# ADR-L02: Record identity, revisions, deletion, and receipts

- Status: **Draft for human and XMemo server-owner review; not frozen**
- Date: 2026-09-28
- Scope: P1b prerequisite for Hybrid plan v2 §§5.3, 9.2–9.3, 19.1–19.3. This document proposes data and tool contracts only; it does not implement them.
- Related drafts: [ADR-H01](ADR-H01-AUTHORITY-BINDING-OUTBOUND-DRAFT.md), [ADR-Q01](ADR-Q01-RETRIEVAL-CAPTURE-EVALUATION.md), and [P1a platform evidence](ADR-L01-SQLITE-PLATFORM-PROBE.md).

## Decision status and invariants

No schema, deletion guarantee, or tool name is accepted by this draft. The options below are proposals for the reviewer to take to the human product owner and the XMemo server synchronization owner. P1b implementation remains unreleased until both ADRs are frozen by those owners.

The draft follows these plan constraints:

- A logical record has a stable ID and explicit origin, authority, cloud binding, and local/remote revision state. Running in “local” or “hybrid” mode does not itself determine who owns a record.
- A revision update names its base. A stale base creates a conflict; wall-clock last-write-wins is not a conflict policy.
- A retry reuses the operation ID created and persisted before the first send. A lost response is an unknown outcome until the server resolves that same operation ID.
- Delete, hard delete, redaction, synchronization, and indexing are distinct states. No receipt may claim cloud confirmation or complete erasure without evidence for that claim.
- Existing tool names and accepted parameters remain compatible. New result fields are optional for old clients.

## Record identity and serialization proposal

The field names below follow Hybrid plan v2 §19.2. This is a wire/storage proposal, not a migration schema.

| Field | Proposed meaning | Constraints |
|---|---|---|
| `record_id` | Immutable logical identity generated when the record is first created. | Use a high-entropy opaque identifier. Keep a separate `(binding_id, remote_id)` mapping; never assume the local ID and cloud ID are equal. Do not encode content, owner names, or paths in it. |
| `origin` | Immutable creation provenance such as `local`, `cloud`, or `import`, plus a non-secret source reference where needed. | Provenance is not authorization. Editing or sharing a record does not rewrite its origin. |
| `authority` | The policy allowed to accept the next authoritative revision: provisional values `local`, `cloud`, or `shared`. | Do not infer it from a `local`/`hybrid` mode, current token, or `agentId`. A transition requires an explicit operation and policy check. The exact value set needs server-owner review. |
| `owner_ref` / `collection_ref` | Opaque trusted principal/vault and collection identifiers. | Populate only from the local vault or authenticated server binding. Never derive them from body text or caller metadata. Whether local vault IDs map to a server owner is open in ADR-H01. |
| `binding_id` | Stable, local opaque reference to the service/account/tenant/collection relationship used for replication. | `null` for local-only records. It contains no API key or bearer token. A changed account or service is a different binding. |
| `local_revision` | Monotonic integer for the local branch of one record. | It orders revisions only within that vault/branch; it is not comparable to a remote revision or another device's counter. |
| `remote_revision` | Opaque server revision token, optionally paired with server epoch/protocol version. | Treat as an equality/precondition token, not a timestamp or locally ordered number. `null` means no remote revision is known. |
| `revision_id` | Opaque ID for one immutable content/state revision. | Every accepted edit, merge, restore, delete, or redaction creates a new revision or deletion barrier. |
| `base_revision` | The local and remote revision references observed by the writer before an update. | Required for new version-aware writes. It is a precondition, not a client-selected “winner.” |
| `operation_id` | Stable idempotency identity for one mutation across attempts and restarts. | Persist before sending. Every retry, reconciliation, or response lookup for that mutation uses the same value. |

Illustrative local-created record envelope:

```json
{
  "schema_version": 1,
  "record_id": "rec_opaque_uuid",
  "origin": { "kind": "local", "source": "user", "created_at": "2026-09-28T00:00:00Z" },
  "authority": "local",
  "owner_ref": { "kind": "local_vault", "id": "vault_opaque_id" },
  "collection_ref": "collection_opaque_id",
  "binding_id": null,
  "local_revision": 1,
  "remote_revision": null,
  "revision": {
    "revision_id": "rev_opaque_id",
    "parents": [],
    "base_revision": null,
    "operation_id": "op_opaque_id",
    "content_hash": "sha256:..."
  }
}
```

The example leaves out body, chunks, and index rows. A content hash is useful for integrity and equality, but it can reveal low-entropy content by guessing; hard-delete/redaction retention of hashes must be decided with the server owner. The serialization must never put credentials, raw sender/session identifiers, or authorization decisions in searchable metadata.

