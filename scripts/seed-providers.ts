// Load the OpenRouter provider catalog into `llm_provider`.
//
//   npx tsx scripts/seed-providers.ts [--file providers.json]
//
// `providers.json` is the response of OpenRouter's provider listing endpoint
// (https://openrouter.ai/api/v1/providers), either the raw `{ "data": [...] }`
// envelope or a bare array. Each entry contributes its {slug, name} pair, which
// is what lets a pinned provider slug be compared against the display name a
// completion reports.
//
// Idempotent — re-run it whenever OpenRouter adds providers. `npm run db:setup`
// runs it automatically when the file is present.

import * as dotenv from "dotenv";
import { Database } from "../src/db";
import { parseProviderFile } from "../src/providers";
import { loadJsonFile, parseArgs } from "../src/utils";

dotenv.config();

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const file = (args.file as string) || "providers.json";

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const providers = parseProviderFile(loadJsonFile(file));
  const db = new Database(databaseUrl);
  try {
    const count = await db.upsertProviders(providers);
    console.log(`✅ Seeded ${count} provider(s) from ${file}.`);

    const sample = (await db.getProviders()).slice(0, 3);
    for (const p of sample) console.log(`   ${p.slug.padEnd(24)} ${p.name}`);
    console.log(`   …`);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error("seed-providers failed:", error);
  process.exit(1);
});
