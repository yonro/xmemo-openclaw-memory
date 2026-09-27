import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { globalBreaker, XMemoClient } from "./client.js";
import type { XMemoMemoryConfig } from "./config.js";
import { XMEMO_OUTBOX_MAX_RECORDS, XMemoLocalCache } from "./local-cache.js";
import { ResilientXMemoClient } from "./resilient-client.js";

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function config(overrides: Partial<XMemoMemoryConfig> = {}): XMemoMemoryConfig {
  return {
    baseUrl: "https://xmemo.dev",
    apiKey: "key",
    bucket: "openclaw",
    scope: undefined,
    readBucket: "%",
    readScope: undefined,
    teamId: undefined,
    agentId: "openclaw",
    agentInstanceId: "instance",
    authMode: "api-key",
    autoCapture: false,
    captureMaxChars: 500,
    customTriggers: undefined,
    recallMaxChars: 1000,
    recallMaxItems: 8,
    recallMaxTokens: 1500,
    ...overrides,
  };
}

function buildClient(cacheDir: string, cfg = config()): ResilientXMemoClient {
  const raw = new XMemoClient(
    cfg.baseUrl,
    cfg.apiKey ?? "",
    cfg.agentId,
    cfg.agentInstanceId,
    cfg.authMode,
  );
  return new ResilientXMemoClient(raw, cfg, new XMemoLocalCache(cacheDir));
}

