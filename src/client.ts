// Thin XMemo REST client. All memory operations are remote HTTP calls.
// No local vector store or embedding model is required.

import type { XMemoAuthMode } from "./config.js";

export type XMemoRememberRequest = {
  content: string;
  path?: string;
  bucket?: string;
  scope?: string | null;
  team_id?: string | null;
  memory_type?: "auto" | "semantic" | "episodic" | "procedural" | "working" | "identity";
  semantic_key?: string | null;
  importance?: number;
  confidence?: number;
  expires_at?: string | null;
  source?: string | null;
  metadata?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
};

export type XMemoRememberResponse = {
  id: string;
  status?: string;
};

export type XMemoRecallContextRequest = {
  query: string;
  path?: string;
  bucket?: string;
  scope?: string | null;
  team_id?: string | null;
  memory_type?: string;
  status?: string;
  threshold?: number;
  max_items?: number;
  max_tokens?: number;
  prefer_working?: boolean;
};

export type XMemoRecallContextItem = {
  id: string;
  content: string;
  snippet?: string;
  path?: string;
  bucket?: string;
  scope?: string | null;
  score?: number;
  memory_type?: string;
  updated_at?: string;
};

export type XMemoRecallContextResponse = {
  items: XMemoRecallContextItem[];
  context_text?: string;
  budget?: { tokens?: number; items?: number };
  coverage?: unknown;
  agent_boundary?: unknown;
};

export type XMemoSearchMemoryRequest = {
  query: string;
  path?: string;
  bucket?: string;
  scope?: string | null;
  team_id?: string | null;
  max_items?: number;
  threshold?: number;
};

export type XMemoSearchMemoryResult = {
  id: string;
  content: string;
  path?: string;
  bucket?: string;
  scope?: string | null;
  score?: number;
  memory_type?: string;
};

export type XMemoSearchMemoryResponse = {
  results: XMemoSearchMemoryResult[];
  coverage?: unknown;
  agent_boundary?: unknown;
};

export type XMemoMemory = {
  id: string;
  content: string;
  path?: string;
  bucket?: string;
  scope?: string | null;
  memory_type?: string;
  status?: string;
  importance?: number;
  confidence?: number;
  updated_at?: string;
  created_at?: string;
};

export type XMemoUpdateMemoryRequest = {
  content?: string | null;
  path?: string | null;
  bucket?: string | null;
  scope?: string | null;
  team_id?: string | null;
  memory_type?: string | null;
  status?: string | null;
  importance?: number;
  confidence?: number;
  metadata?: Record<string, unknown>;
  merge_metadata?: boolean;
  merge_provenance?: boolean;
  detect_conflicts?: boolean;
};

export type XMemoForgetMemoryRequest = {
  mode?: "soft_delete" | "hard_delete" | "redact";
  reason?: string | null;
  replacement_content?: string | null;
};

export type XMemoReminderRequest = {
  content: string;
  bucket?: string;
  scope?: string | null;
  team_id?: string | null;
  due_at?: string | null;
  metadata?: Record<string, unknown>;
};

export type XMemoReminder = {
  id: string;
  content: string;
  status?: string;
  due_at?: string;
};

export type XMemoReminderListResponse = {
  reminders: XMemoReminder[];
};

export type XMemoTimelineEventRequest = {
  content: string;
  event_type?: string;
  bucket?: string;
  scope?: string | null;
  team_id?: string | null;
  session_id?: string | null;
  occurred_at?: string | null;
  importance?: number;
  confidence?: number;
  source?: string | null;
  metadata?: Record<string, unknown>;
};

export type XMemoTimelineEvent = {
  id: string;
  content: string;
  event_type?: string;
  occurred_at?: string;
};

export type XMemoRestartSnapshotRequest = {
  label?: string | null;
  bucket?: string;
  scope?: string | null;
  team_id?: string | null;
  metadata?: Record<string, unknown>;
};

export type XMemoRestartSnapshot = {
  id: string;
  label?: string | null;
  created_at?: string;
};

export type XMemoRestartRestoreRequest = {
  snapshot_id?: string | null;
  bucket?: string;
  scope?: string | null;
  team_id?: string | null;
};

export type XMemoRestartRestoreResponse = {
  id?: string;
  memory_id?: string;
  status?: string;
  restored?: boolean;
  snapshot_id?: string;
};

export type XMemoLedgerMonthlySummaryParams = {
  month?: number;
  year?: number;
  currency?: string;
};

export type XMemoLedgerMonthlySummary = {
  month: string;
  currency: string;
  total: number;
  count: number;
};

