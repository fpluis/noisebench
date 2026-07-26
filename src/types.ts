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
  negatedQuestion?: string;
  description?: string;
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

export type Dataset = DatasetEvent[];

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
  // Max concurrent inference calls per forecaster. Default 6.
  concurrency?: number;
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

// Everything captured from a single forecast inference (across its retries).
export interface InferenceResult {
  model: string;
  provider?: string;
  systemPrompt: string;
  userPrompt: string;
  // The full raw completion text (may be null if every attempt failed).
  rawResponse: string | null;
  reasoning: string | null;
  finishReason: string | null;
  // Probability of a "Yes" resolution, in [0, 1]. Null when unparseable.
  parsedOdds: number | null;
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

// ---------------------------------------------------------------------------
// On-chain forecast registry
// ---------------------------------------------------------------------------

export interface ForecastRegistryConfig {
  contractAddress: string;
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

export interface ForecasterBatch {
  forecasterName: string;
  records: PendingForecastRecord[];
  firstRequestTime: Date;
  inFlight?: boolean;
  nonce?: number;
  pendingTxHash?: string;
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
