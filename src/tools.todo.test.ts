import type { OpenClawPluginApi } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerXMemoTools } from "./tools.js";

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(callIndex: number, calls: unknown[][]): string {
  return String(calls[callIndex]?.[0]);
}

function requestInit(callIndex: number, calls: unknown[][]): RequestInit {
  return (calls[callIndex]?.[1] ?? {}) as RequestInit;
}

describe("xmemo_todo_list tool", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const tools = new Map<string, { execute: (toolCallId: string, params: unknown) => unknown }>();

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    tools.clear();
    process.env.XMEMO_KEY = "test-key";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.XMEMO_KEY;
  });

  function mockApi(): OpenClawPluginApi {
    return {
      config: {
        plugins: {
          entries: {
            "xmemo-memory": {
              config: {
                apiKey: "test-key",
                bucket: "openclaw",
              },
            },
          },
        },
      },
      registerTool: (
        definition: { name: string; execute: (toolCallId: string, params: unknown) => unknown },
        _opts?: unknown,
      ) => {
        tools.set(definition.name, definition);
      },
    } as unknown as OpenClawPluginApi;
  }

  it("unwraps the real XMemo reminder list response shape", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        reminders: [
          { id: "r-1", content: "task one", status: "open" },
          { id: "r-2", content: "task two", status: "open", due_at: "2026-06-20T00:00:00Z" },
        ],
      }),
    );

    registerXMemoTools(mockApi());
    const tool = tools.get("xmemo_todo_list");
    expect(tool).toBeDefined();

    const result = await tool!.execute("call-1", { status: "open" });
    expect(result).toMatchObject({
      content: [
        {
          type: "text",
          text: "XMemo reminders:\n\n1. task one\n2. task two (due 2026-06-20T00:00:00Z)",
        },
      ],
      details: { count: 2 },
    });

    const url = new URL(requestUrl(0, fetchMock.mock.calls));
    expect(url.searchParams.get("item_status")).toBe("open");
  });

  it("unwraps reminder create envelopes and returns the created id", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        reminder: { id: "todo-1", content: "follow up", status: "open" },
      }, 201),
    );

    registerXMemoTools(mockApi());
    const result = await tools.get("xmemo_todo_create")!.execute("call-1", {
      content: "follow up",
    });

    expect(result).toMatchObject({
      content: [{ type: "text", text: "Created XMemo reminder todo-1: follow up" }],
      details: { action: "created", id: "todo-1" },
    });
  });

  it("sends an empty completion body and unwraps reminder complete envelopes", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        reminder: { id: "todo-1", content: "follow up", status: "completed" },
      }),
    );

    registerXMemoTools(mockApi());
    const result = await tools.get("xmemo_todo_complete")!.execute("call-1", {
      id: "todo-1",
    });

    expect(result).toMatchObject({
      content: [{ type: "text", text: "Completed XMemo reminder todo-1: follow up" }],
      details: { action: "completed", id: "todo-1" },
    });
    expect(requestUrl(0, fetchMock.mock.calls)).toBe(
      "https://xmemo.dev/v1/reminders/todo-1/complete",
    );
    expect(requestInit(0, fetchMock.mock.calls).body).toBe("{}");
  });

  it("unwraps timeline event envelopes and returns the event id", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        event: { id: "event-1", content: "milestone reached", event_type: "milestone" },
      }, 201),
    );

    registerXMemoTools(mockApi());
    const result = await tools.get("xmemo_record_event")!.execute("call-1", {
      content: "milestone reached",
      event_type: "milestone",
    });

    expect(result).toMatchObject({
      content: [{ type: "text", text: "Recorded XMemo event event-1: milestone reached" }],
      details: { action: "recorded", id: "event-1" },
    });
  });
});
