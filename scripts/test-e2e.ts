// Self-contained end-to-end suite.
//
//   npm run test:e2e
//   npm run test:e2e -- --markets 20        # quicker smoke
//   npm run test:e2e -- --keep              # leave the DB up to inspect it
//
// Brings up a throwaway PostgreSQL, applies the migrations, seeds the provider
// catalog, runs the unit tests, then drives the REAL benchmark end-to-end over
// the synthetic dataset with fake inference — and reconciles the result. The
// database is destroyed at the end, so nothing here can pollute the database
// you keep real runs in.
//
// What this proves: migrations apply from nothing, the dataset ingests, and
// 16,000 forecasts survive the whole orchestration — the DB mappings, the
// concurrency, the progress bookkeeping and the resume path — at production
// volume, for free. It also rehearses the slice-then-widen workflow a real run
// uses, and asserts that widening a sliced run REUSES its rows rather than
// redoing them, since on a real run that difference is money.
//
// What this does NOT prove: anything on-chain. Submission is skipped entirely,
// and is validated by a small real run instead.

import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { Client } from "pg";
import { parseArgs, sleep } from "../src/utils";

const COMPOSE_FILE = "docker-compose.test.yml";
const PORT = process.env.TEST_PG_PORT || "5434";
const TEST_DATABASE_URL = `postgres://noisebench:noisebench@localhost:${PORT}/noisebench_test`;

// Child processes inherit this: DATABASE_URL points at the throwaway database,
// and dotenv does not override variables that are already set, so a developer's
// own .env cannot redirect the suite at their real database or turn inference
// back on.
const CHILD_ENV = {
  ...process.env,
  DATABASE_URL: TEST_DATABASE_URL,
  NOISEBENCH_FAKE_INFERENCE: "true",
  SKIP_ONCHAIN: "true",
  NOISEBENCH_FAKE_LATENCY_MS: process.env.NOISEBENCH_FAKE_LATENCY_MS || "0",
  PG_POOL_MAX: process.env.PG_POOL_MAX || "24",
};

let stepIndex = 0;
const started = Date.now();

const step = (title: string): void => {
  stepIndex++;
  console.log(`\n${"─".repeat(72)}`);
  console.log(`▶  ${stepIndex}. ${title}`);
  console.log("─".repeat(72));
};

const elapsed = (): string => `${((Date.now() - started) / 1000).toFixed(1)}s`;

