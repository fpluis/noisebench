// Compute the analysis layer for a benchmark run and write it to site/data.
//
//   npx tsx scripts/analyze.ts --run 1
//   npx tsx scripts/analyze.ts --run 1 --out site/data
//
// The site reads only the JSON this produces, so it opens with no database and
// can be served as static files. Aggregation that SQL is good at (joins,
// per-cell counts) happens in Postgres; the decomposition arithmetic happens in
// `src/analysis.ts`, where the unbalanced-cell handling stays readable and is
// unit-tested.
//
// Emits `metrics.json` — the five headline metrics, their composite and their
// per-market slices, which is all the site reads besides `run.json`. The noise
// decomposition and the signed negation analysis are still written out, since
// they are the underlying statistics `docs/analysis-design.md` describes, but no
// page depends on them. Ranking and inference cost land in later passes.

import fs from "fs";
import path from "path";
import { Client } from "pg";
import * as dotenv from "dotenv";
import {
  DirectObservation,
  MIDPOINT_BANDS,
  PairwiseObservation,
  SCALES,
  Scale,
  bandFor,
  decompose,
  logit,
  meanOf,
  negationGaps,
} from "../src/analysis";
import {
  METRIC_COMPONENTS,
  METRIC_KEYS,
  RANDOM_NOISE,
  directionBlindReference,
  marketMetrics,
  noiseScores,
} from "../src/metrics";
import { parseArgs } from "../src/utils";

dotenv.config();

const connectionString =
  process.env.DATABASE_URL ||
  "postgres://noisebench:noisebench@localhost:5433/noisebench";

interface MarketMeta {
  marketId: number;
  slug: string;
  question: string;
  eventTitle: string;
  midpoint: number | null;
}

const round = (x: number, dp = 6): number =>
  Number.isFinite(x) ? Number(x.toFixed(dp)) : 0;

/**
 * The strict-balance subset: cells holding all `iterations` repetitions, and
 * only markets where every model x phrasing cell survives that filter.
 *
 * The primary analysis keeps any cell with at least one observation, which
 * costs nothing in bias when a cell is merely short a repetition. This is the
 * robustness check — if the headline numbers move between the two, the run's
 * parse failures are driving them rather than the models' behaviour, and the
 * site has to say so.
 */
