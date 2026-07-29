import { ethers } from "ethers";
import {
  BatchQueue,
  ForecastRegistryConfig,
  ForecastRecordResult,
  ForecasterBatch,
  PendingForecastRecord,
  PendingPairwiseForecastRecord,
} from "./types";
import {
  FORECAST_REGISTRY_ABI,
  attributeKey,
  toBasisPoints,
  toPairwiseTuple,
} from "./forecast-registry-abi";
import { logger } from "./logger";
import { queryAllLogs } from "./chain-logs";

/**
 * A batch this client gave up on. The records are NOT re-queued — the drop is
 * deliberate, because re-submitting a transaction that may already be in the
 * mempool is how you publish the same forecast twice — so the run has to be
 * told, or a partially-published run reports itself as a complete one.
 *
 * `scripts/republish.ts` is the repair path: it reads the chain first and only
 * re-sends what genuinely never landed.
 */
export interface DroppedBatch {
  forecasterName: string;
  kind: "direct" | "pairwise";
  recordCount: number;
  rowIds: number[];
  reason: string;
  transactionHash?: string;
}

export type BatchDroppedHandler = (dropped: DroppedBatch) => void;

// Invoked after a batch confirms on-chain, so the caller can stamp the affected
// rows with the tx. The tx already cost gas, so a failure here must never
// trigger a re-submission — these handlers are best-effort.
export type BatchSubmittedHandler = (
  records: PendingForecastRecord[],
  transactionHash: string,
  blockNumber: number | undefined,
) => Promise<void>;

export type PairwiseBatchSubmittedHandler = (
  records: PendingPairwiseForecastRecord[],
  transactionHash: string,
  blockNumber: number | undefined,
) => Promise<void>;

/**
 * Accumulates each forecaster's forecasts and submits them to the on-chain
 * ForecastRegistry in batches (by size or after a timeout), one wallet per
 * forecaster.
 */
export class ForecastRegistryClient {
  private readonly config: ForecastRegistryConfig;
  private providers: ethers.JsonRpcProvider[] = [];
  private currentProviderIndex = 0;
  private maxRetries = 3;
  private readonly confirmTimeoutMs = 90000;

  private readonly batches = new Map<string, ForecasterBatch>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  // One wallet per forecaster: keep the raw key so we can re-bind it to whatever
  // provider is currently active after a rotation.
  private readonly privateKeys = new Map<string, string>();
  private readonly addresses = new Map<string, string>();

  private onBatchSubmitted?: BatchSubmittedHandler;
  private onPairwiseBatchSubmitted?: PairwiseBatchSubmittedHandler;
  private onBatchDropped?: BatchDroppedHandler;
  private readonly dropped: DroppedBatch[] = [];
  // address -> attribute key -> value, scanned once on first use.
  private attributeClaims: Map<string, Map<string, string>> | null = null;

  constructor(config: ForecastRegistryConfig) {
    this.config = config;
  }

  setBatchDroppedHandler(handler: BatchDroppedHandler): void {
    this.onBatchDropped = handler;
  }

  /** Every batch abandoned during this run. Empty means everything landed. */
  getDroppedBatches(): readonly DroppedBatch[] {
    return this.dropped;
  }

  getDroppedRecordCount(): number {
    return this.dropped.reduce((sum, d) => sum + d.recordCount, 0);
  }

  /**
   * Record an abandoned batch. Everything that discards records routes through
   * here, so there is exactly one place a forecast can leave the system without
   * reaching the chain — and it is neither silent nor unlogged.
   */
  private reportDrop(drop: DroppedBatch): void {
    this.dropped.push(drop);
    logger.logError(
      `Dropped ${drop.kind} batch of ${drop.recordCount} record(s): ${drop.reason}`,
      new Error(drop.reason),
      {
        forecaster: drop.forecasterName,
        kind: drop.kind,
        recordCount: drop.recordCount,
        rowIds: drop.rowIds,
        transactionHash: drop.transactionHash,
      },
    );
    try {
      this.onBatchDropped?.(drop);
    } catch {
      // A reporting handler must never be able to break submission.
    }
  }

  setBatchSubmittedHandler(handler: BatchSubmittedHandler): void {
    this.onBatchSubmitted = handler;
  }

