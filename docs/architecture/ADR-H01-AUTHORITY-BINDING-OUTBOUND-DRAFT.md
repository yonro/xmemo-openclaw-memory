# ADR-H01: Data authority, cloud binding, outbound policy, and offline leases

- Status: **Accepted – local scope; server contracts pending before P4a**
- Date: 2026-09-28
- Scope: Accepted local-vault policy and identity contract for Hybrid plan v2 §§8.3, 9.1, 9.4, 10, 19.2, and 19.4. It defines a prerequisite for P1b but changes no runtime behavior. Server protocol details listed below remain open until P4a.
- Related decisions: [ADR-L02](ADR-L02-RECORD-REVISION-DELETE-RECEIPT-DRAFT.md), [ADR-Q01](ADR-Q01-RETRIEVAL-CAPTURE-EVALUATION.md), [P1a platform evidence](ADR-L01-SQLITE-PLATFORM-PROBE.md), and the existing [identity-scope contract](IDENTITY-SCOPE-P0C.md).

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

This ADR accepts the local-vault authority, isolation, outbound, and offline behavior below. Authenticated server identity and service behavior remain open as individually tracked P4a contracts; P1b does not depend on those server decisions.

## Accepted local authority and offline behavior

| Record class | Accepted local authority | Accepted local offline behavior | Local outbound boundary / Hybrid boundary |
|---|---|---|---|
| Local-origin private record | Local vault. | Full local read/write while the vault is available. | Local mode denies runtime egress. Content-derived queries, summaries, embeddings, and reranker inputs inherit the local-only restriction. |
| Local-origin record explicitly shared by the user | Local record remains the origin; a specific binding owns only its authorized replica. | Full local work; pending sync is visible and separately cancellable under the operation rules. | Local mode denies runtime egress. Hybrid may send only after explicit sharing to the selected binding and collection; disconnect does not delete the local original. |
| Personal cloud record copied under authorization | Cloud remains authoritative; local edits are a branch based on the last known cloud revision. | Read only within the granted offline policy. Edits remain pending and preserve their base revision. | Local mode denies runtime egress. Hybrid pulls only authorized collections; server-side write preconditions remain pending for P4a. |
| Team-controlled cloud copy | Server/team policy is authoritative. | Read and any allowed queued edit require a current server-issued lease of at most 24 hours. Expiry or known revocation isolates the copy and its derived indexes. The final server cap may only be shorter and is due before P4a. | Local mode denies runtime egress. Hybrid sync is limited to its authorized binding and collections; no cross-account replay. |
| Temporary response/query cache | No durable record authority; it is a disposable projection. | Reuse only while its authorization context and lifetime remain valid. | Local mode denies runtime egress. A cache is never promoted to permanent memory or replicated as a new record. |

`owner`, `collection`, origin, and sender fields are provenance or routing data, not ACLs. For group chats, memory is private to the speaker unless an explicitly configured group collection is opted in per room. Missing trusted group-member or speaker identity fails closed for reads and writes. Every read, write, background replay, model call, and sync attempt still needs an authorization decision. Text and caller-supplied metadata never widen that decision.

## Local cloud-binding semantics

A local cloud binding is a durable, token-free reference for one sync relationship. `binding_id` is `null` for local-only records; a non-null ID does not itself prove an account or grant access. The following is illustrative only; server-issued identity fields and their verification remain pending until P4a:

```json
{
  "binding_id": "bind_opaque_local_id",
  "service_origin": "https://service.example",
  "account_id": "server-issued-account-id",
  "tenant_id": "server-issued-tenant-id",
  "collection_ids": ["server-issued-collection-id"],
  "protocol": { "name": "xmemo-sync", "version": 1 },
  "credential_ref": "openclaw-secret-reference",
  "capabilities": ["conditional_write", "tombstone_feed"],
  "generation": 1,
  "state": "connected"
}
```

The service, account, tenant, collection, and protocol identity must be confirmed from an authenticated server contract or explicit verified setup. Do not treat an API-key hash, configured `agentId`, URL alone, or body metadata as proof of account identity. Store only a secret reference; never copy the credential into a database, outbox, receipt, diagnostic, or ADR.

Accepted local transition rules:

