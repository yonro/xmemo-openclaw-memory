import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { XMemoClient, XMemoClientError, type XMemoTemporalFields } from "./client.js";
import { resolveXMemoMemoryConfig } from "./config.js";
import { XMemoLocalCache } from "./local-cache.js";
import { ResilientXMemoClient } from "./resilient-client.js";

const fields: XMemoTemporalFields = { since: "2026-10-01T00:00:00+09:00", until: "2026-10-02T00:00:00+09:00", owner_timezone: "Asia/Tokyo", reference_time: "2026-10-02T12:00:00+09:00", time_order: "asc" };
const cached = { items: [{ id: "cached", content: "synthetic" }] };
function config(overrides = {}) {
  return resolveXMemoMemoryConfig({ plugins: { entries: { "xmemo-memory": { config: { apiKey: "synthetic-a", baseUrl: "https://audit.invalid", ...overrides } } } } } as any);
}
function client(overrides: Record<string, unknown> = {}, cache?: XMemoLocalCache) {
  const cfg = config(overrides);
  if (typeof overrides.agentInstanceId === "string") cfg.agentInstanceId = overrides.agentInstanceId;
  const raw = new XMemoClient(cfg.baseUrl, cfg.apiKey!, cfg.agentId, cfg.agentInstanceId, cfg.authMode);
  const recall = vi.spyOn(raw, "recallContext").mockResolvedValue(cached);
  return { recall, resilient: new ResilientXMemoClient(raw, cfg, cache) };
}
describe("temporal recall persistent cache boundaries", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "xmemo-temporal-cache-"));
    vi.stubEnv("OPENCLAW_DATA_DIR", dir); vi.stubEnv("XMEMO_CONFIG_HOME", join(dir, "config"));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
  it("keeps the legacy request body and persisted cache key unchanged", async () => {
    const cfg = config(), cache = new XMemoLocalCache(join(dir, "legacy"));
    const key = { query: "q", bucket: cfg.readBucket, scope: cfg.readScope ?? null, teamId: cfg.teamId ?? null, maxItems: cfg.recallMaxItems, maxTokens: cfg.recallMaxTokens };
    cache.putCachedRecall("recall_context", "q", key, cached);
    const { recall, resilient } = client({}, cache);
    recall.mockRejectedValue(new TypeError("fetch failed"));
    expect(await resilient.recallContext("q", {})).toMatchObject({ result: cached, fromCache: true });
    expect(JSON.stringify(recall.mock.calls[0][0])).toBe(JSON.stringify({ query: "q", bucket: cfg.readBucket, scope: cfg.readScope ?? null, team_id: cfg.teamId ?? null, max_items: cfg.recallMaxItems, max_tokens: cfg.recallMaxTokens, prefer_working: true }));
  });
  it.each([new XMemoClientError("server failure", 503), new TypeError("fetch failed")])("reads the exact same temporal key after a transient failure: %s", async error => {
    const first = client(); await first.resilient.recallContext("q", fields);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60 * 1000);
    const restarted = client(); restarted.recall.mockRejectedValue(error);
    expect(await restarted.resilient.recallContext("q", fields)).toMatchObject({ result: cached, fromCache: true, isFresh: false });
    expect(restarted.recall.mock.calls[0][0]).toMatchObject(fields);
  });
  it.each([400, 401, 403, 404, 408, 422, 429])("never serves a temporal cache entry for HTTP %s", async status => {
    const { recall, resilient } = client(); await resilient.recallContext("q", fields);
    const error = new XMemoClientError("rejected", status); recall.mockRejectedValue(error);
    await expect(resilient.recallContext("q", fields)).rejects.toBe(error);
  });
  it.each(["AbortError", "network error after abort"])("never serves cache after cancellation: %s", async name => {
    const { recall, resilient } = client(); await resilient.recallContext("q", fields);
    const controller = new AbortController(); controller.abort();
    const error = new Error(name); error.name = name; recall.mockRejectedValue(error);
    await expect(resilient.recallContext("q", fields, controller.signal)).rejects.toBe(error);
  });
  it.each([
    { since: "2026-10-01T01:00:00+09:00" }, { until: "2026-10-03T00:00:00+09:00" },
    { owner_timezone: "America/New_York" }, { reference_time: "2026-10-03T12:00:00+09:00" }, { time_order: "desc" as const },
    { bucket: "other" }, { scope: "private" }, { teamId: "other-team" }, { preferWorking: false },
  ])("isolates query-identical requests with different parameters: %j", async change => {
    const { recall, resilient } = client(); await resilient.recallContext("q", fields);
    const error = new TypeError("fetch failed"); recall.mockRejectedValue(error);
    await expect(resilient.recallContext("q", { ...fields, ...change })).rejects.toBe(error);
    await expect(resilient.recallContext("q", {})).rejects.toBe(error);
  });
  it.each([{ apiKey: "synthetic-b" }, { baseUrl: "https://second.invalid" }, { agentId: "other" }, { agentInstanceId: "other-instance" }])("isolates identities and base URLs across restarts: %j", async overrides => {
    const first = client(); await first.resilient.recallContext("q", fields);
    const second = client(overrides), error = new TypeError("fetch failed"); second.recall.mockRejectedValue(error);
    await expect(second.resilient.recallContext("q", fields)).rejects.toBe(error);
  });
  it("never borrows the legacy recall or keyword-search cache", async () => {
    const cache = new XMemoLocalCache(join(dir, "shared"));
    const { recall, resilient } = client({}, cache);
    await resilient.recallContext("q", {});
    cache.putCachedRecall("search", "q", fields, cached);
    const error = new TypeError("fetch failed"); recall.mockRejectedValue(error);
    await expect(resilient.recallContext("q", fields)).rejects.toBe(error);
  });
});
