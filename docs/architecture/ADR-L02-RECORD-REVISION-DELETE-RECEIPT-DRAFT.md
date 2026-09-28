# ADR-L02: Record identity, revisions, deletion, and receipts

- Status: **Accepted – local scope; server contracts pending before P4a**
- Date: 2026-09-28
- Scope: Accepted local-vault contract for Hybrid plan v2 §§5.3, 9.2–9.3, and 19.1–19.3. It defines a prerequisite for P1b but does not implement it. Server protocol details listed below remain open until P4a.
- Related decisions: [ADR-H01](ADR-H01-AUTHORITY-BINDING-OUTBOUND-DRAFT.md), [ADR-Q01](ADR-Q01-RETRIEVAL-CAPTURE-EVALUATION.md), and [P1a platform evidence](ADR-L01-SQLITE-PLATFORM-PROBE.md).

## Decision record

Recorded 2026-09-28 from the human decision in review-chat message `1db52b5a-7d2b-480e-b693-f316a202db1e` (“全按照推荐的即可”), replying to the reviewer decision register `b9649e54`. The reviewer supplied the room-level and 30-day defaults below; the human may change either value.

| Decision | Accepted value and scope |
|---|---|
| Group-chat isolation | Private by speaker by default. Sharing requires an explicitly configured group collection and opt-in per room. Missing trusted group-member or speaker identity fails closed. Room-level opt-in is the reviewer’s narrower default; the human may change it to workspace-level opt-in. |
| `X-Memory-OS-Agent-ID` | Keep the configured value (default `openclaw`); record the trusted host agent only as provenance. |
| Team-copy offline lease | Use a server-issued lease capped at 24 hours. The server owner sets the final cap before P4a and may only shorten it. |
| `hard_delete` and backups | Immediately clear active local storage and all local projections. Immutable backups may retain data for at most 30 days; reapply deletion barriers before restoring a backup. Thirty days is the reviewer’s default and the human may change it. |
| Server synchronization ownership | Use one accountable service owner with a security/privacy co-reviewer. The people remain unassigned. |
| Sealed evaluation set | An independent human data owner writes and labels it. The person remains unassigned and must be named before any sealed evaluation run, no later than the P2b quality gate and before P7. |
| CI and platform evidence | Human-authorized on 2026-09-28 in review chat `7b191229`, limited to branch `ci/sqlite-platform-probe`; no `master` or tag pushes, PRs, or releases. Run [36372400347](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36372400347) failed during pnpm setup; corrected runs [36373750828](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36373750828) and [36374695938](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36374695938), with per-job results and failures, are recorded in ADR-L01. |

Only the local-vault semantics in this ADR are accepted. Remote revision/epoch formats, server conditional-write and idempotency behavior, tombstone feeds, remote deletion receipts, binding identity proof, key-change evidence, lease issuance/revocation service levels, and post-delete content-hash retention remain pending for P4a; P1b does not depend on those server decisions.

## Accepted local decision and invariants

This ADR freezes the local record, revision, deletion, receipt, error, and tool-compatibility contract below. It does not claim that the current 1.0.18 Cloud plugin implements that contract, and it does not settle the server contracts listed above.

The accepted local contract follows these plan constraints:

- A logical record has a stable ID and explicit origin, authority, cloud binding, and local/remote revision state. Running in “local” or “hybrid” mode does not itself determine who owns a record.
- A revision update names its base. A stale base creates a conflict; wall-clock last-write-wins is not a conflict policy.
- A retry reuses the operation ID created and persisted before the first send. A lost response is an unknown outcome until the server resolves that same operation ID.
- Delete, hard delete, redaction, synchronization, and indexing are distinct states. No receipt may claim cloud confirmation or complete erasure without evidence for that claim.
- Existing tool names and accepted parameters remain compatible. New result fields are optional for old clients.

## Record identity and serialization

The field names below follow Hybrid plan v2 §19.2 and are accepted for the local vault. This contract is not a migration schema. Server-owned identity and revision formats remain pending until P4a.

