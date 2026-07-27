// A drop-in stand-in for `generateForecast` that never calls OpenRouter.
//
// Its job is to let the *real* benchmark.ts run at full production volume
// (~16,000 tasks) for $0, so that everything downstream of inference — the DB
// mappings, the batching, the on-chain submission, --resume — is exercised at
// the scale it will actually meet. Enabled with NOISEBENCH_FAKE_INFERENCE=true.
//
// Two properties matter:
//
//   1. DETERMINISM. Odds are a pure function of
//      {model, marketId, isNegated, iteration}, so an interrupted run and its
//      --resume produce identical data and the reconciliation checks stay
//      meaningful across restarts.
//
//   2. HOSTILITY. Real runs contain refusals, truncations, null costs, 100 KB
//      reasoning blobs and non-ASCII text. A fake that only emits clean rows
//      proves nothing about the schema, so those cases are injected on purpose
//      at fixed rates.

import { InferenceResult } from "./types";
import { GenerateForecastOptions } from "./llm";
import { SYSTEM_PROMPT, buildUserPrompt } from "./llm";
import { parseForecastProbability, sleep } from "./utils";

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
  // with the negated phrasing landing near its complement plus a per-iteration
  // wobble. That way the coherence check in verify-run.ts reports a realistic
  // non-zero noise figure instead of a suspiciously perfect 0.
  const marketBase = 0.1 + unit(`${model}|${market.externalId}|anchor`) * 0.8;
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
