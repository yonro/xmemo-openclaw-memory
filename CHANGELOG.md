# Changelog

All notable changes to this project will be documented in this file.

## [1.1.1] - 2026-10-26

### Security

- Remove `ledger:write` from default browser-login scopes. Keep `memory:read`, `memory:write`, `memory:restore`, and `ledger:read`; native memory operations and ledger summaries remain available with the required server permissions.
- Preserve explicit `--scopes` overrides for clients that need ledger writes. The option replaces the entire default list, so include every required permission.

### Changed

- Explain before browser authorization that successful login replaces the shared XMemo credential, and flag when ledger writes are not requested.
- Add English and Chinese instructions for shared-credential users who also record expenses through XMemo Skill or MCP, plus login and credential-persistence regression coverage.

### Upgrade notes

- Upgrading does not revoke existing tokens or remove their granted permissions. To drop a previously granted `ledger:write`, obtain a narrower credential and revoke the old token through account controls.
- Re-login replaces the shared credential: clients using that file may lose permissions omitted from the new token. For expense recording, explicitly include `ledger:write` along with the memory and ledger-read scopes described in the README. Server policy determines the actual grant.
- The production temporal-filtering verification limitation (B2 **UNVERIFIED**) documented in 1.1.0 remains unchanged. Local and CI tests do not establish live server authorization or production end-to-end filtering.

## [1.1.0] - 2026-10-25

### Added

- Seven optional temporal controls on `memory_search`: `since`, `until`, `owner_timezone`, `reference_time`, `time_order`, `query_mode`, and `temporal_axis_mode`.
- Local validation of timestamps, timezones, enums, and activity-log windows of at most 90 elapsed days, including fractional-second and DST boundaries.
- Independent Ubuntu compatibility CI for OpenClaw 2026.6.9 and 2026.7.1-2.

### Safety and compatibility

- Temporal queries use only L1 POST recall; HTTP 4xx and cancellation cannot fall back to stale results or unconstrained keyword search. Transient failures may reuse only matching temporal and identity cache entries.
- Advanced ordering preserves server order while deduplicating IDs; calls without temporal parameters retain the existing request and cache behavior.
- Exclude project-local DevFlow state, agent adapters, and workflow documents from source control; release packages retain an explicit product-file allowlist.

### Limitations

- Temporal controls apply to `memory_search`; `xmemo_memory_list` and native MemorySearchManager do not have equivalent coverage.
- Upstream L0 fix `b2e8857dd` is included in deployment-time SHA `03ec4c375d7ca33aeb061be5aa86561eeb85bfcc`. Current backend SHA attestation and isolated production temporal negative tests (B2) remain **UNVERIFIED**. Client tests do not establish production end-to-end filtering. Historical S3 test provenance is supported by independent re-inspection on 2026-10-25, not equality to the original reviewed byte hash.

## [1.0.19] - 2026-10-12

### Fixed

- Remove `contracts.tools` from the plugin manifest to address the reported ClawHub `manifest-unknown-contracts` finding. Tools remain registered at runtime.
- Update manifest auth metadata tests to use `toolMetadata`.

## [1.0.18] - 2026-09-23

### Security

- **移除 login 时自动打开浏览器**: 此前把服务端返回的授权 URL 拼进 shell 命令执行，存在命令注入风险（1.0.16/1.0.17 受影响）。彻底移除 `node:child_process` 依赖，改为仅在控制台打印授权链接与验证码供用户手动打开。
- **保留 `--no-open` 兼容参数**: `--no-open` 选项保留为无操作兼容参数，避免既有脚本报错。

### Fixed

- **配置敏感属性修正**: `openclaw.plugin.json` 中的 `recallMaxTokens` 显式设置 `"sensitive": false`，防止平台命名模式将其误标为敏感凭证。

## [1.0.17] - 2026-09-23

### Fixed

- **xmemo_ledger_monthly_summary 路由迁移**: 迁移至 `POST /v1/skill/operations` (`op: "ledger-summary"`)，解决旧 `GET /v1/me/ledger/monthly-summary` 对 API token 返回 401 导致 1.0.16 该工具线上不可用的问题。
- **403 权限提示优化**: 当服务端返回 403 `permission_denied`（缺少 `ledger:read` scope）时，明确提示用户重新授权以获取相应权限范围。

### Added

- **参数增强与向后兼容**: `xmemo_ledger_monthly_summary` 新增 `months` 与 `transaction_type` 过滤参数，同时保留 `month` / `year` 作为兼容别名。
- **生态对照规范 (Docs)**: 新增 `PARITY.md`，提供 XMemo 服务端 MCP、Skill CLI 与 OpenClaw 插件三方生态契约对照、缺口分析与演化路线图。

## [1.0.16] - 2026-09-21

### Fixed

- Set `autoCapture` default to `false`.

## [1.0.15] - 2026-09-21

### Fixed

- Filter out soft-deleted memories in `memory_list`, `search`, and `get`.
