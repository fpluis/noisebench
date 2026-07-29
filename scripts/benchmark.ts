// noisebench — benchmark entry point.
//
//   npm run benchmark -- --config <config.json> --dataset <dataset.json>
//   npm run benchmark -- --config <config.json> --resume <benchmarkRunId>
//
// Two modalities run over the same dataset:
//
//   * DIRECT — for every event, market, model, both the base and negated
//     phrasing, and each of `promptIterations` repetitions, ask for a
//     probability;
//   * PAIRWISE — for every listed pair of markets, model, all four phrasing
//     combinations, and each of `pairwiseIterations` repetitions, ask only
//     which of the two is likelier.
//
// Each call persists its trace and its result, and records it on-chain (unless
// SKIP_ONCHAIN=true). --resume continues an existing run, skipping tasks in
// either modality whose result was already produced successfully.
//
// SCOPE FLAGS AND THE SLICE-THEN-WIDEN WORKFLOW
//
// A production run is expensive and irreversible, so it is started small and
// widened in place:
//
//   # rehearse the whole pipeline on 2 markets and 1 pair, all models
//   npm run benchmark -- --config c.json --dataset d.json \
//     --max-markets 2 --max-pairs 1 --prompt-iterations 1 --pairwise-iterations 1
//   npx tsx scripts/verify-run.ts --run R --onchain
//
//   # then widen THE SAME RUN to everything, keeping what the slice produced
//   npm run benchmark -- --config c.json --dataset d.json --resume R
//
// The second invocation reuses the slice's rows rather than redoing them:
// markets are upserted on their external id and resume keys off the resulting
// market id, so slicing the same dataset file yields identical ids and the
// completed-task sets skip exactly the work already paid for. This only holds
// because the slice comes from the SAME file — see `sliceDataset`.

import * as dotenv from "dotenv";
import { ethers } from "ethers";
import { Database, pairwiseTaskKey, taskKey } from "../src/db";
import { generateForecast, generatePairwiseForecast } from "../src/llm";
import {
  fakeGenerateForecast,
  fakeGeneratePairwiseForecast,
} from "../src/llm-fake";
import { ForecastRegistryClient } from "../src/forecast-registry-client";
import {
  DatasetEvent,
  DatasetMarket,
  NormalizedModel,
  PairwiseCombination,
  PAIRWISE_COMBINATIONS,
  PendingForecastRecord,
  PendingPairwiseForecastRecord,
  POLYMARKET_PLATFORM_ID,
  ResolvedPair,
} from "../src/types";
import {
  createForecastRegistryConfigFromEnv,
  deriveWalletFromMnemonic,
  forecasterNameFromModel,
  fundWallet,
  loadBenchmarkConfig,
  loadDataset,
  loadMasterMnemonic,
  normalizeModel,
  outcomeForPhrasing,
  parseArgs,
  resolvePairs,
  sliceDataset,
  validateDataset,
} from "../src/utils";
import { logger } from "../src/logger";
import { classifyTaskError, runPool } from "../src/task-pool";

dotenv.config();

interface ForecasterCtx {
  model: NormalizedModel;
  name: string;
  forecasterId: number;
  address?: string;
}

interface Task {
  event: DatasetEvent;
  market: DatasetMarket;
  eventId: number;
  marketId: number;
  isNegated: boolean;
  iteration: number;
}

interface PairwiseTask {
  pair: ResolvedPair;
  marketAId: number;
  marketBId: number;
  combination: PairwiseCombination;
  iteration: number;
}

// Both modalities go into ONE queue per forecaster, so `concurrency` remains a
// cap on that forecaster's in-flight calls rather than becoming two independent
// caps that together double the load on the provider.
type AnyTask =
  ({ kind: "direct" } & Task) | ({ kind: "pairwise" } & PairwiseTask);