| Field | Accepted local meaning | Constraints |
|---|---|---|
| `record_id` | Immutable logical identity generated when the record is first created. | Use a high-entropy opaque identifier. Keep a separate `(binding_id, remote_id)` mapping; never assume the local ID and cloud ID are equal. Do not encode content, owner names, or paths in it. |
| `origin` | Immutable creation provenance such as `local`, `cloud`, or `import`, plus a non-secret source reference where needed. | Provenance is not authorization. Editing or sharing a record does not rewrite its origin. |
| `authority` | The policy allowed to accept the next authoritative revision, represented locally as `local`, `cloud`, or `shared`. | Do not infer it from a `local`/`hybrid` mode, current token, or `agentId`. A transition requires an explicit operation and policy check. Server mapping remains pending until P4a. |
| `owner_ref` / `collection_ref` | Opaque trusted principal/vault and collection identifiers. | Populate only from the local vault or authenticated server binding. Never derive them from body text or caller metadata. Whether local vault IDs map to a server owner is open in ADR-H01. |
| `binding_id` | Stable, local opaque reference to the service/account/tenant/collection relationship used for replication. | `null` for local-only records. It contains no API key or bearer token. A changed account or service is a different binding. |
| `local_revision` | Monotonic integer for the local branch of one record. | It orders revisions only within that vault/branch; it is not comparable to a remote revision or another device's counter. |
| `remote_revision` | Opaque server revision token, if one is known. | The token and epoch format are pending server-owner confirmation before P4a. Treat it as an equality/precondition token, not a timestamp or locally ordered number. `null` means no remote revision is known. |
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

The example leaves out body, chunks, and index rows. A content hash is useful for integrity and equality, but it can reveal low-entropy content by guessing; its retention after hard delete is pending server-owner confirmation before P4a. The serialization must never put credentials, raw sender/session identifiers, or authorization decisions in searchable metadata.

## Local revision and conflict contract

1. Create starts a branch with `base_revision=null`. Update includes the current `base_revision` and a persisted `operation_id`.
2. If the local base still matches, accept the write as a new child revision and advance `local_revision`. A remote conditional write and returned `remote_revision` require the server contract listed under P4a.
3. If the base is stale, preserve both branches and their common base, return a conflict receipt, and require an explicit resolution that creates a new revision. Do not silently overwrite either branch.
4. A merge has both parent revision IDs and its own operation ID. Device wall-clock order may be recorded for display, but never selects authority.
5. Restore creates a new revision from an explicitly selected historical revision and a current base. It does not move a pointer backward or resurrect a tombstoned row by replaying an old edit.
6. For an old client with no `base_revision`, label the write `unversioned_write`. A trusted, still-current exact-read context may be considered as a compatibility bridge only after the applicable server contract is verified. Otherwise the receipt must say that stale-write detection was unavailable; do not imply concurrent-update safety.

`local_revision` and `remote_revision` remain separate even when a server accepts a local write. A server revision is scoped to the binding and protocol that issued it; changing the binding invalidates that comparison context.

## Local delete, hard-delete, and redaction contract

| Operation | User-visible behavior | Data and synchronization behavior |
|---|---|---|
| `soft_delete` | Remove from default search/get immediately; allow explicit restore if retention policy permits. | Keep the recoverable body/revisions under the configured retention policy, create a deletion revision/tombstone, and sync it when authorized. A restore is a new revision based on the current deletion state. |
| `hard_delete` | Stop returning the record and report local-removal separately from any remote confirmation. | Immediately remove readable body/history from active local storage, all local recall/FTS/vector projections, capture/job payloads, and unsent create/update payloads. Persist a content-free deletion barrier sufficient to stop old retries or late responses from restoring the body. Immutable backups have a maximum retention of 30 days; reapply deletion barriers before any backup restore. Remote deletion and its receipt remain pending server-owner confirmation. |
| `redact` | Replace selected sensitive content with an explicit redacted state; do not expose the old value through history or search. | Remove the redacted bytes from prior readable revisions, payloads, and projections; persist a redaction barrier that prevents stale copies or replies from restoring the old value; preserve only approved non-content audit metadata. Sync the barrier where allowed. A body hash may itself be sensitive and must follow the same retention decision. |

