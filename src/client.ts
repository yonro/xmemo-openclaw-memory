// Thin XMemo REST client. All memory operations are remote HTTP calls.
// No local vector store or embedding model is required.

import type { XMemoAuthMode } from "./config.js";
import { createHash } from "node:crypto";

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
  memory_type?: string;
  status?: string;
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
  status?: string;
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
  item_status?: string;
  due_at?: string;
  bucket?: string;
  scope?: string | null;
};

export type XMemoReminderListResponse = {
  reminders: XMemoReminder[];
};

type XMemoReminderEnvelope =
  | XMemoReminder
  | { reminder?: XMemoReminder; item?: XMemoReminder; result?: XMemoReminder };

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

type XMemoTimelineEventEnvelope =
  | XMemoTimelineEvent
  | { event?: XMemoTimelineEvent; timeline_event?: XMemoTimelineEvent; result?: XMemoTimelineEvent };

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
  months?: number;
  month?: number;
  year?: number;
  currency?: string;
  transaction_type?: string;
};

export type XMemoMonthlyLedgerItem = {
  month: string;
  currency: string;
  expense_total?: string | number;
  income_total?: string | number;
  net_total?: string | number;
  transaction_count?: number;
  total?: string | number;
  count?: number;
  [key: string]: unknown;
};

export type XMemoLedgerMonthlySummary = {
  month?: string;
  currency?: string;
  total?: number;
  count?: number;
  summary?: XMemoMonthlyLedgerItem[];
  [key: string]: unknown;
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

function unwrapReminder(response: XMemoReminderEnvelope): XMemoReminder {
  const envelope = response as {
    reminder?: XMemoReminder;
    item?: XMemoReminder;
    result?: XMemoReminder;
  };
  return envelope.reminder ?? envelope.item ?? envelope.result ?? (response as XMemoReminder);
}

function unwrapTimelineEvent(response: XMemoTimelineEventEnvelope): XMemoTimelineEvent {
  const envelope = response as {
    event?: XMemoTimelineEvent;
    timeline_event?: XMemoTimelineEvent;
    result?: XMemoTimelineEvent;
  };
  return envelope.event ?? envelope.timeline_event ?? envelope.result ?? (response as XMemoTimelineEvent);
}

function unwrapLedgerMonthlySummary(response: unknown): XMemoLedgerMonthlySummary {
  if (
    response &&
    typeof response === "object" &&
    "result" in response &&
    response.result &&
    typeof response.result === "object"
  ) {
    return response.result as XMemoLedgerMonthlySummary;
  }
  return (response ?? {}) as XMemoLedgerMonthlySummary;
}

// ---------------------------------------------------------------------------
// Retry & Circuit Breaker
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_DELAY_MS = 500;
const DEFAULT_BACKOFF_FACTOR = 2;
const MAX_RETRY_DELAY_MS = 30_000;
const MAX_RETRY_AFTER_MS = 60 * 60_000;
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 120_000;
const BREAKER_MAX_COOLDOWN_MS = 15 * 60_000;

function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

function isTransientError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === "AbortError") return false; // caller-initiated abort
    if (error.name === "TimeoutError" || /fetch|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR|timeout|timed out/i.test(error.message)) {
      return true;
    }
  }
  if (error instanceof XMemoClientError && error.status !== undefined) {
    return isTransientStatus(error.status);
  }
  return false;
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.min(Math.max(0, dateMs - Date.now()), MAX_RETRY_AFTER_MS);
}

