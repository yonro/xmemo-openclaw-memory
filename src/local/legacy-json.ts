import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { containsCredential, containsRawIdentity, sanitizeTransferValue } from "./transfer-privacy.js";

export const LEGACY_OUTBOX_STATUSES = ["pending", "processing", "held", "failed", "sent"] as const;
type LegacyOutboxStatus = typeof LEGACY_OUTBOX_STATUSES[number];
type SourceKind = "recall_cache" | "write_outbox";
type Disposition = "imported" | "quarantined" | "skipped";

type SourceEntry = {
  kind: SourceKind;
  ordinal: number;
  key: string;
  value: unknown;
  entryHash: string;
  sourceHash: string;
};

export type LegacyImportLedgerEntry = {
  format: "xmemo-legacy-import";
  version: 1;
  sourceKind: SourceKind;
  sourceHash: string;
  sourceOrdinal: number;
  sourceEntryHash: string;
  sourceKey: string;
  category: string;
  disposition: Disposition;
  reasonCode?: string;
  sourceStatus?: string;
  targetAccountHash?: string;
  importedKind?: "cache_copy" | "held_outbox";
  provenance?: { origin: "import"; authority: "cloud" };
  storedStatus?: "held";
  replayEnabled?: false;
  payload?: unknown;
  quarantinePreview?: unknown;
  effect?: { operation: string; endpoint: string; method: string; payload: Record<string, unknown>; idempotencyKey: string };
};

export type LegacyPreview = {
  recallCache: {
    sourceHash: string | null;
    sourceEntries: number;
    categoryCounts: Record<string, number>;
  };
  writeOutbox: {
    sourceHash: string | null;
    sourceEntries: number;
    statusCounts: Record<string, number>;
    categoryCounts: Record<string, number>;
    statusByCategory: Record<string, Record<string, number>>;
  };
  totalSourceEntries: number;
};

