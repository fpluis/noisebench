import test from "node:test";
import assert from "node:assert/strict";
import {
  DirectObservation,
  buildPanel,
  decompose,
  logit,
  negationGaps,
  toYes,
} from "../src/analysis";

// Deterministic normal draws, so a tolerance that passes here passes every run.
const makeRng = (seed: number) => {
  let state = seed >>> 0;
  return (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

const makeNormal = (seed: number) => {
  const rng = makeRng(seed);
  return (): number => {
    // Box-Muller; the 1e-12 floor keeps log() away from zero.
    const u = Math.max(rng(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  };
};

/**
 * Build a panel with known variance components on the Yes scale, then invert
 * the fold so `decompose` has to undo it: a base row stores the Yes value
 * directly, a negated row stores its complement.
 */
const syntheticPanel = (opts: {
  nModels: number;
  nMarkets: number;
  iterations: number;
  level: (i: number) => number;
  difficulty: (j: number) => number;
  phrasing: number;
  pattern: (i: number, j: number) => number;
  occasionSd: number;
  seed: number;
}): DirectObservation[] => {
  const normal = makeNormal(opts.seed);
  const out: DirectObservation[] = [];
  for (let i = 0; i < opts.nModels; i += 1) {
    for (let j = 0; j < opts.nMarkets; j += 1) {
      for (const isNegated of [false, true]) {
        for (let r = 0; r < opts.iterations; r += 1) {
          const pYes =
            0.5 +
            opts.level(i) +
            opts.difficulty(j) +
            (isNegated ? -opts.phrasing / 2 : opts.phrasing / 2) +
            opts.pattern(i, j) +
            normal() * opts.occasionSd;
          out.push({
            model: `m${i}`,
            marketId: j,
            isNegated,
            iteration: r,
            parsedOdds: isNegated ? 1 - pYes : pYes,
          });
        }
      }
    }
  }
  return out;
};

test("toYes folds a negated forecast onto the market's Yes scale", () => {
  const base: DirectObservation = {
    model: "m",
    marketId: 1,
    isNegated: false,
    iteration: 0,
    parsedOdds: 0.93,
  };
  assert.equal(toYes(base), 0.93);
  // The model said 5% to "will X fail", which is 95% on the market's Yes side.
  assert.ok(
    Math.abs(toYes({ ...base, isNegated: true, parsedOdds: 0.05 }) - 0.95) <
      1e-12,
  );
});

test("logit clips the tails rather than diverging", () => {
  assert.ok(Number.isFinite(logit(0)));
  assert.ok(Number.isFinite(logit(1)));
  assert.equal(logit(0.5), 0);
  assert.ok(logit(0.0001) === logit(0.001));
});

test("a noiseless coherent panel has zero noise on every term", () => {
  const observations = syntheticPanel({
    nModels: 6,
    nMarkets: 20,
    iterations: 4,
    level: () => 0,
    difficulty: (j) => (j - 10) * 0.01,
    phrasing: 0,
    pattern: () => 0,
    occasionSd: 0,
    seed: 1,
  });
  const d = decompose(observations, "probability");
  assert.ok(d.level < 1e-9, `level ${d.level}`);
  assert.ok(d.stablePattern.corrected < 1e-9);
  assert.ok(d.occasion < 1e-9);
  assert.ok(Math.abs(d.phrasingEffect) < 1e-9);
  // Market differences are signal and must survive.
  assert.ok(d.caseSpread > 0.05);
});

test("decompose recovers known level, pattern, occasion and phrasing terms", () => {
  const level = (i: number) => (i - 4.5) * 0.02; // sd over 10 models ~ 0.0603
  const pattern = (i: number, j: number) =>
    (((i * 7 + j * 13) % 11) - 5) * 0.01; // rms ~ 0.0317
  const observations = syntheticPanel({
    nModels: 10,
    nMarkets: 60,
    iterations: 4,
    level,
    difficulty: (j) => ((j % 9) - 4) * 0.02,
    phrasing: 0.08,
    pattern,
    occasionSd: 0.05,
    seed: 42,
  });
  const d = decompose(observations, "probability");

  const trueLevel = Math.sqrt(
    Array.from({ length: 10 }, (_, i) => level(i) ** 2).reduce(
      (s, x) => s + x,
      0,
    ) / 9,
  );
  const patternValues: number[] = [];
  for (let i = 0; i < 10; i += 1)
    for (let j = 0; j < 60; j += 1) patternValues.push(pattern(i, j));
  const truePattern = Math.sqrt(
    patternValues.reduce((s, x) => s + x * x, 0) / patternValues.length,
  );

  assert.ok(
    Math.abs(d.level - trueLevel) / trueLevel < 0.15,
    `level ${d.level} vs ${trueLevel}`,
  );
  assert.ok(
    Math.abs(d.stablePattern.corrected - truePattern) / truePattern < 0.15,
    `pattern ${d.stablePattern.corrected} vs ${truePattern}`,
  );
  assert.ok(
    Math.abs(d.occasion - 0.05) / 0.05 < 0.1,
    `occasion ${d.occasion} vs 0.05`,
  );
  assert.ok(
    Math.abs(d.phrasingEffect - 0.08) < 0.01,
    `phrasing ${d.phrasingEffect} vs 0.08`,
  );
});

test("stable pattern noise is not inflated by occasion noise alone", () => {
  // No true model x market interaction, but heavy repetition noise. The raw
  // interaction spread must be visibly positive and the corrected one near
  // zero: this is the whole reason the correction exists.
  const observations = syntheticPanel({
    nModels: 10,
    nMarkets: 60,
    iterations: 4,
    level: (i) => (i - 4.5) * 0.02,
    difficulty: (j) => ((j % 9) - 4) * 0.02,
    phrasing: 0,
    pattern: () => 0,
    occasionSd: 0.12,
    seed: 7,
  });
  const d = decompose(observations, "probability");
  assert.ok(d.stablePattern.raw > 0.03, `raw ${d.stablePattern.raw}`);
  assert.ok(
    d.stablePattern.corrected < 0.015,
    `corrected ${d.stablePattern.corrected} should be ~0`,
  );
});

test("buildPanel drops markets where any model x phrasing cell is empty", () => {
  const observations = syntheticPanel({
    nModels: 3,
    nMarkets: 5,
    iterations: 2,
    level: () => 0,
    difficulty: () => 0,
    phrasing: 0,
    pattern: () => 0,
    occasionSd: 0,
    seed: 3,
  });
  // Knock out every negated observation for one model on market 2.
  const thinned = observations.filter(
    (o) => !(o.model === "m1" && o.marketId === 2 && o.isNegated),
  );
  const panel = buildPanel(thinned, "probability");
  assert.deepEqual(panel.marketIds, [0, 1, 3, 4]);
  assert.equal(panel.models.length, 3);
});

test("negationGaps measures sub-additivity from cell means", () => {
  // Asked "will X happen" the model says 6%; asked "will X fail" it says 22%.
  // Coherence needs those to sum to 1; they sum to 0.28.
  const observations: DirectObservation[] = [
    {
      model: "m",
      marketId: 1,
      isNegated: false,
      iteration: 0,
      parsedOdds: 0.05,
    },
    {
      model: "m",
      marketId: 1,
      isNegated: false,
      iteration: 1,
      parsedOdds: 0.07,
    },
    { model: "m", marketId: 1, isNegated: true, iteration: 0, parsedOdds: 0.2 },
    {
      model: "m",
      marketId: 1,
      isNegated: true,
      iteration: 1,
      parsedOdds: 0.24,
    },
  ];
  const [gap] = negationGaps(observations);
  assert.ok(Math.abs(gap.base - 0.06) < 1e-12);
  assert.ok(Math.abs(gap.negated - 0.22) < 1e-12);
  assert.ok(Math.abs(gap.gap - -0.72) < 1e-12);
  assert.ok(gap.logOddsGap < 0);
});

test("negationGaps skips a cell with only one phrasing present", () => {
  const observations: DirectObservation[] = [
    {
      model: "m",
      marketId: 1,
      isNegated: false,
      iteration: 0,
      parsedOdds: 0.5,
    },
  ];
  assert.equal(negationGaps(observations).length, 0);
});

test("phrasingEffect agrees with the independent negationGaps path", () => {
  const observations = syntheticPanel({
    nModels: 8,
    nMarkets: 30,
    iterations: 4,
    level: (i) => (i - 3.5) * 0.01,
    difficulty: (j) => ((j % 7) - 3) * 0.02,
    phrasing: 0.14,
    pattern: (i, j) => (((i + j) % 5) - 2) * 0.008,
    occasionSd: 0.03,
    seed: 11,
  });
  const d = decompose(observations, "probability");
  const gaps = negationGaps(observations);
  const meanGap = gaps.reduce((s, g) => s + g.gap, 0) / gaps.length;
  // decompose works on the Yes scale where the two arms are differenced;
  // negationGaps works on raw reported odds where they are summed. The same
  // quantity reaches both, so they must agree.
  assert.ok(
    Math.abs(d.phrasingEffect - meanGap) < 0.005,
    `${d.phrasingEffect} vs ${meanGap}`,
  );
});
