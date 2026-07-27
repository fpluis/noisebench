// Generate a production-shaped dataset for offline rehearsals.
//
//   npx tsx scripts/gen-synthetic-dataset.ts --events 25 --markets-per-event 4
//   npx tsx scripts/gen-synthetic-dataset.ts --markets 100 --research-kb 6
//
// The point is not realistic *content* — it is realistic **shape and stress**:
// the same market count, the same order-of-magnitude research blobs, and text
// that will break anything with a hidden encoding or length assumption. If the
// schema survives this at production volume, real data will not surprise it.
//
// Written to datasets/synthetic-<markets>.json unless --out is given.

import fs from "fs";
import path from "path";
import { Dataset, DatasetEvent, DatasetMarket } from "../src/types";
import { parseArgs } from "../src/utils";

// Text designed to break naive persistence: multi-byte characters, quotes that
// break string escaping, and sequences that look like injection payloads. They
// are stored as data and must come back byte-identical.
const HOSTILE_SNIPPETS = [
  "Ünïcödé: café, naïve, Straße, 日本語, العربية, עברית",
  "Emoji: 🎲📈🇺🇸👨‍👩‍👧‍👦 (incl. a ZWJ sequence)",
  "Quotes: “smart”, ‘single’, \"double\", 'apostrophe's'",
  "Escapes: backslash \\ tab\\t newline\\n percent 100%",
  "Injection-shaped: '); DROP TABLE forecast; --",
  'JSON-shaped: {"nested": [1, {"a": null}]}',
  "Math: 1 < 2 > 0, a & b, <script>alert(1)</script>",
  "Long word: " + "supercalifragilistic".repeat(8),
];

const LOREM = [
  "Recent polling shows a narrowing margin across the relevant states.",
  "Prediction markets have repricized this contract three times this month.",
  "The resolution source has clarified its criteria in an update.",
  "Historical base rates for comparable events sit near one in four.",
  "A scheduled announcement falls inside the resolution window.",
];

/** Build a research blob of approximately `kb` kilobytes. */
const buildResearch = (eventIndex: number, kb: number): string => {
  const target = kb * 1024;
  const parts: string[] = [
    `# Deep Research Report — synthetic event ${eventIndex}`,
    "",
    "## Encoding stress",
    ...HOSTILE_SNIPPETS,
    "",
    "## Findings",
  ];
  let size = parts.join("\n").length;
  let i = 0;
  while (size < target) {
    const line = `- [${i}] ${LOREM[i % LOREM.length]} (paragraph ${i})`;
    parts.push(line);
    size += line.length + 1;
    i++;
  }
  return parts.join("\n");
};

const buildMarket = (
  eventIndex: number,
  marketIndex: number,
): DatasetMarket => {
  // External ids must be unique across the whole dataset: they are the primary
  // key on `market` and the string written on-chain as `marketId`.
  const externalId = `9${String(eventIndex).padStart(3, "0")}${String(marketIndex).padStart(3, "0")}`;
  const subject = `candidate ${marketIndex} of event ${eventIndex}`;
  return {
    externalId,
    slug: `synthetic-market-${eventIndex}-${marketIndex}`,
    question: `Will ${subject} achieve the stated outcome by the deadline?`,
    negatedQuestion: `Will ${subject} fail to achieve the stated outcome by the deadline?`,
    description:
      `Resolution rules for ${subject}. ` +
      HOSTILE_SNIPPETS.join(" ") +
      " This market resolves Yes only if the outcome occurs strictly between the start and end dates.",
    startDate: "2026-06-01T00:00:00.000Z",
    endDate: "2026-12-31T00:00:00.000Z",
  };
};

const buildEvent = (
  eventIndex: number,
  marketsPerEvent: number,
  researchKb: number,
): DatasetEvent => ({
  externalId: `8${String(eventIndex).padStart(5, "0")}`,
  isNegRisk: eventIndex % 2 === 0,
  startDate: "2026-06-01T00:00:00.000Z",
  endDate: "2026-12-31T00:00:00.000Z",
  title: `Synthetic event ${eventIndex} — ${HOSTILE_SNIPPETS[eventIndex % HOSTILE_SNIPPETS.length]}`,
  description: `Event-level rules for synthetic event ${eventIndex}. ${HOSTILE_SNIPPETS.join(" ")}`,
  slug: `synthetic-event-${eventIndex}`,
  tags: ["synthetic", "test"],
  markets: Array.from({ length: marketsPerEvent }, (_, m) =>
    buildMarket(eventIndex, m),
  ),
  research: buildResearch(eventIndex, researchKb),
});

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const marketsPerEvent = parseInt(
    (args["markets-per-event"] as string) || "4",
    10,
  );
  // Either say how many events you want, or how many total markets.
  const totalMarkets = args.markets
    ? parseInt(args.markets as string, 10)
    : null;
  const events = totalMarkets
    ? Math.ceil(totalMarkets / marketsPerEvent)
    : parseInt((args.events as string) || "25", 10);
  const researchKb = parseInt((args["research-kb"] as string) || "6", 10);

  const dataset: Dataset = Array.from({ length: events }, (_, e) =>
    buildEvent(e, marketsPerEvent, researchKb),
  );

  const marketCount = dataset.reduce((sum, e) => sum + e.markets.length, 0);
  const outPath = path.resolve(
    process.cwd(),
    (args.out as string) || `datasets/synthetic-${marketCount}.json`,
  );

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(dataset, null, 2), "utf8");

  const bytes = fs.statSync(outPath).size;
  console.log(`Wrote ${outPath}`);
  console.log(
    `  ${events} event(s), ${marketCount} market(s), ${(bytes / 1024 / 1024).toFixed(2)} MB`,
  );
  console.log(
    `  At 4 iterations x 2 phrasings: ${marketCount * 8} task(s) per model.`,
  );
}

main();
