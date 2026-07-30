// The pairwise modality: dataset loading, pair resolution, prompt construction,
// task identity, and the logical identity the whole modality is built on.
//
// The direct side has one invariant that makes it a noise measurement rather
// than an accuracy judgment (`Yes + No ≈ 1`). The pairwise side has one too,
// and it is exact: flipping BOTH sides of a comparison must invert it. These
// tests pin that identity, and pin the encoding that carries it on-chain.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  complementaryCombination,
  loadDataset,
  outcomeForPhrasing,
  resolvePairs,
} from "../src/utils";
import { buildPairwiseUserPrompt, PAIRWISE_SYSTEM_PROMPT } from "../src/llm";
import { pairwiseTaskKey } from "../src/db";
import {
  Dataset,
  PAIRWISE_COMBINATIONS,
  PairwiseCombination,
} from "../src/types";
import { toPairwiseTuple } from "../src/forecast-registry-abi";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const eventA = {
  externalId: "e1",
  title: "Taiwan",
  slug: "taiwan",
  description: "event A rules",
  research: "RESEARCH A",
  markets: [
    {
      externalId: "m1",
      slug: "will-china-invade-taiwan-by-september-30-2026",
      question: "Will China invade Taiwan by September 30, 2026?",
      negatedQuestion:
        "Will China fail to invade Taiwan by September 30, 2026?",
      description: "market A rules",
      startDate: "2026-01-01T00:00:00.000Z",
      endDate: "2026-09-30T00:00:00.000Z",
    },
  ],
};

const eventB = {
  externalId: "e2",
  title: "Anthropic",
  slug: "anthropic",
  description: "event B rules",
  research: "RESEARCH B",
  markets: [
    {
      externalId: "m2",
      slug: "will-anthropic-ipo-by-september-15-2026-415",
      question: "Will Anthropic IPO by September 15, 2026?",
      negatedQuestion: "Will Anthropic fail to IPO by September 15, 2026?",
      description: "market B rules",
    },
  ],
};

const dataset: Dataset = {
  events: [eventA, eventB],
  pairs: [[eventA.markets[0].slug, eventB.markets[0].slug]],
};

/** Write a dataset file to a temp dir and return its path. */
const writeDataset = (contents: unknown): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noisebench-"));
  const file = path.join(dir, "dataset.json");
  fs.writeFileSync(file, JSON.stringify(contents), "utf8");
  return file;
};

// ---------------------------------------------------------------------------
// The identity the modality rests on
// ---------------------------------------------------------------------------

test("the four combinations form two complementary couples", () => {
  // Every combination's complement is also in the set, and no combination is
  // its own complement — so the four split cleanly into two couples that must
  // disagree. If a combination were ever dropped from the list, its partner
  // would be left with nothing to be checked against and check G in
  // verify-run.ts would silently measure nothing.
  assert.equal(PAIRWISE_COMBINATIONS.length, 4);

  const key = (c: PairwiseCombination) =>
    `${c.isANegated ? 1 : 0}${c.isBNegated ? 1 : 0}`;
  const present = new Set(PAIRWISE_COMBINATIONS.map(key));
  assert.deepEqual(Array.from(present).sort(), ["00", "01", "10", "11"]);

  for (const combination of PAIRWISE_COMBINATIONS) {
    const complement = complementaryCombination(combination);
    assert.ok(
      present.has(key(complement)),
      `${key(combination)} has no complement in the set`,
    );
    assert.notEqual(key(complement), key(combination));
  }
});

test("complementing twice is the identity", () => {
  for (const combination of PAIRWISE_COMBINATIONS) {
    assert.deepEqual(
      complementaryCombination(complementaryCombination(combination)),
      combination,
    );
  }
});