  setPairwiseBatchSubmittedHandler(
    handler: PairwiseBatchSubmittedHandler,
  ): void {
    this.onPairwiseBatchSubmitted = handler;
  }

  async initialize(): Promise<void> {
    if (!this.config.rpcUrls?.length) {
      throw new Error("At least one RPC URL must be provided");
    }
    // Pin the network and disable request batching (many wallets share the
    // pool; ethers' default coalescing trips public nodes' per-batch caps).
    this.providers = this.config.rpcUrls.map(
      (url) =>
        new ethers.JsonRpcProvider(url, this.config.chainId, {
          staticNetwork: true,
          batchMaxCount: 1,
        }),
    );
    this.maxRetries = Math.max(3, this.providers.length);

    // `staticNetwork` asserts the chain id rather than querying it, so a URL
    // serving a different chain would otherwise go unnoticed until a signed
    // transaction is rejected (or, on mainnet, accepted).
    //
    // EVERY endpoint is checked, not just the first: `rotateProvider` will
    // happily sign against any of them, so validating only index 0 leaves the
    // exact failure this guard exists to prevent reachable from index 1.
    const chainChecks = await Promise.all(
      this.providers.map(async (provider, index) => {
        try {
          const actual = await provider.getNetwork();
          return { index, chainId: Number(actual.chainId), error: null };
        } catch (error) {
          return { index, chainId: null, error };
        }
      }),
    );
    const wrongChain = chainChecks.filter(
      (c) => c.chainId !== null && c.chainId !== this.config.chainId,
    );
    if (wrongChain.length > 0) {
      throw new Error(
        `Refusing to submit: ${wrongChain.length} RPC endpoint(s) serve the wrong chain.\n` +
          wrongChain
            .map(
              (c) =>
                `  - ${this.config.rpcUrls[c.index]} serves chainId ${c.chainId}, expected ${this.config.chainId}`,
            )
            .join("\n"),
      );
    }
    const reachable = chainChecks.filter((c) => c.chainId !== null);
    if (reachable.length === 0) {
      throw new Error(
        `No RPC endpoint for chainId ${this.config.chainId} could be reached. ` +
          `Checked: ${this.config.rpcUrls.join(", ")}`,
      );
    }
    for (const check of chainChecks) {
      if (check.chainId === null) {
        logger.logError(
          "RPC endpoint unreachable during initialization",
          check.error,
          { rpcUrl: this.config.rpcUrls[check.index] },
        );
      }
    }

    // A call to an address holding no contract SUCCEEDS on the EVM, with
    // status 1 and no logs. So a wrong or unset FORECAST_REGISTRY_ADDRESS does
    // not fail: it burns gas on every batch, emits nothing, and lets every row
    // be stamped as published while the run reports success. Nothing downstream
    // notices until the chain is reconciled against the DB, long after the
    // money is gone. One eth_getCode closes it.
    const firstReachable = this.providers[reachable[0].index];
    const code = await firstReachable.getCode(this.config.contractAddress);
    if (code === "0x") {
      throw new Error(
        `No contract deployed at FORECAST_REGISTRY_ADDRESS ${this.config.contractAddress} ` +
          `on chainId ${this.config.chainId}. Transactions to it would succeed, emit no ` +
          `events, and be recorded as published. Refusing to submit.`,
      );
    }

    console.log(
      `ForecastRegistryClient initialized on chainId ${this.config.chainId} ` +
        `with ${reachable.length}/${this.providers.length} reachable RPC provider(s); ` +
        `registry ${this.config.contractAddress} verified`,
    );
  }

  private getCurrentProvider(): ethers.JsonRpcProvider {
    return this.providers[this.currentProviderIndex];
  }

  private rotateProvider(): ethers.JsonRpcProvider {
    this.currentProviderIndex =
      (this.currentProviderIndex + 1) % this.providers.length;
    return this.getCurrentProvider();
  }

  addForecaster(forecasterName: string, privateKey: string): string {
    const wallet = new ethers.Wallet(privateKey);
    this.privateKeys.set(forecasterName, privateKey);
    this.addresses.set(forecasterName, wallet.address);
    return wallet.address;
  }

