// All OpenRouter / LLM inference logic for noisebench lives here.
//
// A single forecast call takes one market (in either its base or negated
// phrasing) plus the event's research context, asks the model for a plain-text
// forecast ending in `Probability: X%`, and returns everything we can capture
// about the call: the parsed odds, the raw response and reasoning, token and
// cost accounting, timing, the resolved provider, and the payloads of any errors
// or refusals encountered across retries.

import {
  DatasetEvent,
  DatasetMarket,
  InferenceError,
  InferenceResult,
  InferenceTrace,
  PairwiseChoice,
  PairwiseCombination,
  PairwiseInferenceResult,
  ResolvedPair,
} from "./types";
import { parseForecastProbability, parsePairwiseChoice, sleep } from "./utils";
import { logger } from "./logger";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Explicitly setting OpenRouter's own defaults so the run is self-documenting
// and reproducible regardless of any future change to those defaults.
const DEFAULT_TEMPERATURE = 1;
const DEFAULT_TOP_P = 1;
const DEFAULT_REASONING_EFFORT: "low" | "medium" | "high" = "medium";
const DEFAULT_VERBOSITY: "low" | "medium" | "high" = "medium";
const DEFAULT_MAX_TOKENS = 8000;
const DEFAULT_MAX_RETRIES = 3; // 3 retries => up to 4 attempts total.

/**
 * Hard ceiling on a single inference call.
 *
 * Without one, a connection that stalls after the headers blocks its worker for
 * undici's 300s default — and because workers are a fixed pool, one stalled
 * call permanently removes a slot from that model's concurrency. Capping models
 * makes it worse, not better: a stuck call then holds a share of the whole run's
 * throughput. A timeout is a retryable attempt like any other.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 180000;

const requestTimeoutMs = (): number => {
  const raw = process.env.OPENROUTER_TIMEOUT_MS;
  if (!raw) return DEFAULT_REQUEST_TIMEOUT_MS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_REQUEST_TIMEOUT_MS;
};

// The system prompt carries the generic task framing, output format and rules.
export const SYSTEM_PROMPT = `You are a forecasting expert with the goal of providing the most accurate forecast for a single market.

Note that market consensus is that only events that happen between the market's start and end date count, regardless of whether they happened already in the past. So if the market asks whether an event will happen by a given date, only occurrences after the listed start date matter to resolve to "Yes".

Your task: given a market's details, provide a forecast in plain text for the event that ends with 'Probability: X%' at the very end. Express the probability as a positive number with up to 2 decimal places, ie a number between '0.01%' and '99.99%'`;

// The user prompt carries the specifics of the market being forecast. The
// `question` swaps to the negated phrasing when `isNegated` is set; a coherent
// model should assign complementary probabilities to the two phrasings, and the
// gap between them is exactly the noise this benchmark measures.
export const buildUserPrompt = (
  event: DatasetEvent,
  market: DatasetMarket,
  isNegated: boolean,
): string => {
  const question = isNegated
    ? (market.negatedQuestion ?? market.question)
    : market.question;
  const rules = market.description || event.description || "N/A";
  const startDate = market.startDate ?? event.startDate ?? "N/A";
  const endDate = market.endDate ?? event.endDate ?? "N/A";

  return `This is the market you must forecast:

- Event title: ${event.title}
- Market question: ${question}
- Market Rules: ${rules}
- Possible outcomes: Yes (reference outcome), No
- Start Date: ${startDate}
- End Date: ${endDate}

Current timestamp: ${new Date().toISOString()}

This is some recent context we have gathered to help understand the event, provided between "===" blocks below:
===
${event.research ?? "No additional context available."}
===`;
};

// The pairwise system prompt asks for a RANK, not a probability. Nothing is
// asked about how likely either outcome is — only which of the two is likelier
// — because the whole point of the modality is to test whether a model's
// ordering survives when neither side has a number attached to it.
//
// A tie is refused explicitly: the registry has no encoding for "equally
// likely", so a model that declines to choose produces no data point at all.
export const PAIRWISE_SYSTEM_PROMPT = `You are a forecasting expert with the goal of ranking two outcomes by how likely they are.

Note that market consensus is that only events that happen between a market's start and end date count, regardless of whether they happened already in the past. So if a market asks whether an event will happen by a given date, only occurrences after that market's listed start date matter to resolve to "Yes".

The two outcomes come from separate markets and are not alternatives to one another: both may happen, or neither. You are not being asked how likely either one is, only which of the two is MORE likely.

Your task: given the details of outcome A and outcome B, reason in plain text and then state which is more likely, ending with 'More likely: A' or 'More likely: B' at the very end.

You must pick one. Do not answer that they are equally likely, and do not give probabilities instead of a choice — if they seem close, choose the one you would bet on.`;

// One side of a pair, in whichever phrasing this combination calls for. The
// negated phrasing is swapped in exactly as it is for a direct forecast, so a
// side asked negated is asking about that market's "No".
const buildPairwiseSide = (
  label: "A" | "B",
  event: DatasetEvent,
  market: DatasetMarket,
  isNegated: boolean,
): string => {
  const question = isNegated
    ? (market.negatedQuestion ?? market.question)
    : market.question;
  const rules = market.description || event.description || "N/A";
  const startDate = market.startDate ?? event.startDate ?? "N/A";
  const endDate = market.endDate ?? event.endDate ?? "N/A";

  return `Outcome ${label}:
- Event title: ${event.title}
- Question: ${question}
- Market Rules: ${rules}
- Start Date: ${startDate}
- End Date: ${endDate}`;
};

/**
 * Build the user prompt for one {pair, combination}. Both sides get the same
 * treatment they would get as a standalone forecast — full rules, dates and
 * research — so a pairwise judgment is made on the same information as the
 * direct ones it will be compared against.
 *
 * When both markets belong to the same event their shared research is included
 * once: repeating a multi-kilobyte blob verbatim would pay for the tokens twice
 * and invite the model to read the duplication as emphasis.
 */
