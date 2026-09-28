# ADR-H01: Data authority, cloud binding, outbound policy, and offline leases

- Status: **Draft for human and XMemo server-owner review; not frozen**
- Date: 2026-09-28
- Scope: P1b prerequisite for Hybrid plan v2 §§8.3, 9.1, 9.4, 10, 19.2, and 19.4. This is a policy and identity draft only; it changes no runtime behavior.
- Related drafts: [ADR-L02](ADR-L02-RECORD-REVISION-DELETE-RECEIPT-DRAFT.md), [ADR-Q01](ADR-Q01-RETRIEVAL-CAPTURE-EVALUATION.md), [P1a platform evidence](ADR-L01-SQLITE-PLATFORM-PROBE.md), and the existing [identity-scope contract](IDENTITY-SCOPE-P0C.md).

## Decision status

This document does not select a final group-chat policy, lease duration, data-erasure promise, or responsible individual. Every recommended option below is a proposal for human and server-owner review. No choice is accepted until the relevant owner records approval and the server-side behavior has evidence. In particular, a draft approval does not release P1b implementation.

The proposal applies Hybrid plan v2 §§8.3 and 19.2: record authority belongs to the record's policy, not to the running mode or the presence of a credential.

## Record classes and offline behavior proposal

| Record class | Proposed authority | Offline read/write behavior | Default outbound/sync behavior |
|---|---|---|---|
| Local-origin private record | Local vault. | Full local read/write while the vault is available. | No upload. Content-derived queries, summaries, embeddings, and reranker inputs inherit the local-only restriction. |
| Local-origin record explicitly shared by the user | Local record remains the origin; a specific binding owns only its authorized replica. | Full local work; pending sync is visible and separately cancellable under the chosen operation rules. | Sync only to the selected cloud binding and collection, after an explicit share action. Disconnect does not delete the local original. |
| Personal cloud record copied under authorization | Cloud remains authoritative; local edits are a branch based on the last cloud revision. | Read only within the granted offline policy. Edits remain pending and preserve their base revision. | Pull only the authorized collections; push edits only with a server-confirmed binding and current precondition. |
| Team-controlled cloud copy | Server/team policy is authoritative. | Read and any allowed queued edit require a current, bounded server-issued offline lease. Expiry or known revocation isolates the copy and its derived indexes. | Sync only to the team binding and permitted collections/categories. No cross-account replay. |
| Temporary response/query cache | No durable record authority; it is a disposable projection. | Reuse only while its authorization context and lifetime remain valid. | Never promoted to permanent memory or replicated as a new record. |

`owner`, `collection`, origin, and sender fields are provenance or routing data, not ACLs. Every read, write, background replay, model call, and sync attempt still needs an authorization decision. Text and caller-supplied metadata never widen that decision.

## Cloud binding proposal

A cloud binding is a durable, token-free identity for one sync relationship. A draft local record could look like this:

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

Draft transition rules:

- **Same account, rotated key:** retain the binding only after the server confirms the same service/account/tenant/collection identity and required scopes. Reauthorization changes credentials, not record authority.
- **Different account or tenant:** create a new binding. Hold or quarantine old-binding outbox items; never replay them to the new account. Cross-account copy is a separate authorized export that creates new destination records and records their source.
- **Different service origin or collection:** require a new verified binding or explicit collection-move operation. Do not silently rewrite the old binding ID.
- **Invalid, revoked, or ambiguous identity:** pause remote work, preserve local-origin records, and surface the binding state. Do not convert cloud-owned data into local-owned data.

These rules align with Hybrid plan v2 §9.4. The server owner must specify the stable identity response, capability negotiation, binding migration behavior, and what proof is sufficient for same-account key rotation.

## OutboundPolicy proposal

Hybrid plan v2 §19.4 requires one policy gate for all runtime data leaving the local machine. The draft policy decision is evaluated before serialization and again before every retry or queued replay.

| Data/purpose class | Default in Local | Draft Hybrid rule |
|---|---|---|
| Memory body, revision, or attachment | Deny runtime egress. | Allow only an explicitly shared record and only to its selected binding/collection. |
| Search/recall query | Deny runtime egress. | Allow only when the user has authorized that query to the selected service; a query derived from local-only content inherits the local-only restriction. |
| Summary, extracted fact, embedding, or reranker input | Deny runtime egress. | Inherit the strictest source-record policy; a transformation does not make restricted content safe to send. |
| Operational diagnostic | Allow a minimal local log only. | Send only if separately authorized; include IDs, category, and timing, never body text or credentials. |
| Model/runtime download | Not an implicit runtime fallback. | Separate explicit setup action with source, size, and integrity verification. No quiet remote-model fallback. |

