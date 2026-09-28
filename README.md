# XMemo for OpenClaw

[![XMemo logo](./assets/icon.png)](https://xmemo.dev)

**A native OpenClaw memory plugin for persistent XMemo cloud memory and experimental local memory.**

XMemo for OpenClaw connects your agent to XMemo for long-term memory, semantic
search, exact memory reads, TODOs, restart snapshots, and audit tools. The
package version is **1.0.18**. Cloud remains the default. This source also has an
explicit, keyless local mode marked experimental; Hybrid is unavailable.

| Specification | Details |
| :--- | :--- |
| **Plugin ID** | `xmemo-memory` (Native `kind: "memory"` provider) |
| **Compatibility** | OpenClaw `≥ 2026.6.9` |
| **Tools Included** | 18 native memory & governance tools |
| **Storage today** | XMemo cloud by default; explicit experimental local SQLite vault |
| **Local / Hybrid** | Local is experimental and keyless; Hybrid is refused by a capability gate |
| **Cross-Agent** | Shared recall with Claude, ChatGPT, Codex, Hermes, Cursor |
| **Official Hub** | [ClawHub Plugin](https://clawhub.ai/plugins/@xmemo/openclaw-memory) · [Companion Skill](https://clawhub.ai/xmemo/xmemo) |
| **Source Code** | [GitHub Repository](https://github.com/yonro/xmemo-openclaw-memory) |

[English](README.md) · [简体中文](README_CN.md)

[Quick start](#quick-start) · [Architecture](#architecture) · [Tools](#tool-catalog) · [Configuration](#configuration) · [Operations](#operations) · [Security](#security-and-privacy) · [FAQ](#frequently-asked-questions) · [Product facts](docs/PRODUCT-FACTS.md)

---

`@xmemo/openclaw-memory` is the native XMemo memory provider for
[OpenClaw](https://github.com/openclaw/openclaw). It registers as
`kind: "memory"` and becomes OpenClaw's active long-term memory backend when the
`xmemo-memory` slot is selected.

The plugin talks directly to XMemo. No local embedding model or vector database
is required. Memories written by approved XMemo clients can be recalled across
OpenClaw, ChatGPT, Hermes, Codex, Claude, Cursor, and other connected agents,
subject to the credential permissions and configured read scope.

> [!NOTE]
> This is an external OpenClaw plugin distributed through
> [ClawHub](https://clawhub.ai/plugins/@xmemo/openclaw-memory). It is not bundled
> in the default OpenClaw release.

## Available now and planned

| Capability | Current source behavior | Boundary |
| --- | --- | --- |
| Cloud long-term memory and semantic recall | Available with a configured XMemo service | Retain compatibility and improve reliability |
| Cross-agent memory | Available within authorized XMemo scopes | Explicit identity and sharing controls |
| Local memory without cloud credentials | Experimental local SQLite writes, keyword search, exact reads, history, restore, and local JSONL export | No semantic retrieval, cloud synchronization, or complete cloud-tool parity; use only for evaluation |
| Local search and exact reads | `memory_search`, `memory_store`, `memory_get`, and selected management tools use the current trusted host identity | SearchManager `readFile` fails closed for scoped paths because its host API has no trusted requester identity; `memory_get` authorizes each call against the trusted host context |
| Local auto-capture | Disabled even when `autoCapture` and a cloud key are configured | Auto-capture remains cloud-only |
| Local/cloud Hybrid | Refused with `capability_unavailable` | No local commits plus cloud sync or conflict handling |

Local mode is opt-in with `mode: "local"`, creates a keyless SQLite vault, and
does not make network calls. It is experimental and does not replace the cloud
default. The cloud recall cache is separate from this vault. See [product facts](docs/PRODUCT-FACTS.md)
for the complete capability boundary.

## Architecture

![XMemo native memory architecture for OpenClaw](./assets/openclaw-architecture.svg)

| | |
| --- | --- |
| **Package** | `@xmemo/openclaw-memory` |
| **Plugin ID** | `xmemo-memory` |
| **OpenClaw role** | Native `kind: "memory"` provider |
| **Minimum host** | OpenClaw `2026.6.9` |
| **Hosted service** | `https://xmemo.dev` |
| **Tools** | 18 native memory and governance tools |
| **CLI** | `openclaw xmemo` |

## Why this plugin

- **Native active memory** — participates in OpenClaw's memory lifecycle instead
  of exposing a parallel tool collection only.
- **Cross-agent context** — reads all user-visible XMemo buckets by default, so
  OpenClaw can reuse memories created by other approved clients.
- **No local vector stack** — semantic search, persistence, and governance live
  in XMemo.
- **Operational continuity** — TODOs, timeline events, and restart snapshots are
  available beside core memory operations.
- **Limited offline fallback** — eligible search requests can use previously
  cached results; supported writes can enter a local outbox during transient
  failures. See the [limits](#local-cache-and-write-outbox) before relying on it.
- **Explicit automation** — auto-capture is opt-in, permission-gated, filtered,
  and secret-aware.

## Quick start

### Install from ClawHub

```bash
openclaw plugins install clawhub:@xmemo/openclaw-memory
printf '%s' 'xmemo_...' | openclaw xmemo setup --stdin
openclaw xmemo status
```

`openclaw xmemo setup` enables the plugin, selects `xmemo-memory` as the active
memory slot, and saves the credential source. No manual `openclaw.json` editing
is required for normal installs.

PowerShell:

```powershell
$xmemoKey = Read-Host "XMemo API key"
$xmemoKey | openclaw xmemo setup --stdin
Remove-Variable xmemoKey
```

### Sign in with browser authorization

After installation, you can authorize the plugin without copying an API key:

```bash
openclaw xmemo login
openclaw xmemo status
```

Open the URL printed by the command and confirm the displayed device code in
your browser. The command saves the credential and selects the memory slot.

### Install from npm

```bash
openclaw plugins install @xmemo/openclaw-memory
```

### Reuse an XMemo CLI login

The plugin can reuse the user-scoped credential created by `xmemo login`:

```bash
npm install -g @xmemo/client
xmemo login
openclaw plugins install clawhub:@xmemo/openclaw-memory
openclaw xmemo status
```

![XMemo for OpenClaw setup flow](./assets/openclaw-setup-flow.svg)

> [!TIP]
> On production or shared hosts, prefer an environment SecretRef:
> `openclaw xmemo setup --env XMEMO_KEY`.

## Tool catalog

The plugin registers 18 tools. `memory_*` tools are used by the OpenClaw agent
during a turn; they are not standalone shell commands.

### Core memory

| Tool | Purpose |
| --- | --- |
| `memory_search` | Semantic recall across visible XMemo memory |
| `memory_get` | Read a memory by the ID or path returned by native search |
| `xmemo_memory_get` | Read a specific XMemo record by ID or path, with line pagination |
| `memory_store` | Save durable memory |
| `memory_forget` | Delete an exact memory |
| `xmemo_memory_list` | Browse or search memories using query/path hints |
| `xmemo_memory_update` | Update an existing memory |
| `xmemo_memory_history` | Read local revision history with pagination; unavailable in cloud mode |
| `xmemo_memory_restore` | Restore a prior local revision as a new revision; unavailable in cloud mode |

### Continuity and workflow

| Tool | Purpose |
| --- | --- |
| `xmemo_todo_create` | Create a durable TODO |
| `xmemo_todo_list` | List TODOs |
| `xmemo_todo_complete` | Complete a TODO |
| `xmemo_record_event` | Record a timeline event or milestone |
| `xmemo_restart_snapshot_save` | Save restart/handoff state |
| `xmemo_restart_snapshot_restore` | Restore restart/handoff state |

### Owner and governance surfaces

| Tool | Purpose |
| --- | --- |
| `xmemo_ledger_monthly_summary` | Read a monthly ledger summary |
| `xmemo_audit_events` | Read authorized audit events |
| `xmemo_audit_consolidation` | Read authorized audit consolidation |

Ledger and audit tools require the corresponding API-key scopes.

The [bilingual tool schema catalog](docs/TOOL-CATALOG.md) records the live
parameter names, required fields, constraints, defaults, and descriptions. For
`memory_search`, `minScore` accepts a real similarity threshold from 0 to 1;
results without a known score do not satisfy that threshold. The native host
search manager reports `searchCapabilities` with `supportedSources: ["memory"]`,
`sessionKeyFilter: "unsupported"`, and `unsupportedSources: ["sessions"]`.
Runtime inspection also reports `configured`, `connected`, and, when present,
`lastError`. Its `backend` is `builtin` as OpenClaw's compatibility
identifier; `provider` is `xmemo-memory` for this plugin.

## Native plugin, Skill, and MCP

These components complement each other but have different responsibilities:

| Component | Responsibility | Executes memory operations |
| --- | --- | --- |
| **XMemo Skill** | Teaches recall-first behavior, safe write-back, and handoff habits | No |
| **OpenClaw plugin** | Owns the active memory slot and runs native memory tools | Yes |
| **Hosted XMemo MCP** | Portable XMemo tools for MCP-compatible clients | Yes |

For OpenClaw, the recommended pairing is this plugin plus the
[XMemo Skill](https://clawhub.ai/xmemo/xmemo). The Skill guides behavior; the
plugin performs real reads and writes.

Hosted MCP at `https://xmemo.dev/mcp` can coexist with the native plugin, but it
creates a second XMemo tool surface. Prefer the native plugin for OpenClaw memory
operations and add MCP only when a deliberate portable fallback is needed.

## Configuration

Most users should use the CLI setup command. The equivalent explicit
configuration is:

```json
{
  "plugins": {
    "slots": {
      "memory": "xmemo-memory"
    },
    "entries": {
      "xmemo-memory": {
        "enabled": true,
        "package": "@xmemo/openclaw-memory",
        "config": {
          "baseUrl": "https://xmemo.dev",
          "apiKey": {
            "source": "env",
            "provider": "default",
            "id": "XMEMO_KEY"
          },
          "bucket": "openclaw",
          "readBucket": "%",
          "autoCapture": false
        }
      }
    }
  }
}
```

Configuration belongs under
`plugins.entries["xmemo-memory"].config`, not `plugins.config`.

### Configuration reference

| Field | Default | Description |
| --- | --- | --- |
| `mode` | `cloud` | `cloud` (default), `local` (experimental, keyless), or `hybrid` (unavailable) |
| `baseUrl` | `https://xmemo.dev` | Hosted or private XMemo service |
| `apiKey` | — | String or environment SecretRef |
| `authMode` | `api-key` | `api-key`, `bearer`, or `both` |
| `bucket` | `openclaw` | Write bucket for OpenClaw-authored memories |
| `scope` | unset | Optional write scope |
| `readBucket` | `%` | Read all visible buckets by default |
| `readScope` | unset | Optional read-scope restriction |
| `teamId` | unset | Optional enterprise team |
| `agentId` | `openclaw` | Non-secret source attribution |
| `autoCapture` | `false` | Opt-in high-signal capture |
| `captureMaxChars` | `500` | Maximum eligible capture length |
| `recallMaxItems` | `8` | Maximum recalled items |
| `recallMaxTokens` | `12000` | Context-pack token budget |

Previous tagged configurations remain compatible. The deprecated `token` field
is still accepted as an alias for `apiKey`; new setup writes `apiKey`.

To opt into the experimental local vault, set `mode` to `local` and omit
`apiKey`. Local mode creates a SQLite vault under the OpenClaw data directory,
does not call XMemo cloud, and disables auto-capture. It provides keyword
search, scoped reads and writes, revision history, restore, and JSONL export;
cloud-only tools return `capability_unavailable`. Hybrid mode is rejected.

```json
{ "plugins": { "entries": { "xmemo-memory": { "config": { "mode": "local" } } } } }
```

The host SearchManager cannot supply trusted requester identity to its
`readFile` callback, so it fails closed for `local/scoped/<recordId>` paths.
Use `memory_get` for local search results: each tool call receives the current
trusted host context and checks access again.

### Cross-agent read policy

`bucket` and `scope` control where OpenClaw-authored memories are written.
Recall and search read all visible user-owned XMemo memories by default:

```json
{
  "bucket": "openclaw",
  "readBucket": "%",
  "readScope": null
}
```

Advanced operators can narrow reads with `readBucket` and `readScope`.

## Authentication

### Recommended production setup

Make `XMEMO_KEY` available to the OpenClaw service, then save an environment
reference:

```bash
export XMEMO_KEY="your-xmemo-api-key"
openclaw xmemo setup --env XMEMO_KEY
openclaw xmemo status
```

A shell `export` affects only that shell. Daemon or gateway deployments must set
the variable in the service environment.

### Credential resolution

The plugin resolves credentials in this order:

1. `apiKey` or deprecated `token` string in plugin configuration.
2. An environment SecretRef such as
   `{ "source": "env", "provider": "default", "id": "XMEMO_KEY" }`.
3. `XMEMO_KEY`, `MEMORY_OS_API_KEY`, or `MEMORY_OS_MCP_TOKEN`.
4. The shared user credential written by `xmemo login`.

Only `env` SecretRefs are supported. Unsupported `file` and `exec` sources are
rejected by the manifest schema.

Shared XMemo CLI credentials default to Bearer authentication. Other credentials
default to `X-API-Key` unless `authMode` is set explicitly.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `XMEMO_KEY` | Preferred service credential |
| `XMEMO_BASE_URL` / `XMEMO_URL` | Optional private service URL |
| `XMEMO_AGENT_ID` | Optional attribution override |
| `XMEMO_AGENT_INSTANCE_ID` | Optional stable device identifier |
| `XMEMO_CONFIG_HOME` | Optional shared credential root |
| `MEMORY_OS_*` aliases | Backward compatibility |

Non-localhost `http://` service URLs are rejected. Use HTTPS outside local
development.

## Local cache and write outbox

The plugin maintains a service-and-credential-scoped recall cache and write
outbox. This is cloud fallback state, not a standalone local memory engine:

| File | Behavior |
| --- | --- |
| `recall-cache.json` | Previously fetched recall/search results; five-minute freshness marker and up to 24-hour fallback age |
| `write-outbox.json` | Queues supported writes, including `memory_store`, on transient failure |

Storage root:

- `$OPENCLAW_DATA_DIR/xmemo/<scope-hash>/` when configured
- `$XDG_DATA_HOME/xmemo/<scope-hash>/` on XDG systems
- `~/.xmemo/<scope-hash>/` otherwise

The scope hash is derived from the service URL and a credential hash; the
credential itself is never written to the path. Directories and files use
owner-only permissions where supported.

Outbox replay is triggered opportunistically by successful requests through the
resilient client; it is not a continuous background synchronization service.
Not every write path uses the outbox. A queued result is not confirmation that
the cloud saved the memory, and there is currently no outbox management CLI.

The JSON state contains plaintext memory content and queries; file permissions
are not encryption. The current cache/outbox is not a backup and does not provide
transactional multi-process durability. Avoid sharing its data directory between
concurrent plugin processes. A later Hybrid engine must meet separate recovery
and synchronization acceptance criteria before it is documented as available.

## Auto-capture

Auto-capture is disabled by default. When enabled, the plugin inspects successful
agent turns for high-signal preferences, decisions, and facts.

```json
{
  "autoCapture": true,
  "customTriggers": ["save this", "remember for next time"]
}
```

External plugins need explicit conversation permission:

```json
{
  "hooks": {
    "allowConversationAccess": ["xmemo-memory"]
  }
}
```

The capture filter rejects transport metadata, injected context, prompt-like
payloads, known secret patterns, oversized messages, and content without a
memory trigger. At most three eligible messages are captured per processed turn.

## Operations

### CLI

```bash
openclaw xmemo setup --stdin
openclaw xmemo setup --env XMEMO_KEY
openclaw xmemo setup --env XMEMO_KEY --dry-run
openclaw xmemo status
openclaw xmemo status --json
openclaw xmemo import-preview --recall-cache ./recall-cache.json --write-outbox ./write-outbox.json --json
openclaw xmemo import --recall-cache ./recall-cache.json --write-outbox ./write-outbox.json --ledger ./legacy-import.jsonl --json
openclaw xmemo export --output ./local-memory.jsonl --json
```

`openclaw xmemo login` is the supported browser-authorization command. Only
`openclaw xmemo key set` is a deprecated alias for `setup`.

### Health check

```bash
openclaw xmemo status --json
```

Cloud status probes the XMemo endpoint. Local status is keyless and reports
`mode`, `providerReadiness`, `vaultPath`, `pendingPhysicalCleanup`, and
`networkAccess: "none"`; hybrid reports `capability_unavailable` without probing
cloud.

Important cloud fields:

- `configured` — a supported credential source was resolved
- `credentialSource` — `config`, `env-secret-ref`, `env`, or `shared-credential`
- `connected` — the XMemo endpoint passed the connectivity probe
- `provider` — `xmemo-memory`

Inspect the loaded plugin runtime:

```bash
openclaw plugins inspect xmemo-memory --runtime --json
```

The output should list the 18 tools, the `xmemo` CLI, memory capability, and
registered lifecycle hooks. Its provider status includes `configured`,
`connected`, `searchCapabilities`, and optional `lastError`. The search manager
supports `memory` only; session-key filtering and session search are unsupported.
OpenClaw's `backend` field is `builtin` for compatibility; `provider` is
`xmemo-memory` for this plugin.

### Retrieval troubleshooting

An empty semantic search result does not always prove absence. Retry with:

- alternate wording or synonyms
- the saved path
- source-agent words as query hints, not as an authorization filter
- an approximate time
- `xmemo_memory_list` for path-oriented browsing
- `debug: true` for query expansion and tracing

## Memory Operations & Contract Specification

### Precise Read vs. Search

| Feature | `xmemo_memory_get` | `memory_search` / `xmemo_memory_list` |
| :--- | :--- | :--- |
| **Purpose** | Authoritative single-memory retrieval | Heuristic discovery & exploration |
| **Resolution** | Direct `/explain` read when possible, then live search matched by ID or path | Multi-strategy L1 semantic recall + L2 search |
| **Fallback** | Does not accept an arbitrary first result or stale search cache as the requested record | Eligible tool requests can use previously cached results on transient failure |
| **Failure Mode** | Fails closed on not-found, deleted, or unauthorized | Returns empty or degraded notification |

### Supported References

- **Explicit UUID**: `id: "31ca3aa2-d058-4da8-8dae-5a341e305d61"`
- **Canonical Path**: `path: "openclaw/31ca3aa2-d058-4da8-8dae-5a341e305d61"` or `path: "openclaw/docs/31ca3aa2-d058-4da8-8dae-5a341e305d61"`
- **Validation**: Path traversal segments (`..`) are rejected. Use IDs and paths returned by discovery tools; the current API also accepts record identifiers that are not UUIDs.

### Line Ranges & EOF Pagination

- `from`: 1-based start line (default: 1).
- `lines`: Maximum lines to return.
- If `from > totalLines`, the tool returns a typed `range_out_of_bounds` error indicating `totalLines` and the requested line.
- `truncated`: Only `true` when unread lines remain after the current slice (`startIndex + returnedLines < totalLines`), eliminating false EOF truncation.

### Cache & Offline Failure Semantics

- **Transient-Only Fallback**: Stale cache is returned **only** on transient infrastructure failures (network loss, timeouts, HTTP 5xx, HTTP 429).
- **Authorization rejection**: HTTP 401/403 does not trigger fallback for that request; it also clears the credential-scoped recall cache and disables cached fallback until a later request succeeds. HTTP 404 and `AbortError` do not fall back for that request. None of this provides immediate cross-device deletion or permission-change notifications during an offline window.
- **Degradation Transparency**: When operating from cache, tool response text explicitly prefixes `[Degraded / Offline Cache: fromCache=true, isFresh=...]`, and `details` exposes `{ fromCache: true, isFresh: boolean }`.
- **Mutation invalidation**: Successful `memory_store`, `xmemo_memory_update`, `memory_forget`, or `xmemo_restart_snapshot_restore` operations invalidate matching local recall cache entries while preserving queued outbox writes. This is local invalidation, not cross-device invalidation.
- **Coverage**: The native host search manager and explicit tools do not yet share all fallback and filtering behavior. These cache guarantees describe the resilient tool path.

### Ledger & Audit Permission Prerequisites

- `xmemo_ledger_monthly_summary` and `xmemo_audit_events` require specialized account permissions (e.g. `ledger:read`, `audit:read`). Standard memory tokens lacking these scopes return HTTP 401/403 by design.

## Migration from another memory provider

Selecting `xmemo-memory` replaces the active backend. Existing memories in
`memory-core`, `memory-lancedb`, or another provider remain in their original
store but are no longer queried automatically.

Migrate selected content by reading it from the previous provider and writing it
to XMemo, using the supported tools. An automated importer is not included in this plugin.
Do not delete the old store until the
migration has been verified.

## Security and privacy

| Control | Default behavior |
| --- | --- |
| **Secret handling** | `--stdin`, environment SecretRef, or shared user credential |
| **Transport** | HTTPS required outside localhost |
| **Auto-capture** | Disabled and permission-gated |
| **Capture filtering** | Rejects known secret patterns and injected context |
| **Identity** | Non-secret agent and instance attribution headers |
| **Local state** | Cloud cache/outbox plus a separate experimental user-scoped SQLite vault |
| **Destructive tools** | Exact memory references required |
| **Public metadata** | Discovery and package metadata contain no user credentials |

For sensitive environments, place the OpenClaw data directory on an encrypted
user profile or encrypted disk, and clear local XMemo state when rotating
accounts or retiring a device.

## Frequently asked questions

### What is XMemo for OpenClaw?

It is the external `@xmemo/openclaw-memory` plugin, registered as the native
`xmemo-memory` memory provider. It gives OpenClaw access to XMemo cloud memory
through 18 tools and the host memory lifecycle. The local mode is experimental,
has no semantic retrieval or sync, and disables auto-capture. SearchManager
`readFile` fails closed for scoped local paths; use trusted per-call `memory_get`.

### Does XMemo work without a cloud account or internet connection?

Cloud mode requires a configured XMemo service and credential. This source also
contains a keyless experimental local mode with keyword search, revision history,
and restore; it has no semantic search or cloud synchronization. Hybrid remains
unavailable, and the default mode remains cloud.

### Do I need a local embedding model or vector database?

Not for cloud mode; the XMemo service performs semantic retrieval. Experimental
local mode uses keyword search and does not include local embeddings or semantic
retrieval.

### Can OpenClaw share memory with ChatGPT, Claude, or Codex?

Yes, when those clients connect to XMemo and their credentials authorize access
to the same memories. The plugin reads visible buckets by default; `readBucket`
and `readScope` can narrow retrieval. These settings do not grant additional
permissions or automatically connect another client.

### Does XMemo automatically upload every conversation?

No. Auto-capture is disabled by default and needs conversation-access permission
when enabled in cloud mode. It remains disabled in local mode. Capture applies
trigger and content filters, which are heuristic, not a guarantee that every
sensitive value is detected. Explicit cloud writes and eligible cloud captures
are sent to the configured XMemo service.

### Does installing this plugin migrate my existing local memory?

No. Selecting `xmemo-memory` changes the active memory provider; the previous
provider's files remain in its store. Export or read selected records, write them
to XMemo, and verify the results before removing the source data.

### Should I install the plugin, the Skill, or the MCP connection?

For OpenClaw, use the native plugin for memory operations and the optional
companion Skill for usage guidance. The Skill does not execute memory operations
by itself. Hosted MCP is a separate integration for MCP-compatible clients.

### Is XMemo already the fastest or most accurate local memory plugin?

No such claim is made. The current release is a cloud memory plugin; the local
and Hybrid roadmap must be validated with reproducible retrieval, latency,
recovery, and compatibility evidence before comparative claims are published.

## Development

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm pack
```

Verify the compiled package entry point:

```bash
node scripts/verify-plugin.mjs <unpacked-package-directory>
```

The release workflow tests the minimum supported OpenClaw baseline and a
forward-compatibility version before publishing to npm and ClawHub.

## Agent-readable metadata

| Field | Value |
| --- | --- |
| Package | `@xmemo/openclaw-memory` |
| Plugin ID | `xmemo-memory` |
| Runtime role | Native OpenClaw memory provider |
| Recommended pairing | XMemo Skill + native plugin |
| Companion Skill | `https://clawhub.ai/xmemo/xmemo` |
| Plugin listing | `https://clawhub.ai/plugins/@xmemo/openclaw-memory` |
| Product page | `https://xmemo.dev/product/mcp` |
| Discovery | `https://xmemo.dev/.well-known/agent-discovery.json` |
| OpenClaw config | `https://xmemo.dev/v1/mcp/config/openclaw` |
| Hosted MCP | `https://xmemo.dev/mcp` |

If an OpenClaw-compatible setup agent sees only `https://xmemo.dev`, it should
read the public discovery document and prefer the Skill + native plugin pairing.
Other MCP-compatible clients should use hosted MCP unless they have a native
XMemo integration.

## Links

- [XMemo](https://xmemo.dev)
- [XMemo MCP guide](https://xmemo.dev/product/mcp)
- [XMemo OpenClaw plugin on ClawHub](https://clawhub.ai/plugins/@xmemo/openclaw-memory)
- [XMemo Skill on ClawHub](https://clawhub.ai/xmemo/xmemo)
- [GitHub Repository](https://github.com/yonro/xmemo-openclaw-memory)
- [Issues](https://github.com/yonro/xmemo-openclaw-memory/issues)
- [Releases](https://github.com/yonro/xmemo-openclaw-memory/releases)
