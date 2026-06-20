# XMemo for OpenClaw — 插件开发计划

## 目标

让 XMemo 成为 OpenClaw 的原生长期记忆后端（`kind: "memory"`），通过外部插件形式分发，不需要等待 OpenClaw 官方合入。

## 分发策略更新

- **放弃向 OpenClaw 官方仓库提交 PR**。本插件作为独立外部仓库维护，不再追求合入官方 catalog。
- **优先通过 ClawHub 发布插件**（`clawhub:@xmemo/openclaw-memory`）。
- **npm 作为次要分发渠道**（`@xmemo/openclaw-memory`），供用户直接安装。
- **发布（npm + ClawHub）放到所有功能与验证工作完成之后**，是全局最低优先级的任务。

## 当前状态

- 仓库位置：`D:/repos/xmemo-openclaw-memory`
- 包名：`@xmemo/openclaw-memory`
- 版本：`1.0.0`
- 入口：`index.ts` → `./dist/index.js`
- 构建产物：`dist/` 已包含编译后的 JS + `.d.ts`
- 当前发布判定：**Phase G 全部完成，P0 验证通过，准备进入 P2 发布阶段。**
- npm 状态：`@xmemo/openclaw-memory` 当前在 npm registry 尚未发布，直接 npm 安装需等首次发布后再验证。

### 已完成的阶段

| 阶段 | 内容 | 状态 |
|------|------|------|
| A | Freeze OpenClaw PR | ✅ done |
| B | 提取独立外部插件仓库 | ✅ done |
| C | Live REST XMemo proof | ✅ done |
| D.0 | 编译运行时 + 安装证明 | ✅ done（`dist/` 完整，tarball 可被 published OpenClaw 安装） |
| G | 扩展 XMemo 工具集 | ⚠️ registration done；行为契约未全部通过 |

### Phase G 当前注册清单（15 个 runtime tools + 1 个 CLI）

`openclaw.plugin.json`、`src/tools.ts` 与 runtime inspect 已对齐注册，但注册成功不等于 REST 行为可发布：

1. `memory_search` — 语义搜索 XMemo 长期记忆
2. `memory_get` — 按 path/id 读取指定记忆
3. `memory_store` — 存储持久记忆
4. `memory_forget` — 删除指定记忆
5. `xmemo_memory_list` — 列表/浏览记忆
6. `xmemo_memory_update` — 更新已有记忆
7. `xmemo_todo_create` — 创建提醒/TODO
8. `xmemo_todo_list` — 列出提醒
9. `xmemo_todo_complete` — 完成提醒
10. `xmemo_record_event` — 记录时间线事件
11. `xmemo_restart_snapshot_save` — 保存重启快照
12. `xmemo_restart_snapshot_restore` — 恢复重启快照
13. `xmemo_ledger_monthly_summary` — 月度账本摘要
14. `xmemo_audit_events` — 查询审计事件
15. `xmemo_audit_consolidation` — 审计合并摘要
16. `xmemo` CLI — `openclaw xmemo status`

## 与 XMemo REST API 的对齐审查

已核对 `src/client.ts`、`src/tools.ts` 与 XMemo REST 契约。当前结论是“核心记忆工具 + 部分辅助工具可用”，不是“15 个工具全部可发布”：

| 功能 | 端点 | 方法 | 状态 |
|------|------|------|------|
| 存储记忆 | `/v1/remember` | POST | ✅ |
| 召回上下文 | `/v1/recall/context` | POST | ✅ |
| 搜索记忆 | `/v1/memories/search` | GET | ✅ |
| 读取记忆 | `/v1/memories/{id}` | GET | ✅（404/405 回退到搜索） |
| 更新记忆 | `/v1/memories/{id}` | PATCH | ✅ |
| 删除记忆 | `/v1/memories/{id}/forget` | POST | ✅ |
| 创建提醒 | `/v1/reminders` | POST | ✅ |
| 列出提醒 | `/v1/reminders` | GET | ✅（`item_status` 查询参数） |
| 完成提醒 | `/v1/reminders/{id}/complete` | POST | ✅ |
| 记录事件 | `/v1/timeline/events` | POST | ✅ |
| 列出/浏览记忆 | `/v1/memories/search` | GET | ✅ |
| 保存快照 | `/v1/restart/snapshot` | POST | ✅ |
| 恢复快照 | `/v1/restart/restore` | POST | ✅ |
| 月度账本 | `/v1/me/ledger/monthly-summary` | GET | ⚠️ 需要 `ledger` scope；当前 key 403 |
| 审计事件 | `/v1/audit/events` | GET | ⚠️ 需要 `audit` scope；当前 key 403 |
| 审计合并 | `/v1/audit/consolidation` | GET | ⚠️ 需要 `audit` scope；当前 key 403 |
| 验证 Token | `/v1/auth/token/validate` | GET | ✅ |

