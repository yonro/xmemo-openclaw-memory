# OpenClaw identity and scope contract

This note defines the identity boundary used by the plugin. Host context supplies
agent/session/sender attribution. Plugin configuration supplies the XMemo agent
header and read/write filters. Identity metadata is provenance; it is not an
authorization mechanism.

## Trusted identity sources

| Entry point | Trusted host fields | Use |
| --- | --- | --- |
| Registered tool factory and execution context | `agentId`, `sessionKey`, `sessionId`, `requesterSenderId` | Trusted agent/session/sender values are used for provenance metadata. The configured `agentId` remains the XMemo request header. |
| `agent_end` hook context | `agentId`, `sessionKey`, `sessionId`, `senderId`, `trigger`, `jobId` | Trusted host agent separates auto-capture cursors/idempotency keys and supplies provenance metadata. The configured `agentId` remains the XMemo request header. |
| Memory runtime manager parameters | `agentId` | Runtime configuration supplies the XMemo agent header and all read filters. |

If the host omits an agent ID, the configured `agentId` is also used for
provenance. The plugin does not infer identity from message bodies, metadata,
queries, paths, or a workspace directory. User-provided identity/scope-shaped
metadata is removed (including nested and camel-case keys); unrelated custom
metadata is retained. An `agent:` phrase in a query is only retrieval text.

## Read and write ranges

| Entry | Write range | Read range |
| --- | --- | --- |
| `memory_store`, auto-capture, timeline events, TODO creation, and restart snapshot save | Configured `bucket`, `scope`, and `teamId`; configured `agentId` goes in the XMemo agent header. Trusted host agent/session/sender values may appear in provenance metadata. | None. |
| Restart snapshot restore | The API applies the snapshot under configured `bucket`, `scope`, and `teamId`; caller-supplied bucket/scope values are ignored. | Snapshot selection is handled by the API endpoint; the plugin does not substitute message or metadata identity for its configured target range. |
| Memory search/list, search-manager recall, and direct memory get | None. | Configured `readBucket`, `readScope`, and `teamId`. An explicit TODO-list bucket may narrow a configured `%` bucket; it cannot widen a configured bucket. |
| Memory update/forget and TODO completion | The selected record only, after it is found inside configured read filters when those filters are restrictive. | Configured read filters are checked before mutation. |
| Status prompt | None. | Local operational status only; it does not retrieve memory. |

For a restrictive memory read, the plugin fetches the exact ID through the
server-authorized `/v1/memories/{id}/explain` endpoint, then rejects a returned
bucket, scope, or team that definitively differs from configuration. It does not
use top-ranked keyword search to locate the exact ID. Team membership and
request authorization remain enforced by the API. An omitted scope field is
not treated as a mismatch.

The reminders list endpoint has no exact-ID filter or pagination parameter. A
restricted TODO completion checks the configured bucket/scope and `open` status
using a `limit=500` list, then compares returned scope fields (including
`team_id` when present) before completing the ID. The endpoint caps this list at
500 items, so a matching reminder outside that result cannot be completed by
this preflight. The remote API remains responsible for authorization on
requests made outside this plugin.

## Provenance and limits

Writes may include `source_agent` and one-way hashes of trusted session and
sender identifiers. Raw sender/session identifiers are not stored in these
metadata fields. Timeline events also place the trusted host session ID in the
API's dedicated `session_id` field. Neither that field nor the hashes narrow
reads or authorize writes; sender hashes do not separate users in a shared
group.

The host does not provide a canonical project ID to this plugin, and the
current search contract cannot apply OpenClaw's `sessionKey` filter or search
sessions. The plugin therefore does not derive project/session access scopes
from content, paths, or workspace names. Group-chat sender-level isolation and
the policy for narrowing a shared group memory remain questions for ADR-H01;
this slice does not implement sender ACLs.

Unit tests exercise the SDK context contract, including multiple agents,
session/cursor separation, sender changes, missing identity, forged body or
metadata values, exact scoped reads, and reminder completion beyond the default
page. Actual-host checks for private/group chats, subagents, cron, and heartbeat
contexts are deferred to P5b; mocks do not establish those host behaviors.
