// Bring up the local docker postgres (unless one is already reachable), wait for
// it to accept connections, and apply the schema in migrations/. Idempotent-ish:
// re-running against an already-migrated database will error on the CREATE TABLE
// statements, so pass --reset to drop and recreate the public schema first.
//
//   npm run db:setup            # start docker + apply migration
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

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      console.log(`Applying migration ${file}...`);
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      await client.query(sql);
    }
    console.log("✅ Migrations applied.");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("\nDatabase setup failed:", error);
  process.exit(1);
});
