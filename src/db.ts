import { Pool, PoolClient } from "pg";
import {
  DatasetEvent,
  DatasetMarket,
  ForecasterWallet,
  InferenceTrace,
  POLYMARKET_PLATFORM_ID,
} from "./types";

export interface BenchmarkRunRow {
  id: number;
  name: string;
  datasetName: string;
  // Model slugs from `benchmark_run_model`, resolved back to their names.
  models: string[];
  promptIterations: number;
  pairwiseIterations: number;
  config: unknown;
  status: string;
}

// A key identifying one completed task, for --resume: forecaster/market/side/iter.
export const taskKey = (
  forecasterId: number,
  marketId: number,
  isNegated: boolean,
  iteration: number,
): string => `${forecasterId}:${marketId}:${isNegated ? 1 : 0}:${iteration}`;

/**
 * The same, for one pairwise task. Both market ids are included in dataset
 * order, so the reversed pair (a legitimately distinct task) gets its own key
 * rather than colliding with the forward one.
 */
export const pairwiseTaskKey = (
  forecasterId: number,
  marketAId: number,
  marketBId: number,
  isANegated: boolean,
  isBNegated: boolean,
  iteration: number,
): string =>
  `${forecasterId}:${marketAId}:${marketBId}:` +
  `${isANegated ? 1 : 0}${isBNegated ? 1 : 0}:${iteration}`;

// Shared by the standalone upserts and the transactional trace+forecast writes,
// so the two paths can never drift into writing different columns.
//
// The conflict clause deliberately leaves `transaction_id` and `published_at`
// alone: a row that already went on-chain keeps pointing at the transaction
// that recorded it, whatever a later resume does to the rest of the row.
const FORECAST_UPSERT_SQL = `
  INSERT INTO public.forecast
    (benchmark_run_id, forecaster_id, event_id, market_id, llm_trace_id,
     is_negated, prompt_iteration, parsed_odds, outcome)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  ON CONFLICT (benchmark_run_id, forecaster_id, market_id, is_negated, prompt_iteration)
  DO UPDATE SET
    llm_trace_id = EXCLUDED.llm_trace_id,
    parsed_odds = EXCLUDED.parsed_odds,
    outcome = EXCLUDED.outcome,
    event_id = EXCLUDED.event_id
  RETURNING id`;

const PAIRWISE_FORECAST_UPSERT_SQL = `
  INSERT INTO public.pairwise_forecast
    (benchmark_run_id, forecaster_id, market_a_id, market_b_id,
     llm_trace_id, is_a_negated, is_b_negated, prompt_iteration,
     is_a_likelier, outcome_a, outcome_b)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
  ON CONFLICT (benchmark_run_id, forecaster_id, market_a_id, market_b_id,
               is_a_negated, is_b_negated, prompt_iteration)
  DO UPDATE SET
    llm_trace_id = EXCLUDED.llm_trace_id,
    is_a_likelier = EXCLUDED.is_a_likelier,
    outcome_a = EXCLUDED.outcome_a,
    outcome_b = EXCLUDED.outcome_b
  RETURNING id`;

/**
 * All database access for noisebench. A thin wrapper over a single pg Pool — no
 * Redis, no manager sharding; the surface here is small enough to keep in one
 * place.
 */
export class Database {
  private pool: Pool;

