// Shared types for noisebench.

export const POLYMARKET_PLATFORM_ID = 1;

// ---------------------------------------------------------------------------
// Dataset payload (datasets/*.json)
// ---------------------------------------------------------------------------

export interface DatasetMarket {
  externalId: string;
  startDate?: string;
  endDate?: string;
  slug: string;
  question: string;
  // Authoring metadata only. The "No" side of a market is asked by naming the
  // outcome and leaving the question, rules and research untouched — never by
  // substituting a rewritten question — so nothing in the inference path reads
  // this. See the header of src/llm.ts for why.
  negatedQuestion?: string;
  description?: string;
  // Orderbook state when the dataset was prepared. Optional because a synthetic
  // or hand-written dataset has no book behind it. These are snapshot INPUTS
  // describing what the crowd thought at prompt time — never outcomes, and
  // never used to score a forecast. Persisted per run by
  // `benchmark_run_market_snapshot`, since a later dataset re-reads them.
  midpoint?: number;
  spread?: number;
  yesLiquidity?: number;
  noLiquidity?: number;
  orderbookSnapshotAt?: string;
}

export interface DatasetEvent {
  externalId: string;
  isNegRisk?: boolean;
  startDate?: string;
  endDate?: string;
  createdAt?: string;
  preparedAt?: string;
  title: string;
  description?: string;
  slug: string;
  tags?: string[];
  markets: DatasetMarket[];
  research?: string;
}

// Two market slugs to be ranked against each other. Slugs, not external ids,
// because they are what a human writing a dataset can actually read.
export type DatasetPair = [string, string];

export interface Dataset {
  events: DatasetEvent[];
  pairs: DatasetPair[];
}

// A dataset pair with both slugs resolved to the market they name and the event
// that carries their rules and research context. The two markets may belong to
// different events — comparing across events is the interesting case.
export interface ResolvedPair {
  eventA: DatasetEvent;
  marketA: DatasetMarket;
  eventB: DatasetEvent;
  marketB: DatasetMarket;
}

/**
 * Which outcome each side of a pair was asked about — `true` for that market's
 * "No", `false` for its "Yes".
 *
 * Every pair is asked in all four combinations. Flipping BOTH sides must invert
 * the answer for any coherent forecaster — if A's "Yes" beats B's "Yes", then
 * A's "No" must lose to B's "No" — so the four combinations form two
 * complementary couples, {00, 11} and {10, 01}. The rate at which a model fails
 * that identity is the pairwise noise metric, exactly as |Yes + No - 1| is the
 * direct one.
 */
export interface PairwiseCombination {
  isANegated: boolean;
  isBNegated: boolean;
}

export const PAIRWISE_COMBINATIONS: readonly PairwiseCombination[] = [
  { isANegated: false, isBNegated: false },
  { isANegated: true, isBNegated: false },
  { isANegated: false, isBNegated: true },
  { isANegated: true, isBNegated: true },
];

// Which side of a pair the model judged more likely.
export type PairwiseChoice = "A" | "B";

// ---------------------------------------------------------------------------
// Benchmark configuration (configs/*.json)
// ---------------------------------------------------------------------------

// A model entry may be a bare OpenRouter slug, or an object that also pins the
// provider so every call routes to the same backend (less run-to-run noise).
export type ModelConfigEntry =
  string | { slug: string; provider?: string | string[] };

export interface BenchmarkConfig {
  name: string;
  description?: string;
  // Optional; the dataset path is normally passed on the CLI. When both are
  // given the CLI wins.
  dataset?: string;
  models: ModelConfigEntry[];
  // Number of times each prompt is repeated per model per modality. Default 4.
  promptIterations: number;
  // Repetitions of each of a pair's four outcome combinations. Separate from
  // `promptIterations` because a pair already costs 4 calls per iteration, so
  // the two dials are set independently. Default 2.
  pairwiseIterations: number;
  // Max concurrent inference calls per forecaster. Default 6.
  concurrency?: number;
  /**
   * Max forecasters running at once. Unset means all of them, which is the
   * historical behaviour.
   *
   * Total in-flight inference is `modelConcurrency * concurrency`, so capping
   * models without raising `concurrency` cuts throughput proportionally. The
   * pg pool must also be able to hold that many writers: keep
   * `PG_POOL_MAX >= modelConcurrency * concurrency + 8` or tasks start failing
   * on the pool's 10s connection timeout rather than on anything real.
   */
  modelConcurrency?: number;
  // Retries for a task that threw AFTER inference (a DB blip, say). Inference
  // has its own retry budget inside runInference and never throws. Default 2.
  taskMaxRetries?: number;
  // Give up on a forecaster once this share of its attempted tasks have failed
  // outright, so one broken model cannot burn the budget. Default 0.2.
  taskFailureAbortRate?: number;
  // Extra passes over whatever is still unfinished once the main pass drains,
  // to mop up transient failures without a manual --resume. Default 1.
  retryPasses?: number;
}