A policy decision should record the purpose, data class, record/source IDs, destination `binding_id`, allowed fields, consent or administrator policy reference, policy generation, and decision (`allow`, `deny`, or `requires_confirmation`). It must not store the sensitive payload itself. Local mode denies all runtime network access; model preparation is a separate user action. Hybrid permits only the chosen destination and authorized classes.

When cloud is disabled, the policy generation increments, new sends stop, in-flight work is cancelled where possible, and late responses from the old generation are ignored. A queued write is rechecked before replay; merely having been queued while authorized does not grant future permission. Local-origin records remain usable regardless of cloud token expiry.

## Offline lease and revocation proposal

Only server-controlled copies need an offline lease. The server contract should define a verifiable lease with at least a binding, allowed records/collections and operations, permission epoch, issue/expiry times, and revocation/checkpoint semantics. Client wall-clock rollback, backup restore, or a stale outbox must not silently extend a lease.

While a valid lease exists, allow only its listed local reads and explicitly permitted branch writes. On expiry or known revocation, isolate the affected content from ordinary recall, FTS/vector indexes, and derived summaries; hold remote-bound writes; and show the reason and last verified epoch. Do not lock or erase unrelated local-origin content. While offline, a client cannot know about a revocation it has not received; the maximum lease bounds that exposure and must be disclosed. Lease enforcement is not a substitute for server ACL checks after reconnect.

## Human and server-owner decision register

No option in this register is selected. The reviewer should send these items to the human product owner and the XMemo server synchronization owner. A recommendation is not approval.

| Decision | Options and impact | Draft recommendation |
|---|---|---|
| **Group-chat default range and sender isolation** (F05) | **A.** Private-by-sender default; only an explicitly configured group collection is shared. Strongest privacy, with less cross-sender recall. **B.** Shared session collection by default with visible group history; easier collaboration, but one sender's private preference can contaminate another's context. **C.** Disable memory reads/writes when the host cannot provide trusted sender and group context; safest under missing identity, least useful. | **A**, with C as the fail-closed behavior when trusted group membership/sender data is absent. A human must decide whether explicit group collections are opt-in per room or per workspace. |
| **`X-Memory-OS-Agent-ID` header semantics** (P0c-3) | **A.** Keep the configured `agentId` as the compatibility header; carry trusted host agent separately as provenance. Lowest migration risk. **B.** Change the header to trusted per-request host agent. Better per-agent server partitioning only if server semantics and existing data migration are defined; can split historical data. **C.** Remove the header. Simplifies identity but risks changing server defaults and breaking existing clients. | **A** until the server owner publishes a versioned identity contract and migration test. Human/server owner must confirm before changing this header's meaning. |
| **Offline lease for team-controlled copies** | **A.** Online-only; no offline reads. Tightest revocation, poor continuity. **B.** Server-issued lease capped at 24 hours, with per-class permissions and immediate expiry enforcement after the lease ends. Bounded exposure, requires trustworthy lease/clock handling. **C.** Configurable lease up to 7 days. Better travel/offline use, longer unobserved revocation window. | **B** as a starting cap, not a chosen duration. The service owner must set the actual cap and revocation SLA; a human product/security owner must approve the offline usability tradeoff. |
| **`hard_delete` and existing backups** | **A.** Purge active stores/projections immediately; disclose a bounded maximum retention for immutable backups; restored backups reapply deletion barriers before access. Honest and operationally achievable if retention is enforced. **B.** Per-record encryption keys and verified crypto-erasure. Stronger erasure only if keys cover WAL, outbox, indexes, and backups; substantially more complex. **C.** Purge every retained backup immediately. Strong promise, but may be impossible for immutable/offsite backups. | **A** until B is implemented and independently verified. The human data owner must set the retention bound and user-facing wording; the server owner must define remote deletion confirmation. |
| **XMemo server synchronization owner** | **A.** One named API/storage owner accountable for the protocol and a security/privacy co-review. Clear escalation and one compatibility authority. **B.** A small named owner group with a required reviewer from each server subsystem. Shared coverage, slower decisions. **C.** No assigned owner; client proceeds against assumed server behavior. Fastest initially, but no contract can be frozen safely. | **A**, with the actual person/team and backup reviewer assigned by the human service lead. No individual is invented here. P1b remains blocked until an owner accepts the contract review. |
| **Sealed evaluation-set author and labeler** (ADR-Q01) | **A.** Independent human evaluation/data steward authors and labels the sealed set without access to implementation tuning. Lowest leakage risk. **B.** Separate blinded evaluation team with audited custody and a fixed rubric. Scales review, requires access controls. **C.** The implementation executor/agent creates and labels it. Convenient, but violates the separation principle and leaks test distribution into tuning. | **A**, or B if independence/custody can be demonstrated. Do not create the sealed set in this task; the human product/data owner assigns the steward and licensing/review process. |

