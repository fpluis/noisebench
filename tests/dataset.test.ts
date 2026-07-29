import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sliceDataset, validateDataset } from "../src/utils";
import { Dataset, DatasetEvent, DatasetMarket } from "../src/types";

const market = (n: number, over?: Partial<DatasetMarket>): DatasetMarket => ({
  externalId: `mk-ext-${n}`,
  slug: `mk-${n}`,
  question: `Will thing ${n} happen?`,
  negatedQuestion: `Will thing ${n} fail to happen?`,
  description: `Resolution rules for market number ${n}, spelled out at length.`,
  ...over,
});

const event = (n: number, markets: DatasetMarket[]): DatasetEvent => ({
  externalId: `ev-ext-${n}`,
  slug: `ev-${n}`,
  title: `Event ${n}`,
  research: `Research context for event ${n}.`,
  markets,
});

// Four events of two markets each: mk-0..mk-7, in that order.
const build = (pairs: Dataset["pairs"] = []): Dataset => ({
  events: [0, 1, 2, 3].map((e) => event(e, [market(e * 2), market(e * 2 + 1)])),
  pairs,
});

const marketSlugs = (dataset: Dataset): string[] =>
  dataset.events.flatMap((e) => e.markets.map((m) => m.slug));

describe("sliceDataset", () => {
  it("returns the dataset untouched when neither cap is set", () => {
    const dataset = build([["mk-0", "mk-1"]]);
    assert.equal(sliceDataset(dataset, {}), dataset);
  });

  it("takes markets in dataset order, which is the order ids are assigned in", () => {
    const sliced = sliceDataset(build(), { maxMarkets: 3 });
    assert.deepEqual(marketSlugs(sliced), ["mk-0", "mk-1", "mk-2"]);
  });

  it("drops events left with no markets", () => {
    const sliced = sliceDataset(build(), { maxMarkets: 2 });
    assert.deepEqual(
      sliced.events.map((e) => e.slug),
      ["ev-0"],
    );
  });

  it("keeps a selected pair's markets even when they are not first", () => {
    // The rehearsal case: 2 markets and 1 pair should yield exactly the two
    // markets that pair names, not the first two in the file.
    const sliced = sliceDataset(build([["mk-5", "mk-2"]]), {
      maxMarkets: 2,
      maxPairs: 1,
    });
    assert.deepEqual(marketSlugs(sliced).sort(), ["mk-2", "mk-5"]);
    assert.deepEqual(sliced.pairs, [["mk-5", "mk-2"]]);
  });

  it("fills the remaining budget with markets in dataset order", () => {
    const sliced = sliceDataset(build([["mk-6", "mk-7"]]), {
      maxMarkets: 4,
      maxPairs: 1,
    });
    // The pair's markets are mandatory; mk-0 and mk-1 fill the rest.
    assert.deepEqual(marketSlugs(sliced).sort(), [
      "mk-0",
      "mk-1",
      "mk-6",
      "mk-7",
    ]);
  });

  it("refuses a market cap too small for the pairs it must keep", () => {
    assert.throws(
      () =>
        sliceDataset(build([["mk-0", "mk-1"]]), { maxMarkets: 1, maxPairs: 1 }),
      /--max-markets 1 is too small/,
    );
  });

  it("truncates pairs before selecting markets", () => {
    const sliced = sliceDataset(
      build([
        ["mk-0", "mk-1"],
        ["mk-4", "mk-5"],
      ]),
      { maxPairs: 1 },
    );
    assert.deepEqual(sliced.pairs, [["mk-0", "mk-1"]]);
    // No market cap, so every market survives.
    assert.equal(marketSlugs(sliced).length, 8);
  });

  it("a slice is always a subset of the full dataset, so ids are reusable", () => {
    // The property the whole slice-then-widen workflow depends on: every market
    // in a slice appears, unchanged, in the file the widened run reads.
    const full = build([["mk-3", "mk-6"]]);
    const sliced = sliceDataset(full, { maxMarkets: 5, maxPairs: 1 });
    const fullBySlug = new Map(
      full.events.flatMap((e) => e.markets.map((m) => [m.slug, m])),
    );
    for (const slug of marketSlugs(sliced)) {
      assert.deepEqual(
        sliced.events.flatMap((e) => e.markets).find((m) => m.slug === slug),
        fullBySlug.get(slug),
      );
    }
  });
});

describe("validateDataset", () => {
  it("accepts a well-formed dataset and reports its size", () => {
    const result = validateDataset(build([["mk-0", "mk-1"]]));
    assert.equal(result.events, 4);
    assert.equal(result.markets, 8);
    assert.equal(result.pairs, 1);
    assert.deepEqual(result.warnings, []);
  });

  it("REJECTS a market with no negatedQuestion", () => {
    // The highest-stakes check in the file. Without it the negated phrasing
    // asks the BASE question, and the answer is stored as is_negated = true and
    // published on-chain as that market's "No" — wrong data that every
    // structural check downstream accepts.
    const dataset = build();
    delete dataset.events[1].markets[0].negatedQuestion;
    assert.throws(
      () => validateDataset(dataset),
      /negatedQuestion is required/,
    );
  });

  it("REJECTS a negatedQuestion identical to the question", () => {
    const dataset = build();
    dataset.events[0].markets[0].negatedQuestion =
      dataset.events[0].markets[0].question;
    assert.throws(
      () => validateDataset(dataset),
      /negatedQuestion is identical to question/,
    );
  });

  it("treats whitespace-only negation as missing", () => {
    const dataset = build();
    dataset.events[0].markets[0].negatedQuestion = "   ";
    assert.throws(
      () => validateDataset(dataset),
      /negatedQuestion is required/,
    );
  });

  it("rejects a duplicate market externalId — the upsert would merge them", () => {
    const dataset = build();
    dataset.events[2].markets[0].externalId =
      dataset.events[0].markets[0].externalId;
    assert.throws(() => validateDataset(dataset), /already used/);
  });

  it("rejects a duplicate market slug — pairs resolve by slug", () => {
    const dataset = build();
    dataset.events[2].markets[0].slug = dataset.events[0].markets[0].slug;
    assert.throws(() => validateDataset(dataset), /pairs resolve by slug/);
  });

  it("rejects a duplicate event externalId", () => {
    const dataset = build();
    dataset.events[1].externalId = dataset.events[0].externalId;
    assert.throws(
      () => validateDataset(dataset),
      /would upsert into a single row/,
    );
  });

  it("rejects an unparseable date", () => {
    const dataset = build();
    dataset.events[0].markets[0].endDate = "next tuesday";
    assert.throws(() => validateDataset(dataset), /not a parseable date/);
  });

  it("reports every error at once, not just the first", () => {
    const dataset = build();
    delete dataset.events[0].markets[0].negatedQuestion;
    delete dataset.events[1].markets[1].negatedQuestion;
    dataset.events[2].markets[0].question = "";
    assert.throws(
      () => validateDataset(dataset),
      /failed validation with 3 error\(s\)/,
    );
  });

  it("surfaces an unresolvable pair", () => {
    assert.throws(
      () => validateDataset(build([["mk-0", "nope"]])),
      /no market in this dataset has slug "nope"/,
    );
  });

  it("warns, rather than fails, on a missing research blob", () => {
    const dataset = build();
    delete dataset.events[0].research;
    const result = validateDataset(dataset);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /no research blob/);
  });
});
