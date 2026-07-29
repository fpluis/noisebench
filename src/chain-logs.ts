// Bounded event-log queries.
//
// ethers' `queryFilter` defaults to fromBlock 0 / toBlock latest. Against a
// local node that is fine; against Base mainnet it asks a public RPC to scan
// every block ever produced, and they refuse:
//
//   -32062 "Block range is too large"
//
// which surfaces as an opaque `could not coalesce error (code=UNKNOWN_ERROR)`.
// Worse, the caller usually reads that as "the thing I was checking for is
// absent" rather than "the query never ran" — an attribute claim that was never
// looked up looks exactly like one that was never made.
//
// Everything that reads logs goes through here: the registry client's
// attribution check, verify-run's chain reconciliation, and republish's
// recovery scan.

import { ethers } from "ethers";

// Endpoints advertise anything from 10k blocks down to 500, and they do not
// agree — so this is a starting guess that shrinks on rejection rather than a
// value anyone should have to get right.
const DEFAULT_CHUNK_BLOCKS = 2000;
// Below this the scan is so many round-trips that something else is wrong.
const MIN_CHUNK_BLOCKS = 100;

export const logChunkBlocks = (): number => {
  const raw = parseInt(process.env.FORECAST_LOG_CHUNK_BLOCKS || "", 10);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_CHUNK_BLOCKS;
};

// What this process has found actually works, so the shrink is paid once rather
// than at the start of every scan.
let learnedChunk: number | null = null;

const isRangeError = (error: unknown): boolean => {
  const e = error as { message?: unknown; error?: { message?: unknown } };
  const haystack =
    `${e?.error?.message ?? ""} ${e?.message ?? ""}`.toLowerCase();
  return (
    haystack.includes("block range") ||
    haystack.includes("range is too") ||
    haystack.includes("too large") ||
    haystack.includes("limited to") ||
    haystack.includes("exceeds") ||
    haystack.includes("query returned more than")
  );
};

// Deployment blocks are immutable, so one binary search per address per process
// is plenty — and the env var skips even that.
const deploymentBlocks = new Map<string, number>();

/**
 * The block a contract first existed at, so log scans start there rather than
 * at genesis.
 *
 * Found by binary search on `getCode`, which is ~25 calls against a chain the
 * size of Base and needs no explorer API or archive node. Set
 * `FORECAST_REGISTRY_FROM_BLOCK` to skip it.
 */
export async function findDeploymentBlock(
  provider: ethers.Provider,
  address: string,
  chainId: number,
): Promise<number> {
  const configured = parseInt(
    process.env.FORECAST_REGISTRY_FROM_BLOCK || "",
    10,
  );
  if (Number.isInteger(configured) && configured >= 0) return configured;

  const cacheKey = `${chainId}:${address.toLowerCase()}`;
  const cached = deploymentBlocks.get(cacheKey);
  if (cached !== undefined) return cached;

  const latest = await provider.getBlockNumber();
  // If it does not exist at head there is nothing to search for; scanning from
  // 0 would be both useless and enormous.
  if ((await provider.getCode(address, latest)) === "0x") {
    throw new Error(
      `No contract at ${address} on chainId ${chainId} at block ${latest}`,
    );
  }

  let low = 0;
  let high = latest;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const code = await provider.getCode(address, mid);
    if (code === "0x") low = mid + 1;
    else high = mid;
  }
  deploymentBlocks.set(cacheKey, low);
  return low;
}

/**
 * Run `queryFilter` across a bounded range, in chunks the endpoint will accept.
 *
 * Throws rather than returning partial results: a truncated log set is
 * indistinguishable from a genuinely empty one, and every caller here treats
 * "no logs" as a factual claim about the chain.
 */
export async function queryLogsChunked(
  contract: ethers.Contract,
  filter: ethers.ContractEventName,
  fromBlock: number,
  toBlock: number,
  chunkBlocks?: number,
): Promise<(ethers.Log | ethers.EventLog)[]> {
  const out: (ethers.Log | ethers.EventLog)[] = [];
  let chunk = chunkBlocks ?? learnedChunk ?? logChunkBlocks();
  let start = fromBlock;

  while (start <= toBlock) {
    const end = Math.min(start + chunk - 1, toBlock);
    try {
      out.push(...(await contract.queryFilter(filter, start, end)));
      start = end + 1;
    } catch (error) {
      // Endpoints disagree about the cap and report it only by rejecting, so
      // find it by halving rather than by configuration. Retry the SAME start
      // with a smaller window — dropping the chunk would silently return a
      // partial log set, which reads as "this never happened on-chain".
      if (isRangeError(error) && chunk > MIN_CHUNK_BLOCKS) {
        chunk = Math.max(MIN_CHUNK_BLOCKS, Math.floor(chunk / 2));
        learnedChunk = chunk;
        continue;
      }
      throw error;
    }
  }
  if (learnedChunk === null) learnedChunk = chunk;
  return out;
}

/**
 * `queryLogsChunked` over the contract's whole lifetime, resolving the start
 * block from config or by binary search.
 */
export async function queryAllLogs(
  contract: ethers.Contract,
  filter: ethers.ContractEventName,
  provider: ethers.Provider,
  address: string,
  chainId: number,
): Promise<(ethers.Log | ethers.EventLog)[]> {
  const from = await findDeploymentBlock(provider, address, chainId);
  const to = await provider.getBlockNumber();
  return queryLogsChunked(contract, filter, from, to);
}