For all three operations, deletion visibility must be enforced before physical cleanup finishes. Old in-flight results, stale outbox entries, restored backups, or old vector rows must not make the content visible again. Before a backup is restored, reapply all deletion barriers. No interface may promise physical erasure from SSD remapping or an immutable backup. The 30-day backup bound is the reviewer’s default recorded above and remains human-editable. Content-hash retention after hard delete is a P4a server-owner decision.

## Local receipt and error contract

Write receipts are structured so local commit is not confused with cloud sync or index readiness:

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

Accepted status sets:

- `storage_status`: `committed_local`, `not_committed`, or `unknown` when the caller cannot determine whether a durable transaction completed. Resolve an unknown outcome using the same operation ID before creating a replacement operation.
- `sync_status`: `local_only`, `pending_sync`, `sending`, `synced`, `conflict`, `rejected`, `held_auth`, `held_policy`, or `outcome_unknown`.
- `index_status`: `ready`, `pending`, or `failed`; a pending vector projection must not hide a committed record from exact get or full-text search.
- Read results add `source`, `revision`, `coverage`, `stale`, and `conflict`. `coverage` names sources actually queried and unavailable sources; it cannot imply cloud completeness without a successful cloud query.

Errors carry a stable `category`, `retryable`, optional `retry_after_ms`, and optional `operation_id`/`conflict_id`. Accepted categories are `validation`, `not_found`, `auth_required`, `permission_denied`, `conflict`, `quota`, `rate_limited`, `server_unavailable`, `network_timeout`, `cancelled`, `storage_busy`, `storage_full`, `corrupt_store`, `index_unavailable`, and `unsupported_operation`. Authentication, permission, conflict, corruption, and validation errors are not blind-retry cases. A timeout after a write may mean the server committed it, so its outcome remains unknown until idempotency lookup resolves it.

## Tool compatibility contract

| Existing or proposed entry | Accepted mapping | Compatibility condition |
|---|---|---|
| `memory_store` | `create` plus a structured receipt. | Keep current parameters; append optional receipt fields. In Local, the local transaction is success even when sync is pending. In Hybrid, the outbox operation is committed with the record. |
| `memory_get`, `xmemo_memory_get` | Exact record/revision read. | Keep existing ID/path and pagination behavior. Do not return a similar record as an exact-ID result. Add optional source/revision/coverage/conflict fields. |
| `memory_search`, `xmemo_memory_list`, SearchManager | Search/list under one identity, deletion, and coverage policy. | Keep existing names/parameters; default reads hide soft-deleted data. An unavailable source is partial coverage, not an empty result. |
| `xmemo_memory_update` | `update(base_revision)`. | Add an optional version precondition for new clients. Old callers remain accepted but are explicitly marked `unversioned_write` unless a trusted current read proves the base. |
| `memory_forget` | Existing `mode` maps to `soft_delete`, `hard_delete`, or `redact`. | Preserve the existing default `soft_delete`. Do not claim remote or backup completion from an accepted HTTP response alone. |
| Record history/restore pair | `xmemo_memory_history` + `xmemo_memory_restore`. | These are the accepted names for record history and revision restore. Keep them distinct from restart snapshot restoration. Any remote capability behavior remains subject to P4a contracts. |
| `xmemo_restart_snapshot_restore` | Remains session snapshot restore. | It is not a record revision restore and must not be relabeled as one. |

## 1.0.18 code gap table against the accepted local contract

Line references below are from the unchanged plugin code at P1a commit `47bb84a`; they document the current Cloud plugin and do not propose code edits in this task.

