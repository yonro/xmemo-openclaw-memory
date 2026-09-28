import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

const SCHEMA_VERSION = 1;
const { databasePath, busyTimeoutMs } = workerData;
let database;
let vaultId;

class DomainError extends Error {
  constructor(category, message, options = {}) {
    super(message);
    this.category = category;
    this.operationId = options.operationId;
    this.recordId = options.recordId;
    this.storageStatus = options.storageStatus ?? "not_committed";
    this.indexStatus = options.indexStatus ?? "unchanged";
  }
}

const migrationOne = `
  CREATE TABLE vault_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE records (
    rowid INTEGER PRIMARY KEY,
    record_id TEXT NOT NULL UNIQUE,
    origin TEXT NOT NULL CHECK (origin IN ('local', 'cloud', 'import')),
    authority TEXT NOT NULL CHECK (authority IN ('local', 'cloud', 'shared')),
    owner_ref TEXT NOT NULL,
    collection_ref TEXT NOT NULL,
    binding_id TEXT,
    local_revision INTEGER NOT NULL CHECK (local_revision >= 1),
    current_revision_id TEXT NOT NULL,
    current_title TEXT NOT NULL,
    current_body TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  ) STRICT;

  CREATE TABLE revisions (
    revision_id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL REFERENCES records(record_id) ON DELETE CASCADE,
    local_revision INTEGER NOT NULL CHECK (local_revision >= 1),
    parents_json TEXT NOT NULL,
    base_revision TEXT,
    operation_id TEXT NOT NULL UNIQUE,
    content_hash TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    revision_state TEXT NOT NULL CHECK (revision_state IN ('current', 'historical', 'conflict', 'deleted')),
    is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX revisions_record_local_revision ON revisions(record_id, local_revision);

  CREATE TABLE deletion_barriers (
    record_id TEXT PRIMARY KEY REFERENCES records(record_id) ON DELETE CASCADE,
    barrier_revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
    operation_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE operations (
    operation_id TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    record_id TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE VIRTUAL TABLE record_fts USING fts5(
    current_title,
    current_body,
    content='records',
    content_rowid='rowid',
    tokenize='trigram'
  );

  CREATE TRIGGER records_fts_insert AFTER INSERT ON records BEGIN
    INSERT INTO record_fts(rowid, current_title, current_body)
    SELECT NEW.rowid, NEW.current_title, NEW.current_body
    WHERE NEW.deleted_at IS NULL;
  END;

  CREATE TRIGGER records_fts_update AFTER UPDATE OF current_title, current_body, deleted_at ON records BEGIN
    INSERT INTO record_fts(record_fts, rowid, current_title, current_body)
    SELECT 'delete', OLD.rowid, OLD.current_title, OLD.current_body
    WHERE OLD.deleted_at IS NULL;
    INSERT INTO record_fts(rowid, current_title, current_body)
    SELECT NEW.rowid, NEW.current_title, NEW.current_body
    WHERE NEW.deleted_at IS NULL;
  END;

  CREATE TRIGGER records_fts_delete AFTER DELETE ON records BEGIN
    INSERT INTO record_fts(record_fts, rowid, current_title, current_body)
    VALUES ('delete', OLD.rowid, OLD.current_title, OLD.current_body);
  END;
`;

const MIGRATIONS = [{ version: 1, sql: migrationOne }];

function errorCode(error) {
  return typeof error?.code === "string" ? error.code : "";
}

function errorNumber(error) {
  return typeof error?.errcode === "number" ? error.errcode : -1;
}

function categoryFor(error, duringInitialization = false) {
  const code = errorCode(error);
  const number = errorNumber(error);
  const message = String(error?.message ?? "");
  if (number === 5 || number === 6 || /SQLITE_(BUSY|LOCKED)/.test(code) || /database is locked|database is busy/i.test(message)) {
    return "storage_busy";
  }
  if (number === 13 || /SQLITE_FULL/.test(code) || /database or disk is full|no space left/i.test(message)) {
    return "storage_full";
  }
  if (number === 11 || number === 26 || /SQLITE_(CORRUPT|NOTADB)/.test(code) || /malformed|not a database|disk image is malformed/i.test(message)) {
    return "corrupt_store";
  }
  if (duringInitialization) return "corrupt_store";
  if (/SQLITE_CONSTRAINT/.test(code)) return "validation";
  return "validation";
}

