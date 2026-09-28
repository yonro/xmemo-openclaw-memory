# XMemo for OpenClaw — product facts / 产品事实

Reviewed: 2026-09-28 · Runtime baseline: **1.0.18** · Status: current behavior and explicitly marked roadmap.

This is the shared factual reference for the README, package description, marketplace listing, and website copy. A source-level capability is not proof that every client, operating system, or failure scenario has passed live validation.

## What is XMemo for OpenClaw?

**XMemo for OpenClaw is a native OpenClaw memory plugin backed by XMemo cloud.** It provides persistent memory tools, semantic recall, TODOs, events, restart snapshots, and scoped access to cloud ledger and audit features. Approved clients connected to the same XMemo account can work with memories visible to their credentials and configured scope.

**XMemo for OpenClaw 是基于 XMemo 云服务的 OpenClaw 原生记忆插件。** 当前版本提供长期记忆工具、语义召回、TODO、事件、重启快照，以及需要相应权限的云端账本和审计功能。连接同一 XMemo 账户的已授权客户端，可访问其凭证与配置范围允许的记忆。

**Current boundary / 当前边界：** 1.0.18 requires a configured XMemo service and valid authorization for cloud memory. It does not provide a standalone local database, local embedding runtime, or bidirectional local/cloud synchronization. Those are planned capabilities, not configuration options in this release. 当前未配置云记忆时，不能将插件当作完整本地记忆使用。

## Identity and official entry points