describe("ResilientXMemoClient read cache policy", () => {
  let cacheDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    cacheDir = join(tmpdir(), `xmemo-resilient-${randomUUID()}`);
    mkdirSync(cacheDir, { recursive: true });
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("queries cloud even when recall cache is fresh", async () => {
    const cache = new XMemoLocalCache(cacheDir);
    cache.putCachedRecall(
      "recall_context",
      "project plan",
      {
        query: "project plan",
        bucket: "%",
        scope: null,
        teamId: null,
        maxItems: 8,
        maxTokens: 1500,
      },
      { items: [{ id: "cached", content: "cached partial result" }] },
    );
    fetchMock.mockResolvedValue(
      mockResponse({ items: [{ id: "remote", content: "remote authoritative result" }] }),
    );

    const result = await buildClient(cacheDir).recallContext("project plan", {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ fromCache: false, isFresh: true });
    expect(result.result).toEqual({
      items: [{ id: "remote", content: "remote authoritative result" }],
    });
  });

  it("periodically recovers and syncs queued writes without a foreground request, then stops cleanly", async () => {
    vi.useFakeTimers();
    let resilient: ResilientXMemoClient | undefined;
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      globalBreaker.recordSuccess();
      const cache = new XMemoLocalCache(cacheDir);
      fetchMock.mockImplementation(() => Promise.resolve(mockResponse({ id: "synced" })));

      resilient = buildClient(cacheDir);
      resilient.startOutboxSync({ intervalMs: 100, staleLockTimeoutMs: 5 * 60_000 });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).not.toHaveBeenCalled();

      // Leave a record processing while the worker is running, then advance
      // beyond the lock timeout to exercise recovery on a later timer pass.
      const staleId = cache.enqueueWrite("remember", "/v1/remember", "POST", { content: "stale" });
      cache.lockForProcessing(staleId);
      vi.setSystemTime(new Date("2026-01-01T00:06:00.000Z"));
      await vi.advanceTimersByTimeAsync(100);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(new XMemoLocalCache(cacheDir).getStats().sentWrites).toBe(1);

      cache.enqueueWrite("remember", "/v1/remember", "POST", { content: "periodic" });
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.waitFor(() => expect(new XMemoLocalCache(cacheDir).getStats().sentWrites).toBe(2), {
        interval: 1,
        timeout: 100,
      });

      resilient.stopOutboxSync();
      cache.enqueueWrite("remember", "/v1/remember", "POST", { content: "after disable" });
      await vi.advanceTimersByTimeAsync(500);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(new XMemoLocalCache(cacheDir).getStats().pendingWrites).toBe(1);
    } finally {
      resilient?.stopOutboxSync();
      vi.useRealTimers();
    }
  });

  it("returns a visible error instead of claiming success when the outbox is full", async () => {
    const records = Object.fromEntries(Array.from({ length: XMEMO_OUTBOX_MAX_RECORDS }, (_, index) => {
      const id = `record-${index}`;
      return [id, {
        id,
        operation: "remember",
        endpoint: "/v1/remember",
        method: "POST",
        payload: { index },
        idempotencyKey: `key-${index}`,
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        autoReplay: true,
      }];
    }));
    writeFileSync(join(cacheDir, "write-outbox.json"), JSON.stringify({ version: 1, records }), "utf8");
    const client = buildClient(cacheDir);
    vi.spyOn(client.rawClient, "isCircuitOpen").mockReturnValue(true);

    const result = await client.resilientWrite("remember", "/v1/remember", "POST", { content: "new" }, async () => ({}));

    expect(result).toMatchObject({ status: "error" });
    expect(result.status === "error" ? result.message : "").toContain("write queue is full");
    expect(new XMemoLocalCache(cacheDir).getStats().pendingWrites).toBe(XMEMO_OUTBOX_MAX_RECORDS);
  });

  it("exposes failed queue counts and the last durable error in status", () => {
    const cache = new XMemoLocalCache(cacheDir);
    const id = cache.enqueueWrite("remember", "/v1/remember", "POST", { content: "fails" });
    cache.lockForProcessing(id);
    cache.markFailed(id, "authorization rejected", false);

    const client = buildClient(cacheDir);
    const summary = client.getStatusSummary();
    expect(summary.cacheStats).toMatchObject({
      failedWrites: 1,
      lastOutboxError: "authorization rejected",
    });
    expect(client.getPromptStatusLine()).toContain("1 writes failed and need attention");
    expect(client.getPromptStatusLine()).toContain("last write error: authorization rejected");
  });

  it("falls back to recall cache only after cloud failure", async () => {
    const cache = new XMemoLocalCache(cacheDir);
    cache.putCachedRecall(
      "recall_context",
      "project plan",
      {
        query: "project plan",
        bucket: "%",
        scope: null,
        teamId: null,
        maxItems: 8,
        maxTokens: 1500,
      },
      { items: [{ id: "cached", content: "cached fallback result" }] },
    );
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    const result = await buildClient(cacheDir).recallContext("project plan", {});

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ fromCache: true, isFresh: true });
    expect(result.result).toEqual({
      items: [{ id: "cached", content: "cached fallback result" }],
    });
  });

  it("queries cloud even when search cache is fresh", async () => {
    const cache = new XMemoLocalCache(cacheDir);
    cache.putCachedRecall(
      "search",
      "visible",
      {
        query: "visible",
        bucket: "%",
        scope: null,
        teamId: null,
        maxItems: 10,
      },
      { results: [{ id: "cached", content: "cached partial result" }] },
    );
    fetchMock.mockResolvedValue(
      mockResponse({ results: [{ id: "remote", content: "remote authoritative result" }] }),
    );

    const result = await buildClient(cacheDir).searchMemory("visible", {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ fromCache: false, isFresh: true });
    expect(result.result).toEqual({
      results: [{ id: "remote", content: "remote authoritative result" }],
    });
  });

  it("refuses to fall back to recall cache on 401 Unauthorized", async () => {
    const cache = new XMemoLocalCache(cacheDir);
    cache.putCachedRecall(
      "recall_context",
      "secret data",
      {
        query: "secret data",
        bucket: "%",
        scope: null,
        teamId: null,
        maxItems: 8,
        maxTokens: 1500,
      },
      { items: [{ id: "cached", content: "cached secret data" }] },
    );
    fetchMock.mockResolvedValue(mockResponse({ error: "unauthorized" }, 401));

    await expect(
      buildClient(cacheDir).recallContext("secret data", {}),
    ).rejects.toThrow("failed (401)");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to fall back to recall cache on 403 Forbidden", async () => {
    const cache = new XMemoLocalCache(cacheDir);
    cache.putCachedRecall(
      "recall_context",
      "team secret",
      {
        query: "team secret",
        bucket: "%",
        scope: null,
        teamId: null,
        maxItems: 8,
        maxTokens: 1500,
      },
      { items: [{ id: "cached", content: "cached team secret" }] },
    );
    fetchMock.mockResolvedValue(mockResponse({ error: "forbidden" }, 403));

    await expect(
      buildClient(cacheDir).recallContext("team secret", {}),
    ).rejects.toThrow("failed (403)");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to fall back to search cache on 403 Forbidden or 401 Unauthorized", async () => {
    const cache = new XMemoLocalCache(cacheDir);
    cache.putCachedRecall(
      "search",
      "secret",
      {
        query: "secret",
        bucket: "%",
        scope: null,
        teamId: null,
        maxItems: 10,
      },
      { results: [{ id: "cached", content: "cached secret" }] },
    );
    fetchMock.mockResolvedValue(mockResponse({ error: "forbidden" }, 403));

    await expect(
      buildClient(cacheDir).searchMemory("secret", {}),
    ).rejects.toThrow("failed (403)");
  });

  it("refuses to fall back to cache on cancellation (AbortError)", async () => {
    const cache = new XMemoLocalCache(cacheDir);
    cache.putCachedRecall(
      "search",
      "query",
      {
        query: "query",
        bucket: "%",
        scope: null,
        teamId: null,
        maxItems: 10,
      },
      { results: [{ id: "cached", content: "cached" }] },
    );
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    fetchMock.mockRejectedValue(abortErr);

    await expect(
      buildClient(cacheDir).searchMemory("query", {}),
    ).rejects.toThrow("aborted");
  });

  it("refuses to fall back to cache on deterministic 404 miss", async () => {
    const cache = new XMemoLocalCache(cacheDir);
    cache.putCachedRecall(
      "search",
      "missing",
      {
        query: "missing",
        bucket: "%",
        scope: null,
        teamId: null,
        maxItems: 10,
      },
      { results: [{ id: "cached", content: "cached" }] },
    );
    fetchMock.mockResolvedValue(mockResponse({ error: "not found" }, 404));

    await expect(
      buildClient(cacheDir).searchMemory("missing", {}),
    ).rejects.toThrow("failed (404)");
  });

  it("falls back to search cache on transient 500 server error", async () => {
    const cache = new XMemoLocalCache(cacheDir);
    cache.putCachedRecall(
      "search",
      "resilient query",
      {
        query: "resilient query",
        bucket: "%",
        scope: null,
        teamId: null,
        maxItems: 10,
      },
      { results: [{ id: "cached", content: "cached resilient data" }] },
    );
    fetchMock.mockResolvedValue(mockResponse({ error: "internal error" }, 500));

    const result = await buildClient(cacheDir).searchMemory("resilient query", {});

    expect(result).toMatchObject({ fromCache: true, isFresh: true });
    expect(result.result).toEqual({
      results: [{ id: "cached", content: "cached resilient data" }],
    });
  });

  it("resilientWrite invalidates affected cache on successful write", async () => {
    const client = buildClient(cacheDir);
    const cache = (client as any).cache as XMemoLocalCache;
    cache.putCachedRecall(
      "search",
      "important",
      {
        query: "important",
        bucket: "openclaw",
        scope: "team",
        teamId: "team-1",
        maxItems: 10,
      },
      { results: [{ id: "stale" }] },
    );

    expect(
      cache.getCachedRecall("search", "important", {
        query: "important",
        bucket: "openclaw",
        scope: "team",
        teamId: "team-1",
        maxItems: 10,
      }),
    ).not.toBeNull();

    await client.resilientWrite(
      "remember",
      "/v1/remember",
      "POST",
      { bucket: "openclaw", scope: "team", team_id: "team-1", content: "new memory" },
      async () => ({ id: "new-mem" }),
    );

    expect(
      cache.getCachedRecall("search", "important", {
        query: "important",
        bucket: "openclaw",
        scope: "team",
        teamId: "team-1",
        maxItems: 10,
      }),
    ).toBeNull();
  });

  it("isolates cache entries by memory_type parameter", async () => {
    const cache = new XMemoLocalCache(cacheDir);
    cache.putCachedRecall(
      "search",
      "planning",
      {
        query: "planning",
        bucket: "%",
        scope: null,
        teamId: null,
        memory_type: "semantic",
        maxItems: 10,
      },
      { results: [{ id: "semantic-result", content: "Semantic plan" }] },
    );
    cache.putCachedRecall(
      "search",
      "planning",
      {
        query: "planning",
        bucket: "%",
        scope: null,
        teamId: null,
        memory_type: "episodic",
        maxItems: 10,
      },
      { results: [{ id: "episodic-result", content: "Episodic plan" }] },
    );

    fetchMock.mockRejectedValue(new TypeError("fetch failed: offline"));
    const client = buildClient(cacheDir);

    const semanticRes = await client.searchMemory("planning", { memory_type: "semantic" });
    expect(semanticRes.fromCache).toBe(true);
    expect((semanticRes.result as any).results[0].id).toBe("semantic-result");

    const episodicRes = await client.searchMemory("planning", { memory_type: "episodic" });
    expect(episodicRes.fromCache).toBe(true);
    expect((episodicRes.result as any).results[0].id).toBe("episodic-result");

    // Unfiltered search without memory_type has no cache entry and fails transiently
    await expect(client.searchMemory("planning", {})).rejects.toThrow("fetch failed: offline");
  });
});
