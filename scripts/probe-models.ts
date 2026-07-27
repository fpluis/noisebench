// Pre-flight every model in a config with two real calls, before committing to
// a full production cycle.
//
//   npx tsx scripts/probe-models.ts --config configs/benchmark.production.json \
//       --dataset datasets/26-07-2026.json [--markets 100] [--iterations 4]
//
// Costs roughly $1 for 20 models and catches the failure modes that are
// invisible until they have already been paid for 800 times per model:
//
//   * the provider pin is not honored (allow_fallbacks:false is not doing its
//     job, so a model silently routes to a different backend mid-run);
//   * finish_reason === "length" — reasoning consumed the max_tokens budget
//     before the answer, so every call costs full price, returns nothing
//     usable, and burns the whole retry budget;
//   * the model never emits `Probability: X%` in the required format;
//   * no cost is reported, so that model's spend is unaccounted for.
//
// Raw responses are written to tests/fixtures/responses/ to seed the parser's
// golden corpus with text real models actually produce.

import fs from "fs";
import path from "path";
import * as dotenv from "dotenv";
import { Database } from "../src/db";
import { generateForecast } from "../src/llm";
import { ProviderRef, checkProviderPin } from "../src/providers";
import { DatasetEvent, DatasetMarket, NormalizedModel } from "../src/types";
import {
  loadBenchmarkConfig,
  loadDataset,
  normalizeModel,
  parseArgs,
} from "../src/utils";

dotenv.config();

const FIXTURES_DIR = path.resolve(process.cwd(), "tests/fixtures/responses");

interface ProbeRow {
  model: string;
  // The provider slugs pinned in the config, each possibly carrying a region
  // shard suffix (e.g. "google-vertex/global").
  pinnedOrder?: string[];
  // Whatever the completion reported — usually a display name ("Google").
  resolved?: string;
  // `resolved` translated to a catalog slug, or null when it is not in the
  // catalog. Filled in by assess().
  resolvedSlug?: string | null;
  isNegated: boolean;
  parsed: number | null;
  finishReason: string | null;
  tokensOut: number | null;
  reasoningTokens: number | null;
  costNano: number | null;
  timeMs: number;
  attempts: number;
  errors: string[];
}

const problems: string[] = [];
const warnings: string[] = [];

async function probe(
  model: NormalizedModel,
  event: DatasetEvent,
  market: DatasetMarket,
  isNegated: boolean,
  apiKey: string,
): Promise<ProbeRow> {
  const result = await generateForecast({
    apiKey,
    model: model.slug,
    providerOrder: model.providerOrder,
    event,
    market,
    isNegated,
    identifier: `probe-${isNegated ? "neg" : "base"}`,
    // One attempt only: a retry would mask exactly the fragility being probed,
    // and would double the cost of the probe.
    maxRetries: 0,
  });

  // Keep the raw text — it is the most realistic parser corpus available.
  if (result.rawResponse) {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
    const safe = model.slug.replace(/[^a-z0-9.-]/gi, "_");
    fs.writeFileSync(
      path.join(FIXTURES_DIR, `${safe}-${isNegated ? "neg" : "base"}.txt`),
      result.rawResponse,
      "utf8",
    );
  }

  return {
    model: model.slug,
    pinnedOrder: model.providerOrder,
    resolved: result.provider,
    isNegated,
    parsed: result.parsedOdds,
    finishReason: result.finishReason,
    tokensOut: result.tokensOut,
    reasoningTokens: result.reasoningTokens,
    costNano: result.cost,
    timeMs: result.timeMs,
    attempts: result.attempts,
    errors: result.errors.map((e) => `[${e.code}] ${e.message.slice(0, 120)}`),
  };
}

