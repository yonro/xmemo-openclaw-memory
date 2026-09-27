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
import { XMemoClient, XMemoClientError } from "./client.js";
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
    // 401/403 (auth), 404 (deterministic miss), 400/422 (bad request) are non-transient.
    // 5xx (server error), 429 (rate limit), 408/504 (timeout) are transient.
    return error.status >= 500 || error.status === 429 || error.status === 408 || error.status === 504;
  }
  if (error instanceof Error) {
    if (error.name === "AbortError") return false;
    if (error.name === "TimeoutError") return true;
    if (/fetch|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR|timeout/i.test(error.message)) {
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
  private _outboxTimer: ReturnType<typeof setTimeout> | undefined;
  private _outboxSyncStopped = true;
  private _outboxSyncIntervalMs = 30_000;
  private _outboxFailureDelayMs = 30_000;
  private _staleLockTimeoutMs = 300_000;

  constructor(client: XMemoClient, config: XMemoMemoryConfig, cache?: XMemoLocalCache) {
    this.client = client;
    this.config = config;
    // Scope the cache to this specific baseUrl + apiKey pair
    this.cache = cache ?? new XMemoLocalCache({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey ?? "",
    });

    // Recovery failure is visible in status but must not prevent cloud access.
    try {
      this.cache.recoverStaleLocks();
    } catch (error) {
      this._recordFailure(error);
    }
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

  get circuitBreakerState() {
    return this.client.circuitBreakerState;
  }

  /** Start periodic recovery and replay, including an immediate first pass. */
  startOutboxSync(options?: { intervalMs?: number; staleLockTimeoutMs?: number }): void {
    if (options?.intervalMs !== undefined) {
      this._outboxSyncIntervalMs = Math.max(1, options.intervalMs);
    }
    if (options?.staleLockTimeoutMs !== undefined) {
      this._staleLockTimeoutMs = Math.max(1, options.staleLockTimeoutMs);
    }
    if (!this._outboxSyncStopped) return;
    this._outboxSyncStopped = false;
    this._outboxFailureDelayMs = this._outboxSyncIntervalMs;
    void this._runScheduledOutboxSync();
  }

  /** Stop future background passes when OpenClaw disables or unloads the plugin. */
  stopOutboxSync(): void {
    this._outboxSyncStopped = true;
    if (this._outboxTimer !== undefined) {
      clearTimeout(this._outboxTimer);
      this._outboxTimer = undefined;
    }
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
      minScore?: number;
    },
    signal?: AbortSignal,
  ): Promise<{ result: unknown; fromCache: boolean; isFresh: boolean }> {
    const cacheParams: Record<string, unknown> = {
      query,
      bucket: params.bucket ?? this.config.readBucket,
      scope: params.scope !== undefined ? params.scope : (this.config.readScope ?? null),
      teamId: params.teamId !== undefined ? params.teamId : (this.config.teamId ?? null),
      maxItems: params.maxItems ?? this.config.recallMaxItems,
      maxTokens: params.maxTokens ?? this.config.recallMaxTokens,
      minScore: params.minScore,
    };

    // Keep cache available only as a fallback. Recall results can be partial, so
    // cloud remains authoritative even when the local cache is still fresh.
    const cached = this._getCachedRecall("recall_context", query, cacheParams);

    // Try remote call
    try {
      const response = await this.client.recallContext(
        {
          query: query.slice(0, this.config.recallMaxChars),
          bucket: params.bucket ?? this.config.readBucket,
          scope: params.scope !== undefined ? params.scope : (this.config.readScope ?? null),
          team_id: params.teamId !== undefined ? params.teamId : (this.config.teamId ?? null),
          max_items: params.maxItems ?? this.config.recallMaxItems,
          max_tokens: params.maxTokens ?? this.config.recallMaxTokens,
          prefer_working: params.preferWorking ?? true,
          threshold: params.minScore,
        },
        signal,
      );

      this._recordSuccess();

      // Update cache
      this._putCachedRecall("recall_context", query, cacheParams, response);

      // Trigger background outbox sync on success
      this._triggerOutboxSync();

      return { result: response, fromCache: false, isFresh: true };
    } catch (error) {
      this._recordFailure(error);

      // Only allow fallback to stale cache on explicit transient failures (network error, 5xx, timeout).
      // 401/403 (auth), 404 (deterministic miss), and cancellation MUST NOT return cache fallback.
      if (cached && isTransientError(error)) {
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
      memory_type?: string;
      status?: string;
      maxItems?: number;
      path?: string;
      minScore?: number;
    },
    signal?: AbortSignal,
  ): Promise<{ result: unknown; fromCache: boolean; isFresh: boolean }> {
    const cacheParams: Record<string, unknown> = {
      query,
      bucket: params.bucket ?? this.config.readBucket,
      scope: params.scope !== undefined ? params.scope : (this.config.readScope ?? null),
      teamId: params.teamId !== undefined ? params.teamId : (this.config.teamId ?? null),
      ...(params.memory_type ? { memory_type: params.memory_type } : {}),
      ...(params.status ? { status: params.status } : {}),
      maxItems: params.maxItems ?? 10,
      path: params.path,
      minScore: params.minScore,
    };

    // Keep cache available only as a fallback. Search results can be partial, so
    // cloud remains authoritative even when the local cache is still fresh.
    const cached = this._getCachedRecall("search", query, cacheParams);

    try {
      const response = await this.client.searchMemory(
        {
          query,
          bucket: params.bucket ?? this.config.readBucket,
          scope: params.scope !== undefined ? params.scope : (this.config.readScope ?? null),
          team_id: params.teamId !== undefined ? params.teamId : (this.config.teamId ?? null),
          memory_type: params.memory_type,
          status: params.status,
          max_items: params.maxItems ?? 10,
          path: params.path,
          threshold: params.minScore,
        },
        signal,
      );

      this._recordSuccess();
      this._putCachedRecall("search", query, cacheParams, response);
      this._triggerOutboxSync();

      return { result: response, fromCache: false, isFresh: true };
    } catch (error) {
      this._recordFailure(error);

      // Only allow fallback to stale cache on explicit transient failures (network error, 5xx, timeout).
      // 401/403 (auth), 404 (deterministic miss), and cancellation MUST NOT return cache fallback.
      if (cached && isTransientError(error)) {
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
    if (this.client.isCircuitOpen()) {
      return this._enqueueWrite(operation, endpoint, method, payload, idempotencyKey, "Circuit breaker is open");
    }

    try {
      const result = await apiFn(idempotencyKey);
      this._recordSuccess();
      this.invalidateCache({
        bucket: (payload.bucket as string) ?? this.config.bucket,
        scope: payload.scope !== undefined ? (payload.scope as string | null) : (this.config.scope ?? null),
        teamId: payload.team_id !== undefined ? (payload.team_id as string | null) : (this.config.teamId ?? null),
      });
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
        if (this.client.isCircuitOpen()) break;
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
          this.invalidateCache({
            bucket: (record.payload?.bucket as string) ?? this.config.bucket,
            scope: record.payload?.scope !== undefined ? (record.payload.scope as string | null) : (this.config.scope ?? null),
            teamId: record.payload?.team_id !== undefined ? (record.payload.team_id as string | null) : (this.config.teamId ?? null),
          });
          this._recordSuccess();
          synced++;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          this.cache.markFailed(record.id, msg, isTransientError(error));
          this._recordFailure(error);
          failed++;

          if (this.client.circuitBreakerState === "open") break;
        }
      }
    } finally {
      this._syncInProgress = false;
    }

    return { synced, failed };
  }

  // -------------------------------------------------------------------------
  // Cache Management
  // -------------------------------------------------------------------------

  /**
   * Invalidate cached recall/search entries for this identity/space.
   * Does not clear the write outbox or affect other accounts.
   */
  invalidateCache(filter?: {
    bucket?: string | null;
    scope?: string | null;
    teamId?: string | null;
  }): number {
    try {
      return this.cache.invalidateRecallCache(filter);
    } catch (error) {
      this._recordFailure(error);
      return 0;
    }
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
      breakerState: this.client.circuitBreakerState,
      lastError: this._lastError,
      cacheStats: this.cache.getStats(),
    };
  }

  /**
   * Generate a system-prompt-style status line for graceful degradation.
   */
  getPromptStatusLine(): string {
    const state = this.client.circuitBreakerState;
    if (this._status === "online" && state === "closed") {
      const queueNote = this._outboxStatusNote(this.cache.getStats());
      return `XMemo status: online. Memory recall and writes are operational.${queueNote}`;
    }
    if (this._status === "unknown") {
      const queueNote = this._outboxStatusNote(this.cache.getStats());
      return `XMemo is enabled as the active long-term memory backend. Relevant project context, decisions, and prior fixes may be injected automatically or retrieved with the memory tools.${queueNote}`;
    }
    if (this._status === "degraded" || state === "half-open") {
      const stats = this.cache.getStats();
      const queueNote = this._outboxStatusNote(stats);
      return `XMemo status: degraded. Some requests may fail temporarily.${queueNote} Do not assume the user has no saved memories just because recall is empty.`;
    }
    // offline
    const stats = this.cache.getStats();
    const cacheNote = stats.cacheEntries > 0
      ? ` Local cache has ${stats.cacheEntries} entries for fallback.`
      : "";
    const queueNote = this._outboxStatusNote(stats);
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
    try {
      this.cache.enqueueWrite(operation, endpoint, method, payload, {
        idempotencyKey,
        autoReplay,
      });
    } catch (error) {
      return {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }

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

  private _getCachedRecall(
    operation: string,
    query: string,
    params: Record<string, unknown>,
  ): { response: unknown; isFresh: boolean } | null {
    try {
      return this.cache.getCachedRecall(operation, query, params);
    } catch (error) {
      this._recordFailure(error);
      return null;
    }
  }

  private _putCachedRecall(
    operation: string,
    query: string,
    params: Record<string, unknown>,
    response: unknown,
  ): void {
    try {
      this.cache.putCachedRecall(operation, query, params, response);
    } catch (error) {
      this._recordFailure(error);
    }
  }

  private _recordFailure(error: unknown): void {
    this._lastError = error instanceof Error ? error.message : String(error);
    if (this.client.circuitBreakerState === "open") {
      this._status = "offline";
    } else {
      this._status = "degraded";
    }
  }

  private _triggerOutboxSync(): void {
    // Fire-and-forget background sync
    if (this.client.isCircuitOpen()) return;
    void this.syncOutbox().catch(() => {});
  }

  private _outboxStatusNote(stats: ReturnType<XMemoLocalCache["getStats"]>): string {
    const notes: string[] = [];
    if (stats.pendingWrites > 0) notes.push(`${stats.pendingWrites} writes queued for sync`);
    if (stats.heldWrites > 0) notes.push(`${stats.heldWrites} writes are held for manual sync`);
    if (stats.failedWrites > 0) notes.push(`${stats.failedWrites} writes failed and need attention`);
    if (stats.lastOutboxError && !stats.outboxReadError) notes.push(`last write error: ${stats.lastOutboxError}`);
    if (stats.outboxReadError) notes.push(`outbox storage error: ${stats.outboxReadError}`);
    if (stats.cacheReadError) notes.push(`cache storage error: ${stats.cacheReadError}`);
    if (stats.cacheWarning) notes.push(stats.cacheWarning);
    return notes.length > 0 ? ` ${notes.join("; ")}.` : "";
  }

  private async _runScheduledOutboxSync(): Promise<void> {
    if (this._outboxSyncStopped) return;
    let nextDelay = this._outboxSyncIntervalMs;
    try {
      this.cache.recoverStaleLocks(this._staleLockTimeoutMs);
      await this.syncOutbox();
      this._outboxFailureDelayMs = this._outboxSyncIntervalMs;
    } catch (error) {
      this._recordFailure(error);
      nextDelay = this._outboxFailureDelayMs;
      this._outboxFailureDelayMs = Math.min(this._outboxFailureDelayMs * 2, 5 * 60_000);
    }
    if (this._outboxSyncStopped) return;
    this._outboxTimer = setTimeout(() => {
      this._outboxTimer = undefined;
      void this._runScheduledOutboxSync();
    }, nextDelay);
    this._outboxTimer.unref?.();
  }
}
