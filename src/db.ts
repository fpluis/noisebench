import { Pool } from "pg";
import {
  DatasetEvent,
  DatasetMarket,
  ForecasterWallet,
  InferenceResult,
  POLYMARKET_PLATFORM_ID,
} from "./types";

export interface BenchmarkRunRow {
  id: number;
  name: string;
  datasetName: string;
  // Model slugs from `benchmark_run_model`, resolved back to their names.
  models: string[];
  promptIterations: number;
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
 * All database access for noisebench. A thin wrapper over a single pg Pool — no
 * Redis, no manager sharding; the surface here is small enough to keep in one
 * place.
 */
export class Database {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
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
      const walletResult = await client.query(
        `INSERT INTO public.wallet (address) VALUES ($1)
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

  async logLLMTrace(input: {
    forecasterId: number;
    identifier: string;
    result: InferenceResult;
  }): Promise<number> {
    const { forecasterId, identifier, result } = input;
    const llmModelId = await this.intern("llm_model", result.model);
    const llmProviderId = result.provider
      ? await this.intern("llm_provider", result.provider)
      : null;
    const query = `
      INSERT INTO public.llm_trace
        (forecaster_id, llm_model_id, llm_provider_id, identifier, system_prompt,
         prompt, response, reasoning, finish_reason, cost, tokens_in, tokens_out,
         reasoning_tokens, time_ms, attempts, errors, usage)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb)
      RETURNING id`;
    const res = await this.pool.query(query, [
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
    ]);
    return res.rows[0].id;
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
           (name, description, dataset_name, prompt_iterations, config, status_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         RETURNING id`,
        [
          input.name,
          input.description ?? null,
          input.datasetName,
          input.promptIterations,
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
      `SELECT r.id, r.name, r.dataset_name, r.prompt_iterations, r.config,
              s.name AS status,
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
      config: row.config,
      status: row.status,
    };
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

  async markPredictorCompleted(
    benchmarkRunId: number,
    forecasterId: number,
  ): Promise<void> {
    const statusId = await this.statusId("predictor_status", "completed");
    await this.pool.query(
      `UPDATE public.benchmark_predictor_state
       SET status_id = $3, completed_at = NOW(), updated_at = NOW()
       WHERE benchmark_run_id = $1 AND forecaster_id = $2`,
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
    const res = await this.pool.query(
      `INSERT INTO public.forecast
         (benchmark_run_id, forecaster_id, event_id, market_id, llm_trace_id,
          is_negated, prompt_iteration, parsed_odds, outcome)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (benchmark_run_id, forecaster_id, market_id, is_negated, prompt_iteration)
       DO UPDATE SET
         llm_trace_id = EXCLUDED.llm_trace_id,
         parsed_odds = EXCLUDED.parsed_odds,
         outcome = EXCLUDED.outcome,
         event_id = EXCLUDED.event_id
       RETURNING id`,
      [
        input.benchmarkRunId,
        input.forecasterId,
        input.eventId,
        input.marketId,
        input.llmTraceId,
        input.isNegated,
        input.promptIteration,
        input.parsedOdds,
        input.outcome,
      ],
    );
    return res.rows[0].id;
  }

  private async upsertTransaction(
    hash: string,
    blockNumber: number | undefined,
    publishedAt: Date,
  ): Promise<number> {
    const res = await this.pool.query(
      `INSERT INTO public.transaction (hash, block_number, published_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (hash) DO UPDATE SET
         block_number = COALESCE(EXCLUDED.block_number, public.transaction.block_number),
         published_at = COALESCE(EXCLUDED.published_at, public.transaction.published_at)
       RETURNING id`,
      [hash, blockNumber ?? null, publishedAt],
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
  ): Promise<void> {
    if (forecastIds.length === 0) return;
    const publishedAt = new Date();
    const transactionId = await this.upsertTransaction(
      transactionHash,
      blockNumber,
      publishedAt,
    );
    await this.pool.query(
      `UPDATE public.forecast
       SET transaction_id = $2, published_at = $3
       WHERE id = ANY($1::int[])`,
      [forecastIds, transactionId, publishedAt],
    );
  }
}
