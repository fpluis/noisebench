// Bring up the local docker postgres (unless one is already reachable), wait for
// it to accept connections, apply any unapplied migrations, and seed the
// OpenRouter provider catalog.
//
// Applied migrations are recorded in `schema_migration`, so re-running is safe
// and a new migration reaches an existing database without wiping it. A
// database created before that table existed is detected and backfilled.
//
//   npm run db:setup            # start docker + apply pending migrations + seed
//   npm run db:setup -- --reset # also wipe the schema first (destructive)
//   npm run db:setup -- --no-docker  # assume postgres is already running

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { Client } from "pg";
import * as dotenv from "dotenv";
import { parseArgs, sleep } from "../src/utils";

dotenv.config();

const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");

const connectionString =
  process.env.DATABASE_URL ||
  "postgres://noisebench:noisebench@localhost:5433/noisebench";

async function canConnect(): Promise<boolean> {
  const client = new Client({ connectionString });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

async function waitForDb(timeoutMs = 60000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await canConnect()) return;
    process.stdout.write(".");
    await sleep(2000);
  }
  throw new Error(
    `Database not reachable at ${connectionString} within timeout`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args["no-docker"]) {
    try {
      console.log("Starting docker compose postgres service...");
      execSync("docker compose up -d", { stdio: "inherit" });
    } catch (error) {
      console.warn(
        "Could not run `docker compose up -d` (is Docker installed/running?). " +
          "Continuing in case a database is already available.\n",
        error instanceof Error ? error.message : error,
      );
    }
  }

  process.stdout.write("Waiting for database");
  await waitForDb();
  console.log("\nDatabase is reachable.");

  const client = new Client({ connectionString });
  await client.connect();
  try {
    if (args.reset) {
      console.log("Resetting public schema (destructive)...");
      await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    }

    // Track which migrations have run, so a new one can be applied to an
    // existing database instead of forcing a destructive --reset.
    await client.query(
      `CREATE TABLE IF NOT EXISTS public.schema_migration (
         filename   TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
    );

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    // Databases created before migration tracking existed have the initial
    // schema but no record of it. Detect that and backfill, so the first
    // tracked run does not try to re-create tables that are already there.
    const applied = new Set<string>(
      (
        await client.query(`SELECT filename FROM public.schema_migration`)
      ).rows.map((r) => r.filename),
    );
    if (applied.size === 0) {
      const bootstrapped = await client.query(
        `SELECT to_regclass('public.forecast') AS t`,
      );
      if (bootstrapped.rows[0].t !== null && files.length > 0) {
        console.log(
          `Existing schema detected — recording ${files[0]} as already applied.`,
        );
        await client.query(
          `INSERT INTO public.schema_migration (filename) VALUES ($1)
           ON CONFLICT DO NOTHING`,
          [files[0]],
        );
        applied.add(files[0]);
      }
    }

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`Skipping migration ${file} (already applied).`);
        continue;
      }
      console.log(`Applying migration ${file}...`);
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      await client.query(sql);
      await client.query(
        `INSERT INTO public.schema_migration (filename) VALUES ($1)
         ON CONFLICT DO NOTHING`,
        [file],
      );
    }
    console.log("✅ Migrations applied.");
  } finally {
    await client.end();
  }

  // Seed the OpenRouter provider catalog when it is available. Without it, a
  // pinned provider slug cannot be reconciled against the display name a
  // completion reports.
  const providersFile = path.join(process.cwd(), "providers.json");
  if (fs.existsSync(providersFile)) {
    console.log("Seeding provider catalog from providers.json...");
    const { Database } = await import("../src/db");
    const { parseProviderFile } = await import("../src/providers");
    const { loadJsonFile } = await import("../src/utils");
    const db = new Database(connectionString);
    try {
      const count = await db.upsertProviders(
        parseProviderFile(loadJsonFile("providers.json")),
      );
      console.log(`✅ Seeded ${count} provider(s).`);
    } finally {
      await db.close();
    }
  } else {
    console.log(
      "ℹ️  providers.json not found — skipping provider catalog seed. " +
        "Provider pin verification will report 'unverifiable' until it is seeded.",
    );
  }
}

main().catch((error) => {
  console.error("\nDatabase setup failed:", error);
  process.exit(1);
});
