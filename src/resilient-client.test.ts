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
});