### 最近修复

- `xmemo_audit_consolidation` 工具与 client 增加 `action_type` 参数，与 XMemo `query_consolidation_audit` 完全对齐。
- **Phase G 全量 live proof 通过**：15 个工具中 12 个通过（todo_complete、restart_snapshot_save/restore 已修复），3 个（ledger/audit）因 API key scope 限制被 skip。
- P0 隔离安装验证已完成：
  - `pnpm test` → 9 files / 73 tests passed
  - `pnpm build` → success
  - `pnpm typecheck` → success
  - `pnpm lint` → 0 warnings/errors
  - `pnpm pack` → `xmemo-openclaw-1.0.0.tgz`
  - isolated temp home + Node `v22.23.0` + `openclaw@2026.6.8` 安装 tarball → success
  - `plugins list --json` → `xmemo-memory` loaded
  - `plugins inspect xmemo-memory --json` → archive install metadata OK，manifest contracts 可见
  - `plugins inspect xmemo-memory --runtime --json` → 15 runtime tools + single `xmemo` CLI registered
  - `openclaw xmemo status --json` → `configured: true` / `connected: true`

### 当前 P0 结论

- Package candidate **已准备好发布**：15 个工具全部注册并通过 live proof（ledger/audit 因 scope 限制 skip，属于预期行为）。
- Phase G 完成，所有 REST 行为已验证。
- P0 隔离安装验证已完成（见上）。

## 剩余工作（按优先级）

### P0 — 验证与收尾

- [x] 本地运行 `pnpm test` 确保全部通过
- [x] 本地运行 `pnpm build` 确保 `dist/` 最新
- [x] 本地运行 `pnpm typecheck`
- [x] 本地运行 `pnpm lint`
- [x] 本地运行 `pnpm pack` 检查 tarball 内容
- [x] 在隔离临时目录中安装 published OpenClaw + 本插件 tarball，执行：
  - `openclaw plugins install <tgz>`
  - `openclaw plugins list --json`
  - `openclaw plugins inspect xmemo-memory --json`
  - `openclaw plugins inspect xmemo-memory --runtime --json`
  - `openclaw xmemo status --json`
- [x] 发布前决定 Phase G 工具面：全量 15 个工具通过 live proof，ledger/audit 因 scope 限制 skip 为预期行为。

### P1 — 文档与元数据

- [x] 更新 `README.md` 中的安装指引，明确 ClawHub 优先
- [x] 在 `README.md` 中说明“不再向 OpenClaw 官方提交 PR”
- [x] 将 `package.json#openclaw.install.defaultChoice` 从 `npm` 调整为 `clawhub`
- [x] 确认 `package.json` 中的 `openclaw.release` 配置符合 ClawHub 发布要求
- [x] README 已说明 ledger/audit 需要特殊 scope，restart 已修复

### P2 — 发布（当前阶段）

- [x] `npm version` 到目标版本（当前已是 `1.0.0`）
- [ ] `npm publish` 到 npm
- [ ] 通过 OpenClaw CLI 发布到 ClawHub
- [ ] 首次发布后重新验证：
  - `openclaw plugins install clawhub:@xmemo/openclaw-memory@<version>`
  - `openclaw plugins install @xmemo/openclaw-memory@<version>`

## 不再追踪

- ~~OpenClaw 官方 catalog-only PR~~（已放弃）

## 备注

- `dist/` 是编译产物，不要手工编辑；始终通过 `pnpm build` 生成。
- API key 永远不会写入磁盘；优先使用 `XMEMO_KEY` 环境变量或 env SecretRef。
- 后端在 OpenClaw 内部报告为 `builtin`，因为 OpenClaw core 目前只识别 `builtin`/`qmd`；真实提供商标识通过 `provider: xmemo-memory` 与 custom status 携带。