## Revision and conflict proposal

1. Create starts a branch with `base_revision=null`. Update includes the current `base_revision` and a persisted `operation_id`.
2. If the base still matches, accept the write as a new child revision and return the server's new opaque `remote_revision` when applicable.
3. If the base is stale, preserve both branches and their common base, return a conflict receipt, and require an explicit resolution that creates a new revision. Do not silently overwrite either branch.
4. A merge has both parent revision IDs and its own operation ID. Device wall-clock order may be recorded for display, but never selects authority.
5. Restore creates a new revision from an explicitly selected historical revision and a current base. It does not move a pointer backward or resurrect a tombstoned row by replaying an old edit.
6. For an old client with no `base_revision`, label the write `unversioned_write`. A trusted, still-current exact-read context may be considered as a compatibility bridge only if the server owner proves the context and conditional-write semantics. Otherwise the receipt must say that stale-write detection was unavailable; do not imply concurrent-update safety.

`local_revision` and `remote_revision` remain separate even when a server accepts a local write. A server revision is scoped to the binding and protocol that issued it; changing the binding invalidates that comparison context.

## Delete, hard-delete, and redaction proposal

| Operation | User-visible behavior | Data and synchronization behavior |
|---|---|---|
| `soft_delete` | Remove from default search/get immediately; allow explicit restore if retention policy permits. | Keep the recoverable body/revisions under the configured retention policy, create a deletion revision/tombstone, and sync it when authorized. A restore is a new revision based on the current deletion state. |
| `hard_delete` | Stop returning the record and report separate local-removal and remote-confirmation status. | Remove readable body/history from active storage, recall/FTS/vector projections, capture/job payloads, and unsent create/update payloads. Persist a content-free deletion barrier sufficient to stop old retries or late responses from restoring the body. Send a remote delete when a binding exists; do not call it complete until the defined backup boundary is met. |
| `redact` | Replace selected sensitive content with an explicit redacted state; do not expose the old value through history or search. | Remove the redacted bytes from prior readable revisions, payloads, and projections; preserve only approved non-content audit metadata. Sync a redaction barrier where allowed. A body hash may itself be sensitive and must follow the same retention decision. |

For all three operations, deletion visibility must be enforced before physical cleanup finishes. Old in-flight results, stale outbox entries, restored backups, or old vector rows must not make the content visible again. The exact treatment of existing backups is an open human decision in ADR-H01. No interface may promise physical erasure from SSD remapping or an immutable backup unless that guarantee is implemented and verified.

## Receipt and error proposal

Write receipts should be structured so local commit is not confused with cloud sync or index readiness:

```json
{
  "operation_id": "op_opaque_id",
  "record_id": "rec_opaque_uuid",
  "revision": { "local": 3, "remote": "opaque-server-token" },
  "storage_status": "committed_local",
  "sync_status": "pending_sync",
  "index_status": "ready",
  "error": null
}
```

Proposed status sets:

- `storage_status`: `committed_local`, `not_committed`, or `unknown` when the caller cannot determine whether a durable transaction completed. Resolve an unknown outcome using the same operation ID before creating a replacement operation.
- `sync_status`: `local_only`, `pending_sync`, `sending`, `synced`, `conflict`, `rejected`, `held_auth`, `held_policy`, or `outcome_unknown`.
- `index_status`: `ready`, `pending`, or `failed`; a pending vector projection must not hide a committed record from exact get or full-text search.
- Read results add `source`, `revision`, `coverage`, `stale`, and `conflict`. `coverage` names sources actually queried and unavailable sources; it cannot imply cloud completeness without a successful cloud query.

Errors should carry a stable `category`, `retryable`, optional `retry_after_ms`, and optional `operation_id`/`conflict_id`. Candidate categories are `validation`, `not_found`, `auth_required`, `permission_denied`, `conflict`, `quota`, `rate_limited`, `server_unavailable`, `network_timeout`, `cancelled`, `storage_busy`, `storage_full`, `corrupt_store`, `index_unavailable`, and `unsupported_operation`. Authentication, permission, conflict, corruption, and validation errors are not blind-retry cases. A timeout after a write may mean the server committed it, so its outcome remains unknown until idempotency lookup resolves it.

## Tool compatibility proposal

