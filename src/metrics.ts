// The five headline metrics, and the composite built from them.
//
// Every one is a FAILURE rate: zero is a forecaster that agrees with itself,
// and larger is worse. None of them needs to know how a market resolved — each
// compares the model against its own other answers.
//
// Two are measured in probability (the answers are probabilities, so their
// disagreement is a distance in probability), three are shares of judgments.
// All five are reported as plain percentages, and the composite is their
// unweighted mean.
//
// Pure functions over observations, like `analysis.ts`, so the definitions can
// be unit-tested against hand-built panels rather than only against the run.

import {
  DirectObservation,
  INDIFFERENT,
  PairwiseObservation,
  meanOf as mean,
  toYes,
} from "./analysis";

// ---------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------
//
// What each metric reads for a forecaster that answers at random: every direct
// forecast an independent draw from U(0,1), every head-to-head pick an
// independent coin flip. This is the only reference point that can be stated
// without appealing to the data, which is why the site draws it on every chart.
//
// The two probability-scale baselines are exact, not fitted:
//
//   Average error. The mean absolute deviation of n independent U(0,1) draws
//   about their own mean. Writing S = sum|X_i - Xbar| = 2*sum (X_i - Xbar)^+
//   and folding the n symmetric terms into one gives, for n = 4,
//   E[S]/4 = E[(3X_1 - X_2 - X_3 - X_4)^+]/2 = 5/24. (n = 2 gives 1/6, which
//   is the familiar E|X-Y|/2.)
//
//   Negation error. |mean(yes) + mean(no) - 1| where each arm averages four
//   draws, so the sum is an Irwin-Hall(8) variate divided by four:
//   E|A + B - 1| = E|S_8 - 4| / 4 = (59/90)/4 = 59/360.
//
// The three head-to-head baselines are 1/2 by construction: a coin flip repeats
// itself half the time, satisfies a required reversal half the time, and lands
// on the same side as the model's own probabilities half the time.
export const RANDOM_BASELINES = {
  averageError: 5 / 24,
  negationError: 59 / 360,
  pairwiseDisagreement: 0.5,
  negationDisagreement: 0.5,
  individualPairDisagreement: 0.5,
} as const;

export type MetricKey = keyof typeof RANDOM_BASELINES;

export const METRIC_KEYS = Object.keys(RANDOM_BASELINES) as MetricKey[];

export const RANDOM_NOISE = mean(METRIC_KEYS.map((k) => RANDOM_BASELINES[k]));

export interface MetricComponent {
  key: MetricKey;
  label: string;
  // The definition, in the notation the site prints verbatim. Kept next to the
  // implementation so the two cannot drift apart.
  formula: string;
  // "probability" reads as a distance between probabilities; "share" as a
  // proportion of judgments. Both print as percentages, so the unit has to be
  // said in words somewhere, and this is where.
  unit: "probability" | "share";
  question: string;
  description: string;
  baseline: number;
  baselineNote: string;
}