| Contract area | Current 1.0.18 evidence | Gap against the accepted local contract |
|---|---|---|
| Storage boundary | [`src/client.ts:1–2`](../../src/client.ts#L1-L2) describes a thin remote REST client with no local vector store. [`src/local-cache.ts:26–59`](../../src/local-cache.ts#L26-L59) contains recall-cache entries and write-outbox records. | No authoritative local record/revision store or atomic record-plus-operation transaction exists. The JSON outbox is not a local memory vault. |
| Record identity | [`src/client.ts:91–120`](../../src/client.ts#L91-L120) defines `XMemoMemory` and update request fields. | `id` is present, but origin, authority, binding, owner/collection references, local/remote revisions, parent revision, and base revision are absent from the client contract. |
| Create and idempotency | [`src/tools.ts:950–979`](../../src/tools.ts#L950-L979) writes to `/v1/remember` via `resilientWrite`; [`src/resilient-client.ts:281–324`](../../src/resilient-client.ts#L281-L324) creates a request idempotency key and queues transient failures. | This protects a retried cloud request, but does not create a local authoritative record, revision chain, or server-verified revision receipt. |
| Update precondition | [`src/client.ts:106–120,808–817`](../../src/client.ts#L106-L120) accepts mutable fields and sends PATCH without a `base_revision`; [`src/tools.ts:1841–1866`](../../src/tools.ts#L1841-L1866) builds the patch and calls it directly. | No conditional revision update or `unversioned_write` receipt is exposed. Concurrent-write safety is not established. |
| Delete and redaction | [`src/client.ts:122–126,820–829`](../../src/client.ts#L122-L126) names three request modes but treats the response as `unknown`; [`src/tools.ts:1005–1069`](../../src/tools.ts#L1005-L1069) exposes the modes and then returns `action: deleted`. | The interface does not prove tombstone, restore, hard-delete, backup, redaction, projection, or remote-confirmation behavior. The success wording is not a deletion receipt contract. |
| Write/read receipts | [`src/resilient-client.ts:21–24`](../../src/resilient-client.ts#L21-L24) distinguishes only `synced`, `queued`, and message-only `error`; [`src/tools.ts:981–997`](../../src/tools.ts#L981-L997) returns created ID or outbox status. | Storage, sync, and index states are not represented independently; no revision, conflict, coverage, or unknown-write outcome contract exists. |
| History and restore | [`src/client.ts:905–925`](../../src/client.ts#L905-L925) and [`src/tools.ts:1951–2008`](../../src/tools.ts#L1951-L2008) restore restart snapshots. | Snapshot restore is not record history or a revision-based restore. No memory history/restore API is present. |
| Error taxonomy | [`src/resilient-client.ts:32–50`](../../src/resilient-client.ts#L32-L50) classifies transient errors for retries; [`src/resilient-client.ts:481–511`](../../src/resilient-client.ts#L481-L511) returns queued/error prose. | Retry routing exists, but stable caller-facing categories, conflict IDs, revision mismatch, storage-full/corruption, and ambiguous write outcomes are not a unified API contract. |

## Server contracts pending before P4a

Each item is intentionally outside the accepted local scope. P1b does not depend on these answers; the server owner must confirm each one before P4a.

| Pending contract | Required confirmation | Stage |
|---|---|---|
| `remote_revision` and epoch format | Define server-issued opaque revision tokens and epoch/protocol scoping. | P1b does not depend; server owner confirms before P4a. |
| Conditional write and idempotency lookup | Define server preconditions, replay/query behavior for a persisted `operation_id`, and ambiguous-outcome resolution. | P1b does not depend; server owner confirms before P4a. |
| Tombstone feed | Define the server deletion barrier/epoch feed and how clients apply it before exposing restored data. | P1b does not depend; server owner confirms before P4a. |
| Remote deletion receipt | Define evidence and states for remote soft delete, hard delete, and redaction, including how server backups meet the accepted 30-day maximum. | P1b does not depend; server owner confirms before P4a. |
| Binding identity confirmation | Define authenticated service/account/tenant/collection identity and binding confirmation. | P1b does not depend; server owner confirms before P4a. |
| Key-change evidence | Define evidence that permits retaining a binding after credential rotation; a changed account remains a new binding. | P1b does not depend; server owner confirms before P4a. |
| Lease issuance and revocation SLA | Define lease signing, expiry, revocation checks, and the server’s maximum duration (which may be shorter than 24 hours). | P1b does not depend; server owner confirms before P4a. |
| Content hash after hard delete | Decide whether any content hash may remain, and under which retention boundary. | P1b does not depend; server owner confirms before P4a. |

This document-only freeze records the local prerequisite for P1b. P1b is released only by the reviewer after this task passes; no P1b code, schema, or tool implementation is part of this ADR change.