function jitteredRetryDelay(baseDelayMs: number, retryAfterMs?: number): number {
  const jittered = Math.floor(baseDelayMs * (0.5 + Math.random()));
  return Math.max(jittered, retryAfterMs ?? 0);
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

type CircuitBreakerState = "closed" | "open" | "half-open";

type CircuitBreakerPermit = { probe: boolean };

/** A per-service/auth breaker with one concurrent half-open probe. */
class CircuitBreaker {
  private consecutiveFailures = 0;
  private openUntil = 0;
  private halfOpenProbeInFlight = false;
  private openCycles = 0;

  get state(): CircuitBreakerState {
    if (this.consecutiveFailures < BREAKER_THRESHOLD) return "closed";
    return Date.now() < this.openUntil ? "open" : "half-open";
  }

  get failures(): number {
    return this.consecutiveFailures;
  }

  isOpen(): boolean {
    return this.state === "open" || (this.state === "half-open" && this.halfOpenProbeInFlight);
  }

  acquire(): CircuitBreakerPermit | null {
    const state = this.state;
    if (state === "open") return null;
    if (state === "half-open") {
      if (this.halfOpenProbeInFlight) return null;
      this.halfOpenProbeInFlight = true;
      return { probe: true };
    }
    return { probe: false };
  }

  recordSuccess(_permit: CircuitBreakerPermit): void {
    this.consecutiveFailures = 0;
    this.openUntil = 0;
    this.halfOpenProbeInFlight = false;
    this.openCycles = 0;
  }

  recordFailure(permit: CircuitBreakerPermit, retryAfterMs?: number): void {
    const state = this.state;
    this.consecutiveFailures++;
    if (permit.probe || state === "half-open") {
      this.open(retryAfterMs);
      return;
    }
    if (this.consecutiveFailures >= BREAKER_THRESHOLD && state !== "open") {
      this.open(retryAfterMs);
    } else if (state === "open" && retryAfterMs !== undefined) {
      this.openUntil = Math.max(this.openUntil, Date.now() + retryAfterMs);
    }
  }

  release(permit: CircuitBreakerPermit): void {
    if (permit.probe) this.halfOpenProbeInFlight = false;
  }

  reset(): void {
    this.consecutiveFailures = 0;
    this.openUntil = 0;
    this.halfOpenProbeInFlight = false;
    this.openCycles = 0;
  }

  private open(retryAfterMs?: number): void {
    this.consecutiveFailures = Math.max(this.consecutiveFailures, BREAKER_THRESHOLD);
    this.halfOpenProbeInFlight = false;
    this.openCycles++;
    const baseDelay = Math.min(BREAKER_COOLDOWN_MS * 2 ** (this.openCycles - 1), BREAKER_MAX_COOLDOWN_MS);
    const jittered = Math.floor(baseDelay * (0.8 + Math.random() * 0.4));
    this.openUntil = Date.now() + Math.max(jittered, retryAfterMs ?? 0);
  }
}

/**
 * Registry shared by clients, with one independent breaker per service and auth
 * context. The aggregate methods remain for test reset/diagnostic compatibility.
 */
class CircuitBreakerRegistry {
  private readonly byContext = new Map<string, CircuitBreaker>();

  forContext(baseUrl: string, authMode: XMemoAuthMode, apiKey: string): CircuitBreaker {
    const service = normalizedServiceAddress(baseUrl);
    const credential = createHash("sha256").update(apiKey).digest("hex");
    const key = createHash("sha256").update(`${service}\0${authMode}\0${credential}`).digest("hex");
    let breaker = this.byContext.get(key);
    if (!breaker) {
      breaker = new CircuitBreaker();
      this.byContext.set(key, breaker);
    }
    return breaker;
  }

  get state(): CircuitBreakerState {
    const states = Array.from(this.byContext.values(), (breaker) => breaker.state);
    if (states.includes("open")) return "open";
    if (states.includes("half-open")) return "half-open";
    return "closed";
  }

  get consecutiveFailures(): number {
    return Array.from(this.byContext.values()).reduce((total, breaker) => total + breaker.failures, 0);
  }

  isOpen(): boolean {
    return Array.from(this.byContext.values()).some((breaker) => breaker.isOpen());
  }

  /** Reset every context between tests; not used by production request paths. */
  recordSuccess(): void {
    for (const breaker of this.byContext.values()) breaker.reset();
  }

  recordFailure(): void {
    const legacy = this.forContext("https://legacy-breaker.invalid", "api-key", "");
    const permit = legacy.acquire();
    if (permit) legacy.recordFailure(permit);
  }
}

function normalizedServiceAddress(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    url.hash = "";
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    return baseUrl.trim().replace(/\/+$/, "");
  }
}