function safeMessage(category) {
  switch (category) {
    case "storage_busy": return "Local database remained locked beyond the configured busy timeout.";
    case "storage_full": return "Local database is full; the mutation was not committed.";
    case "corrupt_store": return "Local database is corrupt or unreadable; no empty-store fallback was used.";
    case "conflict": return "The supplied base revision is stale; both branches were preserved.";
    case "not_found": return "Local record was not found in the requested identity scope.";
    case "identity_denied": return "Trusted identity is missing or does not permit this local operation.";
    case "unsupported_schema_version": return "Local database schema is newer than this runtime supports; writes were refused.";
    default: return "Local storage request failed validation.";
  }
}

function toWireError(error, context = {}) {
  const category = error?.category ?? categoryFor(error);
  const message = error?.message && error instanceof DomainError ? error.message : safeMessage(category);
  const receipt = {
    ...(context.operationId ?? error?.operationId ? { operationId: context.operationId ?? error.operationId } : {}),
    ...(context.recordId ?? error?.recordId ? { recordId: context.recordId ?? error.recordId } : {}),
    storageStatus: error?.storageStatus ?? "not_committed",
    syncStatus: "local_only",
    indexStatus: error?.indexStatus ?? "unchanged",
    error: { category, message },
  };
  return { category, message, receipt };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new DomainError("validation", safeMessage("validation"));
  return encoded;
}

function digest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

function requireText(value, field, options = {}) {
  if (typeof value !== "string") throw new DomainError("validation", `${field} must be a string.`);
  const normalized = value.trim();
  if (!normalized && !options.allowEmpty) throw new DomainError("validation", `${field} must not be empty.`);
  if (normalized.length > (options.maxLength ?? 1_000_000)) throw new DomainError("validation", `${field} is too long.`);
  return options.preserveWhitespace ? value : normalized;
}

function requireScope(scope) {
  const ownerRef = typeof scope?.ownerRef === "string" ? scope.ownerRef.trim() : "";
  const collectionRef = typeof scope?.collectionRef === "string" ? scope.collectionRef.trim() : "";
  if (!ownerRef || !collectionRef) throw new DomainError("identity_denied", safeMessage("identity_denied"));
  return { ownerRef, collectionRef };
}

function initializeDatabase() {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  try { chmodSync(dirname(databasePath), 0o700); } catch { /* Best effort on Windows. */ }

  database = new DatabaseSync(databasePath, { timeout: busyTimeoutMs });
  const versionRow = database.prepare("PRAGMA user_version").get();
  const userVersion = Number(versionRow?.user_version ?? 0);
  if (userVersion > SCHEMA_VERSION) {
    database.close();
    database = undefined;
    throw new DomainError("unsupported_schema_version", safeMessage("unsupported_schema_version"));
  }

  if (userVersion === 0) {
    const existingTables = database.prepare(
      "SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).get();
    if (Number(existingTables?.count ?? 0) > 0) {
      throw new DomainError("corrupt_store", safeMessage("corrupt_store"));
    }
  } else {
    const metadataTable = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='vault_metadata'",
    ).get();
    if (!metadataTable) throw new DomainError("corrupt_store", safeMessage("corrupt_store"));
    let storedVersion;
    try {
      storedVersion = Number(database.prepare(
        "SELECT value FROM vault_metadata WHERE key = 'schema_version'",
      ).get()?.value);
    } catch {
      throw new DomainError("corrupt_store", safeMessage("corrupt_store"));
    }
    if (storedVersion > SCHEMA_VERSION) {
      database.close();
      database = undefined;
      throw new DomainError("unsupported_schema_version", safeMessage("unsupported_schema_version"));
    }
    if (storedVersion !== userVersion) {
      throw new DomainError("corrupt_store", safeMessage("corrupt_store"));
    }
  }

  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = FULL");
  database.exec("PRAGMA foreign_keys = ON");
  const journalMode = String(database.prepare("PRAGMA journal_mode").get()?.journal_mode ?? "").toLowerCase();
  const synchronous = Number(database.prepare("PRAGMA synchronous").get()?.synchronous ?? 0);
  if (journalMode !== "wal" || synchronous !== 2) {
    throw new DomainError("validation", "Local storage requires WAL and synchronous=FULL on a local filesystem.");
  }

  let version = userVersion;
  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      if (migration.version === 1) {
        database.prepare("INSERT INTO vault_metadata(key, value) VALUES (?, ?)").run("vault_id", randomUUID());
      }
      database.prepare("INSERT OR REPLACE INTO vault_metadata(key, value) VALUES (?, ?)")
        .run("schema_version", String(migration.version));
      database.exec(`PRAGMA user_version = ${migration.version}`);
      database.exec("COMMIT");
      version = migration.version;
    } catch (error) {
      try { if (database.isTransaction) database.exec("ROLLBACK"); } catch { /* Preserve the migration error. */ }
      throw error;
    }
  }

  const metadata = database.prepare("SELECT key, value FROM vault_metadata WHERE key IN ('schema_version', 'vault_id')").all();
  const values = new Map(metadata.map(row => [String(row.key), String(row.value)]));
  const storedVersion = Number(values.get("schema_version"));
  if (storedVersion > SCHEMA_VERSION) {
    throw new DomainError("unsupported_schema_version", safeMessage("unsupported_schema_version"));
  }
  if (storedVersion !== SCHEMA_VERSION || !values.get("vault_id")) {
    throw new DomainError("corrupt_store", safeMessage("corrupt_store"));
  }
  const integrity = database.prepare("PRAGMA quick_check(1)").get();
  if (String(integrity?.quick_check ?? "") !== "ok") {
    throw new DomainError("corrupt_store", safeMessage("corrupt_store"));
  }
  try { chmodSync(databasePath, 0o600); } catch { /* Best effort on Windows. */ }
  return { vaultId: values.get("vault_id"), schemaVersion: storedVersion };
}

