# XMemo OpenClaw Memory Provider

<img src="assets/icon.png" width="128" height="128" alt="XMemo for OpenClaw logo">

[XMemo](https://xmemo.dev) is an identity-aware memory control plane for AI
agents: a user-owned Memory OS that stores, governs, and audits personal and
project context across clients, devices, and agent runtimes.

`@xmemo/openclaw-memory` is the **native OpenClaw memory provider plugin** for
XMemo Cloud Memory. Once enabled, OpenClaw uses XMemo as its active long-term
memory backend instead of local file-backed or vector-backed stores.

It is distributed independently through
[ClawHub](https://clawhub.ai/plugins/@xmemo/openclaw-memory) and npm as an
external plugin. It is not bundled in the default OpenClaw release, and the
project does not pursue inclusion through an upstream OpenClaw pull request.

## Agent-readable summary

Use this section when an agent, marketplace, crawler, or setup assistant needs
to classify the package quickly.

| Field | Value |
|------|-------|
| Package | `@xmemo/openclaw-memory` |
| Plugin ID | `xmemo-memory` |
| OpenClaw role | Native `kind: "memory"` provider |
| Runtime purpose | XMemo cloud-memory reads/writes, recall, TODOs, snapshots, audit tools |
| Companion Skill | `https://clawhub.ai/xmemo/xmemo` |
| Plugin listing | `https://clawhub.ai/plugins/@xmemo/openclaw-memory` |
| Product page | `https://xmemo.dev/product/mcp` |
| Discovery document | `https://xmemo.dev/.well-known/agent-discovery.json` |
| OpenClaw config endpoint | `https://xmemo.dev/v1/mcp/config/openclaw` |
| Hosted MCP endpoint | `https://xmemo.dev/mcp` |
| ChatGPT bridge | XMemo can be connected from ChatGPT through the hosted MCP/OAuth path; saved brainstorms, decisions, and user-approved context can later be recalled by OpenClaw through this plugin. |

If an OpenClaw-compatible agent sees only `https://xmemo.dev`, it should read the
discovery document and prefer the **Skill + plugin** pairing for OpenClaw. Other
MCP-compatible agents should use the hosted MCP endpoint unless they have a
native XMemo integration.

## Shared memory with ChatGPT

XMemo is designed to be one user-owned memory layer across ChatGPT, OpenClaw,
Hermes, Codex, Claude, Cursor, and other agent clients. When a user connects
ChatGPT to XMemo through the hosted MCP/OAuth flow, useful brainstorms,
decisions, preferences, and project context can be saved into the same XMemo
account that this OpenClaw plugin reads from.

That means an idea refined in ChatGPT can later be recalled by OpenClaw during a
coding or planning session, and OpenClaw's durable decisions can be available to
other approved XMemo clients. This is XMemo's shared cloud-memory layer, not
ChatGPT's built-in native memory. Marketplace or "official" status should be
claimed only where a public listing or review approval explicitly supports it.

## Companion XMemo Skill

For the best OpenClaw experience, use this runtime plugin together with the
[XMemo ClawHub Skill](https://clawhub.ai/xmemo/xmemo):

- The **Skill** teaches OpenClaw when to recall, remember, preserve handoff state,
  and avoid saving secrets.
- This **plugin** performs the real XMemo cloud-memory reads and writes and can
  become OpenClaw's active memory backend.

The Skill alone cannot execute memory operations. If only the Skill is present,
OpenClaw should recommend installing/enabling this plugin. If only the plugin is
present, the Skill is recommended for more consistent recall-first behavior.

When OpenClaw receives only `https://xmemo.dev`, it can discover the pairing
without credentials from:

- `https://xmemo.dev/.well-known/agent-discovery.json`
- `https://xmemo.dev/v1/mcp/config/openclaw`

These endpoints never contain user tokens. The recommendation is OpenClaw-specific
and does not change how other MCP clients connect to XMemo.

## Install decision guide

- **OpenClaw users:** install this plugin and optionally add the XMemo Skill for
  recall-first behavior.
- **OpenClaw Skill-only users:** install this plugin if you want real cloud
  memory reads/writes. The Skill is guidance; it is not the memory runtime.
- **Non-OpenClaw MCP clients:** use `https://xmemo.dev/mcp` with your own XMemo
  account token or OAuth flow.
- **Catalogs and setup agents:** use the machine-readable package metadata and
  the XMemo discovery endpoints above. Do not scrape user tokens from examples.

## Features

- Identity-aware memory for OpenClaw via the XMemo REST API
- Canonical memory tools: `memory_search`, `memory_get`, `memory_store`, `memory_forget`
- Memory query/list and update: `xmemo_memory_list` (requires a query), `xmemo_memory_update`
- Reminder tools: `xmemo_todo_create`, `xmemo_todo_list`, `xmemo_todo_complete`
- Timeline event tool: `xmemo_record_event`
- Restart snapshot tools: `xmemo_restart_snapshot_save`, `xmemo_restart_snapshot_restore`
- Ledger and audit tools (requires special API key scope): `xmemo_ledger_monthly_summary`, `xmemo_audit_events`, `xmemo_audit_consolidation`
- Optional automatic capture of high-signal user messages after a successful agent turn
- No local embedding model or vector store required
- Works with hosted XMemo (`https://xmemo.dev`) and private/self-hosted instances

## Native plugin vs MCP

This is a native OpenClaw plugin (`kind: "memory"`). It becomes OpenClaw's
active memory backend when `plugins.slots.memory` is set to `"xmemo-memory"`.

XMemo also provides a hosted MCP server (`https://xmemo.dev/mcp`) for users who
want tools without occupying the OpenClaw memory slot. The MCP server exposes
similar read/write memory tools but does **not** replace `active-memory` recall.

For OpenClaw, the native plugin is the recommended memory-backend path. For
ChatGPT, Claude, Codex, Cursor, Kimi, ModelScope, MCPWorld, and other MCP
clients, the hosted MCP server is the portable integration path.

## Installation

### Quick setup

Install the plugin from ClawHub and set your XMemo API key:

```bash
openclaw plugins install clawhub:@xmemo/openclaw-memory
openclaw xmemo setup "xmemo_..."
openclaw xmemo status
```

No manual `openclaw.json` editing is required. Recent OpenClaw releases select
`xmemo-memory` as the memory slot when the plugin is installed.

If you already use the XMemo CLI on the same user account, the plugin can also
use the XMemo shared user credential created by `xmemo login`:

```bash
npm install -g @xmemo/client
xmemo login
openclaw plugins install clawhub:@xmemo/openclaw-memory
openclaw xmemo status
```

This is a shared XMemo credential contract, not a plugin-private dependency on
the `@xmemo/client` package. Explicit plugin config and service environment
variables still take precedence.

If you also configure XMemo as a hosted MCP server, use the same shared
credential path (`xmemo login` / `xmemo token add --from-stdin`) or the same
`XMEMO_KEY` environment variable. Do not treat an empty plugin `apiKey` field as
an error when a shared credential or environment token is present.

npm is also supported as a secondary distribution channel:

```bash
openclaw plugins install @xmemo/openclaw-memory
```

The plugin already defaults the service URL to `https://xmemo.dev`, the agent ID
to `openclaw`, and a non-secret instance identifier automatically. Normal users
do not need to choose or enter identity fields.
For production or shared hosts, prefer an environment SecretRef instead of a
plaintext key. Make sure `XMEMO_KEY` is already available to the OpenClaw
gateway/service environment before saving the SecretRef:

```bash
export XMEMO_KEY="your-xmemo-api-key"
openclaw xmemo setup --env XMEMO_KEY
```

### OpenClaw compatibility

- Minimum supported host: OpenClaw `2026.4.14`
- Build and full integration baseline: OpenClaw `2026.6.8`
- Recommended host: the latest stable OpenClaw release

The plugin prefers native OpenClaw runtime helpers when the host provides them.
The compatibility fallback is used only by older hosts that do not export those
helpers, so newer OpenClaw releases retain their native behavior.

## Configuration

Optional explicit config:

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
          "apiKey": { "source": "env", "provider": "default", "id": "XMEMO_KEY" },
          "bucket": "openclaw",
          "scope": "my-project",
          "autoCapture": false
        }
      }
    }
  }
}
```

Config lives at `plugins.entries["xmemo-memory"].config`, not `plugins.config`.
For production setups, keep the API key in the environment (`XMEMO_KEY`) instead
of storing it in `openclaw.json`. Most users do not need this block at all.

### Upgrade compatibility

Configuration written by previous tagged releases remains valid. The plugin still
accepts `baseUrl`, `apiKey`, deprecated `token`, `authMode`, `bucket`, `scope`,
`teamId`, `agentId`, `autoCapture`, `captureMaxChars`, `customTriggers`,
`recallMaxChars`, `recallMaxItems`, and `recallMaxTokens`. The newer
`readBucket` and `readScope` fields are optional and default to cross-agent
visible-memory recall.

`token` is kept as a compatibility alias for older configs; new setup commands
write `apiKey` instead. Running `openclaw xmemo setup ...` preserves existing
advanced config such as `baseUrl`, `bucket`, and `scope`.

`bucket` and `scope` control where new OpenClaw-authored memories are written.
Recall and search read all visible user-owned XMemo memories by default so
OpenClaw can reuse context saved by ChatGPT, Hermes, Codex, Claude, and other
connected agents. Advanced operators can narrow reads with `readBucket` and
`readScope`; by default `readBucket` is `%` and `readScope` is unset.

## Authentication

Create a scoped API key in the XMemo Memory Console:
[xmemo.dev](https://xmemo.dev) → **API Keys** → **Create API key**.
Copy the one-time secret value, then paste it into the plugin's **XMemo API
Key** field or use the quick CLI command above.

If you prefer environment-backed secrets, set `XMEMO_KEY` in the environment
seen by the OpenClaw gateway:

```bash
export XMEMO_KEY="your-xmemo-api-key"
```

The key can also be configured with `apiKey` (preferred) or the deprecated
`token` field. For production setups, keep the key in the environment or a
secret manager and omit the `apiKey` field from `openclaw.json`; the plugin
will read `XMEMO_KEY` directly.

For personal desktop installs, `xmemo login` from `@xmemo/client` writes a
user-scoped XMemo shared user credential. If no plugin key and no supported
environment variable is present, the OpenClaw plugin reads that shared
credential and sends it as `Authorization: Bearer ...`.

Running `openclaw xmemo setup "xmemo_..."` also updates the same shared
credential file after the plugin config is saved. This keeps OpenClaw native
memory and XMemo MCP/proxy clients aligned around one user-level credential
contract. `openclaw xmemo setup --env XMEMO_KEY` only stores the environment
reference and does not copy the secret out of the service environment.

If OpenClaw runs as a daemon/service, remember that a shell `export` only affects
that shell. Existing `systemctl --user set-environment XMEMO_KEY=...` setup
still works for the gateway service after restart. Use plugin settings,
`openclaw xmemo setup --env XMEMO_KEY`, or
your service environment so the gateway process can see the key.

### SecretRef support

The plugin resolves `apiKey`/`token` in this order:

1. A literal string.
2. An env SecretRef object: `{ "source": "env", "provider": "default", "id": "XMEMO_KEY" }`.
3. The environment variables `XMEMO_KEY`, `MEMORY_OS_API_KEY`, or `MEMORY_OS_MCP_TOKEN`.
4. The XMemo shared user credential file created by `xmemo login`.

Only `env` SecretRefs are supported. `file` and `exec` sources are not
implemented and are rejected by the manifest config schema.

The shared user credential fallback uses the same path contract as `@xmemo/client`:
`$XMEMO_CONFIG_HOME/credentials.json`, `$MEMORY_OS_CONFIG_HOME/credentials.json`,
`%LOCALAPPDATA%\XMemo\CLI\credentials.json` on Windows, or
`$XDG_CONFIG_HOME/xmemo/credentials.json` / `~/.config/xmemo/credentials.json`
on Unix-like systems.

## Environment variables

- `XMEMO_KEY` — XMemo API key for env-backed setup
- `MEMORY_OS_API_KEY` — alternate env var name
- `XMEMO_AGENT_INSTANCE_ID` — optional stable device-level identifier

## Auth mode

By default the credential is sent as `X-API-Key`. To use Bearer auth or both:

```json
{
  "authMode": "bearer"
}
```

Allowed values: `api-key` (default), `bearer`, `both`.
Credentials loaded from the shared `xmemo login` file default to `bearer` unless
`authMode` is explicitly configured.

`openclaw xmemo status --json` includes a non-secret `credentialSource` field
(`config`, `env-secret-ref`, `env`, or `shared-credential`) so setup assistants
can distinguish "no literal apiKey field" from "not configured".

## MCP and native plugin together

The native OpenClaw memory plugin and the hosted XMemo MCP server can coexist,
but OpenClaw should prefer the native plugin for the active memory slot. The MCP
server is useful for portable tool access or clients that do not use OpenClaw's
memory slot.

To avoid contradictory diagnostics:

- Check `openclaw xmemo status --json` and `credentialSource`, not just whether
  `plugins.entries["xmemo-memory"].config.apiKey` exists.
- Check MCP auth separately only when the user is actually using the hosted MCP
  server.
- Prefer one credential contract: `XMEMO_KEY` for service deployments, or the
  shared user credential file for personal desktop installs.
- If both native plugin tools and MCP tools expose similar names, use the native
  plugin tools for OpenClaw memory operations.

## Agent identity headers

The plugin sends non-secret attribution headers to XMemo:

- `X-Memory-OS-Agent-ID: openclaw`
- `X-Memory-OS-Agent-Instance-ID: <stable-device-id>`

If `XMEMO_AGENT_INSTANCE_ID` is not set, a process-local UUID is generated. The
plugin does not write JSON sidecars to disk.

## CLI

```bash
openclaw xmemo setup "xmemo_..."
openclaw xmemo setup --env XMEMO_KEY
openclaw xmemo status
openclaw xmemo status --json
```

## Auto-capture

When `autoCapture: true`, the plugin listens for `agent_end` and stores
high-signal user messages (preferences, decisions, facts) to XMemo.

> **External plugin permission required:** OpenClaw external plugins do not
> receive conversation access by default. To enable auto-capture, add this to
> your `openclaw.json`:
>
> ```json
> {
>   "hooks": {
>     "allowConversationAccess": ["xmemo-memory"]
>   }
> }
> ```
>
> Without this, the `agent_end` hook is silently skipped and no messages are
> captured.

It skips:

- envelope/transport metadata
- injected context blocks
- prompt-injection-looking payloads
- messages without a memory trigger word

Customize triggers with `customTriggers`:

```json
{
  "autoCapture": true,
  "customTriggers": ["save this", "remember for next time"]
}
```

## Smoke test

After installing and configuring the plugin:

```bash
export XMEMO_KEY="your-xmemo-api-key"
openclaw xmemo status
openclaw xmemo status --json
```

Expected results:

- `status` shows `configured: true` and `connected: true` (or a clear
  `not connected` error if the key/network is wrong).
- `openclaw plugins inspect xmemo-memory --runtime --json` lists the registered
  tools: `memory_search`, `memory_get`, `memory_store`, `memory_forget`,
  `xmemo_memory_list`, `xmemo_memory_update`, `xmemo_todo_create`,
  `xmemo_todo_list`, `xmemo_todo_complete`, `xmemo_record_event`,
  `xmemo_restart_snapshot_save`, `xmemo_restart_snapshot_restore`,
  `xmemo_ledger_monthly_summary`, `xmemo_audit_events`,
  `xmemo_audit_consolidation`, plus the `xmemo` CLI.

The `memory_*` tools are invoked by the OpenClaw agent during a turn, not as
standalone CLI commands.
`xmemo_memory_list` is backed by XMemo search and requires a non-empty query;
use `memory_search` for semantic recall when you do not need an exact list view.

## Migration from memory-core or memory-lancedb

Switching the memory slot replaces the active backend. Existing local memories
remain on disk but are no longer queried automatically. To migrate content into
XMemo, use `memory_get` on the old backend and `memory_store` on XMemo, or use
XMemo's import endpoints.

## Privacy and security

- XMemo API keys are user credentials. Keep them in environment variables or a
  secret manager whenever possible.
- The public discovery document, product page, package metadata, and README do
  not include user tokens.
- Agent identity headers are non-secret attribution metadata. They help XMemo
  show which agent or client wrote a memory.
- Destructive memory operations require exact ids and should be exposed only in
  trusted user-controlled workflows.

## Learn more

- XMemo: https://xmemo.dev
- XMemo MCP guide: https://xmemo.dev/product/mcp
- XMemo ClawHub Skill: https://clawhub.ai/xmemo/xmemo
- XMemo OpenClaw plugin: https://clawhub.ai/plugins/@xmemo/openclaw-memory