  getAddress(forecasterName: string): string | undefined {
    return this.addresses.get(forecasterName);
  }

  async getBalance(forecasterName: string): Promise<bigint> {
    const address = this.addresses.get(forecasterName);
    if (!address) throw new Error(`Unknown forecaster ${forecasterName}`);
    return this.getCurrentProvider().getBalance(address);
  }

  /**
   * What one full batch of `batchSize` forecasts costs to submit, in wei.
   *
   * Wallets are funded once, at startup, and a wallet that runs dry mid-run has
   * its batches rejected as `insufficient funds` — which is classified
   * non-retryable and discards them. The threshold therefore has to cover every
   * batch a forecaster will ever send, and "size it from a rehearsal" is not
   * advice anyone can act on before the first run. This measures it instead.
   *
   * Estimation is best-effort: a node that refuses `eth_estimateGas` from an
   * unfunded address must not be able to stop the run, so the caller gets a
   * conservative fallback and is told which number it got.
   */
  async estimateBatchCostWei(
    forecasterName: string,
    sample: PendingForecastRecord[],
  ): Promise<{ wei: bigint; gas: bigint; estimated: boolean }> {
    const provider = this.getCurrentProvider();
    const address = this.addresses.get(forecasterName);
    if (!address) throw new Error(`Unknown forecaster ${forecasterName}`);

    // Base fee can spike between now and the last batch hours from now, so
    // price the budget off a padded fee rather than the current one.
    const feeData = await provider.getFeeData();
    const pricePerGas =
      feeData.maxFeePerGas ??
      feeData.gasPrice ??
      ethers.parseUnits("0.1", "gwei");

    // A conservative per-record figure for a calldata-heavy emit-only batch,
    // used when the node will not estimate.
    const FALLBACK_GAS_PER_RECORD = 60000n;
    const FALLBACK_BASE_GAS = 50000n;

    let gas: bigint;
    let estimated = true;
    try {
      const contract = new ethers.Contract(
        this.config.contractAddress,
        FORECAST_REGISTRY_ABI as unknown as ethers.InterfaceAbi,
        provider,
      );
      gas = await contract.recordForecastBatch.estimateGas(
        sample.map((r) => r.platformId),
        sample.map((r) => r.marketId),
        sample.map((r) => r.outcome),
        sample.map((r) => toBasisPoints(r.probability)),
        { from: address },
      );
    } catch (error) {
      estimated = false;
      gas =
        FALLBACK_BASE_GAS +
        FALLBACK_GAS_PER_RECORD * BigInt(sample.length || 1);
      logger.logError(
        "Could not estimate batch gas; using a conservative fallback",
        error,
        { forecaster: forecasterName, fallbackGas: gas.toString() },
      );
    }

    return { wei: gas * pricePerGas, gas, estimated };
  }

  /**
   * Whether this wallet has already published the given attribute values.
   *
   * Attribute claims are the only thing tying a wallet's forecasts to a model,
   * so "did this actually land?" has to be answered from the chain rather than
   * from local state — a run that assumed success once will otherwise leave the
   * wallet permanently anonymous.
   */
  /**
   * Every attribute claim on this registry, as address -> key -> value.
   *
   * Scanned ONCE for all wallets rather than once per wallet: the block range
   * is identical for each, and a per-wallet scan multiplies the request count
   * by the number of forecasters — 20 wallets x 11 chunks is 220 requests
   * against public endpoints that are already rate-limiting.
   */
  private async loadAttributeClaims(): Promise<
    Map<string, Map<string, string>>
  > {
    if (this.attributeClaims) return this.attributeClaims;

    const provider = this.getCurrentProvider();
    const contract = new ethers.Contract(
      this.config.contractAddress,
      FORECAST_REGISTRY_ABI as unknown as ethers.InterfaceAbi,
      provider,
    );
    const logs = await queryAllLogs(
      contract,
      contract.filters.AttributeSet(),
      provider,
      this.config.contractAddress,
      this.config.chainId,
    );

    const claims = new Map<string, Map<string, string>>();
    for (const log of logs) {
      const args = (log as ethers.EventLog).args;
      if (!args) continue;
      const who = String(args.who).toLowerCase();
      const forWallet = claims.get(who) ?? new Map<string, string>();
      // Later claims for the same key supersede earlier ones, and queryFilter
      // returns logs in block order, so a plain overwrite is the current value.
      forWallet.set(String(args.key), String(args.value));
      claims.set(who, forWallet);
    }
    this.attributeClaims = claims;
    return claims;
  }