function operationResult(operationId, requestHash, work, recordIdHint) {
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const previous = database.prepare(
      "SELECT request_hash, response_json FROM operations WHERE operation_id = ?",
    ).get(operationId);
    if (previous) {
      if (String(previous.request_hash) !== requestHash) {
        throw new DomainError("validation", "operation_id was already used for a different mutation.", { operationId, recordId: recordIdHint });
      }
      const response = JSON.parse(String(previous.response_json));
      database.exec("COMMIT");
      return response;
    }

    const result = work();
    const recordId = String(result.recordId ?? recordIdHint ?? "");
    if (!recordId) throw new DomainError("validation", "Mutation did not produce a record identifier.", { operationId });
    database.prepare(
      "INSERT INTO operations(operation_id, request_hash, record_id, response_json, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(operationId, requestHash, recordId, JSON.stringify(result), new Date().toISOString());
    database.exec("COMMIT");
    return result;
  } catch (error) {
    let storageStatus = "not_committed";
    if (transactionStarted && database?.isTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
        storageStatus = "unknown";
      }
    }
    if (error instanceof DomainError) {
      error.storageStatus = storageStatus;
      throw error;
    }
    const category = categoryFor(error);
    throw new DomainError(category, safeMessage(category), {
      operationId,
      recordId: recordIdHint,
      storageStatus,
      indexStatus: storageStatus === "unknown" ? "unknown" : "unchanged",
    });
  }
}

function nextLocalRevision(recordId) {
  const row = database.prepare("SELECT coalesce(max(local_revision), 0) AS latest FROM revisions WHERE record_id = ?").get(recordId);
  return Number(row?.latest ?? 0) + 1;
}

function hashContent(title, body, metadataJson, deleted = false) {
  return `sha256:${digest({ title, body, metadata: JSON.parse(metadataJson), deleted })}`;
}

function makeReceipt(operationId, recordId, localRevision, revisionId, writeKind, error = null) {
  return {
    operationId,
    recordId,
    localRevision,
    revisionId,
    storageStatus: "committed_local",
    syncStatus: "local_only",
    indexStatus: "ready",
    writeKind,
    error,
  };
}

