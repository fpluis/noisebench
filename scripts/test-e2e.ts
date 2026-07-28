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
// volume, for free.
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
