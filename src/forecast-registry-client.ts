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

  constructor(config: ForecastRegistryConfig) {
    this.config = config;
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
    // transaction is rejected (or, on mainnet, accepted). Verify once here.
    const actual = await this.providers[0].getNetwork();
    if (Number(actual.chainId) !== this.config.chainId) {
      throw new Error(
        `RPC endpoint ${this.config.rpcUrls[0]} serves chainId ${actual.chainId}, ` +
          `but CHAIN_ID is ${this.config.chainId}. Refusing to submit.`,
      );
    }

    console.log(
      `ForecastRegistryClient initialized on chainId ${this.config.chainId} ` +
        `with ${this.providers.length} RPC provider(s)`,
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
   * Whether this wallet has already published the given attribute values.
   *
   * Attribute claims are the only thing tying a wallet's forecasts to a model,
   * so "did this actually land?" has to be answered from the chain rather than
   * from local state — a run that assumed success once will otherwise leave the
   * wallet permanently anonymous.
   */
  async hasDeclaredAttributes(
    forecasterName: string,
    attributes: Record<string, string>,
  ): Promise<boolean> {
    const address = this.addresses.get(forecasterName);
    if (!address) throw new Error(`Unknown forecaster ${forecasterName}`);

    const contract = new ethers.Contract(
      this.config.contractAddress,
      FORECAST_REGISTRY_ABI as unknown as ethers.InterfaceAbi,
      this.getCurrentProvider(),
    );
    const logs = await contract.queryFilter(
      contract.filters.AttributeSet(address),
    );
    const declared = new Map<string, string>();
    for (const log of logs) {
      const args = (log as ethers.EventLog).args;
      declared.set(String(args.key), String(args.value));
    }
    return Object.entries(attributes).every(
      ([key, value]) => declared.get(attributeKey(key)) === value,
    );
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
        const receipt = await tx.wait();
        if (receipt?.status === 1) return receipt.hash ?? tx.hash;
        throw new Error("setAttributes reverted");
      } catch (error) {
        lastError = error;
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
        console.error(`Error processing batch for ${forecasterName}:`, error),
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
        console.error(`Error processing batch for ${forecasterName}:`, error),
      );
    }
  }

  /** Force-submit a forecaster's remaining records now (e.g. when it finishes). */
  async flush(forecasterName: string): Promise<void> {
    if (this.batches.has(forecasterName)) {
      await this.processBatch(forecasterName, true).catch((error) =>
        console.error(`Error flushing batch for ${forecasterName}:`, error),
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
        console.error(`Error processing batch for ${forecasterName}:`, error),
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
          console.error(
            `Forecast tx ${queue.pendingTxHash} for ${forecasterName} reverted; dropping batch`,
          );
          this.finishQueue(queue, recordCount);
          return { success: false, error: "Transaction reverted on-chain" };
        }
        // Not confirmed within the window — rotate and keep waiting on the hash.
      } catch (error) {
        const kind = this.classifyError(error);
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `Forecast submission error for ${forecasterName} (attempt ${attempt + 1}, kind=${kind}): ${message}`,
        );
        if (kind === "already-submitted") {
          this.finishQueue(queue, recordCount);
          return { success: false, error: `${message} (already submitted)` };
        }
        if (kind === "non-retryable") {
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

    console.error(
      `Max attempts reached for ${forecasterName}; giving up on tx ${queue.pendingTxHash ?? "(never broadcast)"}.`,
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
      console.error(
        `Batch for ${forecasterName} landed on-chain (tx ${transactionHash}) but persisting the linkage failed:`,
        handlerError,
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
