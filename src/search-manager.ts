import { randomUUID } from "node:crypto";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemoryReadResult,
  MemorySearchManager,
  MemorySearchResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { XMemoClient, type XMemoRecallContextItem } from "./client.js";
import type { XMemoMemoryConfig } from "./config.js";
import { CloudProvider, MemoryService, trustedLocalIdentity } from "./memory-service.js";
import { hasRestrictedReadScope, matchesConfiguredReadScope } from "./identity-scope.js";
import { classifyMemorySearchFailure, filterMemorySearchItems, XMEMO_SEARCH_CAPABILITIES } from "./search-policy.js";
import type { TrustedLocalIdentityContext } from "./local/kernel.js";

const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MAX_LOCAL_READ_CAPABILITIES = 512;

type LocalReadCapability = { recordId: string; identity: TrustedLocalIdentityContext };

function sameLocalIdentity(left: TrustedLocalIdentityContext, right: TrustedLocalIdentityContext): boolean {
  return left.kind === right.kind && left.actorRef === right.actorRef && left.roomRef === right.roomRef &&
    left.groupOptIn === right.groupOptIn;
}

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

  private readonly service: MemoryService;
  private readonly config: XMemoMemoryConfig;
  private readonly localReadCapabilities = new Map<string, LocalReadCapability>();

  constructor(source: MemoryService | XMemoClient, config: XMemoMemoryConfig) {
    this.config = config;
    if (source instanceof MemoryService) {
      this.service = source;
    } else {
      this.service = new MemoryService(config, new CloudProvider(source), undefined);
    }
  }

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
    if (!this.service.isConfigured) {
      return [];
    }
    // XMemo indexes durable memory only; it cannot apply the host's sessionKey filter or search sessions.
    if (opts.sources !== undefined && !opts.sources.includes("memory")) {
      return [];
    }

    if (this.service.mode === "hybrid") {
      throw new Error("XMemo capability_unavailable: hybrid mode is not implemented.");
    }

    if (this.service.mode === "local") {
      if (opts.sessionKey && /:(group|channel):/i.test(opts.sessionKey)) {
        throw new Error("XMemo local identity_denied: group search requires trusted speaker identity.");
      }
      if (opts.minScore !== undefined) return [];
      const identity = opts.sessionKey
        ? trustedLocalIdentity({ agentId: this.config.agentId, sessionKey: opts.sessionKey }, this.config.agentId)
        : this.service.localIdentityContext ?? trustedLocalIdentity({ agentId: this.config.agentId }, this.config.agentId);
      const records = await this.service.localSearch(
        query.slice(0, this.config.recallMaxChars),
        opts.maxResults ?? this.config.recallMaxItems,
        identity,
      );
      this.connected = true;
      this.lastError = undefined;
      const defaultIdentity = this.service.localIdentityContext ??
        trustedLocalIdentity({ agentId: this.config.agentId }, this.config.agentId);
      const hasScopedIdentity = !sameLocalIdentity(identity, defaultIdentity);
      return records.map((record) => {
        // The host readFile API has no session field. Carry a bounded opaque handle
        // for results searched under an identity other than the manager's default.
        const path = hasScopedIdentity ? `local/result/${randomUUID()}` : `local/${record.recordId}`;
        if (hasScopedIdentity) {
          this.localReadCapabilities.set(path, { recordId: record.recordId, identity });
          while (this.localReadCapabilities.size > MAX_LOCAL_READ_CAPABILITIES) {
            const oldestPath = this.localReadCapabilities.keys().next().value;
            if (oldestPath === undefined) break;
            this.localReadCapabilities.delete(oldestPath);
          }
        }
        return {
          path,
          startLine: 1,
          endLine: Math.max(1, record.body.split("\n").length),
          score: 0,
          scoreKnown: false,
          snippet: record.body,
          source: "memory" as const,
        } as MemorySearchResult & { scoreKnown: boolean };
      });
    }

    try {
      const response = await this.service.cloudHostRecall(
        {
          query: query.slice(0, this.config.recallMaxChars),
          bucket: this.config.readBucket,
          scope: this.config.readScope ?? null,
          team_id: this.config.teamId ?? null,
          max_items: opts.maxResults ?? this.config.recallMaxItems,
          max_tokens: this.config.recallMaxTokens,
          prefer_working: true,
          threshold: opts.minScore,
        },
        opts.signal,
      );

      this.connected = true;
      this.lastError = undefined;

      return filterMemorySearchItems(response.items ?? [], opts.minScore).map(({ item, score, scoreKnown }) => {
        const path = resultPath(item, this.config.bucket);
        return {
          path,
          startLine: 1,
          endLine: 1,
          score,
          scoreKnown,
          snippet: item.content ?? item.snippet ?? "",
          source: "memory" as const,
        } as MemorySearchResult & { scoreKnown: boolean };
      });
    } catch (error) {
      this.connected = false;
      const failure = classifyMemorySearchFailure(error);
      const status = failure.status === undefined ? "" : ` (${failure.status})`;
      this.lastError = `${failure.errorType}${status}: ${error instanceof Error ? error.message : String(error)}`;
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
    if (!this.service.isConfigured) {
      return { text: "", path: relPath, truncated: false, from: 1, lines: 0 };
    }

    const hasTraversal = relPath.split(/[/\\]/).some((s) => s.trim() === "..");
    if (hasTraversal) {
      throw new Error(`Path traversal not allowed: ${relPath}`);
    }

    if (this.service.mode === "hybrid") {
      throw new Error("XMemo capability_unavailable: hybrid mode is not implemented.");
    }
    if (this.service.mode === "local") {
      const trimmed = relPath.trim();
      const capability = this.localReadCapabilities.get(trimmed);
      const id = capability?.recordId ?? memoryIdFromPath(trimmed);
      if (!id) throw new Error(`Memory not found for path: ${trimmed}`);
      const record = await this.service.localGet(id, capability?.identity);
      const allLines = record.body.split("\n");
      const startFrom = Math.max(1, from ?? 1);
      if (record.body.length > 0 && startFrom > allLines.length) {
        const err = new Error(`Requested line ${startFrom} is out of bounds (document has ${allLines.length} lines)`);
        (err as Error & { code?: string }).code = "range_error";
        throw err;
      }
      const lineCount = typeof lines === "number" ? Math.max(0, lines) : allLines.length;
      const sliced = record.body.length === 0 ? [] : allLines.slice(startFrom - 1, startFrom - 1 + lineCount);
      return {
        text: sliced.join("\n"),
        path: capability ? trimmed : `local/${record.recordId}`,
        truncated: record.body.length > 0 && startFrom - 1 + sliced.length < allLines.length,
        from: startFrom,
        lines: sliced.length,
      };
    }

    const trimmed = relPath.trim();
    const id = memoryIdFromPath(trimmed);
    const isUuid = id ? UUID_REGEX.test(id) : false;
    let text: string | undefined;
    let path = trimmed;

    // Only attempt direct getMemory if id exists and is a UUID or doesn't end with .md
    const directLookup = id && (isUuid || !trimmed.endsWith(".md"));
    const restrictedDirectLookup = Boolean(directLookup && hasRestrictedReadScope(this.config));
    if (directLookup) {
      try {
        const memory = restrictedDirectLookup
          ? await this.service.getMemoryDirect(id, signal)
          : await this.service.getMemory(id, signal);
        if (
          (!restrictedDirectLookup || matchesConfiguredReadScope(memory, this.config)) &&
          typeof memory?.content === "string" &&
          (!memory.status || memory.status.toLowerCase() !== "deleted")
        ) {
          text = memory.content;
          path = memory.path ?? trimmed;
        }
      } catch (err: any) {
        if (err?.status === 401 || err?.status === 403 || err?.name === "AbortError") {
          throw err;
        }
        if (restrictedDirectLookup && err?.status !== 404 && err?.status !== 405) {
          throw err;
        }
        // Fallback to searchMemory if direct getMemory failed
      }
    }

    if (text === undefined) {
      if (restrictedDirectLookup) {
        throw new Error("Memory not found for path: " + trimmed);
      }
      const response = await this.service.cloudSearch(
        {
          query: id || trimmed,
          path: trimmed,
          bucket: this.config.readBucket,
          scope: this.config.readScope ?? null,
          team_id: this.config.teamId ?? null,
          status: "active",
          max_items: 10,
        },
        signal,
      );
      const activeResults = response.results.filter((r) => !r.status || r.status.toLowerCase() !== "deleted");
      const match =
        (id ? activeResults.find((r) => r.id === id) : undefined) ??
        activeResults.find((r) => r.path === trimmed || r.path === trimmed.toLowerCase()) ??
        activeResults.find((r) => r.path?.endsWith("/" + trimmed) || trimmed.endsWith("/" + r.path));

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
    if (text.length > 0 && startFrom > allLines.length) {
      const err = new Error(`Requested line ${startFrom} is out of bounds (document has ${allLines.length} lines)`);
      (err as any).code = "range_error";
      throw err;
    }
    const lineCount = typeof lines === "number" ? Math.max(0, lines) : allLines.length;
    const sliced = text.length === 0 ? [] : allLines.slice(startFrom - 1, startFrom - 1 + lineCount);
    const resultText = sliced.join("\n");
    const isTruncated = text.length === 0 ? false : (startFrom - 1 + sliced.length) < allLines.length;

    return {
      text: resultText,
      path,
      truncated: isTruncated,
      from: startFrom,
      lines: sliced.length,
    };
  }

  async probeConnectivity(signal?: AbortSignal): Promise<boolean> {
    if (!this.service.isConfigured) {
      this.connected = false;
      this.lastError = "not configured";
      return false;
    }

    if (this.service.mode === "local") {
      this.connected = true;
      this.lastError = undefined;
      this.lastProbeAtMs = Date.now();
      return true;
    }
    if (this.service.mode === "hybrid") {
      this.connected = false;
      this.lastError = "capability_unavailable: hybrid mode is not implemented";
      this.lastProbeAtMs = Date.now();
      return false;
    }

    try {
      await this.service.validateCloud(signal);
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
        mode: this.config.mode,
        baseUrl: this.config.baseUrl,
        bucket: this.config.bucket,
        scope: this.config.scope,
        readBucket: this.config.readBucket,
        readScope: this.config.readScope,
        configured: this.service.isConfigured,
        connected: this.connected ?? false,
        searchCapabilities: XMEMO_SEARCH_CAPABILITIES,
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
