import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { XMemoClient } from "./client.js";
import type { XMemoMemoryConfig } from "./config.js";
import { XMemoLocalCache } from "./local-cache.js";
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
});