  constructor(connectionString: string) {
    // A production run drives `models × concurrency` tasks in parallel (20 × 6
    // = 120), each doing several sequential queries. pg's default pool of 10
    // has no acquisition timeout, so exhaustion presents as an indefinite hang
    // with no error — size it up and make starvation fail loudly instead.
    this.pool = new Pool({
      connectionString,
      max: parseInt(process.env.PG_POOL_MAX || "20", 10),
      connectionTimeoutMillis: 10000,
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // -------------------------------------------------------------------------
  // Lookup tables (models, providers, statuses)
  // -------------------------------------------------------------------------

  // Resolved ids of small lookup rows, memoized per process. These tables are
  // append-only and hold a handful of rows, so an id never goes stale — this
  // keeps the per-inference write path down to the queries that matter.
  private lookupIds = new Map<string, number>();

  /**
   * Resolve `name` to its id in an append-only lookup table, creating the row if
   * it does not exist. `table` is a literal union, never caller-supplied text.
   */
  private async intern(
    table: "llm_model" | "llm_provider",
    name: string,
  ): Promise<number> {
    const cacheKey = `${table}:${name}`;
    const cached = this.lookupIds.get(cacheKey);
    if (cached !== undefined) return cached;
    const res = await this.pool.query(
      `INSERT INTO public.${table} (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [name],
    );
    const id: number = res.rows[0].id;
    this.lookupIds.set(cacheKey, id);
    return id;
  }

  /**
   * Resolve a status name to its id. Unlike models/providers these are a closed
   * set seeded by the migration, so an unknown name is a bug, not a new row.
   */
  private async statusId(
    table: "benchmark_status" | "predictor_status",
    name: string,
  ): Promise<number> {
    const cacheKey = `${table}:${name}`;
    const cached = this.lookupIds.get(cacheKey);
    if (cached !== undefined) return cached;
    const res = await this.pool.query(
      `SELECT id FROM public.${table} WHERE name = $1`,
      [name],
    );
    if (res.rows.length === 0) {
      throw new Error(`Unknown ${table} "${name}"`);
    }
    const id: number = res.rows[0].id;
    this.lookupIds.set(cacheKey, id);
    return id;
  }

  // -------------------------------------------------------------------------
  // Provider catalog (slug <-> display name)
  // -------------------------------------------------------------------------

  /**
   * Upsert the OpenRouter provider catalog. Matches on slug — the stable
   * identifier — so a provider that was previously interned by name alone
   * (from a completion, before the catalog was seeded) acquires its slug
   * instead of being duplicated.
   *
   * Returns how many rows were inserted or updated.
   */
  async upsertProviders(
    providers: Array<{ slug: string; name: string }>,
  ): Promise<number> {
    let count = 0;
    for (const { slug, name } of providers) {
      // A row may already exist under this name with no slug (interned from a
      // completion). Claim it rather than inserting a second row for the same
      // provider, which would split its traces across two ids.
      const claimed = await this.pool.query(
        `UPDATE public.llm_provider
         SET slug = $1
         WHERE LOWER(name) = LOWER($2) AND slug IS NULL
         RETURNING id`,
        [slug, name],
      );
      if (claimed.rows.length > 0) {
        count++;
        continue;
      }
      const res = await this.pool.query(
        `INSERT INTO public.llm_provider (name, slug)
         VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET slug = EXCLUDED.slug
         RETURNING id`,
        [name, slug],
      );
      if (res.rows.length > 0) count++;
    }
    // Names/slugs just changed underneath the memoized ids.
    this.lookupIds.clear();
    return count;
  }

  /**
   * The provider catalog as {slug, name} pairs. Used to reconcile a pinned
   * provider slug against the display name a completion reports.
   */
  async getProviders(): Promise<Array<{ slug: string; name: string }>> {
    const res = await this.pool.query(
      `SELECT slug, name FROM public.llm_provider WHERE slug IS NOT NULL ORDER BY slug`,
    );
    return res.rows.map((r) => ({ slug: r.slug, name: r.name }));
  }

  // -------------------------------------------------------------------------
  // Forecasters + features
  // -------------------------------------------------------------------------

  private async getOrCreateFeatureKey(name: string): Promise<number> {
    const existing = await this.pool.query(
      `SELECT id FROM public.feature_key WHERE LOWER(name) = LOWER($1)`,
      [name],
    );
    if (existing.rows.length > 0) return existing.rows[0].id;
    const inserted = await this.pool.query(
      `INSERT INTO public.feature_key (name) VALUES ($1)
       ON CONFLICT DO NOTHING RETURNING id`,
      [name],
    );
    if (inserted.rows.length > 0) return inserted.rows[0].id;
    const retry = await this.pool.query(
      `SELECT id FROM public.feature_key WHERE LOWER(name) = LOWER($1)`,
      [name],
    );
    return retry.rows[0].id;
  }

  private async getOrCreateFeatureValue(name: string): Promise<number> {
    const existing = await this.pool.query(
      `SELECT id FROM public.feature_value WHERE LOWER(name) = LOWER($1)`,
      [name],
    );
    if (existing.rows.length > 0) return existing.rows[0].id;
    const inserted = await this.pool.query(
      `INSERT INTO public.feature_value (name) VALUES ($1)
       ON CONFLICT DO NOTHING RETURNING id`,
      [name],
    );
    if (inserted.rows.length > 0) return inserted.rows[0].id;
    const retry = await this.pool.query(
      `SELECT id FROM public.feature_value WHERE LOWER(name) = LOWER($1)`,
      [name],
    );
    return retry.rows[0].id;
  }

  private async linkForecasterFeatures(
    forecasterId: number,
    features: Record<string, string>,
  ): Promise<void> {
    for (const [key, value] of Object.entries(features)) {
      const keyId = await this.getOrCreateFeatureKey(key);
      const valueId = await this.getOrCreateFeatureValue(value);

      let feature = await this.pool.query(
        `SELECT id FROM public.feature WHERE feature_key_id = $1 AND feature_value_id = $2`,
        [keyId, valueId],
      );
      let featureId: number;
      if (feature.rows.length > 0) {
        featureId = feature.rows[0].id;
      } else {
        const inserted = await this.pool.query(
          `INSERT INTO public.feature (feature_key_id, feature_value_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id`,
          [keyId, valueId],
        );
        if (inserted.rows.length > 0) {
          featureId = inserted.rows[0].id;
        } else {
          feature = await this.pool.query(
            `SELECT id FROM public.feature WHERE feature_key_id = $1 AND feature_value_id = $2`,
            [keyId, valueId],
          );
          featureId = feature.rows[0].id;
        }
      }

      await this.pool.query(
        `INSERT INTO public.forecaster_feature (forecaster_id, feature_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [forecasterId, featureId],
      );
    }
  }

  async upsertForecaster(
    name: string,
    forecastingModel: string,
    features?: Record<string, string>,
  ): Promise<number> {
    const modelId = await this.intern("llm_model", forecastingModel);
    const result = await this.pool.query(
      `INSERT INTO public.forecaster (name, forecasting_model_id)
       VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE
         SET forecasting_model_id = EXCLUDED.forecasting_model_id,
             updated_at = NOW()
       RETURNING id`,
      [name, modelId],
    );
    const forecasterId = result.rows[0].id;
    if (features && Object.keys(features).length > 0) {
      await this.linkForecasterFeatures(forecasterId, features);
    }
    return forecasterId;
  }

  // -------------------------------------------------------------------------
  // Wallets
  // -------------------------------------------------------------------------

  async getWalletByForecasterId(
    forecasterId: number,
  ): Promise<ForecasterWallet | null> {
    const result = await this.pool.query(
      `SELECT w.id, f.id AS forecaster_id, w.address, w.created_at,
              wpdi.derivation_index
       FROM public.forecaster f
       JOIN public.wallet w ON f.wallet_id = w.id
       LEFT JOIN public.wallet_predictor_derivation_index wpdi
         ON w.id = wpdi.wallet_id AND f.id = wpdi.predictor_id
       WHERE f.id = $1`,
      [forecasterId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      id: row.id,
      forecasterId: row.forecaster_id,
      address: row.address,
      createdAt: new Date(row.created_at),
      derivationIndex: row.derivation_index ?? undefined,
    };
  }

  async getNextDerivationIndex(): Promise<number> {
    const result = await this.pool.query(
      `SELECT COALESCE(MAX(derivation_index), -1) + 1 AS next_index
       FROM public.wallet_predictor_derivation_index`,
    );
    return result.rows[0].next_index;
  }

  async assignWalletToForecaster(
    forecasterId: number,
    address: string,
    derivationIndex: number,
  ): Promise<ForecasterWallet> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Addresses are deterministic from the master mnemonic, so this row very
      // often already exists — most commonly after `db:setup --reset` while
      // `.master` is kept, which is exactly what a test cycle does. A bare
      // INSERT would trip `wallet_address_unique` and abort the run.
      const walletResult = await client.query(
        `INSERT INTO public.wallet (address) VALUES ($1)
         ON CONFLICT (address) DO UPDATE SET address = EXCLUDED.address
         RETURNING id, address, created_at`,
        [address],
      );
      const walletRow = walletResult.rows[0];
      await client.query(
        `UPDATE public.forecaster SET wallet_id = $1, updated_at = NOW() WHERE id = $2`,
        [walletRow.id, forecasterId],
      );
      await client.query(
        `INSERT INTO public.wallet_predictor_derivation_index
           (wallet_id, predictor_id, derivation_index)
         VALUES ($1, $2, $3)`,
        [walletRow.id, forecasterId, derivationIndex],
      );
      await client.query("COMMIT");
      return {
        id: walletRow.id,
        forecasterId,
        address: walletRow.address,
        createdAt: new Date(walletRow.created_at),
        derivationIndex,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Events + markets
  // -------------------------------------------------------------------------

  async upsertEvent(event: DatasetEvent): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO public.event
         (platform_id, external_id, title, description, slug, is_neg_risk,
          start_date, end_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (external_id, platform_id) DO UPDATE SET
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         slug = EXCLUDED.slug,
         is_neg_risk = EXCLUDED.is_neg_risk,
         start_date = EXCLUDED.start_date,
         end_date = EXCLUDED.end_date,
         updated_at = NOW()
       RETURNING id`,
      [
        POLYMARKET_PLATFORM_ID,
        event.externalId,
        event.title,
        event.description ?? "",
        event.slug,
        event.isNegRisk ?? false,
        event.startDate ?? null,
        event.endDate ?? null,
      ],
    );
    return result.rows[0].id;
  }

  /**
   * Record the research context a run fed to the model for an event. Research
   * belongs to the {run, event} pair, not to the event: it comes from the run's
   * dataset, so the same event benchmarked from a later dataset carries
   * different (fresher) context.
   */
  async upsertEventResearch(
    benchmarkRunId: number,
    eventId: number,
    research: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO public.event_research (benchmark_run_id, event_id, research)
       VALUES ($1, $2, $3)
       ON CONFLICT (benchmark_run_id, event_id) DO UPDATE SET
         research = EXCLUDED.research,
         updated_at = NOW()`,
      [benchmarkRunId, eventId, research],
    );
  }

  async upsertMarket(eventId: number, market: DatasetMarket): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO public.market
         (event_id, platform_id, external_id, slug, question, negated_question,
          description, start_date, end_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (external_id, platform_id) DO UPDATE SET
         event_id = EXCLUDED.event_id,
         slug = EXCLUDED.slug,
         question = EXCLUDED.question,
         negated_question = EXCLUDED.negated_question,
         description = EXCLUDED.description,
         start_date = EXCLUDED.start_date,
         end_date = EXCLUDED.end_date,
         updated_at = NOW()
       RETURNING id`,
      [
        eventId,
        POLYMARKET_PLATFORM_ID,
        market.externalId,
        market.slug,
        market.question,
        market.negatedQuestion ?? null,
        market.description ?? "",
        market.startDate ?? null,
        market.endDate ?? null,
      ],
    );
    return result.rows[0].id;
  }

  // -------------------------------------------------------------------------
  // LLM traces
  // -------------------------------------------------------------------------

  /**
   * Insert one trace row on a caller-supplied client, so it can share a
   * transaction with the forecast it produced.
   *
   * The `intern` lookups deliberately stay OUTSIDE the caller's transaction:
   * they are memoized, append-only, and shared by every forecaster, so holding
   * them inside would serialize unrelated writers on a row that is almost
   * always already cached.
   */
  private async insertTrace(
    client: PoolClient,
    input: {
      forecasterId: number;
      identifier: string;
      result: InferenceTrace;
      llmModelId: number;
      llmProviderId: number | null;
    },
  ): Promise<number> {
    const { forecasterId, identifier, result, llmModelId, llmProviderId } =
      input;
    const res = await client.query(
      `INSERT INTO public.llm_trace
        (forecaster_id, llm_model_id, llm_provider_id, identifier, system_prompt,
         prompt, response, reasoning, finish_reason, cost, tokens_in, tokens_out,
         reasoning_tokens, time_ms, attempts, errors, usage)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb)
      RETURNING id`,
      [
        forecasterId,
        llmModelId,
        llmProviderId,
        identifier,
        result.systemPrompt,
        result.userPrompt,
        result.rawResponse,
        result.reasoning,
        result.finishReason,
        result.cost,
        result.tokensIn,
        result.tokensOut,
        result.reasoningTokens,
        result.timeMs,
        result.attempts,
        JSON.stringify(result.errors ?? []),
        result.usage ? JSON.stringify(result.usage) : null,
      ],
    );
    return res.rows[0].id;
  }

  private async internTraceIds(
    result: InferenceTrace,
  ): Promise<{ llmModelId: number; llmProviderId: number | null }> {
    return {
      llmModelId: await this.intern("llm_model", result.model),
      llmProviderId: result.provider
        ? await this.intern("llm_provider", result.provider)
        : null,
    };
  }

  async logLLMTrace(input: {
    forecasterId: number;
    identifier: string;
    result: InferenceTrace;
  }): Promise<number> {
    const ids = await this.internTraceIds(input.result);
    const client = await this.pool.connect();
    try {
      return await this.insertTrace(client, { ...input, ...ids });
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Benchmark runs + state
  // -------------------------------------------------------------------------

  /**
   * Create a run and link the model slugs it benchmarks. `config` still holds
   * the verbatim config blob (including per-model provider pins); the normalized
   * `benchmark_run_model` rows are what queries join against.
   */
  async createBenchmarkRun(input: {
    name: string;
    description?: string;
    datasetName: string;
    models: string[];
    promptIterations: number;
    pairwiseIterations: number;
    config: unknown;
  }): Promise<number> {
    const statusId = await this.statusId("benchmark_status", "running");
    const modelIds: number[] = [];
    for (const slug of input.models) {
      modelIds.push(await this.intern("llm_model", slug));
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query(
        `INSERT INTO public.benchmark_run
           (name, description, dataset_name, prompt_iterations,
            pairwise_iterations, config, status_id)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         RETURNING id`,
        [
          input.name,
          input.description ?? null,
          input.datasetName,
          input.promptIterations,
          input.pairwiseIterations,
          JSON.stringify(input.config),
          statusId,
        ],
      );
      const runId = res.rows[0].id;
      for (const modelId of modelIds) {
        await client.query(
          `INSERT INTO public.benchmark_run_model (benchmark_run_id, llm_model_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [runId, modelId],
        );
      }
      await client.query("COMMIT");
      return runId;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getBenchmarkRun(id: number): Promise<BenchmarkRunRow | null> {
    const res = await this.pool.query(
      `SELECT r.id, r.name, r.dataset_name, r.prompt_iterations,
              r.pairwise_iterations, r.config, s.name AS status,
              COALESCE(
                (SELECT ARRAY_AGG(m.name ORDER BY m.name)
                 FROM public.benchmark_run_model brm
                 JOIN public.llm_model m ON m.id = brm.llm_model_id
                 WHERE brm.benchmark_run_id = r.id),
                ARRAY[]::TEXT[]
              ) AS models
       FROM public.benchmark_run r
       JOIN public.benchmark_status s ON s.id = r.status_id
       WHERE r.id = $1`,
      [id],
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      id: row.id,
      name: row.name,
      datasetName: row.dataset_name,
      models: row.models,
      promptIterations: row.prompt_iterations,
      pairwiseIterations: row.pairwise_iterations,
      config: row.config,
      status: row.status,
    };
  }

  /**
   * Re-open an existing run and widen its recorded plan to the scope being run
   * now. Returns the values as they were, so the caller can report the change.
   *
   * A resume reuses the run id but re-reads the dataset and the iteration dials
   * from the command line, so the run row would otherwise still describe the
   * scope of whichever invocation created it. That is not cosmetic: the
   * verifier computes `expected = models × markets × 2 × iterations` from these
   * columns and from `benchmark_run_market`, so a run started as a 2-market
   * rehearsal and widened to 100 markets would be reported as catastrophically
   * over-producing while actually being perfectly healthy.
   *
   * Widen only, never shrink. Resuming at a NARROWER scope must leave the plan
   * wide, because the rows from the wider pass still exist — reporting the run
   * as incomplete is correct, and quietly lowering the bar until it passes is
   * the one behaviour that would make the check worthless.
   */
  async widenBenchmarkRun(
    id: number,
    input: {
      promptIterations: number;
      pairwiseIterations: number;
      datasetName: string;
      models: string[];
      config: unknown;
    },
  ): Promise<{ promptIterations: number; pairwiseIterations: number }> {
    const statusId = await this.statusId("benchmark_status", "running");
    const modelIds: number[] = [];
    for (const slug of input.models) {
      modelIds.push(await this.intern("llm_model", slug));
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const before = await client.query(
        `SELECT prompt_iterations, pairwise_iterations
         FROM public.benchmark_run WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (before.rows.length === 0) {
        throw new Error(`Benchmark run ${id} not found`);
      }
      await client.query(
        `UPDATE public.benchmark_run SET
           prompt_iterations = GREATEST(prompt_iterations, $2),
           pairwise_iterations = GREATEST(pairwise_iterations, $3),
           dataset_name = $4,
           config = $5::jsonb,
           status_id = $6,
           ended_at = NULL
         WHERE id = $1`,
        [
          id,
          input.promptIterations,
          input.pairwiseIterations,
          input.datasetName,
          JSON.stringify(input.config),
          statusId,
        ],
      );
      // A resume may add models the original pass never ran.
      for (const modelId of modelIds) {
        await client.query(
          `INSERT INTO public.benchmark_run_model (benchmark_run_id, llm_model_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [id, modelId],
        );
      }
      await client.query("COMMIT");
      return {
        promptIterations: before.rows[0].prompt_iterations,
        pairwiseIterations: before.rows[0].pairwise_iterations,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async markBenchmarkRunEnded(id: number, status: string): Promise<void> {
    const statusId = await this.statusId("benchmark_status", status);
    await this.pool.query(
      `UPDATE public.benchmark_run SET status_id = $2, ended_at = NOW() WHERE id = $1`,
      [id, statusId],
    );
  }

  async addBenchmarkRunMarket(
    benchmarkRunId: number,
    marketId: number,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO public.benchmark_run_market (benchmark_run_id, market_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [benchmarkRunId, marketId],
    );
  }

  async addBenchmarkRunPair(
    benchmarkRunId: number,
    marketAId: number,
    marketBId: number,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO public.benchmark_run_pair
         (benchmark_run_id, market_a_id, market_b_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [benchmarkRunId, marketAId, marketBId],
    );
  }

  async upsertBenchmarkPredictorState(
    benchmarkRunId: number,
    forecasterId: number,
    totalTasks: number,
  ): Promise<void> {
    const statusId = await this.statusId("predictor_status", "running");
    await this.pool.query(
      `INSERT INTO public.benchmark_predictor_state
         (benchmark_run_id, forecaster_id, status_id, total_tasks, started_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (benchmark_run_id, forecaster_id) DO UPDATE SET
         status_id = EXCLUDED.status_id,
         total_tasks = EXCLUDED.total_tasks,
         updated_at = NOW()`,
      [benchmarkRunId, forecasterId, statusId, totalTasks],
    );
  }

  async bumpPredictorProgress(
    benchmarkRunId: number,
    forecasterId: number,
    completedDelta: number,
    errorDelta: number,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE public.benchmark_predictor_state
       SET completed_tasks = completed_tasks + $3,
           error_count = error_count + $4,
           updated_at = NOW()
       WHERE benchmark_run_id = $1 AND forecaster_id = $2`,
      [benchmarkRunId, forecasterId, completedDelta, errorDelta],
    );
  }

  /**
   * Mark a forecaster finished, reconciling its counters against the forecast
   * rows that actually exist.
   *
   * `bumpPredictorProgress` counts work done by *this* process, which is the
   * right thing during a run but over-counts across a --resume: a retried task
   * updates its existing row rather than adding one, yet still increments. The
   * final numbers are therefore recomputed from the rows themselves, so the
   * summary is trustworthy however many times a run was resumed.
   */
  async markPredictorCompleted(
    benchmarkRunId: number,
    forecasterId: number,
  ): Promise<void> {
    const statusId = await this.statusId("predictor_status", "completed");
    await this.pool.query(
      `UPDATE public.benchmark_predictor_state s
       SET status_id = $3,
           completed_at = NOW(),
           updated_at = NOW(),
           completed_tasks = (
             SELECT COUNT(*) FROM public.forecast f
             WHERE f.benchmark_run_id = s.benchmark_run_id
               AND f.forecaster_id = s.forecaster_id)
             + (
             SELECT COUNT(*) FROM public.pairwise_forecast p
             WHERE p.benchmark_run_id = s.benchmark_run_id
               AND p.forecaster_id = s.forecaster_id),
           error_count = (
             SELECT COUNT(*) FROM public.forecast f
             WHERE f.benchmark_run_id = s.benchmark_run_id
               AND f.forecaster_id = s.forecaster_id
               AND f.parsed_odds IS NULL)
             + (
             SELECT COUNT(*) FROM public.pairwise_forecast p
             WHERE p.benchmark_run_id = s.benchmark_run_id
               AND p.forecaster_id = s.forecaster_id
               AND p.is_a_likelier IS NULL)
       WHERE s.benchmark_run_id = $1 AND s.forecaster_id = $2`,
      [benchmarkRunId, forecasterId, statusId],
    );
  }

  /**
   * Mark a forecaster as abandoned, reconciling its counters the same way
   * `markPredictorCompleted` does so the summary reflects rows that exist
   * rather than work this process happened to attempt.
   */
  async markPredictorFailed(
    benchmarkRunId: number,
    forecasterId: number,
  ): Promise<void> {
    const statusId = await this.statusId("predictor_status", "failed");
    await this.pool.query(
      `UPDATE public.benchmark_predictor_state s
       SET status_id = $3,
           updated_at = NOW(),
           completed_tasks = (
             SELECT COUNT(*) FROM public.forecast f
             WHERE f.benchmark_run_id = s.benchmark_run_id
               AND f.forecaster_id = s.forecaster_id)
             + (
             SELECT COUNT(*) FROM public.pairwise_forecast p
             WHERE p.benchmark_run_id = s.benchmark_run_id
               AND p.forecaster_id = s.forecaster_id)
       WHERE s.benchmark_run_id = $1 AND s.forecaster_id = $2`,
      [benchmarkRunId, forecasterId, statusId],
    );
  }

  /**
   * Task keys already completed (parsed successfully) for a run, so --resume can
   * skip them. Tasks that exist but failed to parse (null odds) are intentionally
   * omitted so they get retried.
   */
  async getCompletedTaskKeys(benchmarkRunId: number): Promise<Set<string>> {
    const res = await this.pool.query(
      `SELECT forecaster_id, market_id, is_negated, prompt_iteration
       FROM public.forecast
       WHERE benchmark_run_id = $1 AND parsed_odds IS NOT NULL`,
      [benchmarkRunId],
    );
    const set = new Set<string>();
    for (const row of res.rows) {
      set.add(
        taskKey(
          row.forecaster_id,
          row.market_id,
          row.is_negated,
          row.prompt_iteration,
        ),
      );
    }
    return set;
  }

  /**
   * The same, for pairwise tasks. A row whose judgment is null was a refusal or
   * an unparseable answer and is deliberately omitted, so --resume retries it.
   */
  async getCompletedPairwiseTaskKeys(
    benchmarkRunId: number,
  ): Promise<Set<string>> {
    const res = await this.pool.query(
      `SELECT forecaster_id, market_a_id, market_b_id, is_a_negated,
              is_b_negated, prompt_iteration
       FROM public.pairwise_forecast
       WHERE benchmark_run_id = $1 AND is_a_likelier IS NOT NULL`,
      [benchmarkRunId],
    );
    const set = new Set<string>();
    for (const row of res.rows) {
      set.add(
        pairwiseTaskKey(
          row.forecaster_id,
          row.market_a_id,
          row.market_b_id,
          row.is_a_negated,
          row.is_b_negated,
          row.prompt_iteration,
        ),
      );
    }
    return set;
  }

  // -------------------------------------------------------------------------
  // Forecasts
  // -------------------------------------------------------------------------

  /** Insert (or update, on re-run) one forecast row and return its id. */
  async upsertForecast(input: {
    benchmarkRunId: number;
    forecasterId: number;
    eventId: number;
    marketId: number;
    llmTraceId: number | null;
    isNegated: boolean;
    promptIteration: number;
    parsedOdds: number | null;
    outcome: string;
  }): Promise<number> {
    const res = await this.pool.query(FORECAST_UPSERT_SQL, [
      input.benchmarkRunId,
      input.forecasterId,
      input.eventId,
      input.marketId,
      input.llmTraceId,
      input.isNegated,
      input.promptIteration,
      input.parsedOdds,
      input.outcome,
    ]);
    return res.rows[0].id;
  }

  /**
   * Write the trace and the forecast it produced as ONE transaction.
   *
   * Written separately, a failure between the two statements left a paid-for
   * trace with no forecast pointing at it: the answer is in the database, but
   * no query returns it, `--resume` cannot see it, and the task is silently
   * re-run at full cost. Neither half is useful without the other, so neither
   * half should be able to land alone.
   */
  async recordForecastWithTrace(input: {
    benchmarkRunId: number;
    forecasterId: number;
    eventId: number;
    marketId: number;
    identifier: string;
    result: InferenceTrace;
    isNegated: boolean;
    promptIteration: number;
    parsedOdds: number | null;
    outcome: string;
  }): Promise<{ forecastId: number; traceId: number }> {
    const ids = await this.internTraceIds(input.result);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const traceId = await this.insertTrace(client, {
        forecasterId: input.forecasterId,
        identifier: input.identifier,
        result: input.result,
        ...ids,
      });
      const res = await client.query(FORECAST_UPSERT_SQL, [
        input.benchmarkRunId,
        input.forecasterId,
        input.eventId,
        input.marketId,
        traceId,
        input.isNegated,
        input.promptIteration,
        input.parsedOdds,
        input.outcome,
      ]);
      await client.query("COMMIT");
      return { forecastId: res.rows[0].id, traceId };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** The same, for a pairwise judgment. */
  async recordPairwiseForecastWithTrace(input: {
    benchmarkRunId: number;
    forecasterId: number;
    marketAId: number;
    marketBId: number;
    identifier: string;
    result: InferenceTrace;
    isANegated: boolean;
    isBNegated: boolean;
    promptIteration: number;
    isALikelier: boolean | null;
    outcomeA: string;
    outcomeB: string;
  }): Promise<{ pairwiseForecastId: number; traceId: number }> {
    const ids = await this.internTraceIds(input.result);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const traceId = await this.insertTrace(client, {
        forecasterId: input.forecasterId,
        identifier: input.identifier,
        result: input.result,
        ...ids,
      });
      const res = await client.query(PAIRWISE_FORECAST_UPSERT_SQL, [
        input.benchmarkRunId,
        input.forecasterId,
        input.marketAId,
        input.marketBId,
        traceId,
        input.isANegated,
        input.isBNegated,
        input.promptIteration,
        input.isALikelier,
        input.outcomeA,
        input.outcomeB,
      ]);
      await client.query("COMMIT");
      return { pairwiseForecastId: res.rows[0].id, traceId };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** Insert (or update, on re-run) one pairwise forecast row and return its id. */
  async upsertPairwiseForecast(input: {
    benchmarkRunId: number;
    forecasterId: number;
    marketAId: number;
    marketBId: number;
    llmTraceId: number | null;
    isANegated: boolean;
    isBNegated: boolean;
    promptIteration: number;
    isALikelier: boolean | null;
    outcomeA: string;
    outcomeB: string;
  }): Promise<number> {
    const res = await this.pool.query(PAIRWISE_FORECAST_UPSERT_SQL, [
      input.benchmarkRunId,
      input.forecasterId,
      input.marketAId,
      input.marketBId,
      input.llmTraceId,
      input.isANegated,
      input.isBNegated,
      input.promptIteration,
      input.isALikelier,
      input.outcomeA,
      input.outcomeB,
    ]);
    return res.rows[0].id;
  }

  /**
   * `chainId` is recorded because dev, testnet and mainnet runs all share one
   * database and a transaction hash alone says nothing about which chain it
   * landed on. Without it, a rehearsal row and a published mainnet row are
   * indistinguishable at the row level.
   */
  private async upsertTransaction(
    hash: string,
    blockNumber: number | undefined,
    publishedAt: Date,
    chainId: number | null,
  ): Promise<number> {
    const res = await this.pool.query(
      `INSERT INTO public.transaction (hash, block_number, published_at, chain_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (hash) DO UPDATE SET
         block_number = COALESCE(EXCLUDED.block_number, public.transaction.block_number),
         published_at = COALESCE(EXCLUDED.published_at, public.transaction.published_at),
         chain_id = COALESCE(EXCLUDED.chain_id, public.transaction.chain_id)
       RETURNING id`,
      [hash, blockNumber ?? null, publishedAt, chainId],
    );
    return res.rows[0].id;
  }

  /**
   * Stamp a set of forecast rows with the on-chain tx that recorded them. Called
   * from the registry client's batch-submitted handler; best-effort.
   */
  async stampForecastsWithTransaction(
    forecastIds: number[],
    transactionHash: string,
    blockNumber: number | undefined,
    chainId: number | null = null,
  ): Promise<void> {
    if (forecastIds.length === 0) return;
    const publishedAt = new Date();
    const transactionId = await this.upsertTransaction(
      transactionHash,
      blockNumber,
      publishedAt,
      chainId,
    );
    await this.pool.query(
      `UPDATE public.forecast
       SET transaction_id = $2, published_at = $3
       WHERE id = ANY($1::int[])`,
      [forecastIds, transactionId, publishedAt],
    );
  }

  /** The same, for pairwise rows. */
  async stampPairwiseForecastsWithTransaction(
    pairwiseForecastIds: number[],
    transactionHash: string,
    blockNumber: number | undefined,
    chainId: number | null = null,
  ): Promise<void> {
    if (pairwiseForecastIds.length === 0) return;
    const publishedAt = new Date();
    const transactionId = await this.upsertTransaction(
      transactionHash,
      blockNumber,
      publishedAt,
      chainId,
    );
    await this.pool.query(
      `UPDATE public.pairwise_forecast
       SET transaction_id = $2, published_at = $3
       WHERE id = ANY($1::int[])`,
      [pairwiseForecastIds, transactionId, publishedAt],
    );
  }
}