| Existing or proposed entry | Draft mapping | Compatibility condition |
|---|---|---|
| `memory_store` | `create` plus a structured receipt. | Keep current parameters; append optional receipt fields. In Local, the local transaction is success even when sync is pending. In Hybrid, the outbox operation is committed with the record. |
| `memory_get`, `xmemo_memory_get` | Exact record/revision read. | Keep existing ID/path and pagination behavior. Do not return a similar record as an exact-ID result. Add optional source/revision/coverage/conflict fields. |
| `memory_search`, `xmemo_memory_list`, SearchManager | Search/list under one identity, deletion, and coverage policy. | Keep existing names/parameters; default reads hide soft-deleted data. An unavailable source is partial coverage, not an empty result. |
| `xmemo_memory_update` | `update(base_revision)`. | Add an optional version precondition for new clients. Old callers remain accepted but are explicitly marked `unversioned_write` unless a trusted current read proves the base. |
| `memory_forget` | Existing `mode` maps to `soft_delete`, `hard_delete`, or `redact`. | Preserve the existing default `soft_delete`. Do not claim remote or backup completion from an accepted HTTP response alone. |
| Proposed history/restore pair | Candidate names: `xmemo_memory_history` + `xmemo_memory_restore` (recommended); `memory_history` + `memory_restore`; or one `xmemo_memory_revision` tool with an action. | Names, permissions, pagination, and cloud capability gating need review. The recommended pair matches the explicit XMemo names used by existing update/list/get tools. |
| `xmemo_restart_snapshot_restore` | Remains session snapshot restore. | It is not a record revision restore and must not be relabeled as one. |

## 1.0.18 code gap table

Line references below are from the unchanged plugin code at P1a commit `47bb84a`; they document the current Cloud plugin and do not propose code edits in this task.

| Contract area | Current 1.0.18 evidence | Gap against this draft |
|---|---|---|
| Storage boundary | [`src/client.ts:1–2`](../../src/client.ts#L1-L2) describes a thin remote REST client with no local vector store. [`src/local-cache.ts:26–59`](../../src/local-cache.ts#L26-L59) contains recall-cache entries and write-outbox records. | No authoritative local record/revision store or atomic record-plus-operation transaction exists. The JSON outbox is not a local memory vault. |
| Record identity | [`src/client.ts:91–120`](../../src/client.ts#L91-L120) defines `XMemoMemory` and update request fields. | `id` is present, but origin, authority, binding, owner/collection references, local/remote revisions, parent revision, and base revision are absent from the client contract. |
| Create and idempotency | [`src/tools.ts:950–979`](../../src/tools.ts#L950-L979) writes to `/v1/remember` via `resilientWrite`; [`src/resilient-client.ts:281–324`](../../src/resilient-client.ts#L281-L324) creates a request idempotency key and queues transient failures. | This protects a retried cloud request, but does not create a local authoritative record, revision chain, or server-verified revision receipt. |
| Update precondition | [`src/client.ts:106–120,808–817`](../../src/client.ts#L106-L120) accepts mutable fields and sends PATCH without a `base_revision`; [`src/tools.ts:1841–1866`](../../src/tools.ts#L1841-L1866) builds the patch and calls it directly. | No conditional revision update or `unversioned_write` receipt is exposed. Concurrent-write safety is not established. |
| Delete and redaction | [`src/client.ts:122–126,820–829`](../../src/client.ts#L122-L126) names three request modes but treats the response as `unknown`; [`src/tools.ts:1005–1069`](../../src/tools.ts#L1005-L1069) exposes the modes and then returns `action: deleted`. | The interface does not prove tombstone, restore, hard-delete, backup, redaction, projection, or remote-confirmation behavior. The success wording is not a deletion receipt contract. |
| Write/read receipts | [`src/resilient-client.ts:21–24`](../../src/resilient-client.ts#L21-L24) distinguishes only `synced`, `queued`, and message-only `error`; [`src/tools.ts:981–997`](../../src/tools.ts#L981-L997) returns created ID or outbox status. | Storage, sync, and index states are not represented independently; no revision, conflict, coverage, or unknown-write outcome contract exists. |
| History and restore | [`src/client.ts:905–925`](../../src/client.ts#L905-L925) and [`src/tools.ts:1951–2008`](../../src/tools.ts#L1951-L2008) restore restart snapshots. | Snapshot restore is not record history or a revision-based restore. No memory history/restore API is present. |
| Error taxonomy | [`src/resilient-client.ts:32–50`](../../src/resilient-client.ts#L32-L50) classifies transient errors for retries; [`src/resilient-client.ts:481–511`](../../src/resilient-client.ts#L481-L511) returns queued/error prose. | Retry routing exists, but stable caller-facing categories, conflict IDs, revision mismatch, storage-full/corruption, and ambiguous write outcomes are not a unified API contract. |

## Freeze checklist

The server synchronization owner must confirm how server IDs/revisions, conditional updates, idempotency lookup, tombstone epochs, restore, and hard-delete receipts map to real endpoints. A product owner must resolve the linked ADR-H01 decisions. Until then, all names and values here remain draft proposals and no P1b schema or tool implementation is authorized by this document.
