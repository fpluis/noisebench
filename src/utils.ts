import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import {
  BenchmarkConfig,
  Dataset,
  DatasetEvent,
  DatasetMarket,
  ForecastRegistryConfig,
  ModelConfigEntry,
  NormalizedModel,
  PairwiseChoice,
  PairwiseCombination,
  ResolvedPair,
} from "./types";

// Base mainnet.
export const BASE_CHAIN_ID = 8453;
// Base Sepolia testnet — the target for end-to-end rehearsals.
export const BASE_SEPOLIA_CHAIN_ID = 84532;

// Public RPC endpoints appended as rotation fallbacks so on-chain submission
// survives any single provider rate-limiting or returning 5xx.
//
// Keyed by chain id, and ONLY the entry for the active chain is ever appended.
// Mixing chains in one rotation is not a cosmetic problem: providers are built
// with `staticNetwork` (the chain id is asserted, never queried), so a single
// rotation onto a foreign endpoint either signs for the wrong chain or, far
// worse, lands a real transaction on mainnet during a testnet run.
const DEFAULT_RPC_URLS: Record<number, string[]> = {
  [BASE_CHAIN_ID]: [
    "https://mainnet.base.org",
    "https://base.llamarpc.com",
    "https://base-rpc.publicnode.com",
    "https://base.meowrpc.com",
    "https://base.drpc.org",
  ],
  [BASE_SEPOLIA_CHAIN_ID]: [
    "https://sepolia.base.org",
    "https://base-sepolia-rpc.publicnode.com",
    "https://base-sepolia.drpc.org",
  ],
};

const MASTER_MNEMONIC_PATH = path.join(process.cwd(), ".master");
const DEFAULT_FUNDER_KEY_PATH = path.join(process.cwd(), ".funder.txt");

// How long to wait for a funding transfer to confirm before rotating endpoint.
// Matches the registry client's own confirmation window.
const FUND_CONFIRM_TIMEOUT_MS = 90000;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Parsing model output
// ---------------------------------------------------------------------------

/**
 * Extract the forecast probability from a model response. Per the system
 * prompt, a well-behaved model ends its answer with `Probability: X%` where X
 * is a percentage. We take the LAST such occurrence (the final answer), tolerate
 * whitespace and an optional `**bold**`, and return the value as a decimal in
 * [0, 1]. Returns null when no valid probability can be found.
 */
export const parseForecastProbability = (
  content: string | null | undefined,
): number | null => {
  if (!content) return null;
  // Match "Probability: 72.5%", "probability = 72.5 %", "**Probability:** 5%".
  const regex =
    /probabilit(?:y|ies)\s*[:=]?\s*\*{0,2}\s*([0-9]+(?:\.[0-9]+)?)\s*%/gi;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = regex.exec(content)) !== null) {
    last = match[1];
  }
  if (last === null) return null;

  const percent = Number(last);
  if (!Number.isFinite(percent)) return null;
  const probability = percent / 100;
  // Clamp into the (0, 1) open interval the system prompt asks for.
  if (probability <= 0) return 0.0001;
  if (probability >= 1) return 0.9999;
  return probability;
};

/**
 * Extract the ranking choice from a pairwise model response. Per the pairwise
 * system prompt, the answer ends with `More likely: A` or `More likely: B`. As
 * with the probability parser we take the LAST occurrence (the final answer,
 * not the working), tolerate whitespace, an optional `**bold**` and an optional
 * "Market" before the letter, and return null when there is no usable choice.
 *
 * A model that refuses to choose — "they are equally likely" — parses as null
 * and is never recorded. That is deliberate: the registry has no encoding for a
 * tie, because a coin-flip judgment is noise rather than data.
 */
export const parsePairwiseChoice = (
  content: string | null | undefined,
): PairwiseChoice | null => {
  if (!content) return null;
  // Match "More likely: A", "**More likely:** Market B", "more likely = a".
  const regex =
    /more\s+likely\s*[:=]?\s*\*{0,2}\s*(?:market\s+)?\*{0,2}\s*([AB])\b/gi;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = regex.exec(content)) !== null) {
    last = match[1];
  }
  if (last === null) return null;
  return last.toUpperCase() as PairwiseChoice;
};

// ---------------------------------------------------------------------------
// Outcome naming
// ---------------------------------------------------------------------------