export const METRIC_COMPONENTS: readonly MetricComponent[] = [
  {
    key: "averageError",
    label: "Odds spread",
    formula:
      "mean over cells of  ( 1/n · Σ |pᵢ − p̄| ),  one cell per {model, question, wording}",
    unit: "probability",
    question:
      "Asked the identical question four times, how far apart are the four answers?",
    description:
      "For each model, each question and each wording there are four forecasts from a byte-identical prompt. Take the mean absolute deviation of those four numbers about their own average, then average that over every such set. It is a spread, not a comparison against anything external: 0% means the four repeats were identical.",
    baseline: RANDOM_BASELINES.averageError,
    baselineNote:
      "Four independent draws from U(0,1) have an expected mean absolute deviation of exactly 5/24.",
  },
  {
    key: "negationError",
    label: "Negated spread",
    formula: "mean over {model, question} of  | avg(Yes) − (1 − avg(No)) |",
    unit: "probability",
    question:
      "Asked for the Yes side and the No side of one market, do the two answers describe the same belief?",
    description:
      "Every market is asked both ways: the outcome as the market words it, and the opposite outcome. Average the four Yes forecasts, average the four No forecasts, convert the No average onto the Yes scale as 1 − avg(No), and take the absolute difference. Direction is discarded — this is error, not tilt. 0% means the two wordings agreed exactly.",
    baseline: RANDOM_BASELINES.negationError,
    baselineNote:
      "Two four-draw averages of U(0,1) sum to an Irwin-Hall(8) variate over four, giving E|avg(Yes) + avg(No) − 1| = 59/360.",
  },
  {
    key: "pairwiseDisagreement",
    label: "Pairwise disagreement",
    formula:
      "flipped / comparable,  over pairs of judgments differing only in promptIteration",
    unit: "share",
    question:
      "Asked the identical head-to-head comparison a second time, does it pick the same side?",
    description:
      "Head-to-head prompts fix the pair of outcomes and the wording of each side, so two iterations of one prompt are the same question asked twice. Count every pair of iterations that can be compared and take the share that disagree. 0% means the model repeated every pick.",
    baseline: RANDOM_BASELINES.pairwiseDisagreement,
    baselineNote:
      "Two independent coin flips differ half the time, so a model choosing at random flips 50%.",
  },
  {
    key: "negationDisagreement",
    label: "Negation disagreement",
    formula:
      "violations / checks,  over the couples (A,B)⇄(¬A,¬B) and (A,¬B)⇄(¬A,B)",
    unit: "share",
    question:
      "Negating both sides of a comparison must reverse the pick. Does it?",
    description:
      "Each pair is asked in all four wording combinations. Two of them are logically forced to disagree with each other: whichever outcome the model prefers in “A or B?”, it must prefer the other in “not-A or not-B?”, and the same holds for “A or not-B?” against “not-A or B?”. A violation is picking the same market in both halves of a couple. Checking those two couples is jointly necessary and sufficient for the four answers to be coherent, and needs no probabilities at all.",
    baseline: RANDOM_BASELINES.negationDisagreement,
    baselineNote:
      "A coin flip satisfies a required reversal half the time, so random answering violates 50%.",
  },
  {
    key: "individualPairDisagreement",
    label: "Individual-pair disagreement",
    formula:
      "disagreeing pairs / pairs,  majority(votes) vs sign( p̄(A) − p̄(B) )",
    unit: "share",
    question:
      "Does the outcome a model prefers head-to-head match the one it gave the higher probability to on its own?",
    description:
      "Two independent readings of the same belief. On the direct side, average the model's eight forecasts for each market on the Yes scale — four asked as Yes plus four asked as No and folded over — and see which market comes out higher. On the head-to-head side, turn each of the pair's judgments into a vote for one market: picking a side as worded votes for that market, picking a negated side votes against it, so for the other. A pair disagrees when the majority vote names a different market than the probabilities do; an even split counts as half. Pairs the model gave the same average to are dropped, not scored: the head-to-head prompt forces a pick, but there is no stated preference for it to contradict.",
    baseline: RANDOM_BASELINES.individualPairDisagreement,
    baselineNote:
      "Random picks carry no information about the model's own probabilities, so they land on the other market half the time.",
  },
];

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

const cellKey = (o: DirectObservation): string =>
  `${o.model} ${o.marketId} ${o.isNegated ? 1 : 0}`;

const modelMarketKey = (model: string, marketId: number): string =>
  `${model} ${marketId}`;

const pairKey = (o: PairwiseObservation): string =>
  `${o.marketAId} ${o.marketBId}`;

const comboKey = (o: PairwiseObservation): string =>
  `${o.isANegated ? 1 : 0}${o.isBNegated ? 1 : 0}`;

/** Mean absolute deviation about the sample's own mean. */
export const mad = (xs: number[]): number => {
  const mu = mean(xs);
  return mean(xs.map((x) => Math.abs(x - mu)));
};

// ---------------------------------------------------------------------------
// 1. Average error
// ---------------------------------------------------------------------------

/**
 * Spread within a cell of identical prompts, averaged over cells.
 *
 * Folding the negated wording onto the Yes scale is a reflection, which leaves
 * every distance inside a cell unchanged — so this is the same number whether
 * it is computed on the answers as reported or after folding. Cells holding a
 * single surviving forecast carry no spread information and are skipped rather
 * than counted as 0.
 */
export interface AverageError {
  model: string;
  averageError: number;
  cells: number;
  forecasts: number;
}

