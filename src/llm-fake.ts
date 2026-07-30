// Drop-in stand-ins for `generateForecast` and `generatePairwiseForecast` that
// never call OpenRouter.
//
// Its job is to let the *real* benchmark.ts run at full production volume
// (~16,000 tasks) for $0, so that everything downstream of inference — the DB
// mappings, the batching, the on-chain submission, --resume — is exercised at
// the scale it will actually meet. Enabled with NOISEBENCH_FAKE_INFERENCE=true.
//
// Two properties matter:
//
//   1. DETERMINISM. Odds are a pure function of
//      {model, marketId, isNegated, iteration} — and a pairwise choice of
//      {model, both marketIds, combination, iteration} — so an interrupted run
//      and its --resume produce identical data and the reconciliation checks
//      stay meaningful across restarts.
//
//   2. HOSTILITY. Real runs contain refusals, truncations, null costs, 100 KB
//      reasoning blobs and non-ASCII text. A fake that only emits clean rows
//      proves nothing about the schema, so those cases are injected on purpose
//      at fixed rates.

import { InferenceResult, PairwiseInferenceResult } from "./types";
import {
  GenerateForecastOptions,
  GeneratePairwiseForecastOptions,
  PAIRWISE_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  buildPairwiseUserPrompt,
  buildUserPrompt,
} from "./llm";
import { parseForecastProbability, parsePairwiseChoice, sleep } from "./utils";

// FNV-1a. Small, dependency-free, and well-distributed enough that the derived
// odds look like a plausible spread rather than a visible pattern.
const hash = (input: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
};

// A deterministic value in [0, 1) from a seed string.
const unit = (seed: string): number => hash(seed) / 0x100000000;

/**
 * The probability this fake "believes" a market resolves Yes, for one model.
 *
 * Shared by both modalities on purpose: a pairwise choice derived from the same
 * anchors as the direct forecasts means the two agree with each other, so a
 * rehearsal exercises the cross-modality checks with realistic data instead of
 * with noise that would fail them for the wrong reason.
 */
const marketAnchor = (model: string, externalId: string): number =>
  0.1 + unit(`${model}|${externalId}|anchor`) * 0.8;

const NASTY_TEXT = [
  "Ünïcödé ✓ — em‑dash, “smart quotes”, and an emoji 🎲",
  "Backslashes \\ and 'single' and \"double\" quotes",
  'JSON-ish: {"key": [1, 2, null]}',
  "SQL-ish: '); DROP TABLE forecast; --",
].join(" | ");

/** Rates for the injected failure modes. Tuned to be common enough to hit
 *  every code path in a few hundred tasks, rare enough that a run still
 *  produces a usable majority of forecasts. */
const UNPARSEABLE_RATE = 0.05;
const HARD_FAILURE_RATE = 0.02;
const NULL_COST_RATE = 0.1;
const HUGE_REASONING_RATE = 0.01;

