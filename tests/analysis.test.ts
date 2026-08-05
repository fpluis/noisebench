import test from "node:test";
import assert from "node:assert/strict";
import {
  CHANCE_CONSISTENCY,
  CONSISTENCY_COMPONENTS,
  DirectObservation,
  PairwiseObservation,
  buildPanel,
  consistencyScores,
  crossModalAgreement,
  decompose,
  expectedChoice,
  logit,
  negationGaps,
  pairwiseConsistency,
  reliability,
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

// ---------------------------------------------------------------------------
// Pairwise + consistency
// ---------------------------------------------------------------------------

const pw = (
  overrides: Partial<PairwiseObservation> = {},
): PairwiseObservation => ({
  model: "m",
  marketAId: 1,
  marketBId: 2,
  isANegated: false,
  isBNegated: false,
  iteration: 0,
  isALikelier: true,
  ...overrides,
});

// All four combinations for one pair/iteration, given the two facts they probe.
const quad = (
  aBeatsB: boolean,
  sumOverOne: boolean,
  iteration = 0,
  model = "m",
): PairwiseObservation[] => [
  pw({
    model,
    iteration,
    isANegated: false,
    isBNegated: false,
    isALikelier: aBeatsB,
  }),
  pw({
    model,
    iteration,
    isANegated: true,
    isBNegated: true,
    isALikelier: !aBeatsB,
  }),
  pw({
    model,
    iteration,
    isANegated: false,
    isBNegated: true,
    isALikelier: sumOverOne,
  }),
  pw({
    model,
    iteration,
    isANegated: true,
    isBNegated: false,
    isALikelier: !sumOverOne,
  }),
];

test("expectedChoice decodes what each phrasing combination asks", () => {
  // A = 0.9, B = 0.4: A beats B, and they sum past 1.
  assert.equal(expectedChoice("00", 0.9, 0.4), true);
  assert.equal(expectedChoice("11", 0.9, 0.4), false);
  assert.equal(expectedChoice("01", 0.9, 0.4), true);
  assert.equal(expectedChoice("10", 0.9, 0.4), false);
  // A = 0.4, B = 0.1: A beats B, but they do NOT sum past 1 — the case the
  // research brief mistook for a contradiction. Both are perfectly coherent.
  assert.equal(expectedChoice("00", 0.4, 0.1), true);
  assert.equal(expectedChoice("01", 0.4, 0.1), false);
});

test("a fully coherent quadruple scores 100% pairwise negation coherence", () => {
  for (const aBeatsB of [true, false]) {
    for (const sumOverOne of [true, false]) {
      const [row] = pairwiseConsistency(quad(aBeatsB, sumOverOne));
      assert.equal(row.negationCoherence, 1, `${aBeatsB}/${sumOverOne}`);
      assert.equal(row.coherenceN, 2);
    }
  }
});

test("a model stuck on one side scores 0 coherence but perfect repeats", () => {
  const stuck = [
    ...quad(true, true).map((o) => ({ ...o, isALikelier: true })),
    ...quad(true, true, 1).map((o) => ({ ...o, isALikelier: true })),
  ];
  const [row] = pairwiseConsistency(stuck);
  assert.equal(row.repeatAgreement, 1);
  assert.equal(row.negationCoherence, 0);
  // The guard that stops the perfect repeat rate being read as consistency.
  assert.equal(row.aRate, 1);
});

test("pairwise repeat agreement counts every pair of repetitions", () => {
  const rows = [
    pw({ iteration: 0, isALikelier: true }),
    pw({ iteration: 1, isALikelier: false }),
    pw({ iteration: 2, isALikelier: true }),
  ];
  const [row] = pairwiseConsistency(rows);
  // 3 comparisons among 3 repetitions; only 0-vs-2 agrees.
  assert.equal(row.repeatN, 3);
  assert.ok(Math.abs(row.repeatAgreement - 1 / 3) < 1e-12);
});

test("cross-modal agreement is 100% when picks follow the model's own odds", () => {
  // Market 1 at 0.80, market 2 at 0.30: A beats B, and they sum past 1.
  const direct: DirectObservation[] = [
    {
      model: "m",
      marketId: 1,
      isNegated: false,
      iteration: 0,
      parsedOdds: 0.8,
    },
    { model: "m", marketId: 1, isNegated: true, iteration: 0, parsedOdds: 0.2 },
    {
      model: "m",
      marketId: 2,
      isNegated: false,
      iteration: 0,
      parsedOdds: 0.3,
    },
    { model: "m", marketId: 2, isNegated: true, iteration: 0, parsedOdds: 0.7 },
  ];
  const [row] = crossModalAgreement(direct, quad(true, true));
  assert.equal(row.agreement, 1);
  assert.equal(row.rank, 1);
  assert.equal(row.sum, 1);
});

test("cross-modal agreement is 0 when every pick contradicts its own odds", () => {
  const direct: DirectObservation[] = [
    {
      model: "m",
      marketId: 1,
      isNegated: false,
      iteration: 0,
      parsedOdds: 0.8,
    },
    {
      model: "m",
      marketId: 2,
      isNegated: false,
      iteration: 0,
      parsedOdds: 0.3,
    },
  ];
  const [row] = crossModalAgreement(direct, quad(false, false));
  assert.equal(row.agreement, 0);
});

test("reliability is high for a repeatable model and low for a drifting one", () => {
  const build = (noise: number, seed: number): DirectObservation[] => {
    const normal = makeNormal(seed);
    const out: DirectObservation[] = [];
    for (let j = 0; j < 30; j += 1) {
      const truth = 0.1 + (j / 30) * 0.8;
      for (const isNegated of [false, true]) {
        for (let r = 0; r < 4; r += 1) {
          const yes = truth + normal() * noise;
          out.push({
            model: "m",
            marketId: j,
            isNegated,
            iteration: r,
            parsedOdds: isNegated ? 1 - yes : yes,
          });
        }
      }
    }
    return out;
  };
  const [tight] = reliability(build(0.01, 5));
  const [loose] = reliability(build(0.25, 5));
  assert.ok(tight.reliability > 0.95, `tight ${tight.reliability}`);
  // Drift of 0.25 against a true spread of ~0.23 puts roughly half the variance
  // in the noise, which is what a ratio should report — not zero.
  assert.ok(loose.reliability < 0.55, `loose ${loose.reliability}`);
  assert.ok(
    tight.reliability - loose.reliability > 0.4,
    `separation ${tight.reliability - loose.reliability}`,
  );
});

test("a perfectly consistent model scores 1 on every component", () => {
  const direct: DirectObservation[] = [];
  for (let j = 1; j <= 20; j += 1) {
    const yes = j / 21;
    for (const isNegated of [false, true]) {
      for (let r = 0; r < 4; r += 1) {
        direct.push({
          model: "m",
          marketId: j,
          isNegated,
          iteration: r,
          parsedOdds: isNegated ? 1 - yes : yes,
        });
      }
    }
  }
  // Pair market 1 (1/21) against market 15 (15/21), answered coherently both
  // times: B beats A, and the two sum to 16/21, short of 1.
  //
  // Deliberately NOT market 20, which would sum to exactly 1.0 — there
  // "P(A)+P(B) > 1" and "P(A)+P(B) < 1" are both false, so no quadruple can
  // satisfy the couple identity and a perfect model would still score 0.75.
  const pairs: PairwiseObservation[] = [];
  for (let it = 0; it < 2; it += 1) {
    pairs.push(
      ...quad(false, false, it).map((o) => ({
        ...o,
        marketAId: 1,
        marketBId: 15,
      })),
    );
  }
  const [score] = consistencyScores(direct, pairs);
  assert.ok(score.reliability > 0.99, `reliability ${score.reliability}`);
  assert.equal(score.negationCoherence, 1);
  assert.equal(score.pairRepeat, 1);
  assert.equal(score.pairNegation, 1);
  assert.equal(score.selfAgreement, 1);
  assert.ok(score.consistency > 0.99);
});

test("CHANCE_CONSISTENCY is the average of the components' own baselines", () => {
  assert.equal(CONSISTENCY_COMPONENTS.length, 5);
  const expected = (0 + 2 / 3 + 0.5 + 0.5 + 0.5) / 5;
  assert.ok(Math.abs(CHANCE_CONSISTENCY - expected) < 1e-12);
  // The floor a coin-flipping forecaster sits at — worth being ~0.43, not 0.
  assert.ok(CHANCE_CONSISTENCY > 0.4 && CHANCE_CONSISTENCY < 0.45);
});