export const averageError = (
  observations: DirectObservation[],
): AverageError[] => {
  const cells = new Map<string, number[]>();
  for (const o of observations) {
    const key = cellKey(o);
    const bucket = cells.get(key);
    if (bucket) bucket.push(o.parsedOdds);
    else cells.set(key, [o.parsedOdds]);
  }

  const perModel = new Map<string, { mads: number[]; forecasts: number }>();
  for (const [key, values] of cells) {
    const model = key.slice(0, key.indexOf(" "));
    let acc = perModel.get(model);
    if (!acc) {
      acc = { mads: [], forecasts: 0 };
      perModel.set(model, acc);
    }
    acc.forecasts += values.length;
    if (values.length >= 2) acc.mads.push(mad(values));
  }

  return [...perModel.entries()]
    .map(([model, acc]) => ({
      model,
      averageError: acc.mads.length > 0 ? mean(acc.mads) : 0,
      cells: acc.mads.length,
      forecasts: acc.forecasts,
    }))
    .sort((a, b) => a.model.localeCompare(b.model));
};

// ---------------------------------------------------------------------------
// 2. Negation error
// ---------------------------------------------------------------------------

/**
 * How far a model's two wordings of one market are from describing one belief.
 *
 * Computed from cell means, not by pairing iterations: Yes iteration r and No
 * iteration r are independent calls with no correspondence between them.
 *
 * `1 - avg(No)` is the No arm read on the Yes scale, so the difference is
 * |avg(Yes) + avg(No) - 1| — the same quantity `analysis.negationGaps` reports
 * signed as `gap`. The two code paths are kept independent so they can be
 * checked against each other.
 */
export interface NegationError {
  model: string;
  negationError: number;
  // Signed, for the arm chart: positive means the two wordings overspend.
  drift: number;
  yes: number;
  no: number;
  markets: number;
}

export const negationError = (
  observations: DirectObservation[],
): NegationError[] => {
  const arms = new Map<string, { yes: number[]; no: number[] }>();
  for (const o of observations) {
    const key = modelMarketKey(o.model, o.marketId);
    let entry = arms.get(key);
    if (!entry) {
      entry = { yes: [], no: [] };
      arms.set(key, entry);
    }
    (o.isNegated ? entry.no : entry.yes).push(o.parsedOdds);
  }

  const perModel = new Map<
    string,
    { errors: number[]; drifts: number[]; yes: number[]; no: number[] }
  >();
  for (const [key, entry] of arms) {
    if (entry.yes.length === 0 || entry.no.length === 0) continue;
    const model = key.slice(0, key.indexOf(" "));
    let acc = perModel.get(model);
    if (!acc) {
      acc = { errors: [], drifts: [], yes: [], no: [] };
      perModel.set(model, acc);
    }
    const yes = mean(entry.yes);
    const no = mean(entry.no);
    acc.errors.push(Math.abs(yes - (1 - no)));
    acc.drifts.push(yes - (1 - no));
    acc.yes.push(yes);
    acc.no.push(no);
  }

  return [...perModel.entries()]
    .map(([model, acc]) => ({
      model,
      negationError: mean(acc.errors),
      drift: mean(acc.drifts),
      yes: mean(acc.yes),
      no: mean(acc.no),
      markets: acc.errors.length,
    }))
    .sort((a, b) => a.model.localeCompare(b.model));
};

// ---------------------------------------------------------------------------
// 3. Pairwise disagreement
// ---------------------------------------------------------------------------

/**
 * Share of repeated head-to-head prompts answered differently the second time.
 *
 * Every unordered pair of iterations inside a {pair, wording combination} cell
 * contributes one comparison, so a run with more than two iterations still
 * spends everything it collected.
 */
export interface PairwiseDisagreement {
  model: string;
  pairwiseDisagreement: number;
  comparisons: number;
  // A model stuck on one side scores 0% without being consistent about
  // anything, so the share of picks going to side A rides along as the guard.
  aRate: number;
  judgments: number;
}

