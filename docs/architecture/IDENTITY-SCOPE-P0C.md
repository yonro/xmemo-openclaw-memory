# OpenClaw identity and scope contract

This note defines the identity boundary used by the plugin. Host context supplies
agent/session/sender attribution. Plugin configuration supplies read and write
filters. Identity metadata is provenance; it is not an authorization mechanism.

## Trusted identity sources

| Entry point | Trusted host fields | Use |
| --- | --- | --- |
| Registered tool factory and execution context | `agentId`, `sessionKey`, `sessionId`, `requesterSenderId` | Captured by the tool factory and used for the request agent header and provenance hashes. |
| `agent_end` hook context | `agentId`, `sessionKey`, `sessionId`, `senderId`, `trigger`, `jobId` | Used by auto-capture for the request agent, cursor/idempotency separation, and provenance hashes. |
| Memory runtime manager parameters | `agentId` | Used for the manager's XMemo agent header. Runtime configuration supplies all read filters. |

If the host omits an agent ID, the configured `agentId` is used. The plugin
does not infer identity from message bodies, metadata, queries, paths, or a
workspace directory. User-provided identity/scope-shaped metadata is removed
(including nested and camel-case keys); unrelated custom metadata is retained.
An `agent:` phrase in a query is only retrieval text.

## Read and write ranges

| Entry | Write range | Read range |
| --- | --- | --- |
| `memory_store`, auto-capture, timeline events, TODO creation, and restart snapshot save | Configured `bucket`, `scope`, and `teamId`; trusted host/configured agent goes in the XMemo agent header. | None. |
| Restart snapshot restore | The API applies the snapshot under configured `bucket`, `scope`, and `teamId`; caller-supplied bucket/scope values are ignored. | Snapshot selection is handled by the API endpoint; the plugin does not substitute message or metadata identity for its configured target range. |
| Memory search/list, search-manager recall, and direct memory get | None. | Configured `readBucket`, `readScope`, and `teamId`. An explicit TODO-list bucket may narrow a configured `%` bucket; it cannot widen a configured bucket. |
| Memory update/forget and TODO completion | The selected record only, after it is found inside configured read filters when those filters are restrictive. | Configured read filters are checked before mutation. |
| Status prompt | None. | Local operational status only; it does not retrieve memory. |

Direct ID endpoints do not apply the plugin's read filters. When a read filter
is restrictive, memory get and the search manager use filtered search instead.
TODO completion first verifies the ID through a filtered reminder list. The
remote API remains responsible for authorization on requests made outside this
plugin.

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
session/cursor separation, sender changes, missing identity, and forged body or
metadata values. Actual-host checks for private/group chats, subagents, cron,
and heartbeat contexts are deferred to P5b; mocks do not establish those host
behaviors.
