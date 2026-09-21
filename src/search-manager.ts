import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemoryReadResult,
  MemorySearchManager,
  MemorySearchResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { XMemoClient, XMemoRecallContextItem } from "./client.js";
import type { XMemoMemoryConfig } from "./config.js";

const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function memoryIdFromPath(relPath: string): string | undefined {
  // Accept paths like "bucket/id", "bucket/scope/id", or just "id".
  // XMemo ids may be UUIDs or arbitrary strings; take the final non-empty segment.
  const parts = relPath.split("/").filter(Boolean);
  const last = parts[parts.length - 1];
  return last;
}

function resultPath(item: XMemoRecallContextItem, fallbackBucket: string): string {
  if (item.path) {
    return `${item.path}/${item.id}`;
  }
  return `${item.bucket ?? fallbackBucket}/${item.id}`;
}

export class XMemoSearchManager implements MemorySearchManager {
  private connected: boolean | undefined;
  private lastError: string | undefined;
  private lastProbeAtMs: number | undefined;

  constructor(
    private readonly client: XMemoClient,
    private readonly config: XMemoMemoryConfig,
  ) {}

  async search(
    query: string,
    opts: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
      signal?: AbortSignal;
      sources?: Array<"memory" | "sessions">;
    } = {},
  ): Promise<MemorySearchResult[]> {
    if (!this.client.isConfigured()) {
      return [];
    }

    try {
      const response = await this.client.recallContext(
        {
          query: query.slice(0, this.config.recallMaxChars),
          bucket: this.config.readBucket,
          scope: this.config.readScope ?? null,
          team_id: this.config.teamId ?? null,
          max_items: opts.maxResults ?? this.config.recallMaxItems,
          max_tokens: this.config.recallMaxTokens,
          prefer_working: true,
        },
        opts.signal,
      );

      this.connected = true;
      this.lastError = undefined;

      return (response.items ?? []).map((item: XMemoRecallContextItem, index: number) => {
        const score = item.score ?? Math.max(0.5, 0.95 - index * 0.05);
        const path = resultPath(item, this.config.bucket);
        return {
          path,
          startLine: 1,
          endLine: 1,
          score,
          snippet: item.content ?? item.snippet ?? "",
          source: "memory" as const,
        };
      });
    } catch (error) {
      this.connected = false;
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async readFile(
    {
      relPath,
      from,
      lines,
    }: {
      relPath: string;
      from?: number;
      lines?: number;
    },
    signal?: AbortSignal,
  ): Promise<MemoryReadResult> {
    if (!this.client.isConfigured()) {
      return { text: "", path: relPath, truncated: false, from: 1, lines: 0 };
    }

    if (relPath.includes("..")) {
      throw new Error(`Path traversal not allowed: ${relPath}`);
    }

    const trimmed = relPath.trim();
    const id = memoryIdFromPath(trimmed);
    const isUuid = id ? UUID_REGEX.test(id) : false;
    let text: string | undefined;
    let path = trimmed;

    // Only attempt direct getMemory if id exists and is a UUID or doesn't end with .md
    if (id && (isUuid || !trimmed.endsWith(".md"))) {
      try {
        const memory = await this.client.getMemory(id, signal);
        if (typeof memory?.content === "string") {
          text = memory.content;
          path = memory.path ?? trimmed;
        }
      } catch (err) {
        // Fallback to searchMemory if direct getMemory failed
      }
    }

    if (text === undefined) {
      const response = await this.client.searchMemory(
        {
          query: id || trimmed,
          path: trimmed,
          bucket: this.config.readBucket,
          scope: this.config.readScope ?? null,
          team_id: this.config.teamId ?? null,
          max_items: 10,
        },
        signal,
      );
      const match =
        (id ? response.results.find((r) => r.id === id) : undefined) ??
        response.results.find((r) => r.path === trimmed || r.path === trimmed.toLowerCase()) ??
        response.results.find((r) => r.path?.endsWith("/" + trimmed) || trimmed.endsWith("/" + r.path));

      if (!match || typeof match.content !== "string") {
        throw new Error(`Memory not found for path: ${trimmed}`);
      }
      text = match.content;
      path = match.path ?? trimmed;
    }

    this.connected = true;
    this.lastError = undefined;

    const allLines = text.split("\n");
    const startFrom = Math.max(1, from ?? 1);
    const lineCount = typeof lines === "number" ? Math.max(0, lines) : allLines.length;
    const sliced = allLines.slice(startFrom - 1, startFrom - 1 + lineCount);
    const resultText = sliced.join("\n");
    const isTruncated = (startFrom - 1 + sliced.length) < allLines.length;

    return {
      text: resultText,
      path,
      truncated: isTruncated,
      from: startFrom,
      lines: sliced.length,
    };
  }

  async probeConnectivity(signal?: AbortSignal): Promise<boolean> {
    if (!this.client.isConfigured()) {
      this.connected = false;
      this.lastError = "not configured";
      return false;
    }

    try {
      await this.client.validateToken(signal);
      this.connected = true;
      this.lastError = undefined;
      this.lastProbeAtMs = Date.now();
      return true;
    } catch (error: unknown) {
      this.connected = false;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.lastProbeAtMs = Date.now();
      return false;
    }
  }

  status(): MemoryProviderStatus {
    return {
      backend: "builtin",
      provider: "xmemo-memory",
      custom: {
        baseUrl: this.config.baseUrl,
        bucket: this.config.bucket,
        scope: this.config.scope,
        readBucket: this.config.readBucket,
        readScope: this.config.readScope,
        configured: this.client.isConfigured(),
        connected: this.connected ?? false,
        ...(this.lastError ? { lastError: this.lastError } : {}),
      },
    };
  }

  async sync(): Promise<void> {
    // XMemo is remote; there is no local index to sync.
  }

  getCachedEmbeddingAvailability(): MemoryEmbeddingProbeResult | null {
    if (this.connected === undefined) {
      return null;
    }
    return {
      ok: this.connected,
      error: this.lastError,
      checked: this.lastProbeAtMs !== undefined,
      cached: true,
      checkedAtMs: this.lastProbeAtMs,
    };
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    const ok = await this.probeConnectivity();
    return {
      ok,
      error: this.lastError,
      checked: true,
      cached: false,
      checkedAtMs: this.lastProbeAtMs,
    };
  }

  async probeVectorStoreAvailability(): Promise<boolean> {
    return await this.probeConnectivity();
  }

  async probeVectorAvailability(): Promise<boolean> {
    return await this.probeConnectivity();
  }

  async close(): Promise<void> {
    // HTTP client is stateless.
  }
}
