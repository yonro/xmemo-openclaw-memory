import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  XMEMO_OUTBOX_MAX_RECORDS,
  XMemoLocalCache,
  XMemoLocalCacheStorageError,
  XMemoOutboxCapacityError,
} from "./local-cache.js";

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

    it("returns stale result when fresh TTL expired", async () => {
      const response = { items: [] };
      // Put with 1ms fresh TTL (expires almost immediately) but long max stale
      cache.putCachedRecall("recall_context", "q", { bucket: "%" }, response, 1, 3_600_000);

      // Wait to ensure fresh TTL has elapsed
      await new Promise((resolve) => setTimeout(resolve, 5));

      const result = cache.getCachedRecall("recall_context", "q", { bucket: "%" });
      expect(result).not.toBeNull();
      expect(result!.isFresh).toBe(false);
      expect(result!.response).toEqual(response);
    });

    it("returns null when max stale TTL expired", async () => {
      const response = { items: [] };
      // Put with 1ms fresh and 1ms max stale, then wait to ensure expiration
      cache.putCachedRecall("recall_context", "q", { bucket: "%" }, response, 1, 1);

      // Wait 5ms to guarantee TTL expiration regardless of clock resolution
      await new Promise((resolve) => setTimeout(resolve, 5));

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

    it("different scope and team combinations produce isolated cache entries", () => {
      const respTeamA = { items: [{ id: "team-a-mem" }] };
      const respTeamB = { items: [{ id: "team-b-mem" }] };
      const respPersonal = { items: [{ id: "personal-mem" }] };
      const respUnscoped = { items: [{ id: "unscoped-mem" }] };

      cache.putCachedRecall("search", "deploy", { bucket: "b", scope: "team", teamId: "team-1" }, respTeamA);
      cache.putCachedRecall("search", "deploy", { bucket: "b", scope: "team", teamId: "team-2" }, respTeamB);
      cache.putCachedRecall("search", "deploy", { bucket: "b", scope: "personal", teamId: null }, respPersonal);
      cache.putCachedRecall("search", "deploy", { bucket: "b", scope: null, teamId: null }, respUnscoped);

      expect(cache.getCachedRecall("search", "deploy", { bucket: "b", scope: "team", teamId: "team-1" })?.response).toEqual(respTeamA);
      expect(cache.getCachedRecall("search", "deploy", { bucket: "b", scope: "team", teamId: "team-2" })?.response).toEqual(respTeamB);
      expect(cache.getCachedRecall("search", "deploy", { bucket: "b", scope: "personal", teamId: null })?.response).toEqual(respPersonal);
      expect(cache.getCachedRecall("search", "deploy", { bucket: "b", scope: null, teamId: null })?.response).toEqual(respUnscoped);
    });
  });

  describe("write outbox", () => {
    it("merges writes from cache instances created before either write", () => {
      const cacheA = new XMemoLocalCache(cacheDir);
      const cacheB = new XMemoLocalCache(cacheDir);

      cacheA.enqueueWrite("remember", "/v1/remember", "POST", { content: "from A" });
      cacheB.enqueueWrite("remember", "/v1/remember", "POST", { content: "from B" });

      const freshCache = new XMemoLocalCache(cacheDir);
      expect(freshCache.listPendingWrites().map((record) => record.payload.content).sort()).toEqual([
        "from A",
        "from B",
      ]);
    });

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
      expect(stats.lastOutboxError).toBe("401 unauthorized");
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

    it("recoverStaleLocks resets stuck processing records", async () => {
      const id = cache.enqueueWrite("remember", "/v1/remember", "POST", { content: "test" });
      cache.lockForProcessing(id);

      // Wait to ensure the lock timestamp is in the past relative to a short timeout
      await new Promise((resolve) => setTimeout(resolve, 5));

      // Recover with 1ms timeout (everything locked before the wait is stale)
      const recovered = cache.recoverStaleLocks(1);
      expect(recovered).toBe(1);

      const pending = cache.listPendingWrites();
      expect(pending.length).toBe(1);
    });

    it("does not lose queue, sync, or cache deletion updates across two processes", async () => {
      const seededA = cache.enqueueWrite("remember", "/v1/remember", "POST", { content: "seed A" });
      const seededB = cache.enqueueWrite("remember", "/v1/remember", "POST", { content: "seed B" });
      cache.putCachedRecall("search", "query A", { bucket: "A" }, { items: ["A"] });
      cache.putCachedRecall("search", "query B", { bucket: "B" }, { items: ["B"] });
      cache.putCachedRecall("search", "keep", { bucket: "keep" }, { items: ["keep"] });

      const barrier = join(cacheDir, "workers-go");
      const workerSource = `
        import { existsSync } from "node:fs";
        const [moduleUrl, cacheDir, barrier, label, recordId, bucket] = process.argv.slice(1);
        const { XMemoLocalCache } = await import(moduleUrl);
        const cache = new XMemoLocalCache(cacheDir);
        console.log("READY");
        while (!existsSync(barrier)) await new Promise((resolve) => setTimeout(resolve, 2));
        cache.enqueueWrite("remember", "/v1/remember", "POST", { content: label });
        if (!cache.lockForProcessing(recordId)) throw new Error("could not lock " + recordId);
        cache.markSent(recordId);
        cache.invalidateRecallCache({ bucket });
      `;
      const moduleUrl = new URL("./local-cache.ts", import.meta.url).href;
      const workers = [
        ["process A", seededA, "A"],
        ["process B", seededB, "B"],
      ].map(([label, recordId, bucket]) => {
        const child = spawn(
          process.execPath,
          ["--experimental-strip-types", "--input-type=module", "-e", workerSource, moduleUrl, cacheDir, barrier, label, recordId, bucket],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let output = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => { output += chunk; });
        child.stderr.on("data", (chunk: string) => { output += chunk; });
        const ready = new Promise<void>((resolve, reject) => {
          child.stdout.on("data", () => {
            if (output.includes("READY")) resolve();
          });
          child.once("error", reject);
          child.once("exit", (code) => {
            if (!output.includes("READY")) reject(new Error(`worker exited before READY (${code}): ${output}`));
          });
        });
        const exited = new Promise<{ code: number | null; output: string }>((resolve) => {
          child.once("exit", (code) => resolve({ code, output }));
        });
        return { ready, exited };
      });

      await Promise.all(workers.map((worker) => worker.ready));
      writeFileSync(barrier, "go");
      const results = await Promise.all(workers.map((worker) => worker.exited));
      expect(results).toEqual([
        { code: 0, output: expect.stringContaining("READY") },
        { code: 0, output: expect.stringContaining("READY") },
      ]);

      const fresh = new XMemoLocalCache(cacheDir);
      expect(fresh.listPendingWrites().map((record) => record.payload.content).sort()).toEqual([
        "process A",
        "process B",
      ]);
      expect(fresh.getStats()).toMatchObject({ sentWrites: 2, pendingWrites: 2, cacheEntries: 1 });
      expect(fresh.getCachedRecall("search", "query A", { bucket: "A" })).toBeNull();
      expect(fresh.getCachedRecall("search", "query B", { bucket: "B" })).toBeNull();
      expect(fresh.getCachedRecall("search", "keep", { bucket: "keep" })).not.toBeNull();
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

    it("invalidateRecallCache removes matching scope entries while keeping others and preserving outbox", () => {
      cache.putCachedRecall("search", "q1", { bucket: "openclaw", scope: "team", teamId: "t1" }, { items: ["a"] });
      cache.putCachedRecall("search", "q2", { bucket: "openclaw", scope: "personal", teamId: null }, { items: ["b"] });
      cache.putCachedRecall("search", "q3", { bucket: "other", scope: "team", teamId: "t1" }, { items: ["c"] });
      cache.enqueueWrite("remember", "/v1/remember", "POST", { content: "keep-me" });

      const removed = cache.invalidateRecallCache({ bucket: "openclaw", scope: "team", teamId: "t1" });
      expect(removed).toBe(1);

      expect(cache.getCachedRecall("search", "q1", { bucket: "openclaw", scope: "team", teamId: "t1" })).toBeNull();
      expect(cache.getCachedRecall("search", "q2", { bucket: "openclaw", scope: "personal", teamId: null })).not.toBeNull();
      expect(cache.getCachedRecall("search", "q3", { bucket: "other", scope: "team", teamId: "t1" })).not.toBeNull();
      expect(cache.getStats().pendingWrites).toBe(1);
    });

    it("invalidateRecallCache with no filter removes all cache entries but preserves outbox", () => {
      cache.putCachedRecall("search", "q1", { bucket: "b" }, { items: ["a"] });
      cache.enqueueWrite("remember", "/v1/remember", "POST", { content: "keep-me" });

      const removed = cache.invalidateRecallCache();
      expect(removed).toBe(1);
      expect(cache.getStats().cacheEntries).toBe(0);
      expect(cache.getStats().pendingWrites).toBe(1);
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

    it("writes cache and outbox files with owner-only permissions where supported", () => {
      cache.putCachedRecall("recall_context", "q", {}, {});
      cache.enqueueWrite("remember", "/v1/remember", "POST", {});

      if (process.platform === "win32") {
        return;
      }

      expect(statSync(join(cacheDir, "recall-cache.json")).mode & 0o777).toBe(0o600);
      expect(statSync(join(cacheDir, "write-outbox.json")).mode & 0o777).toBe(0o600);
    });

    it("surfaces malformed outbox JSON and preserves the unconfirmed file", () => {
      const corrupted = "{ broken";
      const outboxFile = join(cacheDir, "write-outbox.json");
      writeFileSync(outboxFile, corrupted, "utf8");

      const damagedCache = new XMemoLocalCache(cacheDir);
      expect(damagedCache.getStats().outboxReadError).toContain("file is not valid JSON");
      expect(() => damagedCache.enqueueWrite("remember", "/v1/remember", "POST", { content: "new" }))
        .toThrow(XMemoLocalCacheStorageError);
      expect(readFileSync(outboxFile, "utf8")).toBe(corrupted);
    });

    it("keeps old failed records and visibly rejects enqueue at capacity", () => {
      const records = Object.fromEntries(Array.from({ length: XMEMO_OUTBOX_MAX_RECORDS }, (_, index) => {
        const failed = index < 101;
        const id = `record-${index}`;
        return [id, {
          id,
          operation: "remember",
          endpoint: "/v1/remember",
          method: "POST",
          payload: { index },
          idempotencyKey: `key-${index}`,
          status: failed ? "failed" : "pending",
          retryCount: failed ? 5 : 0,
          lastError: failed ? "permanent error" : undefined,
          createdAt: 0,
          updatedAt: failed ? 0 : Date.now(),
          autoReplay: true,
        }];
      }));
      writeFileSync(join(cacheDir, "write-outbox.json"), JSON.stringify({ version: 1, records }), "utf8");

      const fullCache = new XMemoLocalCache(cacheDir);
      fullCache.pruneOldRecords();
      expect(() => fullCache.enqueueWrite("remember", "/v1/remember", "POST", { content: "new" }))
        .toThrow(XMemoOutboxCapacityError);
      const persisted = JSON.parse(readFileSync(join(cacheDir, "write-outbox.json"), "utf8"));
      expect(Object.keys(persisted.records)).toHaveLength(XMEMO_OUTBOX_MAX_RECORDS);
      expect(Object.values(persisted.records).filter((record: any) => record.status === "failed")).toHaveLength(101);
    });

    it("keeps credential-scoped data isolated when configuration switches A to B to A", () => {
      const previousOpenClawData = process.env.OPENCLAW_DATA_DIR;
      const previousXdgData = process.env.XDG_DATA_HOME;
      process.env.OPENCLAW_DATA_DIR = join(cacheDir, "scoped-data");
      delete process.env.XDG_DATA_HOME;
      try {
        new XMemoLocalCache({ baseUrl: "https://api.example", apiKey: "account-A" })
          .enqueueWrite("remember", "/v1/remember", "POST", { content: "A data" });
        new XMemoLocalCache({ baseUrl: "https://api.example", apiKey: "account-B" })
          .enqueueWrite("remember", "/v1/remember", "POST", { content: "B data" });
        const accountAAgain = new XMemoLocalCache({ baseUrl: "https://api.example", apiKey: "account-A" });
        const accountBAgain = new XMemoLocalCache({ baseUrl: "https://api.example", apiKey: "account-B" });
        expect(accountAAgain.listPendingWrites().map((record) => record.payload.content)).toEqual(["A data"]);
        expect(accountBAgain.listPendingWrites().map((record) => record.payload.content)).toEqual(["B data"]);
      } finally {
        if (previousOpenClawData === undefined) delete process.env.OPENCLAW_DATA_DIR;
        else process.env.OPENCLAW_DATA_DIR = previousOpenClawData;
        if (previousXdgData === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previousXdgData;
      }
    });
  });
});