type ReadSourceResult = { entries: SourceEntry[]; sourceHash: string | null; bytes: Buffer | null };

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readSource(path: string, kind: SourceKind): ReadSourceResult {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return { entries: [], sourceHash: null, bytes: null };
    throw new Error(`Cannot read ${kind} source file.`, { cause: error });
  }
  let root: unknown;
  try {
    root = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${kind} source file is not valid JSON; it was left unchanged.`, { cause: error });
  }
  const storeKey = kind === "recall_cache" ? "entries" : "records";
  if (!isObject(root) || root.version !== 1 || !isObject(root[storeKey])) {
    throw new Error(`${kind} source file does not match the documented legacy v1 store; it was left unchanged.`);
  }
  const sourceHash = sha256(bytes);
  const entries = Object.entries(root[storeKey]).map(([key, value], index) => ({
    kind,
    ordinal: index + 1,
    key,
    value,
    entryHash: sha256(JSON.stringify(value)),
    sourceHash,
  }));
  return { entries, sourceHash, bytes };
}

function countBy<T>(values: T[], keyFor: (value: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const key = keyFor(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function statusOf(value: unknown): string {
  return isObject(value) && typeof value.status === "string" && LEGACY_OUTBOX_STATUSES.includes(value.status as LegacyOutboxStatus)
    ? value.status
    : "unknown";
}

function categoryOf(value: unknown): string {
  return isObject(value) && typeof value.operation === "string" && value.operation.trim()
    ? value.operation.trim()
    : "unknown";
}

function sourceEntry(kind: SourceKind, entry: SourceEntry): Omit<LegacyImportLedgerEntry, "disposition"> {
  const sourceKey = sha256(`${kind}\0${entry.key}\0${entry.entryHash}`);
  return {
    format: "xmemo-legacy-import",
    version: 1,
    sourceKind: kind,
    sourceHash: entry.sourceHash,
    sourceOrdinal: entry.ordinal,
    sourceEntryHash: entry.entryHash,
    sourceKey,
    category: categoryOf(entry.value),
    ...(kind === "write_outbox" ? { sourceStatus: statusOf(entry.value) } : {}),
  };
}

export function previewLegacyJson(options: { recallCachePath: string; writeOutboxPath: string }): LegacyPreview {
  const cache = readSource(options.recallCachePath, "recall_cache");
  const outbox = readSource(options.writeOutboxPath, "write_outbox");
  const statusCounts: Record<string, number> = Object.fromEntries(LEGACY_OUTBOX_STATUSES.map(status => [status, 0]));
  statusCounts.unknown = 0;
  const statusByCategory: Record<string, Record<string, number>> = {};
  for (const entry of outbox.entries) {
    const category = categoryOf(entry.value);
    const status = statusOf(entry.value);
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    statusByCategory[category] ??= Object.fromEntries([...LEGACY_OUTBOX_STATUSES, "unknown"].map(value => [value, 0]));
    statusByCategory[category][status] += 1;
  }
  return {
    recallCache: {
      sourceHash: cache.sourceHash,
      sourceEntries: cache.entries.length,
      categoryCounts: countBy(cache.entries, entry => categoryOf(entry.value)),
    },
    writeOutbox: {
      sourceHash: outbox.sourceHash,
      sourceEntries: outbox.entries.length,
      statusCounts,
      categoryCounts: countBy(outbox.entries, entry => categoryOf(entry.value)),
      statusByCategory: Object.fromEntries(Object.entries(statusByCategory).sort(([left], [right]) => left.localeCompare(right))),
    },
    totalSourceEntries: cache.entries.length + outbox.entries.length,
  };
}

function safeLedgerPath(ledgerPath: string, sourcePaths: string[]): string {
  const absoluteLedger = resolve(ledgerPath);
  for (const sourcePath of sourcePaths) {
    const absoluteSource = resolve(sourcePath);
    const realSource = existsSync(absoluteSource) ? realpathSync(absoluteSource) : absoluteSource;
    const realLedger = existsSync(absoluteLedger) ? realpathSync(absoluteLedger) : absoluteLedger;
    if (absoluteLedger === absoluteSource || realLedger === realSource) {
      throw new Error("The import ledger must be a separate destination; source JSON files are read-only.");
    }
  }
  return absoluteLedger;
}

function readLedger(path: string): LegacyImportLedgerEntry[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const rows: LegacyImportLedgerEntry[] = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch (error) {
      throw new Error(`Legacy import ledger line ${index + 1} is corrupt; import stopped without changing sources.`, { cause: error });
    }
    if (!isObject(value) || value.format !== "xmemo-legacy-import" || value.version !== 1
      || typeof value.sourceKey !== "string" || typeof value.disposition !== "string") {
      throw new Error(`Legacy import ledger line ${index + 1} has an unsupported shape; import stopped.`);
    }
    rows.push(value as unknown as LegacyImportLedgerEntry);
  }
  return rows;
}

function writeLedgerAtomically(path: string, rows: LegacyImportLedgerEntry[]): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${randomUUID()}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    const text = rows.map(row => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
    writeSync(fd, text, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
    try { chmodSync(path, 0o600); } catch { /* Best effort on Windows. */ }
  } finally {
    try { unlinkSync(tmp); } catch { /* The file was renamed. */ }
  }
}

function safeCacheCopy(value: Record<string, unknown>): unknown {
  return sanitizeTransferValue(value);
}

function quarantine(
  base: Omit<LegacyImportLedgerEntry, "disposition">,
  entry: SourceEntry,
  reasonCode: string,
): LegacyImportLedgerEntry {
  return {
    ...base,
    disposition: "quarantined",
    reasonCode,
    quarantinePreview: sanitizeTransferValue(entry.value),
  };
}

function classifyCache(entry: SourceEntry, targetAccountRef: string | undefined): LegacyImportLedgerEntry {
  const base = sourceEntry("recall_cache", entry);
  if (!isObject(entry.value) || typeof entry.value.operation !== "string" || !("response" in entry.value)) {
    return quarantine(base, entry, "invalid_cache_entry");
  }
  if (!targetAccountRef) return quarantine(base, entry, "target_account_undetermined");
  const payload = safeCacheCopy(entry.value);
  return {
    ...base,
    disposition: "imported",
    importedKind: "cache_copy",
    provenance: { origin: "import", authority: "cloud" },
    targetAccountHash: sha256(targetAccountRef),
    payload,
  };
}

const REMEMBER_FIELDS = new Set(["content", "path", "bucket", "scope", "team_id", "memory_type", "importance", "source", "metadata"]);

function classifyOutbox(entry: SourceEntry, targetAccountRef: string | undefined): LegacyImportLedgerEntry {
  const base = sourceEntry("write_outbox", entry);
  if (!isObject(entry.value)) return quarantine(base, entry, "invalid_outbox_entry");
  const status = statusOf(entry.value);
  if (status === "sent") return { ...base, disposition: "skipped", reasonCode: "already_confirmed_sent" };
  if (status === "processing") return quarantine(base, entry, "processing_outcome_unknown");
  if (status === "unknown") return quarantine(base, entry, "invalid_outbox_status");
  if (!targetAccountRef) return quarantine(base, entry, "target_account_undetermined");
  const operation = entry.value.operation;
  const endpoint = entry.value.endpoint;
  const method = entry.value.method;
  const payload = entry.value.payload;
  if (operation !== "remember" || endpoint !== "/v1/remember" || method !== "POST"
    || !isObject(payload) || typeof payload.content !== "string"
    || typeof entry.value.idempotencyKey !== "string" || !entry.value.idempotencyKey.trim()) {
    return quarantine(base, entry, "unsupported_or_ambiguous_effect");
  }
  if (Object.keys(payload).some(key => !REMEMBER_FIELDS.has(key))) {
    return quarantine(base, entry, "unsupported_payload_field");
  }
  if (containsCredential(payload) || containsRawIdentity(payload) || containsCredential(entry.value.idempotencyKey)) {
    return quarantine(base, entry, "sensitive_data_in_payload");
  }
  return {
    ...base,
    disposition: "imported",
    importedKind: "held_outbox",
    targetAccountHash: sha256(targetAccountRef),
    storedStatus: "held",
    replayEnabled: false,
    effect: {
      operation,
      endpoint,
      method,
      payload: JSON.parse(JSON.stringify(payload)) as Record<string, unknown>,
      idempotencyKey: entry.value.idempotencyKey,
    },
  };
}

export function importLegacyJson(options: {
  recallCachePath: string;
  writeOutboxPath: string;
  ledgerPath: string;
  /** Explicit offline account binding. Without it, cache and unsent writes stay quarantined. */
  targetAccountRef?: string;
}): { imported: number; quarantined: number; skipped: number; sourceEntries: number; reconciled: true; ledgerPath: string } {
  const ledgerPath = safeLedgerPath(options.ledgerPath, [options.recallCachePath, options.writeOutboxPath]);
  const targetAccountRef = options.targetAccountRef?.trim() || undefined;
  const cache = readSource(options.recallCachePath, "recall_cache");
  const outbox = readSource(options.writeOutboxPath, "write_outbox");
  const prior = readLedger(ledgerPath);
  const ledgerRows = new Map(prior.map(row => [row.sourceKey, row]));
  const input: LegacyImportLedgerEntry[] = [
    ...cache.entries.map(entry => classifyCache(entry, targetAccountRef)),
    ...outbox.entries.map(entry => classifyOutbox(entry, targetAccountRef)),
  ];
  let imported = 0;
  let quarantined = 0;
  let skipped = 0;
  let ledgerChanged = false;
  input.forEach(row => {
    const previous = ledgerRows.get(row.sourceKey);
    if (previous && previous.disposition === "quarantined" && row.disposition === "imported") {
      ledgerRows.set(row.sourceKey, row);
      ledgerChanged = true;
      imported += 1;
      return;
    }
    if (previous && previous.disposition === "imported" && row.disposition === "imported"
      && previous.targetAccountHash !== row.targetAccountHash) {
      throw new Error("A previously imported legacy entry is bound to a different target account.");
    }
    if (previous) {
      skipped += 1;
      return;
    }
    if (row.disposition === "imported") imported += 1;
    else if (row.disposition === "quarantined") quarantined += 1;
    else skipped += 1;
    ledgerRows.set(row.sourceKey, row);
    ledgerChanged = true;
  });

  if (cache.sourceHash !== (readSource(options.recallCachePath, "recall_cache")).sourceHash
    || outbox.sourceHash !== (readSource(options.writeOutboxPath, "write_outbox")).sourceHash) {
    throw new Error("A legacy source changed during import; no ledger entry was written.");
  }
  if (ledgerChanged) writeLedgerAtomically(ledgerPath, [...ledgerRows.values()]);
  const sourceEntries = input.length;
  if (imported + quarantined + skipped !== sourceEntries) throw new Error("Legacy import count reconciliation failed.");
  return { imported, quarantined, skipped, sourceEntries, reconciled: true, ledgerPath };
}

export function readLegacyImportLedger(path: string): {
  entries: LegacyImportLedgerEntry[];
  quarantined: Array<Pick<LegacyImportLedgerEntry, "sourceKind" | "sourceHash" | "sourceOrdinal" | "sourceEntryHash" | "category" | "reasonCode" | "quarantinePreview">>;
} {
  const entries = readLedger(resolve(path));
  const quarantined = entries.filter(row => row.disposition === "quarantined").map(row => ({
    sourceKind: row.sourceKind,
    sourceHash: row.sourceHash,
    sourceOrdinal: row.sourceOrdinal,
    sourceEntryHash: row.sourceEntryHash,
    category: row.category,
    reasonCode: row.reasonCode,
    quarantinePreview: row.quarantinePreview,
  }));
  return { entries, quarantined };
}
