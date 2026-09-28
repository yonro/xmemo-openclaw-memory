# Local vault JSONL transfer and legacy cache migration

`src/local/jsonl-transfer.ts` defines the versioned `xmemo-local-record` JSONL format. Each line contains a record ID, title, body, safe metadata, and a SHA-256 content hash. The exporter reads only the trusted identity's current records; soft-deleted records, hard-deleted records, and records with a redaction barrier are omitted. It does not export owner, collection, sender, session, credential, or deletion-barrier fields. Sensitive metadata keys are removed and credential-like text is redacted before the exported hash is calculated.

```json
{"format":"xmemo-local-record","version":1,"recordId":"local-record-id","title":"Example","body":"Example body","metadata":{"topic":"notes"},"contentHash":"sha256:<64 lowercase hex characters>"}
```

Call `exportLocalJsonl(kernel, trustedIdentity)` to produce the document and `importLocalJsonl(jsonl, freshKernel, trustedIdentity)` to validate every line before creating imported-provenance records. The importer makes no network calls and never routes records through the write outbox. Reapplying the same document uses stable operation IDs and does not create duplicate records.

`src/local/legacy-json.ts` previews the v1 `recall-cache.json` and `write-outbox.json` stores without constructing or mutating `XMemoLocalCache`. Preview reports source hashes, categories, and outbox counts by status. `importLegacyJson` writes a separate, owner-only JSONL migration ledger at the caller-selected `ledgerPath`; it never writes either source file. `readLegacyImportLedger` exposes imported and quarantined rows. Quarantine rows contain the source file hash, entry ordinal, entry hash, category, and reason so the original entry remains available in its byte-identical source file without copying an unknown payload into the destination.

The caller must provide `targetAccountRef` only after independently binding the source cache directory to that account. Without this explicit offline binding, recall entries and unsent writes remain quarantined. Only `remember` + `POST /v1/remember` entries with a recognized payload are imported; imported writes are stored with status `held` and `replayEnabled: false`. Entries found in `processing` are quarantined because their cloud outcome is unknown; `sent` entries are counted as skipped. This slice has no tool wiring or cloud calls.
