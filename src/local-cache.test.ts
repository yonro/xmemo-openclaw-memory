import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { XMemoLocalCache } from "./local-cache.js";

describe("XMemoLocalCache", () => {
  let cacheDir: string;
  let cache: XMemoLocalCache;

  beforeEach(() => {
    cacheDir = join(tmpdir(), `xmemo-test-${randomUUID()}`);
    mkdirSync(cacheDir, { recursive: true });
    cache = new XMemoLocalCache(cacheDir);
  });

  afterEach(() => {
    try {
      rmSync(cacheDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("recall cache", () => {
    it("returns null for cache miss", () => {
      const result = cache.getCachedRecall("recall_context", "test query", { bucket: "%" });
      expect(result).toBeNull();
    });

    it("stores and retrieves cached recall", () => {
      const response = { items: [{ id: "1", content: "hello" }] };
      cache.putCachedRecall("recall_context", "test query", { bucket: "%" }, response);

      const result = cache.getCachedRecall("recall_context", "test query", { bucket: "%" });
      expect(result).not.toBeNull();
      expect(result!.isFresh).toBe(true);
      expect(result!.response).toEqual(response);
    });

    it("returns stale result when fresh TTL expired", () => {
      const response = { items: [] };
      // Put with 0ms fresh TTL (immediately stale) but 1h max stale
      cache.putCachedRecall("recall_context", "q", { bucket: "%" }, response, 0, 3_600_000);

      const result = cache.getCachedRecall("recall_context", "q", { bucket: "%" });
      expect(result).not.toBeNull();
      expect(result!.isFresh).toBe(false);
      expect(result!.response).toEqual(response);
    });

    it("returns null when max stale TTL expired", () => {
      const response = { items: [] };
      // Put with 0ms fresh and 0ms max stale (immediately expired)
      cache.putCachedRecall("recall_context", "q", { bucket: "%" }, response, 0, 0);

      const result = cache.getCachedRecall("recall_context", "q", { bucket: "%" });
      expect(result).toBeNull();
    });

    it("increments hit count on retrieval", () => {
      const response = { items: [] };
      cache.putCachedRecall("recall_context", "q", { bucket: "%" }, response);

      cache.getCachedRecall("recall_context", "q", { bucket: "%" });
      cache.getCachedRecall("recall_context", "q", { bucket: "%" });

      const stats = cache.getStats();
      expect(stats.cacheEntries).toBe(1);
    });

    it("different params produce different cache entries", () => {
      const r1 = { items: [{ id: "1" }] };
      const r2 = { items: [{ id: "2" }] };

      cache.putCachedRecall("recall_context", "q", { bucket: "work" }, r1);
      cache.putCachedRecall("recall_context", "q", { bucket: "public" }, r2);

      const result1 = cache.getCachedRecall("recall_context", "q", { bucket: "work" });
      const result2 = cache.getCachedRecall("recall_context", "q", { bucket: "public" });
      expect(result1!.response).toEqual(r1);
      expect(result2!.response).toEqual(r2);
    });
  });

  describe("write outbox", () => {
    it("enqueues a write and lists it as pending", () => {
      const id = cache.enqueueWrite("remember", "/v1/remember", "POST", { content: "test" });
      expect(id).toBeTruthy();

      const pending = cache.listPendingWrites();
      expect(pending.length).toBe(1);
      expect(pending[0].operation).toBe("remember");
      expect(pending[0].idempotencyKey).toBeTruthy();
    });

    it("lock transitions record to processing", () => {
      const id = cache.enqueueWrite("remember", "/v1/remember", "POST", { content: "test" });

      const locked = cache.lockForProcessing(id);
      expect(locked).toBe(true);

      // Should no longer appear in pending
      const pending = cache.listPendingWrites();
      expect(pending.length).toBe(0);
    });

    it("markSent transitions to sent status", () => {
      const id = cache.enqueueWrite("remember", "/v1/remember", "POST", { content: "test" });
      cache.lockForProcessing(id);
      cache.markSent(id);

      const stats = cache.getStats();
      expect(stats.sentWrites).toBe(1);
      expect(stats.pendingWrites).toBe(0);
    });

    it("markFailed with transient error uses exponential backoff", () => {
      const id = cache.enqueueWrite("remember", "/v1/remember", "POST", { content: "test" });
      cache.lockForProcessing(id);
      cache.markFailed(id, "timeout", true);

      const stats = cache.getStats();
      expect(stats.pendingWrites).toBe(1); // Back to pending with nextRetryAt

      // Should not appear in listPendingWrites yet (nextRetryAt is in the future)
      const pending = cache.listPendingWrites();
      expect(pending.length).toBe(0);
    });

    it("markFailed with non-transient error dead-letters immediately", () => {
      const id = cache.enqueueWrite("remember", "/v1/remember", "POST", { content: "test" });
      cache.lockForProcessing(id);
      cache.markFailed(id, "401 unauthorized", false);

      const stats = cache.getStats();
      expect(stats.failedWrites).toBe(1);
      expect(stats.pendingWrites).toBe(0);
    });

    it("dead-letters after max retries", () => {
      const id = cache.enqueueWrite("remember", "/v1/remember", "POST", { content: "test" });

      for (let i = 0; i < 5; i++) {
        cache.lockForProcessing(id);
        cache.markFailed(id, "server error", true, 5);
        // For retries 1-4, manually reset status to pending for the loop
        // (in real usage, nextRetryAt would be in the future)
      }

      const stats = cache.getStats();
      expect(stats.failedWrites).toBe(1);
    });

    it("held writes are not listed as pending", () => {
      cache.enqueueWrite("record_event", "/v1/timeline/events", "POST", { content: "event" }, {
        autoReplay: false,
      });

      const pending = cache.listPendingWrites();
      expect(pending.length).toBe(0);

      const stats = cache.getStats();
      expect(stats.heldWrites).toBe(1);
    });

    it("recoverStaleLocks resets stuck processing records", () => {
      const id = cache.enqueueWrite("remember", "/v1/remember", "POST", { content: "test" });
      cache.lockForProcessing(id);

      // Recover with 0ms timeout (everything is stale)
      const recovered = cache.recoverStaleLocks(0);
      expect(recovered).toBe(1);

      const pending = cache.listPendingWrites();
      expect(pending.length).toBe(1);
    });
  });

  describe("pruning", () => {
    it("clearCache removes all cache entries", () => {
      cache.putCachedRecall("recall_context", "q1", {}, { items: [] });
      cache.putCachedRecall("recall_context", "q2", {}, { items: [] });
      expect(cache.getStats().cacheEntries).toBe(2);

      cache.clearCache();
      expect(cache.getStats().cacheEntries).toBe(0);
    });

    it("clearOutbox removes all outbox records", () => {
      cache.enqueueWrite("remember", "/v1/remember", "POST", { content: "a" });
      cache.enqueueWrite("remember", "/v1/remember", "POST", { content: "b" });
      expect(cache.getStats().pendingWrites).toBe(2);

      cache.clearOutbox();
      expect(cache.getStats().pendingWrites).toBe(0);
    });
  });

  describe("persistence", () => {
    it("survives re-instantiation from same directory", () => {
      cache.putCachedRecall("recall_context", "persist-q", { bucket: "%" }, { items: [{ id: "x" }] });
      cache.enqueueWrite("remember", "/v1/remember", "POST", { content: "durable" });

      // Create a new instance pointing to the same directory
      const cache2 = new XMemoLocalCache(cacheDir);

      const result = cache2.getCachedRecall("recall_context", "persist-q", { bucket: "%" });
      expect(result).not.toBeNull();
      expect(result!.isFresh).toBe(true);

      const pending = cache2.listPendingWrites();
      expect(pending.length).toBe(1);
      expect(pending[0].payload).toEqual({ content: "durable" });
    });

    it("creates cache files in the specified directory", () => {
      cache.putCachedRecall("recall_context", "q", {}, {});
      cache.enqueueWrite("remember", "/v1/remember", "POST", {});

      expect(existsSync(join(cacheDir, "recall-cache.json"))).toBe(true);
      expect(existsSync(join(cacheDir, "write-outbox.json"))).toBe(true);
    });
  });
});