export const buildPairwiseUserPrompt = (
  pair: ResolvedPair,
  combination: PairwiseCombination,
): string => {
  const { eventA, marketA, eventB, marketB } = pair;
  const sameEvent = eventA.externalId === eventB.externalId;

  const research = sameEvent
    ? `Context for both outcomes:
===
${eventA.research ?? "No additional context available."}
===`
    : `Context for outcome A:
===
${eventA.research ?? "No additional context available."}
===

Context for outcome B:
===
${eventB.research ?? "No additional context available."}
===`;

  return `These are the two outcomes you must rank:

${buildPairwiseSide("A", eventA, marketA, combination.isANegated)}

${buildPairwiseSide("B", eventB, marketB, combination.isBNegated)}

Current timestamp: ${new Date().toISOString()}

This is some recent context we have gathered to help understand the events, provided between "===" blocks below:

${research}`;
};

export interface GenerateForecastOptions {
  apiKey: string;
  model: string;
  // Providers to route to, in order. When set we pin routing with
  // `allow_fallbacks: false` so every call for a model hits the same backend.
  providerOrder?: string[];
  event: DatasetEvent;
  market: DatasetMarket;
  isNegated: boolean;
  reasoningEffort?: "low" | "medium" | "high";
  verbosity?: "low" | "medium" | "high";
  maxRetries?: number;
  maxTokens?: number;
  // Optional label carried into logs/traces (e.g. "iter-2").
  identifier?: string;
}

const normalizeError = (error: unknown): InferenceError => {
  const e = error as any;
  // A request timeout rejects with a DOMException whose legacy numeric `code`
  // (23) says nothing useful. Its name does, and "this attempt timed out" is a
  // distinction worth keeping in the trace: it is the difference between a
  // provider refusing and a provider never answering.
  if (e?.name === "TimeoutError" || e?.name === "AbortError") {
    return {
      code: e.name,
      message: String(e.message ?? e.name).slice(0, 2000),
    };
  }
  const code = e?.error?.code ?? e?.code ?? e?.status ?? "unknown";
  const message =
    e?.error?.message ??
    (e instanceof Error ? e.message : undefined) ??
    (typeof e === "string" ? e : JSON.stringify(e));
  return { code, message: String(message).slice(0, 2000) };
};

