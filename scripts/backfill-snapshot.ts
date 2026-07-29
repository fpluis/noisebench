// Populate `benchmark_run_market_snapshot` from the dataset a run was built on.
//
//   npx tsx scripts/backfill-snapshot.ts --run 1
//   npx tsx scripts/backfill-snapshot.ts --run 1 --dataset datasets/other.json
//   npx tsx scripts/backfill-snapshot.ts --run 1 --dry-run
//
// Runs finished before migration 05 existed have their orderbook state only in
// the dataset JSON. This reads it back and writes it against the run, matching
// on market slug.
//
// The dataset path defaults to `benchmark_run.dataset_name`, which is the file
// the run actually used — passing --dataset overrides it and is only correct
// when that file has been moved or renamed. Markets are matched by slug within
// the run's own market set, so a dataset that has since been re-cut cannot
// inject prices for markets the run never saw.

import { Client } from "pg";
import * as dotenv from "dotenv";
import { loadDataset, parseArgs } from "../src/utils";
import { DatasetMarket } from "../src/types";

dotenv.config();

const connectionString =
  process.env.DATABASE_URL ||
  "postgres://noisebench:noisebench@localhost:5433/noisebench";

// A market with no book behind it contributes nothing; writing a row of all
// nulls would be indistinguishable from a real snapshot of an illiquid market.
const hasSnapshot = (m: DatasetMarket): boolean =>
  m.midpoint !== undefined ||
  m.spread !== undefined ||
  m.yesLiquidity !== undefined ||
  m.noLiquidity !== undefined;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = Number(args.run);
  if (!Number.isInteger(runId) || runId <= 0) {
    throw new Error(
      "Usage: backfill-snapshot.ts --run <id> [--dataset <path>] [--dry-run]",
    );
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const run = await client.query(
      `SELECT id, name, dataset_name FROM public.benchmark_run WHERE id = $1`,
      [runId],
    );
    if (run.rowCount === 0)
      throw new Error(`No benchmark run with id ${runId}`);

    const datasetPath = (args.dataset as string) || run.rows[0].dataset_name;
    console.log(`Run ${runId} (${run.rows[0].name})`);
    console.log(`Dataset: ${datasetPath}`);

    const dataset = loadDataset(datasetPath);
    const bySlug = new Map<string, DatasetMarket>();
    for (const event of dataset.events) {
      for (const market of event.markets) bySlug.set(market.slug, market);
    }

    // Only markets the run actually benchmarked, so a re-cut dataset cannot
    // widen the run's market set through the back door.
    const inRun = await client.query(
      `SELECT m.id, m.slug
         FROM public.benchmark_run_market brm
         JOIN public.market m ON m.id = brm.market_id
        WHERE brm.benchmark_run_id = $1`,
      [runId],
    );

    let written = 0;
    let missing = 0;
    let noBook = 0;

    for (const row of inRun.rows) {
      const market = bySlug.get(row.slug);
      if (!market) {
        missing += 1;
        console.warn(`  ! ${row.slug} is in the run but not in the dataset`);
        continue;
      }
      if (!hasSnapshot(market)) {
        noBook += 1;
        continue;
      }
      if (!args["dry-run"]) {
        await client.query(
          `INSERT INTO public.benchmark_run_market_snapshot
             (benchmark_run_id, market_id, midpoint, spread,
              yes_liquidity, no_liquidity, snapshot_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (benchmark_run_id, market_id) DO UPDATE SET
             midpoint = EXCLUDED.midpoint,
             spread = EXCLUDED.spread,
             yes_liquidity = EXCLUDED.yes_liquidity,
             no_liquidity = EXCLUDED.no_liquidity,
             snapshot_at = EXCLUDED.snapshot_at,
             updated_at = NOW()`,
          [
            runId,
            row.id,
            market.midpoint ?? null,
            market.spread ?? null,
            market.yesLiquidity ?? null,
            market.noLiquidity ?? null,
            market.orderbookSnapshotAt ?? null,
          ],
        );
      }
      written += 1;
    }

    const verb = args["dry-run"] ? "would write" : "wrote";
    console.log(`\n✅ ${verb} ${written} snapshot row(s) for run ${runId}.`);
    if (noBook > 0) console.log(`   ${noBook} market(s) carry no orderbook.`);
    if (missing > 0) {
      console.log(`   ${missing} run market(s) absent from the dataset.`);
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("\nSnapshot backfill failed:", error);
  process.exit(1);
});
