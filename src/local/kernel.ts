import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { sanitizeUntrustedMemoryMetadata } from "../identity-scope.js";

export type LocalErrorCategory =
  | "storage_busy"
  | "storage_full"
  | "corrupt_store"
  | "conflict"
  | "validation"
  | "not_found"
  | "identity_denied"
  | "unsupported_schema_version"
  | "worker_failure";

export type TrustedLocalIdentityContext = {
  /** Host-derived identity only. Never copy this value from request text or metadata. */
  kind: "direct" | "group";
  actorRef: string;
  /** Required for group messages and ignored for direct messages. */
  roomRef?: string;
  /** A group is shared only after explicit room opt-in and a configured collection. */
  groupOptIn?: boolean;
  groupCollectionRef?: string;
};

export type LocalRecordInput = {
  recordId?: string;
  body: string;
  title?: string;
  metadata?: Record<string, unknown>;
  operationId?: string;
};

export type LocalUpdateInput = {
  body: string;
  title?: string;
  metadata?: Record<string, unknown>;
  /** Omit only for a legacy unversioned write, which is marked in the receipt. */
  baseRevision?: string | null;
  operationId?: string;
};

export type LocalSoftDeleteInput = {
  baseRevision?: string | null;
  operationId?: string;
};

export type LocalRevision = {
  revisionId: string;
  parents: string[];
  baseRevision: string | null;
  operationId: string;
  contentHash: string;
};

