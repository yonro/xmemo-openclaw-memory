/**
 * Resilient wrapper around XMemoClient that adds:
 * - Local recall cache (read-through with TTL)
 * - Write outbox (offline queueing with idempotency)
 * - Background outbox sync
 * - Graceful degradation status
 *
 * Tools should use ResilientXMemoClient instead of XMemoClient directly
 * when reliability guarantees are needed.
 */

import { randomUUID } from "node:crypto";
import { XMemoClient, XMemoClientError, globalBreaker } from "./client.js";
import { XMemoLocalCache } from "./local-cache.js";
import type { XMemoMemoryConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ResilientWriteResult =
  | { status: "synced"; result: unknown }
  | { status: "queued"; idempotencyKey: string; outboxStatus: string; message: string }
  | { status: "error"; message: string };

export type ProviderStatus = "online" | "degraded" | "offline" | "unknown";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTransientError(error: unknown): boolean {
  if (error instanceof XMemoClientError && error.status !== undefined) {
    return error.status >= 500 || error.status === 429;
  }
  if (error instanceof Error) {
    if (error.name === "AbortError") return false;
    if (/fetch|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i.test(error.message)) {
      return true;
    }
  }
  return false;
}

// Idempotent write operations that are safe for automatic replay
const IDEMPOTENT_OPS = new Set(["remember", "update_state"]);

// ---------------------------------------------------------------------------
// ResilientXMemoClient
// ---------------------------------------------------------------------------

export class ResilientXMemoClient {
  private readonly client: XMemoClient;
  private readonly cache: XMemoLocalCache;
  private readonly config: XMemoMemoryConfig;

  private _status: ProviderStatus = "unknown";
  private _lastSuccessAt = 0;
  private _lastError = "";
  private _syncInProgress = false;

  constructor(client: XMemoClient, config: XMemoMemoryConfig, cache?: XMemoLocalCache) {
    this.client = client;
    this.config = config;
    // Scope the cache to this specific baseUrl + apiKey pair
    this.cache = cache ?? new XMemoLocalCache({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey ?? "",
    });

    // Recover stale locks on construction
    this.cache.recoverStaleLocks();
  }

  get status(): ProviderStatus {
    return this._status;
  }

  get lastError(): string {
    return this._lastError;
  }

  get rawClient(): XMemoClient {
    return this.client;
  }

  // -------------------------------------------------------------------------
  // Cached Reads
  // -------------------------------------------------------------------------

  /**
   * Recall context with local cache. Returns cached result if available
   * and falls back to remote call. On network failure, returns stale cache.
   */
  async recallContext(
    query: string,
    params: {
      bucket?: string;
      scope?: string | null;
      teamId?: string | null;
      maxItems?: number;
      maxTokens?: number;
      preferWorking?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<{ result: unknown; fromCache: boolean; isFresh: boolean }> {
    const cacheParams: Record<string, unknown> = {
      query,
      bucket: params.bucket ?? this.config.readBucket,
      scope: params.scope ?? this.config.readScope ?? null,
      teamId: params.teamId ?? this.config.teamId ?? null,
      maxItems: params.maxItems ?? this.config.recallMaxItems,
      maxTokens: params.maxTokens ?? this.config.recallMaxTokens,
    };

    // Keep cache available only as a fallback. Recall results can be partial, so
    // cloud remains authoritative even when the local cache is still fresh.
    const cached = this.cache.getCachedRecall("recall_context", query, cacheParams);

    // Try remote call
    try {
      const response = await this.client.recallContext(
        {
          query: query.slice(0, this.config.recallMaxChars),
          bucket: params.bucket ?? this.config.readBucket,
          scope: params.scope ?? this.config.readScope ?? null,
          team_id: params.teamId ?? this.config.teamId ?? null,
          max_items: params.maxItems ?? this.config.recallMaxItems,
          max_tokens: params.maxTokens ?? this.config.recallMaxTokens,
          prefer_working: params.preferWorking ?? true,
        },
        signal,
      );

      this._recordSuccess();

      // Update cache
      this.cache.putCachedRecall("recall_context", query, cacheParams, response);

      // Trigger background outbox sync on success
      this._triggerOutboxSync();

      return { result: response, fromCache: false, isFresh: true };
    } catch (error) {
      this._recordFailure(error);

      // If we have stale cache, return it as fallback
      if (cached) {
        return { result: cached.response, fromCache: true, isFresh: cached.isFresh };
      }

      throw error;
    }
  }

  /**
   * Search with local cache.
   */
  async searchMemory(
    query: string,
    params: {
      bucket?: string;
      scope?: string | null;
      teamId?: string | null;
      maxItems?: number;
    },
    signal?: AbortSignal,
  ): Promise<{ result: unknown; fromCache: boolean; isFresh: boolean }> {
    const cacheParams: Record<string, unknown> = {
      query,
      bucket: params.bucket ?? this.config.readBucket,
      scope: params.scope ?? this.config.readScope ?? null,
      teamId: params.teamId ?? this.config.teamId ?? null,
      maxItems: params.maxItems ?? 10,
    };

    // Keep cache available only as a fallback. Search results can be partial, so
    // cloud remains authoritative even when the local cache is still fresh.
    const cached = this.cache.getCachedRecall("search", query, cacheParams);

    try {
      const response = await this.client.searchMemory(
        {
          query,
          bucket: params.bucket ?? this.config.readBucket,
          scope: params.scope ?? this.config.readScope ?? null,
          team_id: params.teamId ?? this.config.teamId ?? null,
          max_items: params.maxItems ?? 10,
        },
        signal,
      );

      this._recordSuccess();
      this.cache.putCachedRecall("search", query, cacheParams, response);
      this._triggerOutboxSync();

      return { result: response, fromCache: false, isFresh: true };
    } catch (error) {
      this._recordFailure(error);

      if (cached) {
        return { result: cached.response, fromCache: true, isFresh: cached.isFresh };
      }

      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Resilient Writes (with outbox fallback)
  // -------------------------------------------------------------------------

  /**
   * Execute a write operation with outbox fallback.
   * If the API call fails with a transient error, the write is queued locally.
   */
  async resilientWrite(
    operation: string,
    endpoint: string,
    method: string,
    payload: Record<string, unknown>,
    apiFn: (idempotencyKey: string) => Promise<unknown>,
  ): Promise<ResilientWriteResult> {
    const idempotencyKey = randomUUID();

    // Check circuit breaker
    if (globalBreaker.isOpen()) {
      return this._enqueueWrite(operation, endpoint, method, payload, idempotencyKey, "Circuit breaker is open");
    }

    try {
      const result = await apiFn(idempotencyKey);
      this._recordSuccess();
      this._triggerOutboxSync();
      return { status: "synced", result };
    } catch (error) {
      this._recordFailure(error);

      if (isTransientError(error)) {
        return this._enqueueWrite(
          operation,
          endpoint,
          method,
          payload,
          idempotencyKey,
          error instanceof Error ? error.message : String(error),
        );
      }

      // Non-transient error — fail immediately
      return {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // -------------------------------------------------------------------------
  // Outbox Sync
  // -------------------------------------------------------------------------

  /**
   * Synchronize pending outbox writes. Call this opportunistically
   * (e.g. after a successful API call) or on a timer.
   */
  async syncOutbox(): Promise<{ synced: number; failed: number }> {
    if (this._syncInProgress) return { synced: 0, failed: 0 };
    this._syncInProgress = true;

    let synced = 0;
    let failed = 0;

    try {
      this.cache.pruneOldRecords();
      const pending = this.cache.listPendingWrites();
      if (pending.length === 0) return { synced: 0, failed: 0 };

      for (const record of pending) {
        if (globalBreaker.isOpen()) break;
        if (!this.cache.lockForProcessing(record.id)) continue;

        try {
          // Replay the write through XMemoClient which handles auth headers
          // (X-API-Key / Bearer / both), agent ID, instance ID, and retry logic.
          await this.client.replayWrite(
            record.endpoint,
            record.method,
            record.payload,
            record.idempotencyKey,
          );
          this.cache.markSent(record.id);
          this._recordSuccess();
          synced++;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          this.cache.markFailed(record.id, msg, isTransientError(error));
          failed++;

          if (globalBreaker.state === "open") break;
        }
      }
    } finally {
      this._syncInProgress = false;
    }

    return { synced, failed };
  }

  // -------------------------------------------------------------------------
  // Status & Diagnostics
  // -------------------------------------------------------------------------

  getStatusSummary(): {
    status: ProviderStatus;
    breakerState: string;
    lastError: string;
    cacheStats: ReturnType<XMemoLocalCache["getStats"]>;
  } {
    return {
      status: this._status,
      breakerState: globalBreaker.state,
      lastError: this._lastError,
      cacheStats: this.cache.getStats(),
    };
  }

  /**
   * Generate a system-prompt-style status line for graceful degradation.
   */
  getPromptStatusLine(): string {
    const state = globalBreaker.state;
    if (this._status === "online" && state === "closed") {
      return "XMemo status: online. Memory recall and writes are fully operational.";
    }
    if (this._status === "unknown") {
      return "XMemo is enabled as the active long-term memory backend. Relevant project context, decisions, and prior fixes may be injected automatically or retrieved with the memory tools.";
    }
    if (this._status === "degraded" || state === "half-open") {
      const stats = this.cache.getStats();
      const queueNote = stats.pendingWrites > 0
        ? ` ${stats.pendingWrites} writes queued locally.`
        : "";
      return `XMemo status: degraded. Some requests may fail temporarily.${queueNote} Do not assume the user has no saved memories just because recall is empty.`;
    }
    // offline
    const stats = this.cache.getStats();
    const cacheNote = stats.cacheEntries > 0
      ? ` Local cache has ${stats.cacheEntries} entries for fallback.`
      : "";
    const queueNote = stats.pendingWrites > 0
      ? ` ${stats.pendingWrites} writes queued for sync.`
      : "";
    return `XMemo status: offline. Memory service is temporarily unavailable.${cacheNote}${queueNote} Do not overwrite or forget user memory based only on missing recall results.`;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private _enqueueWrite(
    operation: string,
    endpoint: string,
    method: string,
    payload: Record<string, unknown>,
    idempotencyKey: string,
    _errorMsg: string,
  ): ResilientWriteResult {
    const autoReplay = IDEMPOTENT_OPS.has(operation);

    this.cache.enqueueWrite(operation, endpoint, method, payload, {
      idempotencyKey,
      autoReplay,
    });

    const note = autoReplay
      ? "queued locally and will sync automatically when connection is restored"
      : "queued locally (manual sync required to avoid duplicates)";

    return {
      status: "queued",
      idempotencyKey,
      outboxStatus: autoReplay ? "pending" : "held",
      message: `XMemo temporarily unavailable. Write ${note}.`,
    };
  }

  private _recordSuccess(): void {
    this._status = "online";
    this._lastSuccessAt = Date.now();
    this._lastError = "";
  }

  private _recordFailure(error: unknown): void {
    this._lastError = error instanceof Error ? error.message : String(error);
    if (globalBreaker.state === "open") {
      this._status = "offline";
    } else {
      this._status = "degraded";
    }
  }

  private _triggerOutboxSync(): void {
    // Fire-and-forget background sync
    if (globalBreaker.isOpen()) return;
    void this.syncOutbox().catch(() => {});
  }
}