export async function fakeGenerateForecast(
  options: GenerateForecastOptions,
): Promise<InferenceResult> {
  const { model, event, market, isNegated, identifier } = options;

  const seed = `${model}|${market.externalId}|${isNegated ? "neg" : "base"}|${identifier ?? ""}`;
  const roll = (salt: string) => unit(`${seed}|${salt}`);

  // Simulate inference latency so concurrency, pool contention and batch
  // timers behave like they will in production. Default is deliberately small.
  const latencyMs = parseInt(process.env.NOISEBENCH_FAKE_LATENCY_MS || "5", 10);
  if (latencyMs > 0) {
    await sleep(Math.round(latencyMs * (0.5 + roll("latency"))));
  }

  const result: InferenceResult = {
    model,
    provider: "fake-provider",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildUserPrompt(event, market, isNegated),
    rawResponse: null,
    reasoning: null,
    finishReason: "stop",
    parsedOdds: null,
    cost: 1234,
    tokensIn: 1000 + Math.floor(roll("tin") * 4000),
    tokensOut: 200 + Math.floor(roll("tout") * 800),
    reasoningTokens: Math.floor(roll("rtok") * 2000),
    timeMs: latencyMs,
    attempts: 1,
    errors: [],
    usage: { fake: true, prompt_tokens: 1000, completion_tokens: 200 },
  };

  // --- Injected failure mode: every attempt failed, nothing came back. ------
  if (roll("hardfail") < HARD_FAILURE_RATE) {
    result.rawResponse = null;
    result.finishReason = null;
    result.cost = null;
    result.tokensIn = null;
    result.tokensOut = null;
    result.reasoningTokens = null;
    result.usage = null;
    result.attempts = 4;
    result.errors = [
      { code: 429, message: "Rate limit exceeded (simulated)" },
      { code: 502, message: "Upstream provider error (simulated)" },
      { code: "unknown", message: NASTY_TEXT },
    ];
    return result;
  }

  // --- Injected failure mode: content, but no `Probability: X%`. ------------
  // The single most expensive real-world case: it burns the full retry budget
  // and still yields no data point, so --resume must retry it next time.
  if (roll("unparseable") < UNPARSEABLE_RATE) {
    result.rawResponse =
      "I cannot responsibly forecast this event without more information. " +
      NASTY_TEXT;
    result.finishReason = roll("truncated") < 0.5 ? "length" : "stop";
    result.attempts = 4;
    result.errors = [
      {
        code: "unparseable",
        message: "No 'Probability: X%' found. Response head: I cannot…",
      },
    ];
    return result;
  }

  // --- The normal path. ----------------------------------------------------
  // Give the fake the shape of the real signal: a base probability per market,
  // with the "No" request landing near its complement plus a per-iteration
  // wobble. That way the coherence check in verify-run.ts reports a realistic
  // non-zero noise figure instead of a suspiciously perfect 0.
  const marketBase = marketAnchor(model, market.externalId);
  const drift = (roll("drift") - 0.5) * 0.08;
  const raw = isNegated ? 1 - marketBase + drift : marketBase + drift;
  const percent = Math.min(99.99, Math.max(0.01, raw * 100));

  const reasoningLength = roll("huge") < HUGE_REASONING_RATE ? 100_000 : 400;
  result.reasoning = "r".repeat(reasoningLength);
  result.rawResponse =
    `Considering the evidence and the base rate. ${NASTY_TEXT}\n\n` +
    `Probability: ${percent.toFixed(2)}%`;

  if (roll("nullcost") < NULL_COST_RATE) result.cost = null;

  // Parse via the real parser rather than assigning `percent` directly, so the
  // fake exercises the same code path production does.
  result.parsedOdds = parseForecastProbability(result.rawResponse);
  return result;
}

// A pairwise-only refusal: the model declares the two equally likely. The
// registry has no encoding for a tie, so this must end up as no data point at
// all rather than as an arbitrary coin flip — which makes it worth injecting.
const TIE_REFUSAL_RATE = 0.03;

// Rate at which a judgment contradicts the fake's own beliefs, so the pairwise
// coherence check has real violations to find. See the normal path below.
const INCOHERENCE_RATE = 0.05;

/** The offline stand-in for `generatePairwiseForecast`. Same contract as the
 *  direct fake: deterministic, and hostile at fixed rates. */