export const pairwiseDisagreement = (
  observations: PairwiseObservation[],
): PairwiseDisagreement[] => {
  const byModel = new Map<string, PairwiseObservation[]>();
  for (const o of observations) {
    const bucket = byModel.get(o.model);
    if (bucket) bucket.push(o);
    else byModel.set(o.model, [o]);
  }

  return [...byModel.entries()]
    .map(([model, rows]) => {
      const cells = new Map<string, boolean[]>();
      for (const o of rows) {
        const key = `${pairKey(o)} ${comboKey(o)}`;
        const bucket = cells.get(key);
        if (bucket) bucket.push(o.isALikelier);
        else cells.set(key, [o.isALikelier]);
      }

      let flipped = 0;
      let comparisons = 0;
      for (const picks of cells.values()) {
        for (let i = 0; i < picks.length; i += 1) {
          for (let j = i + 1; j < picks.length; j += 1) {
            comparisons += 1;
            if (picks[i] !== picks[j]) flipped += 1;
          }
        }
      }

      return {
        model,
        pairwiseDisagreement: comparisons > 0 ? flipped / comparisons : 0,
        comparisons,
        aRate: mean(rows.map((r) => (r.isALikelier ? 1 : 0))),
        judgments: rows.length,
      };
    })
    .sort((a, b) => a.model.localeCompare(b.model));
};

// ---------------------------------------------------------------------------
// 4. Negation disagreement
// ---------------------------------------------------------------------------
//
// The two couples that are logically forced to disagree. Keyed "<a><b>" with 1
// meaning that side was presented negated:
//
//   (A, B)   picks A  <=>  P(A) > P(B)
//   (¬A, ¬B) picks A  <=>  P(A) < P(B)      must oppose (A, B)
//   (A, ¬B)  picks A  <=>  P(A) + P(B) > 1
//   (¬A, B)  picks A  <=>  P(A) + P(B) < 1  must oppose (A, ¬B)
//
// So the four wordings probe only two independent facts, each asked twice in
// opposite directions. Checking both couples is jointly necessary and
// sufficient for coherence: all four combinations of the two facts are
// realizable, so nothing else is constrained.
const COHERENCE_COUPLES: readonly [string, string][] = [
  ["00", "11"],
  ["01", "10"],
];

export interface NegationDisagreement {
  model: string;
  negationDisagreement: number;
  checks: number;
  // Split by couple, because they ask different things: the first is about
  // which outcome is likelier, the second about whether the two sum past 1.
  rankCouple: number;
  sumCouple: number;
}

export const negationDisagreement = (
  observations: PairwiseObservation[],
): NegationDisagreement[] => {
  const byModel = new Map<string, PairwiseObservation[]>();
  for (const o of observations) {
    const bucket = byModel.get(o.model);
    if (bucket) bucket.push(o);
    else byModel.set(o.model, [o]);
  }

  return [...byModel.entries()]
    .map(([model, rows]) => {
      // One quadruple per {pair, iteration}: the four wordings answered on the
      // same repetition, side by side.
      const quads = new Map<string, Map<string, boolean>>();
      for (const o of rows) {
        const key = `${pairKey(o)} ${o.iteration}`;
        let quad = quads.get(key);
        if (!quad) {
          quad = new Map();
          quads.set(key, quad);
        }
        quad.set(comboKey(o), o.isALikelier);
      }

      const violations = [0, 0];
      const checks = [0, 0];
      for (const quad of quads.values()) {
        COHERENCE_COUPLES.forEach(([left, right], i) => {
          const a = quad.get(left);
          const b = quad.get(right);
          if (a === undefined || b === undefined) return;
          checks[i] += 1;
          // Both halves naming the same market is the contradiction.
          if (a === b) violations[i] += 1;
        });
      }

      const total = checks[0] + checks[1];
      return {
        model,
        negationDisagreement:
          total > 0 ? (violations[0] + violations[1]) / total : 0,
        checks: total,
        rankCouple: checks[0] > 0 ? violations[0] / checks[0] : 0,
        sumCouple: checks[1] > 0 ? violations[1] / checks[1] : 0,
      };
    })
    .sort((a, b) => a.model.localeCompare(b.model));
};

// ---------------------------------------------------------------------------
// 5. Individual-pair disagreement
// ---------------------------------------------------------------------------