const strictlyBalanced = (
  observations: DirectObservation[],
  iterations: number,
): DirectObservation[] => {
  const counts = new Map<string, number>();
  for (const o of observations) {
    const key = `${o.model} ${o.marketId} ${o.isNegated ? 1 : 0}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const models = new Set(observations.map((o) => o.model));
  const full = new Set<number>();
  for (const marketId of new Set(observations.map((o) => o.marketId))) {
    let ok = true;
    for (const model of models) {
      for (const negated of [0, 1]) {
        if ((counts.get(`${model} ${marketId} ${negated}`) ?? 0) < iterations) {
          ok = false;
          break;
        }
      }
      if (!ok) break;
    }
    if (ok) full.add(marketId);
  }
  return observations.filter((o) => full.has(o.marketId));
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = Number(args.run ?? 1);
  const outDir = (args.out as string) || path.join("site", "data");

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const runResult = await client.query(
      `SELECT r.id, r.name, r.description, r.dataset_name, r.prompt_iterations,
              r.pairwise_iterations, r.started_at, r.ended_at, s.name AS status
         FROM public.benchmark_run r
         JOIN public.benchmark_status s ON s.id = r.status_id
        WHERE r.id = $1`,
      [runId],
    );
    if (runResult.rowCount === 0)
      throw new Error(`No benchmark run with id ${runId}`);
    const run = runResult.rows[0];

    const marketRows = await client.query(
      `SELECT m.id AS market_id, m.slug, m.question,
              e.title AS event_title, s.midpoint
         FROM public.benchmark_run_market brm
         JOIN public.market m ON m.id = brm.market_id
         JOIN public.event e ON e.id = m.event_id
         LEFT JOIN public.benchmark_run_market_snapshot s
                ON s.benchmark_run_id = brm.benchmark_run_id
               AND s.market_id = m.id
        WHERE brm.benchmark_run_id = $1`,
      [runId],
    );
    const markets: MarketMeta[] = marketRows.rows.map((r) => ({
      marketId: r.market_id,
      slug: r.slug,
      question: r.question,
      eventTitle: r.event_title,
      midpoint: r.midpoint === null ? null : Number(r.midpoint),
    }));
    const marketById = new Map(markets.map((m) => [m.marketId, m]));

    const forecastRows = await client.query(
      `SELECT lm.name AS model, f.market_id, f.is_negated, f.prompt_iteration,
              f.parsed_odds
         FROM public.forecast f
         JOIN public.forecaster fc ON fc.id = f.forecaster_id
         JOIN public.llm_model lm ON lm.id = fc.forecasting_model_id
        WHERE f.benchmark_run_id = $1
          AND f.parsed_odds IS NOT NULL`,
      [runId],
    );
    const observations: DirectObservation[] = forecastRows.rows.map((r) => ({
      model: r.model,
      marketId: r.market_id,
      isNegated: r.is_negated,
      iteration: r.prompt_iteration,
      parsedOdds: Number(r.parsed_odds),
    }));

    const pairwiseRows = await client.query(
      `SELECT lm.name AS model, p.market_a_id, p.market_b_id,
              p.is_a_negated, p.is_b_negated, p.prompt_iteration, p.is_a_likelier
         FROM public.pairwise_forecast p
         JOIN public.forecaster fc ON fc.id = p.forecaster_id
         JOIN public.llm_model lm ON lm.id = fc.forecasting_model_id
        WHERE p.benchmark_run_id = $1
          AND p.is_a_likelier IS NOT NULL`,
      [runId],
    );
    const pairwise: PairwiseObservation[] = pairwiseRows.rows.map((r) => ({
      model: r.model,
      marketAId: r.market_a_id,
      marketBId: r.market_b_id,
      isANegated: r.is_a_negated,
      isBNegated: r.is_b_negated,
      iteration: r.prompt_iteration,
      isALikelier: r.is_a_likelier,
    }));

    const coverageRows = await client.query(
      `SELECT lm.name AS model,
              COUNT(*) AS attempted,
              COUNT(f.parsed_odds) AS parsed
         FROM public.forecast f
         JOIN public.forecaster fc ON fc.id = f.forecaster_id
         JOIN public.llm_model lm ON lm.id = fc.forecasting_model_id
        WHERE f.benchmark_run_id = $1
        GROUP BY 1 ORDER BY 1`,
      [runId],
    );

    console.log(
      `Run ${runId} (${run.name}): ${observations.length} parsed direct forecasts, ` +
        `${pairwise.length} head-to-head judgments, ${markets.length} markets.`,
    );

    // ---------------------------------------------------------------------
    // The five headline metrics and their composite, from both modalities.
    // ---------------------------------------------------------------------
    const scores = noiseScores(observations, pairwise);
    const perMarket = marketMetrics(observations);
    const directionBlind = directionBlindReference(observations);

    console.log(
      `  noise ${(100 * scores[0].noise).toFixed(1)}% (${scores[0].model}) ` +
        `up to ${(100 * scores[scores.length - 1].noise).toFixed(1)}% ` +
        `(${scores[scores.length - 1].model}); answering at random ${(100 * RANDOM_NOISE).toFixed(1)}%`,
    );
    for (const c of METRIC_COMPONENTS) {
      const field = meanOf(scores.map((s) => s[c.key]));
      console.log(
        `    ${c.label.padEnd(28)} field ${(100 * field).toFixed(1)}%  ` +
          `baseline ${(100 * c.baseline).toFixed(1)}%`,
      );
    }

    // ---------------------------------------------------------------------
    // Noise decomposition, on both scales and both subsets.
    // ---------------------------------------------------------------------
    const strict = strictlyBalanced(observations, run.prompt_iterations);
    const fits: Record<string, unknown> = {};
    for (const scale of SCALES) {
      const primary = decompose(observations, scale);
      const robustness = decompose(strict, scale);
      fits[scale] = {
        primary: serializeFit(primary, marketById),
        robustness: serializeFit(robustness, marketById),
      };
      console.log(
        `  ${scale.padEnd(11)} level ${primary.level.toFixed(3)}  ` +
          `stable ${primary.stablePattern.corrected.toFixed(3)}  ` +
          `occasion ${primary.occasion.toFixed(3)}  ` +
          `system ${primary.systemNoise.toFixed(3)}  ` +
          `(${primary.marketIds.length} markets)`,
      );
    }

    // Occasion noise by how extreme the market is. The point of carrying two
    // scales: on probability, noise shrinks toward the tails simply because
    // there is less room to move; in log-odds it does not.
    const occasionByBand = occasionNoiseByBand(observations, marketById);

    // ---------------------------------------------------------------------
    // Negation coherence.
    // ---------------------------------------------------------------------
    const gaps = negationGaps(observations);
    const byModel = new Map<string, typeof gaps>();
    for (const g of gaps) {
      const bucket = byModel.get(g.model);
      if (bucket) bucket.push(g);
      else byModel.set(g.model, [g]);
    }

    const negationByModel = [...byModel.entries()]
      .map(([model, rows]) => ({
        model,
        gap: round(meanOf(rows.map((r) => r.gap))),
        absGap: round(meanOf(rows.map((r) => Math.abs(r.gap)))),
        logOddsGap: round(meanOf(rows.map((r) => r.logOddsGap))),
        base: round(meanOf(rows.map((r) => r.base))),
        negated: round(meanOf(rows.map((r) => r.negated))),
        markets: rows.length,
      }))
      .sort((a, b) => a.gap - b.gap);

    const negationByBand = MIDPOINT_BANDS.map((band) => {
      const rows = gaps.filter((g) => {
        const midpoint = marketById.get(g.marketId)?.midpoint;
        return (
          midpoint !== null &&
          midpoint !== undefined &&
          bandFor(midpoint) === band.label
        );
      });
      const marketIds = new Set(rows.map((r) => r.marketId));
      return {
        band: band.label,
        markets: marketIds.size,
        meanMidpoint: round(
          meanOf([...marketIds].map((id) => marketById.get(id)?.midpoint ?? 0)),
        ),
        base: round(meanOf(rows.map((r) => r.base))),
        negated: round(meanOf(rows.map((r) => r.negated))),
        gap: round(meanOf(rows.map((r) => r.gap))),
        logOddsGap: round(meanOf(rows.map((r) => r.logOddsGap))),
      };
    }).filter((b) => b.markets > 0);

    const negationByMarket = [...new Set(gaps.map((g) => g.marketId))]
      .map((marketId) => {
        const rows = gaps.filter((g) => g.marketId === marketId);
        const meta = marketById.get(marketId);
        return {
          marketId,
          slug: meta?.slug ?? String(marketId),
          question: meta?.question ?? "",
          midpoint: meta?.midpoint ?? null,
          base: round(meanOf(rows.map((r) => r.base))),
          negated: round(meanOf(rows.map((r) => r.negated))),
          gap: round(meanOf(rows.map((r) => r.gap))),
        };
      })
      .sort((a, b) => a.gap - b.gap);

    console.log(
      `  negation gap ${round(meanOf(gaps.map((g) => g.gap)), 3)} overall, ` +
        `${negationByBand[0]?.gap} in the lowest band`,
    );

    // ---------------------------------------------------------------------
    // Write.
    // ---------------------------------------------------------------------
    fs.mkdirSync(outDir, { recursive: true });

    write(outDir, "run.json", {
      id: run.id,
      name: run.name,
      description: run.description,
      dataset: run.dataset_name,
      status: run.status,
      promptIterations: run.prompt_iterations,
      pairwiseIterations: run.pairwise_iterations,
      startedAt: run.started_at,
      endedAt: run.ended_at,
      models: coverageRows.rows.map((r) => ({
        model: r.model,
        attempted: Number(r.attempted),
        parsed: Number(r.parsed),
        parseFailureRate: round(
          (Number(r.attempted) - Number(r.parsed)) / Number(r.attempted),
        ),
      })),
      markets: markets.length,
      generatedAt: new Date().toISOString(),
    });

    write(outDir, "metrics.json", {
      runId,
      // The five definitions travel with the numbers, so a chart can never
      // label a metric with a formula the code no longer computes.
      components: METRIC_COMPONENTS,
      randomNoise: round(RANDOM_NOISE, 4),
      directionBlind: round(directionBlind, 4),
      field: Object.fromEntries([
        ["noise", round(meanOf(scores.map((s) => s.noise)), 4)],
        ...METRIC_KEYS.map((key) => [
          key,
          round(meanOf(scores.map((s) => s[key])), 4),
        ]),
      ]),
      models: scores.map((s) => ({
        model: s.model,
        noise: round(s.noise, 4),
        averageError: round(s.averageError, 4),
        negationError: round(s.negationError, 4),
        pairwiseDisagreement: round(s.pairwiseDisagreement, 4),
        negationDisagreement: round(s.negationDisagreement, 4),
        individualPairDisagreement: round(s.individualPairDisagreement, 4),
        drift: round(s.drift, 4),
        yes: round(s.yes, 4),
        no: round(s.no, 4),
        aRate: round(s.aRate, 4),
        rankCouple: round(s.rankCouple, 4),
        sumCouple: round(s.sumCouple, 4),
        cells: s.cells,
        forecasts: s.forecasts,
        markets: s.markets,
        comparisons: s.comparisons,
        checks: s.checks,
        judgments: s.judgments,
        pairs: s.pairs,
        ties: s.ties,
      })),
      byMarket: perMarket.map((m) => {
        const meta = marketById.get(m.marketId);
        return {
          marketId: m.marketId,
          slug: meta?.slug ?? String(m.marketId),
          question: meta?.question ?? "",
          eventTitle: meta?.eventTitle ?? "",
          midpoint: meta?.midpoint ?? null,
          modelEstimate: round(m.modelEstimate, 4),
          averageError: round(m.averageError, 4),
          negationError: round(m.negationError, 4),
          drift: round(m.drift, 4),
          yes: round(m.yes, 4),
          no: round(m.no, 4),
          models: m.models,
          forecasts: m.forecasts,
        };
      }),
    });

    write(outDir, "noise.json", {
      runId,
      scales: fits,
      occasionByBand,
      subsets: {
        primary: {
          label: "Every model x phrasing cell non-empty",
          markets: decompose(observations, "probability").marketIds.length,
        },
        robustness: {
          label: `All ${run.prompt_iterations} iterations in every cell`,
          markets: decompose(strict, "probability").marketIds.length,
        },
      },
    });

    write(outDir, "negation.json", {
      runId,
      overall: {
        gap: round(meanOf(gaps.map((g) => g.gap))),
        absGap: round(meanOf(gaps.map((g) => Math.abs(g.gap)))),
        logOddsGap: round(meanOf(gaps.map((g) => g.logOddsGap))),
        base: round(meanOf(gaps.map((g) => g.base))),
        negated: round(meanOf(gaps.map((g) => g.negated))),
        cells: gaps.length,
      },
      byModel: negationByModel,
      byBand: negationByBand,
      byMarket: negationByMarket,
    });

    console.log(`\n✅ Wrote analysis JSON to ${outDir}/`);
  } finally {
    await client.end();
  }
}

const serializeFit = (
  fit: ReturnType<typeof decompose>,
  marketById: Map<number, MarketMeta>,
) => ({
  scale: fit.scale,
  grandMean: round(fit.grandMean),
  level: round(fit.level),
  stablePattern: round(fit.stablePattern.corrected),
  stablePatternRaw: round(fit.stablePattern.raw),
  occasion: round(fit.occasion),
  systemNoise: round(fit.systemNoise),
  caseSpread: round(fit.caseSpread),
  phrasingEffect: round(fit.phrasingEffect),
  phrasingPattern: round(fit.phrasingPattern.corrected),
  models: fit.models.length,
  markets: fit.marketIds.length,
  observations: fit.observations,
  clipped: fit.clipped,
  occasionDf: fit.occasionDf,
  perModel: fit.perModel.map((m) => ({
    model: m.model,
    level: round(m.level),
    stablePattern: round(m.stablePattern.corrected),
    occasion: round(m.occasion),
    phrasingBias: round(m.phrasingBias),
    observations: m.observations,
  })),
  perMarket: fit.perMarket.map((m) => ({
    marketId: m.marketId,
    slug: marketById.get(m.marketId)?.slug ?? String(m.marketId),
    question: marketById.get(m.marketId)?.question ?? "",
    midpoint: marketById.get(m.marketId)?.midpoint ?? null,
    difficulty: round(m.difficulty),
    consensus: round(m.consensus),
    betweenModel: round(m.betweenModel),
    withinModel: round(m.withinModel),
    negationGap: round(m.negationGap),
  })),
});

/**
 * Within-cell noise split by how extreme the market's snapshot price is,
 * reported on both scales side by side.
 *
 * This is the table that settles the absolute-versus-relative question: a model
 * moving 0.01 -> 0.03 on a long shot barely registers in points but is a 3x
 * move in the odds of the event.
 */
const occasionNoiseByBand = (
  observations: DirectObservation[],
  marketById: Map<number, MarketMeta>,
) => {
  const cells = new Map<string, { probability: number[]; logOdds: number[] }>();
  for (const o of observations) {
    const key = `${o.model} ${o.marketId} ${o.isNegated ? 1 : 0}`;
    const pYes = o.isNegated ? 1 - o.parsedOdds : o.parsedOdds;
    let bucket = cells.get(key);
    if (!bucket) {
      bucket = { probability: [], logOdds: [] };
      cells.set(key, bucket);
    }
    bucket.probability.push(pYes);
    bucket.logOdds.push(logit(pYes));
  }

  const pooled = new Map<
    string,
    { probSs: number; logSs: number; df: number; markets: Set<number> }
  >();
  for (const [key, bucket] of cells) {
    if (bucket.probability.length < 2) continue;
    const marketId = Number(key.split(" ")[1]);
    const midpoint = marketById.get(marketId)?.midpoint;
    if (midpoint === null || midpoint === undefined) continue;
    const band = bandFor(midpoint);
    let acc = pooled.get(band);
    if (!acc) {
      acc = { probSs: 0, logSs: 0, df: 0, markets: new Set() };
      pooled.set(band, acc);
    }
    for (const scale of ["probability", "logOdds"] as Scale[]) {
      const values =
        scale === "probability" ? bucket.probability : bucket.logOdds;
      const mu = meanOf(values);
      const ss = values.reduce((s, x) => s + (x - mu) * (x - mu), 0);
      if (scale === "probability") acc.probSs += ss;
      else acc.logSs += ss;
    }
    acc.df += bucket.probability.length - 1;
    acc.markets.add(marketId);
  }

  return MIDPOINT_BANDS.filter((b) => pooled.has(b.label)).map((b) => {
    const acc = pooled.get(b.label)!;
    return {
      band: b.label,
      markets: acc.markets.size,
      probability: round(Math.sqrt(acc.probSs / acc.df)),
      logOdds: round(Math.sqrt(acc.logSs / acc.df)),
      df: acc.df,
    };
  });
};

const write = (dir: string, name: string, payload: unknown): void => {
  fs.writeFileSync(
    path.join(dir, name),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
};

main().catch((error) => {
  console.error("\nAnalysis failed:", error);
  process.exit(1);
});
