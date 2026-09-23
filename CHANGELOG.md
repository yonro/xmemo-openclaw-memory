# Changelog

All notable changes to this project will be documented in this file.

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