export type LocalRecord = {
  recordId: string;
  origin: "local";
  authority: "local";
  ownerRef: string;
  collectionRef: string;
  bindingId: null;
  localRevision: number;
  revision: LocalRevision;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type LocalConflict = {
  category: "conflict";
  message: string;
  baseRevision: string;
  acceptedRevisionId: string;
  conflictRevisionId: string;
};

export type LocalWriteReceipt = {
  operationId: string;
  recordId: string;
  localRevision: number;
  revisionId: string;
  storageStatus: "committed_local";
  syncStatus: "local_only";
  indexStatus: "ready";
  writeKind: "created" | "versioned_update" | "unversioned_write" | "soft_deleted" | "conflict";
  error: LocalConflict | null;
};

export type LocalErrorReceipt = {
  operationId?: string;
  recordId?: string;
  storageStatus: "not_committed" | "unknown";
  syncStatus: "local_only";
  indexStatus: "unchanged" | "unknown";
  error: { category: LocalErrorCategory; message: string };
};

export class LocalKernelError extends Error {
  readonly category: LocalErrorCategory;
  readonly receipt: LocalErrorReceipt;

  constructor(receipt: LocalErrorReceipt) {
    super(receipt.error.message);
    this.name = "LocalKernelError";
    this.category = receipt.error.category;
    this.receipt = receipt;
  }
}

export type LocalMemoryKernelOptions = {
  /** Override the existing XMemo data directory for tests or host-controlled storage. */
  dataDirectory?: string;
  /** Override the database file directly for controlled probes. */
  databasePath?: string;
  /** Maximum SQLite lock wait; SQLite returns storage_busy after this bound. */
  busyTimeoutMs?: number;
};

export function resolveLocalVaultPath(options: Pick<LocalMemoryKernelOptions, "dataDirectory" | "databasePath"> = {}): string {
  if (options.databasePath) return resolve(options.databasePath);
  const baseDirectory = options.dataDirectory ?? (() => {
    const openClawData = process.env.OPENCLAW_DATA_DIR;
    if (openClawData) return join(openClawData, "xmemo");
    const xdgData = process.env.XDG_DATA_HOME;
    if (xdgData) return join(xdgData, "xmemo");
    return join(homedir(), ".xmemo");
  })();
  return join(resolve(baseDirectory), "local-vault.sqlite");
}

type Scope = { ownerRef: string; collectionRef: string };

function opaqueRef(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deriveScope(vaultId: string, context: TrustedLocalIdentityContext | undefined): Scope {
  if (!context || (context.kind !== "direct" && context.kind !== "group")) {
    throw new LocalKernelError({
      storageStatus: "not_committed",
      syncStatus: "local_only",
      indexStatus: "unchanged",
      error: { category: "identity_denied", message: "A trusted local identity context is required." },
    });
  }

  const actorRef = typeof context.actorRef === "string" ? context.actorRef.trim() : "";
  if (!actorRef) {
    throw new LocalKernelError({
      storageStatus: "not_committed",
      syncStatus: "local_only",
      indexStatus: "unchanged",
      error: { category: "identity_denied", message: "The trusted local actor identity is missing." },
    });
  }

  if (context.kind === "direct") {
    return {
      ownerRef: `actor:${opaqueRef(`${vaultId}\0${actorRef}`)}`,
      collectionRef: "direct:private",
    };
  }

  const roomRef = typeof context.roomRef === "string" ? context.roomRef.trim() : "";
  if (!roomRef) {
    throw new LocalKernelError({
      storageStatus: "not_committed",
      syncStatus: "local_only",
      indexStatus: "unchanged",
      error: { category: "identity_denied", message: "A trusted group room identity is required." },
    });
  }

  if (context.groupOptIn === true) {
    const groupCollectionRef = typeof context.groupCollectionRef === "string"
      ? context.groupCollectionRef.trim()
      : "";
    if (!groupCollectionRef) {
      throw new LocalKernelError({
        storageStatus: "not_committed",
        syncStatus: "local_only",
        indexStatus: "unchanged",
        error: { category: "identity_denied", message: "Group sharing requires a configured collection." },
      });
    }
    return {
      ownerRef: `vault:${vaultId}`,
      collectionRef: `group:${opaqueRef(`${roomRef}\0${groupCollectionRef}`)}`,
    };
  }

  return {
    ownerRef: `actor:${opaqueRef(`${vaultId}\0${actorRef}`)}`,
    collectionRef: `group-private:${opaqueRef(roomRef)}`,
  };
}

function serializeMetadata(metadata: Record<string, unknown> | undefined): string {
  if (metadata !== undefined && (!metadata || typeof metadata !== "object" || Array.isArray(metadata))) {
    throw new LocalKernelError({
      storageStatus: "not_committed",
      syncStatus: "local_only",
      indexStatus: "unchanged",
      error: { category: "validation", message: "Metadata must be a JSON object." },
    });
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(JSON.stringify(metadata ?? {})) as Record<string, unknown>;
  } catch {
    throw new LocalKernelError({
      storageStatus: "not_committed",
      syncStatus: "local_only",
      indexStatus: "unchanged",
      error: { category: "validation", message: "Metadata must contain JSON-serializable values." },
    });
  }
  return JSON.stringify(sanitizeUntrustedMemoryMetadata(parsed));
}

type WorkerReady = { type: "ready"; vaultId: string; schemaVersion: number };
type WorkerFailure = {
  category: LocalErrorCategory;
  message: string;
  receipt?: LocalErrorReceipt;
};
type WorkerResponse =
  | WorkerReady
  | { type: "fatal"; error: WorkerFailure }
  | { type: "response"; id: number; value?: unknown; error?: WorkerFailure };

type PendingRequest = { resolve(value: unknown): void; reject(error: Error): void };

function errorFromWire(error: WorkerFailure): LocalKernelError {
  return new LocalKernelError(error.receipt ?? {
    storageStatus: "not_committed",
    syncStatus: "local_only",
    indexStatus: "unchanged",
    error: { category: error.category, message: error.message },
  });
}

export class LocalMemoryKernel {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly readyPromise: Promise<void>;
  private vaultIdValue = "";
  private nextRequestId = 1;
  private closed = false;
  private failed: Error | undefined;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;

  private constructor(worker: Worker) {
    this.worker = worker;
    this.readyPromise = new Promise<void>((resolveReady, rejectReady) => {
      this.resolveReady = resolveReady;
      this.rejectReady = rejectReady;
    });
    this.worker.on("message", (raw: WorkerResponse) => {
      if (raw.type === "ready") {
        this.vaultIdValue = raw.vaultId;
        this.resolveReady();
        return;
      }
      if (raw.type === "fatal") {
        this.fail(errorFromWire(raw.error));
        return;
      }
      const pending = this.pending.get(raw.id);
      if (!pending) return;
      this.pending.delete(raw.id);
      if (raw.error) pending.reject(errorFromWire(raw.error));
      else pending.resolve(raw.value);
    });
    this.worker.on("error", () => this.fail(new LocalKernelError({
      storageStatus: "unknown",
      syncStatus: "local_only",
      indexStatus: "unknown",
      error: { category: "worker_failure", message: "Local storage worker crashed; the operation outcome may be unknown." },
    })));
    this.worker.on("exit", (code: number) => {
      if (this.closed || this.failed) return;
      this.fail(new LocalKernelError({
        storageStatus: "unknown",
        syncStatus: "local_only",
        indexStatus: "unknown",
        error: { category: "worker_failure", message: `Local storage worker exited unexpectedly (${code}); operation outcome may be unknown.` },
      }));
    });
  }

  static async open(options: LocalMemoryKernelOptions = {}): Promise<LocalMemoryKernel> {
    const databasePath = resolveLocalVaultPath(options);
    const busyTimeoutMs = options.busyTimeoutMs ?? 250;
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 30_000) {
      throw new LocalKernelError({
        storageStatus: "not_committed",
        syncStatus: "local_only",
        indexStatus: "unchanged",
        error: { category: "validation", message: "busyTimeoutMs must be between 1 and 30000." },
      });
    }
    const worker = new Worker(new URL("./sqlite-worker.mjs", import.meta.url), {
      workerData: { databasePath, busyTimeoutMs },
    });
    const kernel = new LocalMemoryKernel(worker);
    try {
      await kernel.readyPromise;
      return kernel;
    } catch (error) {
      await worker.terminate();
      throw error;
    }
  }

  get vaultId(): string {
    return this.vaultIdValue;
  }

  async create(input: LocalRecordInput, identity: TrustedLocalIdentityContext): Promise<LocalWriteReceipt> {
    await this.readyPromise;
    const scope = deriveScope(this.vaultId, identity);
    const operationId = input.operationId ?? randomUUID();
    const metadataJson = serializeMetadata(input.metadata);
    return await this.request<LocalWriteReceipt>("create", {
      operationId,
      recordId: input.recordId,
      body: input.body,
      title: input.title ?? "",
      metadataJson,
      scope,
    });
  }

  async get(recordId: string, identity: TrustedLocalIdentityContext): Promise<LocalRecord> {
    await this.readyPromise;
    return await this.request<LocalRecord>("get", {
      recordId,
      scope: deriveScope(this.vaultId, identity),
    });
  }

  async update(
    recordId: string,
    input: LocalUpdateInput,
    identity: TrustedLocalIdentityContext,
  ): Promise<LocalWriteReceipt> {
    await this.readyPromise;
    const scope = deriveScope(this.vaultId, identity);
    const operationId = input.operationId ?? randomUUID();
    const metadataJson = serializeMetadata(input.metadata);
    return await this.request<LocalWriteReceipt>("update", {
      operationId,
      recordId,
      body: input.body,
      title: input.title ?? "",
      metadataJson,
      baseRevision: input.baseRevision ?? null,
      scope,
    });
  }

  async softDelete(
    recordId: string,
    input: LocalSoftDeleteInput,
    identity: TrustedLocalIdentityContext,
  ): Promise<LocalWriteReceipt> {
    await this.readyPromise;
    return await this.request<LocalWriteReceipt>("softDelete", {
      operationId: input.operationId ?? randomUUID(),
      recordId,
      baseRevision: input.baseRevision ?? null,
      scope: deriveScope(this.vaultId, identity),
    });
  }

  async search(
    query: string,
    identity: TrustedLocalIdentityContext,
    limit = 20,
  ): Promise<Array<LocalRecord & { rank: number }>> {
    await this.readyPromise;
    return await this.request<Array<LocalRecord & { rank: number }>>("search", {
      query,
      limit,
      scope: deriveScope(this.vaultId, identity),
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.failed) {
      this.closed = true;
      await this.worker.terminate();
      return;
    }
    await this.readyPromise;
    await this.request<void>("close", {});
    this.closed = true;
    await this.worker.terminate();
  }

  private async request<T>(operation: string, payload: Record<string, unknown>): Promise<T> {
    await this.readyPromise;
    if (this.failed) throw this.failed;
    if (this.closed) {
      throw new LocalKernelError({
        storageStatus: "not_committed",
        syncStatus: "local_only",
        indexStatus: "unchanged",
        error: { category: "validation", message: "Local memory kernel is closed." },
      });
    }
    const id = this.nextRequestId++;
    return await new Promise<T>((resolveRequest, rejectRequest) => {
      this.pending.set(id, {
        resolve: value => resolveRequest(value as T),
        reject: rejectRequest,
      });
      try {
        this.worker.postMessage({ type: "request", id, operation, payload });
      } catch (error) {
        this.pending.delete(id);
        rejectRequest(new LocalKernelError({
          storageStatus: "not_committed",
          syncStatus: "local_only",
          indexStatus: "unchanged",
          error: { category: "validation", message: error instanceof Error ? error.message : "Request could not be sent to the storage worker." },
        }));
      }
    });
  }

  private fail(error: Error): void {
    if (this.failed) return;
    this.failed = error;
    this.rejectReady(error);
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}
