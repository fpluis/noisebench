import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import {
  BenchmarkConfig,
  Dataset,
  ForecastRegistryConfig,
  ModelConfigEntry,
  NormalizedModel,
} from "./types";

// Base mainnet.
export const BASE_CHAIN_ID = 8453;

// Public Base RPC endpoints appended as rotation fallbacks so on-chain
// submission survives any single provider rate-limiting or returning 5xx.
const DEFAULT_BASE_RPC_URLS: string[] = [
  "https://mainnet.base.org",
  "https://base.llamarpc.com",
  "https://base-rpc.publicnode.com",
  "https://base.meowrpc.com",
  "https://base.drpc.org",
];

const MASTER_MNEMONIC_PATH = path.join(process.cwd(), ".master");
const DEFAULT_FUNDER_KEY_PATH = path.join(process.cwd(), ".funder.txt");

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

export const loadDataset = (filePath: string): Dataset => {
  const dataset = loadJsonFile<Dataset>(filePath);
  if (!Array.isArray(dataset)) {
    throw new Error(`Dataset ${filePath} must be a JSON array of events`);
  }
  return dataset;
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

export const createForecastRegistryConfigFromEnv =
  (): ForecastRegistryConfig => {
    const contractAddress = process.env.FORECAST_REGISTRY_ADDRESS;

    const configuredUrls = (
      process.env.BASE_RPC_URLS ||
      process.env.BASE_RPC_URL ||
      ""
    )
      .split(",")
      .map((url) => url.trim())
      .filter((url) => url.length > 0);

    const rpcUrls = Array.from(
      new Set([...configuredUrls, ...DEFAULT_BASE_RPC_URLS]),
    );

    if (!contractAddress) {
      throw new Error(
        "ForecastRegistry configuration incomplete: FORECAST_REGISTRY_ADDRESS is required",
      );
    }

    return {
      contractAddress,
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
 */
export async function fundWallet(
  targetAddress: string,
  amountInEth: string,
  rpcUrl: string,
  maxRetries = 5,
): Promise<string> {
  const provider = new ethers.JsonRpcProvider(rpcUrl, BASE_CHAIN_ID, {
    staticNetwork: true,
    batchMaxCount: 1,
  });
  const fundingWallet = new ethers.Wallet(readFundingPrivateKey(), provider);
  const amountWei = ethers.parseEther(amountInEth);

  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        await sleep(Math.min(1000 * Math.pow(2, attempt - 1), 30000));
      }
      const tx = await fundingWallet.sendTransaction({
        to: targetAddress,
        value: amountWei,
      });
      const receipt = await tx.wait();
      if (!receipt) throw new Error("Transaction receipt not found");
      return tx.hash;
    } catch (error) {
      lastError = error;
      const isRateLimit = String(error)
        .toLowerCase()
        .match(/429|too many requests|rate limit/);
      if (!isRateLimit) {
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