/**
 * The market outcome a phrasing corresponds to, as recorded on-chain.
 *
 * The negated question asks whether the market FAILS to resolve Yes, so a "Yes"
 * answer to it is the market's "No". Both the direct and the pairwise path map
 * phrasing to outcome through here, so the two can never drift apart.
 */
export const outcomeForPhrasing = (isNegated: boolean): string =>
  isNegated ? "No" : "Yes";

/**
 * The combination whose answer must be the exact opposite of this one.
 *
 * Flipping both sides of a comparison inverts it for any coherent forecaster:
 * `P(A) > P(B)` iff `1 - P(A) < 1 - P(B)`. This holds whatever the model
 * believes, which is what makes it a usable noise probe rather than an
 * accuracy judgment.
 */
export const complementaryCombination = (
  combination: PairwiseCombination,
): PairwiseCombination => ({
  isANegated: !combination.isANegated,
  isBNegated: !combination.isBNegated,
});

// ---------------------------------------------------------------------------
// Config loading + normalization
// ---------------------------------------------------------------------------

export const loadJsonFile = <T>(filePath: string): T => {
  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  return JSON.parse(fs.readFileSync(resolved, "utf8")) as T;
};

/**
 * Load a dataset: a JSON object `{ events, pairs }`.
 *
 * Both keys are required, `pairs` included. A dataset that runs no comparisons
 * says so with an empty array — inferring that from a missing key would make an
 * authoring slip indistinguishable from a deliberate direct-only run, and the
 * two differ by every pairwise row the run was supposed to produce.
 */
export const loadDataset = (filePath: string): Dataset => {
  const raw = loadJsonFile<unknown>(filePath);

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `Dataset ${filePath} must be a JSON object { events, pairs }`,
    );
  }

  const { events, pairs } = raw as Partial<Dataset>;
  if (!Array.isArray(events)) {
    throw new Error(`Dataset ${filePath} must have an "events" array`);
  }
  if (!Array.isArray(pairs)) {
    throw new Error(
      `Dataset ${filePath} must have a "pairs" array (use [] to run no comparisons)`,
    );
  }
  for (const [index, pair] of pairs.entries()) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      pair.some((slug) => typeof slug !== "string" || slug.length === 0)
    ) {
      throw new Error(
        `Dataset ${filePath}: pairs[${index}] must be a [slugA, slugB] tuple of two non-empty strings`,
      );
    }
  }

  return { events, pairs };
};

/**
 * Resolve each `[slugA, slugB]` pair to the markets it names, along with the
 * events that carry their rules and research.
 *
 * Every failure here is a dataset authoring bug that would otherwise surface as
 * a reverted transaction or a silently short run, so all of them are fatal:
 *
 *   - a slug naming no market, or naming more than one (slugs are the only
 *     handle a pair has, so an ambiguous one has no correct resolution);
 *   - a market paired with itself, which the contract rejects outright with
 *     `IdenticalMarkets`;
 *   - the same pair listed twice, which would collide on the run's unique key
 *     and quietly produce fewer rows than the run planned for.
 *
 * The REVERSED pair is allowed and distinct: the four phrasing combinations
 * always present the same market first, so listing `[B, A]` as well is the only
 * way to probe position bias.
 */
export const resolvePairs = (dataset: Dataset): ResolvedPair[] => {
  const bySlug = new Map<
    string,
    { event: DatasetEvent; market: DatasetMarket }
  >();
  const ambiguous = new Set<string>();
  for (const event of dataset.events) {
    for (const market of event.markets) {
      if (bySlug.has(market.slug)) ambiguous.add(market.slug);
      bySlug.set(market.slug, { event, market });
    }
  }

  const seen = new Set<string>();
  return dataset.pairs.map(([slugA, slugB], index) => {
    const where = `pairs[${index}] (${slugA}, ${slugB})`;
    for (const slug of [slugA, slugB]) {
      if (!bySlug.has(slug)) {
        throw new Error(
          `${where}: no market in this dataset has slug "${slug}"`,
        );
      }
      if (ambiguous.has(slug)) {
        throw new Error(
          `${where}: slug "${slug}" is used by more than one market, so the pair is ambiguous`,
        );
      }
    }
    if (slugA === slugB) {
      throw new Error(
        `${where}: a market cannot be compared against itself — the contract reverts with IdenticalMarkets`,
      );
    }
    const key = `${slugA} ${slugB}`;
    if (seen.has(key)) {
      throw new Error(`${where}: duplicate pair, already listed earlier`);
    }
    seen.add(key);

    const a = bySlug.get(slugA)!;
    const b = bySlug.get(slugB)!;
    return {
      eventA: a.event,
      marketA: a.market,
      eventB: b.event,
      marketB: b.market,
    };
  });
};

