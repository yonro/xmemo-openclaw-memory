import type { XMemoMemoryConfig } from "./config.js";
import { resolveLocalVaultPath, LocalMemoryKernel, type TrustedLocalIdentityContext } from "./local/kernel.js";
import type {
  XMemoClient,
  XMemoForgetMemoryRequest,
  XMemoMemory,
  XMemoRecallContextRequest,
  XMemoSearchMemoryRequest,
  XMemoUpdateMemoryRequest,
} from "./client.js";
import { LocalKernelError, type LocalHardDeleteReceipt, type LocalRecord, type LocalSoftDeleteInput, type LocalUpdateInput, type LocalWriteReceipt } from "./local/kernel.js";
import type { ResilientXMemoClient, ResilientWriteResult } from "./resilient-client.js";

export const HYBRID_UNAVAILABLE_MESSAGE = "XMemo capability_unavailable: hybrid mode is not implemented.";

export class CapabilityUnavailableError extends Error {
  readonly category = "capability_unavailable";

  constructor(message = HYBRID_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = "CapabilityUnavailableError";
  }
}

export type LocalSearchRecord = LocalRecord & { rank: number };

/** Cloud adapter that preserves the existing HTTP client and resilient-cache/outbox path. */
export class CloudProvider {
  constructor(
    private readonly client: XMemoClient,
    private readonly resilient?: ResilientXMemoClient,
  ) {}

  isConfigured(): boolean {
    return this.client.isConfigured();
  }

  validateToken(signal?: AbortSignal): Promise<unknown> {
    return this.client.validateToken(signal);
  }

  get circuitBreakerState(): "closed" | "open" | "half-open" {
    return this.resilient?.circuitBreakerState ?? "closed";
  }

  recallContext(
    query: string,
    options: Parameters<ResilientXMemoClient["recallContext"]>[1],
    signal?: AbortSignal,
  ): Promise<{ result: unknown; fromCache: boolean; isFresh: boolean }> {
    if (!this.resilient) throw new Error("XMemo cloud provider is not configured.");
    return this.resilient.recallContext(query, options, signal);
  }

  searchMemory(
    query: string,
    options: Parameters<ResilientXMemoClient["searchMemory"]>[1],
    signal?: AbortSignal,
  ): Promise<{ result: unknown; fromCache: boolean; isFresh: boolean }> {
    if (!this.resilient) throw new Error("XMemo cloud provider is not configured.");
    return this.resilient.searchMemory(query, options, signal);
  }

  write(
    operation: string,
    endpoint: string,
    method: string,
    payload: Record<string, unknown>,
    apiFn: (idempotencyKey: string) => Promise<unknown>,
  ): Promise<ResilientWriteResult> {
    if (!this.resilient) throw new Error("XMemo cloud provider is not configured.");
    return this.resilient.resilientWrite(operation, endpoint, method, payload, apiFn);
  }

  replayWrite(endpoint: string, method: string, payload: Record<string, unknown>, idempotencyKey: string, signal?: AbortSignal) {
    if (!this.resilient) throw new Error("XMemo cloud provider is not configured.");
    return this.resilient.rawClient.replayWrite(endpoint, method, payload, idempotencyKey, signal);
  }

  cloudRecall(request: XMemoRecallContextRequest, signal?: AbortSignal) {
    return this.client.recallContext(request, signal);
  }

  cloudSearch(request: XMemoSearchMemoryRequest, signal?: AbortSignal) {
    return this.client.searchMemory(request, signal);
  }

  getMemoryDirect(id: string, signal?: AbortSignal): Promise<XMemoMemory> {
    return this.client.getMemoryDirect(id, signal);
  }

  getMemory(id: string, signal?: AbortSignal): Promise<XMemoMemory> {
    return this.client.getMemory(id, signal);
  }

  updateMemory(id: string, request: XMemoUpdateMemoryRequest, signal?: AbortSignal): Promise<XMemoMemory> {
    return this.client.updateMemory(id, request, signal);
  }

  forgetMemory(id: string, request?: XMemoForgetMemoryRequest, signal?: AbortSignal): Promise<unknown> {
    if (this.resilient) return this.resilient.forgetMemory(id, request, signal);
    return this.client.forgetMemory(id, request, signal);
  }

  invalidateCache(filters: { bucket?: string; scope?: string | null; teamId?: string | null }): void {
    this.resilient?.invalidateCache(filters);
  }

  stopOutboxSync(): void {
    this.resilient?.stopOutboxSync();
  }
}

