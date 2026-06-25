/**
 * Lightweight file-based local cache and write outbox for the XMemo OpenClaw plugin.
 *
 * Uses JSON files stored under the OpenClaw data directory (or fallback to ~/.xmemo/).
 * Provides:
 * - Read cache: recall/search results cached with fresh TTL + max-stale TTL
 * - Write outbox: failed writes queued locally with idempotency keys, exponential
 *   backoff retry, and dead-lettering after max retries
 *
 * Design constraints:
 * - Zero native dependencies (no better-sqlite3, no node:sqlite)
 * - Atomic writes via write-to-temp + rename
 * - Single-process safe (OpenClaw plugins run in one process)
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CachedRecallEntry = {
  id: string;
  operation: string;
  query: string;
  paramsHash: string;
  response: unknown;
  createdAt: number;
  freshUntil: number;
  maxStaleUntil: number;
  hitCount: number;
};

export type OutboxRecord = {
  id: string;
  operation: string;
  endpoint: string;
  method: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  status: "pending" | "processing" | "sent" | "failed" | "held";
  retryCount: number;
  lastError?: string;
  lockedAt?: number;
  createdAt: number;
  updatedAt: number;
  nextRetryAt?: number;
  autoReplay: boolean;
};

type CacheStore = {
  version: 1;
  entries: Record<string, CachedRecallEntry>;
};

type OutboxStore = {
  version: 1;
  records: Record<string, OutboxRecord>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function atomicWriteJson(filepath: string, data: unknown): void {
  ensureDir(dirname(filepath));
  // Write temp file in the same directory to avoid cross-volume rename issues on Windows
  const tmp = join(dirname(filepath), `.xmemo-${randomUUID()}.tmp`);
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, filepath);
}

function readJsonSafe<T>(filepath: string, fallback: T): T {
  try {
    if (!existsSync(filepath)) return fallback;
    const raw = readFileSync(filepath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function hashSignature(operation: string, query: string, params: Record<string, unknown>): string {
  const sorted = JSON.stringify(params, Object.keys(params).sort());
  const sig = `${operation}:${query}:${sorted}`;
  return createHash("sha256").update(sig).digest("hex");
}

// ---------------------------------------------------------------------------
// Default paths
// ---------------------------------------------------------------------------

/**
 * Generate a cache directory scoped to the current baseUrl + apiKey combination.
 * This prevents outbox writes for account A from replaying against account B,
 * and staging writes from replaying against production.
 */
function scopedCacheDir(baseUrl: string, apiKey: string): string {
  const baseDir = (() => {
    const openclawData = process.env.OPENCLAW_DATA_DIR;
    if (openclawData) return join(openclawData, "xmemo");
    const xdg = process.env.XDG_DATA_HOME;
    if (xdg) return join(xdg, "xmemo");
    return join(homedir(), ".xmemo");
  })();

  // Hash baseUrl + first 8 chars of apiKey to create a stable, filesystem-safe scope.
  // This gives each (service, account) pair its own isolated cache/outbox.
  const scopeInput = `${baseUrl}:${apiKey.slice(0, 8)}`;
  const scopeHash = createHash("sha256").update(scopeInput).digest("hex").slice(0, 12);
  return join(baseDir, scopeHash);
}

// ---------------------------------------------------------------------------
// XMemoLocalCache
// ---------------------------------------------------------------------------

export class XMemoLocalCache {
  private readonly cacheFile: string;
  private readonly outboxFile: string;
  private cache: CacheStore;
  private outbox: OutboxStore;

  constructor(cacheDirOrScope?: string | { baseUrl: string; apiKey: string }) {
    let dir: string;
    if (typeof cacheDirOrScope === "string") {
      dir = cacheDirOrScope;
    } else if (cacheDirOrScope) {
      dir = scopedCacheDir(cacheDirOrScope.baseUrl, cacheDirOrScope.apiKey);
    } else {
      // Fallback: use a generic unscopable directory (testing only)
      dir = join(homedir(), ".xmemo", "_default");
    }
    ensureDir(dir);
    this.cacheFile = join(dir, "recall-cache.json");
    this.outboxFile = join(dir, "write-outbox.json");
    this.cache = readJsonSafe<CacheStore>(this.cacheFile, { version: 1, entries: {} });
    this.outbox = readJsonSafe<OutboxStore>(this.outboxFile, { version: 1, records: {} });
  }

  // -------------------------------------------------------------------------
  // Read Cache
  // -------------------------------------------------------------------------

  getCachedRecall(
    operation: string,
    query: string,
    params: Record<string, unknown>,
  ): { response: unknown; isFresh: boolean } | null {
    const id = hashSignature(operation, query, params);
    const entry = this.cache.entries[id];
    if (!entry) return null;

    const now = Date.now();
    if (now > entry.maxStaleUntil) {
      // Expired beyond max stale — evict
      delete this.cache.entries[id];
      this._saveCache();
      return null;
    }

    // Update hit count
    entry.hitCount++;
    this._saveCache();

    return {
      response: entry.response,
      isFresh: now <= entry.freshUntil,
    };
  }

  putCachedRecall(
    operation: string,
    query: string,
    params: Record<string, unknown>,
    response: unknown,
    freshTtlMs: number = 5 * 60 * 1000, // 5 minutes
    maxStaleTtlMs: number = 24 * 60 * 60 * 1000, // 24 hours
  ): void {
    const id = hashSignature(operation, query, params);
    const now = Date.now();

    this.cache.entries[id] = {
      id,
      operation,
      query,
      paramsHash: id,
      response,
      createdAt: now,
      freshUntil: now + freshTtlMs,
      maxStaleUntil: now + maxStaleTtlMs,
      hitCount: 0,
    };
    this._saveCache();
  }