// A model config normalized to a stable shape.
export interface NormalizedModel {
  slug: string;
  providerOrder?: string[];
}

// ---------------------------------------------------------------------------
// Inference result
// ---------------------------------------------------------------------------

export interface InferenceError {
  code: string | number;
  message: string;
}

// Everything captured from a single inference call (across its retries), minus
// whatever was parsed out of it. Both forecast modalities produce one of these,
// and `llm_trace` stores exactly this much.
export interface InferenceTrace {
  model: string;
  provider?: string;
  systemPrompt: string;
  userPrompt: string;
  // The full raw completion text (may be null if every attempt failed).
  rawResponse: string | null;
  reasoning: string | null;
  finishReason: string | null;
  // Cost in nano-USD (round(usd * 1e9)); null when the provider returns none.
  cost: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  reasoningTokens: number | null;
  // Wall-clock time of the successful attempt, in milliseconds.
  timeMs: number;
  attempts: number;
  errors: InferenceError[];
  usage: Record<string, unknown> | null;
}

// A direct-probability inference.
export interface InferenceResult extends InferenceTrace {
  // Probability of a "Yes" resolution, in [0, 1]. Null when unparseable.
  parsedOdds: number | null;
}

// A pairwise rank inference: which of the two presented outcomes is likelier.
// Null when the model gave no usable choice — including when it declared the
// two equally likely, which the registry deliberately cannot represent.
export interface PairwiseInferenceResult extends InferenceTrace {
  choice: PairwiseChoice | null;
}

// ---------------------------------------------------------------------------
// On-chain forecast registry
// ---------------------------------------------------------------------------

export interface ForecastRegistryConfig {
  contractAddress: string;
  // Target chain. Providers pin this via `staticNetwork`, so every URL in
  // `rpcUrls` must serve this exact chain.
  chainId: number;
  // Ordered RPC endpoints; the client rotates on failure.
  rpcUrls: string[];
  batchSize: number; // default 50
  batchTimeoutMs: number; // default 300000 (5 min)
}

// One market-level forecast queued for on-chain submission. `forecastId` links
// back to the public.forecast row so it can be stamped with the tx once mined.
export interface PendingForecastRecord {
  forecastId: number;
  forecasterName: string;
  platformId: number;
  marketId: string;
  outcome: string;
  // Probability in [0, 1]; encoded on-chain as basis points round(p * 10000).
  probability: number;
}

/**
 * One pairwise judgment queued for on-chain submission. The two sides carry
 * independent platform ids because the contract allows cross-venue comparisons;
 * this benchmark only produces Polymarket-vs-Polymarket pairs today.
 *
 * `marketAOutcome`/`marketBOutcome` are the outcome each side was asked about:
 * a negated side is that market's "No".
 */
export interface PendingPairwiseForecastRecord {
  pairwiseForecastId: number;
  forecasterName: string;
  platformIdA: number;
  marketAId: string;
  marketAOutcome: string;
  platformIdB: number;
  marketBId: string;
  marketBOutcome: string;
  isALikelier: boolean;
}

/**
 * One kind of queued work for a forecaster's wallet, with the nonce and tx hash
 * of its in-flight submission.
 *
 * Direct and pairwise forecasts need different contract calls, so they cannot
 * share a transaction — but they DO share a wallet, and therefore a nonce
 * sequence. They are kept as two queues under one batch (rather than two
 * independent batches) so that a single `inFlight` guard serializes them: two
 * concurrent submissions from one wallet would both read the same pending
 * nonce and one would silently replace the other.
 */
export interface BatchQueue<T> {
  records: T[];
  nonce?: number;
  pendingTxHash?: string;
}

export interface ForecasterBatch {
  forecasterName: string;
  forecasts: BatchQueue<PendingForecastRecord>;
  pairwise: BatchQueue<PendingPairwiseForecastRecord>;
  firstRequestTime: Date;
  inFlight?: boolean;
}

export interface ForecastRecordResult {
  success: boolean;
  transactionHash?: string;
  error?: string;
  gasUsed?: number;
  blockNumber?: number;
}

export interface ForecasterWallet {
  id: number;
  forecasterId: number;
  address: string;
  createdAt: Date;
  derivationIndex?: number;
}