- **Same account, rotated key:** retain the binding only after the server confirms the same service/account/tenant/collection identity and required scopes. Reauthorization changes credentials, not record authority.
- **Different account or tenant:** create a new binding. Hold or quarantine old-binding outbox items; never replay them to the new account. Cross-account copy is a separate authorized export that creates new destination records and records their source.
- **Different service origin or collection:** require a new verified binding or explicit collection-move operation. Do not silently rewrite the old binding ID.
- **Invalid, revoked, or ambiguous identity:** pause remote work, preserve local-origin records, and surface the binding state. Do not convert cloud-owned data into local-owned data.

These rules align with Hybrid plan v2 §9.4. Server-side account/tenant/collection confirmation and proof for same-account key rotation are pending until P4a.

## Accepted local OutboundPolicy boundary

Hybrid plan v2 §19.4 requires one policy gate for all runtime data leaving the local machine. The accepted local policy decision is evaluated before serialization and again before every retry or queued replay.

| Data/purpose class | Accepted default in Local | Hybrid boundary; server contracts pending |
|---|---|---|
| Memory body, revision, or attachment | Deny runtime egress. | Allow only an explicitly shared record and only to its selected binding/collection. |
| Search/recall query | Deny runtime egress. | Allow only when the user has authorized that query to the selected service; a query derived from local-only content inherits the local-only restriction. |
| Summary, extracted fact, embedding, or reranker input | Deny runtime egress. | Inherit the strictest source-record policy; a transformation does not make restricted content safe to send. |
| Operational diagnostic | Allow a minimal local log only. | Send only if separately authorized; include IDs, category, and timing, never body text or credentials. |
| Model/runtime download | Not an implicit runtime fallback. | Separate explicit setup action with source, size, and integrity verification. No quiet remote-model fallback. |

A policy decision records the purpose, data class, record/source IDs, destination `binding_id`, allowed fields, consent or administrator policy reference, policy generation, and decision (`allow`, `deny`, or `requires_confirmation`). It must not store the sensitive payload itself. Local mode denies all runtime network access; model preparation is a separate user action. Hybrid sends require an explicit policy decision for the chosen destination and authorized data class; server-side identity and capability enforcement remain pending until P4a.

When cloud is disabled, the policy generation increments, new sends stop, in-flight work is cancelled where possible, and late responses from the old generation are ignored. A queued write is rechecked before replay; merely having been queued while authorized does not grant future permission. Local-origin records remain usable regardless of cloud token expiry.

## Accepted offline lease boundary

Only server-controlled copies need an offline lease. The lease is server-issued and has a maximum duration of 24 hours; the server owner sets the final cap before P4a and may only shorten it. The P4a contract must define a verifiable lease with at least a binding, allowed records/collections and operations, permission epoch, issue/expiry times, and revocation/checkpoint semantics. Client wall-clock rollback, backup restore, or a stale outbox must not silently extend a lease.

While a valid lease exists, allow only its listed local reads and explicitly permitted branch writes. On expiry or known revocation, isolate the affected content from ordinary recall, FTS/vector indexes, and derived summaries; hold remote-bound writes; and show the reason and last verified epoch. Do not lock or erase unrelated local-origin content. While offline, a client cannot know about a revocation it has not received; the maximum lease bounds that exposure and must be disclosed. Lease enforcement is not a substitute for server ACL checks after reconnect.

## Remaining ownership decisions

The human selected the recommendations recorded above. The accountable roles are accepted, but their names remain open; this ADR does not invent owners or create a sealed evaluation set.

| Open item | Owner and required timing |
|---|---|
| Name the single accountable server synchronization owner and security/privacy co-reviewer. | Human service lead; before P4a. |
| Name the independent human data owner for the sealed evaluation set. | Human product/data owner; before any sealed evaluation run, no later than the P2b quality gate and before P7. |

## 1.0.18 code gap table against the accepted local contract

Line references below are from the unchanged plugin at P1a commit `47bb84a`. “Partial” means a narrower cloud-client behavior exists; it does not imply Local or Hybrid support.

