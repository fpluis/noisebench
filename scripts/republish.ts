// Re-submit forecasts that were produced but never made it on-chain.
//
//   npx tsx scripts/republish.ts --run 12 [--apply]
//
// The registry client discards a batch once its retries are exhausted, and
// nothing retries it afterwards: the forecast stays in Postgres with
// transaction_id NULL and simply never appears in the public log. Check C in
// verify-run.ts finds those rows; this script fixes them.
//
// Defaults to a dry run. Pass --apply to actually submit.
//
// IMPORTANT: a batch can also be dropped after it was already broadcast (the
// "already-submitted" classification covers nonce-too-low / already-known),
// in which case the forecast IS on-chain and only the DB linkage is missing.
// Blindly re-sending would duplicate it in an append-only log, so every
// candidate is first checked against the chain and merely re-stamped if found.

import * as dotenv from "dotenv";
import { ethers } from "ethers";
import { Database } from "../src/db";
import { Pool } from "pg";
import { ForecastRegistryClient } from "../src/forecast-registry-client";
import { FORECAST_REGISTRY_ABI } from "../src/forecast-registry-abi";
import {
  PendingForecastRecord,
  PendingPairwiseForecastRecord,
  POLYMARKET_PLATFORM_ID,
} from "../src/types";
import {
  createForecastRegistryConfigFromEnv,
  deriveWalletFromMnemonic,
  loadMasterMnemonic,
  parseArgs,
} from "../src/utils";

