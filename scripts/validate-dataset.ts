// Check a dataset before it costs anything.
//
//   npx tsx scripts/validate-dataset.ts --dataset datasets/28-07-26.json
//   npx tsx scripts/validate-dataset.ts --dataset d.json --config configs/c.json
//   npx tsx scripts/validate-dataset.ts --dataset d.json --max-markets 2 --max-pairs 1
//
// `benchmark.ts` runs the same validation itself, fatally, before it writes
// anything — this exists so a dataset can be checked while it is being
// authored, without a database, an API key, or a chain.
//
// The checks that matter most are the ones producing WRONG rows rather than
// missing ones — a duplicate external id merging two markets into one, an
// unresolvable pair slug — because every structural check downstream accepts
// their output. `negatedQuestion` is deliberately NOT among them: the "No" side
// is asked by naming the outcome on the unmodified market, so the field is
// unused metadata. See the header of src/llm.ts.
//
// Exits non-zero on failure, so it can gate a pipeline.

import {
  loadBenchmarkConfig,
  loadDataset,
  parseArgs,
  resolvePairs,
  sliceDataset,
  validateDataset,
} from "../src/utils";
import { PAIRWISE_COMBINATIONS } from "../src/types";

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const datasetPath = (args.dataset as string) || (args.d as string);
  if (!datasetPath) {
    throw new Error(
      "Usage: validate-dataset.ts --dataset <path> [--config <path>] " +
        "[--max-markets N] [--max-pairs N]",
    );
  }

  const dataset = loadDataset(datasetPath);
  const result = validateDataset(dataset, datasetPath);

  console.log(`\n✅ ${datasetPath} is valid`);
  console.log(
    `   ${result.events} event(s), ${result.markets} market(s), ${result.pairs} pair(s)`,
  );

  if (result.warnings.length > 0) {
    console.log(`\n⚠️  ${result.warnings.length} warning(s):`);
    for (const warning of result.warnings) console.log(`   - ${warning}`);
  }

  // Report the slice the same flags would produce for a run, so a rehearsal's
  // scope can be confirmed before it is the thing spending money.
  const num = (name: string): number | undefined => {
    const raw = args[name];
    return raw === undefined ? undefined : parseInt(String(raw), 10);
  };
  const maxMarkets = num("max-markets");
  const maxPairs = num("max-pairs");
  const sliced = sliceDataset(dataset, { maxMarkets, maxPairs });
  if (sliced !== dataset) {
    const slicedMarkets = sliced.events.reduce(
      (n, e) => n + e.markets.length,
      0,
    );
    console.log(
      `\nWith --max-markets ${maxMarkets ?? "all"} --max-pairs ${maxPairs ?? "all"}:` +
        ` ${slicedMarkets} market(s), ${sliced.pairs.length} pair(s),` +
        ` ${sliced.events.length} event(s)`,
    );
    for (const event of sliced.events) {
      for (const market of event.markets) {
        console.log(`   - ${market.slug}`);
      }
    }
    resolvePairs(sliced);
  }

  // Task volume is the number that decides whether a run fits in a day and what
  // it costs, so print it here rather than making someone derive it.
  const configPath = (args.config as string) || (args.c as string);
  if (configPath) {
    const config = loadBenchmarkConfig(configPath);
    const markets = sliced.events.reduce((n, e) => n + e.markets.length, 0);
    const models = config.models.length;
    const direct = markets * 2 * config.promptIterations;
    const pairwise =
      sliced.pairs.length *
      PAIRWISE_COMBINATIONS.length *
      config.pairwiseIterations;
    console.log(
      `\nProjected volume for ${configPath}:\n` +
        `   direct   ${markets} × 2 phrasings × ${config.promptIterations} iteration(s) = ${direct} call(s) per model\n` +
        `   pairwise ${sliced.pairs.length} × ${PAIRWISE_COMBINATIONS.length} combinations × ${config.pairwiseIterations} iteration(s) = ${pairwise} call(s) per model\n` +
        `   total    ${(direct + pairwise) * models} call(s) across ${models} model(s)`,
    );
  }
}

try {
  main();
} catch (error) {
  console.error(
    `\n❌ ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