/** Local adapter bound to one trusted host identity for the duration of a request. */
export class LocalProvider {
  constructor(
    private readonly kernel: LocalMemoryKernel,
    private readonly identity: TrustedLocalIdentityContext,
  ) {}

  get identityContext(): TrustedLocalIdentityContext {
    return this.identity;
  }

  search(query: string, limit: number, identity = this.identity): Promise<LocalSearchRecord[]> {
    return this.kernel.search(query, identity, limit);
  }

  get(id: string): Promise<LocalRecord> {
    return this.kernel.get(id, this.identity);
  }

  create(input: { body: string; title?: string; metadata?: Record<string, unknown> }): Promise<LocalWriteReceipt> {
    return this.kernel.create(input, this.identity);
  }

  update(id: string, input: LocalUpdateInput): Promise<LocalWriteReceipt> {
    return this.kernel.update(id, input, this.identity);
  }

  async forget(
    id: string,
    mode: "soft_delete" | "hard_delete" | "redact",
  ): Promise<LocalWriteReceipt | LocalHardDeleteReceipt> {
    const current = await this.kernel.get(id, this.identity);
    const baseRevision = current.revision.revisionId;
    if (mode === "soft_delete") {
      const input: LocalSoftDeleteInput = { baseRevision };
      return this.kernel.softDelete(id, input, this.identity);
    }
    if (mode === "hard_delete") {
      return this.kernel.hardDelete(id, { baseRevision }, this.identity);
    }
    return this.kernel.redact(id, { baseRevision, fields: ["title", "body"] }, this.identity);
  }
}

/** Mode gate and the single domain boundary consumed by tools and SearchManager. */
export class MemoryService {
  constructor(
    readonly config: XMemoMemoryConfig,
    readonly cloud: CloudProvider | undefined,
    readonly local: LocalProvider | undefined,
  ) {}

  get mode(): XMemoMemoryConfig["mode"] {
    return this.config.mode;
  }

  get isConfigured(): boolean {
    return this.mode === "local" ? Boolean(this.local) : Boolean(this.cloud?.isConfigured());
  }

  get circuitBreakerState(): "closed" | "open" | "half-open" {
    return this.cloud?.circuitBreakerState ?? "closed";
  }

  get localIdentityContext(): TrustedLocalIdentityContext | undefined {
    return this.local?.identityContext;
  }

  /** Search used by the OpenClaw host MemorySearchManager in cloud mode. */
  cloudHostRecall(request: XMemoRecallContextRequest, signal?: AbortSignal) {
    return this.cloudProvider().cloudRecall(request, signal);
  }

  validateCloud(signal?: AbortSignal): Promise<unknown> {
    return this.cloudProvider().validateToken(signal);
  }

  private cloudProvider(): CloudProvider {
    if (this.mode === "hybrid") throw new CapabilityUnavailableError();
    if (this.mode !== "cloud" || !this.cloud) throw new CapabilityUnavailableError("XMemo capability_unavailable: cloud provider is unavailable in local mode.");
    return this.cloud;
  }

  private localProvider(): LocalProvider {
    if (this.mode === "hybrid") throw new CapabilityUnavailableError();
    if (this.mode !== "local" || !this.local) throw new CapabilityUnavailableError("XMemo capability_unavailable: local provider is unavailable in cloud mode.");
    return this.local;
  }

  recallContext(query: string, options: Parameters<ResilientXMemoClient["recallContext"]>[1], signal?: AbortSignal) {
    return this.cloudProvider().recallContext(query, options, signal);
  }

  searchMemory(query: string, options: Parameters<ResilientXMemoClient["searchMemory"]>[1], signal?: AbortSignal) {
    return this.cloudProvider().searchMemory(query, options, signal);
  }

  write(operation: string, endpoint: string, method: string, payload: Record<string, unknown>, apiFn: (idempotencyKey: string) => Promise<unknown>) {
    return this.cloudProvider().write(operation, endpoint, method, payload, apiFn);
  }

  replayWrite(endpoint: string, method: string, payload: Record<string, unknown>, idempotencyKey: string, signal?: AbortSignal) {
    return this.cloudProvider().replayWrite(endpoint, method, payload, idempotencyKey, signal);
  }

  cloudRecall(request: XMemoRecallContextRequest, signal?: AbortSignal) {
    return this.cloudProvider().cloudRecall(request, signal);
  }

