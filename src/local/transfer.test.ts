import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importLegacyJson, previewLegacyJson, readLegacyImportLedger } from "./legacy-json.js";
import { LocalMemoryKernel, type TrustedLocalIdentityContext } from "./kernel.js";
import { exportLocalJsonl, importLocalJsonl } from "./jsonl-transfer.js";
import { containsCredential, sanitizeTransferText } from "./transfer-privacy.js";

const directAlice: TrustedLocalIdentityContext = { kind: "direct", actorRef: "transfer-test-alice" };
const directBob: TrustedLocalIdentityContext = { kind: "direct", actorRef: "transfer-test-bob" };

describe("local transfer", () => {
  const directories: string[] = [];
  const kernels: LocalMemoryKernel[] = [];

  afterEach(async () => {
    for (const kernel of kernels.splice(0)) await kernel.close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function temporaryDirectory(prefix: string): string {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    directories.push(directory);
    return directory;
  }

  async function openKernel(dataDirectory: string): Promise<LocalMemoryKernel> {
    const kernel = await LocalMemoryKernel.open({ dataDirectory });
    kernels.push(kernel);
    return kernel;
  }

  it("previews read-only, imports only determinable effects as held, quarantines ambiguities, and reruns idempotently", () => {
    const source = temporaryDirectory("xmemo-legacy-source-");
    const recallCachePath = join(source, "recall-cache.json");
    const writeOutboxPath = join(source, "write-outbox.json");
    const ledgerPath = join(temporaryDirectory("xmemo-legacy-target-"), "migration-ledger.jsonl");
    const cacheStore = {
      version: 1,
      entries: {
        cachedOne: { id: "cachedOne", operation: "recall_context", query: "q", paramsHash: "p", response: { items: [{ content: "cached copy" }] }, createdAt: 1, freshUntil: 2, maxStaleUntil: 3, hitCount: 0 },
      },
    };
    const outboxStore = {
      version: 1,
      records: {
        pendingSafe: { id: "pendingSafe", operation: "remember", endpoint: "/v1/remember", method: "POST", payload: { content: "held remember", bucket: "openclaw" }, idempotencyKey: "safe-idempotency-key", status: "pending", retryCount: 0, createdAt: 1, updatedAt: 1, autoReplay: true },
        processing: { id: "processing", operation: "remember", endpoint: "/v1/remember", method: "POST", payload: { content: "ambiguous in-flight" }, idempotencyKey: "processing-key", status: "processing", retryCount: 0, createdAt: 1, updatedAt: 1, autoReplay: true },
        held: { id: "held", operation: "record_event", endpoint: "/v1/timeline/events", method: "POST", payload: { content: "unknown effect", authorization: "secret-value-never-copy" }, idempotencyKey: "held-key", status: "held", retryCount: 0, createdAt: 1, updatedAt: 1, autoReplay: false },
        failed: { id: "failed", operation: "remember", endpoint: "/v1/remember", method: "POST", payload: { content: "failed but known" }, idempotencyKey: "failed-key", status: "failed", retryCount: 5, createdAt: 1, updatedAt: 1, autoReplay: true },
        sent: { id: "sent", operation: "remember", endpoint: "/v1/remember", method: "POST", payload: { content: "confirmed" }, idempotencyKey: "sent-key", status: "sent", retryCount: 0, createdAt: 1, updatedAt: 1, autoReplay: true },
      },
    };
    writeFileSync(recallCachePath, JSON.stringify(cacheStore), "utf8");
    writeFileSync(writeOutboxPath, JSON.stringify(outboxStore), "utf8");
    const sourceBefore = [readFileSync(recallCachePath), readFileSync(writeOutboxPath)];

    const preview = previewLegacyJson({ recallCachePath, writeOutboxPath });
    expect(preview).toMatchObject({
      recallCache: { sourceEntries: 1, categoryCounts: { recall_context: 1 } },
      writeOutbox: {
        sourceEntries: 5,
        statusCounts: { pending: 1, processing: 1, held: 1, failed: 1, sent: 1, unknown: 0 },
        categoryCounts: { record_event: 1, remember: 4 },
        statusByCategory: { remember: { pending: 1, processing: 1, held: 0, failed: 1, sent: 1, unknown: 0 } },
      },
      totalSourceEntries: 6,
    });
    expect(existsSync(ledgerPath)).toBe(false);
    expect(readFileSync(recallCachePath)).toEqual(sourceBefore[0]);
    expect(readFileSync(writeOutboxPath)).toEqual(sourceBefore[1]);

    const first = importLegacyJson({ recallCachePath, writeOutboxPath, ledgerPath, targetAccountRef: "account:verified" });
    expect(first).toMatchObject({ imported: 3, quarantined: 2, skipped: 1, sourceEntries: 6, reconciled: true });
    const ledger = readLegacyImportLedger(ledgerPath);
    expect(ledger.entries.filter(entry => entry.importedKind === "held_outbox")).toHaveLength(2);
    expect(ledger.entries.filter(entry => entry.importedKind === "held_outbox").every(entry =>
      entry.storedStatus === "held" && entry.replayEnabled === false && entry.targetAccountHash?.startsWith("sha256:"),
    )).toBe(true);
    expect(ledger.entries.find(entry => entry.importedKind === "cache_copy")).toMatchObject({
      provenance: { origin: "import", authority: "cloud" },
    });
    expect(ledger.quarantined.map(entry => entry.reasonCode)).toContain("processing_outcome_unknown");
    expect(ledger.quarantined.map(entry => entry.reasonCode)).toContain("unsupported_or_ambiguous_effect");
    expect(JSON.stringify(ledger)).not.toContain("secret-value-never-copy");
    expect(JSON.stringify(ledger)).not.toContain("account:verified");

    const ledgerBeforeRerun = readFileSync(ledgerPath);
    const second = importLegacyJson({ recallCachePath, writeOutboxPath, ledgerPath, targetAccountRef: "account:verified" });
    expect(second).toMatchObject({ imported: 0, quarantined: 0, skipped: 6, sourceEntries: 6, reconciled: true });
    expect(() => importLegacyJson({ recallCachePath, writeOutboxPath, ledgerPath, targetAccountRef: "account:other" }))
      .toThrow(/different target account/);
    expect(readFileSync(ledgerPath)).toEqual(ledgerBeforeRerun);
    expect(readFileSync(recallCachePath)).toEqual(sourceBefore[0]);
    expect(readFileSync(writeOutboxPath)).toEqual(sourceBefore[1]);
  });

  it("quarantines legacy entries when no trusted account binding is supplied", () => {
    const source = temporaryDirectory("xmemo-legacy-unbound-");
    const recallCachePath = join(source, "recall-cache.json");
    const writeOutboxPath = join(source, "write-outbox.json");
    const ledgerPath = join(temporaryDirectory("xmemo-legacy-unbound-target-"), "migration-ledger.jsonl");
    writeFileSync(recallCachePath, JSON.stringify({ version: 1, entries: { c: { operation: "search", response: [] } } }));
    writeFileSync(writeOutboxPath, JSON.stringify({ version: 1, records: { p: { id: "p", operation: "remember", endpoint: "/v1/remember", method: "POST", payload: { content: "write" }, idempotencyKey: "k", status: "pending" } } }));
    const sourceBefore = [readFileSync(recallCachePath), readFileSync(writeOutboxPath)];

    const result = importLegacyJson({ recallCachePath, writeOutboxPath, ledgerPath });
    expect(result).toMatchObject({ imported: 0, quarantined: 2, skipped: 0, sourceEntries: 2, reconciled: true });
    expect(readLegacyImportLedger(ledgerPath).quarantined.map(row => row.reasonCode))
      .toEqual(["target_account_undetermined", "target_account_undetermined"]);
    expect(importLegacyJson({ recallCachePath, writeOutboxPath, ledgerPath, targetAccountRef: "account:now-bound" }))
      .toMatchObject({ imported: 2, quarantined: 0, skipped: 0, sourceEntries: 2, reconciled: true });
    expect(importLegacyJson({ recallCachePath, writeOutboxPath, ledgerPath, targetAccountRef: "account:now-bound" }))
      .toMatchObject({ imported: 0, quarantined: 0, skipped: 2, sourceEntries: 2, reconciled: true });
    expect(readFileSync(recallCachePath)).toEqual(sourceBefore[0]);
    expect(readFileSync(writeOutboxPath)).toEqual(sourceBefore[1]);
  });

  it("detects and redacts credential formats without copying quarantined payloads", async () => {
    const credentials = [
      "xmemo_S3CR3TKEYS3CR3TKEYS3CR3TKEY",
      "sk-1234567890abcdefghijklmnop",
      "ghp_1234567890abcdefghijklmnopqrst",
      "gho_1234567890abcdefghijklmnopqrst",
      "github_pat_1234567890abcdefghijklmnopqrst",
      "xoxb-1234567890-1234567890-1234567890",
      "AKIA1234567890123456",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.signature123456",
      "Bearer abcdefghijklmnop",
      "api_key=supersecretvalue",
    ];
    for (const credential of credentials) {
      expect(containsCredential(credential), credential).toBe(true);
      expect(sanitizeTransferText(`value ${credential} end`)).not.toContain(credential);
    }

    const token = credentials[0];
    const source = temporaryDirectory("xmemo-legacy-secret-source-");
    const recallCachePath = join(source, "recall-cache.json");
    const writeOutboxPath = join(source, "write-outbox.json");
    const ledgerPath = join(temporaryDirectory("xmemo-legacy-secret-target-"), "migration-ledger.jsonl");
    writeFileSync(recallCachePath, JSON.stringify({
      version: 1,
      entries: { cached: { operation: "recall_context", response: { items: [{ content: `cached ${token}` }] } } },
    }));
    writeFileSync(writeOutboxPath, JSON.stringify({
      version: 1,
      records: {
        pending: {
          operation: "remember",
          endpoint: "/v1/remember",
          method: "POST",
          payload: { content: `held ${token}` },
          idempotencyKey: "safe-idempotency-key",
          status: "pending",
        },
      },
    }));
    const sourceBefore = [readFileSync(recallCachePath), readFileSync(writeOutboxPath)];

    const preview = previewLegacyJson({ recallCachePath, writeOutboxPath });
    expect(JSON.stringify(preview)).not.toContain(token);
    const imported = importLegacyJson({ recallCachePath, writeOutboxPath, ledgerPath, targetAccountRef: "account:verified" });
    expect(imported).toMatchObject({ imported: 1, quarantined: 1, skipped: 0, sourceEntries: 2, reconciled: true });
    const ledgerText = readFileSync(ledgerPath, "utf8");
    expect(ledgerText).not.toContain(token);
    const ledger = readLegacyImportLedger(ledgerPath);
    expect(ledger.entries.find(entry => entry.importedKind === "cache_copy")?.payload)
      .toMatchObject({ response: { items: [{ content: "cached [REDACTED]" }] } });
    expect(ledger.quarantined).toEqual([expect.objectContaining({
      sourceKind: "write_outbox",
      category: "remember",
      reasonCode: "sensitive_data_in_payload",
    })]);
    expect(ledger.quarantined[0]).not.toHaveProperty("quarantinePreview");
    expect(ledger.entries.find(entry => entry.disposition === "quarantined"))
      .not.toHaveProperty("effect");
    expect(readFileSync(recallCachePath)).toEqual(sourceBefore[0]);
    expect(readFileSync(writeOutboxPath)).toEqual(sourceBefore[1]);

    const cacheEntry = ledger.entries.find(entry => entry.importedKind === "cache_copy");
    const outboxEntry = ledger.entries.find(entry => entry.sourceKind === "write_outbox");
    expect(cacheEntry?.targetAccountHash).toBeTruthy();
    expect(outboxEntry?.disposition).toBe("quarantined");
    const oldLedgerRows = ledger.entries.map(entry => {
      if (entry.importedKind === "cache_copy") {
        return { ...entry, payload: { response: { items: [{ content: `cached ${token}` }] } } };
      }
      if (entry.sourceKind === "write_outbox") {
        return {
          ...entry,
          disposition: "imported" as const,
          targetAccountHash: cacheEntry?.targetAccountHash,
          importedKind: "held_outbox" as const,
          storedStatus: "held" as const,
          replayEnabled: false as const,
          effect: {
            operation: "remember",
            endpoint: "/v1/remember",
            method: "POST",
            payload: { content: `held ${token}` },
            idempotencyKey: "safe-idempotency-key",
          },
        };
      }
      return entry;
    });
    writeFileSync(ledgerPath, `${oldLedgerRows.map(row => JSON.stringify(row)).join("\n")}\n`);
    const refreshed = importLegacyJson({ recallCachePath, writeOutboxPath, ledgerPath, targetAccountRef: "account:verified" });
    expect(refreshed).toMatchObject({ imported: 0, quarantined: 1, skipped: 1, sourceEntries: 2, reconciled: true });
    const refreshedText = readFileSync(ledgerPath, "utf8");
    expect(refreshedText).not.toContain(token);
    expect(readLegacyImportLedger(ledgerPath).quarantined[0]).toMatchObject({ reasonCode: "sensitive_data_in_payload" });
    expect(readFileSync(recallCachePath)).toEqual(sourceBefore[0]);
    expect(readFileSync(writeOutboxPath)).toEqual(sourceBefore[1]);

    const sourceKernel = await openKernel(temporaryDirectory("xmemo-jsonl-secret-source-"));
    await sourceKernel.create({ body: `export ${token}`, operationId: "transfer-create-xmemo-secret" }, directAlice);
    const jsonl = await exportLocalJsonl(sourceKernel, directAlice);
    expect(jsonl).not.toContain(token);
    expect(JSON.parse(jsonl.trim())).toMatchObject({ body: "export [REDACTED]" });
  });

  it("round-trips active JSONL records by content hash while excluding deleted, redacted, identity, and credential data", async () => {
    const source = await openKernel(temporaryDirectory("xmemo-jsonl-source-"));
    const stable = await source.create({
      recordId: "transfer-record-stable",
      title: "portable title",
      body: "portable body with api_key=supersecretvalue and session_id=raw-session-body-4321",
      metadata: {
        safe: "retained",
        source_session_id: "raw-session-123",
        nested: { senderId: "raw-sender-456", accessToken: "nested-secret-value" },
      },
      operationId: "transfer-create-stable",
    }, directAlice);
    const redacted = await source.create({ body: "redacted-canary-bad8", operationId: "transfer-create-redacted" }, directAlice);
    await source.redact(redacted.recordId, { baseRevision: redacted.revisionId, fields: ["body"], operationId: "transfer-redact" }, directAlice);
    const deleted = await source.create({ body: "hard-delete-canary-c205", operationId: "transfer-create-deleted" }, directAlice);
    await source.hardDelete(deleted.recordId, { baseRevision: deleted.revisionId, operationId: "transfer-hard-delete" }, directAlice);

    const jsonl = await exportLocalJsonl(source, directAlice);
    expect(jsonl.trim().split("\n")).toHaveLength(1);
    expect(Object.keys((await source.exportRecords(directAlice))[0]).sort())
      .toEqual(["body", "metadata", "recordId", "title"]);
    expect(jsonl).not.toContain("raw-session-123");
    expect(jsonl).not.toContain("raw-sender-456");
    expect(jsonl).not.toContain("nested-secret-value");
    expect(jsonl).not.toContain("supersecretvalue");
    expect(jsonl).not.toContain("raw-session-body-4321");
    expect(jsonl).not.toContain("redacted-canary-bad8");
    expect(jsonl).not.toContain("hard-delete-canary-c205");

    const fresh = await openKernel(temporaryDirectory("xmemo-jsonl-fresh-"));
    const imported = await importLocalJsonl(jsonl, fresh, directBob);
    expect(imported).toEqual({ imported: 1, lines: 1 });
    const copy = await fresh.get(stable.recordId, directBob);
    const line = JSON.parse(jsonl.trim()) as { contentHash: string; metadata: Record<string, unknown>; body: string };
    expect(copy.origin).toBe("import");
    expect(copy.authority).toBe("local");
    expect(copy.revision.contentHash).toBe(line.contentHash);
    expect(copy.body).toBe(line.body);
    expect(copy.metadata).toEqual(line.metadata);
    expect(await importLocalJsonl(jsonl, fresh, directBob)).toEqual({ imported: 1, lines: 1 });
    expect(await fresh.exportRecords(directBob)).toHaveLength(1);
    await expect(fresh.get(stable.recordId, directAlice)).rejects.toMatchObject({ category: "not_found" });
  });

  it("validates all JSONL hashes and duplicate ids before creating any record", async () => {
    const source = await openKernel(temporaryDirectory("xmemo-jsonl-invalid-source-"));
    await source.create({ recordId: "valid-jsonl-record", body: "valid body", operationId: "valid-jsonl-op" }, directAlice);
    const jsonl = await exportLocalJsonl(source, directAlice);
    const fresh = await openKernel(temporaryDirectory("xmemo-jsonl-invalid-target-"));
    await expect(importLocalJsonl(`${jsonl}${jsonl}`, fresh, directBob)).rejects.toThrow(/repeats recordId/);
    await expect(fresh.get("valid-jsonl-record", directBob)).rejects.toMatchObject({ category: "not_found" });
    const row = JSON.parse(jsonl.trim()) as Record<string, unknown>;
    row.contentHash = `sha256:${createHash("sha256").update(randomUUID()).digest("hex")}`;
    await expect(importLocalJsonl(`${JSON.stringify(row)}\n`, fresh, directBob)).rejects.toThrow(/content hash/);
    await expect(fresh.get("valid-jsonl-record", directBob)).rejects.toMatchObject({ category: "not_found" });
  });
});