const globalBreaker = new CircuitBreakerRegistry();

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
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly agentId: string,
    private readonly agentInstanceId: string,
    private readonly authMode: XMemoAuthMode = "api-key",
  ) {
    this.breaker = globalBreaker.forContext(baseUrl, authMode, apiKey);
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  get circuitBreakerState(): CircuitBreakerState {
    return this.breaker.state;
  }

  isCircuitOpen(): boolean {
    return this.breaker.isOpen();
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
    const permit = this.breaker.acquire();
    if (!permit) {
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
    let backoffMs = DEFAULT_INITIAL_DELAY_MS;
    let lastError: unknown;
    let retryAfterMs: number | undefined;

    try {
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
            const error = new XMemoClientError(
              redactErrorMessage(`XMemo ${pathname} failed (${response.status}): ${text}`, this.apiKey),
              response.status,
              pathname,
            );

            if (isTransientStatus(response.status)) {
              retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
              if (attempt < maxAttempts) {
                await sleep(jitteredRetryDelay(backoffMs, retryAfterMs), options.signal as AbortSignal | undefined);
                backoffMs = Math.min(backoffMs * DEFAULT_BACKOFF_FACTOR, MAX_RETRY_DELAY_MS);
                continue;
              }
            }
            throw error;
          }

          const contentType = response.headers.get("content-type") ?? "";
          const result = contentType.includes("application/json") ? await response.json() as T : {} as T;
          this.breaker.recordSuccess(permit);
          return result;
        } catch (error) {
          lastError = error;
          if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
            throw error;
          }

          if (isTransientError(error) && attempt < maxAttempts) {
            await sleep(jitteredRetryDelay(backoffMs, retryAfterMs), options.signal as AbortSignal | undefined);
            backoffMs = Math.min(backoffMs * DEFAULT_BACKOFF_FACTOR, MAX_RETRY_DELAY_MS);
            continue;
          }
          if (error instanceof XMemoClientError) throw error;

          const message = error instanceof Error ? error.message : String(error);
          throw new XMemoClientError(
            redactErrorMessage(`XMemo ${pathname} failed: ${message}`, this.apiKey),
            undefined,
            pathname,
          );
        }
      }

      if (lastError instanceof XMemoClientError) throw lastError;
      const message = lastError instanceof Error ? lastError.message : String(lastError);
      throw new XMemoClientError(
        redactErrorMessage(`XMemo ${pathname} failed after ${maxAttempts} attempts: ${message}`, this.apiKey),
        undefined,
        pathname,
      );
    } catch (error) {
      if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        this.breaker.release(permit);
      } else if (isTransientError(error)) {
        this.breaker.recordFailure(permit, retryAfterMs);
      } else {
        this.breaker.release(permit);
      }
      throw error;
    }
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
      memory_type: request.memory_type,
      status: request.status,
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
      const explain = await this.request<any>(
        `/v1/memories/${encodeURIComponent(id)}/explain?include_embedding=false`,
        { method: "GET", signal },
      );
      if (explain && typeof explain.content === "string") {
        if (explain.status && String(explain.status).toLowerCase() === "deleted") {
          throw new XMemoClientError("Memory not found", 404);
        }
        return {
          id: explain.id || explain.memory_id || id,
          content: explain.content,
          path: explain.path,
          bucket: explain.bucket,
          scope: explain.scope,
          memory_type: explain.memory_type,
          status: explain.status,
          updated_at: explain.updated_at,
          created_at: explain.created_at,
        };
      }
      throw new XMemoClientError("Memory not found", 404);
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
          status: "active",
          max_items: 5,
        },
        signal,
      );
      const match = search.results.find((r) => r.id === id && (!r.status || r.status.toLowerCase() !== "deleted"));
      if (match && typeof match.content === "string") {
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
    const response = await this.request<XMemoReminderEnvelope>("/v1/reminders", {
      method: "POST",
      body: JSON.stringify(request),
      signal,
    });
    return unwrapReminder(response);
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
    const response = await this.request<XMemoReminderEnvelope>(`/v1/reminders/${encodeURIComponent(id)}/complete`, {
      method: "POST",
      body: JSON.stringify({}),
      signal,
    });
    return unwrapReminder(response);
  }

  async recordEvent(
    request: XMemoTimelineEventRequest,
    signal?: AbortSignal,
  ): Promise<XMemoTimelineEvent> {
    const response = await this.request<XMemoTimelineEventEnvelope>("/v1/timeline/events", {
      method: "POST",
      body: JSON.stringify(request),
      signal,
    });
    return unwrapTimelineEvent(response);
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
    const args: Record<string, unknown> = {};

    let effectiveMonths: number | undefined;
    if (typeof params?.months === "number" && Number.isInteger(params.months)) {
      effectiveMonths = params.months;
    } else if (typeof params?.month === "number" || typeof params?.year === "number") {
      const now = new Date();
      const targetYear = typeof params?.year === "number" ? params.year : now.getFullYear();
      const targetMonth = typeof params?.month === "number" ? params.month : now.getMonth() + 1;
      const diff = (now.getFullYear() - targetYear) * 12 + (now.getMonth() + 1 - targetMonth);
      effectiveMonths = Math.max(1, Math.min(24, diff + 1));
    } else {
      effectiveMonths = 6;
    }

    if (effectiveMonths !== undefined) {
      args.months = Math.max(1, Math.min(24, effectiveMonths));
    }
    if (typeof params?.currency === "string" && params.currency.trim()) {
      args.currency = params.currency.trim().toUpperCase();
    }
    if (typeof params?.transaction_type === "string" && params.transaction_type.trim()) {
      args.transaction_type = params.transaction_type.trim().toLowerCase();
    }

    const payload = {
      operation: "ledger-summary",
      arguments: args,
    };

    const res = await this.request<unknown>("/v1/skill/operations", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "application/json",
      },
      signal,
    });

    return unwrapLedgerMonthlySummary(res);
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