// A production run is measured in hours, so progress has to be legible while it
// happens — "will this finish inside the day" is a decision made at hour two,
// not at the end.
const HEARTBEAT_MS = 60000;
const STALL_WARN_MINUTES = 15;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const configPath = (args.config as string) || (args.c as string);
  if (!configPath) throw new Error("Missing required --config <path>");

  // Swap in the offline stand-in so the whole pipeline can be rehearsed at
  // production volume without spending anything. Loud on purpose: a run whose
  // forecasts came from a fake must never be mistaken for a real one.
  const useFakeInference =
    String(process.env.NOISEBENCH_FAKE_INFERENCE).toLowerCase() === "true";
  const inference = useFakeInference ? fakeGenerateForecast : generateForecast;
  const pairwiseInference = useFakeInference
    ? fakeGeneratePairwiseForecast
    : generatePairwiseForecast;
  if (useFakeInference) {
    console.log(
      "⚠️  NOISEBENCH_FAKE_INFERENCE=true — forecasts are SYNTHETIC, not model output.",
    );
  }

  const apiKey = process.env.OPENROUTER_API_KEY ?? "";
  if (!apiKey && !useFakeInference) {
    throw new Error("OPENROUTER_API_KEY is required");
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const skipOnchain = String(process.env.SKIP_ONCHAIN).toLowerCase() === "true";
  const resumeRunId = args.resume ? parseInt(args.resume as string, 10) : null;

  const config = loadBenchmarkConfig(configPath);
  const datasetPath =
    (args.dataset as string) || (args.d as string) || config.dataset;
  if (!datasetPath) {
    throw new Error(
      "Missing dataset: pass --dataset <path> or set it in config",
    );
  }
  const fullDataset = loadDataset(datasetPath);

  // Validated before anything is written. Every failure here is a dataset
  // authoring bug, and the worst of them — a market with no negatedQuestion —
  // does not produce a missing row but a WRONG one: the negated phrasing asks
  // the base question, and the answer is recorded and published as that
  // market's "No". Nothing downstream can distinguish that from a real result.
  const validation = validateDataset(fullDataset, datasetPath);
  for (const warning of validation.warnings) console.warn(`⚠️  ${warning}`);

  const numberArg = (name: string): number | undefined => {
    const raw = args[name];
    if (raw === undefined) return undefined;
    const parsed = parseInt(String(raw), 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(`--${name} must be a non-negative integer, got "${raw}"`);
    }
    return parsed;
  };

  const maxMarkets = numberArg("max-markets");
  const maxPairs = numberArg("max-pairs");
  const dataset = sliceDataset(fullDataset, { maxMarkets, maxPairs });
  if (dataset !== fullDataset) {
    const sliced = dataset.events.reduce((n, e) => n + e.markets.length, 0);
    console.log(
      `Slicing ${datasetPath}: ${sliced}/${validation.markets} market(s), ` +
        `${dataset.pairs.length}/${validation.pairs} pair(s), ` +
        `${dataset.events.length}/${validation.events} event(s)`,
    );
  }

  // Resolved before anything is written: an unresolvable slug or a self-pair is
  // a dataset bug, and finding it after a run has started means discovering it
  // as a reverted transaction instead of as an error message.
  const pairs = resolvePairs(dataset);
  const models = config.models.map(normalizeModel);
  const promptIterations =
    numberArg("prompt-iterations") ?? config.promptIterations ?? 4;
  const pairwiseIterations =
    numberArg("pairwise-iterations") ?? config.pairwiseIterations ?? 2;
  const concurrency = config.concurrency ?? 6;
  // Unset means "every model at once", which is what this did before the flag
  // existed. Note that total in-flight inference is the PRODUCT of this and
  // `concurrency`, and the pg pool has to be able to hold that many writers.
  const modelConcurrency =
    numberArg("model-concurrency") ?? config.modelConcurrency ?? models.length;
  const taskMaxRetries = config.taskMaxRetries ?? 2;
  const taskFailureAbortRate = config.taskFailureAbortRate ?? 0.2;
  const retryPasses = numberArg("retry-passes") ?? config.retryPasses ?? 1;

  const poolMax = parseInt(process.env.PG_POOL_MAX || "20", 10);
  const inFlight = modelConcurrency * concurrency;
  if (inFlight + 4 > poolMax) {
    console.warn(
      `⚠️  ${modelConcurrency} model(s) × concurrency ${concurrency} = ${inFlight} tasks in flight, ` +
        `but PG_POOL_MAX is ${poolMax}. Tasks will start failing on the pool's 10s acquisition ` +
        `timeout rather than on anything real — set PG_POOL_MAX to at least ${inFlight + 8}.`,
    );
  }

  const db = new Database(databaseUrl);

  // ---------------------------------------------------------------------------
  // On-chain registry client (skippable for local dry-runs).
  // ---------------------------------------------------------------------------
  let registry: ForecastRegistryClient | null = null;
  const registryConfig = skipOnchain
    ? null
    : createForecastRegistryConfigFromEnv();
  // Map every queued on-chain record back to its forecast row so the batch
  // handler can stamp exactly those rows once the tx confirms.
  if (registryConfig) {
    registry = new ForecastRegistryClient(registryConfig);
    await registry.initialize();
    registry.setBatchSubmittedHandler(async (records, txHash, blockNumber) => {
      const forecastIds = records.map((r) => r.forecastId);
      await db.stampForecastsWithTransaction(
        forecastIds,
        txHash,
        blockNumber,
        registryConfig.chainId,
      );
    });
    registry.setPairwiseBatchSubmittedHandler(
      async (records, txHash, blockNumber) => {
        await db.stampPairwiseForecastsWithTransaction(
          records.map((r) => r.pairwiseForecastId),
          txHash,
          blockNumber,
          registryConfig.chainId,
        );
      },
    );
  } else {
    console.log("SKIP_ONCHAIN=true — forecasts will be saved to the DB only.");
  }

  // ---------------------------------------------------------------------------
  // 1-3. Initialize forecasters: upsert, derive wallets, set attributes, fund.
  // ---------------------------------------------------------------------------
  const thresholdEth = process.env.THRESHOLD_BALANCE || "0.001";
  const researchModel = process.env.RESEARCH_MODEL || "local-research-v1";
  const mnemonic = registry ? loadMasterMnemonic() : null;

  // Forecasters whose on-chain model declaration did not land. Their forecasts
  // are still valid, but published from an unattributable address — surfaced at
  // the end of the run rather than buried in the error log.
  const undeclared: string[] = [];
  let budgetChecked = false;

  const forecasters: ForecasterCtx[] = [];
  for (const model of models) {
    const name = forecasterNameFromModel(model.slug);
    const forecasterId = await db.upsertForecaster(name, model.slug, {
      model: model.slug,
      ...(model.providerOrder
        ? { provider: model.providerOrder.join(",") }
        : {}),
    });
    const ctx: ForecasterCtx = { model, name, forecasterId };

    if (registry && mnemonic && registryConfig) {
      let wallet = await db.getWalletByForecasterId(forecasterId);
      if (!wallet) {
        const derivationIndex = await db.getNextDerivationIndex();
        const derived = deriveWalletFromMnemonic(mnemonic, derivationIndex);
        wallet = await db.assignWalletToForecaster(
          forecasterId,
          derived.address,
          derivationIndex,
        );
      }
      if (wallet.derivationIndex === undefined) {
        throw new Error(`Wallet for ${name} is missing its derivation index`);
      }
      const derived = deriveWalletFromMnemonic(
        mnemonic,
        wallet.derivationIndex,
      );
      const address = registry.addForecaster(name, derived.privateKey);
      ctx.address = address;

      // Gas budget gate, run once against the first registered wallet.
      //
      // Wallets are funded only here, at startup. A wallet that runs dry
      // halfway through has its batches rejected with `insufficient funds`,
      // which classifies as non-retryable and discards them — so the threshold
      // has to cover every batch this forecaster will ever send, and the
      // failure mode of getting it wrong is losing forecasts we already paid
      // an LLM to produce. Measure it instead of guessing.
      if (!budgetChecked) {
        budgetChecked = true;
        const marketCount = dataset.events.reduce(
          (n, e) => n + e.markets.length,
          0,
        );
        const directRecords = marketCount * 2 * promptIterations;
        const pairwiseRecords = pairs.length * 4 * pairwiseIterations;
        const batchSize = Math.max(1, registryConfig.batchSize);
        const batchesPerForecaster =
          Math.ceil(directRecords / batchSize) +
          Math.ceil(pairwiseRecords / batchSize) +
          1; // the attribute claim

        // Sample real market ids: calldata size drives gas, so a synthetic id
        // of a different length would price the wrong transaction.
        const sampleIds = dataset.events.flatMap((e) =>
          e.markets.map((m) => m.externalId),
        );
        const sample: PendingForecastRecord[] = Array.from(
          { length: Math.min(batchSize, Math.max(1, directRecords)) },
          (_, i) => ({
            forecastId: 0,
            forecasterName: name,
            platformId: POLYMARKET_PLATFORM_ID,
            marketId: sampleIds[i % sampleIds.length],
            outcome: "Yes",
            probability: 0.5,
          }),
        );

        const { wei, gas, estimated } = await registry.estimateBatchCostWei(
          name,
          sample,
        );
        // Base fee can climb between the first batch and the last one hours
        // later, so budget above the current price rather than at it.
        const required = (wei * BigInt(batchesPerForecaster) * 3n) / 2n;
        const threshold = ethers.parseEther(thresholdEth);
        console.log(
          `Gas budget: ~${batchesPerForecaster} batch(es)/forecaster × ${gas} gas ` +
            `(${estimated ? "estimated" : "FALLBACK, node would not estimate"}) ` +
            `= ${ethers.formatEther(required)} ETH needed per wallet ` +
            `(incl. 1.5x headroom); THRESHOLD_BALANCE is ${thresholdEth} ETH`,
        );
        if (threshold < required) {
          throw new Error(
            `THRESHOLD_BALANCE=${thresholdEth} ETH cannot cover this run: each of the ` +
              `${models.length} wallet(s) needs about ${ethers.formatEther(required)} ETH for ` +
              `${batchesPerForecaster} batch(es). A wallet that runs out mid-run has its ` +
              `batches rejected as insufficient-funds and silently discarded.\n` +
              `  - set THRESHOLD_BALANCE=${ethers.formatEther(required)}\n` +
              `  - fund the funder with at least ` +
              `${ethers.formatEther(required * BigInt(models.length))} ETH`,
          );
        }
        console.log(
          `Funder must hold at least ` +
            `${ethers.formatEther(threshold * BigInt(models.length))} ETH to top up all ` +
            `${models.length} wallet(s).`,
        );
      }

      // 2. Top up to THRESHOLD_BALANCE if the wallet is below it.
      //
      // This MUST happen before any transaction is sent from the wallet: a
      // freshly derived wallet holds nothing, so anything sent first — the
      // attribute claim below included — fails with "insufficient funds".
      //
      // Funding happens only here, at startup. A wallet that runs dry mid-run
      // has its batches rejected as insufficient-funds, which is classified
      // non-retryable and silently discards them, so the threshold must cover
      // every batch this forecaster will submit. Size it from the gas measured
      // on a Sepolia rehearsal, not by guesswork.
      const balance = await registry.getBalance(name);
      const threshold = ethers.parseEther(thresholdEth);
      if (balance < threshold) {
        // Send the shortfall, not the whole threshold: a wallet sitting just
        // under the line needs a top-up, not another full threshold's worth.
        const shortfall = ethers.formatEther(threshold - balance);
        console.log(
          `[${name}] balance ${ethers.formatEther(balance)} ETH < ${thresholdEth} — funding ${shortfall} ETH`,
        );
        try {
          await fundWallet(
            address,
            shortfall,
            registryConfig.rpcUrls,
            registryConfig.chainId,
          );
        } catch (error) {
          logger.logError("Failed to fund wallet", error, { forecaster: name });
        }
      }

      // 3. Declare this wallet's model on-chain before it forecasts.
      //
      // Gated on what the chain actually says rather than on "is this a new
      // forecaster", so a claim that failed on an earlier run is repaired on
      // the next one. Without the claim the wallet is anonymous and its
      // forecasts cannot be attributed to a model — which is the entire point
      // of publishing them.
      const attributes = {
        forecastingModel: model.slug,
        researchModel,
      };
      try {
        if (await registry.hasDeclaredAttributes(name, attributes)) {
          console.log(`[${name}] model already declared on-chain`);
        } else {
          console.log(`[${name}] recording model attributes on-chain`);
          await registry.setForecasterAttributes(name, attributes);
        }
      } catch (error) {
        undeclared.push(name);
        logger.logError("Failed to set on-chain attributes", error, {
          forecaster: name,
        });
      }
    }

    forecasters.push(ctx);
  }

  // ---------------------------------------------------------------------------
  // 4. Upsert dataset events/markets and set up (or resume) the benchmark run.
  // ---------------------------------------------------------------------------
  // Enrich each market with its DB ids while preserving dataset order.
  const eventRows: Array<{ event: DatasetEvent; eventId: number }> = [];
  const marketRows: Array<{
    event: DatasetEvent;
    market: DatasetMarket;
    eventId: number;
    marketId: number;
  }> = [];
  for (const event of dataset.events) {
    const eventId = await db.upsertEvent(event);
    eventRows.push({ event, eventId });
    for (const market of event.markets) {
      const marketId = await db.upsertMarket(eventId, market);
      marketRows.push({ event, market, eventId, marketId });
    }
  }

  // Pairs reference markets that were just upserted, so their ids come from the
  // same map rather than from a second round of queries.
  const marketIdBySlug = new Map(
    marketRows.map((row) => [row.market.slug, row.marketId]),
  );
  const pairRows = pairs.map((pair) => ({
    pair,
    marketAId: marketIdBySlug.get(pair.marketA.slug)!,
    marketBId: marketIdBySlug.get(pair.marketB.slug)!,
  }));

  let benchmarkRunId: number;
  let completed: Set<string>;
  let completedPairwise: Set<string>;
  if (resumeRunId !== null) {
    const run = await db.getBenchmarkRun(resumeRunId);
    if (!run) throw new Error(`Benchmark run ${resumeRunId} not found`);
    benchmarkRunId = run.id;

    // Bring the run's RECORDED plan up to the scope being run now. A resume
    // reuses the id but re-reads the dataset and dials from this command line,
    // so without this a run started as a 2-market rehearsal keeps claiming it
    // is a 2-market run — and verify-run, which computes what to expect from
    // exactly these columns, reports a healthy widened run as broken.
    const before = await db.widenBenchmarkRun(benchmarkRunId, {
      promptIterations,
      pairwiseIterations,
      datasetName: datasetPath,
      models: models.map((m) => m.slug),
      config,
    });

    completed = await db.getCompletedTaskKeys(benchmarkRunId);
    completedPairwise = await db.getCompletedPairwiseTaskKeys(benchmarkRunId);
    console.log(
      `Resuming benchmark run ${benchmarkRunId} — ${completed.size} direct and ` +
        `${completedPairwise.size} pairwise task(s) already complete`,
    );
    if (
      before.promptIterations !== promptIterations ||
      before.pairwiseIterations !== pairwiseIterations
    ) {
      console.log(
        `  widened iterations: prompt ${before.promptIterations} → ` +
          `${Math.max(before.promptIterations, promptIterations)}, ` +
          `pairwise ${before.pairwiseIterations} → ` +
          `${Math.max(before.pairwiseIterations, pairwiseIterations)}`,
      );
    }
  } else {
    benchmarkRunId = await db.createBenchmarkRun({
      name: config.name,
      description: config.description,
      datasetName: datasetPath,
      models: models.map((m) => m.slug),
      promptIterations,
      pairwiseIterations,
      config,
    });
    completed = new Set<string>();
    completedPairwise = new Set<string>();
    console.log(`Created benchmark run ${benchmarkRunId}`);
  }

  // Scope rows are (re)declared on BOTH paths. They are the denominator the
  // verifier divides by, so a widened run whose scope table still lists only
  // the rehearsal's markets would fail completeness while being complete.
  // Both inserts are ON CONFLICT DO NOTHING, so replaying them is free.
  for (const row of marketRows) {
    await db.addBenchmarkRunMarket(benchmarkRunId, row.marketId);
  }
  for (const row of pairRows) {
    await db.addBenchmarkRunPair(benchmarkRunId, row.marketAId, row.marketBId);
  }

  // Research is scoped to {run, event} — the context this run's dataset fed to
  // the model — so it is recorded once the run id is known, for resumes too.
  for (const row of eventRows) {
    if (row.event.research) {
      await db.upsertEventResearch(
        benchmarkRunId,
        row.eventId,
        row.event.research,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // 5. Build each forecaster's task list and run them in parallel.
  // ---------------------------------------------------------------------------
  const directTasksPerForecaster = marketRows.length * 2 * promptIterations;
  const pairwiseTasksPerForecaster =
    pairRows.length * PAIRWISE_COMBINATIONS.length * pairwiseIterations;
  const totalTasksPerForecaster =
    directTasksPerForecaster + pairwiseTasksPerForecaster;
  for (const f of forecasters) {
    await db.upsertBenchmarkPredictorState(
      benchmarkRunId,
      f.forecasterId,
      totalTasksPerForecaster,
    );
  }

  console.log(
    `Running ${forecasters.length} forecaster(s):\n` +
      `  direct   ${marketRows.length} market(s) × 2 phrasings × ${promptIterations} iteration(s) = ${directTasksPerForecaster} task(s) each\n` +
      `  pairwise ${pairRows.length} pair(s) × ${PAIRWISE_COMBINATIONS.length} combinations × ${pairwiseIterations} iteration(s) = ${pairwiseTasksPerForecaster} task(s) each`,
  );

  // Per-forecaster tallies of tasks that threw outright (as opposed to tasks
  // whose model refused, which are a recorded result rather than a failure).
  const attempted = new Map<number, number>();
  const hardFailures = new Map<number, number>();
  const abandoned = new Set<string>();
  // Live progress, for the heartbeat. `at` is when this forecaster last
  // finished something, which is what makes a stall distinguishable from a
  // model that is merely slow.
  const progress = new Map<
    string,
    { done: number; total: number; at: number }
  >();
  let completedForecasters = 0;
  // Set when a task hits an error that retrying cannot fix and continuing would
  // only multiply — an integrity violation. Stops every pool between items.
  let fatalError: unknown = null;

  const bump = (map: Map<number, number>, key: number): void => {
    map.set(key, (map.get(key) ?? 0) + 1);
  };

  /**
   * Run one task, absorbing failure so a single bad task cannot take the run
   * down with it.
   *
   * Inference failures never reach here — `runInference` returns a null result
   * rather than throwing, and that is recorded as a legitimate data point. What
   * reaches here is infrastructure: a dropped connection, an exhausted pool, a
   * constraint rejection. The first two are retried, the last stops everything,
   * and anything unrecognised is logged and skipped so `--resume` and the retry
   * sweep can pick it up later.
   */
  const runTaskGuarded = async (
    f: ForecasterCtx,
    identifier: string,
    body: () => Promise<void>,
  ): Promise<void> => {
    bump(attempted, f.forecasterId);
    for (let attempt = 0; attempt <= taskMaxRetries; attempt++) {
      try {
        await body();
        return;
      } catch (error) {
        const kind = classifyTaskError(error);
        if (kind === "fatal") {
          logger.logError(
            "Database rejected a forecast row — stopping the run",
            error,
            { forecaster: f.name, identifier },
          );
          fatalError = error;
          return;
        }
        if (kind === "transient" && attempt < taskMaxRetries) {
          await new Promise((r) =>
            setTimeout(
              r,
              Math.min(1000 * 2 ** attempt, 15000) +
                Math.floor(Math.random() * 500),
            ),
          );
          continue;
        }
        bump(hardFailures, f.forecasterId);
        logger.logError("Task failed; leaving it for a later pass", error, {
          forecaster: f.name,
          identifier,
          kind,
          attempt: attempt + 1,
        });
        return;
      }
    }
  };

  /**
   * Whether this forecaster is failing so consistently that continuing only
   * spends money. Requires a floor of attempts so a couple of early blips on a
   * healthy model cannot trip it.
   */
  const shouldAbandon = (f: ForecasterCtx): boolean => {
    const tried = attempted.get(f.forecasterId) ?? 0;
    const failed = hardFailures.get(f.forecasterId) ?? 0;
    return tried >= 20 && failed / tried > taskFailureAbortRate;
  };

  const runForecaster = async (f: ForecasterCtx): Promise<void> => {
    const tasks: AnyTask[] = [];
    for (const row of marketRows) {
      for (const isNegated of [false, true]) {
        for (let iteration = 0; iteration < promptIterations; iteration++) {
          const key = taskKey(
            f.forecasterId,
            row.marketId,
            isNegated,
            iteration,
          );
          if (completed.has(key)) continue;
          tasks.push({
            kind: "direct",
            event: row.event,
            market: row.market,
            eventId: row.eventId,
            marketId: row.marketId,
            isNegated,
            iteration,
          });
        }
      }
    }
    for (const row of pairRows) {
      for (const combination of PAIRWISE_COMBINATIONS) {
        for (let iteration = 0; iteration < pairwiseIterations; iteration++) {
          const key = pairwiseTaskKey(
            f.forecasterId,
            row.marketAId,
            row.marketBId,
            combination.isANegated,
            combination.isBNegated,
            iteration,
          );
          if (completedPairwise.has(key)) continue;
          tasks.push({
            kind: "pairwise",
            pair: row.pair,
            marketAId: row.marketAId,
            marketBId: row.marketBId,
            combination,
            iteration,
          });
        }
      }
    }

    if (tasks.length === 0) {
      console.log(`[${f.name}] nothing to do (already complete)`);
      await db.markPredictorCompleted(benchmarkRunId, f.forecasterId);
      return;
    }
    console.log(`[${f.name}] ${tasks.length} task(s) to run`);
    progress.set(f.name, { done: 0, total: tasks.length, at: Date.now() });

    let done = 0;
    await runPool(
      tasks,
      concurrency,
      async (item) => {
        if (item.kind === "pairwise") {
          await runPairwiseTask(f, item);
        } else {
          await runDirectTask(f, item);
        }
        done++;
        progress.set(f.name, { done, total: tasks.length, at: Date.now() });
        if (done % 25 === 0 || done === tasks.length) {
          console.log(`[${f.name}] ${done}/${tasks.length} done`);
        }
      },
      () => fatalError !== null || shouldAbandon(f),
    );

    // Forecaster finished — flush its remaining on-chain batch immediately
    // rather than waiting for the batch timeout.
    if (registry) await registry.flush(f.name);

    if (fatalError !== null) return;
    if (shouldAbandon(f)) {
      abandoned.add(f.name);
      await db.markPredictorFailed(benchmarkRunId, f.forecasterId);
      console.error(
        `[${f.name}] abandoned — ${hardFailures.get(f.forecasterId)} of ` +
          `${attempted.get(f.forecasterId)} attempted task(s) failed outright ` +
          `(limit ${(taskFailureAbortRate * 100).toFixed(0)}%). Its rows so far are kept; ` +
          `fix the cause and --resume ${benchmarkRunId}.`,
      );
      return;
    }
    await db.markPredictorCompleted(benchmarkRunId, f.forecasterId);
    console.log(`[${f.name}] complete`);
  };

  const runDirectTask = async (f: ForecasterCtx, task: Task): Promise<void> => {
    const identifier = `m${task.marketId}-${task.isNegated ? "neg" : "base"}-i${task.iteration}`;
    await runTaskGuarded(f, identifier, async () => {
      const result = await inference({
        apiKey,
        model: f.model.slug,
        providerOrder: f.model.providerOrder,
        event: task.event,
        market: task.market,
        isNegated: task.isNegated,
        identifier,
      });

      // Trace and forecast go in as one transaction. Written separately, a
      // failure between them left an inference we had paid for recorded in a
      // row nothing points at — invisible to every query and to --resume, so
      // the task was silently bought twice.
      const outcome = outcomeForPhrasing(task.isNegated);
      const { forecastId } = await db.recordForecastWithTrace({
        benchmarkRunId,
        forecasterId: f.forecasterId,
        eventId: task.eventId,
        marketId: task.marketId,
        identifier,
        result,
        isNegated: task.isNegated,
        promptIteration: task.iteration,
        parsedOdds: result.parsedOdds,
        outcome,
      });

      const failed = result.parsedOdds === null;
      await db.bumpPredictorProgress(
        benchmarkRunId,
        f.forecasterId,
        1,
        failed ? 1 : 0,
      );

      // Only record a usable forecast on-chain.
      if (registry && !failed) {
        const record: PendingForecastRecord = {
          forecastId,
          forecasterName: f.name,
          platformId: POLYMARKET_PLATFORM_ID,
          marketId: task.market.externalId,
          outcome,
          probability: result.parsedOdds!,
        };
        await registry.queueForecasts([record]);
      }
    });
  };

  const runPairwiseTask = async (
    f: ForecasterCtx,
    task: PairwiseTask,
  ): Promise<void> => {
    const { combination, pair } = task;
    const combo = `${combination.isANegated ? "neg" : "base"}-${combination.isBNegated ? "neg" : "base"}`;
    const identifier = `p${task.marketAId}v${task.marketBId}-${combo}-i${task.iteration}`;

    await runTaskGuarded(f, identifier, async () => {
      const result = await pairwiseInference({
        apiKey,
        model: f.model.slug,
        providerOrder: f.model.providerOrder,
        pair,
        combination,
        identifier,
      });

      // A side asked in its negated phrasing is asking about that market's
      // "No", exactly as on the direct path.
      const outcomeA = outcomeForPhrasing(combination.isANegated);
      const outcomeB = outcomeForPhrasing(combination.isBNegated);
      const isALikelier = result.choice === null ? null : result.choice === "A";

      const { pairwiseForecastId } = await db.recordPairwiseForecastWithTrace({
        benchmarkRunId,
        forecasterId: f.forecasterId,
        marketAId: task.marketAId,
        marketBId: task.marketBId,
        identifier,
        result,
        isANegated: combination.isANegated,
        isBNegated: combination.isBNegated,
        promptIteration: task.iteration,
        isALikelier,
        outcomeA,
        outcomeB,
      });

      await db.bumpPredictorProgress(
        benchmarkRunId,
        f.forecasterId,
        1,
        isALikelier === null ? 1 : 0,
      );

      if (registry && isALikelier !== null) {
        const record: PendingPairwiseForecastRecord = {
          pairwiseForecastId,
          forecasterName: f.name,
          platformIdA: POLYMARKET_PLATFORM_ID,
          marketAId: pair.marketA.externalId,
          marketAOutcome: outcomeA,
          platformIdB: POLYMARKET_PLATFORM_ID,
          marketBId: pair.marketB.externalId,
          marketBOutcome: outcomeB,
          isALikelier,
        };
        await registry.queuePairwiseForecasts([record]);
      }
    });
  };

  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    const elapsedMin = (Date.now() - startedAt) / 60000;
    let done = 0;
    let total = 0;
    for (const p of progress.values()) {
      done += p.done;
      total += p.total;
    }
    const rate = elapsedMin > 0 ? done / elapsedMin : 0;
    const eta =
      rate > 0 && total > done
        ? `${((total - done) / rate / 60).toFixed(1)}h`
        : "n/a";
    const running = Array.from(progress.entries())
      .filter(([name, p]) => p.done < p.total && !abandoned.has(name))
      .map(([name, p]) => `${name} ${p.done}/${p.total}`);
    console.log(
      `\n⏱  ${elapsedMin.toFixed(1)}min elapsed — ${done}/${total} task(s), ` +
        `${rate.toFixed(1)}/min, ETA ${eta}` +
        `\n   active: ${running.length > 0 ? running.join(", ") : "none"}` +
        `\n   waiting for a slot: ${Math.max(0, forecasters.length - modelConcurrency - completedForecasters)}`,
    );
    // A forecaster that has completed nothing for a long stretch is either on a
    // very slow model or wedged; either way it is the thing deciding when this
    // run ends, so say so rather than leaving it to be inferred from silence.
    for (const [name, p] of progress) {
      if (p.done >= p.total || abandoned.has(name)) continue;
      const stalledMin = (Date.now() - p.at) / 60000;
      if (stalledMin >= STALL_WARN_MINUTES) {
        console.warn(
          `   ⚠️  ${name} has completed no task in ${stalledMin.toFixed(0)}min (${p.done}/${p.total})`,
        );
      }
    }
  }, HEARTBEAT_MS);

  try {
    // Models run in a bounded pool rather than all at once. `runPool` steals
    // work by index, so a fast model finishing frees its slot immediately —
    // which is the property that matters when model speeds differ by 10x.
    await runPool(
      forecasters,
      modelConcurrency,
      async (f) => {
        await runForecaster(f);
        completedForecasters++;
      },
      () => fatalError !== null,
    );

    // Sweep up whatever transient failures left behind, re-deriving what is
    // outstanding from the database exactly as a --resume would. Cheaper than
    // asking an operator to notice and re-run by hand, and identically correct.
    for (let pass = 1; pass <= retryPasses && fatalError === null; pass++) {
      const remaining = forecasters.filter(
        (f) =>
          !abandoned.has(f.name) && (hardFailures.get(f.forecasterId) ?? 0) > 0,
      );
      if (remaining.length === 0) break;
      console.log(
        `\n↻ Retry pass ${pass}/${retryPasses} for ${remaining.length} forecaster(s) with failed task(s)`,
      );
      completed = await db.getCompletedTaskKeys(benchmarkRunId);
      completedPairwise = await db.getCompletedPairwiseTaskKeys(benchmarkRunId);
      // Reset the ratio so the pass is judged on its own evidence: a model that
      // failed a handful of tasks out of thousands should not inherit a verdict
      // from work it has already redone.
      for (const f of remaining) {
        hardFailures.set(f.forecasterId, 0);
        attempted.set(f.forecasterId, 0);
      }
      await runPool(
        remaining,
        modelConcurrency,
        (f) => runForecaster(f),
        () => fatalError !== null,
      );
    }

    if (registry) await registry.flushAll();
    if (fatalError !== null) throw fatalError;

    const droppedRecords = registry?.getDroppedRecordCount() ?? 0;
    const healthy = abandoned.size === 0 && droppedRecords === 0;
    await db.markBenchmarkRunEnded(
      benchmarkRunId,
      healthy ? "completed" : "failed",
    );

    if (healthy) {
      console.log(`\n✅ Benchmark run ${benchmarkRunId} completed.`);
    } else {
      console.error(`\n❌ Benchmark run ${benchmarkRunId} finished with gaps:`);
      if (abandoned.size > 0) {
        console.error(
          `   ${abandoned.size} forecaster(s) abandoned on the failure threshold: ` +
            `${Array.from(abandoned).join(", ")}`,
        );
      }
      if (droppedRecords > 0) {
        // These forecasts exist in the DB and are usable; they just never
        // reached the chain. republish.ts re-checks the chain and re-sends only
        // what genuinely never landed.
        const byForecaster = new Map<string, number>();
        for (const drop of registry!.getDroppedBatches()) {
          byForecaster.set(
            drop.forecasterName,
            (byForecaster.get(drop.forecasterName) ?? 0) + drop.recordCount,
          );
        }
        console.error(
          `   ${droppedRecords} record(s) in ${registry!.getDroppedBatches().length} batch(es) ` +
            `never reached the chain: ` +
            Array.from(byForecaster)
              .map(([name, n]) => `${name} (${n})`)
              .join(", "),
        );
        console.error(
          `   Repair with: npx tsx scripts/republish.ts --run ${benchmarkRunId} --apply`,
        );
      }
      process.exitCode = 1;
    }

    if (undeclared.length > 0) {
      console.warn(
        `\n⚠️  ${undeclared.length} forecaster(s) never declared their model on-chain: ` +
          `${undeclared.join(", ")}.\n` +
          `   Their forecasts are published from an address that cannot be attributed to a model.\n` +
          `   Re-run to repair the claim, then confirm with: verify-run.ts --run ${benchmarkRunId} --onchain`,
      );
    }
    console.log(
      `\nNext: npx tsx scripts/verify-run.ts --run ${benchmarkRunId}${registry ? " --onchain" : ""}`,
    );
  } catch (error) {
    logger.logError("Benchmark run failed", error, {});
    // The final flush is the last chance for anything still queued to reach the
    // chain; a failure here has to be visible, not swallowed.
    if (registry) {
      await registry
        .flushAll()
        .catch((flushError) =>
          logger.logError("Final flush failed", flushError, {}),
        );
    }
    await db.markBenchmarkRunEnded(benchmarkRunId, "failed");
    throw error;
  } finally {
    clearInterval(heartbeat);
    await db.close();
  }
}

main().catch((error) => {
  console.error("Benchmark failed:", error);
  process.exit(1);
});
