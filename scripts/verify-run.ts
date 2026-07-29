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
import {
  BASE_CHAIN_ID,
  createForecastRegistryConfigFromEnv,
  parseArgs,
} from "../src/utils";
import { findDeploymentBlock, queryLogsChunked } from "../src/chain-logs";

dotenv.config();

/**
 * The chain this run's rows are expected to name.
 *
 * Deliberately NOT `resolveChainId()`: that refuses mainnet without
 * ALLOW_MAINNET=true, which is the right guard for something about to spend
 * money and the wrong one for something only reading back what was already
 * spent. Verification must never be harder to run than the run it verifies.
 */
const resolveExpectedChainId = (): number => {
  const parsed = parseInt(process.env.CHAIN_ID || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : BASE_CHAIN_ID;
};

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
      `SELECT r.id, r.name, r.dataset_name, r.prompt_iterations,
              r.pairwise_iterations, s.name AS status, r.started_at, r.ended_at
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
    const pairwiseIterations: number = run.pairwise_iterations;

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
    const pairCount = (
      await pool.query(
        `SELECT COUNT(*)::int AS n FROM public.benchmark_run_pair WHERE benchmark_run_id = $1`,
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
    // A2. Completeness of the pairwise modality.
    // -----------------------------------------------------------------------
    const expectedPairwise =
      modelCount * pairCount * 4 * (pairwiseIterations || 0);
    const pairwiseRes = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(is_a_likelier)::int AS decided
       FROM public.pairwise_forecast WHERE benchmark_run_id = $1`,
      [runId],
    );
    const { total: pwTotal, decided: pwDecided } = pairwiseRes.rows[0];
    record({
      id: "A2",
      title: "Completeness (pairwise)",
      status:
        pairCount === 0
          ? "SKIP"
          : pwTotal === expectedPairwise
            ? "PASS"
            : "FAIL",
      detail:
        pairCount === 0
          ? "this run's dataset lists no pairs"
          : `expected ${expectedPairwise} pairwise rows ` +
            `(${modelCount} models x ${pairCount} pairs x 4 combinations x ${pairwiseIterations} iterations), ` +
            `found ${pwTotal}; ${pwDecided} carry a decision ` +
            `(${pwTotal ? ((pwDecided / pwTotal) * 100).toFixed(1) : "0"}% decision rate — ` +
            `the remainder are refusals, including declared ties)`,
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
    // B2. The same, for pairwise rows.
    // -----------------------------------------------------------------------
    const pwOrphanRes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM public.pairwise_forecast
       WHERE benchmark_run_id = $1 AND llm_trace_id IS NULL`,
      [runId],
    );
    const pwMismatchRes = await pool.query(
      `SELECT p.id, fc.name AS forecaster, m1.name AS trace_model, m2.name AS forecaster_model
       FROM public.pairwise_forecast p
       JOIN public.llm_trace t   ON t.id = p.llm_trace_id
       JOIN public.forecaster fc ON fc.id = p.forecaster_id
       JOIN public.llm_model m1  ON m1.id = t.llm_model_id
       JOIN public.llm_model m2  ON m2.id = fc.forecasting_model_id
       WHERE p.benchmark_run_id = $1 AND m1.id <> m2.id
       LIMIT 5`,
      [runId],
    );
    const pwOrphans = pwOrphanRes.rows[0].n;
    record({
      id: "B2",
      title: "Trace linkage (pairwise)",
      status:
        pairCount === 0
          ? "SKIP"
          : pwOrphans === 0 && pwMismatchRes.rows.length === 0
            ? "PASS"
            : "FAIL",
      detail:
        pairCount === 0
          ? "this run's dataset lists no pairs"
          : `${pwOrphans} pairwise row(s) without an llm_trace; ${pwMismatchRes.rows.length} with a trace from the wrong model`,
      samples: pwMismatchRes.rows.map(
        (r) =>
          `pairwise ${r.id}: forecaster ${r.forecaster} is ${r.forecaster_model} but trace is ${r.trace_model}`,
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
    // C2. The same, for pairwise rows.
    // -----------------------------------------------------------------------
    const pwUnpublishedRes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM public.pairwise_forecast
       WHERE benchmark_run_id = $1 AND is_a_likelier IS NOT NULL AND transaction_id IS NULL`,
      [runId],
    );
    const pwUnpublished = pwUnpublishedRes.rows[0].n;
    record({
      id: "C2",
      title: "Publication (pairwise)",
      status:
        skipOnchain || pairCount === 0
          ? "SKIP"
          : pwUnpublished === 0
            ? "PASS"
            : "FAIL",
      detail: skipOnchain
        ? "SKIP_ONCHAIN=true — nothing was expected on-chain"
        : pairCount === 0
          ? "this run's dataset lists no pairs"
          : `${pwUnpublished} decided pairwise judgment(s) have no transaction. ` +
            (pwUnpublished > 0
              ? "These were dropped after failed submission; re-publish with scripts/republish.ts."
              : "Every decided judgment is on-chain."),
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
                  AND f.forecaster_id = s.forecaster_id)
              + (SELECT COUNT(*)::int FROM public.pairwise_forecast p
                WHERE p.benchmark_run_id = s.benchmark_run_id
                  AND p.forecaster_id = s.forecaster_id) AS actual_rows
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
    // G. Pairwise coherence — the double-negation detector.
    //    Flipping BOTH sides of a comparison must invert it: P(A) > P(B) iff
    //    1-P(A) < 1-P(B). So the four combinations form two couples that must
    //    disagree — (A,B) against (¬A,¬B), and (¬A,B) against (A,¬B). The rate
    //    at which they agree instead IS the pairwise noise metric, and a rate
    //    near 1.0 means the negation is being applied to the wrong side while
    //    every structural check above still passes.
    // -----------------------------------------------------------------------
    const coherenceRes = await pool.query(
      `WITH combos AS (
         SELECT forecaster_id, market_a_id, market_b_id, prompt_iteration,
                MAX(CASE WHEN NOT is_a_negated AND NOT is_b_negated THEN is_a_likelier::int END) AS c00,
                MAX(CASE WHEN     is_a_negated AND     is_b_negated THEN is_a_likelier::int END) AS c11,
                MAX(CASE WHEN     is_a_negated AND NOT is_b_negated THEN is_a_likelier::int END) AS c10,
                MAX(CASE WHEN NOT is_a_negated AND     is_b_negated THEN is_a_likelier::int END) AS c01
         FROM public.pairwise_forecast
         WHERE benchmark_run_id = $1 AND is_a_likelier IS NOT NULL
         GROUP BY forecaster_id, market_a_id, market_b_id, prompt_iteration
       )
       SELECT
         COUNT(*) FILTER (WHERE c00 IS NOT NULL AND c11 IS NOT NULL)::int AS couples,
         COUNT(*) FILTER (WHERE c00 IS NOT NULL AND c11 IS NOT NULL AND c00 = c11)::int AS violations,
         COUNT(*) FILTER (WHERE c10 IS NOT NULL AND c01 IS NOT NULL)::int AS couples_mixed,
         COUNT(*) FILTER (WHERE c10 IS NOT NULL AND c01 IS NOT NULL AND c10 = c01)::int AS violations_mixed
       FROM combos`,
      [runId],
    );
    const coh = coherenceRes.rows[0];
    const totalCouples = coh.couples + coh.couples_mixed;
    const totalViolations = coh.violations + coh.violations_mixed;
    const violationRate = totalCouples > 0 ? totalViolations / totalCouples : 0;
    // Expected couples: two per {model, pair, iteration}.
    const expectedCouples = modelCount * pairCount * pairwiseIterations * 2;

    // The two couples are judged SEPARATELY, and either one alone can fail the
    // check. They are independent invariants, and the realistic bug — a
    // negation applied to the wrong side, or one combination mislabelled —
    // wrecks one couple while leaving the other intact. Averaging the two
    // halves that failure to ~50%, comfortably under any inversion threshold,
    // so an aggregate verdict would report a catastrophic run as healthy.
    const rate = (violations: number, couples: number): number | null =>
      couples > 0 ? violations / couples : null;
    const doubleRate = rate(coh.violations, coh.couples);
    const mixedRate = rate(coh.violations_mixed, coh.couples_mixed);
    const invertedCouples = [doubleRate, mixedRate].filter(
      (r): r is number => r !== null && r > 0.8,
    );
    const pct = (r: number | null) =>
      r === null ? "n/a" : `${(r * 100).toFixed(2)}%`;

    record({
      id: "G",
      title: "Pairwise coherence (flipping both sides inverts the answer)",
      status:
        pairCount === 0
          ? "SKIP"
          : totalCouples === 0
            ? "WARN"
            : invertedCouples.length > 0
              ? "FAIL"
              : "PASS",
      detail:
        pairCount === 0
          ? "this run's dataset lists no pairs"
          : totalCouples === 0
            ? "no complete combination couples to compare"
            : `${totalCouples}/${expectedCouples} complete couple(s); ` +
              `violation rate = ${pct(violationRate)} (this IS the pairwise noise metric) — ` +
              `(A,B) vs (¬A,¬B): ${coh.violations}/${coh.couples} = ${pct(doubleRate)}, ` +
              `(¬A,B) vs (A,¬B): ${coh.violations_mixed}/${coh.couples_mixed} = ${pct(mixedRate)}` +
              (invertedCouples.length > 0
                ? ` — ${invertedCouples.length} couple(s) near 100%, meaning the negation is being applied to the WRONG SIDE`
                : ""),
    });

    // -----------------------------------------------------------------------
    // H. Chain provenance — are these rows from the chain we think they are?
    //    Dev, testnet and mainnet runs share one database, and a transaction
    //    hash says nothing about which chain it landed on. Without this, a
    //    rehearsal and a published production run are indistinguishable at the
    //    row level, and E1-E4 would happily reconcile a run against whichever
    //    chain the environment happens to point at right now.
    // -----------------------------------------------------------------------
    const expectedChainId = skipOnchain ? null : resolveExpectedChainId();
    const chainRes = await pool.query(
      `SELECT t.chain_id, COUNT(*)::int AS n
       FROM public.transaction t
       WHERE t.id IN (
         SELECT transaction_id FROM public.forecast
           WHERE benchmark_run_id = $1 AND transaction_id IS NOT NULL
         UNION
         SELECT transaction_id FROM public.pairwise_forecast
           WHERE benchmark_run_id = $1 AND transaction_id IS NOT NULL
       )
       GROUP BY t.chain_id`,
      [runId],
    );
    const chainRows = chainRes.rows;
    const foreign = chainRows.filter(
      (r) => r.chain_id !== null && r.chain_id !== expectedChainId,
    );
    // Rows written before chain_id existed carry NULL. That is unknown
    // provenance, not proven-wrong provenance, so it warns rather than fails.
    const unknownChain = chainRows
      .filter((r) => r.chain_id === null)
      .reduce((n, r) => n + r.n, 0);
    record({
      id: "H",
      title: "Chain provenance",
      status: skipOnchain
        ? "SKIP"
        : chainRows.length === 0
          ? "WARN"
          : foreign.length > 0
            ? "FAIL"
            : unknownChain > 0
              ? "WARN"
              : "PASS",
      detail: skipOnchain
        ? "SKIP_ONCHAIN=true — nothing was expected on-chain"
        : chainRows.length === 0
          ? "this run has no on-chain transactions yet"
          : `expected chainId ${expectedChainId}; ` +
            chainRows
              .map((r) => `${r.n} tx on ${r.chain_id ?? "unrecorded"}`)
              .join(", ") +
            (foreign.length > 0
              ? " — this run's rows were published to MORE THAN ONE chain"
              : unknownChain > 0
                ? " (unrecorded = written before chain_id was tracked)"
                : ""),
      samples: foreign.map(
        (r) =>
          `${r.n} transaction(s) on chainId ${r.chain_id}, expected ${expectedChainId}`,
      ),
    });

    // -----------------------------------------------------------------------
    // I. Clamp rate — how much of this run is a parser artifact?
    //    An out-of-range percentage is clamped into (0, 1) rather than
    //    rejected, so "Probability: 150%" is stored as a maximally confident
    //    0.9999 and counts as a successful forecast. That is a deliberate,
    //    tested decision; this makes its blast radius a number instead of an
    //    assumption.
    // -----------------------------------------------------------------------
    const clampRes = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE parsed_odds = 0.0001)::int AS low,
              COUNT(*) FILTER (WHERE parsed_odds = 0.9999)::int AS high,
              COUNT(parsed_odds)::int AS parsed
       FROM public.forecast WHERE benchmark_run_id = $1`,
      [runId],
    );
    const clamp = clampRes.rows[0];
    const clamped = clamp.low + clamp.high;
    const clampRate = clamp.parsed > 0 ? clamped / clamp.parsed : 0;
    record({
      id: "I",
      title: "Parser clamp rate",
      status: clamp.parsed === 0 ? "SKIP" : clampRate > 0.05 ? "WARN" : "PASS",
      detail:
        clamp.parsed === 0
          ? "no parsed forecasts to inspect"
          : `${clamped}/${clamp.parsed} forecast(s) sit exactly on a clamp bound ` +
            `(${(clampRate * 100).toFixed(2)}%) — ${clamp.low} at 0.0001, ${clamp.high} at 0.9999` +
            (clampRate > 0.05
              ? ". A large share means models are emitting out-of-range or malformed " +
                "percentages that are being recorded as confident forecasts."
              : ""),
    });

    // -----------------------------------------------------------------------
    // J. Orphan traces — inference that was paid for and then lost.
    //    A resume that re-runs a task re-points the forecast at its new trace,
    //    legitimately orphaning the old one, so this is informational. A count
    //    far above the number of retried tasks means traces are being written
    //    without the forecast that should accompany them.
    // -----------------------------------------------------------------------
    const orphanTraceRes = await pool.query(
      `SELECT COUNT(*)::int AS n
       FROM public.llm_trace t
       WHERE t.forecaster_id IN (
               SELECT DISTINCT forecaster_id FROM public.forecast WHERE benchmark_run_id = $1)
         AND NOT EXISTS (SELECT 1 FROM public.forecast f WHERE f.llm_trace_id = t.id)
         AND NOT EXISTS (SELECT 1 FROM public.pairwise_forecast p WHERE p.llm_trace_id = t.id)`,
      [runId],
    );
    const orphanTraces = orphanTraceRes.rows[0].n;
    record({
      id: "J",
      title: "Orphan traces",
      status: orphanTraces === 0 ? "PASS" : "WARN",
      detail:
        orphanTraces === 0
          ? "every trace for this run's forecasters is attached to a forecast"
          : `${orphanTraces} trace(s) with no forecast pointing at them. Expected after a ` +
            `resume (a retried task re-points its forecast and orphans the old trace); ` +
            `a count far above the number of retried tasks means traces are being written ` +
            `without their forecast. Note this counts across ALL runs for these forecasters.`,
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

  // Resolved once and shared by every wallet's scan. An unbounded queryFilter
  // asks a public endpoint to walk all of Base from genesis, which it refuses
  // with -32062 "Block range is too large" — and the refusal surfaces as an
  // opaque error that reads like "this wallet declared nothing".
  const fromBlock = await findDeploymentBlock(
    provider,
    config.contractAddress,
    config.chainId,
  );
  const toBlock = await provider.getBlockNumber();
  console.log(
    `  scanning blocks ${fromBlock}..${toBlock} (${toBlock - fromBlock} blocks)`,
  );

  // Scanned ONCE for every wallet, then filtered in memory. A scan per wallet
  // per event type is 3 x (number of forecasters) passes over the same range —
  // for 20 forecasters that is 60 scans and >12,000 requests against endpoints
  // that rate-limit, which makes the verifier itself a source of flakiness.
  const [allForecastLogs, allPairwiseLogs, allAttrLogs] = await Promise.all([
    queryLogsChunked(contract, contract.filters.ForecastRecorded(), fromBlock, toBlock),
    queryLogsChunked(contract, contract.filters.PairwiseForecastRecorded(), fromBlock, toBlock),
    queryLogsChunked(contract, contract.filters.AttributeSet(), fromBlock, toBlock),
  ]);
  console.log(
    `  on-chain: ${allForecastLogs.length} forecast, ${allPairwiseLogs.length} pairwise, ` +
      `${allAttrLogs.length} attribute event(s)\n`,
  );

  const bySubmitter = (
    logs: (ethers.Log | ethers.EventLog)[],
    field: "submitter" | "who",
    address: string,
  ): ethers.EventLog[] => {
    const target = address.toLowerCase();
    return logs.filter((log) => {
      const args = (log as ethers.EventLog).args;
      return args && String(args[field]).toLowerCase() === target;
    }) as ethers.EventLog[];
  };

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
  const pairwiseMissing: string[] = [];
  let onChainTotal = 0;
  let comparedTotal = 0;
  let pairwiseOnChainTotal = 0;
  let pairwiseComparedTotal = 0;

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

    const logs = bySubmitter(allForecastLogs, "submitter", wallet.address);
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

    // The same comparison for pairwise judgments. Iterations are again
    // indistinguishable on-chain, so the key is the whole judgment —
    // both sides, both outcomes, and which one won.
    const pwDbRes = await pool.query(
      `SELECT ma.external_id AS market_a, p.outcome_a,
              mb.external_id AS market_b, p.outcome_b,
              p.is_a_likelier
       FROM public.pairwise_forecast p
       JOIN public.market ma     ON ma.id = p.market_a_id
       JOIN public.market mb     ON mb.id = p.market_b_id
       JOIN public.forecaster fc ON fc.id = p.forecaster_id
       JOIN public.wallet w      ON w.id = fc.wallet_id
       WHERE p.benchmark_run_id = $1
         AND w.address = $2
         AND p.is_a_likelier IS NOT NULL
         AND p.transaction_id IS NOT NULL`,
      [runId, wallet.address],
    );

    const pwDbCounts = new Map<string, number>();
    for (const row of pwDbRes.rows) {
      const key = `${row.market_a}|${row.outcome_a}|${row.market_b}|${row.outcome_b}|${row.is_a_likelier}`;
      pwDbCounts.set(key, (pwDbCounts.get(key) ?? 0) + 1);
    }
    pairwiseComparedTotal += pwDbRes.rows.length;

    const pwLogs = bySubmitter(allPairwiseLogs, "submitter", wallet.address);
    pairwiseOnChainTotal += pwLogs.length;

    const pwChainCounts = new Map<string, number>();
    for (const log of pwLogs) {
      const a = (log as ethers.EventLog).args;
      const key = `${a.marketAId}|${a.marketAOutcome}|${a.marketBId}|${a.marketBOutcome}|${a.isALikelier}`;
      pwChainCounts.set(key, (pwChainCounts.get(key) ?? 0) + 1);
    }

    for (const [key, count] of pwDbCounts) {
      const onChain = pwChainCounts.get(key) ?? 0;
      if (onChain < count) {
        const [marketA, outcomeA, marketB, outcomeB, likelier] = key.split("|");
        pairwiseMissing.push(
          `${wallet.name}: ${marketA}/${outcomeA} vs ${marketB}/${outcomeB} ` +
            `(A likelier: ${likelier}) — DB has ${count}, chain has ${onChain}`,
        );
      }
    }

    // The wallet must have declared its model on-chain, or the published log is
    // anonymous — nobody can tell which model produced these forecasts.
    const attrLogs = bySubmitter(allAttrLogs, "who", wallet.address);
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
    id: "E4",
    title: "Chain <-> DB: every published pairwise judgment is on-chain",
    status: pairwiseMissing.length === 0 ? "PASS" : "FAIL",
    detail: `compared ${pairwiseComparedTotal} DB row(s) against ${pairwiseOnChainTotal} on-chain PairwiseForecastRecorded event(s); ${pairwiseMissing.length} missing`,
    samples: pairwiseMissing,
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
