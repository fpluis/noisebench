// noisebench — benchmark entry point.
//
//   npm run benchmark -- --config <config.json> --dataset <dataset.json>
//   npm run benchmark -- --config <config.json> --resume <benchmarkRunId>
//
// For every event in the dataset, for every market, for every model, for both
// the base and negated phrasing, for each of `promptIterations` repetitions, we
// call the model, persist the trace + forecast, and record the forecast on-chain
// (unless SKIP_ONCHAIN=true). --resume continues an existing run, skipping tasks
// whose forecast was already produced successfully.

import * as dotenv from "dotenv";
import { ethers } from "ethers";
import { Database, taskKey } from "../src/db";
import { generateForecast } from "../src/llm";
import { fakeGenerateForecast } from "../src/llm-fake";
import { ForecastRegistryClient } from "../src/forecast-registry-client";
import {
  DatasetEvent,
  DatasetMarket,
  NormalizedModel,
  PendingForecastRecord,
  POLYMARKET_PLATFORM_ID,
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
  parseArgs,
} from "../src/utils";
import { logger } from "../src/logger";

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

// Run `worker` over `items` with at most `concurrency` in flight.
async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const runners = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length || 1)) },
    async () => {
      while (index < items.length) {
        const current = items[index++];
        await worker(current);
      }
    },
  );
  await Promise.all(runners);
}

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
  const dataset = loadDataset(datasetPath);
  const models = config.models.map(normalizeModel);
  const promptIterations = config.promptIterations ?? 4;
  const concurrency = config.concurrency ?? 6;

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
      await db.stampForecastsWithTransaction(forecastIds, txHash, blockNumber);
    });
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
  for (const event of dataset) {
    const eventId = await db.upsertEvent(event);
    eventRows.push({ event, eventId });
    for (const market of event.markets) {
      const marketId = await db.upsertMarket(eventId, market);
      marketRows.push({ event, market, eventId, marketId });
    }
  }

  let benchmarkRunId: number;
  let completed: Set<string>;
  if (resumeRunId !== null) {
    const run = await db.getBenchmarkRun(resumeRunId);
    if (!run) throw new Error(`Benchmark run ${resumeRunId} not found`);
    benchmarkRunId = run.id;
    completed = await db.getCompletedTaskKeys(benchmarkRunId);
    console.log(
      `Resuming benchmark run ${benchmarkRunId} — ${completed.size} tasks already complete`,
    );
  } else {
    benchmarkRunId = await db.createBenchmarkRun({
      name: config.name,
      description: config.description,
      datasetName: datasetPath,
      models: models.map((m) => m.slug),
      promptIterations,
      config,
    });
    for (const row of marketRows) {
      await db.addBenchmarkRunMarket(benchmarkRunId, row.marketId);
    }
    completed = new Set<string>();
    console.log(`Created benchmark run ${benchmarkRunId}`);
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
  const totalTasksPerForecaster = marketRows.length * 2 * promptIterations;
  for (const f of forecasters) {
    await db.upsertBenchmarkPredictorState(
      benchmarkRunId,
      f.forecasterId,
      totalTasksPerForecaster,
    );
  }

  console.log(
    `Running ${forecasters.length} forecaster(s) × ${marketRows.length} market(s) × 2 modalities × ${promptIterations} iteration(s)`,
  );

  const runForecaster = async (f: ForecasterCtx): Promise<void> => {
    const tasks: Task[] = [];
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

    if (tasks.length === 0) {
      console.log(`[${f.name}] nothing to do (already complete)`);
      await db.markPredictorCompleted(benchmarkRunId, f.forecasterId);
      return;
    }
    console.log(`[${f.name}] ${tasks.length} task(s) to run`);

    let done = 0;
    await runPool(tasks, concurrency, async (task) => {
      const identifier = `m${task.marketId}-${task.isNegated ? "neg" : "base"}-i${task.iteration}`;
      const result = await inference({
        apiKey,
        model: f.model.slug,
        providerOrder: f.model.providerOrder,
        event: task.event,
        market: task.market,
        isNegated: task.isNegated,
        identifier,
      });

      const traceId = await db.logLLMTrace({
        forecasterId: f.forecasterId,
        identifier,
        result,
      });

      const outcome = task.isNegated ? "No" : "Yes";
      const forecastId = await db.upsertForecast({
        benchmarkRunId,
        forecasterId: f.forecasterId,
        eventId: task.eventId,
        marketId: task.marketId,
        llmTraceId: traceId,
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

      done++;
      if (done % 25 === 0 || done === tasks.length) {
        console.log(`[${f.name}] ${done}/${tasks.length} done`);
      }
    });

    // Forecaster finished — flush its remaining on-chain batch immediately
    // rather than waiting for the batch timeout.
    if (registry) await registry.flush(f.name);
    await db.markPredictorCompleted(benchmarkRunId, f.forecasterId);
    console.log(`[${f.name}] complete`);
  };

  try {
    await Promise.all(forecasters.map((f) => runForecaster(f)));
    if (registry) await registry.flushAll();
    await db.markBenchmarkRunEnded(benchmarkRunId, "completed");
    console.log(`\n✅ Benchmark run ${benchmarkRunId} completed.`);
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
    if (registry) await registry.flushAll().catch(() => {});
    await db.markBenchmarkRunEnded(benchmarkRunId, "failed");
    throw error;
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error("Benchmark failed:", error);
  process.exit(1);
});