export type XMemoAuditEvent = {
  id: string;
  action: string;
  target_id?: string;
  created_at?: string;
};

export type XMemoAuditEventsParams = {
  action?: string;
  target_id?: string;
  limit?: number;
  since?: string;
  until?: string;
};

export type XMemoAuditEventsResponse = {
  events: XMemoAuditEvent[];
};

export type XMemoAuditConsolidationParams = {
  action_type?: string;
  limit?: number;
  since?: string;
  until?: string;
};

export type XMemoAuditConsolidationResponse = Record<string, unknown>;

export type XMemoTokenValidateResponse = {
  status: "valid";
  scopes?: string[];
  setup_state?: string;
};

// ---------------------------------------------------------------------------
// Retry & Circuit Breaker
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_DELAY_MS = 500;
const DEFAULT_BACKOFF_FACTOR = 2;
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 120_000;

function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

function isTransientError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === "AbortError") return false; // caller-initiated abort
    if (/fetch|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR/i.test(error.message)) {
      return true;
    }
  }
  if (error instanceof XMemoClientError && error.status !== undefined) {
    return isTransientStatus(error.status);
  }
  return false;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

/**
 * Simple circuit breaker shared across all XMemoClient instances in a process.
 * Opens after BREAKER_THRESHOLD consecutive transient failures, auto-resets
 * after BREAKER_COOLDOWN_MS.
 */
class CircuitBreaker {
  private consecutiveFailures = 0;
  private openUntil = 0;

  isOpen(): boolean {
    if (this.consecutiveFailures < BREAKER_THRESHOLD) return false;
    if (Date.now() >= this.openUntil) {
      // Half-open: allow one probe
      this.consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= BREAKER_THRESHOLD) {
      this.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
    }
  }

  get state(): "closed" | "open" | "half-open" {
    if (this.consecutiveFailures < BREAKER_THRESHOLD) return "closed";
    if (Date.now() >= this.openUntil) return "half-open";
    return "open";
  }
}

/** Process-global breaker so all tool calls share the same failure counter. */
const globalBreaker = new CircuitBreaker();

export { globalBreaker };

function redactErrorMessage(message: string, apiKey: string): string {
  if (!apiKey) {
    return message;
  }
  // Replace the literal key so it is never echoed in logs, CLI output, or tool results.
  return message.replaceAll(apiKey, "***");
}

/** Structured HTTP error from the XMemo REST client. */
export class XMemoClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly pathname?: string,
  ) {
    super(message);
    this.name = "XMemoClientError";
  }
}

