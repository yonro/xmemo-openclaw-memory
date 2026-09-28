import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
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

async function physicalVaultBytes(dataDirectory: string): Promise<Buffer> {
  const databasePath = resolveLocalVaultPath({ dataDirectory });
  const files = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
  const buffers: Buffer[] = [];
  for (const file of files) {
    try {
      buffers.push(await readFile(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return Buffer.concat(buffers);
}

function expectTokensAbsent(bytes: Buffer, tokens: string[]): void {
  for (const token of tokens) expect(bytes.includes(Buffer.from(token, "utf8")), token).toBe(false);
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

  it("pages revision history and restores a soft-deleted record as a new revision", async () => {
    const kernel = await createKernel();
    const created = await kernel.create({ body: "history first revision" }, directAlice);
    const updated = await kernel.update(created.recordId, {
      body: "history second revision",
      baseRevision: created.revisionId,
    }, directAlice);
    const conflict = await kernel.update(created.recordId, {
      body: "history preserved conflict branch",
      baseRevision: created.revisionId,
      operationId: "history-conflict-operation",
    }, directAlice);
    expect(conflict.writeKind).toBe("conflict");

    const firstPage = await kernel.history(created.recordId, directAlice, { limit: 2 });
    expect(firstPage.revisions).toHaveLength(2);
    expect(firstPage.nextBeforeLocalRevision).toBeDefined();
    await expect(kernel.history(created.recordId, directBob)).rejects.toMatchObject({ category: "not_found" });
    const secondPage = await kernel.history(created.recordId, directAlice, {
      limit: 2,
      beforeLocalRevision: firstPage.nextBeforeLocalRevision,
    });
    const beforeDelete = [...firstPage.revisions, ...secondPage.revisions];
    expect(new Set(beforeDelete.map(revision => revision.revisionId)).size).toBe(beforeDelete.length);
    expect(beforeDelete.map(revision => revision.state).sort()).toEqual(["conflict", "current", "historical"]);
    expect(beforeDelete.find(revision => revision.revisionId === updated.revisionId)?.body)
      .toBe("history second revision");

    const deleted = await kernel.softDelete(created.recordId, {
      baseRevision: updated.revisionId,
      operationId: "history-soft-delete",
    }, directAlice);
    const restored = await kernel.restore(created.recordId, {
      fromRevisionId: created.revisionId,
      baseRevision: deleted.revisionId,
      operationId: "history-restore",
    }, directAlice);
    expect(restored).toMatchObject({ writeKind: "restored", storageStatus: "committed_local" });
    expect(restored.revisionId).not.toBe(created.revisionId);
    expect(restored.localRevision).toBeGreaterThan(deleted.localRevision);
    expect((await kernel.get(created.recordId, directAlice)).body).toBe("history first revision");
    const latestHistory = await kernel.history(created.recordId, directAlice, { limit: 20 });
    expect(latestHistory.revisions.find(revision => revision.revisionId === deleted.revisionId)?.state).toBe("deleted");
    expect(latestHistory.revisions.find(revision => revision.revisionId === restored.revisionId))
      .toMatchObject({ state: "current", parents: [deleted.revisionId, created.revisionId] });

    const database = new DatabaseSync(resolveLocalVaultPath({ dataDirectory: dataDirectories.at(-1) }), { readOnly: true });
    try {
      expect(database.prepare("SELECT cleared_at FROM deletion_barriers WHERE record_id = ? AND barrier_kind = 'soft_delete'")
        .get(created.recordId)).toMatchObject({ cleared_at: expect.any(String) });
    } finally {
      database.close();
    }
  });

  it("hard-deletes all revision content and permanently blocks old operation replays and late writes", async () => {
    const kernel = await createKernel();
    const recordId = "hard-delete-opaque-record";
    const secretBody = "hard delete sensitive body phrase";
    const secretTitle = "hard delete sensitive title";
    const created = await kernel.create({
      recordId,
      body: secretBody,
      title: secretTitle,
      metadata: { privateKey: "hard-delete-sensitive-metadata" },
      operationId: "hard-delete-old-create",
    }, directAlice);
    const updated = await kernel.update(recordId, {
      body: "hard delete second sensitive body",
      title: "hard delete second sensitive title",
      metadata: { privateKey: "hard-delete-second-sensitive-metadata" },
      baseRevision: created.revisionId,
      operationId: "hard-delete-old-update",
    }, directAlice);
    const deleted = await kernel.hardDelete(recordId, {
      baseRevision: updated.revisionId,
      operationId: "hard-delete-final-operation",
    }, directAlice);
    expect(deleted).toMatchObject({ writeKind: "hard_deleted", storageStatus: "committed_local" });
    expect(deleted.barrierId).toBeTruthy();
    await expect(kernel.get(recordId, directAlice)).rejects.toMatchObject({ category: "not_found" });
    expect(await kernel.search("hard delete sensitive", directAlice)).toHaveLength(0);
    await expect(kernel.create({
      recordId,
      body: secretBody,
      title: secretTitle,
      metadata: { privateKey: "hard-delete-sensitive-metadata" },
      operationId: "hard-delete-late-create",
    }, directAlice)).rejects.toMatchObject({ category: "not_found" });
    await expect(kernel.create({
      recordId,
      body: secretBody,
      title: secretTitle,
      metadata: { privateKey: "hard-delete-sensitive-metadata" },
      operationId: "hard-delete-old-create",
    }, directAlice)).rejects.toMatchObject({ category: "not_found" });
    await expect(kernel.update(recordId, {
      body: secretBody,
      baseRevision: updated.revisionId,
      operationId: "hard-delete-late-update",
    }, directAlice)).rejects.toMatchObject({ category: "not_found" });
    expect(await kernel.hardDelete(recordId, {
      baseRevision: updated.revisionId,
      operationId: "hard-delete-final-operation",
    }, directAlice)).toEqual(deleted);

    const database = new DatabaseSync(resolveLocalVaultPath({ dataDirectory: dataDirectories.at(-1) }), { readOnly: true });
    try {
      expect(database.prepare("SELECT 1 FROM records WHERE record_id = ?").get(recordId)).toBeUndefined();
      expect(database.prepare("SELECT 1 FROM revisions WHERE record_id = ?").get(recordId)).toBeUndefined();
      expect(database.prepare("SELECT 1 FROM operations WHERE operation_id IN (?, ?)")
        .get("hard-delete-old-create", "hard-delete-old-update")).toBeUndefined();
      expect(database.prepare("SELECT count(*) AS count FROM operation_tombstones WHERE operation_id IN (?, ?)")
        .get("hard-delete-old-create", "hard-delete-old-update")).toMatchObject({ count: 2 });
      expect(database.prepare("SELECT barrier_kind, barrier_revision_id FROM deletion_barriers WHERE record_id = ? AND barrier_id = ?")
        .get(recordId, deleted.barrierId)).toMatchObject({ barrier_kind: "hard_delete", barrier_revision_id: null });
      const remaining = JSON.stringify(database.prepare("SELECT * FROM operations WHERE record_id = ?").all(recordId));
      expect(remaining).not.toContain(secretBody);
      expect(remaining).not.toContain(secretTitle);
      expect(remaining).not.toContain("hard-delete-sensitive-metadata");
    } finally {
      database.close();
    }
  });

  it("redacts selected fields from every revision and FTS without reopening stale-write paths", async () => {
    const kernel = await createKernel();
    const created = await kernel.create({
      body: "redact first private body phrase",
      title: "redaction keeps this title",
      metadata: { keep: "approved audit note", secret: "private metadata phrase" },
      operationId: "redact-old-create",
    }, directAlice);
    const updated = await kernel.update(created.recordId, {
      body: "redact second private body phrase",
      title: "redaction keeps this newer title",
      metadata: { keep: "second approved note", secret: "second private metadata phrase" },
      baseRevision: created.revisionId,
      operationId: "redact-old-update",
    }, directAlice);
    const priorHistory = await kernel.history(created.recordId, directAlice, { limit: 20 });
    const priorHashes = new Map(priorHistory.revisions.map(revision => [revision.revisionId, revision.contentHash]));
    const redacted = await kernel.redact(created.recordId, {
      baseRevision: updated.revisionId,
      fields: ["body"],
      metadataKeys: ["secret"],
      operationId: "redact-content-operation",
    }, directAlice);
    expect(redacted).toMatchObject({ writeKind: "redacted", storageStatus: "committed_local" });
    const current = await kernel.get(created.recordId, directAlice);
    expect(current.body).toBe("");
    expect(current.title).toBe("redaction keeps this newer title");
    expect(current.metadata).toEqual({ keep: "second approved note" });
    expect(await kernel.search("private body phrase", directAlice)).toHaveLength(0);
    expect((await kernel.search("keeps this newer title", directAlice)).map(record => record.recordId)).toContain(created.recordId);
    const history = await kernel.history(created.recordId, directAlice, { limit: 20 });
    expect(history.revisions).toHaveLength(priorHistory.revisions.length + 1);
    for (const revision of history.revisions) {
      expect(revision.body).toBe("");
      expect(JSON.stringify(revision.metadata)).not.toContain("private metadata phrase");
      if (priorHashes.has(revision.revisionId)) expect(revision.contentHash).not.toBe(priorHashes.get(revision.revisionId));
    }

    const revisionCount = history.revisions.length;
    await expect(kernel.update(created.recordId, {
      body: "redact first private body phrase",
      baseRevision: created.revisionId,
      operationId: "redact-stale-late-update",
    }, directAlice)).rejects.toMatchObject({ category: "conflict", receipt: { storageStatus: "not_committed" } });
    await expect(kernel.create({
      recordId: created.recordId,
      body: "redact first private body phrase",
      operationId: "redact-old-create",
    }, directAlice)).rejects.toMatchObject({ category: "not_found" });
    expect((await kernel.history(created.recordId, directAlice, { limit: 20 })).revisions).toHaveLength(revisionCount);
    expect(await kernel.redact(created.recordId, {
      baseRevision: updated.revisionId,
      fields: ["body"],
      metadataKeys: ["secret"],
      operationId: "redact-content-operation",
    }, directAlice)).toEqual(redacted);

    const restored = await kernel.restore(created.recordId, {
      fromRevisionId: created.revisionId,
      baseRevision: redacted.revisionId,
      operationId: "redact-restore-prior-revision",
    }, directAlice);
    expect(restored.writeKind).toBe("restored");
    expect((await kernel.get(created.recordId, directAlice)).body).toBe("");
    expect(await kernel.search("private body phrase", directAlice)).toHaveLength(0);
    const restoredHistory = await kernel.history(created.recordId, directAlice, { limit: 20 });
    expect(restoredHistory.revisions).toHaveLength(revisionCount + 1);
    expect(restoredHistory.revisions.every(revision => revision.body === "")).toBe(true);

    const database = new DatabaseSync(resolveLocalVaultPath({ dataDirectory: dataDirectories.at(-1) }), { readOnly: true });
    try {
      expect(database.prepare("SELECT 1 FROM operations WHERE operation_id IN (?, ?)")
        .get("redact-old-create", "redact-old-update")).toBeUndefined();
      expect(database.prepare("SELECT count(*) AS count FROM operation_tombstones WHERE operation_id IN (?, ?)")
        .get("redact-old-create", "redact-old-update")).toMatchObject({ count: 2 });
    } finally {
      database.close();
    }
  });

  it("physically scrubs hard-deleted content from the database and WAL before returning", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "xmemo-hard-delete-bytes-"));
    dataDirectories.push(dataDirectory);
    const kernel = await createKernel({ dataDirectory });
    const canaries = [
      "hard-delete-title-raw-canary-7dcb",
      "hard-delete-body-raw-canary-5f81",
      "hard-delete-metadata-raw-canary-90aa",
      "hard-delete-updated-body-raw-canary-f315",
    ];
    const created = await kernel.create({
      title: canaries[0],
      body: canaries[1],
      metadata: { privateValue: canaries[2] },
      operationId: "hard-delete-byte-scan-create",
    }, directAlice);
    const updated = await kernel.update(created.recordId, {
      title: "public title after update",
      body: canaries[3],
      metadata: { privateValue: canaries[2] },
      baseRevision: created.revisionId,
      operationId: "hard-delete-byte-scan-update",
    }, directAlice);

    const deleted = await kernel.hardDelete(created.recordId, {
      baseRevision: updated.revisionId,
      operationId: "hard-delete-byte-scan-delete",
    }, directAlice);

    expect(deleted.physicalCleanup).toBe("complete");
    expectTokensAbsent(await physicalVaultBytes(dataDirectory), canaries);
    await kernel.close();

    const reopened = await createKernel({ dataDirectory });
    expectTokensAbsent(await physicalVaultBytes(dataDirectory), canaries);
    await reopened.close();
  });

  it("physically scrubs redacted content from every database and WAL copy", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "xmemo-redact-bytes-"));
    dataDirectories.push(dataDirectory);
    const kernel = await createKernel({ dataDirectory });
    const canaries = [
      "redact-body-raw-canary-2e74",
      "redact-updated-body-raw-canary-c113",
      "redact-metadata-raw-canary-41d9",
    ];
    const created = await kernel.create({
      title: "public title",
      body: canaries[0],
      metadata: { removeMe: canaries[2], keep: "public" },
      operationId: "redact-byte-scan-create",
    }, directAlice);
    const updated = await kernel.update(created.recordId, {
      body: canaries[1],
      metadata: { removeMe: canaries[2], keep: "still public" },
      baseRevision: created.revisionId,
      operationId: "redact-byte-scan-update",
    }, directAlice);

    const redacted = await kernel.redact(created.recordId, {
      baseRevision: updated.revisionId,
      fields: ["body"],
      metadataKeys: ["removeMe"],
      operationId: "redact-byte-scan-redact",
    }, directAlice);

    expect(redacted.physicalCleanup).toBe("complete");
    expectTokensAbsent(await physicalVaultBytes(dataDirectory), canaries);
    await kernel.close();

    const reopened = await createKernel({ dataDirectory });
    expectTokensAbsent(await physicalVaultBytes(dataDirectory), canaries);
    await reopened.close();
  });

  it("creates an integrity-checked SQLite backup while writes continue", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "xmemo-online-backup-"));
    dataDirectories.push(dataDirectory);
    const kernel = await createKernel({ dataDirectory });
    for (let index = 0; index < 64; index += 1) {
      await kernel.create({ body: `backup seed ${index} ${"x".repeat(16_384)}` }, directAlice);
    }

    const artifactDirectory = join(dataDirectory, "backups", "concurrent");
    const backupPromise = kernel.backup(artifactDirectory).then(
      value => ({ value }),
      error => ({ error }),
    );
    const concurrentWrites = Promise.allSettled(Array.from({ length: 24 }, (_, index) => kernel.create({
      body: `concurrent backup write ${index} ${"y".repeat(8_192)}`,
    }, directAlice)));
    const [backupResult, writeResults] = await Promise.all([backupPromise, concurrentWrites]);
    if ("error" in backupResult) throw new Error("Online backup failed while concurrent writes completed.", { cause: backupResult.error });
    const rejectedWrite = writeResults.find(result => result.status === "rejected");
    if (rejectedWrite?.status === "rejected") {
      throw new Error("A concurrent write failed during online backup.", { cause: rejectedWrite.reason });
    }
    const manifest = backupResult.value;
    const writes = writeResults.map(result => result.status === "fulfilled" ? result.value : undefined);

    expect(manifest).toMatchObject({
      format_version: 1,
      integrity: "ok",
      schema_version: 4,
      vault_id: kernel.vaultId,
      artifact_sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      epoch: 1,
      max_retention_days: 30,
      counts: { records: expect.any(Number), revisions: expect.any(Number) },
    });
    expect(Date.parse(manifest.expires_at) - Date.parse(manifest.created_at)).toBe(30 * 24 * 60 * 60 * 1000);
    expect(writes).toHaveLength(24);
    expect(manifest.counts.records).toBeGreaterThanOrEqual(64);
    expect(manifest.counts.records).toBeLessThanOrEqual(88);

    const backupDb = new DatabaseSync(join(artifactDirectory, "vault.sqlite"), { readOnly: true });
    try {
      expect(backupDb.prepare("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" });
      expect(backupDb.prepare("SELECT count(*) AS count FROM records").get()?.count).toBe(manifest.counts.records);
      expect(backupDb.prepare("SELECT value FROM vault_metadata WHERE key='generation'").get()?.value)
        .toBe(String(manifest.generation));
    } finally {
      backupDb.close();
    }
  }, 15_000);

  it("restores in place, reapplies hard-delete and redaction barriers, and fences stale operations", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "xmemo-backup-restore-"));
    dataDirectories.push(dataDirectory);
    const kernel = await createKernel({ dataDirectory });
    const hardDeleteCanary = "restore-hard-delete-byte-canary-f72a";
    const redactionCanary = "restore-redaction-byte-canary-a811";
    const staleCanary = "restore-post-backup-stale-operation-canary-044b";
    const hardRecord = await kernel.create({ body: hardDeleteCanary, operationId: "backup-hard-delete-create" }, directAlice);
    const redactedRecord = await kernel.create({ body: redactionCanary, operationId: "backup-redact-create" }, directAlice);
    const survivor = await kernel.create({ body: "survivor as captured by the backup", operationId: "backup-survivor-create" }, directAlice);
    const softDeletedRecord = await kernel.create({ body: "soft delete barrier record" }, directAlice);
    const artifactDirectory = join(dataDirectory, "backups", "restore-drill");
    const manifest = await kernel.backup(artifactDirectory);

    const staleUpdate = await kernel.update(survivor.recordId, {
      body: staleCanary,
      baseRevision: survivor.revisionId,
      operationId: "post-backup-stale-update",
    }, directAlice);
    expect(staleUpdate.writeKind).toBe("versioned_update");
    await kernel.redact(redactedRecord.recordId, {
      baseRevision: redactedRecord.revisionId,
      fields: ["body"],
      metadataKeys: [],
      operationId: "post-backup-redact",
    }, directAlice);
    await kernel.hardDelete(hardRecord.recordId, {
      baseRevision: hardRecord.revisionId,
      operationId: "post-backup-hard-delete",
    }, directAlice);
    await kernel.softDelete(softDeletedRecord.recordId, {
      baseRevision: softDeletedRecord.revisionId,
      operationId: "post-backup-soft-delete",
    }, directAlice);

    const restored = await kernel.restoreBackup(artifactDirectory);
    expect(restored).toMatchObject({
      restored: true,
      integrity: "ok",
      schema_version: 4,
      vault_id: kernel.vaultId,
      source_epoch: manifest.epoch,
      replayed_barriers: 3,
      physical_cleanup: "complete",
    });
    expect(restored.epoch).toBeGreaterThan(manifest.epoch);
    expect(restored.generation).toBeGreaterThan(manifest.generation);
    expect(restored.counts.records).toBe(manifest.counts.records - 1);
    expect(restored.counts.revisions).toBe(manifest.counts.revisions - 1);
    expect(restored.counts.deletion_barriers).toBe(3);
    expect(restored.counts.operations).toBe(manifest.counts.operations - 2);
    await expect(kernel.get(hardRecord.recordId, directAlice)).rejects.toMatchObject({ category: "not_found" });
    await expect(kernel.get(softDeletedRecord.recordId, directAlice)).rejects.toMatchObject({ category: "not_found" });
    expect((await kernel.get(redactedRecord.recordId, directAlice)).body).toBe("");
    expect((await kernel.get(survivor.recordId, directAlice)).body).toBe("survivor as captured by the backup");
    expect(await kernel.search(hardDeleteCanary, directAlice)).toHaveLength(0);
    expect(await kernel.search(redactionCanary, directAlice)).toHaveLength(0);
    expect(await kernel.search("soft delete barrier record", directAlice)).toHaveLength(0);
    expect((await kernel.search("survivor as captured", directAlice)).map(record => record.recordId)).toContain(survivor.recordId);
    await expect(kernel.update(survivor.recordId, {
      body: staleCanary,
      baseRevision: survivor.revisionId,
      operationId: "post-backup-stale-update",
    }, directAlice)).rejects.toMatchObject({ category: "not_found" });
    await expect(kernel.create({
      body: "survivor as captured by the backup",
      operationId: "backup-survivor-create",
    }, directAlice))
      .rejects.toMatchObject({ category: "conflict" });
    expectTokensAbsent(await physicalVaultBytes(dataDirectory), [hardDeleteCanary, redactionCanary, staleCanary]);
    await kernel.close();
    const reopened = await createKernel({ dataDirectory });
    expectTokensAbsent(await physicalVaultBytes(dataDirectory), [hardDeleteCanary, redactionCanary, staleCanary]);
    expect((await reopened.get(survivor.recordId, directAlice)).body).toBe("survivor as captured by the backup");
  });

  it("rejects a backup from another vault without changing the active vault", async () => {
    const firstDirectory = await mkdtemp(join(tmpdir(), "xmemo-backup-source-"));
    const secondDirectory = await mkdtemp(join(tmpdir(), "xmemo-backup-target-"));
    dataDirectories.push(firstDirectory, secondDirectory);
    const source = await createKernel({ dataDirectory: firstDirectory });
    const target = await createKernel({ dataDirectory: secondDirectory });
    const sourceRecord = await source.create({ body: "source vault backup" }, directAlice);
    const targetRecord = await target.create({ body: "target vault remains unchanged" }, directAlice);
    const artifactDirectory = join(firstDirectory, "backup");
    await source.backup(artifactDirectory);

    await expect(target.restoreBackup(artifactDirectory)).rejects.toMatchObject({ category: "validation" });
    expect((await target.get(targetRecord.recordId, directAlice)).body).toBe("target vault remains unchanged");
    expect((await source.get(sourceRecord.recordId, directAlice)).body).toBe("source vault backup");
  });

  it("rejects a backup whose SQLite artifact no longer matches its manifest", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "xmemo-backup-tamper-"));
    dataDirectories.push(dataDirectory);
    const kernel = await createKernel({ dataDirectory });
    const record = await kernel.create({ body: "active data survives a damaged backup" }, directAlice);
    const artifactDirectory = join(dataDirectory, "backup");
    await kernel.backup(artifactDirectory);
    await appendFile(join(artifactDirectory, "vault.sqlite"), Buffer.from("tamper"));

    await expect(kernel.restoreBackup(artifactDirectory)).rejects.toMatchObject({ category: "corrupt_store" });
    expect((await kernel.get(record.recordId, directAlice)).body).toBe("active data survives a damaged backup");
  });

  it("persists pending physical cleanup when a reader blocks WAL truncation and completes it when idle", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "xmemo-pending-cleanup-"));
    dataDirectories.push(dataDirectory);
    const kernel = await createKernel({ dataDirectory });
    const canary = "redact-busy-reader-raw-canary-67c2";
    const created = await kernel.create({
      body: canary,
      operationId: "redact-busy-reader-create",
    }, directAlice);
    const databasePath = resolveLocalVaultPath({ dataDirectory });
    const reader = new DatabaseSync(databasePath, { readOnly: true });
    const observer = new DatabaseSync(databasePath, { readOnly: true });
    try {
      reader.exec("BEGIN");
      reader.prepare("SELECT current_body FROM records WHERE record_id = ?").get(created.recordId);

      const redacted = await kernel.redact(created.recordId, {
        baseRevision: created.revisionId,
        fields: ["body"],
        metadataKeys: [],
        operationId: "redact-busy-reader-redact",
      }, directAlice);

      expect(redacted).toMatchObject({ writeKind: "redacted", physicalCleanup: "pending" });
      expect(observer.prepare("SELECT status FROM physical_cleanup_jobs WHERE operation_id = ?")
        .get("redact-busy-reader-redact")).toMatchObject({ status: "pending" });
      expect((await physicalVaultBytes(dataDirectory)).includes(Buffer.from(canary))).toBe(true);

      reader.exec("ROLLBACK");
      const deadline = Date.now() + 5_000;
      let cleanup = observer.prepare("SELECT status FROM physical_cleanup_jobs WHERE operation_id = ?")
        .get("redact-busy-reader-redact");
      while (cleanup?.status !== "complete" && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
        cleanup = observer.prepare("SELECT status FROM physical_cleanup_jobs WHERE operation_id = ?")
          .get("redact-busy-reader-redact");
      }
      expect(cleanup).toMatchObject({ status: "complete" });
      expect(JSON.parse(String(observer.prepare("SELECT response_json FROM operations WHERE operation_id = ?")
        .get("redact-busy-reader-redact")?.response_json))).toMatchObject({ physicalCleanup: "complete" });
      expectTokensAbsent(await physicalVaultBytes(dataDirectory), [canary]);
    } finally {
      try { if (reader.isTransaction) reader.exec("ROLLBACK"); } catch { /* Best effort during test cleanup. */ }
      reader.close();
      observer.close();
    }

    await kernel.close();
    const reopened = await createKernel({ dataDirectory });
    expectTokensAbsent(await physicalVaultBytes(dataDirectory), [canary]);
    await reopened.close();
  });

  it("migrates a version 1 soft-delete barrier without losing its restore path", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "xmemo-local-migrate-v1-"));
    const kernel = await createKernel({ dataDirectory });
    const created = await kernel.create({ body: "migration barrier keeps content" }, directAlice);
    const deleted = await kernel.softDelete(created.recordId, {
      baseRevision: created.revisionId,
      operationId: "migration-v1-soft-delete",
    }, directAlice);
    await kernel.close();

    const databasePath = resolveLocalVaultPath({ dataDirectory });
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("PRAGMA foreign_keys = OFF");
      database.exec(`
        CREATE TABLE deletion_barriers_v1 (
          record_id TEXT PRIMARY KEY REFERENCES records(record_id) ON DELETE CASCADE,
          barrier_revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
          operation_id TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL
        ) STRICT
      `);
      database.prepare(`
        INSERT INTO deletion_barriers_v1(record_id, barrier_revision_id, operation_id, created_at)
        SELECT record_id, barrier_revision_id, operation_id, created_at FROM deletion_barriers WHERE record_id = ?
      `).run(created.recordId);
      database.exec("DROP TABLE deletion_barriers; ALTER TABLE deletion_barriers_v1 RENAME TO deletion_barriers; DROP TABLE operation_tombstones; DROP TABLE physical_cleanup_jobs");
      database.exec("ALTER TABLE operations DROP COLUMN generation; ALTER TABLE operations DROP COLUMN epoch");
      database.prepare("UPDATE vault_metadata SET value = '1' WHERE key = 'schema_version'").run();
      database.exec("PRAGMA user_version = 1");
    } finally {
      database.close();
    }

    const migrated = await createKernel({ dataDirectory });
    const restored = await migrated.restore(created.recordId, {
      fromRevisionId: created.revisionId,
      baseRevision: deleted.revisionId,
      operationId: "migration-v1-restore",
    }, directAlice);
    expect(restored.writeKind).toBe("restored");
    expect((await migrated.get(created.recordId, directAlice)).body).toBe("migration barrier keeps content");
    const verification = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(verification.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 4 });
      expect(verification.prepare("SELECT value FROM vault_metadata WHERE key = 'schema_version'").get())
        .toMatchObject({ value: "4" });
    } finally {
      verification.close();
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