interface RunInferenceRequest<T> {
  apiKey: string;
  model: string;
  providerOrder?: string[];
  systemPrompt: string;
  userPrompt: string;
  reasoningEffort: "low" | "medium" | "high";
  verbosity: "low" | "medium" | "high";
  maxRetries: number;
  maxTokens: number;
  identifier?: string;
  // What a usable answer looks like. Returning null marks the attempt a soft
  // failure — content came back but not in the required format — and buys
  // another retry.
  parse: (raw: string) => T | null;
  // The format the parser wanted, quoted in the unparseable error so a trace
  // says what was missing rather than only that something was.
  expectedFormat: string;
}

/**
 * One inference call with the benchmark's pinned sampling parameters, retried up
 * to `maxRetries` times with exponential backoff on transport errors, provider
 * errors, empty responses, and unparseable outputs. Never throws for an
 * inference failure — it always resolves with the trace of what happened and a
 * `parsed` that is null when no usable answer was obtained.
 *
 * Both modalities share this so that the retry accounting, the rate-limit
 * handling and the cost/token capture cannot drift apart between them: a
 * difference in how a pairwise call is retried would show up as a difference in
 * measured noise.
 */
async function runInference<T>(
  request: RunInferenceRequest<T>,
): Promise<{ trace: InferenceTrace; parsed: T | null }> {
  const {
    apiKey,
    model,
    providerOrder,
    systemPrompt,
    userPrompt,
    reasoningEffort,
    verbosity,
    maxRetries,
    maxTokens,
    identifier,
    parse,
    expectedFormat,
  } = request;

  const result: InferenceTrace = {
    model,
    provider: undefined,
    systemPrompt,
    userPrompt,
    rawResponse: null,
    reasoning: null,
    finishReason: null,
    cost: null,
    tokensIn: null,
    tokensOut: null,
    reasoningTokens: null,
    timeMs: 0,
    attempts: 0,
    errors: [],
    usage: null,
  };

  const provider: Record<string, unknown> = { allow_fallbacks: false };
  if (providerOrder && providerOrder.length > 0) provider.order = providerOrder;

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: DEFAULT_TEMPERATURE,
    top_p: DEFAULT_TOP_P,
    reasoning: { effort: reasoningEffort },
    verbosity,
    max_tokens: maxTokens,
    provider,
    usage: { include: true },
    stream: false,
  };

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (process.env.OPENROUTER_REFERER) {
    headers["HTTP-Referer"] = process.env.OPENROUTER_REFERER;
  }
  if (process.env.OPENROUTER_TITLE) {
    headers["X-Title"] = process.env.OPENROUTER_TITLE;
  }

  const maxAttempts = maxRetries + 1;
  const initialDelay = 1000;
  const maxDelay = 30000;
  const timeoutMs = requestTimeoutMs();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    result.attempts = attempt + 1;
    const startedAt = Date.now();
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        const errorBody: any = await res.json().catch(() => ({
          error: { code: res.status, message: res.statusText },
        }));
        // Honor an explicit rate-limit reset before counting a retry.
        const resetHeader =
          errorBody?.error?.metadata?.headers?.["X-RateLimit-Reset"];
        if (res.status === 429 && resetHeader) {
          const resetMs = Math.max(0, parseInt(resetHeader, 10) - Date.now());
          if (Number.isFinite(resetMs) && resetMs > 0) {
            result.errors.push(normalizeError(errorBody));
            await sleep(Math.min(resetMs, maxDelay));
            continue;
          }
        }
        throw errorBody;
      }

      const completion: any = await res.json();
      const choice = completion?.choices?.[0];
      const message = choice?.message;
      if (!message) {
        throw new Error("Invalid response structure: no message in choices[0]");
      }

      // Capture the call's data regardless of whether it parses — we paid for
      // it, and it's the best fallback if later attempts also fail.
      const usage = completion.usage ?? null;
      const rawResponse =
        typeof message.content === "string"
          ? message.content
          : String(message.content ?? "");
      result.provider = completion.provider ?? result.provider;
      result.rawResponse = rawResponse;
      result.reasoning =
        typeof message.reasoning === "string" ? message.reasoning : null;
      result.finishReason = choice.finish_reason ?? null;
      result.usage = usage;
      result.cost =
        usage && typeof usage.cost === "number"
          ? Math.round(usage.cost * 1e9)
          : result.cost;
      result.tokensIn = usage?.prompt_tokens ?? result.tokensIn;
      result.tokensOut = usage?.completion_tokens ?? result.tokensOut;
      result.reasoningTokens =
        usage?.completion_tokens_details?.reasoning_tokens ??
        result.reasoningTokens;
      result.timeMs = Date.now() - startedAt;

      const parsed = parse(rawResponse);
      if (parsed !== null) {
        return { trace: result, parsed };
      }

      // Content came back but not in the required format — treat as a soft
      // failure/refusal and retry for a parseable answer.
      result.errors.push({
        code: "unparseable",
        message: `No ${expectedFormat} found. Response head: ${rawResponse.slice(0, 300)}`,
      });
    } catch (error) {
      result.errors.push(normalizeError(error));
      logger.logError("Inference attempt failed", error, {
        model,
        identifier,
        attempt: attempt + 1,
      });
    }

    if (attempt < maxAttempts - 1) {
      await sleep(Math.min(initialDelay * Math.pow(2, attempt), maxDelay));
    }
  }

  return { trace: result, parsed: null };
}

