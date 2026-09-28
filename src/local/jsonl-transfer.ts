import { createHash } from "node:crypto";
import type { LocalExportRecord, LocalMemoryKernel, TrustedLocalIdentityContext } from "./kernel.js";
import { sanitizeTransferText, sanitizeTransferValue } from "./transfer-privacy.js";

export const LOCAL_JSONL_FORMAT = "xmemo-local-record" as const;
export const LOCAL_JSONL_VERSION = 1 as const;

export type LocalJsonlRecord = {
  format: typeof LOCAL_JSONL_FORMAT;
  version: typeof LOCAL_JSONL_VERSION;
  recordId: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  contentHash: string;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("JSONL values must be JSON serializable.");
  return encoded;
}

function contentHash(title: string, body: string, metadata: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(canonical({ title, body, metadata, deleted: false })).digest("hex")}`;
}

function toJsonlRecord(record: LocalExportRecord): LocalJsonlRecord {
  const title = sanitizeTransferText(record.title);
  const body = sanitizeTransferText(record.body);
  const metadata = sanitizeTransferValue(record.metadata) as Record<string, unknown>;
  return {
    format: LOCAL_JSONL_FORMAT,
    version: LOCAL_JSONL_VERSION,
    recordId: record.recordId,
    title,
    body,
    metadata,
    contentHash: contentHash(title, body, metadata),
  };
}

export async function exportLocalJsonl(
  kernel: LocalMemoryKernel,
  identity: TrustedLocalIdentityContext,
): Promise<string> {
  const records = await kernel.exportRecords(identity);
  return exportLocalRecordsJsonl(records);
}

export function exportLocalRecordsJsonl(records: LocalExportRecord[]): string {
  return records.map(record => JSON.stringify(toJsonlRecord(record))).join("\n") + (records.length ? "\n" : "");
}

function parseJsonlRecord(line: string, lineNumber: number): LocalJsonlRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`JSONL line ${lineNumber} is not valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`JSONL line ${lineNumber} must be an object.`);
  }
  const value = parsed as Record<string, unknown>;
  if (value.format !== LOCAL_JSONL_FORMAT || value.version !== LOCAL_JSONL_VERSION
    || typeof value.recordId !== "string" || !value.recordId.trim()
    || typeof value.title !== "string" || typeof value.body !== "string"
    || !value.metadata || typeof value.metadata !== "object" || Array.isArray(value.metadata)
    || typeof value.contentHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.contentHash)) {
    throw new Error(`JSONL line ${lineNumber} does not match ${LOCAL_JSONL_FORMAT} v${LOCAL_JSONL_VERSION}.`);
  }
  const metadata = sanitizeTransferValue(value.metadata) as Record<string, unknown>;
  const title = sanitizeTransferText(value.title);
  const body = sanitizeTransferText(value.body);
  if (canonical(metadata) !== canonical(value.metadata) || title !== value.title || body !== value.body) {
    throw new Error(`JSONL line ${lineNumber} contains fields excluded by the export privacy rules.`);
  }
  const expectedHash = contentHash(title, body, metadata);
  if (value.contentHash !== expectedHash) throw new Error(`JSONL line ${lineNumber} content hash does not match.`);
  return value as LocalJsonlRecord;
}

export async function importLocalJsonl(
  jsonl: string,
  kernel: LocalMemoryKernel,
  identity: TrustedLocalIdentityContext,
): Promise<{ imported: number; lines: number }> {
  const lines = jsonl.split(/\r?\n/).filter(line => line.trim().length > 0);
  const records = lines.map((line, index) => parseJsonlRecord(line, index + 1));
  const seen = new Set<string>();
  for (let index = 0; index < records.length; index += 1) {
    if (seen.has(records[index].recordId)) throw new Error(`JSONL repeats recordId on line ${index + 1}.`);
    seen.add(records[index].recordId);
  }

  for (const record of records) {
    const operationId = `jsonl-import-${createHash("sha256").update(canonical(record)).digest("hex")}`;
    await kernel.importRecord({
      recordId: record.recordId,
      title: record.title,
      body: record.body,
      metadata: record.metadata,
      operationId,
    }, identity);
  }
  return { imported: records.length, lines: records.length };
}