function createRecord(payload) {
  const operationId = requireText(payload.operationId, "operationId", { maxLength: 200 });
  const scope = requireScope(payload.scope);
  const recordIdHint = payload.recordId === undefined
    ? undefined
    : requireText(payload.recordId, "recordId", { maxLength: 200 });
  const body = requireText(payload.body, "body", { preserveWhitespace: true });
  const title = requireText(payload.title ?? "", "title", { allowEmpty: true, preserveWhitespace: true, maxLength: 10_000 });
  const metadataJson = requireText(payload.metadataJson, "metadataJson", { preserveWhitespace: true });
  const requestHash = digest({ operation: "create", recordId: recordIdHint ?? null, scope, body, title, metadataJson });

  return operationResult(operationId, requestHash, () => {
    const recordId = recordIdHint ?? randomUUID();
    const existing = database.prepare("SELECT 1 FROM records WHERE record_id = ?").get(recordId);
    if (existing) throw new DomainError("validation", "recordId already exists.", { operationId, recordId });
    const now = new Date().toISOString();
    const revisionId = randomUUID();
    const contentHash = hashContent(title, body, metadataJson);
    database.prepare(`
      INSERT INTO records(
        record_id, origin, authority, owner_ref, collection_ref, binding_id,
        local_revision, current_revision_id, current_title, current_body, metadata_json,
        created_at, updated_at, deleted_at
      ) VALUES (?, 'local', 'local', ?, ?, NULL, 1, ?, ?, ?, ?, ?, ?, NULL)
    `).run(recordId, scope.ownerRef, scope.collectionRef, revisionId, title, body, metadataJson, now, now);
    database.prepare(`
      INSERT INTO revisions(
        revision_id, record_id, local_revision, parents_json, base_revision, operation_id,
        content_hash, title, body, metadata_json, revision_state, created_at
      ) VALUES (?, ?, 1, '[]', NULL, ?, ?, ?, ?, ?, 'current', ?)
    `).run(revisionId, recordId, operationId, contentHash, title, body, metadataJson, now);
    return makeReceipt(operationId, recordId, 1, revisionId, "created");
  }, recordIdHint);
}

function currentRecord(recordId, scope) {
  const row = database.prepare(`
    SELECT r.*, v.revision_id, v.parents_json, v.base_revision, v.operation_id, v.content_hash
    FROM records AS r
    JOIN revisions AS v ON v.revision_id = r.current_revision_id
    WHERE r.record_id = ? AND r.owner_ref = ? AND r.collection_ref = ? AND r.deleted_at IS NULL
  `).get(recordId, scope.ownerRef, scope.collectionRef);
  if (!row) throw new DomainError("not_found", safeMessage("not_found"), { recordId });
  return row;
}

function isRevisionForRecord(recordId, revisionId) {
  return database.prepare("SELECT 1 FROM revisions WHERE record_id = ? AND revision_id = ?").get(recordId, revisionId);
}

function conflictBranch({ operationId, recordId, current, baseRevision, title, body, metadataJson, deleted = false }) {
  if (!isRevisionForRecord(recordId, baseRevision)) {
    throw new DomainError("not_found", "base_revision does not belong to this local record.", { operationId, recordId });
  }
  const revisionId = randomUUID();
  const localRevision = nextLocalRevision(recordId);
  const now = new Date().toISOString();
  const contentHash = hashContent(title, body, metadataJson, deleted);
  database.prepare(`
    INSERT INTO revisions(
      revision_id, record_id, local_revision, parents_json, base_revision, operation_id,
      content_hash, title, body, metadata_json, revision_state, is_deleted, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'conflict', ?, ?)
  `).run(revisionId, recordId, localRevision, JSON.stringify([baseRevision]), baseRevision,
    operationId, contentHash, title, body, metadataJson, deleted ? 1 : 0, now);
  return makeReceipt(operationId, recordId, localRevision, revisionId, "conflict", {
    category: "conflict",
    message: safeMessage("conflict"),
    baseRevision,
    acceptedRevisionId: String(current.current_revision_id),
    conflictRevisionId: revisionId,
  });
}

