// Smoke test for the inference path. Touches neither the database nor the
// chain — it only needs OPENROUTER_API_KEY. Nothing it produces is stored.
//
// Sweep a whole dataset with one model — every market in both phrasings, every
// pair in all four phrasing combinations — and report the coherence numbers:
//
//   npm run test-inference -- --dataset datasets/28-07-26.json \
//       --config configs/benchmark.example.json --model <slug> --all [--verbose]
//
// Or make a single call and print everything that came back:
//
//   npm run test-inference -- --dataset … --config … \
//       [--event <event-slug>] [--model <openrouter-slug>] [--negated]
//
//   npm run test-inference -- --dataset … --config … --pairwise \
//       [--pair <index>] [--combination <00|10|01|11>]
//
// --model defaults to the first model in the config; --event to the first event
// in the dataset, using its first market. In --pairwise mode, --pair indexes the
// dataset's `pairs` array and --combination selects which phrasings the two
// sides are asked in (A then B, 1 = negated). --all ignores those selectors: it
// runs the whole dataset.

import * as dotenv from "dotenv";
import {
  loadBenchmarkConfig,
  loadDataset,
  normalizeModel,
  parseArgs,
  resolvePairs,
} from "../src/utils";
import { generateForecast, generatePairwiseForecast } from "../src/llm";
import {
  Dataset,
  InferenceTrace,
  NormalizedModel,
  PAIRWISE_COMBINATIONS,
  PairwiseChoice,
  PairwiseCombination,
} from "../src/types";

dotenv.config();

/** Everything up to the parsed answer, printed identically for both modalities. */
function reportTrace(result: InferenceTrace): void {
  console.log("\n----- SYSTEM PROMPT -----\n" + result.systemPrompt);
  console.log("\n----- USER PROMPT -----\n" + result.userPrompt);
  if (result.reasoning) {
    console.log("\n----- REASONING -----\n" + result.reasoning);
  }
  console.log(
    "\n----- RAW RESPONSE -----\n" + (result.rawResponse ?? "(none)"),
  );
  console.log("\n----- PARSED -----");
}

function reportFooter(result: InferenceTrace, startedAt: number): void {
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
    `Inference time: ${result.timeMs} ms  (wall: ${Date.now() - startedAt} ms)`,
  );
  if (result.errors.length > 0) {
    console.log(`\n----- ERRORS (${result.errors.length}) -----`);
    for (const err of result.errors) {
      console.log(`  [${err.code}] ${err.message}`);
    }
  }
  console.log("\nDone.");
}

const usd = (nano: number | null): string =>
  nano === null ? "(no cost)" : `$${(nano / 1e9).toFixed(6)}`;

/** Collapse a raw response to one line, for --verbose. */
const oneLine = (text: string | null, width = 300): string =>
  (text ?? "(none)").replace(/\s+/g, " ").slice(0, width);

// ---------------------------------------------------------------------------
// --all: the whole dataset through one model
// ---------------------------------------------------------------------------

/** "00" | "10" | "01" | "11" — A's phrasing then B's, 1 = negated. */
const comboLabel = (c: PairwiseCombination): string =>
  `${c.isANegated ? 1 : 0}${c.isBNegated ? 1 : 0}`;

/** One market's two phrasings, kept together so `|Yes + No - 1|` is computable. */
interface MarketOutcome {
  slug: string;
  base: number | null;
  negated: number | null;
}

/** One pair's four combinations, keyed by label so the couples can be compared. */
interface PairOutcome {
  index: number;
  choices: Map<string, PairwiseChoice | null>;
}

/**
 * Run every market and every pair in the dataset through one model, then report
 * the two coherence metrics the benchmark itself measures.
 *
 * Calls are sequential: this is a pre-flight for one model, where legible output
 * and a bounded burst against the provider matter more than wall time.
 */