// How much of a dataset to actually run. Both dials are caps: unset means "all".
export interface DatasetSliceOptions {
  maxMarkets?: number;
  maxPairs?: number;
}

/**
 * Take a deterministic sub-dataset, so a run can be rehearsed at a fraction of
 * its size and then widened without redoing the rehearsal.
 *
 * Slicing the REAL dataset file is what makes that widening work. Markets are
 * upserted on `(external_id, platform_id)` and resume keys off the resulting
 * market id, so a slice of the same file produces byte-identical ids to the
 * full run — every row the slice wrote is a row the full run would have
 * written, and `--resume` skips exactly those. A separately authored small
 * dataset gives no such guarantee: one edited external id silently turns a
 * resumed run into a partly duplicated one.
 *
 * Pairs are selected first and their markets are mandatory, because a pair
 * whose markets were dropped is unresolvable — `--max-markets` only decides how
 * many *further* markets come along.
 */
export const sliceDataset = (
  dataset: Dataset,
  { maxMarkets, maxPairs }: DatasetSliceOptions,
): Dataset => {
  if (maxMarkets === undefined && maxPairs === undefined) return dataset;

  const pairs =
    maxPairs === undefined
      ? dataset.pairs
      : dataset.pairs.slice(0, Math.max(0, maxPairs));

  // Dataset order is the order markets are upserted, and therefore the order
  // their ids are assigned in. Preserve it everywhere.
  const ordered: DatasetMarket[] = [];
  for (const event of dataset.events) ordered.push(...event.markets);

  const required = new Set<string>();
  for (const [slugA, slugB] of pairs) {
    required.add(slugA);
    required.add(slugB);
  }

  const limit =
    maxMarkets === undefined ? ordered.length : Math.max(0, maxMarkets);
  const keep = new Set<string>();
  for (const market of ordered) {
    if (required.has(market.slug)) keep.add(market.slug);
  }
  if (keep.size > limit) {
    throw new Error(
      `--max-markets ${limit} is too small: the first ${pairs.length} pair(s) reference ` +
        `${keep.size} distinct market(s), and dropping one would leave a pair unresolvable. ` +
        `Raise --max-markets to ${keep.size} or lower --max-pairs.`,
    );
  }
  for (const market of ordered) {
    if (keep.size >= limit) break;
    keep.add(market.slug);
  }

  const events = dataset.events
    .map((event) => ({
      ...event,
      markets: event.markets.filter((market) => keep.has(market.slug)),
    }))
    .filter((event) => event.markets.length > 0);

  return { events, pairs };
};

export interface DatasetValidation {
  events: number;
  markets: number;
  pairs: number;
  warnings: string[];
}

/**
 * Check a dataset for the authoring mistakes that produce WRONG data rather
 * than missing data, and report every one of them at once.
 *
 * The load-bearing check is `negatedQuestion`. When it is absent the inference
 * path silently falls back to the base question, but the row is still written
 * with `is_negated = true` and `outcome = 'No'` — and published on-chain as
 * that market's "No" at the probability the model gave for its "Yes". Nothing
 * downstream can tell: every structural check passes, and it surfaces only as
 * a coherence mean near 1.0, which is indistinguishable from a global
 * inversion bug. It has to be caught here, before anything is written.
 *
 * Errors accumulate rather than throwing at the first one: a dataset is
 * authored in one pass, so it should be fixable in one pass.
 */
