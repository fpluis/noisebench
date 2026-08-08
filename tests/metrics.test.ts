import test from "node:test";
import assert from "node:assert/strict";
import { DirectObservation, PairwiseObservation } from "../src/analysis";
import {
  METRIC_COMPONENTS,
  METRIC_KEYS,
  RANDOM_BASELINES,
  RANDOM_NOISE,
  averageError,
  directionBlindReference,
  individualPairDisagreement,
  mad,
  marketMetrics,
  negationDisagreement,
  negationError,
  noiseScores,
  pairwiseDisagreement,
  voteFor,
} from "../src/metrics";

// Deterministic uniform draws, so a tolerance that passes here passes every run.
const makeRng = (seed: number) => {
  let state = seed >>> 0;
  return (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

const direct = (
  model: string,
  marketId: number,
  isNegated: boolean,
  values: number[],
): DirectObservation[] =>
  values.map((parsedOdds, iteration) => ({
    model,
    marketId,
    isNegated,
    iteration,
    parsedOdds,
  }));

/** One quadruple of head-to-head judgments, keyed by wording combination. */
const quad = (
  model: string,
  marketAId: number,
  marketBId: number,
  iteration: number,
  picks: Record<string, boolean>,
): PairwiseObservation[] =>
  Object.entries(picks).map(([combo, isALikelier]) => ({
    model,
    marketAId,
    marketBId,
    isANegated: combo[0] === "1",
    isBNegated: combo[1] === "1",
    iteration,
    isALikelier,
  }));

// ---------------------------------------------------------------------------
// Average error
// ---------------------------------------------------------------------------

test("mad is the mean distance from the sample's own mean", () => {
  assert.equal(mad([0.5, 0.5, 0.5, 0.5]), 0);
  // mean 0.5, deviations 0.05/0.05/0.02/0.02 -> 0.035.
  assert.ok(Math.abs(mad([0.55, 0.45, 0.48, 0.52]) - 0.035) < 1e-12);
});

test("average error averages the per-cell MAD over cells, not over forecasts", () => {
  const observations = [
    // Cell 1: MAD 0.035.
    ...direct("m", 1, false, [0.55, 0.45, 0.48, 0.52]),
    // Cell 2: flat, MAD 0.
    ...direct("m", 1, true, [0.4, 0.4, 0.4, 0.4]),
    // Cell 3: MAD 0.1, and only two forecasts — it still counts as one cell,
    // which is the whole point of averaging cells rather than observations.
    ...direct("m", 2, false, [0.3, 0.5]),
    ...direct("m", 2, true, [0.6, 0.6]),
  ];
  const [row] = averageError(observations);
  assert.equal(row.cells, 4);
  assert.equal(row.forecasts, 12);
  assert.ok(Math.abs(row.averageError - (0.035 + 0 + 0.1 + 0) / 4) < 1e-12);
});

test("average error ignores cells with a single surviving forecast", () => {
  const observations = [
    ...direct("m", 1, false, [0.2, 0.4]),
    ...direct("m", 1, true, [0.7]),
  ];
  const [row] = averageError(observations);
  assert.equal(row.cells, 1);
  assert.equal(row.forecasts, 3);
  assert.ok(Math.abs(row.averageError - 0.1) < 1e-12);
});

test("average error is unchanged by folding the negated wording", () => {
  // Folding is p -> 1 - p, a reflection, so every distance inside a cell is
  // preserved. Two cells that are each other's mirror must score identically.
  const asked = averageError(direct("m", 1, false, [0.1, 0.2, 0.4, 0.3]));
  const mirrored = averageError(direct("m", 1, true, [0.9, 0.8, 0.6, 0.7]));
  assert.ok(Math.abs(asked[0].averageError - mirrored[0].averageError) < 1e-12);
});

// ---------------------------------------------------------------------------
// Negation error
// ---------------------------------------------------------------------------

test("negation error matches the worked example from the brief", () => {
  // avg(Yes) = 0.4875, avg(No) = 0.6 -> |0.4875 - 0.4| = 0.0875.
  const observations = [
    ...direct("m", 1, false, [0.5, 0.45, 0.48, 0.52]),
    ...direct("m", 1, true, [0.6, 0.55, 0.6, 0.65]),
  ];
  const [row] = negationError(observations);
  assert.ok(Math.abs(row.negationError - 0.0875) < 1e-12);
  // Signed drift keeps the direction the absolute error throws away.
  assert.ok(Math.abs(row.drift - 0.0875) < 1e-12);
  assert.equal(row.markets, 1);
});

test("negation error discards direction, so opposite failures do not cancel", () => {
  const observations = [
    // Yes 0.6, No 0.5 -> drift +0.1.
    ...direct("m", 1, false, [0.6]),
    ...direct("m", 1, true, [0.5]),
    // Yes 0.3, No 0.6 -> drift -0.1.
    ...direct("m", 2, false, [0.3]),
    ...direct("m", 2, true, [0.6]),
  ];
  const [row] = negationError(observations);
  assert.ok(Math.abs(row.negationError - 0.1) < 1e-12);
  assert.ok(Math.abs(row.drift) < 1e-12);
});

test("negation error skips markets answered in only one wording", () => {
  const observations = [
    ...direct("m", 1, false, [0.6]),
    ...direct("m", 1, true, [0.4]),
    ...direct("m", 2, false, [0.9]),
  ];
  const [row] = negationError(observations);
  assert.equal(row.markets, 1);
  assert.equal(row.negationError, 0);
});

// ---------------------------------------------------------------------------
// Pairwise disagreement
// ---------------------------------------------------------------------------

test("pairwise disagreement counts every unordered pair of iterations", () => {
  const rows: PairwiseObservation[] = [
    // Same wording combination, three iterations: A, A, B -> 2 of 3 flip.
    ...quad("m", 1, 2, 0, { "00": true }),
    ...quad("m", 1, 2, 1, { "00": true }),
    ...quad("m", 1, 2, 2, { "00": false }),
    // A second combination, answered the same way twice.
    ...quad("m", 1, 2, 0, { "11": true }),
    ...quad("m", 1, 2, 1, { "11": true }),
  ];
  const [row] = pairwiseDisagreement(rows);
  assert.equal(row.comparisons, 4);
  assert.equal(row.judgments, 5);
  assert.ok(Math.abs(row.pairwiseDisagreement - 0.5) < 1e-12);
});

test("a model stuck on one side scores zero disagreement but a giveaway A-rate", () => {
  const rows = [0, 1].flatMap((it) =>
    quad("m", 1, 2, it, { "00": true, "01": true, "10": true, "11": true }),
  );
  const [row] = pairwiseDisagreement(rows);
  assert.equal(row.pairwiseDisagreement, 0);
  assert.equal(row.aRate, 1);
});

// ---------------------------------------------------------------------------
// Negation disagreement
// ---------------------------------------------------------------------------

test("negation disagreement is zero for a coherent quadruple", () => {
  // P(A) > P(B) and P(A) + P(B) > 1: picks A, A, B, B across 00, 01, 10, 11.
  const rows = [0, 1].flatMap((it) =>
    quad("m", 1, 2, it, { "00": true, "01": true, "10": false, "11": false }),
  );
  const [row] = negationDisagreement(rows);
  assert.equal(row.negationDisagreement, 0);
  assert.equal(row.checks, 4);
});

test("negation disagreement catches each couple separately", () => {
  const rows = quad("m", 1, 2, 0, {
    // (A,B) and (¬A,¬B) both name A: the rank couple is violated.
    "00": true,
    "11": true,
    // (A,¬B) and (¬A,B) oppose: the sum couple is satisfied.
    "01": true,
    "10": false,
  });
  const [row] = negationDisagreement(rows);
  assert.equal(row.checks, 2);
  assert.equal(row.rankCouple, 1);
  assert.equal(row.sumCouple, 0);
  assert.ok(Math.abs(row.negationDisagreement - 0.5) < 1e-12);
});

test("a model stuck on the left option violates every couple", () => {
  const rows = [0, 1].flatMap((it) =>
    quad("m", 1, 2, it, { "00": true, "01": true, "10": true, "11": true }),
  );
  const [row] = negationDisagreement(rows);
  assert.equal(row.negationDisagreement, 1);
});

test("negation disagreement needs both halves of a couple present", () => {
  const rows = quad("m", 1, 2, 0, { "00": true, "01": true });
  const [row] = negationDisagreement(rows);
  assert.equal(row.checks, 0);
  assert.equal(row.negationDisagreement, 0);
});

// ---------------------------------------------------------------------------
// Individual-pair disagreement
// ---------------------------------------------------------------------------

test("a vote goes to the market whose own side was preferred", () => {
  const one = (combo: string, isALikelier: boolean) =>
    voteFor(quad("m", 1, 2, 0, { [combo]: isALikelier })[0]);
  // Picking a side as worded votes for its market.
  assert.equal(one("00", true), "A");
  assert.equal(one("00", false), "B");
  // Picking a negated side votes against its market.
  assert.equal(one("11", true), "B");
  assert.equal(one("11", false), "A");
  // The sum wordings carry no ranking information: each votes one way whatever
  // is picked, so a balanced run cancels them.
  assert.equal(one("01", true), "A");
  assert.equal(one("01", false), "A");
  assert.equal(one("10", true), "B");
  assert.equal(one("10", false), "B");
});

test("individual-pair disagreement reproduces the worked example", () => {
  // (A,B) = [A,A], (¬A,B) = [B,B], (A,¬B) = [A,B], (¬A,¬B) = [A,B].
  // Votes: A five times, B three -> the majority names A.
  const pairwise: PairwiseObservation[] = [
    ...quad("m", 1, 2, 0, { "00": true, "10": false, "01": true, "11": true }),
    ...quad("m", 1, 2, 1, {
      "00": true,
      "10": false,
      "01": false,
      "11": false,
    }),
  ];
  // Direct forecasts that also make A likelier: no disagreement.
  const agreeing = [
    ...direct("m", 1, false, [0.6]),
    ...direct("m", 1, true, [0.4]),
    ...direct("m", 2, false, [0.2]),
    ...direct("m", 2, true, [0.8]),
  ];
  const [agree] = individualPairDisagreement(agreeing, pairwise);
  assert.equal(agree.pairs, 1);
  assert.equal(agree.ties, 0);
  assert.equal(agree.individualPairDisagreement, 0);

  // Flip only the probabilities: same votes, now contradicted.
  const conflicting = [
    ...direct("m", 1, false, [0.2]),
    ...direct("m", 1, true, [0.8]),
    ...direct("m", 2, false, [0.6]),
    ...direct("m", 2, true, [0.4]),
  ];
  const [conflict] = individualPairDisagreement(conflicting, pairwise);
  assert.equal(conflict.individualPairDisagreement, 1);
});

test("an even vote split counts as half a disagreement", () => {
  const pairwise = quad("m", 1, 2, 0, {
    "00": true,
    "11": true,
    "01": true,
    "10": true,
  });
  const observations = [
    ...direct("m", 1, false, [0.6]),
    ...direct("m", 1, true, [0.4]),
    ...direct("m", 2, false, [0.2]),
    ...direct("m", 2, true, [0.8]),
  ];
  const [row] = individualPairDisagreement(observations, pairwise);
  assert.equal(row.ties, 1);
  assert.equal(row.indistinguishable, 0);
  assert.equal(row.individualPairDisagreement, 0.5);
});

test("a pair the model rates identically leaves the denominator", () => {
  // Both markets average 0.40, so the head-to-head pick was forced by the
  // prompt rather than by a belief and there is nothing to score it against.
  const observations = [
    ...direct("m", 1, false, [0.3]),
    ...direct("m", 1, true, [0.5]),
    ...direct("m", 2, false, [0.5]),
    ...direct("m", 2, true, [0.7]),
  ];
  const pairwise = quad("m", 1, 2, 0, {
    "00": true,
    "11": true,
    "01": true,
    "10": true,
  });
  const [row] = individualPairDisagreement(observations, pairwise);
  assert.equal(row.pairs, 0);
  assert.equal(row.ties, 0);
  assert.equal(row.indistinguishable, 1);
  // No scorable pair, so the rate is the empty-denominator zero, not 0.5.
  assert.equal(row.individualPairDisagreement, 0);
});

test("a belief tie surviving only as float noise is still dropped", () => {
  // Both markets are 0.05 every time, but mean([0.05, 0.05]) and
  // mean([0.05, 1 - 0.95]) are different floats. Exact equality would have
  // scored this pair; INDIFFERENT catches it.
  const observations = [
    ...direct("m", 1, false, [0.05]),
    ...direct("m", 1, true, [0.95]),
    ...direct("m", 2, false, [0.05, 0.05]),
    ...direct("m", 2, true, [0.95, 0.95]),
  ];
  const pA = 0.05;
  const pB = (0.05 + (1 - 0.95)) / 2;
  assert.notEqual(pA, pB, "the fixture must actually differ in the last bits");
  assert.ok(Math.abs(pA - pB) < 1e-15);

  const pairwise = quad("m", 1, 2, 0, { "00": true, "11": true });
  const [row] = individualPairDisagreement(observations, pairwise);
  assert.equal(row.pairs, 0);
  assert.equal(row.indistinguishable, 1);
});

test("the folded belief averages both wordings, not just the Yes arm", () => {
  // Yes arm alone would call B likelier (0.30 < 0.35); folding the No arm in
  // reverses it (A: mean(0.30, 0.50) = 0.40 against B: 0.35).
  const observations = [
    ...direct("m", 1, false, [0.3]),
    ...direct("m", 1, true, [0.5]),
    ...direct("m", 2, false, [0.35]),
    ...direct("m", 2, true, [0.65]),
  ];
  const pairwise = quad("m", 1, 2, 0, { "00": true, "11": false });
  const [row] = individualPairDisagreement(observations, pairwise);
  assert.equal(row.individualPairDisagreement, 0);
});

// ---------------------------------------------------------------------------
// Composite and baselines
// ---------------------------------------------------------------------------

test("a perfectly self-consistent model scores zero on all five", () => {
  const observations = [1, 2].flatMap((marketId) => [
    ...direct("m", marketId, false, [0.2 * marketId, 0.2 * marketId]),
    ...direct("m", marketId, true, [1 - 0.2 * marketId, 1 - 0.2 * marketId]),
  ]);
  // Believes A = 0.2, B = 0.4, so B is likelier and the pair sums below 1.
  const pairwise = [0, 1].flatMap((it) =>
    quad("m", 1, 2, it, {
      "00": false,
      "11": true,
      "01": false,
      "10": true,
    }),
  );
  const [score] = noiseScores(observations, pairwise);
  for (const key of METRIC_KEYS) assert.ok(score[key] < 1e-12, key);
  assert.ok(score.noise < 1e-12);
});

test("the composite is the unweighted mean of the five components", () => {
  const observations = [
    ...direct("m", 1, false, [0.5, 0.45, 0.48, 0.52]),
    ...direct("m", 1, true, [0.6, 0.55, 0.6, 0.65]),
    ...direct("m", 2, false, [0.1, 0.2, 0.15, 0.15]),
    ...direct("m", 2, true, [0.7, 0.8, 0.75, 0.75]),
  ];
  const pairwise = [0, 1].flatMap((it) =>
    quad("m", 1, 2, it, {
      "00": true,
      "01": true,
      "10": false,
      "11": it === 0,
    }),
  );
  const [score] = noiseScores(observations, pairwise);
  const expected =
    METRIC_KEYS.reduce((s, k) => s + score[k], 0) / METRIC_KEYS.length;
  assert.ok(Math.abs(score.noise - expected) < 1e-12);
});

test("the random-answering baselines are what random answering produces", () => {
  const rng = makeRng(20260730);
  const draws = 200_000;

  let madSum = 0;
  let negSum = 0;
  for (let t = 0; t < draws; t += 1) {
    const yes = [rng(), rng(), rng(), rng()];
    const no = [rng(), rng(), rng(), rng()];
    madSum += mad(yes);
    const avgYes = yes.reduce((s, x) => s + x, 0) / 4;
    const avgNo = no.reduce((s, x) => s + x, 0) / 4;
    negSum += Math.abs(avgYes - (1 - avgNo));
  }

  // 2e5 draws puts the standard error near 2e-4; 3e-3 is comfortable.
  assert.ok(
    Math.abs(madSum / draws - RANDOM_BASELINES.averageError) < 3e-3,
    `average error baseline: ${madSum / draws} vs ${RANDOM_BASELINES.averageError}`,
  );
  assert.ok(
    Math.abs(negSum / draws - RANDOM_BASELINES.negationError) < 3e-3,
    `negation error baseline: ${negSum / draws} vs ${RANDOM_BASELINES.negationError}`,
  );

  // The closed forms the site quotes.
  assert.equal(RANDOM_BASELINES.averageError, 5 / 24);
  assert.equal(RANDOM_BASELINES.negationError, 59 / 360);
});

test("coin-flipping head-to-head picks land on the 50% baselines", () => {
  const rng = makeRng(4242);
  const pairwise: PairwiseObservation[] = [];
  const observations: DirectObservation[] = [];
  for (let pair = 0; pair < 400; pair += 1) {
    const a = 2 * pair;
    const b = 2 * pair + 1;
    for (const marketId of [a, b]) {
      const p = rng();
      observations.push(
        ...direct("m", marketId, false, [p]),
        ...direct("m", marketId, true, [1 - p]),
      );
    }
    for (let it = 0; it < 2; it += 1) {
      pairwise.push(
        ...quad("m", a, b, it, {
          "00": rng() < 0.5,
          "01": rng() < 0.5,
          "10": rng() < 0.5,
          "11": rng() < 0.5,
        }),
      );
    }
  }

  const [repeat] = pairwiseDisagreement(pairwise);
  const [negation] = negationDisagreement(pairwise);
  const [cross] = individualPairDisagreement(observations, pairwise);
  assert.ok(
    Math.abs(repeat.pairwiseDisagreement - 0.5) < 0.05,
    `pairwise ${repeat.pairwiseDisagreement}`,
  );
  assert.ok(
    Math.abs(negation.negationDisagreement - 0.5) < 0.05,
    `negation ${negation.negationDisagreement}`,
  );
  assert.ok(
    Math.abs(cross.individualPairDisagreement - 0.5) < 0.06,
    `individual-pair ${cross.individualPairDisagreement}`,
  );
});

test("the direction-blind reference is what ignoring the wording would score", () => {
  const observations = [
    // Yes 0.10 -> |2(0.10) - 1| = 0.80.
    ...direct("m", 1, false, [0.05, 0.15]),
    ...direct("m", 1, true, [0.9]),
    // Yes 0.50 -> 0, the one place ignoring the wording costs nothing.
    ...direct("m", 2, false, [0.5]),
    ...direct("m", 2, true, [0.5]),
  ];
  assert.ok(Math.abs(directionBlindReference(observations) - 0.4) < 1e-12);
});

test("RANDOM_NOISE is the mean of the five baselines", () => {
  assert.equal(METRIC_COMPONENTS.length, 5);
  const expected = (5 / 24 + 59 / 360 + 0.5 + 0.5 + 0.5) / 5;
  assert.ok(Math.abs(RANDOM_NOISE - expected) < 1e-12);
  // Worth being ~37%, not 0 and not 50.
  assert.ok(RANDOM_NOISE > 0.37 && RANDOM_NOISE < 0.38);
});

test("every component carries a formula and a baseline the code agrees with", () => {
  assert.deepEqual(
    METRIC_COMPONENTS.map((c) => c.key),
    METRIC_KEYS,
  );
  for (const c of METRIC_COMPONENTS) {
    assert.equal(c.baseline, RANDOM_BASELINES[c.key]);
    assert.ok(c.formula.length > 0, `${c.key} has no formula`);
    assert.ok(c.baselineNote.length > 0, `${c.key} has no baseline note`);
  }
});

// ---------------------------------------------------------------------------
// Per market
// ---------------------------------------------------------------------------

test("the market estimate weights models equally, not forecasts", () => {
  const observations = [
    // One model with eight forecasts, all saying 0.2 on the Yes scale.
    ...direct("a", 1, false, [0.2, 0.2, 0.2, 0.2]),
    ...direct("a", 1, true, [0.8, 0.8, 0.8, 0.8]),
    // A second model with two, saying 0.6.
    ...direct("b", 1, false, [0.6]),
    ...direct("b", 1, true, [0.4]),
  ];
  const [row] = marketMetrics(observations);
  assert.equal(row.models, 2);
  assert.equal(row.forecasts, 10);
  assert.ok(Math.abs(row.modelEstimate - 0.4) < 1e-12);
  assert.equal(row.averageError, 0);
  assert.ok(row.negationError < 1e-12);
});

test("per-market negation error averages the per-model absolute errors", () => {
  const observations = [
    // Model a: Yes 0.6, No 0.5 -> error 0.1.
    ...direct("a", 1, false, [0.6]),
    ...direct("a", 1, true, [0.5]),
    // Model b: Yes 0.3, No 0.6 -> error 0.1 the other way.
    ...direct("b", 1, false, [0.3]),
    ...direct("b", 1, true, [0.6]),
  ];
  const [row] = marketMetrics(observations);
  assert.ok(Math.abs(row.negationError - 0.1) < 1e-12);
  assert.ok(Math.abs(row.drift) < 1e-12);
});