  async hasDeclaredAttributes(
    forecasterName: string,
    attributes: Record<string, string>,
  ): Promise<boolean> {
    const address = this.addresses.get(forecasterName);
    if (!address) throw new Error(`Unknown forecaster ${forecasterName}`);

    const claims = await this.loadAttributeClaims();
    const declared =
      claims.get(address.toLowerCase()) ?? new Map<string, string>();
    return Object.entries(attributes).every(
      ([key, value]) => declared.get(attributeKey(key)) === value,
    );
  }

  /** Fold a claim we just made into the cache, so it is not re-scanned for. */
  private recordAttributeClaim(
    address: string,
    attributes: Record<string, string>,
  ): void {
    if (!this.attributeClaims) return;
    const key = address.toLowerCase();
    const forWallet =
      this.attributeClaims.get(key) ?? new Map<string, string>();
    for (const [k, v] of Object.entries(attributes)) {
      forWallet.set(attributeKey(k), v);
    }
    this.attributeClaims.set(key, forWallet);
  }

  /**
   * Bind this forecaster's wallet to its model on-chain by emitting attribute
   * claims. The wallet must already be funded — this sends a transaction.
   */
  async setForecasterAttributes(
    forecasterName: string,
    attributes: Record<string, string>,
  ): Promise<string> {
    const privateKey = this.privateKeys.get(forecasterName);
    if (!privateKey) throw new Error(`Unknown forecaster ${forecasterName}`);

    const keys = Object.keys(attributes).map((k) => attributeKey(k));
    const values = Object.values(attributes);

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const provider = this.getCurrentProvider();
      try {
        const wallet = new ethers.Wallet(privateKey, provider);
        const contract = new ethers.Contract(
          this.config.contractAddress,
          FORECAST_REGISTRY_ABI as unknown as ethers.InterfaceAbi,
          wallet,
        );
        const tx =
          keys.length === 1
            ? await contract.setAttribute(keys[0], values[0])
            : await contract.setAttributes(keys, values);
        // Bounded, like the forecast submission path. This runs in the
        // SEQUENTIAL startup loop before any inference begins, so an unbounded
        // wait here does not slow the run down — it stops it entirely, with no
        // error and no output, for as long as the transaction stays unmined.
        const receipt = await provider.waitForTransaction(
          tx.hash,
          1,
          this.confirmTimeoutMs,
        );
        if (receipt?.status === 1) {
          this.recordAttributeClaim(wallet.address, attributes);
          return receipt.hash ?? tx.hash;
        }
        if (receipt?.status === 0) throw new Error("setAttributes reverted");
        throw new Error(
          `setAttributes tx ${tx.hash} not confirmed within ${this.confirmTimeoutMs}ms`,
        );
      } catch (error) {
        lastError = error;
        logger.logError("On-chain attribute claim attempt failed", error, {
          forecaster: forecasterName,
          attempt: attempt + 1,
          rpcUrl: this.config.rpcUrls[this.currentProviderIndex],
        });
        if (this.providers.length > 1) this.rotateProvider();
        if (attempt < this.maxRetries) {
          await new Promise((r) =>
            setTimeout(r, Math.min(1000 * 2 ** attempt, 30000)),
          );
        }
      }
    }
    throw new Error(
      `Failed to set attributes for ${forecasterName}: ${lastError}`,
    );
  }

  /** The forecaster's batch, created (and its flush timer started) on demand. */
  private getOrCreateBatch(forecasterName: string): ForecasterBatch {
    let batch = this.batches.get(forecasterName);
    if (!batch) {
      batch = {
        forecasterName,
        forecasts: { records: [] },
        pairwise: { records: [] },
        firstRequestTime: new Date(),
      };
      this.batches.set(forecasterName, batch);
      this.scheduleTimer(forecasterName);
    }
    return batch;
  }

  /**
   * Queue market forecasts for a forecaster. Flushes immediately once the batch
   * reaches `batchSize`; otherwise a timer flushes it after `batchTimeoutMs`.
   */
  async queueForecasts(records: PendingForecastRecord[]): Promise<void> {
    if (records.length === 0) return;
    const forecasterName = records[0].forecasterName;
    const batch = this.getOrCreateBatch(forecasterName);
    batch.forecasts.records.push(...records);

    if (batch.forecasts.records.length >= this.config.batchSize) {
      await this.processBatch(forecasterName).catch((error) =>
        logger.logError("Error processing forecast batch", error, {
          forecaster: forecasterName,
        }),
      );
    }
  }

  /**
   * Queue pairwise judgments for a forecaster. Same batching policy as
   * `queueForecasts`, but a separate queue: the two need different contract
   * calls and therefore different transactions.
   */
  async queuePairwiseForecasts(
    records: PendingPairwiseForecastRecord[],
  ): Promise<void> {
    if (records.length === 0) return;
    const forecasterName = records[0].forecasterName;
    const batch = this.getOrCreateBatch(forecasterName);
    batch.pairwise.records.push(...records);

    if (batch.pairwise.records.length >= this.config.batchSize) {
      await this.processBatch(forecasterName).catch((error) =>
        logger.logError("Error processing pairwise batch", error, {
          forecaster: forecasterName,
        }),
      );
    }
  }

  /** Force-submit a forecaster's remaining records now (e.g. when it finishes). */
  async flush(forecasterName: string): Promise<void> {
    if (this.batches.has(forecasterName)) {
      await this.processBatch(forecasterName, true).catch((error) =>
        logger.logError("Error flushing batch", error, {
          forecaster: forecasterName,
        }),
      );
    }
  }

  async flushAll(): Promise<void> {
    for (const name of Array.from(this.batches.keys())) {
      await this.flush(name);
    }
  }

  private scheduleTimer(forecasterName: string): void {
    if (this.timers.has(forecasterName)) return;
    const timer = setTimeout(() => {
      // The timeout exists precisely to get part-filled queues out, so it
      // forces both regardless of size.
      this.processBatch(forecasterName, true).catch((error) =>
        logger.logError("Error processing timed-out batch", error, {
          forecaster: forecasterName,
        }),
      );
    }, this.config.batchTimeoutMs);
    this.timers.set(forecasterName, timer);
  }

  private clearTimer(forecasterName: string): void {
    const timer = this.timers.get(forecasterName);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(forecasterName);
    }
  }

  /**
   * Submit this forecaster's queued work.
   *
   * The two queues go out as separate transactions, SEQUENTIALLY and under one
   * `inFlight` guard. They share a wallet and therefore a nonce sequence, so
   * overlapping them would have both read the same pending nonce and one would
   * silently replace the other — losing a whole batch with no error anywhere.
   *
   * `force` distinguishes the two callers. A size-triggered flush submits only
   * the queues that are actually full; the timer and `flush()` submit whatever
   * is there. Without that split, every full batch of direct forecasts would
   * drag a part-filled pairwise batch along with it — and since direct
   * forecasts arrive several times more often, the pairwise records would go
   * out in many small transactions, paying the per-transaction base gas over
   * and over for work that was not urgent.
   */
  private async processBatch(
    forecasterName: string,
    force = false,
  ): Promise<ForecastRecordResult[]> {
    const batch = this.batches.get(forecasterName);
    if (!batch) return [{ success: false, error: "No batch found" }];
    if (batch.inFlight) {
      return [{ success: false, error: "Submission already in progress" }];
    }
    if (!this.privateKeys.has(forecasterName)) {
      return [{ success: false, error: `No wallet for ${forecasterName}` }];
    }

    const ready = (queue: { records: unknown[] }): boolean =>
      queue.records.length > 0 &&
      (force || queue.records.length >= this.config.batchSize);

    this.clearTimer(forecasterName);
    batch.inFlight = true;
    try {
      const results: ForecastRecordResult[] = [];
      if (ready(batch.forecasts)) {
        results.push(
          await this.submitQueue(
            forecasterName,
            batch.forecasts,
            "direct",
            (records) => records.map((r) => r.forecastId),
            (contract, records, overrides) =>
              records.length === 1
                ? contract.recordForecast(
                    records[0].platformId,
                    records[0].marketId,
                    records[0].outcome,
                    toBasisPoints(records[0].probability),
                    overrides,
                  )
                : contract.recordForecastBatch(
                    records.map((r) => r.platformId),
                    records.map((r) => r.marketId),
                    records.map((r) => r.outcome),
                    records.map((r) => toBasisPoints(r.probability)),
                    overrides,
                  ),
            (records, hash, block) =>
              this.onBatchSubmitted?.(records, hash, block),
          ),
        );
      }
      if (ready(batch.pairwise)) {
        results.push(
          await this.submitQueue(
            forecasterName,
            batch.pairwise,
            "pairwise",
            (records) => records.map((r) => r.pairwiseForecastId),
            (contract, records, overrides) =>
              records.length === 1
                ? contract.recordPairwiseForecast(
                    ...toPairwiseTuple(records[0]),
                    overrides,
                  )
                : contract.recordPairwiseForecastBatch(
                    records.map(toPairwiseTuple),
                    overrides,
                  ),
            (records, hash, block) =>
              this.onPairwiseBatchSubmitted?.(records, hash, block),
          ),
        );
      }
      // Retires an empty batch too: `processBatch` cleared its timer on entry,
      // so leaving the husk in the map would mean the next records queued for
      // this forecaster never get a flush timer at all.
      this.retireBatch(forecasterName, batch);
      return results.length > 0
        ? results
        : [{ success: false, error: "Empty batch" }];
    } finally {
      batch.inFlight = false;
    }
  }

  private async submitQueue<T extends { forecasterName: string }>(
    forecasterName: string,
    queue: BatchQueue<T>,
    kind: "direct" | "pairwise",
    idsOf: (records: T[]) => number[],
    sendTx: (
      contract: ethers.Contract,
      records: T[],
      overrides: ethers.Overrides,
    ) => Promise<ethers.ContractTransactionResponse>,
    notify: (
      records: T[],
      transactionHash: string,
      blockNumber: number | undefined,
    ) => Promise<void> | undefined,
  ): Promise<ForecastRecordResult> {
    const address = this.addresses.get(forecasterName)!;
    const privateKey = this.privateKeys.get(forecasterName)!;

    // Snapshot exactly what we're submitting; records that arrive during the
    // (potentially long) confirmation stay queued for a fresh batch.
    const recordCount = queue.records.length;
    const records = queue.records.slice(0, recordCount);
    const abandon = (reason: string): void =>
      this.reportDrop({
        forecasterName,
        kind,
        recordCount,
        rowIds: idsOf(records),
        reason,
        transactionHash: queue.pendingTxHash,
      });

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const provider = this.getCurrentProvider();
      try {
        if (!queue.pendingTxHash) {
          const wallet = new ethers.Wallet(privateKey, provider);
          const contract = new ethers.Contract(
            this.config.contractAddress,
            FORECAST_REGISTRY_ABI as unknown as ethers.InterfaceAbi,
            wallet,
          );
          // Reserve the nonce once so any re-broadcast is a replacement, not a
          // second (duplicate) forecast tx.
          if (queue.nonce === undefined) {
            queue.nonce = await provider.getTransactionCount(
              address,
              "pending",
            );
          }
          const overrides = { nonce: queue.nonce };
          const tx = await sendTx(contract, records, overrides);
          queue.pendingTxHash = tx.hash;
        }

        const receipt = await this.waitForReceipt(queue.pendingTxHash!);

        if (receipt && receipt.status === 1) {
          const transactionHash = receipt.hash ?? queue.pendingTxHash!;
          const blockNumber =
            receipt.blockNumber !== undefined
              ? Number(receipt.blockNumber)
              : undefined;
          await this.recordSubmits(
            forecasterName,
            records,
            transactionHash,
            blockNumber,
            notify,
          );
          this.finishQueue(queue, recordCount);
          return {
            success: true,
            transactionHash,
            blockNumber,
            gasUsed:
              receipt.gasUsed !== undefined
                ? Number(receipt.gasUsed)
                : undefined,
          };
        }

        if (receipt && receipt.status === 0) {
          abandon("transaction reverted on-chain");
          this.finishQueue(queue, recordCount);
          return { success: false, error: "Transaction reverted on-chain" };
        }
        // Not confirmed within the window — rotate and keep waiting on the hash.
      } catch (error) {
        const errorKind = this.classifyError(error);
        const message = error instanceof Error ? error.message : String(error);
        logger.logError("Forecast submission attempt failed", error, {
          forecaster: forecasterName,
          kind,
          classification: errorKind,
          attempt: attempt + 1,
          recordCount,
          transactionHash: queue.pendingTxHash,
          rpcUrl: this.config.rpcUrls[this.currentProviderIndex],
        });
        if (errorKind === "already-submitted") {
          abandon(`${message} (already submitted)`);
          this.finishQueue(queue, recordCount);
          return { success: false, error: `${message} (already submitted)` };
        }
        if (errorKind === "non-retryable") {
          abandon(`${message} (non-retryable)`);
          this.finishQueue(queue, recordCount);
          return { success: false, error: `${message} (non-retryable)` };
        }
      }

      if (this.providers.length > 1) this.rotateProvider();
      if (attempt < this.maxRetries) {
        await new Promise((r) =>
          setTimeout(
            r,
            Math.min(1000 * 2 ** attempt, 30000) +
              Math.floor(Math.random() * 500),
          ),
        );
      }
    }

    abandon(
      `max attempts reached on tx ${queue.pendingTxHash ?? "(never broadcast)"}`,
    );
    this.finishQueue(queue, recordCount);
    return { success: false, error: "Max retries exceeded" };
  }

  private async waitForReceipt(
    transactionHash: string,
  ): Promise<ethers.TransactionReceipt | null> {
    try {
      return await this.getCurrentProvider().waitForTransaction(
        transactionHash,
        1,
        this.confirmTimeoutMs,
      );
    } catch {
      return null;
    }
  }

  private async recordSubmits<T>(
    forecasterName: string,
    records: T[],
    transactionHash: string,
    blockNumber: number | undefined,
    notify: (
      records: T[],
      transactionHash: string,
      blockNumber: number | undefined,
    ) => Promise<void> | undefined,
  ): Promise<void> {
    if (records.length === 0) return;
    try {
      await notify(records, transactionHash, blockNumber);
    } catch (handlerError) {
      logger.logError(
        "Batch landed on-chain but persisting the DB linkage failed",
        handlerError,
        { forecaster: forecasterName, transactionHash, blockNumber },
      );
    }
  }

  /** Drop the submitted records and clear the tx state so the queue is reusable. */
  private finishQueue<T>(queue: BatchQueue<T>, recordCount: number): void {
    queue.records.splice(0, recordCount);
    queue.nonce = undefined;
    queue.pendingTxHash = undefined;
  }

  /**
   * Forget a forecaster's batch once both queues are drained, or re-arm the
   * flush timer for whatever arrived mid-submission.
   */
  private retireBatch(forecasterName: string, batch: ForecasterBatch): void {
    if (
      batch.forecasts.records.length === 0 &&
      batch.pairwise.records.length === 0
    ) {
      this.batches.delete(forecasterName);
      this.clearTimer(forecasterName);
      return;
    }
    this.scheduleTimer(forecasterName);
  }

  private classifyError(
    error: unknown,
  ): "already-submitted" | "non-retryable" | "retryable" {
    const message =
      (error instanceof Error ? error.message : String(error ?? "")) || "";
    const haystack = `${message} ${JSON.stringify(error ?? "")}`.toLowerCase();
    const has = (needle: string) => haystack.includes(needle);

    if (
      has("replacement transaction underpriced") ||
      has("replacement fee too low") ||
      has("nonce too low") ||
      has("already known") ||
      has("transaction already imported") ||
      has("already exists")
    ) {
      return "already-submitted";
    }
    if (
      has("execution reverted") ||
      has("transaction failed") ||
      has("invalid signature") ||
      has("invalid private key") ||
      has("insufficient funds")
    ) {
      return "non-retryable";
    }
    return "retryable";
  }
}