| Contract area | Current 1.0.18 evidence | Gap against the accepted local contract |
|---|---|---|
| Authority classes and local originals | [`src/client.ts:1–2`](../../src/client.ts#L1-L2) states memory operations are remote HTTP calls; [`src/config.ts:12–30`](../../src/config.ts#L12-L30) contains cloud URL/credential, bucket, scope, team, and agent settings. | No local authoritative record mode or five-class authority model exists. P1a only probed SQLite and explicitly did not integrate it. |
| Trusted agent/sender context | [`src/identity-scope.ts:18–43`](../../src/identity-scope.ts#L18-L43) adds trusted agent/session/sender provenance; [`src/identity-scope.ts:68–87`](../../src/identity-scope.ts#L68-L87) filters configured bucket/scope/team. | Sender is an opaque provenance hash and is explicitly not an access filter. Group membership and sender-level read/write ACLs are not implemented. |
| Agent header | [`src/client.ts:550–562`](../../src/client.ts#L550-L562) sends configured agent and agent-instance headers; [`src/config.ts:226–239`](../../src/config.ts#L226-L239) resolves those values and auth mode. | The header meaning is an existing compatibility choice, not a per-record authority or proven group isolation rule. Any change requires the open server contract decision above. |
| Cloud binding | [`src/config.ts:12–23,226–239`](../../src/config.ts#L12-L23) configures base URL, key, bucket/scope/team, and agent; [`src/local-cache.ts:251–264`](../../src/local-cache.ts#L251-L264) scopes cache files by base URL plus an API-key fingerprint. | The cache fingerprint is local isolation, not a server-verified account/tenant/collection binding. There is no persisted `binding_id`, negotiated protocol/capability record, or reviewed key-rotation/account-switch transition. |
| Outbound policy | [`src/client.ts:565–594`](../../src/client.ts#L565-L594) sends requests to the configured service origin; [`src/tools.ts:950–979`](../../src/tools.ts#L950-L979) sends memory content to `/v1/remember`. | No single purpose/data-class gate controls content, queries, summaries, model inputs, diagnostics, or retries. There is no complete local mode that denies runtime egress. |
| Outbox authorization and account change | [`src/local-cache.ts:41–59,356–390`](../../src/local-cache.ts#L41-L59) stores endpoint, method, payload, idempotency key, and queue state; [`src/resilient-client.ts:347–370`](../../src/resilient-client.ts#L347-L370) replays through the current client. | The outbox has no `binding_id`, policy generation, lease, or server identity proof. BaseURL/key cache partitioning is not sufficient proof for a safe account transfer or replay decision. |
| Lease and revoked team copy | [`src/resilient-client.ts:71–85`](../../src/resilient-client.ts#L71-L85) recovers retry locks; cache fallback is for cloud recall. | There is no server-issued offline entitlement lease, epoch check, team-copy isolation, or distinction between local-original and remote-owned data after revocation. |
| Stop cloud and late response | [`src/resilient-client.ts:118–125`](../../src/resilient-client.ts#L118-L125) stops the periodic outbox timer at runtime unload. | This lifecycle stop is not an account-binding revocation protocol: it does not define a policy generation, invalidate in-flight results, or preserve/quarantine records by authority class. |

## Server contracts pending before P4a

Each item below remains open, does not block P1b, and must be confirmed by the server owner before P4a.

| Pending contract | Required confirmation | Stage |
|---|---|---|
| `remote_revision` and epoch format | Define server-issued opaque revision tokens and epoch/protocol scoping. | P1b does not depend; server owner confirms before P4a. |
| Conditional write and idempotency lookup | Define server preconditions, replay/query behavior for a persisted `operation_id`, and ambiguous-outcome resolution. | P1b does not depend; server owner confirms before P4a. |
| Tombstone feed | Define the server deletion barrier/epoch feed and how clients apply it before exposing restored data. | P1b does not depend; server owner confirms before P4a. |
| Remote deletion receipt | Define evidence and states for remote soft delete, hard delete, and redaction, including how server backups meet the accepted 30-day maximum. | P1b does not depend; server owner confirms before P4a. |
| Binding identity confirmation | Define authenticated service/account/tenant/collection identity and binding confirmation. | P1b does not depend; server owner confirms before P4a. |
| Key-change evidence | Define evidence that permits retaining a binding after credential rotation; a changed account remains a new binding. | P1b does not depend; server owner confirms before P4a. |
| Lease issuance and revocation SLA | Define lease signing, expiry, revocation checks, and the maximum duration, which may be shorter than 24 hours. | P1b does not depend; server owner confirms before P4a. |
| Content hash after hard delete | Decide whether any content hash may remain and under which retention boundary. | P1b does not depend; server owner confirms before P4a. |

CI was human-authorized on 2026-09-28 in review chat `7b191229` for branch-only validation on `ci/sqlite-platform-probe`; no `master` or tag pushes, PRs, or releases. Initial run [36372400347](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36372400347) failed during pnpm setup; corrected runs [36373750828](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36373750828) and [36374695938](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36374695938) are recorded in ADR-L01. This document-only freeze records the local prerequisite for P1b. P1b is released only by the reviewer after the CI task passes; no code, schema, tool, or version change is part of this ADR change.