/**
 * The market a single head-to-head judgment speaks in favour of.
 *
 * Picking a side as the market words it is a vote for that market; picking a
 * negated side is a vote against it, and therefore for the other one. That
 * normalization is what lets all four wordings be pooled into one majority.
 *
 * Note what it implies: (A, ¬B) votes for A whichever side is picked, and
 * (¬A, B) votes for B whichever side is picked. Those two wordings ask about
 * the SUM of the pair, not about which outcome is likelier, so they carry no
 * ranking information — and under this normalization they cancel exactly
 * whenever the run holds as many of one as of the other. The majority is
 * therefore decided by the (A,B) and (¬A,¬B) judgments, with the sum wordings
 * contributing a tie. They are still counted, so the denominator is every
 * judgment the model made about the pair.
 */
export const voteFor = (o: PairwiseObservation): "A" | "B" => {
  const negated = o.isALikelier ? o.isANegated : o.isBNegated;
  const picked = o.isALikelier ? "A" : "B";
  if (!negated) return picked;
  return picked === "A" ? "B" : "A";
};

export interface IndividualPairDisagreement {
  model: string;
  individualPairDisagreement: number;
  pairs: number;
  // Pairs whose votes split evenly. The model HAS a preference on the direct
  // side; its head-to-head answers just failed to name one, which is the noise
  // this metric exists to catch, so these stay in the denominator at half.
  ties: number;
  // Pairs dropped entirely: the model gave both markets the same average, so
  // there is no preference for the majority to match or contradict. Not counted
  // in `pairs`.
  indistinguishable: number;
}

export const individualPairDisagreement = (
  direct: DirectObservation[],
  pairwise: PairwiseObservation[],
): IndividualPairDisagreement[] => {
  // The model's own P(Yes) per market: every repetition of both wordings,
  // folded onto the Yes scale and averaged. Eight forecasts in a complete run.
  const folded = new Map<string, number[]>();
  for (const o of direct) {
    const key = modelMarketKey(o.model, o.marketId);
    const bucket = folded.get(key);
    if (bucket) bucket.push(toYes(o));
    else folded.set(key, [toYes(o)]);
  }
  const believed = new Map<string, number>();
  for (const [key, values] of folded) believed.set(key, mean(values));

  const byModelPair = new Map<string, PairwiseObservation[]>();
  for (const o of pairwise) {
    const key = `${o.model} ${pairKey(o)}`;
    const bucket = byModelPair.get(key);
    if (bucket) bucket.push(o);
    else byModelPair.set(key, [o]);
  }

  const perModel = new Map<
    string,
    {
      disagreements: number;
      pairs: number;
      ties: number;
      indistinguishable: number;
    }
  >();
  for (const rows of byModelPair.values()) {
    const model = rows[0].model;
    const pA = believed.get(modelMarketKey(model, rows[0].marketAId));
    const pB = believed.get(modelMarketKey(model, rows[0].marketBId));
    if (pA === undefined || pB === undefined) continue;

    let acc = perModel.get(model);
    if (!acc) {
      acc = { disagreements: 0, pairs: 0, ties: 0, indistinguishable: 0 };
      perModel.set(model, acc);
    }

    // The model rates the two markets the same, so it named no favourite for
    // the head-to-head majority to match. The pick was forced by the prompt,
    // not by a belief, and leaves the denominator entirely.
    if (Math.abs(pA - pB) <= INDIFFERENT) {
      acc.indistinguishable += 1;
      continue;
    }

    let votesA = 0;
    for (const o of rows) if (voteFor(o) === "A") votesA += 1;
    const votesB = rows.length - votesA;

    acc.pairs += 1;
    if (votesA === votesB) {
      // A preference exists but the votes did not find it: half a disagreement,
      // so the denominator stays every pair the model could have answered.
      acc.ties += 1;
      acc.disagreements += 0.5;
    } else if (votesA > votesB !== pA > pB) {
      acc.disagreements += 1;
    }
  }

  return [...perModel.entries()]
    .map(([model, acc]) => ({
      model,
      individualPairDisagreement:
        acc.pairs > 0 ? acc.disagreements / acc.pairs : 0,
      pairs: acc.pairs,
      ties: acc.ties,
      indistinguishable: acc.indistinguishable,
    }))
    .sort((a, b) => a.model.localeCompare(b.model));
};