function updateRecord(payload) {
  const operationId = requireText(payload.operationId, "operationId", { maxLength: 200 });
  const recordId = requireText(payload.recordId, "recordId", { maxLength: 200 });
  const scope = requireScope(payload.scope);
  const body = requireText(payload.body, "body", { preserveWhitespace: true });
  const title = requireText(payload.title ?? "", "title", { allowEmpty: true, preserveWhitespace: true, maxLength: 10_000 });
  const metadataJson = requireText(payload.metadataJson, "metadataJson", { preserveWhitespace: true });
  const baseRevision = payload.baseRevision === null || payload.baseRevision === undefined
    ? null
    : requireText(payload.baseRevision, "baseRevision", { maxLength: 200 });
  const requestHash = digest({ operation: "update", recordId, scope, body, title, metadataJson, baseRevision });

  return operationResult(operationId, requestHash, () => {
    const current = currentRecord(recordId, scope);
    if (baseRevision !== null && !isRevisionForRecord(recordId, baseRevision)) {
      throw new DomainError("not_found", "base_revision does not belong to this local record.", { operationId, recordId });
    }
    if (baseRevision !== null && baseRevision !== String(current.current_revision_id)) {
      return conflictBranch({ operationId, recordId, current, baseRevision, title, body, metadataJson });
    }

    const localRevision = nextLocalRevision(recordId);
    const revisionId = randomUUID();
    const now = new Date().toISOString();
    const contentHash = hashContent(title, body, metadataJson);
    database.prepare("UPDATE revisions SET revision_state = 'historical' WHERE revision_id = ?")
      .run(String(current.current_revision_id));
    database.prepare(`
      INSERT INTO revisions(
        revision_id, record_id, local_revision, parents_json, base_revision, operation_id,
        content_hash, title, body, metadata_json, revision_state, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', ?)
    `).run(revisionId, recordId, localRevision, JSON.stringify([String(current.current_revision_id)]),
      baseRevision ?? String(current.current_revision_id), operationId, contentHash, title, body, metadataJson, now);
    database.prepare(`
      UPDATE records
      SET local_revision = ?, current_revision_id = ?, current_title = ?, current_body = ?,
          metadata_json = ?, updated_at = ?
      WHERE record_id = ? AND owner_ref = ? AND collection_ref = ? AND deleted_at IS NULL
    `).run(localRevision, revisionId, title, body, metadataJson, now, recordId, scope.ownerRef, scope.collectionRef);
    return makeReceipt(operationId, recordId, localRevision, revisionId,
      baseRevision === null ? "unversioned_write" : "versioned_update");
  }, recordId);
}