/**
 * Run one forecast inference for a single {market, isNegated}. A valid forecast
 * MUST end with `Probability: X%`; anything else is retried. Never throws —
 * `parsedOdds` is null when no usable forecast was obtained, and `errors`
 * records every attempt that failed.
 */
export async function generateForecast(
  options: GenerateForecastOptions,
): Promise<InferenceResult> {
  const {
    apiKey,
    model,
    providerOrder,
    event,
    market,
    isNegated,
    reasoningEffort = DEFAULT_REASONING_EFFORT,
    verbosity = DEFAULT_VERBOSITY,
    maxRetries = DEFAULT_MAX_RETRIES,
    maxTokens = DEFAULT_MAX_TOKENS,
    identifier,
  } = options;

  const { trace, parsed } = await runInference<number>({
    apiKey,
    model,
    providerOrder,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildUserPrompt(event, market, isNegated),
    reasoningEffort,
    verbosity,
    maxRetries,
    maxTokens,
    identifier,
    parse: parseForecastProbability,
    expectedFormat: "'Probability: X%'",
  });

  return { ...trace, parsedOdds: parsed };
}

export interface GeneratePairwiseForecastOptions {
  apiKey: string;
  providerOrder?: string[];
  model: string;
  pair: ResolvedPair;
  combination: PairwiseCombination;
  reasoningEffort?: "low" | "medium" | "high";
  verbosity?: "low" | "medium" | "high";
  maxRetries?: number;
  maxTokens?: number;
  identifier?: string;
}

/**
 * Run one pairwise rank inference for a single {pair, combination}. A valid
 * answer MUST end with `More likely: A` or `More likely: B`; anything else —
 * including a model that insists the two are equally likely — is retried and
 * then recorded as `choice: null`, producing no on-chain record.
 */
export async function generatePairwiseForecast(
  options: GeneratePairwiseForecastOptions,
): Promise<PairwiseInferenceResult> {
  const {
    apiKey,
    model,
    providerOrder,
    pair,
    combination,
    reasoningEffort = DEFAULT_REASONING_EFFORT,
    verbosity = DEFAULT_VERBOSITY,
    maxRetries = DEFAULT_MAX_RETRIES,
    maxTokens = DEFAULT_MAX_TOKENS,
    identifier,
  } = options;

  const { trace, parsed } = await runInference<PairwiseChoice>({
    apiKey,
    model,
    providerOrder,
    systemPrompt: PAIRWISE_SYSTEM_PROMPT,
    userPrompt: buildPairwiseUserPrompt(pair, combination),
    reasoningEffort,
    verbosity,
    maxRetries,
    maxTokens,
    identifier,
    parse: parsePairwiseChoice,
    expectedFormat: "'More likely: A' or 'More likely: B'",
  });

  return { ...trace, choice: parsed };
}