/**
 * What negation error would read if a model ignored the wording entirely.
 *
 * A model that answers its Yes number to the No wording as well scores
 * |avg(Yes) - (1 - avg(Yes))| = |2·avg(Yes) - 1|, so this is the metric's
 * failure ceiling ON THIS DATASET rather than a universal constant: it depends
 * on how lopsided the questions are. It is the number the run's own answers
 * would produce, which is why the site quotes it next to the random-answering
 * baseline — random answering is not the worst a forecaster can do here.
 */
export const directionBlindReference = (
  observations: DirectObservation[],
): number => {
  const yes = new Map<string, number[]>();
  for (const o of observations) {
    if (o.isNegated) continue;
    const key = modelMarketKey(o.model, o.marketId);
    const bucket = yes.get(key);
    if (bucket) bucket.push(o.parsedOdds);
    else yes.set(key, [o.parsedOdds]);
  }
  const errors = [...yes.values()].map((v) => Math.abs(2 * mean(v) - 1));
  return errors.length > 0 ? mean(errors) : 0;
};

// ---------------------------------------------------------------------------
// The composite
// ---------------------------------------------------------------------------

/**
 * The unweighted mean of the five, per model.
 *
 * Equal weight, not equal contribution: the head-to-head shares run an order of
 * magnitude larger than the two probability-scale errors, so they dominate the
 * total. That is why the site never shows the composite without its five parts
 * beside it, and why the ranking is always readable component by component.
 *
 * The floor is a genuine zero — a forecaster that repeats itself exactly, keeps
 * its two wordings consistent and ranks the same way twice scores 0% on all
 * five. The random-answering reference is `RANDOM_NOISE`.
 */
export interface NoiseScore {
  model: string;
  noise: number;
  averageError: number;
  negationError: number;
  pairwiseDisagreement: number;
  negationDisagreement: number;
  individualPairDisagreement: number;
  // Context, never scored.
  drift: number;
  yes: number;
  no: number;
  aRate: number;
  rankCouple: number;
  sumCouple: number;
  cells: number;
  forecasts: number;
  markets: number;
  comparisons: number;
  checks: number;
  judgments: number;
  pairs: number;
  ties: number;
  indistinguishablePairs: number;
}

export const noiseScores = (
  direct: DirectObservation[],
  pairwise: PairwiseObservation[],
): NoiseScore[] => {
  const avg = new Map(averageError(direct).map((r) => [r.model, r]));
  const neg = new Map(negationError(direct).map((r) => [r.model, r]));
  const pairRepeat = new Map(
    pairwiseDisagreement(pairwise).map((r) => [r.model, r]),
  );
  const pairNeg = new Map(
    negationDisagreement(pairwise).map((r) => [r.model, r]),
  );
  const cross = new Map(
    individualPairDisagreement(direct, pairwise).map((r) => [r.model, r]),
  );

  const models = [...new Set(direct.map((o) => o.model))].sort();
  return models
    .map((model) => {
      const parts = {
        averageError: avg.get(model)?.averageError ?? 0,
        negationError: neg.get(model)?.negationError ?? 0,
        pairwiseDisagreement: pairRepeat.get(model)?.pairwiseDisagreement ?? 0,
        negationDisagreement: pairNeg.get(model)?.negationDisagreement ?? 0,
        individualPairDisagreement:
          cross.get(model)?.individualPairDisagreement ?? 0,
      };
      return {
        model,
        ...parts,
        noise: mean(METRIC_KEYS.map((k) => parts[k])),
        drift: neg.get(model)?.drift ?? 0,
        yes: neg.get(model)?.yes ?? 0,
        no: neg.get(model)?.no ?? 0,
        aRate: pairRepeat.get(model)?.aRate ?? 0,
        rankCouple: pairNeg.get(model)?.rankCouple ?? 0,
        sumCouple: pairNeg.get(model)?.sumCouple ?? 0,
        cells: avg.get(model)?.cells ?? 0,
        forecasts: avg.get(model)?.forecasts ?? 0,
        markets: neg.get(model)?.markets ?? 0,
        comparisons: pairRepeat.get(model)?.comparisons ?? 0,
        checks: pairNeg.get(model)?.checks ?? 0,
        judgments: pairRepeat.get(model)?.judgments ?? 0,
        pairs: cross.get(model)?.pairs ?? 0,
        ties: cross.get(model)?.ties ?? 0,
        indistinguishablePairs: cross.get(model)?.indistinguishable ?? 0,
      };
    })
    .sort((a, b) => a.noise - b.noise);
};

