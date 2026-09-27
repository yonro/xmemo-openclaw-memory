/**
 * Lightweight file-based local cache and write outbox for the XMemo OpenClaw plugin.
 *
 * JSON files live under the OpenClaw data directory (or ~/.xmemo fallback). Each
 * read-modify-write transaction reloads the latest file while holding an
 * exclusive lock, so multiple plugin instances and processes cannot overwrite
 * one another's changes.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type CachedRecallEntry = {
  id: string;
  operation: string;
  query: string;
  paramsHash: string;
  response: unknown;
  bucket?: string;
  scope?: string | null;
  teamId?: string | null;
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

type CacheStore = { version: 1; entries: Record<string, CachedRecallEntry> };
type OutboxStore = { version: 1; records: Record<string, OutboxRecord> };

export const XMEMO_OUTBOX_MAX_RECORDS = 1_000;
const LOCK_WAIT_MS = 15_000;
const LOCK_STALE_MS = 2 * 60_000;

export type XMemoLocalCacheStorageErrorKind = "read" | "parse" | "structure" | "lock";

export class XMemoLocalCacheStorageError extends Error {
  readonly filepath: string;
  readonly kind: XMemoLocalCacheStorageErrorKind;

  constructor(filepath: string, kind: XMemoLocalCacheStorageErrorKind, detail: string) {
    super(`XMemo local storage error at ${filepath}: ${detail}`);
    this.name = "XMemoLocalCacheStorageError";
    this.filepath = filepath;
    this.kind = kind;
  }
}

export type XMemoLocalCacheOptions = { onWarning?: (message: string) => void };

export class XMemoOutboxCapacityError extends Error {
  constructor(limit: number) {
    super(`XMemo write queue is full (${limit} records). No write was queued; existing records were kept.`);
    this.name = "XMemoOutboxCapacityError";
  }
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // chmod is best-effort on Windows and some mounted filesystems.
  }
}

function atomicWriteJson(filepath: string, data: unknown): void {
  ensureDir(dirname(filepath));
  const tmp = join(dirname(filepath), `.xmemo-${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // chmod is best-effort on Windows and some mounted filesystems.
    }
    try {
      renameSync(tmp, filepath);
    } catch (err: unknown) {
      const code = err && typeof err === "object" && "code" in err
        ? (err as { code?: string }).code
        : undefined;
      if (process.platform === "win32" && (code === "EPERM" || code === "EBUSY" || code === "EACCES")) {
        try {
          copyFileSync(tmp, filepath);
          unlinkSync(tmp);
        } catch {
          renameSync(tmp, filepath);
        }
      } else {
        throw err;
      }
    }
    try {
      chmodSync(filepath, 0o600);
    } catch {
      // chmod is best-effort on Windows and some mounted filesystems.
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file has normally been renamed already.
    }
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJsonStore<T extends { version: 1 }>(
  filepath: string,
  key: "entries" | "records",
  fallback: T,
): T {
  let raw: string;
  try {
    raw = readFileSync(filepath, "utf-8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return fallback;
    }
    throw new XMemoLocalCacheStorageError(filepath, "read", error instanceof Error ? error.message : String(error));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new XMemoLocalCacheStorageError(
      filepath,
      "parse",
      `file is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!isObjectRecord(parsed) || parsed.version !== 1 || !isObjectRecord(parsed[key])) {
    throw new XMemoLocalCacheStorageError(filepath, "structure", `file has an invalid ${key} store structure`);
  }
  for (const value of Object.values(parsed[key])) {
    if (!isObjectRecord(value)) {
      throw new XMemoLocalCacheStorageError(filepath, "structure", `file contains an invalid ${key} record`);
    }
  }
  return parsed as T;
}

function withFileLock<T>(filepath: string, operation: () => T): T {
  ensureDir(dirname(filepath));
  const lockPath = `${filepath}.lock`;
  const token = `${process.pid}:${randomUUID()}`;
  const startedAt = Date.now();

  while (true) {
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, `${token}\n${Date.now()}`, "utf-8");
      closeSync(fd);
      fd = undefined;
      break;
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Continue to release the lock path below if it belongs to this attempt.
        }
        try {
          if (readFileSync(lockPath, "utf-8").startsWith(`${token}\n`)) unlinkSync(lockPath);
        } catch {
          // The lock may already have been removed by stale-lock recovery.
        }
      }
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : undefined;
      if (code !== "EEXIST") {
        throw new XMemoLocalCacheStorageError(filepath, "lock", `could not acquire file lock (${String(error)})`);
      }

      try {
        const firstStat = statSync(lockPath);
        if (Date.now() - firstStat.mtimeMs > LOCK_STALE_MS) {
          const secondStat = statSync(lockPath);
          if (firstStat.ino === secondStat.ino && firstStat.mtimeMs === secondStat.mtimeMs) {
            unlinkSync(lockPath);
            continue;
          }
        }
      } catch (statError) {
        if (statError && typeof statError === "object" && "code" in statError && statError.code === "ENOENT") {
          continue;
        }
        throw new XMemoLocalCacheStorageError(filepath, "lock", `could not inspect file lock (${String(statError)})`);
      }

      if (Date.now() - startedAt >= LOCK_WAIT_MS) {
        throw new XMemoLocalCacheStorageError(filepath, "lock", `timed out waiting for file lock ${lockPath}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }

  try {
    return operation();
  } finally {
    try {
      if (readFileSync(lockPath, "utf-8").startsWith(`${token}\n`)) unlinkSync(lockPath);
    } catch {
      // Lock cleanup is best-effort; the next holder reclaims stale locks.
    }
  }
}

function hashSignature(operation: string, query: string, params: Record<string, unknown>): string {
  const sorted = JSON.stringify(params, Object.keys(params).sort());
  return createHash("sha256").update(`${operation}:${query}:${sorted}`).digest("hex");
}

function scopedCacheDir(baseUrl: string, apiKey: string): string {
  const baseDir = (() => {
    const openclawData = process.env.OPENCLAW_DATA_DIR;
    if (openclawData) return join(openclawData, "xmemo");
    const xdg = process.env.XDG_DATA_HOME;
    if (xdg) return join(xdg, "xmemo");
    return join(homedir(), ".xmemo");
  })();
  const credentialFingerprint = apiKey ? createHash("sha256").update(apiKey).digest("hex") : "anonymous";
  const scopeHash = createHash("sha256")
    .update(JSON.stringify({ baseUrl, credentialFingerprint }))
    .digest("hex")
    .slice(0, 16);
  return join(baseDir, scopeHash);
}

export class XMemoLocalCache {
  private readonly cacheFile: string;
  private readonly outboxFile: string;
  private readonly onWarning: (message: string) => void;
  private _cacheStorageError: XMemoLocalCacheStorageError | null = null;
  private _outboxStorageError: XMemoLocalCacheStorageError | null = null;
  private _lastCacheWarning: string | null = null;

  constructor(
    cacheDirOrScope?: string | { baseUrl: string; apiKey: string },
    options: XMemoLocalCacheOptions = {},
  ) {
    this.onWarning = options.onWarning ?? (() => {});
    let dir: string;
    if (typeof cacheDirOrScope === "string") {
      dir = cacheDirOrScope;
    } else if (cacheDirOrScope) {
      dir = scopedCacheDir(cacheDirOrScope.baseUrl, cacheDirOrScope.apiKey);
    } else {
      dir = join(homedir(), ".xmemo", "_default");
    }
    ensureDir(dir);
    this.cacheFile = join(dir, "recall-cache.json");
    this.outboxFile = join(dir, "write-outbox.json");
    // The recall cache is disposable; corrupt JSON is quarantined. Other read
    // failures remain explicit. The outbox is authoritative for unconfirmed
    // writes, so it is left untouched and marked unavailable instead.
    try {
      this._readCache();
    } catch (error) {
      if (!(error instanceof XMemoLocalCacheStorageError)) throw error;
      this._cacheStorageError = error;
    }
    try {
      this._readOutbox();
    } catch (error) {
      if (!(error instanceof XMemoLocalCacheStorageError)) throw error;
      this._outboxStorageError = error;
    }
  }

  getCachedRecall(
    operation: string,
    query: string,
    params: Record<string, unknown>,
  ): { response: unknown; isFresh: boolean } | null {
    const id = hashSignature(operation, query, params);
    return this._mutateCache((store) => {
      const entry = store.entries[id];
      if (!entry) return { result: null, changed: false };
      const now = Date.now();
      if (now > entry.maxStaleUntil) {
        delete store.entries[id];
        return { result: null, changed: true };
      }
      entry.hitCount++;
      return { result: { response: entry.response, isFresh: now <= entry.freshUntil }, changed: true };
    });
  }

  putCachedRecall(
    operation: string,
    query: string,
    params: Record<string, unknown>,
    response: unknown,
    freshTtlMs = 5 * 60 * 1000,
    maxStaleTtlMs = 24 * 60 * 60 * 1000,
  ): void {
    const id = hashSignature(operation, query, params);
    const now = Date.now();
    this._mutateCache((store) => {
      store.entries[id] = {
        id,
        operation,
        query,
        paramsHash: id,
        response,
        bucket: typeof params.bucket === "string" ? params.bucket : undefined,
        scope: params.scope !== undefined ? (params.scope as string | null) : undefined,
        teamId: params.teamId !== undefined ? (params.teamId as string | null) : undefined,
        createdAt: now,
        freshUntil: now + freshTtlMs,
        maxStaleUntil: now + maxStaleTtlMs,
        hitCount: 0,
      };
      return { result: undefined, changed: true };
    });
  }

  enqueueWrite(
    operation: string,
    endpoint: string,
    method: string,
    payload: Record<string, unknown>,
    options?: { idempotencyKey?: string; autoReplay?: boolean },
  ): string {
    const id = randomUUID();
    const now = Date.now();
    const idempotencyKey = options?.idempotencyKey ?? randomUUID();
    const autoReplay = options?.autoReplay ?? true;
    return this._mutateOutbox((store) => {
      const oldestRetainedSentAt = now - 86_400_000;
      for (const [recordId, record] of Object.entries(store.records)) {
        if (record.status === "sent" && record.updatedAt < oldestRetainedSentAt) {
          delete store.records[recordId];
        }
      }
      if (Object.keys(store.records).length >= XMEMO_OUTBOX_MAX_RECORDS) {
        throw new XMemoOutboxCapacityError(XMEMO_OUTBOX_MAX_RECORDS);
      }
      store.records[id] = {
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
      return { result: id, changed: true };
    });
  }

  listPendingWrites(): OutboxRecord[] {
    const now = Date.now();
    return Object.values(this._readOutbox().records).filter(
      (record) => record.status === "pending" && (record.nextRetryAt === undefined || record.nextRetryAt <= now),
    );
  }

  lockForProcessing(recordId: string): boolean {
    return this._mutateOutbox((store) => {
      const record = store.records[recordId];
      if (!record || record.status !== "pending") return { result: false, changed: false };
      record.status = "processing";
      record.lockedAt = Date.now();
      record.updatedAt = record.lockedAt;
      return { result: true, changed: true };
    });
  }

  markSent(recordId: string): void {
    this._mutateOutbox((store) => {
      const record = store.records[recordId];
      if (!record) return { result: undefined, changed: false };
      record.status = "sent";
      record.lockedAt = undefined;
      record.lastError = undefined;
      record.updatedAt = Date.now();
      return { result: undefined, changed: true };
    });
  }

  markFailed(recordId: string, error: string, isTransient: boolean, maxRetries = 5): void {
    this._mutateOutbox((store) => {
      const record = store.records[recordId];
      if (!record) return { result: undefined, changed: false };
      record.retryCount++;
      record.lastError = error;
      record.lockedAt = undefined;
      record.updatedAt = Date.now();
      if (!isTransient || record.retryCount >= maxRetries) {
        record.status = "failed";
        record.nextRetryAt = undefined;
      } else {
        const backoffMs = Math.min(Math.pow(2, record.retryCount) * 10_000, 3_600_000);
        record.nextRetryAt = Date.now() + backoffMs;
        record.status = "pending";
      }
      return { result: undefined, changed: true };
    });
  }

  recoverStaleLocks(timeoutMs = 300_000): number {
    return this._mutateOutbox((store) => {
      const staleTime = Date.now() - timeoutMs;
      let recovered = 0;
      for (const record of Object.values(store.records)) {
        if (record.status === "processing" && record.lockedAt !== undefined && record.lockedAt < staleTime) {
          record.status = record.autoReplay ? "pending" : "held";
          record.lockedAt = undefined;
          record.updatedAt = Date.now();
          recovered++;
        }
      }
      return { result: recovered, changed: recovered > 0 };
    });
  }

  pruneOldRecords(): void {
    const now = Date.now();
    const oneDayAgo = now - 86_400_000;
    this._mutateOutbox((store) => {
      let changed = false;
      // Only cloud-confirmed sent records can be discarded. Failed records stay
      // visible indefinitely until a user or explicit operation removes them.
      for (const [id, record] of Object.entries(store.records)) {
        if (record.status === "sent" && record.updatedAt < oneDayAgo) {
          delete store.records[id];
          changed = true;
        }
      }
      return { result: undefined, changed };
    });
    this._mutateCache((store) => {
      let changed = false;
      for (const [id, entry] of Object.entries(store.entries)) {
        if (now > entry.maxStaleUntil) {
          delete store.entries[id];
          changed = true;
        }
      }
      return { result: undefined, changed };
    });
  }

  invalidateRecallCache(filter?: { bucket?: string | null; scope?: string | null; teamId?: string | null }): number {
    return this._mutateCache((store) => {
      let count = 0;
      for (const [id, entry] of Object.entries(store.entries)) {
        if (filter) {
          if (filter.bucket !== undefined && filter.bucket !== null && entry.bucket !== undefined) {
            const bucketMatches = entry.bucket === "%" || filter.bucket === "%" || entry.bucket.toLowerCase() === filter.bucket.toLowerCase();
            if (!bucketMatches) continue;
          }
          if (filter.scope !== undefined && entry.scope !== undefined) {
            if (!(entry.scope === null || filter.scope === null || entry.scope === filter.scope)) continue;
          }
          if (filter.teamId !== undefined && entry.teamId !== undefined) {
            if (!(entry.teamId === null || filter.teamId === null || entry.teamId === filter.teamId)) continue;
          }
        }
        delete store.entries[id];
        count++;
      }
      return { result: count, changed: count > 0 };
    });
  }

  clearCache(): void {
    this._mutateCache((store) => {
      store.entries = {};
      return { result: undefined, changed: true };
    });
  }

  clearOutbox(): void {
    this._mutateOutbox((store) => {
      store.records = {};
      return { result: undefined, changed: true };
    });
  }

  getStats(): {
    cacheEntries: number;
    pendingWrites: number;
    heldWrites: number;
    failedWrites: number;
    sentWrites: number;
    lastOutboxError: string | null;
    lastOutboxErrorAt: number | null;
    cacheReadError: string | null;
    cacheWarning: string | null;
    outboxReadError: string | null;
  } {
    let records: OutboxRecord[] = [];
    let outboxReadError: string | null = this._outboxStorageError?.message ?? null;
    try {
      records = Object.values(this._readOutbox().records);
    } catch (error) {
      outboxReadError = error instanceof Error ? error.message : String(error);
    }
    let cacheEntries = 0;
    let cacheReadError: string | null = this._cacheStorageError?.message ?? null;
    try {
      cacheEntries = Object.keys(this._readCache().entries).length;
    } catch (error) {
      cacheReadError = error instanceof Error ? error.message : String(error);
      if (error instanceof XMemoLocalCacheStorageError) this._cacheStorageError = error;
    }
    const latestError = records
      .filter((record) => record.lastError && (record.status === "pending" || record.status === "failed"))
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    return {
      cacheEntries,
      pendingWrites: records.filter((record) => record.status === "pending").length,
      heldWrites: records.filter((record) => record.status === "held").length,
      failedWrites: records.filter((record) => record.status === "failed").length,
      sentWrites: records.filter((record) => record.status === "sent").length,
      lastOutboxError: latestError?.lastError ?? outboxReadError,
      lastOutboxErrorAt: latestError?.updatedAt ?? null,
      cacheReadError,
      cacheWarning: this._lastCacheWarning,
      outboxReadError,
    };
  }

  private _readCache(): CacheStore {
    return withFileLock(this.cacheFile, () => this._readCacheLocked());
  }

  private _readCacheLocked(): CacheStore {
    try {
      const store = readJsonStore(this.cacheFile, "entries", { version: 1, entries: {} });
      this._cacheStorageError = null;
      return store;
    } catch (error) {
      if (!(error instanceof XMemoLocalCacheStorageError)) throw error;
      if (error.kind !== "parse" && error.kind !== "structure") {
        this._cacheStorageError = error;
        throw error;
      }

      const quarantinePath = `${this.cacheFile}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`;
      try {
        renameSync(this.cacheFile, quarantinePath);
      } catch (renameError) {
        const code = renameError && typeof renameError === "object" && "code" in renameError
          ? (renameError as { code?: string }).code
          : undefined;
        if (code !== "ENOENT") {
          const storageError = new XMemoLocalCacheStorageError(
            this.cacheFile,
            "read",
            `could not quarantine corrupt cache file (${String(renameError)})`,
          );
          this._cacheStorageError = storageError;
          throw storageError;
        }
      }

      this._cacheStorageError = null;
      this._lastCacheWarning = "XMemo recall cache was corrupt and quarantined; a fresh cache will be used.";
      try {
        this.onWarning(`${this._lastCacheWarning} Backup: ${quarantinePath}`);
      } catch {
        // Logging callbacks must not turn a recoverable cache fault into an outage.
      }
      return { version: 1, entries: {} };
    }
  }

  private _readOutbox(): OutboxStore {
    try {
      const store = readJsonStore(this.outboxFile, "records", { version: 1, records: {} });
      this._outboxStorageError = null;
      return store;
    } catch (error) {
      if (error instanceof XMemoLocalCacheStorageError) this._outboxStorageError = error;
      throw error;
    }
  }

  private _mutateCache<T>(mutator: (store: CacheStore) => { result: T; changed: boolean }): T {
    return withFileLock(this.cacheFile, () => {
      const store = this._readCacheLocked();
      const outcome = mutator(store);
      if (outcome.changed) atomicWriteJson(this.cacheFile, store);
      return outcome.result;
    });
  }

  private _mutateOutbox<T>(mutator: (store: OutboxStore) => { result: T; changed: boolean }): T {
    return withFileLock(this.outboxFile, () => {
      const store = this._readOutbox();
      const outcome = mutator(store);
      if (outcome.changed) atomicWriteJson(this.outboxFile, store);
      return outcome.result;
    });
  }
}
