// Quick smoke test for the inference path: run one market through one model and
// print everything we got back. Touches neither the database nor the chain — it
// only needs OPENROUTER_API_KEY.
//
//   npm run test-inference -- --dataset datasets/19-07-2026.json \
//       --config configs/benchmark.example.json \
//       [--event <event-slug>] [--model <openrouter-slug>] [--negated]
//
// --event defaults to the first event in the dataset, --model to the first model
// in the config. The first market of the chosen event is used.

import * as dotenv from "dotenv";
import {
  loadBenchmarkConfig,
  loadDataset,
  normalizeModel,
  parseArgs,
} from "../src/utils";
import { generateForecast } from "../src/llm";

dotenv.config();

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const datasetPath = (args.dataset as string) || (args.d as string);
  const configPath = (args.config as string) || (args.c as string);

  if (!datasetPath || !configPath) {
    console.error(
      "Usage: npm run test-inference -- --dataset <path> --config <path> [--event <slug>] [--model <slug>] [--negated]",
    );
    process.exit(1);
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");

  const dataset = loadDataset(datasetPath);
  const config = loadBenchmarkConfig(configPath);

  const event =
    (args.event ? dataset.find((e) => e.slug === args.event) : dataset[0]) ??
    undefined;
  if (!event) throw new Error(`Event not found: ${args.event}`);
  const market = event.markets[0];
  if (!market) throw new Error(`Event "${event.slug}" has no markets`);

  const model = args.model
    ? { slug: args.model as string }
    : normalizeModel(config.models[0]);
  const isNegated = Boolean(args.negated);

  console.log("=".repeat(80));
  console.log(`Event:   ${event.title}  (${event.slug})`);
  console.log(
    `Market:  ${isNegated ? market.negatedQuestion : market.question}`,
  );
  console.log(`Model:   ${model.slug}`);
  console.log(
    `Provider order: ${model.providerOrder?.join(", ") ?? "(default)"}`,
  );
  console.log(`Modality: ${isNegated ? "negated" : "base"}`);
  console.log("=".repeat(80));

  const started = Date.now();
  const result = await generateForecast({
    apiKey,
    model: model.slug,
    providerOrder: model.providerOrder,
    event,
    market,
    isNegated,
    identifier: "test-inference",
  });

  console.log("\n----- SYSTEM PROMPT -----\n" + result.systemPrompt);
  console.log("\n----- USER PROMPT -----\n" + result.userPrompt);
  if (result.reasoning) {
    console.log("\n----- REASONING -----\n" + result.reasoning);
  }
  console.log(
    "\n----- RAW RESPONSE -----\n" + (result.rawResponse ?? "(none)"),
  );
  console.log("\n----- PARSED -----");
  console.log(
    `Parsed odds:    ${
      result.parsedOdds === null
        ? "FAILED TO PARSE"
        : `${(result.parsedOdds * 100).toFixed(2)}% (${result.parsedOdds})`
    }`,
  );
  console.log(`Provider:       ${result.provider ?? "(unknown)"}`);
  console.log(`Finish reason:  ${result.finishReason ?? "(unknown)"}`);
  console.log(
    `Tokens in/out:  ${result.tokensIn ?? "?"} / ${result.tokensOut ?? "?"}`,
  );
  console.log(`Reasoning toks: ${result.reasoningTokens ?? "?"}`);
  console.log(
    `Cost:           ${
      result.cost === null
        ? "(none reported)"
        : `$${(result.cost / 1e9).toFixed(6)}`
    }`,
  );
  console.log(`Attempts:       ${result.attempts}`);
  console.log(
    `Inference time: ${result.timeMs} ms  (wall: ${Date.now() - started} ms)`,
  );
  if (result.errors.length > 0) {
    console.log(`\n----- ERRORS (${result.errors.length}) -----`);
    for (const err of result.errors) {
      console.log(`  [${err.code}] ${err.message}`);
    }
  }
  console.log("\nDone.");
}

main().catch((error) => {
  console.error("test-inference failed:", error);
  process.exit(1);
});