export const validateDataset = (
  dataset: Dataset,
  label = "dataset",
): DatasetValidation => {
  const errors: string[] = [];
  const warnings: string[] = [];

  const eventExternalIds = new Map<string, number>();
  const eventSlugs = new Map<string, number>();
  const marketExternalIds = new Map<string, string>();
  const marketSlugs = new Map<string, string>();
  let marketCount = 0;

  const nonEmpty = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;

  const checkDate = (value: unknown, where: string, field: string): void => {
    if (value === undefined || value === null) return;
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
      errors.push(
        `${where}: ${field} is not a parseable date (${String(value)})`,
      );
    }
  };

  if (dataset.events.length === 0) {
    errors.push("dataset has no events");
  }

  dataset.events.forEach((event, eventIndex) => {
    const where = `events[${eventIndex}]${event.slug ? ` (${event.slug})` : ""}`;

    if (!nonEmpty(event.externalId))
      errors.push(`${where}: externalId is required`);
    if (!nonEmpty(event.slug)) errors.push(`${where}: slug is required`);
    if (!nonEmpty(event.title)) errors.push(`${where}: title is required`);
    checkDate(event.startDate, where, "startDate");
    checkDate(event.endDate, where, "endDate");

    // The upsert conflict key. A duplicate silently merges two events into one
    // row, taking the second one's markets with it.
    if (nonEmpty(event.externalId)) {
      const seen = eventExternalIds.get(event.externalId);
      if (seen !== undefined) {
        errors.push(
          `${where}: externalId "${event.externalId}" already used by events[${seen}] — ` +
            `the two would upsert into a single row`,
        );
      } else {
        eventExternalIds.set(event.externalId, eventIndex);
      }
    }
    if (nonEmpty(event.slug)) {
      const seen = eventSlugs.get(event.slug);
      if (seen !== undefined) {
        warnings.push(
          `${where}: slug "${event.slug}" is also used by events[${seen}]`,
        );
      } else {
        eventSlugs.set(event.slug, eventIndex);
      }
    }

    if (!nonEmpty(event.research)) {
      warnings.push(
        `${where}: no research blob — the model gets no context for this event`,
      );
    }
    if (!Array.isArray(event.markets) || event.markets.length === 0) {
      errors.push(`${where}: must list at least one market`);
      return;
    }

    event.markets.forEach((market, marketIndex) => {
      marketCount++;
      const at = `${where}.markets[${marketIndex}]${market.slug ? ` (${market.slug})` : ""}`;

      if (!nonEmpty(market.externalId))
        errors.push(`${at}: externalId is required`);
      if (!nonEmpty(market.slug)) errors.push(`${at}: slug is required`);
      if (!nonEmpty(market.question))
        errors.push(`${at}: question is required`);
      checkDate(market.startDate, at, "startDate");
      checkDate(market.endDate, at, "endDate");

      // The whole negated modality depends on this one field.
      if (!nonEmpty(market.negatedQuestion)) {
        errors.push(
          `${at}: negatedQuestion is required — without it the negated phrasing asks the ` +
            `BASE question but is still recorded, and published on-chain, as this market's "No"`,
        );
      } else if (
        nonEmpty(market.question) &&
        market.negatedQuestion.trim() === market.question.trim()
      ) {
        errors.push(
          `${at}: negatedQuestion is identical to question — the negated phrasing would ` +
            `record a "Yes" answer as this market's "No"`,
        );
      }

      if (nonEmpty(market.externalId)) {
        const seen = marketExternalIds.get(market.externalId);
        if (seen !== undefined) {
          errors.push(
            `${at}: externalId "${market.externalId}" already used at ${seen} — ` +
              `the two would upsert into a single row`,
          );
        } else {
          marketExternalIds.set(market.externalId, at);
        }
      }
      // Pairs are resolved by slug, so an ambiguous one has no correct answer.
      if (nonEmpty(market.slug)) {
        const seen = marketSlugs.get(market.slug);
        if (seen !== undefined) {
          errors.push(
            `${at}: slug "${market.slug}" already used at ${seen} — pairs resolve by slug, ` +
              `so this one is ambiguous`,
          );
        } else {
          marketSlugs.set(market.slug, at);
        }
      }

      if (
        market.description !== undefined &&
        market.description.trim().length < 20
      ) {
        warnings.push(
          `${at}: description is very short — resolution rules may be missing`,
        );
      }
    });
  });

  // Only worth attempting once slugs are known to be sane; otherwise every pair
  // reports a failure caused by a market error already listed above.
  if (errors.length === 0) {
    try {
      resolvePairs(dataset);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `${label} failed validation with ${errors.length} error(s):\n` +
        errors.map((e) => `  - ${e}`).join("\n"),
    );
  }

  return {
    events: dataset.events.length,
    markets: marketCount,
    pairs: dataset.pairs.length,
    warnings,
  };
};

export const loadBenchmarkConfig = (filePath: string): BenchmarkConfig => {
  const config = loadJsonFile<BenchmarkConfig>(filePath);
  if (!config.models || config.models.length === 0) {
    throw new Error(
      `Benchmark config ${filePath} must list at least one model`,
    );
  }
  if (!config.name) {
    throw new Error(`Benchmark config ${filePath} must have a "name"`);
  }
  config.promptIterations = config.promptIterations ?? 4;
  config.pairwiseIterations = config.pairwiseIterations ?? 2;
  return config;
};