## 1.0.18 code gap table

Line references below are from the unchanged plugin at P1a commit `47bb84a`. “Partial” means a narrower cloud-client behavior exists; it does not imply Local or Hybrid support.

| Contract area | Current 1.0.18 evidence | Gap against this draft |
|---|---|---|
| Authority classes and local originals | [`src/client.ts:1–2`](../../src/client.ts#L1-L2) states memory operations are remote HTTP calls; [`src/config.ts:12–30`](../../src/config.ts#L12-L30) contains cloud URL/credential, bucket, scope, team, and agent settings. | No local authoritative record mode or five-class authority model exists. P1a only probed SQLite and explicitly did not integrate it. |
| Trusted agent/sender context | [`src/identity-scope.ts:18–43`](../../src/identity-scope.ts#L18-L43) adds trusted agent/session/sender provenance; [`src/identity-scope.ts:68–87`](../../src/identity-scope.ts#L68-L87) filters configured bucket/scope/team. | Sender is an opaque provenance hash and is explicitly not an access filter. Group membership and sender-level read/write ACLs are not implemented. |
| Agent header | [`src/client.ts:550–562`](../../src/client.ts#L550-L562) sends configured agent and agent-instance headers; [`src/config.ts:226–239`](../../src/config.ts#L226-L239) resolves those values and auth mode. | The header meaning is an existing compatibility choice, not a per-record authority or proven group isolation rule. Any change requires the open server contract decision above. |
| Cloud binding | [`src/config.ts:12–23,226–239`](../../src/config.ts#L12-L23) configures base URL, key, bucket/scope/team, and agent; [`src/local-cache.ts:251–264`](../../src/local-cache.ts#L251-L264) scopes cache files by base URL plus an API-key fingerprint. | The cache fingerprint is local isolation, not a server-verified account/tenant/collection binding. There is no persisted `binding_id`, negotiated protocol/capability record, or reviewed key-rotation/account-switch transition. |
| Outbound policy | [`src/client.ts:565–594`](../../src/client.ts#L565-L594) sends requests to the configured service origin; [`src/tools.ts:950–979`](../../src/tools.ts#L950-L979) sends memory content to `/v1/remember`. | No single purpose/data-class gate controls content, queries, summaries, model inputs, diagnostics, or retries. There is no complete local mode that denies runtime egress. |
| Outbox authorization and account change | [`src/local-cache.ts:41–59,356–390`](../../src/local-cache.ts#L41-L59) stores endpoint, method, payload, idempotency key, and queue state; [`src/resilient-client.ts:347–370`](../../src/resilient-client.ts#L347-L370) replays through the current client. | The outbox has no `binding_id`, policy generation, lease, or server identity proof. BaseURL/key cache partitioning is not sufficient proof for a safe account transfer or replay decision. |
| Lease and revoked team copy | [`src/resilient-client.ts:71–85`](../../src/resilient-client.ts#L71-L85) recovers retry locks; cache fallback is for cloud recall. | There is no server-issued offline entitlement lease, epoch check, team-copy isolation, or distinction between local-original and remote-owned data after revocation. |
| Stop cloud and late response | [`src/resilient-client.ts:118–125`](../../src/resilient-client.ts#L118-L125) stops the periodic outbox timer at runtime unload. | This lifecycle stop is not an account-binding revocation protocol: it does not define a policy generation, invalidate in-flight results, or preserve/quarantine records by authority class. |

## Open contracts required to freeze

The human product owner must decide the registered choices and name the accountable service owner. The server owner must verify authenticated account/tenant/collection identity, protocol version/capability negotiation, operation idempotency, revision/tombstone epochs, delete receipts, and lease issuance/revocation. The reviewer should return the decision register for those approvals. Until then, this is an unaccepted draft and the P1b implementation gate remains closed.