function assess(row: ProbeRow, catalog: ProviderRef[]): void {
  const tag = `${row.model} (${row.isNegated ? "negated" : "base"})`;

  // A config pins by slug ("google-vertex/global"); a completion reports a
  // display name ("Google"). Both are translated through the catalog before
  // being compared, so a correctly pinned model is not flagged.
  const { verdict, resolvedSlug } = checkProviderPin(
    row.pinnedOrder,
    row.resolved,
    catalog,
  );
  row.resolvedSlug = resolvedSlug;

  if (verdict === "violated") {
    problems.push(
      `${tag}: provider pin "${row.pinnedOrder?.join(",")}" NOT honored — ` +
        `routed to "${row.resolved}" (${resolvedSlug}). Runs will drift between backends.`,
    );
  } else if (verdict === "unverifiable" && row.pinnedOrder?.length) {
    // Deliberately a warning, not a problem: an absent catalog entry says
    // nothing about whether the pin was honored, and failing here would be the
    // false alarm this translation exists to prevent.
    warnings.push(
      `${tag}: cannot verify the provider pin — ` +
        (row.resolved
          ? `"${row.resolved}" is not in the provider catalog. Refresh providers.json and re-seed.`
          : `the completion reported no provider.`),
    );
  }
  if (row.finishReason === "length") {
    problems.push(
      `${tag}: finish_reason="length" — the response was truncated before the answer. ` +
        `Reasoning is eating the max_tokens budget; every call will cost full price ` +
        `and return nothing usable. Raise maxTokens or lower reasoning effort.`,
    );
  }
  if (row.parsed === null) {
    problems.push(
      `${tag}: no 'Probability: X%' parsed — this model does not follow the output format.`,
    );
  }
  if (row.costNano === null) {
    problems.push(
      `${tag}: provider reported no cost — this model's spend will be unaccounted for.`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const configPath = (args.config as string) || (args.c as string);
  if (!configPath) throw new Error("Missing required --config <path>");

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");

  const config = loadBenchmarkConfig(configPath);
  const datasetPath =
    (args.dataset as string) || (args.d as string) || config.dataset;
  if (!datasetPath) throw new Error("Missing dataset: pass --dataset <path>");

  const dataset = loadDataset(datasetPath);
  const event = dataset[0];
  const market = event?.markets?.[0];
  if (!event || !market) throw new Error("Dataset has no usable event/market");

  const models = config.models.map(normalizeModel);

  // The provider catalog is the authority on slug <-> display name. Without it
  // a pinned slug cannot be compared to what a completion reports, so pin
  // checks degrade to "unverifiable" rather than guessing.
  let catalog: ProviderRef[] = [];
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    const db = new Database(databaseUrl);
    try {
      catalog = await db.getProviders();
    } catch (error) {
      console.warn(`  (could not read the provider catalog: ${error})`);
    } finally {
      await db.close();
    }
  }
  if (catalog.length === 0) {
    console.warn(
      "⚠️  Provider catalog is empty — provider pins cannot be verified.\n" +
        "   Seed it with: npx tsx scripts/seed-providers.ts\n",
    );
  } else {
    console.log(`Provider catalog: ${catalog.length} provider(s).`);
  }

  // Production shape, for the cost projection.
  const iterations = parseInt(
    (args.iterations as string) || String(config.promptIterations ?? 4),
    10,
  );
  const marketCount = args.markets
    ? parseInt(args.markets as string, 10)
    : dataset.reduce((sum, e) => sum + e.markets.length, 0);

  console.log(
    `Probing ${models.length} model(s) x 2 phrasings on "${market.question}"\n`,
  );

  const rows: ProbeRow[] = [];
  for (const model of models) {
    for (const isNegated of [false, true]) {
      process.stdout.write(
        `  ${model.slug} ${isNegated ? "(negated)" : "(base)"} … `,
      );
      const row = await probe(model, event, market, isNegated, apiKey);
      rows.push(row);
      assess(row, catalog);
      console.log(
        row.parsed !== null
          ? `${(row.parsed * 100).toFixed(2)}%  ${row.timeMs}ms`
          : `FAILED  ${row.errors[0] ?? "(no error recorded)"}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Table
  // -------------------------------------------------------------------------
  console.log(`\n${"=".repeat(138)}`);
  const header = [
    "model".padEnd(34),
    "phrasing".padEnd(8),
    "provider".padEnd(16),
    "slug".padEnd(20),
    "parsed".padEnd(8),
    "finish".padEnd(9),
    "out".padEnd(6),
    "reason".padEnd(7),
    "cost($)".padEnd(10),
    "ms",
  ].join(" ");
  console.log(header);
  console.log("-".repeat(138));
  for (const r of rows) {
    console.log(
      [
        r.model.slice(0, 33).padEnd(34),
        (r.isNegated ? "negated" : "base").padEnd(8),
        (r.resolved ?? "?").slice(0, 15).padEnd(16),
        (r.resolvedSlug ?? "(unknown)").slice(0, 19).padEnd(20),
        (r.parsed === null ? "FAIL" : `${(r.parsed * 100).toFixed(2)}%`).padEnd(
          8,
        ),
        (r.finishReason ?? "?").padEnd(9),
        String(r.tokensOut ?? "?").padEnd(6),
        String(r.reasoningTokens ?? "?").padEnd(7),
        (r.costNano === null ? "none" : (r.costNano / 1e9).toFixed(6)).padEnd(
          10,
        ),
        String(r.timeMs),
      ].join(" "),
    );
  }
  console.log("=".repeat(138));

  // -------------------------------------------------------------------------
  // Cost projection — the number worth knowing before committing.
  // -------------------------------------------------------------------------
  const costed = rows.filter((r) => r.costNano !== null);
  const probeCost = costed.reduce((sum, r) => sum + (r.costNano ?? 0), 0) / 1e9;
  console.log(`\nThis probe cost $${probeCost.toFixed(4)}.`);

  if (costed.length > 0) {
    console.log(
      `\nProjected production cost at ${marketCount} markets x 2 phrasings x ${iterations} iterations:`,
    );
    let projectedTotal = 0;
    for (const model of models) {
      const modelRows = rows.filter(
        (r) => r.model === model.slug && r.costNano !== null,
      );
      if (modelRows.length === 0) {
        console.log(`  ${model.slug.padEnd(38)} unknown (no cost reported)`);
        continue;
      }
      const meanCost =
        modelRows.reduce((s, r) => s + (r.costNano ?? 0), 0) /
        modelRows.length /
        1e9;
      const projected = meanCost * marketCount * 2 * iterations;
      projectedTotal += projected;
      console.log(`  ${model.slug.padEnd(38)} $${projected.toFixed(2)}`);
    }
    console.log(`  ${"TOTAL".padEnd(38)} $${projectedTotal.toFixed(2)}`);
    console.log(
      `\n  (Excludes retries. A model that fails to parse costs up to 4x this.)`,
    );
  }

  // -------------------------------------------------------------------------
  // Verdict
  // -------------------------------------------------------------------------
  // Warnings do not fail the probe: they mark what could not be checked, which
  // is different from something being wrong.
  if (warnings.length > 0) {
    console.log(`\n⚠️  ${warnings.length} warning(s):\n`);
    for (const w of warnings) console.log(`  - ${w}`);
  }

  if (problems.length === 0) {
    console.log("\n✅ No per-model problems detected.");
  } else {
    console.log(`\n❌ ${problems.length} problem(s) found:\n`);
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("probe-models failed:", error);
  process.exit(1);
});