// ---------------------------------------------------------------------------
// Per market
// ---------------------------------------------------------------------------

/**
 * The two probability-scale metrics again, sliced by question instead of by
 * model, plus what the panel thought the answer was.
 *
 * `modelEstimate` is the unweighted mean of the per-model folded means, so a
 * model with more surviving forecasts does not get extra vote weight. The
 * head-to-head metrics have no per-market form: F1 of the design notes — one
 * market sits in two pairs and another in none — so a "per market" pairwise
 * rate would be dividing by a number that varies.
 *
 * `estimates` carries the same per-model folded means the average is built
 * from, so the site can show the panel's spread on a question rather than only
 * its centre. They are the terms of `modelEstimate`, not a second statistic.
 */
export interface MarketMetrics {
  marketId: number;
  modelEstimate: number;
  estimates: { model: string; estimate: number }[];
  averageError: number;
  negationError: number;
  drift: number;
  yes: number;
  no: number;
  models: number;
  forecasts: number;
}

export const marketMetrics = (
  observations: DirectObservation[],
): MarketMetrics[] => {
  interface Acc {
    mads: number[];
    errors: number[];
    drifts: number[];
    yes: number[];
    no: number[];
    folded: { model: string; estimate: number }[];
    models: Set<string>;
    forecasts: number;
  }
  const byMarket = new Map<number, Acc>();
  const cells = new Map<string, number[]>();
  const arms = new Map<string, { yes: number[]; no: number[] }>();

  const acc = (marketId: number): Acc => {
    let entry = byMarket.get(marketId);
    if (!entry) {
      entry = {
        mads: [],
        errors: [],
        drifts: [],
        yes: [],
        no: [],
        folded: [],
        models: new Set(),
        forecasts: 0,
      };
      byMarket.set(marketId, entry);
    }
    return entry;
  };

  for (const o of observations) {
    const entry = acc(o.marketId);
    entry.models.add(o.model);
    entry.forecasts += 1;

    const key = cellKey(o);
    const cell = cells.get(key);
    if (cell) cell.push(o.parsedOdds);
    else cells.set(key, [o.parsedOdds]);

    const mm = modelMarketKey(o.model, o.marketId);
    let arm = arms.get(mm);
    if (!arm) {
      arm = { yes: [], no: [] };
      arms.set(mm, arm);
    }
    (o.isNegated ? arm.no : arm.yes).push(o.parsedOdds);
  }

  for (const [key, values] of cells) {
    if (values.length < 2) continue;
    acc(Number(key.split(" ")[1])).mads.push(mad(values));
  }

  for (const [key, arm] of arms) {
    if (arm.yes.length === 0 || arm.no.length === 0) continue;
    const entry = acc(Number(key.split(" ")[1]));
    const yes = mean(arm.yes);
    const no = mean(arm.no);
    entry.errors.push(Math.abs(yes - (1 - no)));
    entry.drifts.push(yes - (1 - no));
    entry.yes.push(yes);
    entry.no.push(no);
    // The model's own view of the market: both wordings folded onto Yes.
    entry.folded.push({
      model: key.slice(0, key.indexOf(" ")),
      estimate: mean([yes, 1 - no]),
    });
  }

  return [...byMarket.entries()]
    .map(([marketId, entry]) => ({
      marketId,
      modelEstimate:
        entry.folded.length > 0 ? mean(entry.folded.map((f) => f.estimate)) : 0,
      estimates: [...entry.folded].sort((a, b) =>
        a.model.localeCompare(b.model),
      ),
      averageError: entry.mads.length > 0 ? mean(entry.mads) : 0,
      negationError: entry.errors.length > 0 ? mean(entry.errors) : 0,
      drift: entry.drifts.length > 0 ? mean(entry.drifts) : 0,
      yes: entry.yes.length > 0 ? mean(entry.yes) : 0,
      no: entry.no.length > 0 ? mean(entry.no) : 0,
      models: entry.models.size,
      forecasts: entry.forecasts,
    }))
    .sort((a, b) => a.marketId - b.marketId);
};