function softDeleteRecord(payload) {
  const operationId = requireText(payload.operationId, "operationId", { maxLength: 200 });
  const recordId = requireText(payload.recordId, "recordId", { maxLength: 200 });
  const scope = requireScope(payload.scope);
  const baseRevision = payload.baseRevision === null || payload.baseRevision === undefined
    ? null
    : requireText(payload.baseRevision, "baseRevision", { maxLength: 200 });
  const requestHash = digest({ operation: "softDelete", recordId, scope, baseRevision });

  return operationResult(operationId, requestHash, () => {
    const current = currentRecord(recordId, scope);
    if (baseRevision !== null && !isRevisionForRecord(recordId, baseRevision)) {
      throw new DomainError("not_found", "base_revision does not belong to this local record.", { operationId, recordId });
    }
    if (baseRevision !== null && baseRevision !== String(current.current_revision_id)) {
      return conflictBranch({
        operationId,
        recordId,
        current,
        baseRevision,
        title: String(current.current_title),
        body: String(current.current_body),
        metadataJson: String(current.metadata_json),
        deleted: true,
      });
    }

    const localRevision = nextLocalRevision(recordId);
    const revisionId = randomUUID();
    const now = new Date().toISOString();
    const title = String(current.current_title);
    const body = String(current.current_body);
    const metadataJson = String(current.metadata_json);
    const contentHash = hashContent(title, body, metadataJson, true);
    database.prepare("UPDATE revisions SET revision_state = 'historical' WHERE revision_id = ?")
      .run(String(current.current_revision_id));
    database.prepare(`
      INSERT INTO revisions(
      revision_id, record_id, local_revision, parents_json, base_revision, operation_id,
      content_hash, title, body, metadata_json, revision_state, is_deleted, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'deleted', 1, ?)
  `).run(revisionId, recordId, localRevision, JSON.stringify([String(current.current_revision_id)]),
      baseRevision ?? String(current.current_revision_id), operationId, contentHash, title, body, metadataJson, now);
    database.prepare(`
      UPDATE records
      SET local_revision = ?, current_revision_id = ?, deleted_at = ?, updated_at = ?
      WHERE record_id = ? AND owner_ref = ? AND collection_ref = ? AND deleted_at IS NULL
    `).run(localRevision, revisionId, now, now, recordId, scope.ownerRef, scope.collectionRef);
    database.prepare(`
      INSERT INTO deletion_barriers(record_id, barrier_revision_id, operation_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(recordId, revisionId, operationId, now);
    return makeReceipt(operationId, recordId, localRevision, revisionId, "soft_deleted");
  }, recordId);
}

function decodeRecord(row) {
  try {
    return {
      recordId: String(row.record_id),
      origin: "local",
      authority: "local",
      ownerRef: String(row.owner_ref),
      collectionRef: String(row.collection_ref),
      bindingId: null,
      localRevision: Number(row.local_revision),
      revision: {
        revisionId: String(row.revision_id),
        parents: JSON.parse(String(row.parents_json)),
        baseRevision: row.base_revision === null ? null : String(row.base_revision),
        operationId: String(row.operation_id),
        contentHash: String(row.content_hash),
      },
      title: String(row.current_title),
      body: String(row.current_body),
      metadata: JSON.parse(String(row.metadata_json)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  } catch {
    throw new DomainError("corrupt_store", safeMessage("corrupt_store"), { recordId: String(row.record_id) });
  }
}

function getRecord(payload) {
  const recordId = requireText(payload.recordId, "recordId", { maxLength: 200 });
  const scope = requireScope(payload.scope);
  const row = currentRecord(recordId, scope);
  return decodeRecord(row);
}

function searchRecords(payload) {
  const scope = requireScope(payload.scope);
  const query = requireText(payload.query, "query", { maxLength: 1_000, allowEmpty: true }).trim();
  const limit = Number(payload.limit ?? 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new DomainError("validation", "Search limit must be between 1 and 100.");
  }
  if (!query) return [];

  let rows;
  if (Array.from(query).length < 3) {
    const escaped = query.replace(/[\\%_]/g, "\\$&");
    const like = `%${escaped}%`;
    rows = database.prepare(`
      SELECT r.*, v.revision_id, v.parents_json, v.base_revision, v.operation_id, v.content_hash, 0.0 AS rank
      FROM records AS r
      JOIN revisions AS v ON v.revision_id = r.current_revision_id
      WHERE r.owner_ref = ? AND r.collection_ref = ? AND r.deleted_at IS NULL
        AND (r.current_title LIKE ? ESCAPE '\\' OR r.current_body LIKE ? ESCAPE '\\')
      ORDER BY r.updated_at DESC
      LIMIT ?
    `).all(scope.ownerRef, scope.collectionRef, like, like, limit);
  } else {
    const phrase = `"${query.replace(/"/g, '""')}"`;
    rows = database.prepare(`
      SELECT r.*, v.revision_id, v.parents_json, v.base_revision, v.operation_id, v.content_hash,
             bm25(record_fts) AS rank
      FROM record_fts
      JOIN records AS r ON r.rowid = record_fts.rowid
      JOIN revisions AS v ON v.revision_id = r.current_revision_id
      WHERE record_fts MATCH ? AND r.owner_ref = ? AND r.collection_ref = ? AND r.deleted_at IS NULL
      ORDER BY rank ASC, r.updated_at DESC
      LIMIT ?
    `).all(phrase, scope.ownerRef, scope.collectionRef, limit);
  }
  return rows.map(row => ({ ...decodeRecord(row), rank: Number(row.rank ?? 0) }));
}

function handleRequest(operation, payload) {
  switch (operation) {
    case "create": return createRecord(payload);
    case "get": return getRecord(payload);
    case "update": return updateRecord(payload);
    case "softDelete": return softDeleteRecord(payload);
    case "search": return searchRecords(payload);
    case "close":
      database.close();
      database = undefined;
      return undefined;
    default: throw new DomainError("validation", "Unknown local storage operation.");
  }
}

function sendFatal(error) {
  const category = error?.category ?? categoryFor(error, true);
  parentPort?.postMessage({
    type: "fatal",
    error: toWireError(error instanceof DomainError ? error : new DomainError(category, safeMessage(category))),
  });
  try { database?.close(); } catch { /* Best effort after failed open. */ }
  database = undefined;
  parentPort?.close();
}

try {
  const ready = initializeDatabase();
  vaultId = ready.vaultId;
  parentPort?.postMessage({ type: "ready", vaultId, schemaVersion: ready.schemaVersion });
} catch (error) {
  sendFatal(error);
}

parentPort?.on("message", message => {
  if (!message || message.type !== "request" || typeof message.id !== "number") return;
  const { id, operation, payload = {} } = message;
  try {
    const value = handleRequest(operation, payload);
    parentPort?.postMessage({ type: "response", id, value });
    if (operation === "close") parentPort?.close();
  } catch (error) {
    parentPort?.postMessage({
      type: "response",
      id,
      error: toWireError(error, {
        operationId: payload.operationId,
        recordId: payload.recordId,
      }),
    });
  }
});