async function runWholeDataset(
  dataset: Dataset,
  model: NormalizedModel,
  apiKey: string,
  verbose: boolean,
): Promise<void> {
  // Resolve pairs before spending anything — a dataset authoring bug should
  // cost nothing to discover.
  const pairs = resolvePairs(dataset);
  const markets = dataset.events.flatMap((event) =>
    event.markets.map((market) => ({ event, market })),
  );

  const directCalls = markets.length * 2;
  const pairwiseCalls = pairs.length * PAIRWISE_COMBINATIONS.length;

  console.log("=".repeat(96));
  console.log(`Model:          ${model.slug}`);
  console.log(
    `Provider order: ${model.providerOrder?.join(", ") ?? "(default)"}`,
  );
  console.log(
    `Plan:           ${markets.length} market(s) x 2 phrasings   = ${directCalls} direct call(s)`,
  );
  console.log(
    `                ${pairs.length} pair(s) x 4 combinations = ${pairwiseCalls} pairwise call(s)`,
  );
  console.log(`                ${directCalls + pairwiseCalls} calls in total`);
  console.log("=".repeat(96));

  let costNano = 0;
  let costUnreported = 0;
  let unusable = 0;
  let retried = 0;
  const started = Date.now();

  /** Fold one call's accounting in, whichever modality produced it. */
  const account = (result: InferenceTrace): void => {
    if (result.cost === null) costUnreported++;
    else costNano += result.cost;
    if (result.attempts > 1) retried++;
  };

  // Direct ------------------------------------------------------------------
  const marketOutcomes: MarketOutcome[] = [];
  console.log(`\n--- DIRECT (${directCalls} call(s)) ---`);
  for (const { event, market } of markets) {
    const outcome: MarketOutcome = {
      slug: market.slug,
      base: null,
      negated: null,
    };
    for (const isNegated of [false, true]) {
      process.stdout.write(
        `  ${market.slug.slice(0, 54).padEnd(56)}${(isNegated ? "negated" : "base").padEnd(9)}`,
      );
      const result = await generateForecast({
        apiKey,
        model: model.slug,
        providerOrder: model.providerOrder,
        event,
        market,
        isNegated,
        identifier: `test-inference-all-${isNegated ? "neg" : "base"}`,
      });
      account(result);

      if (result.parsedOdds === null) {
        unusable++;
        const first = result.errors[0];
        console.log(
          `FAILED  ${String(result.timeMs).padStart(6)}ms  ` +
            (first
              ? `[${first.code}] ${first.message.slice(0, 60)}`
              : "(no 'Probability: X%' in the response)"),
        );
      } else {
        if (isNegated) outcome.negated = result.parsedOdds;
        else outcome.base = result.parsedOdds;
        console.log(
          `${(result.parsedOdds * 100).toFixed(2).padStart(6)}%  ` +
            `${String(result.timeMs).padStart(6)}ms  ${usd(result.cost)}`,
        );
      }
      if (verbose) console.log(`      raw: ${oneLine(result.rawResponse)}`);
    }
    marketOutcomes.push(outcome);
  }

  // Pairwise ----------------------------------------------------------------
  const pairOutcomes: PairOutcome[] = [];
  if (pairs.length > 0) {
    console.log(`\n--- PAIRWISE (${pairwiseCalls} call(s)) ---`);
  }
  for (const [index, pair] of pairs.entries()) {
    console.log(
      `  pair #${index}:  A = ${pair.marketA.slug.slice(0, 36)}\n` +
        `            B = ${pair.marketB.slug.slice(0, 36)}`,
    );
    const choices = new Map<string, PairwiseChoice | null>();
    for (const combination of PAIRWISE_COMBINATIONS) {
      const combo = comboLabel(combination);
      process.stdout.write(
        `    ${combo}  ${combination.isANegated ? "¬A" : " A"} vs ${combination.isBNegated ? "¬B" : " B"}   `,
      );
      const result = await generatePairwiseForecast({
        apiKey,
        model: model.slug,
        providerOrder: model.providerOrder,
        pair,
        combination,
        identifier: `test-inference-all-pairwise-${combo}`,
      });
      account(result);

      choices.set(combo, result.choice);
      if (result.choice === null) {
        unusable++;
        const first = result.errors[0];
        console.log(
          `-  ${String(result.timeMs).padStart(6)}ms  ` +
            (first
              ? `[${first.code}] ${first.message.slice(0, 60)}`
              : "(refused to rank, or no 'More likely: A|B')"),
        );
      } else {
        console.log(
          `${result.choice}  ${String(result.timeMs).padStart(6)}ms  ${usd(result.cost)}`,
        );
      }
      if (verbose) console.log(`        raw: ${oneLine(result.rawResponse)}`);
    }
    pairOutcomes.push({ index, choices });
  }

  // -------------------------------------------------------------------------
  // Coherence — the same two metrics verify-run computes over a stored run,
  // reported here for one model so a config can be judged before committing.
  // -------------------------------------------------------------------------
  console.log(`\n${"=".repeat(96)}`);
  console.log("DIRECT COHERENCE — |Yes + No - 1|, 0 = perfectly coherent");
  console.log("-".repeat(96));
  const deviations: number[] = [];
  for (const m of marketOutcomes) {
    const label = `  ${m.slug.slice(0, 58).padEnd(60)}`;
    if (m.base === null || m.negated === null) {
      console.log(`${label}incomplete — a phrasing produced no usable answer`);
      continue;
    }
    const deviation = Math.abs(m.base + m.negated - 1);
    deviations.push(deviation);
    console.log(
      `${label}${(m.base * 100).toFixed(2).padStart(6)}% + ` +
        `${(m.negated * 100).toFixed(2).padStart(6)}%  ->  ` +
        `${(deviation * 100).toFixed(2).padStart(6)}%`,
    );
  }
  if (deviations.length > 0) {
    const mean = deviations.reduce((a, b) => a + b, 0) / deviations.length;
    console.log(
      `  mean over ${deviations.length} complete market(s) = ${(mean * 100).toFixed(2)}%  ` +
        `(max ${(Math.max(...deviations) * 100).toFixed(2)}%)`,
    );
  }

  if (pairOutcomes.length > 0) {
    console.log(`\n${"=".repeat(96)}`);
    console.log(
      "PAIRWISE COHERENCE — flipping both sides must invert the answer",
    );
    console.log("-".repeat(96));
    // The two complementary couples. Agreement WITHIN a couple is the
    // contradiction: the model ranked A over B and also ranked ¬A over ¬B.
    const couples: [string, string][] = [
      ["00", "11"],
      ["10", "01"],
    ];
    let complete = 0;
    let violated = 0;
    for (const p of pairOutcomes) {
      const verdicts = couples.map(([x, y]) => {
        const first = p.choices.get(x);
        const second = p.choices.get(y);
        if (!first || !second) return `${x}/${y} incomplete`;
        complete++;
        if (first === second) {
          violated++;
          return `${x}/${y} ${first}=${second} VIOLATED`;
        }
        return `${x}/${y} ${first}/${second} ok`;
      });
      console.log(`  pair #${p.index}    ${verdicts.join("      ")}`);
    }
    if (complete > 0) {
      console.log(
        `  ${violated}/${complete} complete couple(s) violated = ` +
          `${((violated / complete) * 100).toFixed(2)}%`,
      );
    }
  }

  // -------------------------------------------------------------------------
  console.log(`\n${"=".repeat(96)}`);
  console.log(
    `${directCalls + pairwiseCalls} call(s) in ${((Date.now() - started) / 1000).toFixed(1)}s · ` +
      `${unusable} unusable · $${(costNano / 1e9).toFixed(4)} spent` +
      (costUnreported > 0
        ? ` (+${costUnreported} call(s) reported no cost)`
        : ""),
  );
  // A trace carries only the final attempt's cost, so a retried call's earlier
  // attempts were paid for but are not in the total above. Say so rather than
  // let an underestimate be read as the real number.
  if (retried > 0) {
    console.log(
      `${retried} call(s) needed a retry — their earlier attempts were billed but are not in that total.`,
    );
  }
  console.log("Nothing was stored: no database writes, no chain.");
  console.log("=".repeat(96));

  // A model that cannot answer is the thing this script exists to catch, so it
  // must be visible to a shell, not only to a reader.
  if (unusable > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const datasetPath = (args.dataset as string) || (args.d as string);
  const configPath = (args.config as string) || (args.c as string);

  if (!datasetPath || !configPath) {
    console.error(
      "Usage: npm run test-inference -- --dataset <path> --config <path> [--model <slug>] [--all]",
    );
    process.exit(1);
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");

  const dataset = loadDataset(datasetPath);
  const config = loadBenchmarkConfig(configPath);

  const model = args.model
    ? { slug: args.model as string }
    : normalizeModel(config.models[0]);

  if (args.all) {
    await runWholeDataset(dataset, model, apiKey, Boolean(args.verbose));
    return;
  }

  if (args.pairwise) {
    const pairs = resolvePairs(dataset);
    const index = parseInt((args.pair as string) || "0", 10);
    const pair = pairs[index];
    if (!pair) {
      throw new Error(
        `Dataset has no pairs[${index}] (${pairs.length} pair(s) available)`,
      );
    }
    const combo = String(args.combination ?? "00");
    if (!/^[01]{2}$/.test(combo)) {
      throw new Error(
        `--combination must be 00, 10, 01 or 11 (got "${combo}")`,
      );
    }
    const combination = {
      isANegated: combo[0] === "1",
      isBNegated: combo[1] === "1",
    };

    console.log("=".repeat(80));
    console.log(`Pair:     #${index} of ${pairs.length}`);
    console.log(
      `Outcome A: ${combination.isANegated ? (pair.marketA.negatedQuestion ?? pair.marketA.question) : pair.marketA.question}`,
    );
    console.log(
      `Outcome B: ${combination.isBNegated ? (pair.marketB.negatedQuestion ?? pair.marketB.question) : pair.marketB.question}`,
    );
    console.log(`Model:    ${model.slug}`);
    console.log(
      `Provider order: ${model.providerOrder?.join(", ") ?? "(default)"}`,
    );
    console.log(`Combination: ${combo} (1 = negated phrasing)`);
    console.log("=".repeat(80));

    const started = Date.now();
    const result = await generatePairwiseForecast({
      apiKey,
      model: model.slug,
      providerOrder: model.providerOrder,
      pair,
      combination,
      identifier: "test-inference-pairwise",
    });

    reportTrace(result);
    console.log(
      `Choice:         ${
        result.choice === null
          ? "FAILED TO PARSE"
          : `${result.choice} (outcome ${result.choice} is likelier)`
      }`,
    );
    reportFooter(result, started);
    return;
  }

  const event =
    (args.event
      ? dataset.events.find((e) => e.slug === args.event)
      : dataset.events[0]) ?? undefined;
  if (!event) throw new Error(`Event not found: ${args.event}`);
  const market = event.markets[0];
  if (!market) throw new Error(`Event "${event.slug}" has no markets`);

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

  reportTrace(result);
  console.log(
    `Parsed odds:    ${
      result.parsedOdds === null
        ? "FAILED TO PARSE"
        : `${(result.parsedOdds * 100).toFixed(2)}% (${result.parsedOdds})`
    }`,
  );
  reportFooter(result, started);
}

main().catch((error) => {
  console.error("test-inference failed:", error);
  process.exit(1);
});
