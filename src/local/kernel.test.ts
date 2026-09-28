import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LocalMemoryKernel,
  resolveLocalVaultPath,
  type TrustedLocalIdentityContext,
} from "./kernel.js";

const directAlice: TrustedLocalIdentityContext = { kind: "direct", actorRef: "alice" };
const directBob: TrustedLocalIdentityContext = { kind: "direct", actorRef: "bob" };

const dataDirectories: string[] = [];
const kernels: LocalMemoryKernel[] = [];

async function createKernel(options: { dataDirectory?: string; busyTimeoutMs?: number } = {}): Promise<LocalMemoryKernel> {
  const dataDirectory = options.dataDirectory ?? await mkdtemp(join(tmpdir(), "xmemo-local-kernel-"));
  if (!dataDirectories.includes(dataDirectory)) dataDirectories.push(dataDirectory);
  const kernel = await LocalMemoryKernel.open({ dataDirectory, busyTimeoutMs: options.busyTimeoutMs });
  kernels.push(kernel);
  return kernel;
}

afterEach(async () => {
  for (const kernel of kernels.splice(0)) await kernel.close().catch(() => {});
  for (const directory of dataDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("isolated local SQLite kernel", () => {
  it("opens and performs keyless CRUD without depending on API-key changes", async () => {
    vi.stubEnv("XMEMO_API_KEY", undefined);
    const dataDirectory = await mkdtemp(join(tmpdir(), "xmemo-vault-id-"));
    dataDirectories.push(dataDirectory);
    const first = await createKernel({ dataDirectory });
    const firstVaultId = first.vaultId;
    const created = await first.create({ body: "keyless local memory" }, directAlice);
    const readBack = await first.get(created.recordId, directAlice);
    expect(readBack.body).toBe("keyless local memory");
    await first.close();

    vi.stubEnv("XMEMO_API_KEY", "rotated-cloud-key-must-not-change-vault");
    const second = await createKernel({ dataDirectory });
    expect(second.vaultId).toBe(firstVaultId);
    expect(resolveLocalVaultPath({ dataDirectory })).toBe(join(dataDirectory, "local-vault.sqlite"));
  });

  it("records local authority, null binding, revision metadata, and a durable success receipt", async () => {
    const kernel = await createKernel();
    const receipt = await kernel.create({
      body: "private local body",
      title: "Local title",
      metadata: { topic: "architecture", owner_ref: "caller-controlled-owner", collectionRef: "caller-controlled-collection" },
      operationId: "create-private-record",
    }, directAlice);

    expect(receipt).toMatchObject({
      operationId: "create-private-record",
      storageStatus: "committed_local",
      syncStatus: "local_only",
      indexStatus: "ready",
      writeKind: "created",
      error: null,
    });
    const record = await kernel.get(receipt.recordId, directAlice);
    expect(record).toMatchObject({
      origin: "local",
      authority: "local",
      bindingId: null,
      localRevision: 1,
      body: "private local body",
      title: "Local title",
      metadata: { topic: "architecture" },
      revision: {
        revisionId: receipt.revisionId,
        parents: [],
        baseRevision: null,
        operationId: "create-private-record",
      },
    });
    expect(record.ownerRef).not.toBe("caller-controlled-owner");
    expect(record.collectionRef).not.toBe("caller-controlled-collection");
    await expect(kernel.get(receipt.recordId, directBob)).rejects.toMatchObject({ category: "not_found" });
  });

  it("uses versioned updates and preserves a stale write as a non-searchable conflict branch", async () => {
    const kernel = await createKernel();
    const created = await kernel.create({ body: "common-base alpha", operationId: "create-revision-chain" }, directAlice);
    const accepted = await kernel.update(created.recordId, {
      body: "accepted current revision",
      baseRevision: created.revisionId,
      operationId: "accept-current-branch",
    }, directAlice);
    const stale = await kernel.update(created.recordId, {
      body: "stale branch unique phrase",
      baseRevision: created.revisionId,
      operationId: "preserve-stale-branch",
    }, directAlice);

    expect(accepted.writeKind).toBe("versioned_update");
    expect(stale).toMatchObject({
      writeKind: "conflict",
      storageStatus: "committed_local",
      error: {
        category: "conflict",
        baseRevision: created.revisionId,
        acceptedRevisionId: accepted.revisionId,
        conflictRevisionId: stale.revisionId,
      },
    });
    expect((await kernel.get(created.recordId, directAlice)).body).toBe("accepted current revision");
    expect(await kernel.search("stale branch unique", directAlice)).toHaveLength(0);
    expect((await kernel.search("accepted current", directAlice)).map(record => record.recordId)).toContain(created.recordId);

    const db = new DatabaseSync(resolveLocalVaultPath({ dataDirectory: dataDirectories[0] }), { readOnly: true });
    try {
      const conflict = db.prepare("SELECT parents_json, revision_state FROM revisions WHERE revision_id = ?").get(stale.revisionId);
      expect(conflict).toMatchObject({ parents_json: JSON.stringify([created.revisionId]), revision_state: "conflict" });
    } finally {
      db.close();
    }
  });

  it("labels updates without a base revision as unversioned_write", async () => {
    const kernel = await createKernel();
    const created = await kernel.create({ body: "before old-client edit" }, directAlice);
    const updated = await kernel.update(created.recordId, { body: "after old-client edit" }, directAlice);
    expect(updated).toMatchObject({ writeKind: "unversioned_write", storageStatus: "committed_local", error: null });
    const current = await kernel.get(created.recordId, directAlice);
    expect(current.body).toBe("after old-client edit");
    expect(current.revision.parents).toEqual([created.revisionId]);
  });

  it("soft deletes through a barrier and removes records from exact get and FTS in the same commit", async () => {
    const kernel = await createKernel();
    const created = await kernel.create({ body: "soft deletion searchable phrase" }, directAlice);
    const deleted = await kernel.softDelete(created.recordId, { baseRevision: created.revisionId }, directAlice);
    expect(deleted).toMatchObject({ writeKind: "soft_deleted", storageStatus: "committed_local", indexStatus: "ready", error: null });
    await expect(kernel.get(created.recordId, directAlice)).rejects.toMatchObject({ category: "not_found" });
    expect(await kernel.search("soft deletion searchable", directAlice)).toHaveLength(0);

    const db = new DatabaseSync(resolveLocalVaultPath({ dataDirectory: dataDirectories[0] }), { readOnly: true });
    try {
      expect(db.prepare("SELECT barrier_revision_id FROM deletion_barriers WHERE record_id = ?").get(created.recordId))
        .toMatchObject({ barrier_revision_id: deleted.revisionId });
      expect(db.prepare("SELECT is_deleted, revision_state FROM revisions WHERE revision_id = ?").get(deleted.revisionId))
        .toMatchObject({ is_deleted: 1, revision_state: "deleted" });
    } finally {
      db.close();
    }
  });

  it("indexes English and CJK substrings and never returns historical text", async () => {
    const kernel = await createKernel();
    const created = await kernel.create({ body: "记忆系统 supports immediate local memory search" }, directAlice);
    expect((await kernel.search("忆系统", directAlice)).map(record => record.recordId)).toContain(created.recordId);
    expect((await kernel.search("memory search", directAlice)).map(record => record.recordId)).toContain(created.recordId);

    await kernel.update(created.recordId, {
      body: "replacement revision with current searchable phrase",
      baseRevision: created.revisionId,
    }, directAlice);
    expect(await kernel.search("记忆系统", directAlice)).toHaveLength(0);
    expect((await kernel.search("current searchable", directAlice)).map(record => record.recordId)).toContain(created.recordId);
  });

  it("keeps group records private by speaker unless that room has an opted-in collection", async () => {
    const kernel = await createKernel();
    const aliceRoom: TrustedLocalIdentityContext = { kind: "group", actorRef: "alice", roomRef: "room-1" };
    const bobRoom: TrustedLocalIdentityContext = { kind: "group", actorRef: "bob", roomRef: "room-1" };
    const privateRecord = await kernel.create({ body: "speaker private group phrase" }, aliceRoom);
    expect(await kernel.search("speaker private group", bobRoom)).toHaveLength(0);
    await expect(kernel.get(privateRecord.recordId, bobRoom)).rejects.toMatchObject({ category: "not_found" });

    const aliceShared: TrustedLocalIdentityContext = {
      ...aliceRoom,
      groupOptIn: true,
      groupCollectionRef: "configured-room-collection",
    };
    const bobShared: TrustedLocalIdentityContext = {
      ...bobRoom,
      groupOptIn: true,
      groupCollectionRef: "configured-room-collection",
    };
    const sharedRecord = await kernel.create({ body: "explicit shared room phrase" }, aliceShared);
    expect((await kernel.search("explicit shared room", bobShared)).map(record => record.recordId)).toContain(sharedRecord.recordId);
  });

  it("fails closed when group speaker identity or shared collection is missing", async () => {
    const kernel = await createKernel();
    await expect(kernel.create({ body: "must not store" }, { kind: "group", actorRef: "", roomRef: "room-1" }))
      .rejects.toMatchObject({ category: "identity_denied" });
    await expect(kernel.create({ body: "must not share" }, {
      kind: "group", actorRef: "alice", roomRef: "room-1", groupOptIn: true,
    })).rejects.toMatchObject({ category: "identity_denied" });
  });

  it("replays the same operation idempotently and rejects reuse with different content", async () => {
    const kernel = await createKernel();
    const first = await kernel.create({ body: "idempotent local create", operationId: "stable-create-operation" }, directAlice);
    const replay = await kernel.create({ body: "idempotent local create", operationId: "stable-create-operation" }, directAlice);
    expect(replay).toEqual(first);
    await expect(kernel.create({ body: "different body", operationId: "stable-create-operation" }, directAlice))
      .rejects.toMatchObject({ category: "validation" });
  });

  it("maps a bounded lock wait to storage_busy without a success receipt", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "xmemo-local-busy-"));
    dataDirectories.push(dataDirectory);
    const kernel = await createKernel({ dataDirectory, busyTimeoutMs: 20 });
    const db = new DatabaseSync(resolveLocalVaultPath({ dataDirectory }), { timeout: 20 });
    db.exec("BEGIN IMMEDIATE");
    try {
      await expect(kernel.create({ body: "busy request", operationId: "busy-operation" }, directAlice))
        .rejects.toMatchObject({
          category: "storage_busy",
          receipt: {
            operationId: "busy-operation",
            storageStatus: "not_committed",
            syncStatus: "local_only",
            error: { category: "storage_busy" },
          },
        });
    } finally {
      db.exec("ROLLBACK");
      db.close();
    }
  });

  it("refuses an unknown newer schema without migrating or writing it", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "xmemo-local-newer-schema-"));
    dataDirectories.push(dataDirectory);
    const databasePath = resolveLocalVaultPath({ dataDirectory });
    const db = new DatabaseSync(databasePath);
    db.exec("PRAGMA user_version = 97");
    db.close();
    const before = await readFile(databasePath);

    await expect(LocalMemoryKernel.open({ dataDirectory })).rejects.toMatchObject({
      category: "unsupported_schema_version",
      receipt: { storageStatus: "not_committed", error: { category: "unsupported_schema_version" } },
    });
    expect(await readFile(databasePath)).toEqual(before);
    const verification = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(verification.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 97 });
      expect(verification.prepare("SELECT name FROM sqlite_master WHERE name='vault_metadata'").get()).toBeUndefined();
    } finally {
      verification.close();
    }
  });

  it("refuses a newer metadata schema without changing database bytes", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "xmemo-local-newer-metadata-schema-"));
    dataDirectories.push(dataDirectory);
    const databasePath = resolveLocalVaultPath({ dataDirectory });
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TABLE vault_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO vault_metadata(key, value) VALUES ('schema_version', '97')").run();
    db.exec("PRAGMA user_version = 1");
    db.close();
    const before = await readFile(databasePath);

    await expect(LocalMemoryKernel.open({ dataDirectory })).rejects.toMatchObject({
      category: "unsupported_schema_version",
      receipt: { storageStatus: "not_committed", error: { category: "unsupported_schema_version" } },
    });
    expect(await readFile(databasePath)).toEqual(before);
    const verification = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(verification.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 1 });
      expect(verification.prepare("SELECT value FROM vault_metadata WHERE key='schema_version'").get())
        .toMatchObject({ value: "97" });
    } finally {
      verification.close();
    }
  });

  it("rejects invalid busy timeout settings before starting a worker", async () => {
    await expect(LocalMemoryKernel.open({ busyTimeoutMs: 0 })).rejects.toMatchObject({ category: "validation" });
  });
});