export class XMemoClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly agentId: string,
    private readonly agentInstanceId: string,
    private readonly authMode: XMemoAuthMode = "api-key",
  ) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Memory-OS-Agent-ID": this.agentId,
      "X-Memory-OS-Agent-Instance-ID": this.agentInstanceId,
    };
    if (this.authMode === "api-key" || this.authMode === "both") {
      headers["X-API-Key"] = this.apiKey;
    }
    if (this.authMode === "bearer" || this.authMode === "both") {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private async request<T>(pathname: string, options: RequestInit = {}): Promise<T> {
    // Check circuit breaker before attempting the request.
    if (globalBreaker.isOpen()) {
      throw new XMemoClientError(
        "XMemo circuit breaker is open — service temporarily unavailable",
        503,
        pathname,
      );
    }

    const isRead =
      options.method === "GET" ||
      (options.method === "POST" && pathname === "/v1/recall/context");

    const maxAttempts = isRead ? DEFAULT_MAX_ATTEMPTS : 1;
    let delay = DEFAULT_INITIAL_DELAY_MS;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const url = `${this.baseUrl}${pathname}`;
        const response = await fetch(url, {
          ...options,
          headers: {
            ...this.headers(),
            ...(options.headers as Record<string, string> | undefined),
          },
        });

        if (!response.ok) {
          const text = await response.text().catch(() => "unknown error");
          const rawMessage = `XMemo ${pathname} failed (${response.status}): ${text}`;
          const error = new XMemoClientError(
            redactErrorMessage(rawMessage, this.apiKey),
            response.status,
            pathname,
          );

          // Retry on transient HTTP status for read operations
          if (isTransientStatus(response.status) && attempt < maxAttempts) {
            lastError = error;
            await sleep(delay, options.signal as AbortSignal | undefined);
            delay *= DEFAULT_BACKOFF_FACTOR;
            continue;
          }

          // Record transient failure for circuit breaker
          if (isTransientStatus(response.status)) {
            globalBreaker.recordFailure();
          }

          throw error;
        }

        // Success
        globalBreaker.recordSuccess();

        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          return (await response.json()) as T;
        }
        return {} as T;
      } catch (error) {
        lastError = error;

        // Don't retry caller-initiated aborts
        if (error instanceof Error && error.name === "AbortError") {
          throw error;
        }

        // Already a classified XMemoClientError from the !response.ok path above
        if (error instanceof XMemoClientError) {
          if (isTransientError(error) && attempt < maxAttempts) {
            await sleep(delay, options.signal as AbortSignal | undefined);
            delay *= DEFAULT_BACKOFF_FACTOR;
            continue;
          }
          if (isTransientError(error)) {
            globalBreaker.recordFailure();
          }
          throw error;
        }

        // Network-level errors (fetch failed, DNS, connection refused, etc.)
        if (isTransientError(error) && attempt < maxAttempts) {
          await sleep(delay, options.signal as AbortSignal | undefined);
          delay *= DEFAULT_BACKOFF_FACTOR;
          continue;
        }

        // Final attempt or non-transient
        if (isTransientError(error)) {
          globalBreaker.recordFailure();
        }

        const message = error instanceof Error ? error.message : String(error);
        throw new XMemoClientError(
          redactErrorMessage(`XMemo ${pathname} failed: ${message}`, this.apiKey),
          undefined,
          pathname,
        );
      }
    }

    // Should not reach here, but satisfy the type checker
    if (lastError instanceof XMemoClientError) throw lastError;
    const msg = lastError instanceof Error ? lastError.message : String(lastError);
    throw new XMemoClientError(
      redactErrorMessage(`XMemo ${pathname} failed after ${maxAttempts} attempts: ${msg}`, this.apiKey),
      undefined,
      pathname,
    );
  }

  private buildSearchParams(
    params: Record<string, string | number | boolean | null | undefined>,
  ): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      search.set(key, String(value));
    }
    const query = search.toString();
    return query ? `?${query}` : "";
  }

  /**
   * Replay an outbox write with full auth headers and idempotency key.
   * Used by the resilient client's outbox sync to ensure queued writes
   * use the same authentication and agent headers as normal writes.
   */
  async replayWrite(
    pathname: string,
    method: string,
    payload: Record<string, unknown>,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const body = { ...payload, idempotency_key: idempotencyKey };
    return this.request<unknown>(pathname, {
      method,
      body: JSON.stringify(body),
      headers: {
        "Idempotency-Key": idempotencyKey,
        "X-Idempotency-Key": idempotencyKey,
      },
      signal,
    });
  }

  async remember(
    request: XMemoRememberRequest,
    signal?: AbortSignal,
  ): Promise<XMemoRememberResponse> {
    return this.request<XMemoRememberResponse>("/v1/remember", {
      method: "POST",
      body: JSON.stringify(request),
      signal,
    });
  }

  async validateToken(signal?: AbortSignal): Promise<XMemoTokenValidateResponse> {
    return this.request<XMemoTokenValidateResponse>("/v1/auth/token/validate", {
      method: "GET",
      signal,
    });
  }

  async recallContext(
    request: XMemoRecallContextRequest,
    signal?: AbortSignal,
  ): Promise<XMemoRecallContextResponse> {
    return this.request<XMemoRecallContextResponse>("/v1/recall/context", {
      method: "POST",
      body: JSON.stringify(request),
      signal,
    });
  }

  async searchMemory(
    request: XMemoSearchMemoryRequest,
    signal?: AbortSignal,
  ): Promise<XMemoSearchMemoryResponse> {
    const query = this.buildSearchParams({
      query: request.query,
      path: request.path,
      bucket: request.bucket,
      scope: request.scope,
      team_id: request.team_id,
      limit: request.max_items,
      threshold: request.threshold,
    });
    return this.request<XMemoSearchMemoryResponse>(`/v1/memories/search${query}`, {
      method: "GET",
      signal,
    });
  }

  async getMemory(id: string, signal?: AbortSignal): Promise<XMemoMemory> {
    try {
      return await this.request<XMemoMemory>(`/v1/memories/${encodeURIComponent(id)}`, {
        method: "GET",
        signal,
      });
    } catch (error) {
      // Only fall back to search-by-id when the direct GET endpoint is missing or
      // unavailable (404/405). Auth, timeout, and server errors should surface as-is.
      if (!(error instanceof XMemoClientError) || (error.status !== 404 && error.status !== 405)) {
        throw error;
      }
      const search = await this.searchMemory(
        {
          query: id,
          bucket: undefined,
          scope: null,
          team_id: null,
          max_items: 5,
        },
        signal,
      );
      const match = search.results.find((r) => r.id === id);
      if (match) {
        return {
          id: match.id,
          content: match.content,
          path: match.path,
          bucket: match.bucket,
          scope: match.scope,
          memory_type: match.memory_type,
        };
      }
      throw error;
    }
  }

  async updateMemory(
    id: string,
    request: XMemoUpdateMemoryRequest,
    signal?: AbortSignal,
  ): Promise<XMemoMemory> {
    return this.request<XMemoMemory>(`/v1/memories/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(request),
      signal,
    });
  }

  async forgetMemory(
    id: string,
    request?: XMemoForgetMemoryRequest,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request<unknown>(`/v1/memories/${encodeURIComponent(id)}/forget`, {
      method: "POST",
      body: JSON.stringify(request ?? {}),
      signal,
    });
  }

  async createReminder(
    request: XMemoReminderRequest,
    signal?: AbortSignal,
  ): Promise<XMemoReminder> {
    return this.request<XMemoReminder>("/v1/reminders", {
      method: "POST",
      body: JSON.stringify(request),
      signal,
    });
  }

  async listReminders(
    params?: {
      bucket?: string;
      scope?: string | null;
      item_status?: string;
    },
    signal?: AbortSignal,
  ): Promise<XMemoReminderListResponse> {
    const query = this.buildSearchParams({
      bucket: params?.bucket,
      scope: params?.scope,
      item_status: params?.item_status,
    });
    return this.request<XMemoReminderListResponse>(`/v1/reminders${query}`, {
      method: "GET",
      signal,
    });
  }

  async completeReminder(id: string, signal?: AbortSignal): Promise<XMemoReminder> {
    return this.request<XMemoReminder>(`/v1/reminders/${encodeURIComponent(id)}/complete`, {
      method: "POST",
      signal,
    });
  }

  async recordEvent(
    request: XMemoTimelineEventRequest,
    signal?: AbortSignal,
  ): Promise<XMemoTimelineEvent> {
    return this.request<XMemoTimelineEvent>("/v1/timeline/events", {
      method: "POST",
      body: JSON.stringify(request),
      signal,
    });
  }

  async getTimeline(
    params?: {
      bucket?: string;
      scope?: string | null;
      limit?: number;
    },
    signal?: AbortSignal,
  ): Promise<XMemoTimelineEvent[]> {
    const query = this.buildSearchParams({
      bucket: params?.bucket,
      scope: params?.scope,
      limit: params?.limit,
    });
    return this.request<XMemoTimelineEvent[]>(`/v1/timeline${query}`, {
      method: "GET",
      signal,
    });
  }

  async saveRestartSnapshot(
    request: XMemoRestartSnapshotRequest,
    signal?: AbortSignal,
  ): Promise<XMemoRestartSnapshot> {
    return this.request<XMemoRestartSnapshot>("/v1/restart/snapshot", {
      method: "POST",
      body: JSON.stringify(request),
      signal,
    });
  }

  async restoreRestartSnapshot(
    request?: XMemoRestartRestoreRequest,
    signal?: AbortSignal,
  ): Promise<XMemoRestartRestoreResponse> {
    return this.request<XMemoRestartRestoreResponse>("/v1/restart/restore", {
      method: "POST",
      body: JSON.stringify(request ?? {}),
      signal,
    });
  }

  async getLedgerMonthlySummary(
    params?: XMemoLedgerMonthlySummaryParams,
    signal?: AbortSignal,
  ): Promise<XMemoLedgerMonthlySummary> {
    const query = this.buildSearchParams({
      month: params?.month,
      year: params?.year,
      currency: params?.currency,
    });
    return this.request<XMemoLedgerMonthlySummary>(`/v1/me/ledger/monthly-summary${query}`, {
      method: "GET",
      signal,
    });
  }

  async getAuditEvents(
    params?: XMemoAuditEventsParams,
    signal?: AbortSignal,
  ): Promise<XMemoAuditEventsResponse> {
    const query = this.buildSearchParams({
      action: params?.action,
      target_id: params?.target_id,
      limit: params?.limit,
      since: params?.since,
      until: params?.until,
    });
    return this.request<XMemoAuditEventsResponse>(`/v1/audit/events${query}`, {
      method: "GET",
      signal,
    });
  }

  async getAuditConsolidation(
    params?: XMemoAuditConsolidationParams,
    signal?: AbortSignal,
  ): Promise<XMemoAuditConsolidationResponse> {
    const query = this.buildSearchParams({
      action_type: params?.action_type,
      limit: params?.limit,
      since: params?.since,
      until: params?.until,
    });
    return this.request<XMemoAuditConsolidationResponse>(`/v1/audit/consolidation${query}`, {
      method: "GET",
      signal,
    });
  }
}