export const normalizeModel = (entry: ModelConfigEntry): NormalizedModel => {
  if (typeof entry === "string") return { slug: entry };
  const providerOrder = entry.provider
    ? Array.isArray(entry.provider)
      ? entry.provider
      : [entry.provider]
    : undefined;
  return { slug: entry.slug, providerOrder };
};

// A filesystem-safe forecaster name derived from the model slug, e.g.
// "openai/gpt-5.6-luna" -> "openai-gpt-5.6-luna".
export const forecasterNameFromModel = (slug: string): string =>
  slug.replace(/[/:]/g, "-");

// ---------------------------------------------------------------------------
// ForecastRegistry config from env
// ---------------------------------------------------------------------------

/**
 * Resolve the target chain from `CHAIN_ID`, defaulting to Base mainnet.
 *
 * Writing to mainnet is irreversible and costs real money, so it must be asked
 * for twice: once by chain id, and once by `ALLOW_MAINNET=true`. Every other
 * chain (Base Sepolia, a local hardhat/anvil node) needs no such ceremony.
 */
export const resolveChainId = (): number => {
  const raw = process.env.CHAIN_ID;
  const chainId = raw ? parseInt(raw, 10) : BASE_CHAIN_ID;
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`Invalid CHAIN_ID "${raw}" — expected a positive integer`);
  }
  if (
    chainId === BASE_CHAIN_ID &&
    String(process.env.ALLOW_MAINNET).toLowerCase() !== "true"
  ) {
    throw new Error(
      `Refusing to run against Base mainnet (chainId ${BASE_CHAIN_ID}) without ALLOW_MAINNET=true.\n` +
        `  - to rehearse on testnet:  CHAIN_ID=${BASE_SEPOLIA_CHAIN_ID}\n` +
        `  - to run with no chain:    SKIP_ONCHAIN=true\n` +
        `  - to really write mainnet: ALLOW_MAINNET=true`,
    );
  }
  return chainId;
};

export const createForecastRegistryConfigFromEnv =
  (): ForecastRegistryConfig => {
    const contractAddress = process.env.FORECAST_REGISTRY_ADDRESS;
    const chainId = resolveChainId();

    const configuredUrls = (
      process.env.RPC_URLS ||
      process.env.BASE_RPC_URLS ||
      process.env.BASE_RPC_URL ||
      ""
    )
      .split(",")
      .map((url) => url.trim())
      .filter((url) => url.length > 0);

    // Only this chain's public endpoints are eligible as fallbacks; an unknown
    // chain (e.g. a local node on 31337) gets none, so the configured URL is
    // the only one used rather than silently rotating onto a public network.
    const rpcUrls = Array.from(
      new Set([...configuredUrls, ...(DEFAULT_RPC_URLS[chainId] ?? [])]),
    );

    if (!contractAddress) {
      throw new Error(
        "ForecastRegistry configuration incomplete: FORECAST_REGISTRY_ADDRESS is required",
      );
    }
    if (rpcUrls.length === 0) {
      throw new Error(
        `No RPC endpoints for chainId ${chainId}. Set RPC_URLS to a comma-separated list.`,
      );
    }

    return {
      contractAddress,
      chainId,
      rpcUrls,
      batchSize: parseInt(process.env.FORECAST_BATCH_SIZE || "50", 10),
      batchTimeoutMs: parseInt(
        process.env.FORECAST_BATCH_TIMEOUT_MS || "300000",
        10,
      ),
    };
  };

// ---------------------------------------------------------------------------
// Wallet derivation + funding (master mnemonic + funder key)
// ---------------------------------------------------------------------------

export function loadMasterMnemonic(): string {
  if (!fs.existsSync(MASTER_MNEMONIC_PATH)) {
    throw new Error(
      `.master file not found at ${MASTER_MNEMONIC_PATH}. Run 'npm run generate-master-mnemonic' first.`,
    );
  }
  const mnemonic = fs.readFileSync(MASTER_MNEMONIC_PATH, "utf8").trim();
  const words = mnemonic.split(/\s+/);
  if (words.length !== 12 && words.length !== 24) {
    throw new Error(
      `Invalid mnemonic in .master file. Expected 12 or 24 words, got ${words.length}`,
    );
  }
  try {
    ethers.Mnemonic.fromPhrase(mnemonic);
  } catch (error) {
    throw new Error(`Invalid mnemonic in .master file: ${error}`);
  }
  return mnemonic;
}