  // -------------------------------------------------------------------------
  // Write Outbox
  // -------------------------------------------------------------------------

  enqueueWrite(
    operation: string,
    endpoint: string,
    method: string,
    payload: Record<string, unknown>,
    options?: {
      idempotencyKey?: string;
      autoReplay?: boolean;
    },
  ): string {
    const id = randomUUID();
    const now = Date.now();
    const idempotencyKey = options?.idempotencyKey ?? randomUUID();
    const autoReplay = options?.autoReplay ?? true;

    this.outbox.records[id] = {
      id,
      operation,
      endpoint,
      method,
      payload,
      idempotencyKey,
      status: autoReplay ? "pending" : "held",
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
      autoReplay,
    };
    this._saveOutbox();
    return id;
  }

  listPendingWrites(): OutboxRecord[] {
    const now = Date.now();
    return Object.values(this.outbox.records).filter(
      (r) => r.status === "pending" && (r.nextRetryAt === undefined || r.nextRetryAt <= now),
    );
  }

  lockForProcessing(recordId: string): boolean {
    const record = this.outbox.records[recordId];
    if (!record || record.status !== "pending") return false;
    record.status = "processing";
    record.lockedAt = Date.now();
    record.updatedAt = Date.now();
    this._saveOutbox();
    return true;
  }

  markSent(recordId: string): void {
    const record = this.outbox.records[recordId];
    if (!record) return;
    record.status = "sent";
    record.lockedAt = undefined;
    record.updatedAt = Date.now();
    this._saveOutbox();
  }

  markFailed(recordId: string, error: string, isTransient: boolean, maxRetries = 5): void {
    const record = this.outbox.records[recordId];
    if (!record) return;

    record.retryCount++;
    record.lastError = error;
    record.lockedAt = undefined;
    record.updatedAt = Date.now();

    if (!isTransient || record.retryCount >= maxRetries) {
      record.status = "failed";
    } else {
      // Exponential backoff: (2^retryCount) * 10s, capped at 1 hour
      const backoffMs = Math.min(Math.pow(2, record.retryCount) * 10_000, 3_600_000);
      record.nextRetryAt = Date.now() + backoffMs;
      record.status = "pending";
    }
    this._saveOutbox();
  }

  recoverStaleLocks(timeoutMs = 300_000): number {
    const staleTime = Date.now() - timeoutMs;
    let recovered = 0;

    for (const record of Object.values(this.outbox.records)) {
      if (record.status === "processing" && record.lockedAt !== undefined && record.lockedAt < staleTime) {
        record.status = record.autoReplay ? "pending" : "held";
        record.lockedAt = undefined;
        record.updatedAt = Date.now();
        recovered++;
      }
    }

    if (recovered > 0) this._saveOutbox();
    return recovered;
  }

  // -------------------------------------------------------------------------
  // Pruning & Stats
  // -------------------------------------------------------------------------

  pruneOldRecords(): void {
    const now = Date.now();
    const oneDayAgo = now - 86_400_000;
    const sevenDaysAgo = now - 7 * 86_400_000;
    let changed = false;

    // Prune sent records older than 24h
    for (const [id, record] of Object.entries(this.outbox.records)) {
      if (record.status === "sent" && record.updatedAt < oneDayAgo) {
        delete this.outbox.records[id];
        changed = true;
      }
    }

    // Prune failed records older than 7 days
    for (const [id, record] of Object.entries(this.outbox.records)) {
      if (record.status === "failed" && record.updatedAt < sevenDaysAgo) {
        delete this.outbox.records[id];
        changed = true;
      }
    }

    // Cap failed records at 100
    const failed = Object.values(this.outbox.records).filter((r) => r.status === "failed");
    if (failed.length > 100) {
      const excess = failed
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .slice(0, failed.length - 100);
      for (const r of excess) {
        delete this.outbox.records[r.id];
      }
      changed = true;
    }

    // Prune expired cache entries
    for (const [id, entry] of Object.entries(this.cache.entries)) {
      if (now > entry.maxStaleUntil) {
        delete this.cache.entries[id];
        changed = true;
      }
    }

    if (changed) {
      this._saveCache();
      this._saveOutbox();
    }
  }

  clearCache(): void {
    this.cache = { version: 1, entries: {} };
    this._saveCache();
  }

  clearOutbox(): void {
    this.outbox = { version: 1, records: {} };
    this._saveOutbox();
  }

  getStats(): {
    cacheEntries: number;
    pendingWrites: number;
    heldWrites: number;
    failedWrites: number;
    sentWrites: number;
  } {
    const records = Object.values(this.outbox.records);
    return {
      cacheEntries: Object.keys(this.cache.entries).length,
      pendingWrites: records.filter((r) => r.status === "pending").length,
      heldWrites: records.filter((r) => r.status === "held").length,
      failedWrites: records.filter((r) => r.status === "failed").length,
      sentWrites: records.filter((r) => r.status === "sent").length,
    };
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private _saveCache(): void {
    atomicWriteJson(this.cacheFile, this.cache);
  }

  private _saveOutbox(): void {
    atomicWriteJson(this.outboxFile, this.outbox);
  }
}
