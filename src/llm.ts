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
} from "./types";
import { parseForecastProbability, sleep } from "./utils";
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
  const code = e?.error?.code ?? e?.code ?? e?.status ?? "unknown";
  const message =
    e?.error?.message ??
    (e instanceof Error ? e.message : undefined) ??
    (typeof e === "string" ? e : JSON.stringify(e));
  return { code, message: String(message).slice(0, 2000) };
};

/**
 * Run one forecast inference for a single {market, isNegated}. Retries up to
 * `maxRetries` times with exponential backoff on transport errors, provider
 * errors, empty responses, and unparseable outputs (a valid forecast MUST end
 * with `Probability: X%`). Never throws for an inference failure — it always
 * resolves with an InferenceResult whose `errors` array records what happened
 * and whose `parsedOdds` is null if no usable forecast was obtained.
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

  const systemPrompt = SYSTEM_PROMPT;
  const userPrompt = buildUserPrompt(event, market, isNegated);

  const result: InferenceResult = {
    model,
    provider: undefined,
    systemPrompt,
    userPrompt,
    rawResponse: null,
    reasoning: null,
    finishReason: null,
    parsedOdds: null,
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

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    result.attempts = attempt + 1;
    const startedAt = Date.now();
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
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
      result.provider = completion.provider ?? result.provider;
      result.rawResponse =
        typeof message.content === "string"
          ? message.content
          : String(message.content ?? "");
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

      const parsed = parseForecastProbability(result.rawResponse);
      if (parsed !== null) {
        result.parsedOdds = parsed;
        return result;
      }

      // Content came back but had no `Probability: X%` — treat as a soft
      // failure/refusal and retry for a parseable answer.
      result.errors.push({
        code: "unparseable",
        message: `No 'Probability: X%' found. Response head: ${(
          result.rawResponse ?? ""
        ).slice(0, 300)}`,
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

  return result;
}
