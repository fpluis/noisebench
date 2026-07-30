// Delete the results produced by the OLD negated-question prompt, so they can
// be re-run against the corrected one.
//
//   npx tsx scripts/delete-negated-results.ts --run 1           # dry run
//   npx tsx scripts/delete-negated-results.ts --run 1 --apply
//
// WHAT WAS WRONG WITH THEM
//
// The "No" side used to be asked by substituting a hand-written
// `negatedQuestion` for the market's question. Only the question was ever
// negated: the rules, the dates and the research blob beside it still described
// the "Yes" outcome, so the prompt contradicted itself — "Will the U.S. NOT
// invade Cuba in 2026?" above rules reading "resolves to Yes if the United
// States commences a military offensive". Every such answer is a measurement of
// how a model handles an inconsistency we authored, not of the noise this
// benchmark exists to measure. See the header of src/llm.ts.
//
// WHAT THIS DELETES
//
//   * direct forecasts with is_negated = true;
//   * pairwise forecasts with is_a_negated OR is_b_negated — three of the four
//     combinations, since the same substitution was made per side;
//   * the llm_trace row behind each of them.
//
// The base/00 rows are untouched: they were asked with the market's own
// question and rules, which is exactly what the corrected prompt does, so they
// remain valid measurements.
//
// WHAT THIS DELIBERATELY DOES NOT TOUCH
//
//   * `public.transaction`. A batch carries whatever finished around the same
//     time, so the same tx row is pointed at by both negated and base
//     forecasts. Deleting it would orphan rows that are still correct.
//   * The chain. The registry is emit-only, so the wrong forecasts published to
//     Base mainnet are there permanently and no database operation can retract
//     them. The re-run APPENDS corrected records alongside them.
//
// Deleting rather than letting the re-run overwrite them is deliberate. The
// forecast upsert's ON CONFLICT clause preserves `transaction_id` and
// `published_at`, so an overwritten row would carry NEW odds while still
// pointing at the transaction that published the OLD ones — silently false
// provenance, which is worse than the gap.

import { Client } from "pg";
import * as dotenv from "dotenv";
import { parseArgs } from "../src/utils";

dotenv.config();

const connectionString =
  process.env.DATABASE_URL ||
  "postgres://noisebench:noisebench@localhost:5433/noisebench";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = Number(args.run);
  if (!Number.isInteger(runId)) {
    throw new Error("Usage: delete-negated-results.ts --run <id> [--apply]");
  }
  const apply = Boolean(args.apply);

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");

    // Counted inside the transaction so the numbers reported are the numbers
    // acted on, even if something else is writing concurrently.
    const before = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM public.forecast
           WHERE benchmark_run_id = $1 AND is_negated)::int AS direct,
         (SELECT COUNT(*) FROM public.forecast
           WHERE benchmark_run_id = $1 AND is_negated
             AND transaction_id IS NOT NULL)::int AS direct_published,
         (SELECT COUNT(*) FROM public.pairwise_forecast
           WHERE benchmark_run_id = $1
             AND (is_a_negated OR is_b_negated))::int AS pairwise,
         (SELECT COUNT(*) FROM public.pairwise_forecast
           WHERE benchmark_run_id = $1 AND (is_a_negated OR is_b_negated)
             AND transaction_id IS NOT NULL)::int AS pairwise_published,
         (SELECT COUNT(*) FROM public.forecast
           WHERE benchmark_run_id = $1 AND NOT is_negated)::int AS direct_kept,
         (SELECT COUNT(*) FROM public.pairwise_forecast
           WHERE benchmark_run_id = $1
             AND NOT is_a_negated AND NOT is_b_negated)::int AS pairwise_kept`,
      [runId],
    );
    const n = before.rows[0];

    console.log(`Benchmark run ${runId}`);
    console.log(
      `  direct   to delete: ${n.direct} (${n.direct_published} already on-chain), keeping ${n.direct_kept}`,
    );
    console.log(
      `  pairwise to delete: ${n.pairwise} (${n.pairwise_published} already on-chain), keeping ${n.pairwise_kept}`,
    );

    // Traces are collected BEFORE the forecasts that point at them are removed;
    // afterwards nothing links the two and the traces would be unfindable
    // orphans rather than deletable rows.
    const traceRes = await client.query(
      `SELECT llm_trace_id AS id FROM public.forecast
        WHERE benchmark_run_id = $1 AND is_negated
          AND llm_trace_id IS NOT NULL
       UNION
       SELECT llm_trace_id FROM public.pairwise_forecast
        WHERE benchmark_run_id = $1 AND (is_a_negated OR is_b_negated)
          AND llm_trace_id IS NOT NULL`,
      [runId],
    );
    const traceIds: number[] = traceRes.rows.map((r) => r.id);
    console.log(`  llm_trace to delete: ${traceIds.length}`);

    if (!apply) {
      await client.query("ROLLBACK");
      console.log("\nDry run — nothing was deleted. Re-run with --apply.");
      return;
    }

    const direct = await client.query(
      `DELETE FROM public.forecast
        WHERE benchmark_run_id = $1 AND is_negated`,
      [runId],
    );
    const pairwise = await client.query(
      `DELETE FROM public.pairwise_forecast
        WHERE benchmark_run_id = $1 AND (is_a_negated OR is_b_negated)`,
      [runId],
    );
    // Guarded on NOT EXISTS so a trace somehow shared with a surviving forecast
    // is left alone rather than taking that forecast's evidence with it.
    const traces = await client.query(
      `DELETE FROM public.llm_trace t
        WHERE t.id = ANY($1::int[])
          AND NOT EXISTS (SELECT 1 FROM public.forecast f WHERE f.llm_trace_id = t.id)
          AND NOT EXISTS (SELECT 1 FROM public.pairwise_forecast p WHERE p.llm_trace_id = t.id)`,
      [traceIds],
    );

    // Progress counters are cumulative and the re-run bumps them again, so a
    // stale count would make a complete forecaster look over-complete. Reset to
    // what actually survives; the benchmark re-declares `total_tasks` itself.
    const state = await client.query(
      `UPDATE public.benchmark_predictor_state s
          SET completed_tasks = COALESCE(counts.n, 0),
              error_count = 0,
              updated_at = now()
         FROM (SELECT forecaster_id, COUNT(*)::int AS n
                 FROM (SELECT forecaster_id FROM public.forecast
                        WHERE benchmark_run_id = $1
                       UNION ALL
                       SELECT forecaster_id FROM public.pairwise_forecast
                        WHERE benchmark_run_id = $1) rows
                GROUP BY forecaster_id) counts
        WHERE s.benchmark_run_id = $1
          AND s.forecaster_id = counts.forecaster_id`,
      [runId],
    );

    await client.query("COMMIT");
    console.log(
      `\nDeleted ${direct.rowCount} direct forecast(s), ${pairwise.rowCount} pairwise ` +
        `forecast(s), ${traces.rowCount} trace(s); reset ${state.rowCount} predictor state row(s).`,
    );
    console.log(
      `\nNext: npm run benchmark -- --config configs/benchmark.production.json --resume ${runId}`,
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("delete-negated-results failed:", error);
  process.exit(1);
});
