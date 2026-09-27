import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { globalBreaker, XMemoClient } from "./client.js";

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

describe("XMemoClient", () => {
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

  it("counts one terminal HTTP failure once per logical request", async () => {
    fetchMock.mockResolvedValue(mockResponse({}, 503));
    const client = new XMemoClient("https://breaker-count.invalid", "fake-key", "openclaw", "instance");

    await expect(client.replayWrite("/v1/remember", "POST", {}, "fake-idempotency")).rejects.toThrow("failed (503)");

    expect(globalBreaker.consecutiveFailures).toBe(1);
  });

  it("isolates breakers by authorization context and admits one half-open probe", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    fetchMock
      .mockResolvedValueOnce(mockResponse({}, 503))
      .mockResolvedValueOnce(mockResponse({}, 503))
      .mockResolvedValueOnce(mockResponse({}, 503))
      .mockResolvedValueOnce(mockResponse({}, 503))
      .mockResolvedValueOnce(mockResponse({}, 503))
      .mockResolvedValueOnce(mockResponse({ id: "other-auth" }))
      .mockResolvedValueOnce(mockResponse({ id: "other-service" }));

    const client = new XMemoClient("https://breaker-scope.invalid", "fake-key-a", "openclaw", "instance");
    for (let index = 0; index < 5; index++) {
      await expect(client.remember({ content: `failure ${index}` })).rejects.toThrow("failed (503)");
    }
    expect(client.circuitBreakerState).toBe("open");

    const otherAuthorization = new XMemoClient("https://breaker-scope.invalid", "fake-key-b", "openclaw", "instance");
    await expect(otherAuthorization.remember({ content: "other auth context" })).resolves.toMatchObject({ id: "other-auth" });
    expect(otherAuthorization.circuitBreakerState).toBe("closed");
    const otherService = new XMemoClient("https://another-service.invalid", "fake-key-a", "openclaw", "instance");
    await expect(otherService.remember({ content: "other service" })).resolves.toMatchObject({ id: "other-service" });
    expect(otherService.circuitBreakerState).toBe("closed");

    await vi.advanceTimersByTimeAsync(120_000);
    let releaseProbe!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseProbe = resolve; }));
    const probe = client.remember({ content: "half-open probe" });
    expect(client.circuitBreakerState).toBe("half-open");
    expect(fetchMock).toHaveBeenCalledTimes(8);

    const duplicateClient = new XMemoClient("https://breaker-scope.invalid", "fake-key-a", "another-agent", "other-instance");
    await expect(duplicateClient.remember({ content: "second probe" })).rejects.toThrow("circuit breaker is open");
    expect(fetchMock).toHaveBeenCalledTimes(8);

    releaseProbe(mockResponse({ id: "probe-ok" }));
    await expect(probe).resolves.toMatchObject({ id: "probe-ok" });
    expect(client.circuitBreakerState).toBe("closed");
  });

  it("uses jittered retry delays and honors Retry-After on transient reads", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const client = new XMemoClient("https://retry-jitter.invalid", "fake-key", "openclaw", "instance");
    fetchMock.mockResolvedValueOnce(mockResponse({}, 503)).mockResolvedValueOnce(mockResponse({ items: [] }));

    const jitteredRetry = client.recallContext({ query: "jitter" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(jitteredRetry).resolves.toMatchObject({ items: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(mockResponse({}, 429, { "retry-after": "2" }))
      .mockResolvedValueOnce(mockResponse({ items: [] }));
    const retryAfter = client.recallContext({ query: "retry-after" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(retryAfter).resolves.toMatchObject({ items: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends X-API-Key by default", async () => {
    fetchMock.mockResolvedValue(mockResponse({ results: [] }));
    const client = new XMemoClient(
      "https://xmemo.dev",
      "secret-key",
      "openclaw",
      "instance",
      "api-key",
    );
    await client.searchMemory({ query: "hello", bucket: "openclaw" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = requestInit(0, fetchMock.mock.calls);
    const headers = new Headers(init.headers);
    expect(headers.get("X-API-Key")).toBe("secret-key");
    expect(headers.get("Authorization")).toBeNull();
  });

  it("sends Bearer token when authMode is bearer", async () => {
    fetchMock.mockResolvedValue(mockResponse({ results: [] }));
    const client = new XMemoClient(
      "https://xmemo.dev",
      "secret-key",
      "openclaw",
      "instance",
      "bearer",
    );
    await client.searchMemory({ query: "hello", bucket: "openclaw" });

    const init = requestInit(0, fetchMock.mock.calls);
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer secret-key");
    expect(headers.get("X-API-Key")).toBeNull();
  });

  it("sends both headers when authMode is both", async () => {
    fetchMock.mockResolvedValue(mockResponse({ results: [] }));
    const client = new XMemoClient(
      "https://xmemo.dev",
      "secret-key",
      "openclaw",
      "instance",
      "both",
    );
    await client.searchMemory({ query: "hello", bucket: "openclaw" });

    const init = requestInit(0, fetchMock.mock.calls);
    const headers = new Headers(init.headers);
    expect(headers.get("X-API-Key")).toBe("secret-key");
    expect(headers.get("Authorization")).toBe("Bearer secret-key");
  });

  it("uses GET for searchMemory with query params", async () => {
    fetchMock.mockResolvedValue(mockResponse({ results: [] }));
    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    await client.searchMemory({ query: "hello", bucket: "openclaw", scope: "team", max_items: 5 });

    expect(requestUrl(0, fetchMock.mock.calls)).toBe(
      "https://xmemo.dev/v1/memories/search?query=hello&bucket=openclaw&scope=team&limit=5",
    );
    expect(requestInit(0, fetchMock.mock.calls).method).toBe("GET");
  });

  it("includes memory_type in searchMemory query params when provided", async () => {
    fetchMock.mockResolvedValue(mockResponse({ results: [] }));
    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    await client.searchMemory({ query: "hello", bucket: "openclaw", memory_type: "episodic" });

    expect(requestUrl(0, fetchMock.mock.calls)).toBe(
      "https://xmemo.dev/v1/memories/search?query=hello&bucket=openclaw&memory_type=episodic",
    );
  });

  it("redacts the api key when it appears in the response body", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid key: super-secret-key" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new XMemoClient("https://xmemo.dev", "super-secret-key", "openclaw", "instance");
    await expect(client.remember({ content: "hello", bucket: "openclaw" })).rejects.toThrow(
      "invalid key: ***",
    );
    await expect(client.remember({ content: "hello", bucket: "openclaw" })).rejects.not.toThrow(
      "super-secret-key",
    );
  });

  it("falls back to search when getMemory direct endpoint returns 404", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(
        mockResponse({
          results: [{ id: "mem-1", content: "found via search", bucket: "openclaw" }],
        }),
      );

    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    const memory = await client.getMemory("mem-1");
    expect(memory.id).toBe("mem-1");
    expect(memory.content).toBe("found via search");
  });

  it("falls back to search when getMemory direct endpoint returns 405", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("method not allowed", { status: 405 }))
      .mockResolvedValueOnce(
        mockResponse({
          results: [{ id: "mem-2", content: "found via search after 405", bucket: "openclaw" }],
        }),
      );

    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    const memory = await client.getMemory("mem-2");
    expect(memory.id).toBe("mem-2");
    expect(memory.content).toBe("found via search after 405");
  });

  it("throws the original error when getMemory fallback search finds no match", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(mockResponse({ results: [] }));

    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    await expect(client.getMemory("missing-id")).rejects.toThrow("failed (404)");
  });

  it("does not fallback to search on 401 auth errors", async () => {
    fetchMock.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));

    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    await expect(client.getMemory("mem-1")).rejects.toThrow("failed (401)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not fallback to search on 403 forbidden errors", async () => {
    fetchMock.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));

    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    await expect(client.getMemory("mem-1")).rejects.toThrow("failed (403)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not fallback to search on AbortError", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    fetchMock.mockRejectedValueOnce(abort);

    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    await expect(client.getMemory("mem-1")).rejects.toThrow("aborted");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("remembers content via POST /v1/remember", async () => {
    fetchMock.mockResolvedValue(mockResponse({ id: "mem-1" }));
    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    const result = await client.remember({ content: "hello", bucket: "openclaw" });

    expect(result.id).toBe("mem-1");
    expect(requestUrl(0, fetchMock.mock.calls)).toBe("https://xmemo.dev/v1/remember");
    expect(requestInit(0, fetchMock.mock.calls).method).toBe("POST");
  });

  it("validates tokens via GET /v1/auth/token/validate", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ status: "valid", scopes: ["memory:read"], setup_state: "setup_completed" }),
    );
    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    const result = await client.validateToken();

    expect(result.status).toBe("valid");
    expect(requestUrl(0, fetchMock.mock.calls)).toBe("https://xmemo.dev/v1/auth/token/validate");
    expect(requestInit(0, fetchMock.mock.calls).method).toBe("GET");
  });

  it("lists reminders using item_status and unwraps { reminders }", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        reminders: [
          { id: "r-1", content: "buy milk", status: "open", due_at: "2026-06-20T00:00:00Z" },
        ],
      }),
    );
    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    const result = await client.listReminders({ bucket: "openclaw", item_status: "open" });

    expect(result.reminders).toHaveLength(1);
    expect(result.reminders[0]).toMatchObject({ id: "r-1", content: "buy milk" });
    expect(requestUrl(0, fetchMock.mock.calls)).toBe(
      "https://xmemo.dev/v1/reminders?bucket=openclaw&item_status=open",
    );
    expect(requestInit(0, fetchMock.mock.calls).method).toBe("GET");
  });

  it("restores restart snapshots with bucket and scope in the request body", async () => {
    fetchMock.mockResolvedValue(mockResponse({ restored: true, snapshot_id: "snap-1" }));
    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    await client.restoreRestartSnapshot({
      snapshot_id: "snap-1",
      bucket: "openclaw",
      scope: "team",
      team_id: "team-1",
    });

    expect(requestUrl(0, fetchMock.mock.calls)).toBe("https://xmemo.dev/v1/restart/restore");
    expect(requestInit(0, fetchMock.mock.calls).method).toBe("POST");
    expect(JSON.parse(String(requestInit(0, fetchMock.mock.calls).body))).toEqual({
      snapshot_id: "snap-1",
      bucket: "openclaw",
      scope: "team",
      team_id: "team-1",
    });
  });

  it("fetches audit consolidation with action_type filter", async () => {
    fetchMock.mockResolvedValue(mockResponse({ summary: {} }));
    const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
    await client.getAuditConsolidation({ action_type: "summarize", limit: 10 });

    expect(requestUrl(0, fetchMock.mock.calls)).toBe(
      "https://xmemo.dev/v1/audit/consolidation?action_type=summarize&limit=10",
    );
    expect(requestInit(0, fetchMock.mock.calls).method).toBe("GET");
  });

  describe("getLedgerMonthlySummary (skill operations migration)", () => {
    it("posts to /v1/skill/operations with default months: 6 and unwraps wrapped result", async () => {
      fetchMock.mockResolvedValue(
        mockResponse({
          ok: true,
          operation: "ledger-summary",
          result: {
            summary: [
              { month: "2026-09", total: 150.5, count: 3, currency: "CNY" },
              { month: "2026-08", total: 200, count: 4, currency: "CNY" },
            ],
          },
        }),
      );
      const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
      const summary = await client.getLedgerMonthlySummary();

      expect(requestUrl(0, fetchMock.mock.calls)).toBe("https://xmemo.dev/v1/skill/operations");
      const init = requestInit(0, fetchMock.mock.calls);
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({
        operation: "ledger-summary",
        arguments: {
          months: 6,
        },
      });

      expect(summary.summary).toHaveLength(2);
      expect(summary.summary?.[0]?.month).toBe("2026-09");
      expect(summary.summary?.[0]?.total).toBe(150.5);
    });

    it("strictly allow-lists outbound parameters and sanitizes casing and range", async () => {
      fetchMock.mockResolvedValue(
        mockResponse({
          ok: true,
          operation: "ledger-summary",
          result: {
            summary: [],
          },
        }),
      );
      const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
      await client.getLedgerMonthlySummary({
        months: 99, // Should clamp to 24
        currency: " cny ", // Should trim and uppercase
        transaction_type: " Expense ", // Should trim and lowercase
        ...({ unexpected_field: "should_not_pass", owner_id: "leak" } as any),
      });

      const init = requestInit(0, fetchMock.mock.calls);
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({
        operation: "ledger-summary",
        arguments: {
          months: 24,
          currency: "CNY",
          transaction_type: "expense",
        },
      });
      expect(body.arguments.unexpected_field).toBeUndefined();
      expect(body.arguments.owner_id).toBeUndefined();
    });

    it("unwraps raw unwrapped payload directly", async () => {
      fetchMock.mockResolvedValue(
        mockResponse({
          total: 500,
          count: 10,
          currency: "USD",
          month: 9,
          year: 2026,
        }),
      );
      const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
      const summary = await client.getLedgerMonthlySummary({ months: 3 });

      expect(summary.total).toBe(500);
      expect(summary.count).toBe(10);
      expect(summary.currency).toBe("USD");
    });

    it("maps legacy month and year to rolling months window", async () => {
      fetchMock.mockResolvedValue(
        mockResponse({
          ok: true,
          operation: "ledger-summary",
          result: { summary: [] },
        }),
      );
      const client = new XMemoClient("https://xmemo.dev", "key", "openclaw", "instance");
      await client.getLedgerMonthlySummary({
        month: 8,
        year: 2026,
      });

      const init = requestInit(0, fetchMock.mock.calls);
      const body = JSON.parse(String(init.body));
      expect(typeof body.arguments.months).toBe("number");
      expect(body.arguments.months).toBeGreaterThanOrEqual(1);
      expect(body.arguments.months).toBeLessThanOrEqual(24);
    });
  });
});