// Standard Ethereum BIP-44 path: m/44'/60'/0'/0/{index}.
export function deriveWalletFromMnemonic(
  mnemonic: string,
  index: number,
): ethers.HDNodeWallet {
  const derivationPath = `m/44'/60'/0'/0/${index}`;
  try {
    return ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, derivationPath);
  } catch (error) {
    throw new Error(`Failed to derive wallet at index ${index}: ${error}`);
  }
}

export function readFundingPrivateKey(): string {
  const keyPath =
    process.env.FORECAST_FUNDING_PKEY_PATH || DEFAULT_FUNDER_KEY_PATH;
  if (!fs.existsSync(keyPath)) {
    throw new Error(
      `Funding private key file not found at ${keyPath}. Create it or set FORECAST_FUNDING_PKEY_PATH.`,
    );
  }
  const privateKey = fs.readFileSync(keyPath, "utf8").trim();
  const clean = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error(`Invalid private key format in ${keyPath}.`);
  }
  return privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
}

/**
 * Send `amountInEth` ETH from the funder wallet to `targetAddress`, retrying on
 * transient/rate-limit errors. Returns the tx hash once confirmed.
 *
 * `rpcUrls` is the full rotation list, not a single endpoint: a production run
 * funds one wallet per model back-to-back from the same funder, which is
 * exactly the burst that makes a public endpoint start returning 429. Retrying
 * the same URL cannot clear that, so each attempt moves to the next endpoint.
 */
export async function fundWallet(
  targetAddress: string,
  amountInEth: string,
  rpcUrls: string | string[],
  chainId: number,
  maxRetries = 5,
  confirmTimeoutMs = FUND_CONFIRM_TIMEOUT_MS,
): Promise<string> {
  const urls = (Array.isArray(rpcUrls) ? rpcUrls : [rpcUrls]).filter(Boolean);
  if (urls.length === 0) throw new Error("fundWallet requires an RPC URL");

  const privateKey = readFundingPrivateKey();
  const amountWei = ethers.parseEther(amountInEth);

  // Funding runs in the startup loop, before any forecast is made, so an
  // unbounded wait here stalls the entire benchmark with no error to look at.
  // The hash is kept across attempts so a confirmation timeout resumes waiting
  // on the SAME transaction instead of sending a second one — otherwise a slow
  // block turns into two funding transfers out of the funder wallet.
  let pendingHash: string | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        await sleep(Math.min(1000 * Math.pow(2, attempt - 1), 30000));
      }
      const provider = new ethers.JsonRpcProvider(
        urls[attempt % urls.length],
        chainId,
        { staticNetwork: true, batchMaxCount: 1 },
      );
      if (!pendingHash) {
        const fundingWallet = new ethers.Wallet(privateKey, provider);
        const tx = await fundingWallet.sendTransaction({
          to: targetAddress,
          value: amountWei,
        });
        pendingHash = tx.hash;
      }
      const receipt = await provider.waitForTransaction(
        pendingHash,
        1,
        confirmTimeoutMs,
      );
      if (!receipt) {
        // Not mined inside the window. Rotate and keep waiting on the hash.
        throw new Error(
          `funding tx ${pendingHash} not confirmed within ${confirmTimeoutMs}ms`,
        );
      }
      if (receipt.status === 0) {
        throw new Error(`Funding transaction ${pendingHash} reverted`);
      }
      return pendingHash;
    } catch (error) {
      lastError = error;
      const isTransient = String(error)
        .toLowerCase()
        .match(
          /429|too many requests|rate limit|timeout|not confirmed|econnreset|502|503/,
        );
      if (!isTransient) {
        throw new Error(`Failed to fund wallet ${targetAddress}: ${error}`);
      }
    }
  }
  throw new Error(
    `Failed to fund wallet ${targetAddress} after ${maxRetries} attempts: ${lastError}`,
  );
}

// ---------------------------------------------------------------------------
// Tiny CLI arg parser: --flag value / --flag=value / --bool
// ---------------------------------------------------------------------------

export const parseArgs = (argv: string[]): Record<string, string | boolean> => {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const eq = key.indexOf("=");
    if (eq !== -1) {
      out[key.slice(0, eq)] = key.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[key] = argv[++i];
    } else {
      out[key] = true;
    }
  }
  return out;
};