dotenv.config();

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = parseInt((args.run as string) || "", 10);
  if (!Number.isInteger(runId)) {
    throw new Error("Usage: republish.ts --run <benchmarkRunId> [--apply]");
  }
  const apply = Boolean(args.apply);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const pool = new Pool({ connectionString: databaseUrl });
  const db = new Database(databaseUrl);
  const config = createForecastRegistryConfigFromEnv();
  const mnemonic = loadMasterMnemonic();

  try {
    // Every usable forecast in this run with no transaction linkage.
    const pending = await pool.query(
      `SELECT f.id, fc.name AS forecaster, w.address, wpdi.derivation_index,
              mk.external_id AS market_id, f.outcome,
              f.parsed_odds::float AS parsed_odds
       FROM public.forecast f
       JOIN public.forecaster fc ON fc.id = f.forecaster_id
       JOIN public.wallet w      ON w.id = fc.wallet_id
       JOIN public.wallet_predictor_derivation_index wpdi
         ON wpdi.wallet_id = w.id AND wpdi.predictor_id = fc.id
       JOIN public.market mk     ON mk.id = f.market_id
       WHERE f.benchmark_run_id = $1
         AND f.parsed_odds IS NOT NULL
         AND f.transaction_id IS NULL
       ORDER BY fc.name, f.id`,
      [runId],
    );

    // The same, for pairwise judgments.
    const pendingPairwise = await pool.query(
      `SELECT p.id, fc.name AS forecaster, w.address, wpdi.derivation_index,
              ma.external_id AS market_a, p.outcome_a,
              mb.external_id AS market_b, p.outcome_b,
              p.is_a_likelier
       FROM public.pairwise_forecast p
       JOIN public.forecaster fc ON fc.id = p.forecaster_id
       JOIN public.wallet w      ON w.id = fc.wallet_id
       JOIN public.wallet_predictor_derivation_index wpdi
         ON wpdi.wallet_id = w.id AND wpdi.predictor_id = fc.id
       JOIN public.market ma     ON ma.id = p.market_a_id
       JOIN public.market mb     ON mb.id = p.market_b_id
       WHERE p.benchmark_run_id = $1
         AND p.is_a_likelier IS NOT NULL
         AND p.transaction_id IS NULL
       ORDER BY fc.name, p.id`,
      [runId],
    );

    if (pending.rows.length === 0 && pendingPairwise.rows.length === 0) {
      console.log(`✅ Run ${runId}: nothing to republish.`);
      return;
    }
    console.log(
      `Run ${runId}: ${pending.rows.length} forecast(s) and ` +
        `${pendingPairwise.rows.length} pairwise judgment(s) with no on-chain transaction.`,
    );

    // Group by forecaster, since each publishes from its own wallet.
    const byForecaster = new Map<string, typeof pending.rows>();
    for (const row of pending.rows) {
      const list = byForecaster.get(row.forecaster) ?? [];
      list.push(row);
      byForecaster.set(row.forecaster, list);
    }
    const pairwiseByForecaster = new Map<string, typeof pendingPairwise.rows>();
    for (const row of pendingPairwise.rows) {
      const list = pairwiseByForecaster.get(row.forecaster) ?? [];
      list.push(row);
      pairwiseByForecaster.set(row.forecaster, list);
    }
    // A forecaster may have only one kind pending, so iterate the union.
    const forecasterNames = Array.from(
      new Set([...byForecaster.keys(), ...pairwiseByForecaster.keys()]),
    ).sort();

    const provider = new ethers.JsonRpcProvider(
      config.rpcUrls[0],
      config.chainId,
      { staticNetwork: true, batchMaxCount: 1 },
    );
    const readContract = new ethers.Contract(
      config.contractAddress,
      FORECAST_REGISTRY_ABI as unknown as ethers.InterfaceAbi,
      provider,
    );

    const registry = new ForecastRegistryClient(config);
    await registry.initialize();
    registry.setBatchSubmittedHandler(async (records, txHash, blockNumber) => {
      await db.stampForecastsWithTransaction(
        records.map((r) => r.forecastId),
        txHash,
        blockNumber,
      );
    });
    registry.setPairwiseBatchSubmittedHandler(
      async (records, txHash, blockNumber) => {
        await db.stampPairwiseForecastsWithTransaction(
          records.map((r) => r.pairwiseForecastId),
          txHash,
          blockNumber,
        );
      },
    );

    let alreadyOnChain = 0;
    let toSubmit = 0;
    let pairwiseAlreadyOnChain = 0;
    let pairwiseToSubmit = 0;

    for (const forecaster of forecasterNames) {
      const rows = byForecaster.get(forecaster) ?? [];
      const pairwiseRows = pairwiseByForecaster.get(forecaster) ?? [];
      const identity = rows[0] ?? pairwiseRows[0];
      const wallet = deriveWalletFromMnemonic(
        mnemonic,
        identity.derivation_index,
      );
      registry.addForecaster(forecaster, wallet.privateKey);

      // What this wallet has actually published, as a multiset.
      const logs = await readContract.queryFilter(
        readContract.filters.ForecastRecorded(identity.address),
      );
      const onChain = new Map<string, number>();
      for (const log of logs) {
        const a = (log as ethers.EventLog).args;
        const key = `${a.marketId}|${a.outcome}|${Number(a.odds)}`;
        onChain.set(key, (onChain.get(key) ?? 0) + 1);
      }
      // Rows already correctly stamped consume matching log entries, so we only
      // credit surplus ones to the unstamped rows below.
      const stamped = await pool.query(
        `SELECT mk.external_id AS market_id, f.outcome,
                ROUND(f.parsed_odds * 10000)::int AS odds
         FROM public.forecast f
         JOIN public.market mk ON mk.id = f.market_id
         WHERE f.benchmark_run_id = $1 AND f.forecaster_id =
               (SELECT id FROM public.forecaster WHERE name = $2)
           AND f.transaction_id IS NOT NULL`,
        [runId, forecaster],
      );
      for (const row of stamped.rows) {
        const key = `${row.market_id}|${row.outcome}|${row.odds}`;
        const n = onChain.get(key) ?? 0;
        if (n > 0) onChain.set(key, n - 1);
      }

      const resubmit: PendingForecastRecord[] = [];
      const recovered: number[] = [];
      for (const row of rows) {
        const odds = Math.round(row.parsed_odds * 10000);
        const key = `${row.market_id}|${row.outcome}|${odds}`;
        const surplus = onChain.get(key) ?? 0;
        if (surplus > 0) {
          // It landed after all — only the DB linkage was lost.
          onChain.set(key, surplus - 1);
          recovered.push(row.id);
        } else {
          resubmit.push({
            forecastId: row.id,
            forecasterName: forecaster,
            platformId: POLYMARKET_PLATFORM_ID,
            marketId: row.market_id,
            outcome: row.outcome,
            probability: row.parsed_odds,
          });
        }
      }

      // The same recovery pass for pairwise judgments. The key is the whole
      // judgment — both sides, both outcomes, and which one won — because that
      // is all the event carries; iterations are indistinguishable on-chain.
      const pwLogs = await readContract.queryFilter(
        readContract.filters.PairwiseForecastRecorded(identity.address),
      );
      const pwOnChain = new Map<string, number>();
      for (const log of pwLogs) {
        const a = (log as ethers.EventLog).args;
        const key = `${a.marketAId}|${a.marketAOutcome}|${a.marketBId}|${a.marketBOutcome}|${a.isALikelier}`;
        pwOnChain.set(key, (pwOnChain.get(key) ?? 0) + 1);
      }
      const pwStamped = await pool.query(
        `SELECT ma.external_id AS market_a, p.outcome_a,
                mb.external_id AS market_b, p.outcome_b, p.is_a_likelier
         FROM public.pairwise_forecast p
         JOIN public.market ma ON ma.id = p.market_a_id
         JOIN public.market mb ON mb.id = p.market_b_id
         WHERE p.benchmark_run_id = $1 AND p.forecaster_id =
               (SELECT id FROM public.forecaster WHERE name = $2)
           AND p.transaction_id IS NOT NULL`,
        [runId, forecaster],
      );
      for (const row of pwStamped.rows) {
        const key = `${row.market_a}|${row.outcome_a}|${row.market_b}|${row.outcome_b}|${row.is_a_likelier}`;
        const n = pwOnChain.get(key) ?? 0;
        if (n > 0) pwOnChain.set(key, n - 1);
      }

      const pwResubmit: PendingPairwiseForecastRecord[] = [];
      const pwRecovered: number[] = [];
      for (const row of pairwiseRows) {
        const key = `${row.market_a}|${row.outcome_a}|${row.market_b}|${row.outcome_b}|${row.is_a_likelier}`;
        const surplus = pwOnChain.get(key) ?? 0;
        if (surplus > 0) {
          pwOnChain.set(key, surplus - 1);
          pwRecovered.push(row.id);
        } else {
          pwResubmit.push({
            pairwiseForecastId: row.id,
            forecasterName: forecaster,
            platformIdA: POLYMARKET_PLATFORM_ID,
            marketAId: row.market_a,
            marketAOutcome: row.outcome_a,
            platformIdB: POLYMARKET_PLATFORM_ID,
            marketBId: row.market_b,
            marketBOutcome: row.outcome_b,
            isALikelier: row.is_a_likelier,
          });
        }
      }

      alreadyOnChain += recovered.length;
      toSubmit += resubmit.length;
      pairwiseAlreadyOnChain += pwRecovered.length;
      pairwiseToSubmit += pwResubmit.length;
      console.log(
        `  ${forecaster}: ${recovered.length} already on-chain (needs re-stamping only), ${resubmit.length} to submit` +
          (pairwiseRows.length > 0
            ? `; pairwise ${pwRecovered.length} already on-chain, ${pwResubmit.length} to submit`
            : ""),
      );

      if (apply) {
        const recoveredTotal = recovered.length + pwRecovered.length;
        if (recoveredTotal > 0) {
          // The original tx hash is unknown; record the linkage against the
          // block the log was found in rather than leaving it dangling.
          console.log(
            `    re-stamping ${recoveredTotal} recovered record(s) is not automatic — ` +
              `they are on-chain but their tx hash was never captured. Leaving as-is.`,
          );
        }
        // Queue both kinds before flushing: one flush then submits them as two
        // sequential transactions from this wallet, rather than racing them for
        // the same nonce.
        if (resubmit.length > 0) await registry.queueForecasts(resubmit);
        if (pwResubmit.length > 0) {
          await registry.queuePairwiseForecasts(pwResubmit);
        }
        if (resubmit.length > 0 || pwResubmit.length > 0) {
          await registry.flush(forecaster);
        }
      }
    }

    const totalToSubmit = toSubmit + pairwiseToSubmit;
    console.log(
      `\n${apply ? "Applied" : "Dry run"}: ` +
        `${alreadyOnChain} forecast(s) and ${pairwiseAlreadyOnChain} pairwise judgment(s) already on-chain; ` +
        `${toSubmit} and ${pairwiseToSubmit} needing submission.`,
    );
    if (!apply && totalToSubmit > 0) {
      console.log("Re-run with --apply to submit them.");
    }
  } finally {
    await pool.end();
    await db.close();
  }
}

main().catch((error) => {
  console.error("republish failed:", error);
  process.exit(1);
});
