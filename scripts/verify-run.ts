// Reconcile a benchmark run across all three stores: what the model said, what
// Postgres recorded, and what landed on-chain.
//
//   npx tsx scripts/verify-run.ts --run 12
//   npx tsx scripts/verify-run.ts --run 12 --onchain
//
// This is the check that actually answers "is it correctly wired". Every other
// test proves a component works in isolation; this proves the components agree
// with each other. Run it after every rehearsal AND after the production cycle.
//
// Exits non-zero if any check fails, so it can gate a pipeline.

import * as dotenv from "dotenv";
import { ethers } from "ethers";
import { Pool } from "pg";
import { FORECAST_REGISTRY_ABI } from "../src/forecast-registry-abi";
import { createForecastRegistryConfigFromEnv, parseArgs } from "../src/utils";

dotenv.config();

type Status = "PASS" | "FAIL" | "WARN" | "SKIP";

interface CheckResult {
  id: string;
  title: string;
  status: Status;
  detail: string;
  // A few example offending rows, for actually debugging the failure.
  samples?: string[];
}

const results: CheckResult[] = [];
const record = (r: CheckResult) => {
  results.push(r);
  const icon = { PASS: "✅", FAIL: "❌", WARN: "⚠️ ", SKIP: "⏭️ " }[r.status];
  console.log(`${icon} [${r.id}] ${r.title}`);
  console.log(`      ${r.detail}`);
  for (const s of (r.samples ?? []).slice(0, 5)) console.log(`        - ${s}`);
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = parseInt((args.run as string) || "", 10);
  if (!Number.isInteger(runId)) {
    throw new Error("Usage: verify-run.ts --run <benchmarkRunId> [--onchain]");
  }
  const checkOnchain = Boolean(args.onchain);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const runRes = await pool.query(
      `SELECT r.id, r.name, r.dataset_name, r.prompt_iterations, s.name AS status,
              r.started_at, r.ended_at
       FROM public.benchmark_run r
       JOIN public.benchmark_status s ON s.id = r.status_id
       WHERE r.id = $1`,
      [runId],
    );
    if (runRes.rows.length === 0) {
      throw new Error(`Benchmark run ${runId} not found`);
    }
    const run = runRes.rows[0];
    const iterations: number = run.prompt_iterations;

    console.log(`\nBenchmark run ${run.id} — "${run.name}"`);
    console.log(`  dataset: ${run.dataset_name}`);
    console.log(`  status:  ${run.status}`);
    console.log("");

    const modelCount = (
      await pool.query(
        `SELECT COUNT(*)::int AS n FROM public.benchmark_run_model WHERE benchmark_run_id = $1`,
        [runId],
      )
    ).rows[0].n;
    const marketCount = (
      await pool.query(
        `SELECT COUNT(*)::int AS n FROM public.benchmark_run_market WHERE benchmark_run_id = $1`,
        [runId],
      )
    ).rows[0].n;

    // -----------------------------------------------------------------------
    // A. Completeness — did every planned task produce a row?
    // -----------------------------------------------------------------------
    const expected = modelCount * marketCount * 2 * iterations;
    const actualRes = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(parsed_odds)::int AS parsed
       FROM public.forecast WHERE benchmark_run_id = $1`,
      [runId],
    );
    const { total, parsed } = actualRes.rows[0];
    record({
      id: "A",
      title: "Completeness",
      status: total === expected ? "PASS" : "FAIL",
      detail:
        `expected ${expected} forecast rows ` +
        `(${modelCount} models x ${marketCount} markets x 2 phrasings x ${iterations} iterations), ` +
        `found ${total}; ${parsed} have a parsed probability ` +
        `(${total ? ((parsed / total) * 100).toFixed(1) : "0"}% parse rate)`,
    });

    // -----------------------------------------------------------------------
    // B. Trace linkage — every forecast points at the call that produced it,
    //    and that call was made with the forecaster's own model.
    // -----------------------------------------------------------------------
    const orphanRes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM public.forecast
       WHERE benchmark_run_id = $1 AND llm_trace_id IS NULL`,
      [runId],
    );
    const mismatchRes = await pool.query(
      `SELECT f.id, fc.name AS forecaster, m1.name AS trace_model, m2.name AS forecaster_model
       FROM public.forecast f
       JOIN public.llm_trace t   ON t.id = f.llm_trace_id
       JOIN public.forecaster fc ON fc.id = f.forecaster_id
       JOIN public.llm_model m1  ON m1.id = t.llm_model_id
       JOIN public.llm_model m2  ON m2.id = fc.forecasting_model_id
       WHERE f.benchmark_run_id = $1 AND m1.id <> m2.id
       LIMIT 5`,
      [runId],
    );
    const orphans = orphanRes.rows[0].n;
    record({
      id: "B",
      title: "Trace linkage",
      status: orphans === 0 && mismatchRes.rows.length === 0 ? "PASS" : "FAIL",
      detail: `${orphans} forecast(s) without an llm_trace; ${mismatchRes.rows.length} with a trace from the wrong model`,
      samples: mismatchRes.rows.map(
        (r) =>
          `forecast ${r.id}: forecaster ${r.forecaster} is ${r.forecaster_model} but trace is ${r.trace_model}`,
      ),
    });

    // -----------------------------------------------------------------------
    // C. Publication — the silent-drop detector.
    //    A batch that exhausts its retries is discarded by the registry client
    //    and never retried, leaving a usable forecast that never reached the
    //    chain. Nothing else in the system notices; this is what notices.
    // -----------------------------------------------------------------------
    const unpublishedRes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM public.forecast
       WHERE benchmark_run_id = $1 AND parsed_odds IS NOT NULL AND transaction_id IS NULL`,
      [runId],
    );
    const unpublished = unpublishedRes.rows[0].n;
    const skipOnchain =
      String(process.env.SKIP_ONCHAIN).toLowerCase() === "true";
    record({
      id: "C",
      title: "Publication (silent on-chain drop detector)",
      status: skipOnchain ? "SKIP" : unpublished === 0 ? "PASS" : "FAIL",
      detail: skipOnchain
        ? "SKIP_ONCHAIN=true — nothing was expected on-chain"
        : `${unpublished} usable forecast(s) have no transaction. ` +
          (unpublished > 0
            ? "These were dropped after failed submission; re-publish with scripts/republish.ts."
            : "Every usable forecast is on-chain."),
    });

    // -----------------------------------------------------------------------
    // D. Progress bookkeeping matches reality.
    // -----------------------------------------------------------------------
    const stateRes = await pool.query(
      `SELECT fc.name,
              s.completed_tasks,
              s.total_tasks,
              (SELECT COUNT(*)::int FROM public.forecast f
                WHERE f.benchmark_run_id = s.benchmark_run_id
                  AND f.forecaster_id = s.forecaster_id) AS actual_rows
       FROM public.benchmark_predictor_state s
       JOIN public.forecaster fc ON fc.id = s.forecaster_id
       WHERE s.benchmark_run_id = $1`,
      [runId],
    );
    // markPredictorCompleted recomputes these counters from the forecast rows,
    // so on a finished run they must agree exactly. Mid-run they legitimately
    // trail, hence the softer verdict when the run is still going.
    const drifted = stateRes.rows.filter(
      (r) => r.completed_tasks !== r.actual_rows,
    );
    const runFinished = run.status !== "running";
    record({
      id: "D",
      title: "Progress bookkeeping",
      status: drifted.length === 0 ? "PASS" : runFinished ? "FAIL" : "WARN",
      detail:
        drifted.length === 0
          ? `all ${stateRes.rows.length} forecaster state row(s) match their forecast counts`
          : `${drifted.length} forecaster(s) whose counter differs from actual rows` +
            (runFinished
              ? " on a finished run"
              : " (run still in progress — counters trail)"),
      samples: drifted.map(
        (r) =>
          `${r.name}: counter=${r.completed_tasks} actual=${r.actual_rows} total=${r.total_tasks}`,
      ),
    });

    // -----------------------------------------------------------------------
    // F. Semantic coherence — the inversion detector.
    //    Both phrasings must exist for every {forecaster, market, iteration},
    //    and Yes+No should sit near 1. If the base/negated -> Yes/No mapping
    //    ever inverts, this mean jumps from ~0.1 to ~1.0 while every structural
    //    check above still passes.
    // -----------------------------------------------------------------------
    const pairRes = await pool.query(
      `WITH pairs AS (
         SELECT forecaster_id, market_id, prompt_iteration,
                MAX(CASE WHEN is_negated THEN parsed_odds END) AS neg_odds,
                MAX(CASE WHEN NOT is_negated THEN parsed_odds END) AS base_odds
         FROM public.forecast
         WHERE benchmark_run_id = $1 AND parsed_odds IS NOT NULL
         GROUP BY forecaster_id, market_id, prompt_iteration
       )
       SELECT COUNT(*)::int AS complete_pairs,
              AVG(ABS(base_odds + neg_odds - 1))::float AS mean_gap,
              MAX(ABS(base_odds + neg_odds - 1))::float AS max_gap
       FROM pairs WHERE base_odds IS NOT NULL AND neg_odds IS NOT NULL`,
      [runId],
    );
    const { complete_pairs, mean_gap, max_gap } = pairRes.rows[0];
    const expectedPairs = modelCount * marketCount * iterations;
    // A mean near 1.0 means Yes and No are agreeing rather than complementing,
    // i.e. the negation is being recorded on the wrong side.
    const inverted = complete_pairs > 0 && mean_gap !== null && mean_gap > 0.8;
    record({
      id: "F",
      title: "Semantic coherence (Yes+No ~ 1)",
      status: complete_pairs === 0 ? "WARN" : inverted ? "FAIL" : "PASS",
      detail:
        complete_pairs === 0
          ? "no complete base/negated pairs to compare"
          : `${complete_pairs}/${expectedPairs} complete pair(s); ` +
            `mean |Yes+No-1| = ${mean_gap?.toFixed(4)} (this IS the noise metric), ` +
            `max = ${max_gap?.toFixed(4)}` +
            (inverted
              ? " — near 1.0 means the base/negated -> Yes/No mapping is INVERTED"
              : ""),
    });

    // -----------------------------------------------------------------------
    // E. Chain <-> DB bijection.
    // -----------------------------------------------------------------------
    if (!checkOnchain) {
      record({
        id: "E",
        title: "Chain <-> DB reconciliation",
        status: "SKIP",
        detail: "pass --onchain to compare against ForecastRecorded logs",
      });
    } else {
      await verifyOnchain(pool, runId);
    }
  } finally {
    await pool.end();
  }

  const failed = results.filter((r) => r.status === "FAIL");
  console.log(
    `\n${failed.length === 0 ? "✅ All checks passed" : `❌ ${failed.length} check(s) FAILED: ${failed.map((f) => f.id).join(", ")}`}`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

/**
 * Compare the on-chain ForecastRecorded log against the DB, per forecaster
 * wallet. The chain is the published artifact, so any disagreement means the
 * public record and the private record tell different stories.
 */
async function verifyOnchain(pool: Pool, runId: number): Promise<void> {
  const config = createForecastRegistryConfigFromEnv();
  const provider = new ethers.JsonRpcProvider(
    config.rpcUrls[0],
    config.chainId,
    { staticNetwork: true, batchMaxCount: 1 },
  );
  const contract = new ethers.Contract(
    config.contractAddress,
    FORECAST_REGISTRY_ABI as unknown as ethers.InterfaceAbi,
    provider,
  );

  const walletRes = await pool.query(
    `SELECT DISTINCT fc.name, w.address, m.name AS model
     FROM public.forecast f
     JOIN public.forecaster fc ON fc.id = f.forecaster_id
     JOIN public.wallet w      ON w.id = fc.wallet_id
     JOIN public.llm_model m   ON m.id = fc.forecasting_model_id
     WHERE f.benchmark_run_id = $1`,
    [runId],
  );

  if (walletRes.rows.length === 0) {
    record({
      id: "E",
      title: "Chain <-> DB reconciliation",
      status: "WARN",
      detail: "no forecaster in this run has a wallet — nothing to compare",
    });
    return;
  }

  const missingOnChain: string[] = [];
  const oddsMismatch: string[] = [];
  const missingAttribute: string[] = [];
  let onChainTotal = 0;
  let comparedTotal = 0;

  for (const wallet of walletRes.rows) {
    // Every forecast this wallet published for this run, keyed the same way the
    // chain identifies it: {marketId, outcome}. Iterations are indistinguishable
    // on-chain, so compare as a multiset of odds per key.
    const dbRes = await pool.query(
      `SELECT mk.external_id AS market_id, f.outcome,
              ROUND(f.parsed_odds * 10000)::int AS odds
       FROM public.forecast f
       JOIN public.market mk ON mk.id = f.market_id
       JOIN public.forecaster fc ON fc.id = f.forecaster_id
       JOIN public.wallet w ON w.id = fc.wallet_id
       WHERE f.benchmark_run_id = $1
         AND w.address = $2
         AND f.parsed_odds IS NOT NULL
         AND f.transaction_id IS NOT NULL`,
      [runId, wallet.address],
    );

    const dbCounts = new Map<string, number>();
    for (const row of dbRes.rows) {
      const key = `${row.market_id}|${row.outcome}|${row.odds}`;
      dbCounts.set(key, (dbCounts.get(key) ?? 0) + 1);
    }
    comparedTotal += dbRes.rows.length;

    const logs = await contract.queryFilter(
      contract.filters.ForecastRecorded(wallet.address),
    );
    onChainTotal += logs.length;

    const chainCounts = new Map<string, number>();
    for (const log of logs) {
      const a = (log as ethers.EventLog).args;
      const key = `${a.marketId}|${a.outcome}|${Number(a.odds)}`;
      chainCounts.set(key, (chainCounts.get(key) ?? 0) + 1);
    }

    // Every DB row claiming to be published must have a matching log entry.
    for (const [key, count] of dbCounts) {
      const onChain = chainCounts.get(key) ?? 0;
      if (onChain < count) {
        const [marketId, outcome, odds] = key.split("|");
        missingOnChain.push(
          `${wallet.name}: market ${marketId} ${outcome}@${odds}bps — DB has ${count}, chain has ${onChain}`,
        );
      }
    }

    // Odds recorded for a {market, outcome} the DB never produced.
    for (const [key] of chainCounts) {
      const [marketId, outcome, odds] = key.split("|");
      const anyDbForKey = Array.from(dbCounts.keys()).some((k) =>
        k.startsWith(`${marketId}|${outcome}|`),
      );
      if (anyDbForKey && !dbCounts.has(key)) {
        oddsMismatch.push(
          `${wallet.name}: chain has market ${marketId} ${outcome}@${odds}bps with no matching DB odds`,
        );
      }
    }

    // The wallet must have declared its model on-chain, or the published log is
    // anonymous — nobody can tell which model produced these forecasts.
    const attrLogs = await contract.queryFilter(
      contract.filters.AttributeSet(wallet.address),
    );
    const declared = attrLogs.some(
      (log) => (log as ethers.EventLog).args.value === wallet.model,
    );
    if (!declared) {
      missingAttribute.push(
        `${wallet.name} (${wallet.address}) never declared forecastingModel="${wallet.model}" on-chain`,
      );
    }
  }

  record({
    id: "E1",
    title: "Chain <-> DB: every published forecast is on-chain",
    status: missingOnChain.length === 0 ? "PASS" : "FAIL",
    detail: `compared ${comparedTotal} DB row(s) against ${onChainTotal} on-chain event(s) across ${walletRes.rows.length} wallet(s); ${missingOnChain.length} missing`,
    samples: missingOnChain,
  });
  record({
    id: "E2",
    title: "Chain <-> DB: odds agree",
    status: oddsMismatch.length === 0 ? "PASS" : "FAIL",
    detail: `${oddsMismatch.length} on-chain odds value(s) with no matching DB row`,
    samples: oddsMismatch,
  });
  record({
    id: "E3",
    title: "Every wallet declared its model on-chain",
    status: missingAttribute.length === 0 ? "PASS" : "FAIL",
    detail: `${missingAttribute.length} of ${walletRes.rows.length} wallet(s) missing a forecastingModel attribute`,
    samples: missingAttribute,
  });
}

main().catch((error) => {
  console.error("verify-run failed:", error);
  process.exit(1);
});
