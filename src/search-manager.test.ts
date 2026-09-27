import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { globalBreaker, XMemoClient } from "./client.js";
import { XMemoSearchManager } from "./search-manager.js";

function mockResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(status === 204 ? undefined : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function requestUrl(callIndex: number, calls: unknown[][]): string {
  return String(calls[callIndex]?.[0]);
}

function requestInit(callIndex: number, calls: unknown[][]): RequestInit {
  return (calls[callIndex]?.[1] ?? {}) as RequestInit;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  globalBreaker.recordSuccess();
  fetchMock = vi.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalBreaker.recordSuccess();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createConfig(
  overrides: Partial<{
    apiKey: string;
    bucket: string;
    scope: string | undefined;
    readBucket: string;
    readScope: string | undefined;
    teamId: string | undefined;
    recallMaxItems: number;
    recallMaxTokens: number;
    recallMaxChars: number;
  }> = {},
) {
  return {
    baseUrl: "https://xmemo.dev",
    apiKey: overrides.apiKey ?? "key",
    bucket: overrides.bucket ?? "openclaw",
    scope: overrides.scope,
    readBucket: overrides.readBucket ?? "%",
    readScope: overrides.readScope,
    teamId: overrides.teamId,
    agentId: "openclaw",
    agentInstanceId: "instance",
    authMode: "api-key" as const,
    autoCapture: false,
    captureMaxChars: 500,
    customTriggers: undefined,
    recallMaxChars: overrides.recallMaxChars ?? 1000,
    recallMaxItems: overrides.recallMaxItems ?? 8,
    recallMaxTokens: overrides.recallMaxTokens ?? 1500,
  };
}

describe("XMemoSearchManager", () => {
  it("filters deleted and below-threshold results without inventing missing similarity scores", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        items: [
          { id: "deleted", content: "stale", path: "openclaw", status: "deleted", score: 0.99 },
          { id: "below", content: "low score", path: "openclaw", score: 0.1 },
          { id: "above", content: "high score", path: "openclaw", score: 0.95 },
          { id: "unknown", content: "no score", path: "openclaw" },
        ],
      }),
    );
    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    const manager = new XMemoSearchManager(client, createConfig());

    const thresholdResults = await manager.search("hello", { minScore: 0.9 });
    expect(thresholdResults.map((result) => result.path)).toEqual(["openclaw/above"]);
    expect(thresholdResults[0]).toMatchObject({ score: 0.95, scoreKnown: true });
    expect(JSON.parse(String(requestInit(0, fetchMock.mock.calls).body))).toMatchObject({ threshold: 0.9 });

    fetchMock.mockResolvedValueOnce(mockResponse({ items: [{ id: "unknown", content: "no score", path: "openclaw" }] }));
    const unknownScore = await manager.search("unknown score");
    expect(unknownScore[0]).toMatchObject({ score: 0, scoreKnown: false });
  });

  it("declares memory-only source support and does not search when sessions are the only requested source", async () => {
    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    const manager = new XMemoSearchManager(client, createConfig());

    await expect(manager.search("hello", { sessionKey: "session-1", sources: ["sessions"] })).resolves.toEqual([]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect((manager.status().custom as Record<string, unknown>).searchCapabilities).toMatchObject({
      supportedSources: ["memory"],
      sessionKeyFilter: "unsupported",
    });
  });

  it.each([401, 403])("classifies %i authorization failures consistently and preserves the HTTP status", async (status) => {
    fetchMock.mockResolvedValue(mockResponse({ error: "authorization rejected" }, status));
    const manager = new XMemoSearchManager(
      new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance"),
      createConfig(),
    );

    await expect(manager.search("hello")).rejects.toMatchObject({ status });
    expect((manager.status().custom as Record<string, unknown>).lastError).toContain(`auth (${status})`);
  });

  it("classifies timeout and cancellation on the host search path", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => Promise.resolve(mockResponse({ error: "timed out" }, 504)));
    const manager = new XMemoSearchManager(
      new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance"),
      createConfig(),
    );
    const timedOut = expect(manager.search("slow request")).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(5_000);
    await timedOut;
    expect((manager.status().custom as Record<string, unknown>).lastError).toContain("timeout (504)");

    const abort = new Error("request aborted");
    abort.name = "AbortError";
    fetchMock.mockRejectedValueOnce(abort);
    await expect(manager.search("cancelled request")).rejects.toBe(abort);
    expect((manager.status().custom as Record<string, unknown>).lastError).toContain("cancelled:");
  });

  it("returns empty results when client is not configured", async () => {
    const client = new XMemoClient("https://xmemo.dev", "", "openclaw", "instance");
    const manager = new XMemoSearchManager(client, createConfig());
    const results = await manager.search("hello");
    expect(results).toEqual([]);
  });

  it("maps recall_context items to MemorySearchResult", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        items: [
          { id: "mem-1", content: "first memory", path: "openclaw", score: 0.95 },
          { id: "mem-2", content: "second memory", bucket: "chatgpt", score: 0.88 },
        ],
      }),
    );
    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    const manager = new XMemoSearchManager(client, createConfig());
    const results = await manager.search("hello");

    expect(results).toHaveLength(2);
    const [first, second] = results;
    expect(first?.path).toBe("openclaw/mem-1");
    expect(first?.snippet).toBe("first memory");
    expect(second?.path).toBe("chatgpt/mem-2");
    expect(JSON.parse(String(requestInit(0, fetchMock.mock.calls).body))).toMatchObject({
      bucket: "%",
      scope: null,
    });
  });

  it("uses configured read filters separately from write bucket and scope", async () => {
    fetchMock.mockResolvedValue(mockResponse({ items: [] }));
    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    const manager = new XMemoSearchManager(
      client,
      createConfig({
        bucket: "openclaw",
        scope: "write-scope",
        readBucket: "work",
        readScope: "shared-project",
      }),
    );

    await manager.search("hello");

    expect(JSON.parse(String(requestInit(0, fetchMock.mock.calls).body))).toMatchObject({
      bucket: "work",
      scope: "shared-project",
    });
  });

  it("reads a memory by id path", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        id: "mem-1",
        content: "line one\nline two\nline three",
        path: "openclaw",
      }),
    );
    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    const manager = new XMemoSearchManager(client, createConfig());
    const result = await manager.readFile({ relPath: "openclaw/mem-1", from: 2, lines: 1 });

    expect(result.text).toBe("line two");
    expect(result.from).toBe(2);
    expect(result.lines).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it("reads a memory by non-UUID id path", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        id: "custom-id-123",
        content: "custom memory",
        path: "openclaw",
      }),
    );
    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    const manager = new XMemoSearchManager(client, createConfig());
    const result = await manager.readFile({ relPath: "openclaw/custom-id-123" });

    expect(result.text).toBe("custom memory");
  });

  it("reports not connected before any probe", () => {
    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    const manager = new XMemoSearchManager(client, createConfig());
    const status = manager.status();
    expect((status.custom as Record<string, unknown>).connected).toBe(false);
  });

  it("probes connectivity with token validation", async () => {
    fetchMock.mockResolvedValue(mockResponse({ status: "valid" }));
    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    const manager = new XMemoSearchManager(client, createConfig());

    const ok = await manager.probeConnectivity();
    expect(ok).toBe(true);
    expect(requestUrl(0, fetchMock.mock.calls)).toBe("https://xmemo.dev/v1/auth/token/validate");
    expect(requestInit(0, fetchMock.mock.calls).method).toBe("GET");
    expect((manager.status().custom as Record<string, unknown>).connected).toBe(true);
  });

  it("reports probe failure without leaking the api key", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "bad key: super-secret-key" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new XMemoClient("https://xmemo.dev", "super-secret-key", "openclaw", "instance");
    const manager = new XMemoSearchManager(client, createConfig());

    const ok = await manager.probeConnectivity();
    expect(ok).toBe(false);
    const lastError = (manager.status().custom as Record<string, unknown>).lastError as string;
    expect(lastError).not.toContain("super-secret-key");
  });

  it("returns status with builtin backend and xmemo provider identity", () => {
    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    const manager = new XMemoSearchManager(client, createConfig());
    const status = manager.status();

    // OpenClaw core only accepts "builtin" and "qmd" backend identifiers.
    // XMemo-specific identity is carried in the provider and custom fields.
    expect(status.backend).toBe("builtin");
    expect(status.provider).toBe("xmemo-memory");
    expect((status.custom as Record<string, unknown>).configured).toBe(true);
  });

  it("rejects path traversal in readFile", async () => {
    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    const manager = new XMemoSearchManager(client, createConfig());
    await expect(manager.readFile({ relPath: "../etc/passwd" })).rejects.toThrow("Path traversal not allowed");
  });

  it("throws not found when search results do not match path exactly", async () => {
    // When search returns unrelated results, readFile must not fall back to results[0] or join
    fetchMock.mockResolvedValue(
      mockResponse({
        results: [
          { id: "unrelated-1", content: "unrelated memory content", path: "other/path" },
        ],
      }),
    );
    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    const manager = new XMemoSearchManager(client, createConfig());
    await expect(manager.readFile({ relPath: "foobar.md" })).rejects.toThrow("Memory not found for path: foobar.md");
  });

  it("marks truncated as false when reading to end of file", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        id: "mem-3",
        content: "line1\nline2\nline3",
        path: "openclaw",
      }),
    );
    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    const manager = new XMemoSearchManager(client, createConfig());
    // from=2, lines=2 reads lines 2 and 3 of 3-line doc -> reaches EOF -> truncated should be false
    const result = await manager.readFile({ relPath: "openclaw/mem-3", from: 2, lines: 2 });
    expect(result.text).toBe("line2\nline3");
    expect(result.from).toBe(2);
    expect(result.lines).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("throws range_error with code property when from exceeds total lines", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        mockResponse({
          id: "mem-short",
          content: "line1\nline2",
          path: "openclaw",
        }),
      ),
    );
    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    const manager = new XMemoSearchManager(client, createConfig());
    await expect(manager.readFile({ relPath: "openclaw/mem-short", from: 10 })).rejects.toThrow(
      "Requested line 10 is out of bounds",
    );
    let caught: any;
    try {
      await manager.readFile({ relPath: "openclaw/mem-short", from: 10 });
    } catch (err: any) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.message).toContain("Requested line 10 is out of bounds");
    expect(caught.code).toBe("range_error");
  });
});