| Field | Value |
|---|---|
| Product | XMemo for OpenClaw |
| npm package | [`@xmemo/openclaw-memory`](https://www.npmjs.com/package/@xmemo/openclaw-memory) |
| OpenClaw plugin ID | `xmemo-memory` |
| Slot | `kind: "memory"` |
| Source | [yonro/xmemo-openclaw-memory](https://github.com/yonro/xmemo-openclaw-memory) |
| Plugin listing | [ClawHub plugin](https://clawhub.ai/plugins/@xmemo/openclaw-memory) |
| Companion guidance | [XMemo Skill](https://clawhub.ai/xmemo/xmemo) |
| Website | [xmemo.dev](https://xmemo.dev) |
| Current product page | [XMemo for MCP and connected clients](https://xmemo.dev/product/mcp) |
| Public discovery | [Agent discovery](https://xmemo.dev/.well-known/agent-discovery.json) |
| OpenClaw configuration discovery | [OpenClaw config](https://xmemo.dev/v1/mcp/config/openclaw) |
| Separate hosted MCP endpoint | `https://xmemo.dev/mcp` |

The plugin, companion Skill, and hosted MCP service are related but separate surfaces. This npm package implements the OpenClaw runtime integration; installing guidance alone does not install that runtime. 上述名称与链接应保持一致，不能将插件描述为独立 MCP server 或仅有提示词的 Skill。

## Capability and claim register

“Implemented” below means present in the reviewed source. It does not imply that all reliability gaps have been closed. The roadmap has no promised release date.

| ID | Capability / 能力 | State in 1.0.18 | Safe public wording and boundary |
|---|---|---|---|
| C01 | Native memory slot | Implemented | Registers the OpenClaw memory capability and tools. The reviewed manifest declares OpenClaw `>=2026.6.9`; that range is not proof of compatibility with every future release. |
| C02 | Cloud memory search, get, store, update, forget | Implemented | Uses XMemo APIs; service authorization and availability apply. Do not describe every operation as offline-capable. |
| C03 | Cross-agent sharing | Implemented integration | Works through the same authorized cloud memory account and allowed scope; not access to arbitrary agents' or users' data. |
| C04 | Semantic recall | Implemented, cloud-backed | Queries cloud recall/search. No built-in local embedding model in this version. |
| C05 | TODO, event, restart snapshot | Implemented, cloud-backed | Exposes tools for these workflows; a cloud restart snapshot is not a complete local transcript archive. |
| C06 | Ledger and audit | Implemented, cloud-backed | Subject to endpoint support and the required credential scopes. Not an offline accounting database. |
| C07 | Automatic capture | Implemented, opt-in | `autoCapture` defaults to `false`; matching user messages can be submitted after a turn. It is not guaranteed complete conversation capture or a locally running fact-extraction model. |
| C08 | Cache and write queue | Implemented with limitations | Some recall/search paths cache previous responses and some writes can be queued. Recovery is opportunistic; not all tools use this path. No claim of full offline search, lossless synchronization, or permanent local history. |
| C09 | Local data handling | Local cache/queue files exist | Cloud-backed does not mean nothing is stored on disk. These files may contain memory content; no built-in encryption claim. |
| C10 | Browser login and key setup | Implemented | Browser device login, shared XMemo credential, environment key, and supported setup commands; see the README. Never place live credentials in examples. |
| P01 | Complete local mode without cloud | **Planned** | Target: local transactions, full-text and local semantic retrieval, revisions, recovery, and continuity without a cloud account. Not shipped in 1.0.18. |
| P02 | Hybrid local/cloud mode | **Planned** | Target: explicit sharing, local commits, durable sync, conflict preservation, and deletion propagation. Not the current cache/queue. |
| P03 | Leading benchmark performance | **Unproven** | Comparative superiority requires reproducible results with fixed versions and configurations. No “fastest”, “best”, “leading”, or “zero data loss” claim today. |

中文对外口径：**当前是云记忆插件；本地缓存与部分写入队列提供有限容错；完整 Local 与 Hybrid 是后续路线。** 后续只有在对应能力通过发布验收后，才将 P01/P02 改为已交付。

## Current tool inventory: 16

The current release registers 16 tools.

The manifest and tool registrations are the source of truth. The 16 registered tools describe exposed cloud-backed operations, not separate offline capabilities.

See the [bilingual schema catalog](TOOL-CATALOG.md) for every registered parameter, requirement, constraint, explicit or descriptive default, and schema description. `memory_search.minScore` is a 0–1 threshold over known similarity scores; unknown scores are excluded. Host search status exposes `configured`, `connected`, `searchCapabilities`, and optional `lastError`. Its capabilities are `supportedSources: ["memory"]`, `sessionKeyFilter: "unsupported"`, and `unsupportedSources: ["sessions"]`. OpenClaw's `backend` value is `builtin` for host compatibility; the provider identity is `xmemo-memory`.

| Group | Tools |
|---|---|
| Host memory | `memory_search`, `memory_get`, `memory_store`, `memory_forget` |
| Memory management | `xmemo_memory_list`, `xmemo_memory_get`, `xmemo_memory_update` |
| TODO | `xmemo_todo_create`, `xmemo_todo_list`, `xmemo_todo_complete` |
| Events | `xmemo_record_event` |
| Restart snapshots | `xmemo_restart_snapshot_save`, `xmemo_restart_snapshot_restore` |
| Ledger | `xmemo_ledger_monthly_summary` |
| Audit | `xmemo_audit_events`, `xmemo_audit_consolidation` |

## Short answers / 常见问题

**Can I use it without XMemo cloud? / 不配云也能完整运行吗？**<br>
Not in 1.0.18. Complete local operation is planned. 当前不能；缓存不等于独立本地数据库。

**Is it the same as the XMemo Skill? / 和 XMemo Skill 一样吗？**<br>
No. The plugin supplies the native runtime and tools; the companion Skill supplies workflow guidance. 插件负责运行与工具，配套 Skill 负责使用指导。

**Will every conversation be saved automatically? / 会自动保存所有对话吗？**<br>
No. Automatic capture is disabled by default and uses selective triggers when enabled. 默认关闭；启用后也是选择性捕获。

**Does cloud memory mean no local files? / 云记忆是否完全不落盘？**<br>
No. Cache and queue files can contain content. 完整本地存储、撤权清理与加密能力须分别验证，不能由“云端”一词推导隐私承诺。

**Can I share memories with other AI clients? / 能跨客户端共享吗？**<br>
Yes, through approved clients and authorized scopes on the same XMemo service. Client setup and permissions still apply. 跨客户端共享以实际授权与可见范围为准。

## Evidence and maintenance

Runtime implementation evidence is pinned to the current source baseline commit `ee22f7855074d0b2fe8040dbe7182f489e7de5d7`; this P0d slice changes documentation, package metadata, and parity tooling only. It records package version `1.0.18`, manifest minimum OpenClaw `2026.6.9`, and the local validation runtime snapshot Node `v26.9.0` (not a supported-runtime claim). Competitor comparison references are source commits reported in the 2026-09-27 audit, not claims of latest releases or equivalent benchmarks:

- XMemo baseline audit: `e22df8a1981c522469b1b620d64097d995beb432`.
- Mem0: `94c3fe9f238f3dbf29c9ce98643bd71eb13077cd`; Honcho: `7d98107298b0f7e1e31bd3fb9ddd3f1ff18ca50e`.
- OpenViking: `a09a9d20a8e07d08973aee177802d00e08df29e6`; TencentDB Agent Memory: `bd88cc83870bf9e7dbd2ec36aa13608d2295c7f4`.
- OpenClaw LanceDB: `5f3781df412caf60e3258428cf0bb7e406f19a76`.

Source pointers at the pinned implementation baseline: [tool registrations](https://github.com/yonro/xmemo-openclaw-memory/blob/ee22f7855074d0b2fe8040dbe7182f489e7de5d7/src/tools.ts), [host search/status](https://github.com/yonro/xmemo-openclaw-memory/blob/ee22f7855074d0b2fe8040dbe7182f489e7de5d7/src/search-manager.ts), [configuration](https://github.com/yonro/xmemo-openclaw-memory/blob/ee22f7855074d0b2fe8040dbe7182f489e7de5d7/src/config.ts), [capture](https://github.com/yonro/xmemo-openclaw-memory/blob/ee22f7855074d0b2fe8040dbe7182f489e7de5d7/src/auto-capture.ts), and [manifest](https://github.com/yonro/xmemo-openclaw-memory/blob/ee22f7855074d0b2fe8040dbe7182f489e7de5d7/openclaw.plugin.json).

These competitor references are the sources checked by that audit, not necessarily latest releases. No same-data competitor performance benchmark was run. The test `src/documentation-parity.test.ts` compares the manifest, actual registered schemas, README inventories, and this facts page.

Before each release, the release owner updates the version/date, verifies the inventory and defaults, attaches relevant acceptance evidence, and synchronizes both READMEs and listing copy. Any benchmark statement must include platform, data scale, product/model versions, measured metrics, and limitations. Do not turn download counts into active-user or quality claims.

Setup: [English README](../README.md) · [中文说明](../README_CN.md).