/** Run a command, inheriting stdio. Throws with a readable message on failure. */
function run(command: string, args: string[], label: string): void {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: CHILD_ENV,
    // `docker` and `node` are real executables, so no shell is needed — which
    // also keeps this working identically on PowerShell, cmd and bash.
    shell: false,
  });
  if (result.error)
    throw new Error(`${label} could not start: ${result.error}`);
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status})`);
  }
}

/** Run one of this repo's TypeScript entry points in a child process. */
function runScript(script: string, args: string[], label: string): void {
  run(process.execPath, ["--import", "tsx", script, ...args], label);
}

function compose(args: string[], label: string): void {
  // An explicit project name keeps this stack in its own namespace. Without it
  // Compose derives the project from the directory, so the suite would share a
  // network with the development stack and teardown would try to remove a
  // network the dev database is still using.
  run(
    "docker",
    ["compose", "-p", "noisebench-test", "-f", COMPOSE_FILE, ...args],
    label,
  );
}

async function waitForDatabase(timeoutMs = 90000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  process.stdout.write("Waiting for the test database");
  while (Date.now() < deadline) {
    const client = new Client({ connectionString: TEST_DATABASE_URL });
    try {
      await client.connect();
      await client.query("SELECT 1");
      console.log(" ready.");
      return;
    } catch {
      process.stdout.write(".");
      await sleep(1500);
    } finally {
      await client.end().catch(() => {});
    }
  }
  throw new Error(`Test database not reachable on port ${PORT} within timeout`);
}

/** Whether a dataset file exists and lists at least one pair. */
function hasPairs(datasetPath: string): boolean {
  const resolved = path.resolve(process.cwd(), datasetPath);
  if (!fs.existsSync(resolved)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
    return Array.isArray(parsed?.pairs) && parsed.pairs.length > 0;
  } catch {
    return false;
  }
}

/** The id of the most recent benchmark run, so verification can target it. */
async function latestRunId(): Promise<number> {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  try {
    await client.connect();
    const res = await client.query(
      `SELECT id FROM public.benchmark_run ORDER BY id DESC LIMIT 1`,
    );
    if (res.rows.length === 0) throw new Error("No benchmark run was created");
    return res.rows[0].id;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * A fingerprint of every forecast row belonging to a run, keyed by the task it
 * answers, used to prove a widening resume REUSES the slice's rows rather than
 * redoing them. The id and creation timestamp are what a rewrite would change;
 * the parsed value and trace are what a re-inference would change.
 *
 * `parsed` matters because the two kinds of row have DIFFERENT guarantees. A
 * row that produced a usable probability is complete and must survive widening
 * untouched — redoing it is money spent twice. A row whose model refused or
 * returned something unparseable is deliberately NOT counted as complete
 * (`getCompletedTaskKeys` filters on `parsed_odds IS NOT NULL`), so widening
 * retrying it, writing a fresh trace and re-pointing the row at it, is the
 * feature working.
 */
interface ForecastFingerprint {
  parsed: boolean;
  digest: string;
}

async function forecastFingerprints(
  runId: number,
): Promise<Map<string, ForecastFingerprint>> {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  try {
    await client.connect();
    const res = await client.query(
      `SELECT forecaster_id, market_id, is_negated, prompt_iteration,
              id, created_at, parsed_odds, outcome, llm_trace_id
       FROM public.forecast WHERE benchmark_run_id = $1`,
      [runId],
    );
    const out = new Map<string, ForecastFingerprint>();
    for (const r of res.rows) {
      out.set(
        `${r.forecaster_id}:${r.market_id}:${r.is_negated ? 1 : 0}:${r.prompt_iteration}`,
        {
          parsed: r.parsed_odds !== null,
          digest:
            `${r.id}|${new Date(r.created_at).toISOString()}|${r.parsed_odds}` +
            `|${r.outcome}|${r.llm_trace_id}`,
        },
      );
    }
    return out;
  } finally {
    await client.end().catch(() => {});
  }
}

/** The scope and iteration dials the run row currently records. */
async function runPlan(runId: number): Promise<{
  promptIterations: number;
  pairwiseIterations: number;
  markets: number;
  pairs: number;
}> {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  try {
    await client.connect();
    const res = await client.query(
      `SELECT r.prompt_iterations, r.pairwise_iterations,
              (SELECT COUNT(*)::int FROM public.benchmark_run_market m
                 WHERE m.benchmark_run_id = r.id) AS markets,
              (SELECT COUNT(*)::int FROM public.benchmark_run_pair p
                 WHERE p.benchmark_run_id = r.id) AS pairs
       FROM public.benchmark_run r WHERE r.id = $1`,
      [runId],
    );
    const r = res.rows[0];
    return {
      promptIterations: r.prompt_iterations,
      pairwiseIterations: r.pairwise_iterations,
      markets: r.markets,
      pairs: r.pairs,
    };
  } finally {
    await client.end().catch(() => {});
  }
}

/** A short summary of what actually landed, so the run is legible at a glance. */
async function summarize(runId: number): Promise<void> {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  try {
    await client.connect();
    const rows = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM public.forecast   WHERE benchmark_run_id = $1) AS forecasts,
         (SELECT COUNT(*) FROM public.pairwise_forecast WHERE benchmark_run_id = $1) AS pairwise,
         (SELECT COUNT(*) FROM public.llm_trace) AS traces,
         (SELECT COUNT(*) FROM public.forecaster) AS forecasters,
         (SELECT COUNT(*) FROM public.event)     AS events,
         (SELECT COUNT(*) FROM public.market)    AS markets,
         (SELECT COUNT(*) FROM public.llm_provider WHERE slug IS NOT NULL) AS providers,
         (SELECT pg_size_pretty(pg_database_size(current_database()))) AS size`,
      [runId],
    );
    const r = rows.rows[0];
    console.log(
      `\n  ${r.forecasts} forecasts · ${r.pairwise} pairwise · ${r.traces} traces · ` +
        `${r.forecasters} forecasters · ${r.events} events · ${r.markets} markets · ` +
        `${r.providers} providers · ${r.size} on disk`,
    );
  } finally {
    await client.end().catch(() => {});
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const keep = Boolean(args.keep);
  const markets = parseInt((args.markets as string) || "100", 10);
  const configPath = (args.config as string) || "configs/benchmark.local.json";
  const datasetPath = `datasets/synthetic-${markets}.json`;

  console.log("noisebench end-to-end suite");
  console.log(`  database : ${TEST_DATABASE_URL} (throwaway)`);
  console.log(`  dataset  : ${datasetPath}`);
  console.log(`  config   : ${configPath}`);

  let torndown = false;
  const teardown = (): void => {
    if (torndown) return;
    torndown = true;
    if (keep) {
      console.log(
        `\n--keep: leaving the database up on port ${PORT}.\n` +
          `  inspect : docker exec -it noisebench-postgres-test psql -U noisebench -d noisebench_test\n` +
          `  stop    : docker compose -p noisebench-test -f ${COMPOSE_FILE} down -v`,
      );
      return;
    }
    console.log("\nTearing down the test database…");
    try {
      compose(["down", "-v"], "docker compose down");
    } catch (error) {
      console.warn(`  (teardown failed: ${error})`);
    }
  };

  // Tear down even on Ctrl-C, so an interrupted run does not leave a container
  // holding the port.
  process.on("SIGINT", () => {
    teardown();
    process.exit(130);
  });

  try {
    step("Start a throwaway PostgreSQL");
    // `down -v` first so a container left over from an interrupted run cannot
    // silently supply stale state to this one.
    try {
      compose(["down", "-v"], "docker compose down");
    } catch {
      // Nothing was running; that is the normal case.
    }
    compose(["up", "-d"], "docker compose up");
    await waitForDatabase();

    step("Apply migrations and seed the provider catalog");
    // The real setup path, not a test-only reimplementation of it — so this
    // also proves the migrations apply cleanly to an empty database.
    runScript("scripts/setup-db.ts", ["--no-docker"], "setup-db");

    step("Unit tests");
    run(
      process.execPath,
      ["--import", "tsx", "--test", "tests/**/*.test.ts"],
      "unit tests",
    );

    step(`Generate the synthetic dataset (${markets} markets)`);
    // Reuse an existing file only if it carries pairs. A dataset left over from
    // before the pairwise modality no longer loads at all, and one carrying an
    // empty `pairs` would run a suite that never exercises the pairwise path;
    // regenerating is cheap, so neither is worth reusing.
    if (hasPairs(datasetPath)) {
      console.log(`${datasetPath} already exists — reusing it.`);
    } else {
      runScript(
        "scripts/gen-synthetic-dataset.ts",
        ["--markets", String(markets), "--markets-per-event", "4"],
        "gen-synthetic-dataset",
      );
    }

    // -----------------------------------------------------------------------
    // The slice-then-widen rehearsal.
    //
    // This is the workflow a production run actually uses: start on two markets
    // and one pair to prove the pipeline works, then widen THE SAME RUN to the
    // full dataset, keeping everything the slice produced. What makes it safe
    // is that the slice comes from the same dataset file, so market ids are
    // identical and the completed-task sets skip exactly the work already paid
    // for. This asserts that property directly rather than trusting it.
    // -----------------------------------------------------------------------
    step("Slice run — 2 markets, 1 pair, 1 iteration of each modality");
    runScript(
      "scripts/benchmark.ts",
      [
        "--config",
        configPath,
        "--dataset",
        datasetPath,
        "--max-markets",
        "2",
        "--max-pairs",
        "1",
        "--prompt-iterations",
        "1",
        "--pairwise-iterations",
        "1",
        "--model-concurrency",
        "4",
      ],
      "benchmark --max-markets 2",
    );
    const sliceRunId = await latestRunId();
    runScript(
      "scripts/verify-run.ts",
      ["--run", String(sliceRunId)],
      "verify-run (slice)",
    );

    const slicePlan = await runPlan(sliceRunId);
    if (slicePlan.markets !== 2 || slicePlan.pairs !== 1) {
      throw new Error(
        `slice recorded ${slicePlan.markets} market(s) and ${slicePlan.pairs} pair(s), expected 2 and 1`,
      );
    }
    const sliceRows = await forecastFingerprints(sliceRunId);
    console.log(
      `\n  slice produced ${sliceRows.size} forecast row(s) across 2 market(s)`,
    );

    step(`Widen run ${sliceRunId} to the full dataset`);
    runScript(
      "scripts/benchmark.ts",
      [
        "--config",
        configPath,
        "--dataset",
        datasetPath,
        "--resume",
        String(sliceRunId),
      ],
      "benchmark --resume (widen)",
    );

    step(`Verify the widened run ${sliceRunId}`);
    // Check A derives what to expect from the run row and its scope tables, so
    // this passing IS the proof that widening updated the recorded plan. Before
    // that fix it reported a healthy widened run as catastrophically incomplete.
    runScript(
      "scripts/verify-run.ts",
      ["--run", String(sliceRunId)],
      "verify-run (widened)",
    );

    const widenedPlan = await runPlan(sliceRunId);
    if (widenedPlan.markets <= slicePlan.markets) {
      throw new Error(
        `widening did not extend the run's market scope (still ${widenedPlan.markets})`,
      );
    }
    if (widenedPlan.promptIterations <= slicePlan.promptIterations) {
      throw new Error(
        `widening did not raise prompt_iterations (still ${widenedPlan.promptIterations})`,
      );
    }
    console.log(
      `\n  plan widened: ${slicePlan.markets}→${widenedPlan.markets} markets, ` +
        `${slicePlan.pairs}→${widenedPlan.pairs} pairs, ` +
        `iterations ${slicePlan.promptIterations}→${widenedPlan.promptIterations} / ` +
        `${slicePlan.pairwiseIterations}→${widenedPlan.pairwiseIterations}`,
    );

    // The load-bearing assertion: every USABLE row the slice produced is still
    // there, byte for byte. A changed id, timestamp or probability means the
    // widened run redid work that had already been paid for — which on a real
    // run is money. Unparsed rows are exempt: they are not "complete", so
    // retrying them is the resume contract doing its job.
    const afterWidening = await forecastFingerprints(sliceRunId);
    let preserved = 0;
    let retried = 0;
    for (const [task, before] of sliceRows) {
      const after = afterWidening.get(task);
      if (after === undefined) {
        throw new Error(`widening LOST the slice's row for task ${task}`);
      }
      if (!before.parsed) {
        retried++;
        continue;
      }
      if (after.digest !== before.digest) {
        throw new Error(
          `widening REWROTE a completed slice row for task ${task}:\n` +
            `  before: ${before.digest}\n  after:  ${after.digest}`,
        );
      }
      preserved++;
    }
    if (preserved === 0) {
      throw new Error(
        "the slice produced no usable rows, so preservation was never tested",
      );
    }
    console.log(
      `  ✅ all ${preserved} completed slice row(s) preserved unchanged; ` +
        `${retried} unparsed row(s) correctly re-attempted`,
    );
    await summarize(sliceRunId);

    step("Benchmark run (fake inference, no chain)");
    runScript(
      "scripts/benchmark.ts",
      ["--config", configPath, "--dataset", datasetPath],
      "benchmark",
    );
    const runId = await latestRunId();
    await summarize(runId);

    step(`Verify run ${runId}`);
    runScript("scripts/verify-run.ts", ["--run", String(runId)], "verify-run");

    step(`Resume run ${runId} (retries only what failed to parse)`);
    // The most likely production incident is an interrupted run, so the resume
    // path is exercised rather than assumed. The fake is deterministic, so the
    // same tasks fail again and the row count must not move.
    runScript(
      "scripts/benchmark.ts",
      [
        "--config",
        configPath,
        "--dataset",
        datasetPath,
        "--resume",
        String(runId),
      ],
      "benchmark --resume",
    );

    step(`Re-verify run ${runId} after resume`);
    runScript("scripts/verify-run.ts", ["--run", String(runId)], "verify-run");
    await summarize(runId);

    console.log(`\n${"═".repeat(72)}`);
    console.log(`✅ End-to-end suite passed in ${elapsed()}.`);
    console.log(
      "   On-chain submission was skipped — validate that with a small real run.",
    );
    console.log("═".repeat(72));
  } finally {
    teardown();
  }
}

main().catch((error) => {
  console.error(
    `\n❌ End-to-end suite FAILED after ${elapsed()}:\n   ${error.message}`,
  );
  process.exit(1);
});
