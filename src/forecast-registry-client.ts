import { ethers } from "ethers";
import {
  ForecastRegistryConfig,
  ForecastRecordResult,
  ForecasterBatch,
  PendingForecastRecord,
} from "./types";
import {
  FORECAST_REGISTRY_ABI,
  attributeKey,
  toBasisPoints,
} from "./forecast-registry-abi";
import { BASE_CHAIN_ID } from "./utils";

// Invoked after a batch confirms on-chain, so the caller can stamp the affected
// public.forecast rows with the tx. The tx already cost gas, so a failure here
// must never trigger a re-submission — the handler is best-effort.
export type BatchSubmittedHandler = (
  records: PendingForecastRecord[],
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

  constructor(config: ForecastRegistryConfig) {
    this.config = config;
  }

  setBatchSubmittedHandler(handler: BatchSubmittedHandler): void {
    this.onBatchSubmitted = handler;
  }

  async initialize(): Promise<void> {
    if (!this.config.rpcUrls?.length) {
      throw new Error("At least one RPC URL must be provided");
    }
    // Pin the network and disable request batching (many wallets share the
    // pool; ethers' default coalescing trips public nodes' per-batch caps).
    this.providers = this.config.rpcUrls.map(
      (url) =>
        new ethers.JsonRpcProvider(url, BASE_CHAIN_ID, {
          staticNetwork: true,
          batchMaxCount: 1,
        }),
    );
    this.maxRetries = Math.max(3, this.providers.length);
    console.log(
      `ForecastRegistryClient initialized with ${this.providers.length} RPC providers`,
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
   * Bind this forecaster's wallet to its model on-chain by emitting attribute
   * claims. Called once, before the forecaster starts forecasting.
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

  /**
   * Queue market forecasts for a forecaster. Flushes immediately once the batch
   * reaches `batchSize`; otherwise a timer flushes it after `batchTimeoutMs`.
   */
  async queueForecasts(records: PendingForecastRecord[]): Promise<void> {
    if (records.length === 0) return;
    const forecasterName = records[0].forecasterName;

    let batch = this.batches.get(forecasterName);
    if (!batch) {
      batch = { forecasterName, records: [], firstRequestTime: new Date() };
      this.batches.set(forecasterName, batch);
      this.scheduleTimer(forecasterName);
    }
    batch.records.push(...records);

    if (batch.records.length >= this.config.batchSize) {
      await this.processBatch(forecasterName).catch((error) =>
        console.error(`Error processing batch for ${forecasterName}:`, error),
      );
    }
  }

  /** Force-submit a forecaster's remaining records now (e.g. when it finishes). */
  async flush(forecasterName: string): Promise<void> {
    if (this.batches.has(forecasterName)) {
      await this.processBatch(forecasterName).catch((error) =>
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
      this.processBatch(forecasterName).catch((error) =>
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

  private async processBatch(
    forecasterName: string,
  ): Promise<ForecastRecordResult> {
    const batch = this.batches.get(forecasterName);
    if (!batch || batch.records.length === 0) {
      return { success: false, error: "No batch found or empty batch" };
    }
    if (batch.inFlight) {
      return { success: false, error: "Submission already in progress" };
    }
    if (!this.privateKeys.has(forecasterName)) {
      return { success: false, error: `No wallet for ${forecasterName}` };
    }

    this.clearTimer(forecasterName);
    batch.inFlight = true;
    // Snapshot exactly what we're submitting; records that arrive during the
    // (potentially long) confirmation stay queued for a fresh batch.
    const recordCount = batch.records.length;
    const records = batch.records.slice(0, recordCount);
    try {
      return await this.submitBatch(
        forecasterName,
        batch,
        recordCount,
        records,
      );
    } finally {
      batch.inFlight = false;
    }
  }

  private async submitBatch(
    forecasterName: string,
    batch: ForecasterBatch,
    recordCount: number,
    records: PendingForecastRecord[],
  ): Promise<ForecastRecordResult> {
    const address = this.addresses.get(forecasterName)!;
    const privateKey = this.privateKeys.get(forecasterName)!;

    const platformIds = records.map((r) => r.platformId);
    const marketIds = records.map((r) => r.marketId);
    const outcomes = records.map((r) => r.outcome);
    const oddsList = records.map((r) => toBasisPoints(r.probability));

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const provider = this.getCurrentProvider();
      try {
        if (!batch.pendingTxHash) {
          const wallet = new ethers.Wallet(privateKey, provider);
          const contract = new ethers.Contract(
            this.config.contractAddress,
            FORECAST_REGISTRY_ABI as unknown as ethers.InterfaceAbi,
            wallet,
          );
          // Reserve the nonce once so any re-broadcast is a replacement, not a
          // second (duplicate) forecast tx.
          if (batch.nonce === undefined) {
            batch.nonce = await provider.getTransactionCount(
              address,
              "pending",
            );
          }
          const overrides = { nonce: batch.nonce };
          const tx =
            records.length === 1
              ? await contract.recordForecast(
                  platformIds[0],
                  marketIds[0],
                  outcomes[0],
                  oddsList[0],
                  overrides,
                )
              : await contract.recordForecastBatch(
                  platformIds,
                  marketIds,
                  outcomes,
                  oddsList,
                  overrides,
                );
          batch.pendingTxHash = tx.hash;
        }

        const receipt = await this.waitForReceipt(batch.pendingTxHash!);

        if (receipt && receipt.status === 1) {
          const transactionHash = receipt.hash ?? batch.pendingTxHash!;
          const blockNumber =
            receipt.blockNumber !== undefined
              ? Number(receipt.blockNumber)
              : undefined;
          await this.recordSubmits(
            forecasterName,
            records,
            transactionHash,
            blockNumber,
          );
          this.finishBatch(forecasterName, batch, recordCount, true);
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
            `Forecast tx ${batch.pendingTxHash} for ${forecasterName} reverted; dropping batch`,
          );
          this.finishBatch(forecasterName, batch, recordCount, true);
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
          this.finishBatch(forecasterName, batch, recordCount, true);
          return { success: false, error: `${message} (already submitted)` };
        }
        if (kind === "non-retryable") {
          this.finishBatch(forecasterName, batch, recordCount, true);
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
      `Max attempts reached for ${forecasterName}; giving up on tx ${batch.pendingTxHash ?? "(never broadcast)"}.`,
    );
    this.finishBatch(forecasterName, batch, recordCount, true);
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

  private async recordSubmits(
    forecasterName: string,
    records: PendingForecastRecord[],
    transactionHash: string,
    blockNumber: number | undefined,
  ): Promise<void> {
    if (!this.onBatchSubmitted || records.length === 0) return;
    try {
      await this.onBatchSubmitted(records, transactionHash, blockNumber);
    } catch (handlerError) {
      console.error(
        `Batch for ${forecasterName} landed on-chain (tx ${transactionHash}) but persisting the linkage failed:`,
        handlerError,
      );
    }
  }

  private finishBatch(
    forecasterName: string,
    batch: ForecasterBatch,
    recordCount: number,
    allowReschedule: boolean,
  ): void {
    batch.records.splice(0, recordCount);
    batch.nonce = undefined;
    batch.pendingTxHash = undefined;

    if (batch.records.length === 0) {
      this.batches.delete(forecasterName);
      this.clearTimer(forecasterName);
      return;
    }
    if (allowReschedule) this.scheduleTimer(forecasterName);
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