test("a coherent forecaster's answers invert under double negation", () => {
  // The property in full, simulated over a grid of beliefs: for any P(A), P(B),
  // the side judged likelier under (x, y) is the OTHER side under (¬x, ¬y).
  // This is what makes the violation rate a noise measurement — it holds
  // whatever the model believes, so no ground truth is needed to score it.
  const decide = (
    pA: number,
    pB: number,
    combination: PairwiseCombination,
  ): boolean => {
    const sideA = combination.isANegated ? 1 - pA : pA;
    const sideB = combination.isBNegated ? 1 - pB : pB;
    return sideA > sideB;
  };

  for (let a = 5; a < 100; a += 7) {
    for (let b = 3; b < 100; b += 11) {
      const pA = a / 100;
      const pB = b / 100;
      if (pA === pB || pA + pB === 1) continue; // genuine ties: no correct answer
      for (const combination of PAIRWISE_COMBINATIONS) {
        assert.notEqual(
          decide(pA, pB, combination),
          decide(pA, pB, complementaryCombination(combination)),
          `P(A)=${pA} P(B)=${pB} did not invert under double negation`,
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// On-chain encoding
// ---------------------------------------------------------------------------

test("a negated side is published as that market's No", () => {
  // The same mapping the direct path uses, and the same one the prompt states:
  // a negated side IS that market resolving "No". Prompt, DB row and on-chain
  // record all go through outcomeForPhrasing so they can never disagree about
  // which side of a market a judgment refers to.
  assert.equal(outcomeForPhrasing(false), "Yes");
  assert.equal(outcomeForPhrasing(true), "No");
});

test("toPairwiseTuple lays the fields out in the contract's order", () => {
  // ethers encodes a tuple positionally, so swapping two same-typed neighbours
  // still encodes cleanly and publishes a judgment about something else. This
  // is the test that would catch that.
  assert.deepEqual(
    toPairwiseTuple({
      pairwiseForecastId: 7,
      forecasterName: "model-x",
      platformIdA: 1,
      marketAId: "m1",
      marketAOutcome: "Yes",
      platformIdB: 2,
      marketBId: "m2",
      marketBOutcome: "No",
      isALikelier: true,
    }),
    [1, "m1", "Yes", 2, "m2", "No", true],
  );
});

// ---------------------------------------------------------------------------
// Task identity (--resume)
// ---------------------------------------------------------------------------

test("pairwiseTaskKey uniquely identifies one unit of work", () => {
  const base = pairwiseTaskKey(1, 10, 20, false, false, 0);
  // Each dimension must move the key.
  assert.notEqual(base, pairwiseTaskKey(2, 10, 20, false, false, 0));
  assert.notEqual(base, pairwiseTaskKey(1, 10, 20, true, false, 0));
  assert.notEqual(base, pairwiseTaskKey(1, 10, 20, false, true, 0));
  assert.notEqual(base, pairwiseTaskKey(1, 10, 20, false, false, 1));
  // The two single-negation combinations must not collide with each other —
  // they are the couple check G compares, so a collision would make half the
  // pairwise noise metric disappear.
  assert.notEqual(
    pairwiseTaskKey(1, 10, 20, true, false, 0),
    pairwiseTaskKey(1, 10, 20, false, true, 0),
  );
  // The reversed pair is a different task, not the same one.
  assert.notEqual(base, pairwiseTaskKey(1, 20, 10, false, false, 0));
});

// ---------------------------------------------------------------------------
// Dataset loading
// ---------------------------------------------------------------------------

test("loads the { events, pairs } shape", () => {
  const loaded = loadDataset(writeDataset(dataset));
  assert.equal(loaded.events.length, 2);
  assert.deepEqual(loaded.pairs, [
    [
      "will-china-invade-taiwan-by-september-30-2026",
      "will-anthropic-ipo-by-september-15-2026-415",
    ],
  ]);
});

test("a bare array of events is rejected", () => {
  // The pre-pairwise shape. Accepting it would load as a dataset with no pairs
  // and run a benchmark that silently skips the pairwise modality entirely.
  assert.throws(
    () => loadDataset(writeDataset([eventA, eventB])),
    /must be a JSON object/,
  );
});

test("a dataset missing either key is rejected", () => {
  assert.throws(
    () => loadDataset(writeDataset({ pairs: [] })),
    /must have an "events" array/,
  );
  // An absent `pairs` is an authoring slip, not a direct-only run — that is
  // spelled `"pairs": []`.
  assert.throws(
    () => loadDataset(writeDataset({ events: [eventA] })),
    /must have a "pairs" array/,
  );
  assert.throws(
    () => loadDataset(writeDataset("nope")),
    /must be a JSON object/,
  );
});

test("an empty pairs array is a valid direct-only dataset", () => {
  const loaded = loadDataset(writeDataset({ events: [eventA], pairs: [] }));
  assert.equal(loaded.events.length, 1);
  assert.deepEqual(loaded.pairs, []);
});

test("a malformed pair is rejected at load", () => {
  const bad = [
    { pairs: [["only-one"]] },
    { pairs: [["a", "b", "c"]] },
    { pairs: [["a", 2]] },
    { pairs: [["a", ""]] },
    { pairs: ["a b"] },
  ];
  for (const pairs of bad) {
    assert.throws(
      () => loadDataset(writeDataset({ events: [], ...pairs })),
      /must be a \[slugA, slugB\] tuple/,
      `${JSON.stringify(pairs)} should have been rejected`,
    );
  }
  assert.throws(
    () => loadDataset(writeDataset({ events: [], pairs: "nope" })),
    /must have a "pairs" array/,
  );
});

// ---------------------------------------------------------------------------
// Pair resolution — every failure here is fatal on purpose
// ---------------------------------------------------------------------------

test("resolvePairs maps slugs to their markets and events", () => {
  const [pair] = resolvePairs(dataset);
  assert.equal(pair.marketA.externalId, "m1");
  assert.equal(pair.eventA.externalId, "e1");
  assert.equal(pair.marketB.externalId, "m2");
  assert.equal(pair.eventB.externalId, "e2");
});

test("an unknown slug fails the run rather than being skipped", () => {
  assert.throws(
    () =>
      resolvePairs({ events: dataset.events, pairs: [["ghost", "m2-slug"]] }),
    /no market in this dataset has slug "ghost"/,
  );
});

test("a market compared against itself is rejected before it reaches the chain", () => {
  // The contract reverts with IdenticalMarkets, which would take down the whole
  // batch the judgment was submitted in.
  const slug = eventA.markets[0].slug;
  assert.throws(
    () => resolvePairs({ events: dataset.events, pairs: [[slug, slug]] }),
    /cannot be compared against itself/,
  );
});

test("a duplicated pair is rejected", () => {
  // Two identical pairs collide on the run's unique key, so the second would
  // overwrite the first and the run would silently produce fewer rows than the
  // completeness check expects.
  const pair = dataset.pairs[0];
  assert.throws(
    () => resolvePairs({ events: dataset.events, pairs: [pair, [...pair]] }),
    /duplicate pair/,
  );
});

test("the REVERSED pair is allowed — it is the only position-bias probe", () => {
  // All four combinations present market A first, so [B, A] is genuinely
  // different work rather than a duplicate.
  const [a, b] = dataset.pairs[0];
  const resolved = resolvePairs({
    events: dataset.events,
    pairs: [
      [a, b],
      [b, a],
    ],
  });
  assert.equal(resolved.length, 2);
  assert.equal(resolved[0].marketA.externalId, "m1");
  assert.equal(resolved[1].marketA.externalId, "m2");
});

test("an ambiguous slug is rejected rather than resolved arbitrarily", () => {
  // Slugs are the only handle a pair has, so a slug used twice has no correct
  // resolution — picking either market would publish a judgment about a market
  // the dataset author did not name.
  const duplicated = {
    ...eventB,
    externalId: "e3",
    slug: "other",
    markets: [{ ...eventB.markets[0], externalId: "m3" }],
  };
  assert.throws(
    () =>
      resolvePairs({
        events: [eventA, eventB, duplicated],
        pairs: dataset.pairs,
      }),
    /is used by more than one market/,
  );
});

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

test("the pairwise prompt never rewrites a question — it names the outcome", () => {
  // The bug this replaces: the negated side substituted `negatedQuestion` while
  // the rules beside it still described the "Yes" outcome, so the prompt
  // contradicted itself and the model was scored on resolving that.
  const [pair] = resolvePairs(dataset);
  const combos = PAIRWISE_COMBINATIONS.map((c) =>
    buildPairwiseUserPrompt(pair, c),
  );

  for (const prompt of combos) {
    // Both markets are always presented in their own words, whichever outcome
    // each side is asked about.
    assert.ok(
      prompt.includes("Will China invade Taiwan by September 30, 2026?"),
    );
    assert.ok(prompt.includes("Will Anthropic IPO by September 15, 2026?"));
    // And the rewritten questions never appear anywhere.
    assert.ok(!prompt.includes("fail to invade"));
    assert.ok(!prompt.includes("fail to IPO"));
  }
});

test("only the requested outcomes differ between the four combinations", () => {
  // The identity that flipping both sides inverts the answer holds only if the
  // sides differ in the requested outcome and in NOTHING else. Strip the two
  // outcome declarations and the timestamp, and all four prompts must be the
  // same bytes.
  const [pair] = resolvePairs(dataset);
  const strip = (prompt: string): string =>
    prompt
      .replace(/the market below resolving to "(Yes|No)"/g, "OUTCOME")
      .replace(/this market resolving to "(Yes|No)"/g, "OUTCOME")
      .replace(/Current timestamp: \S+/, "TIMESTAMP");

  const stripped = PAIRWISE_COMBINATIONS.map((c) =>
    strip(buildPairwiseUserPrompt(pair, c)),
  );
  for (const prompt of stripped) assert.equal(prompt, stripped[0]);

  // And the declarations themselves track the combination.
  const negA = buildPairwiseUserPrompt(pair, {
    isANegated: true,
    isBNegated: false,
  });
  assert.ok(
    negA.includes('Outcome A refers to: this market resolving to "No"'),
  );
  assert.ok(
    negA.includes('Outcome B refers to: this market resolving to "Yes"'),
  );
});

test("both sides carry their own rules and research", () => {
  const [pair] = resolvePairs(dataset);
  const prompt = buildPairwiseUserPrompt(pair, {
    isANegated: false,
    isBNegated: false,
  });
  assert.ok(prompt.includes("market A rules"));
  assert.ok(prompt.includes("market B rules"));
  assert.ok(prompt.includes("RESEARCH A"));
  assert.ok(prompt.includes("RESEARCH B"));
  assert.ok(prompt.includes("Outcome A:"));
  assert.ok(prompt.includes("Outcome B:"));
});

test("a same-event pair includes its shared research only once", () => {
  // Repeating a multi-kilobyte blob pays for the tokens twice and invites the
  // model to read the duplication as emphasis.
  const sameEvent = {
    ...eventA,
    markets: [
      eventA.markets[0],
      { ...eventA.markets[0], externalId: "m1b", slug: "m1b" },
    ],
  };
  const [pair] = resolvePairs({
    events: [sameEvent],
    pairs: [[sameEvent.markets[0].slug, "m1b"]],
  });
  const prompt = buildPairwiseUserPrompt(pair, {
    isANegated: false,
    isBNegated: false,
  });
  assert.equal(prompt.split("RESEARCH A").length - 1, 1);
  assert.ok(prompt.includes("Context for both outcomes"));
});

test("the pairwise system prompt asks for a rank and refuses a tie", () => {
  // Both are load-bearing: the modality collects no probabilities, and the
  // registry has no encoding for "equally likely".
  assert.ok(PAIRWISE_SYSTEM_PROMPT.includes("More likely: A"));
  assert.ok(PAIRWISE_SYSTEM_PROMPT.includes("More likely: B"));
  assert.match(PAIRWISE_SYSTEM_PROMPT, /equally likely/);
  assert.match(PAIRWISE_SYSTEM_PROMPT, /must pick one/i);
});

test("the pairwise system prompt explains that rules are never inverted", () => {
  // Without this the "No" side is ill-posed: a model reading Yes-shaped rules
  // beside a request for "No" has to guess which of the two is authoritative,
  // and that guess is noise we injected rather than noise we measured.
  assert.match(PAIRWISE_SYSTEM_PROMPT, /never rewritten or inverted/i);
  assert.match(PAIRWISE_SYSTEM_PROMPT, /NOT resolving "Yes"/);
});