  cloudSearch(request: XMemoSearchMemoryRequest, signal?: AbortSignal) {
    return this.cloudProvider().cloudSearch(request, signal);
  }

  getMemoryDirect(id: string, signal?: AbortSignal) {
    return this.cloudProvider().getMemoryDirect(id, signal);
  }

  getMemory(id: string, signal?: AbortSignal) {
    return this.cloudProvider().getMemory(id, signal);
  }

  updateMemory(id: string, request: XMemoUpdateMemoryRequest, signal?: AbortSignal) {
    return this.cloudProvider().updateMemory(id, request, signal);
  }

  forgetMemory(id: string, request?: XMemoForgetMemoryRequest, signal?: AbortSignal) {
    return this.cloudProvider().forgetMemory(id, request, signal);
  }

  invalidateCache(filters: { bucket?: string; scope?: string | null; teamId?: string | null }): void {
    this.cloudProvider().invalidateCache(filters);
  }

  localSearch(query: string, limit: number, identity?: TrustedLocalIdentityContext): Promise<LocalSearchRecord[]> {
    return this.localProvider().search(query, limit, identity);
  }

  localGet(id: string): Promise<LocalRecord> {
    return this.localProvider().get(id);
  }

  localCreate(input: { body: string; title?: string; metadata?: Record<string, unknown> }): Promise<LocalWriteReceipt> {
    return this.localProvider().create(input);
  }

  localUpdate(id: string, input: LocalUpdateInput): Promise<LocalWriteReceipt> {
    return this.localProvider().update(id, input);
  }

  localForget(id: string, mode: "soft_delete" | "hard_delete" | "redact") {
    return this.localProvider().forget(id, mode);
  }
}

export function isLocalIdentityError(error: unknown): error is LocalKernelError {
  return error instanceof LocalKernelError && error.category === "identity_denied";
}

export type TrustedHostIdentity = {
  agentId?: string | null;
  sessionKey?: string | null;
  requesterSenderId?: string | null;
};

export function trustedLocalIdentity(
  host: TrustedHostIdentity | undefined,
  configuredAgentId: string,
): TrustedLocalIdentityContext {
  const sessionKey = typeof host?.sessionKey === "string" ? host.sessionKey.trim() : "";
  const groupSession = /:(group|channel):/i.test(sessionKey);
  if (groupSession) {
    return {
      kind: "group",
      actorRef: typeof host?.requesterSenderId === "string" ? host.requesterSenderId.trim() : "",
      roomRef: sessionKey,
      // No group-sharing configuration is accepted in this slice. Group content
      // therefore remains private to the trusted speaker by default.
      groupOptIn: false,
    };
  }
  const directPeer = directPeerFromSession(sessionKey);
  const hasDirectMarker = /:(direct|dm)(:|$)/i.test(sessionKey);
  const senderRef = typeof host?.requesterSenderId === "string" ? host.requesterSenderId.trim() : "";
  const agentRef = typeof host?.agentId === "string" ? host.agentId.trim() : "";
  const actorRef = senderRef || directPeer || (hasDirectMarker ? "" : agentRef || configuredAgentId);
  return {
    kind: "direct",
    actorRef,
  };
}

function directPeerFromSession(sessionKey: string): string | undefined {
  const parts = sessionKey.split(":").filter(Boolean);
  const directIndex = parts.findIndex((part) => part.toLowerCase() === "direct" || part.toLowerCase() === "dm");
  if (directIndex < 0 || directIndex >= parts.length - 1) return undefined;
  const peerParts = parts.slice(directIndex + 1);
  const threadIndex = peerParts.findIndex((part) => part.toLowerCase() === "thread");
  const peer = (threadIndex >= 0 ? peerParts.slice(0, threadIndex) : peerParts).join(":").trim();
  return peer || undefined;
}

const sharedLocalKernels = new Map<string, Promise<LocalMemoryKernel>>();

export function getSharedLocalKernel(): Promise<LocalMemoryKernel> {
  const path = resolveLocalVaultPath();
  let kernel = sharedLocalKernels.get(path);
  if (!kernel) {
    kernel = LocalMemoryKernel.open({ databasePath: path });
    sharedLocalKernels.set(path, kernel);
  }
  return kernel;
}

export async function closeSharedLocalKernels(): Promise<void> {
  const kernels = await Promise.all(sharedLocalKernels.values());
  sharedLocalKernels.clear();
  await Promise.all(kernels.map((kernel) => kernel.close().catch(() => undefined)));
}