export async function fakeGeneratePairwiseForecast(
  options: GeneratePairwiseForecastOptions,
): Promise<PairwiseInferenceResult> {
  const { model, pair, combination, identifier } = options;
  const { marketA, marketB } = pair;

  const combo = `${combination.isANegated ? 1 : 0}${combination.isBNegated ? 1 : 0}`;
  const seed = `${model}|${marketA.externalId}|${marketB.externalId}|${combo}|${identifier ?? ""}`;
  const roll = (salt: string) => unit(`${seed}|${salt}`);

  const latencyMs = parseInt(process.env.NOISEBENCH_FAKE_LATENCY_MS || "5", 10);
  if (latencyMs > 0) {
    await sleep(Math.round(latencyMs * (0.5 + roll("latency"))));
  }

  const result: PairwiseInferenceResult = {
    model,
    provider: "fake-provider",
    systemPrompt: PAIRWISE_SYSTEM_PROMPT,
    userPrompt: buildPairwiseUserPrompt(pair, combination),
    rawResponse: null,
    reasoning: null,
    finishReason: "stop",
    choice: null,
    cost: 1234,
    tokensIn: 1000 + Math.floor(roll("tin") * 4000),
    tokensOut: 200 + Math.floor(roll("tout") * 800),
    reasoningTokens: Math.floor(roll("rtok") * 2000),
    timeMs: latencyMs,
    attempts: 1,
    errors: [],
    usage: { fake: true, prompt_tokens: 1000, completion_tokens: 200 },
  };

  if (roll("hardfail") < HARD_FAILURE_RATE) {
    result.rawResponse = null;
    result.finishReason = null;
    result.cost = null;
    result.tokensIn = null;
    result.tokensOut = null;
    result.reasoningTokens = null;
    result.usage = null;
    result.attempts = 4;
    result.errors = [
      { code: 429, message: "Rate limit exceeded (simulated)" },
      { code: "unknown", message: NASTY_TEXT },
    ];
    return result;
  }

  if (roll("tie") < TIE_REFUSAL_RATE) {
    result.rawResponse =
      "These two outcomes look equally likely to me; I decline to rank them. " +
      NASTY_TEXT;
    result.attempts = 4;
    result.errors = [
      {
        code: "unparseable",
        message:
          "No 'More likely: A' or 'More likely: B' found. Response head: These two…",
      },
    ];
    return result;
  }

  if (roll("unparseable") < UNPARSEABLE_RATE) {
    result.rawResponse =
      "I cannot responsibly compare these without more information. " +
      NASTY_TEXT;
    result.finishReason = roll("truncated") < 0.5 ? "length" : "stop";
    result.attempts = 4;
    result.errors = [
      {
        code: "unparseable",
        message:
          "No 'More likely: A' or 'More likely: B' found. Response head: I cannot…",
      },
    ];
    return result;
  }

  // --- The normal path. ----------------------------------------------------
  // Rank the two sides off the same per-market anchors the direct fake uses,
  // with the negated side taking the complement — so the four combinations of
  // a pair are coherent with each other by construction.
  const anchorA = marketAnchor(model, marketA.externalId);
  const anchorB = marketAnchor(model, marketB.externalId);
  const sideA = combination.isANegated ? 1 - anchorA : anchorA;
  const sideB = combination.isBNegated ? 1 - anchorB : anchorB;
  const coherent = sideA > sideB ? "A" : "B";

  // Then break that coherence on purpose, at a fixed rate. Without this the
  // fake is a *perfectly* coherent forecaster, verify-run's check G reports a
  // 0.00% violation rate, and a rehearsal proves nothing about the check — a
  // pairwise noise metric that can only ever report zero would pass just as
  // happily if it were measuring nothing at all.
  //
  // Flipping per CALL rather than per pair is what makes it visible: a couple
  // is violated when exactly one of its two combinations flips, so this rate
  // yields roughly 2r(1-r) ≈ 9.5% violated couples.
  const choice =
    roll("incoherent") < INCOHERENCE_RATE
      ? coherent === "A"
        ? "B"
        : "A"
      : coherent;

  result.reasoning = "r".repeat(
    roll("huge") < HUGE_REASONING_RATE ? 100_000 : 400,
  );
  result.rawResponse =
    `Weighing both outcomes against their base rates. ${NASTY_TEXT}\n\n` +
    `More likely: ${choice}`;

  if (roll("nullcost") < NULL_COST_RATE) result.cost = null;

  // Parse via the real parser, so the fake exercises production's code path.
  result.choice = parsePairwiseChoice(result.rawResponse);
  return result;
}
