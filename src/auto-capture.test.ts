import type { OpenClawPluginApi } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { registerXMemoAutoCapture } from "./auto-capture.js";

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestInit(callIndex: number, calls: unknown[][]): RequestInit {
  return (calls[callIndex]?.[1] ?? {}) as RequestInit;
}

function idempotencyKey(callIndex: number, calls: unknown[][]): string | undefined {
  const headers = requestInit(callIndex, calls).headers as Record<string, string>;
  return headers["Idempotency-Key"];
}

describe("xmemo auto-capture", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void>>;
  let logs: Array<{ level: string; message: string }>;
  let sessionId: string;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    handlers = {};
    logs = [];
    sessionId = randomUUID();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.XMEMO_KEY;
  });

  function mockApi(pluginConfig: Record<string, unknown> = {}): OpenClawPluginApi {
    return {
      config: {
        plugins: {
          entries: {
            "xmemo-memory": {
              config: pluginConfig,
            },
          },
        },
      },
      pluginConfig,
      on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
        handlers[event] = handler;
      },
      logger: {
        info: (message: string) => logs.push({ level: "info", message }),
        warn: (message: string) => logs.push({ level: "warn", message }),
      },
    } as unknown as OpenClawPluginApi;
  }

  async function capture(
    messages: Array<{ role: string; content: string }>,
    pluginConfig: Record<string, unknown> = {},
    session = sessionId,
  ) {
    registerXMemoAutoCapture(mockApi({ apiKey: "key", autoCapture: true, ...pluginConfig }));
    await handlers.agent_end?.(
      { success: true, messages },
      { sessionId: session, sessionKey: session },
    );
  }

  it("stores a user preference when auto-capture is enabled", async () => {
    fetchMock.mockResolvedValue(mockResponse({ id: "mem-1" }));
    await capture([{ role: "user", content: "I prefer dark mode" }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(requestInit(0, fetchMock.mock.calls).body));
    expect(body.content).toBe("I prefer dark mode");
    expect(body.metadata.category).toBe("preference");
  });

  it("does nothing when autoCapture is disabled", async () => {
    registerXMemoAutoCapture(mockApi({ apiKey: "key", autoCapture: false }));
    await handlers.agent_end?.(
      { success: true, messages: [{ role: "user", content: "I prefer dark mode" }] },
      { sessionId: "session-1" },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when the plugin is not configured", async () => {
    registerXMemoAutoCapture(mockApi({ autoCapture: true }));
    await handlers.agent_end?.(
      { success: true, messages: [{ role: "user", content: "I prefer dark mode" }] },
      { sessionId: "session-1" },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips non-user messages", async () => {
    await capture([
      { role: "assistant", content: "I will remember that" },
      { role: "system", content: "system prompt" },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips messages without a capture trigger", async () => {
    await capture([{ role: "user", content: "hello world" }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips auto-capture when the message appears to contain a secret", async () => {
    await capture([
      {
        role: "user",
        content: "remember this deployment key sk-proj-abcdefghijklmnopqrstuvwxyz1234567890",
      },
      {
        role: "user",
        content: "I prefer dark mode",
      },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(requestInit(0, fetchMock.mock.calls).body));
    expect(body.content).toBe("I prefer dark mode");
  });

  it("defers captures above the three-item limit and resumes them on the next event", async () => {
    fetchMock.mockImplementation(async () => mockResponse({ id: "mem-1" }));
    const messages = [
      { role: "user", content: "I prefer dark mode" },
      { role: "user", content: "My email is a@b.com" },
      { role: "user", content: "I decided to use TypeScript" },
      { role: "user", content: "I love Kimi" },
    ];

    await capture(messages);
    expect(fetchMock.mock.calls.map((_, index) => JSON.parse(String(requestInit(index, fetchMock.mock.calls).body)).content)).toEqual([
      "I prefer dark mode",
      "My email is a@b.com",
      "I decided to use TypeScript",
    ]);
    await capture(messages);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(JSON.parse(String(requestInit(3, fetchMock.mock.calls).body)).content).toBe("I love Kimi");
    await capture(messages);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(new Set(fetchMock.mock.calls.map((_, index) => idempotencyKey(index, fetchMock.mock.calls))).size).toBe(4);
  });

  it("keeps one idempotency key across 503, lost response, and retry", async () => {
    const messages = [{ role: "user", content: "I prefer dark mode" }];
    fetchMock
      .mockResolvedValueOnce(mockResponse({ error: "temporarily unavailable" }, 503))
      .mockRejectedValueOnce(new TypeError("fetch failed: response lost"))
      .mockImplementationOnce(async () => mockResponse({ id: "mem-1" }));

    await capture(messages);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstKey = idempotencyKey(0, fetchMock.mock.calls);
    expect(firstKey).toMatch(/^[0-9a-f]{64}$/);

    await capture(messages);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(idempotencyKey(1, fetchMock.mock.calls)).toBe(firstKey);

    await capture(messages);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(idempotencyKey(2, fetchMock.mock.calls)).toBe(firstKey);
    expect(JSON.parse(String(requestInit(2, fetchMock.mock.calls).body)).idempotency_key).toBe(firstKey);
  });

  it("keeps the idempotency key stable after a session cursor is reset", async () => {
    const messages = [{ role: "user", content: "I prefer dark mode" }];
    fetchMock.mockImplementation(async () => mockResponse({ id: "mem-1" }));

    await capture(messages);
    const firstKey = idempotencyKey(0, fetchMock.mock.calls);
    await handlers.session_end?.({}, { sessionId, sessionKey: sessionId });
    await capture(messages);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(idempotencyKey(1, fetchMock.mock.calls)).toBe(firstKey);
  });

  it("does not skip identical messages when the event history grows", async () => {
    fetchMock.mockImplementation(async () => mockResponse({ id: "mem-1" }));
    const repeated = { role: "user", content: "I prefer dark mode" };

    await capture([repeated]);
    await capture([repeated, repeated]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Set(fetchMock.mock.calls.map((_, index) => idempotencyKey(index, fetchMock.mock.calls))).size).toBe(2);
  });

  it("captures Chinese, Japanese, and Korean triggers without ASCII word boundaries", async () => {
    fetchMock.mockImplementation(async () => mockResponse({ id: "mem-1" }));
    await capture([
      { role: "user", content: "请记住我喜欢深色模式，以后默认使用深色主题。" },
      { role: "user", content: "この設定を覚えてください。今後もダークモードを使ってください。" },
      { role: "user", content: "앞으로 이 설정을 기억해 주세요. 항상 다크 모드를 사용해 주세요." },
    ]);

    expect(fetchMock.mock.calls.map((_, index) => JSON.parse(String(requestInit(index, fetchMock.mock.calls).body)).content)).toEqual([
      "请记住我喜欢深色模式，以后默认使用深色主题。",
      "この設定を覚えてください。今後もダークモードを使ってください。",
      "앞으로 이 설정을 기억해 주세요. 항상 다크 모드를 사용해 주세요.",
    ]);
  });

  it("rejects negated, quoted, and temporary capture requests", async () => {
    await capture([
      { role: "user", content: "请不要保存这件事，我喜欢深色模式。" },
      { role: "user", content: "朋友说：“请记住我喜欢深色模式。”" },
      { role: "user", content: "今天临时需要深色模式，请记住到今天结束。" },
      { role: "user", content: "我需要一辆车。" },
      { role: "user", content: "Please don't save this: I prefer dark mode." },
    ]);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("respects custom triggers", async () => {
    fetchMock.mockResolvedValue(mockResponse({ id: "mem-1" }));
    await capture(
      [
        { role: "user", content: "plain message" },
        { role: "user", content: "storethis decision" },
      ],
      {
        customTriggers: ["storethis"],
      },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(requestInit(0, fetchMock.mock.calls).body));
    expect(body.content).toBe("storethis decision");
  });

  it("passes an AbortSignal to the underlying request", async () => {
    fetchMock.mockResolvedValue(mockResponse({ id: "mem-1" }));
    await capture([{ role: "user", content: "I prefer dark mode" }]);

    const init = requestInit(0, fetchMock.mock.calls);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
