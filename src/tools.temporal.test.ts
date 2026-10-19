import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalBreaker } from "./client.js";
import { registerXMemoTools, resetResilientClientForTesting } from "./tools.js";

const temporal = { since: "2026-10-01T00:00:00+09:00", until: "2026-10-02T00:00:00+09:00", owner_timezone: "Asia/Tokyo", reference_time: "2026-10-02T12:00:00+09:00", time_order: "asc" };
function apiTools() {
  const tools = new Map<string, any>();
  registerXMemoTools({ config: { plugins: { entries: { "xmemo-memory": { enabled: true, config: { apiKey: "synthetic", baseUrl: "https://audit.invalid" } } } } }, registerTool: (t: any) => tools.set(t.name, t), runtime: { config: { current: () => ({ plugins: {} }) } }, logger: { info() {}, warn() {} } } as any);
  return tools;
}
function response(items: any[] = [], status = 200) { return new Response(JSON.stringify({ items }), { status, headers: { "content-type": "application/json" } }); }
describe("memory_search temporal contract", () => {
  let dir: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "xmemo-temporal-"));
    vi.stubEnv("OPENCLAW_DATA_DIR", dir); vi.stubEnv("XMEMO_CONFIG_HOME", join(dir, "config"));
    resetResilientClientForTesting(); globalBreaker.recordSuccess();
    fetchMock = vi.fn().mockImplementation(async () => response()); vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { resetResilientClientForTesting(); globalBreaker.recordSuccess(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
  it("exposes five optional fields only on memory_search and sends them unchanged on L1, never L2", async () => {
    const tools = apiTools(), tool = tools.get("memory_search");
    for (const key of Object.keys(temporal)) {
      expect(tool.parameters.properties).toHaveProperty(key);
      expect(tool.parameters.required ?? []).not.toContain(key);
      expect(tools.get("xmemo_memory_list").parameters.properties).not.toHaveProperty(key);
    }
    await tool.execute("t", { query: "synthetic", ...temporal });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://audit.invalid/v1/recall/context");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ query: "synthetic", bucket: "%", scope: null, team_id: null, max_items: 8, max_tokens: 12000, prefer_working: true, ...temporal });
  });
  it.each([
    { since: "2026-10-01" }, { since: "2026-10-01T01:00:00" }, { since: "2026-02-30T00:00:00Z" }, { since: "2026-13-01T00:00:00Z" },
    { since: "2026-10-01T24:00:00Z" }, { since: "2026-10-01T00:60:00Z" }, { since: "2026-10-01T00:00:00+24:00" }, { since: "" }, { since: null },
    { reference_time: "invalid" }, { owner_timezone: "Mars/Olympus" }, { owner_timezone: "+09:00" }, { time_order: "newest" }, { time_order: null },
    { since: temporal.until, until: temporal.since }, { since: temporal.since, until: temporal.since },
  ])("rejects invalid fields before any network call: %j", async fields => {
    const result = await apiTools().get("memory_search").execute("t", { query: "synthetic", ...fields });
    expect(result.details.error).toBe("invalid_argument"); expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([400, 422, 401, 403, 408, 429])("does not use warm cache or L2 for HTTP %s", async status => {
    const tool = apiTools().get("memory_search");
    fetchMock.mockResolvedValueOnce(response([{ id: "secret-cache", content: "synthetic" }]));
    await tool.execute("warm", { query: "synthetic", ...temporal });
    fetchMock.mockClear(); globalBreaker.recordSuccess(); fetchMock.mockImplementation(async () => response([], status));
    const result = await tool.execute("fail", { query: "synthetic", ...temporal });
    expect(result.details.status).toBe(status);
    expect(JSON.stringify(result)).not.toContain("secret-cache");
    expect(fetchMock.mock.calls.every(c => String(c[0]).endsWith("/v1/recall/context"))).toBe(true);
    if (status === 400 || status === 422) expect(result.content[0].text).toMatch(/temporal.*(invalid|support)/i);
  });
  it("preserves server time order and metadata despite unequal scores, ties and duplicate paths", async () => {
    fetchMock.mockResolvedValue(response([
      { id: "early", path: "same", score: .1, content: "first", created_at: temporal.since, updated_at: temporal.since },
      { id: "later", path: "same", score: .9, content: "second", created_at: "2026-10-01T01:00:00+09:00" },
      { id: "early", path: "same", score: 1, content: "duplicate" },
      { id: "last", path: "same", score: .9, content: "third" },
    ]));
    const result = await apiTools().get("memory_search").execute("t", { query: "synthetic", ...temporal });
    expect(result.details.ids).toEqual(["early", "later", "last"]);
    expect(result.details.results[0]).toMatchObject({ created_at: temporal.since, updated_at: temporal.since });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["2026-10-01T00:00:00+09:00", "2026-10-02T00:00:00+09:00", "Asia/Tokyo"],
    ["2026-03-08T00:00:00-05:00", "2026-03-09T00:00:00-04:00", "America/New_York"],
    ["2026-11-01T00:00:00-04:00", "2026-11-02T00:00:00-05:00", "America/New_York"],
  ])("keeps half-open bounds for UTC+9/DST: %s", async (since, until, owner_timezone) => {
    // Synthetic server fixture applies [since, until); this verifies transport, not production behavior.
    fetchMock.mockImplementation(async (_url, init) => { const body = JSON.parse(init.body); const start = Date.parse(body.since), end = Date.parse(body.until); return response([start - 1, start, end - 1, end].filter(t => t >= start && t < end).map(t => ({ id: String(t), content: "synthetic", created_at: new Date(t).toISOString() }))); });
    const result = await apiTools().get("memory_search").execute("t", { query: "synthetic", since, until, owner_timezone, time_order: "asc" });
    expect(result.details.ids).toEqual([String(Date.parse(since)), String(Date.parse(until) - 1)]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ since, until, owner_timezone });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("rejects advanced fields explicitly instead of silently issuing an unconstrained query", async () => {
    const result = await apiTools().get("memory_search").execute("t", { query: "synthetic", query_mode: "activity_log" });
    expect(result.details.error).toBe("unsupported_parameter"); expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(Object.entries(temporal))("activates the L1-only path for %s alone", async (key, value) => {
    await apiTools().get("memory_search").execute("t", { query: "synthetic", [key]: value });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[key]).toBe(value);
    for (const other of Object.keys(temporal).filter(k => k !== key)) expect(body).not.toHaveProperty(other);
  });
  it("preserves descending server order with score ties and deduplicates by id only", async () => {
    fetchMock.mockImplementation(async () => response([
      { id: "new", content: "new", score: 0.1, path: "same" },
      { id: "middle", content: "middle", score: 0.9, path: "same" },
      { id: "new", content: "duplicate", score: 1 },
      { id: "old", content: "old", score: 0.9, path: "same" },
    ]));
    const result = await apiTools().get("memory_search").execute("t", { query: "synthetic", time_order: "desc" });
    expect(result.details.ids).toEqual(["new", "middle", "old"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("does not collapse a valid sub-millisecond window", async () => {
    const result = await apiTools().get("memory_search").execute("t", { query: "synthetic", since: "2026-10-01T00:00:00.0001Z", until: "2026-10-01T00:00:00.0002Z" });
    expect(result.details.error).toBeUndefined(); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("compares equivalent instants across offsets before network", async () => {
    const result = await apiTools().get("memory_search").execute("t", { query: "synthetic", since: "2026-10-01T09:00:00+09:00", until: "2026-10-01T00:00:00Z" });
    expect(result.details.error).toBe("invalid_argument"); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("never falls through to L2 after a network error, with or without a matching cache entry", async () => {
    const tool = apiTools().get("memory_search");
    fetchMock.mockImplementation(async () => response([{ id: "cached", content: "synthetic" }]));
    await tool.execute("warm", { query: "synthetic", ...temporal });
    fetchMock.mockClear(); fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const same = await tool.execute("same", { query: "synthetic", ...temporal });
    expect(same.details.fromCache).toBe(true); expect(same.details.ids).toEqual(["cached"]);
    const different = await tool.execute("different", { query: "synthetic", ...temporal, owner_timezone: "UTC" });
    expect(different.details.ids).toBeUndefined();
    expect(fetchMock.mock.calls.every(c => String(c[0]).endsWith("/v1/recall/context"))).toBe(true);
  });
  it("does not return cached results or call L2 when cancelled", async () => {
    const tool = apiTools().get("memory_search");
    fetchMock.mockImplementation(async () => response([{ id: "cached", content: "synthetic" }]));
    await tool.execute("warm", { query: "synthetic", ...temporal });
    fetchMock.mockClear(); fetchMock.mockRejectedValue(new DOMException("Aborted", "AbortError"));
    const controller = new AbortController(); controller.abort();
    const result = await tool.execute("cancel", { query: "synthetic", ...temporal }, controller.signal);
    expect(result.details.ids).toBeUndefined(); expect(result.details.fromCache).not.toBe(true);
    expect(fetchMock.mock.calls.every(c => String(c[0]).endsWith("/v1/recall/context"))).toBe(true);
  });
});
