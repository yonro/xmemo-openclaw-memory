# XMemo Ecosystem Parity Specification & Gap Analysis (PARITY.md)

> 历史对照说明：本文主体来自2026-09-22、v1.0.16阶段的切片分析。2026-09-28按插件1.0.18源码更新了插件工具参数、ledger路由、行分页与host search能力；服务端与Skill签名并未在本次完整复核。原“197/197”只是历史测试记录，不是当前测试结果；曾列出的服务端/Skill工具数也未经当前复核，故不作为现状基线。当前能力与规划以[产品事实](docs/PRODUCT-FACTS.md)为准；本文🟢只表示历史接口对照，不证明离线、同步或可靠性验收完成。

**任务编号**: `[TID:INBOX-20260922-1DC6EC]` (P1)  
**计划对应**: `.progress/plans/XMEMO-SKILL-UX-IMPROVEMENTS-2026-09-22.md` 切片 S5（最终片）  
**目标仓库**: `D:\repos\xmemo-openclaw-memory` (v1.0.16)  
**对照来源**:
- 服务端 MCP 源码: `D:\repos\memory-os\src\memory_manager\mcp\tools.py`
- 技能 CLI 源码: `D:\repos\memory-os-cli\skills\xmemo\scripts\xmemo-skill.mjs`
- 插件工具源码: `D:\repos\xmemo-openclaw-memory\src\tools.ts`
- 插件客户端源码: `D:\repos\xmemo-openclaw-memory\src\client.ts`

---

## 1. 执行路径选择说明 (Path Selection & Rationale)

依据任务指令明确赋予的决策分支：
> *“然后二选一（取信息更全者）：(a) 若服务端 MCP 工具齐全且插件可直接暴露：插件补齐 overview/activity/stats/ledger-list/ledger-summary/todo-list 对应工具...；(b) 若对齐成本超切片：产出 PARITY.md 对照清单 + 缺口说明 + 后续切片建议，不改代码。”*

经第一步全面源码核实，**正式选择路径 (b)**。核心原因与客观架构事实如下：

1. **插件实际工具存量与初始假设不符**：
   - 任务描述假定插件仅有 4 个 MCP 工具（`memory_store/memory_search/memory_get/memory_forget`）。
   - 经源码核实，插件 `src/tools.ts` 当前**已完整注册 16 个工具**，包括已有扩展工具：`xmemo_todo_create`、`xmemo_todo_list`、`xmemo_todo_complete`、`xmemo_record_event`、`xmemo_memory_list`、`xmemo_memory_get`、`xmemo_memory_update`、`xmemo_restart_snapshot_save`、`xmemo_restart_snapshot_restore`、`xmemo_ledger_monthly_summary`、`xmemo_audit_events`、`xmemo_audit_consolidation`。
2. **“直接暴露”在物理架构上不可行**：
   - 服务端 MCP 工具（`src/memory_manager/mcp/tools.py`）运行在 Python FastMCP 服务端，直接调用底层 `MemoryManager` / SQL 数据库服务。
   - OpenClaw 插件是独立的 TypeScript 宿主扩展，所有远端操作均通过 HTTP REST 客户端（`XMemoClient`）向 `xmemo.dev` 发起网络请求。插件并非 MCP 反向代理，**无法“直接暴露”服务端 Python 函数**。
3. **传输协议需要逐项接入（已按1.0.18勘误）**：
   - 针对 `overview`、`activity`、`ledger-list`、`ledger-summary`，生产环境 API Key 数据面统一通过 `POST /v1/skill/operations` 路由。
   - 插件 `getLedgerMonthlySummary` 已接入 `POST /v1/skill/operations` 的 `ledger-summary` 操作；不能再把ledger迁移列作尚未实现。overview/activity/ledger-list等缺失能力仍需各自的客户端方法、参数白名单与异常分类。
4. **命名空间与参数契约保护**：
   - OpenClaw 存在多插件共存环境，非 Slot 工具统一强制 `xmemo_` 前缀以防全局工具污染；若直接使用服务端裸名（如 `memory_overview`、`list_ledger_transactions`），会破坏 OpenClaw 隔离规范。
   - 现有工具（如 `xmemo_todo_list` 的 `status`、`xmemo_ledger_monthly_summary` 的 `month`/`year`）保留兼容参数并有源码回归测试；历史测试总数不代表当前验证结果。
5. **“取信息更全者”**：
   - 该历史选择记录曾列出服务端与Skill工具数量；它们未经本次复核，不能据此称为当前全景清单。插件的当前工具与参数以[注册 schema 目录](docs/TOOL-CATALOG.md)和自动 parity 测试为准。

---

## 2. 全景三方 Parity 对照表 (The 3-Way Parity Matrix)

| 功能领域 | 插件工具 (Plugin, OpenClaw) | 服务端 MCP 工具 (Server MCP) | 技能 CLI 命令 (Skill CLI) | Parity 状态 | 差异与缺口特征 |
| :--- | :--- | :--- | :--- | :---: | :--- |
| **持久记忆存储** | `memory_store` (Slot) | `remember` / `store_memory` | `remember` | 🟢 对齐 | 插件作为 OpenClaw Slot 实现；服务端提供参数更丰富的重载。 |
| **语义检索召回** | `memory_search` (Slot)<br>`xmemo_memory_list` (Ext) | `recall` / `search_memory` / `recall_context` | `recall`<br>`search`<br>`recall-context` | 🟢 接口对齐 | 部分路径支持两级检索和已缓存查询回退；list支持 `memory_type` 检索过滤，这不是权限隔离或完整离线搜索。 |
| **单条记忆读取** | `memory_get` (Slot)<br>`xmemo_memory_get` (Ext) | `read_memory` / `explain_memory` | `read` | 🟢 接口对齐 | 插件支持 `from`/`lines` 按行分页与跨路径 UUID 读取；精确读取不等于模糊召回。 |
| **记忆在位更新** | `xmemo_memory_update` (Ext) | `update_memory` | `update` | 🟢 对齐 | 均走 `PATCH /v1/memories/{id}`，严格校验 update scope。 |
| **记忆软删除** | `memory_forget` (Slot) | `forget` / `forget_memory` | `forget` | 🟢 接口对齐 | 走 `POST /v1/memories/{id}/forget`；默认 `soft_delete`，插件也接受 `hard_delete` / `redact`。 |
| **概览指标** | ❌ **无对应工具** | `memory_overview` | `overview` | 🔴 缺失 | 插件缺少账户统计/存储/Token 消耗概览工具。 |
| **记忆多维统计** | ❌ **无对应工具** | `memory_stats` | `stats` | 🔴 缺失 | 插件缺少 `GET /v1/memories/stats` 分组、时间与类型统计工具。 |
| **近期活动流** | ❌ **无对应工具** | `memory_activity` | `activity` | 🔴 缺失 | 插件缺少查询增删改审计活动流的工具。 |
| **账本交易列表** | ❌ **无对应工具** | `list_ledger_transactions` | `ledger-list` | 🔴 缺失 | 插件目前完全无法列出具体流水与关联 ID。 |
| **账本月度汇总** | `xmemo_ledger_monthly_summary` | `get_monthly_ledger_summary` | `ledger-summary` | 🟢 对齐 | 插件已迁移至 `POST /v1/skill/operations` (`ledger-summary`)，主参数对齐 `months`，保留 `month`/`year` 兼容映射；403 明确提示重授 `ledger:read`，不降级缓存。 |
| **记录新增支出** | ❌ **无对应工具** | `add_expense` | `expense-add` | ⚪️ 规划中 | 技能与服务端已具备写入能力，插件作为读取优先侧暂缓。 |
| **待办事项创建** | `xmemo_todo_create` (Ext) | `create_memory_todo` / `create_reminder` | `todo-add` | 🟢 对齐 | 支持 `content` 与 `due_at`。 |
| **待办事项列表** | `xmemo_todo_list` (Ext) | `list_memory_todos` / `todo_list` | `todo-list` | 🟡 参数差异 | 插件使用 `status` (`open`/`completed`)；服务端使用 `item_status`，且插件缺少 `limit` 和 `due_before`。 |
| **待办事项完成** | `xmemo_todo_complete` (Ext) | `complete_memory_todo` / `complete_reminder` | `todo-done` | 🟢 对齐 | 均按唯一 ID 完成。 |
| **轻量工作状态** | ❌ **无对应工具** | `update_state` | `save-state`<br>`restore-state` | 🟡 缺口 | 插件目前仅有重启快照，无单一任务状态槽位的快捷工具。 |
| **会话重启快照** | `xmemo_restart_snapshot_save`<br>`xmemo_restart_snapshot_restore` | `create_restart_snapshot`<br>`restore_restart_snapshot` | `restart-snapshot`<br>`restart-restore` | 🟢 对齐 | 完整覆盖打包保存与状态恢复。 |
| **轻量时间线事件** | `xmemo_record_event` (Ext) | `record_event`<br>`get_timeline` | (内部使用) | 🟢 部分对齐 | 插件具备记录事件能力，缺少时间线独立读取工具。 |
| **审计与合并日志** | `xmemo_audit_events`<br>`xmemo_audit_consolidation` | `query_audit`<br>`query_consolidation_audit` | (无 CLI 命令) | 🟢 插件超前 | 插件已支持审计与归并记录查询。 |

### 2.1 当前插件 schema 与宿主状态契约

插件当前**注册 16 个工具**。其参数名、必填项、约束、显式默认值与描述以 [工具 schema 目录](docs/TOOL-CATALOG.md)中的实时注册快照为准；`src/documentation-parity.test.ts` 会将快照、manifest、README（中英文）和产品事实页与真实注册结果比较。

`memory_search.minScore` 是 0–1 的真实相似度阈值，未知分数结果不满足阈值。OpenClaw host search manager 的 `searchCapabilities` 声明 `supportedSources: ["memory"]`、`sessionKeyFilter: "unsupported"`、`unsupportedSources: ["sessions"]`；provider status 另含 `configured`、`connected` 与可选 `lastError`。`backend: "builtin"` 是宿主兼容映射，不表示本插件使用 OpenClaw 内置记忆；`provider: "xmemo-memory"` 标识实际插件。

---

## 3. 核心工具源码签名逐项核对 (Exact Signature Discrepancies)

### 3.1 概览工具 (`overview`)
- **服务端 MCP 签名** (`src/memory_manager/mcp/tools.py:7955`):
  ```python
  def memory_overview(
      section: Literal["overview", "stats", "activity"] = "overview",
      memory_type: str = "%",
      since: str = "",
      until: str = "",
      group_by: str = "",
      top_n: int = 10,
      path_filter: str = "%",
      scope: str = "",
      activity_type: str = "all",
      limit: int = 10,
      include_timeline: bool = True,
      output_json: bool = False,
  ) -> str
  ```
- **技能 CLI** (`xmemo-skill.mjs`):
  - 命令: `node scripts/xmemo-skill.mjs overview [--json]`
  - 路由: `POST /v1/skill/operations` with `{ operation: "overview", arguments: {} }`
- **插件现状**: ❌ 未实现。

---

### 3.2 统计工具 (`stats`)
- **服务端 MCP 签名** (`src/memory_manager/mcp/tools.py:8202`):
  ```python
  def memory_stats(
      memory_type: str = "%",
      since: str = "",
      until: str = "",
      group_by: str = "",
      top_n: int = 10,
      path_filter: str = "%",
      scope: str = "",
      output_json: bool = False,
  ) -> str
  ```
- **技能 CLI** (`xmemo-skill.mjs`):
  - 命令: `node scripts/xmemo-skill.mjs stats [--type <t>] [--since <s>] [--until <u>] [--group_by <g>] [--top-n <n>]`
  - 路由: `GET /v1/memories/stats`
- **插件现状**: ❌ 未实现。

---

### 3.3 活动流工具 (`activity`)
- **服务端 MCP 签名** (`src/memory_manager/mcp/tools.py:8400`):
  ```python
  def memory_activity(
      activity_type: str = "all",
      since: str = "",
      until: str = "",
      limit: int = 10,
      include_timeline: bool = True,
      output_json: bool = False,
  ) -> str
  ```
- **技能 CLI** (`xmemo-skill.mjs`):
  - 命令: `node scripts/xmemo-skill.mjs activity [--limit <n>] [--type <t>]`
  - 路由: `POST /v1/skill/operations` with `{ operation: "activity", arguments: { limit, activity_type } }`
- **插件现状**: ❌ 未实现。

---

### 3.4 账本交易列表 (`ledger-list`)
- **服务端 MCP 签名** (`src/memory_manager/mcp/tools.py:2688`):
  ```python
  def list_ledger_transactions(
      limit: int = 20,
      offset: int = 0,
      query: str = "",
      currency: str = "",
      date_from: str = "",
      date_to: str = "",
      category: str = "",
      min_amount: Optional[float] = None,
      max_amount: Optional[float] = None,
      transaction_type: str = "",
      bucket: str = "%",
      scope: str = "",
      output_json: bool = False,
  ) -> str
  ```
- **技能 CLI** (`xmemo-skill.mjs`):
  - 命令: `node scripts/xmemo-skill.mjs ledger-list [--limit <n>] [--offset <o>] [--query <q>] [--month <YYYY-MM>] [--currency <c>] [--type <t>]`
  - 路由: `POST /v1/skill/operations` with `{ operation: "ledger-list", arguments: { ... } }`
- **插件现状**: ❌ 未实现。

---

### 3.5 账本月度汇总 (`ledger-summary` vs `xmemo_ledger_monthly_summary`)
- **服务端 MCP 签名** (`src/memory_manager/mcp/tools.py:2728`):
  ```python
  def get_monthly_ledger_summary(
      months: int = 6,
      currency: str = "",
      transaction_type: str = "",
      bucket: str = "%",
      scope: str = "",
      output_json: bool = False,
  ) -> str
  ```
- **技能 CLI** (`xmemo-skill.mjs`):
  - 命令: `node scripts/xmemo-skill.mjs ledger-summary [--months <n>] [--currency <c>] [--type <t>]`
  - 路由: `POST /v1/skill/operations` with `{ operation: "ledger-summary", arguments: { months, currency, transaction_type } }`
- **插件实现** (`src/tools.ts`, `src/client.ts`):
  - 路由: `POST /v1/skill/operations` with `{ operation: "ledger-summary", arguments: { months, currency, transaction_type } }`
  - 参数对齐: 主参数对齐为 `months` (1-24，默认 6)，支持 `currency` 与 `transaction_type`。严格白名单过滤。
  - 向后兼容: 兼容保留 `month` 与 `year` 入参，内部平滑映射至 rolling months。
  - 403 行为: 当服务端返回 403 Forbidden 或提示缺少 `ledger:read` scope 时，绝不降级至本地缓存，立即向用户明确提示重新授权并勾选 `ledger:read` 权限。
- **核查结论**: 🟢 已通过 P0 修复对齐。路由已脱离 `/v1/me/ledger/monthly-summary` 会话面，支持独立 API token，鉴权与参数策略完整对齐。

---

### 3.6 待办事项列表 (`todo-list` vs `xmemo_todo_list`)
- **服务端 MCP 签名** (`src/memory_manager/mcp/tools.py:4945` & `4881`):
  ```python
  def list_memory_todos(
      limit: int = 20,
      bucket: str = "%",
      scope: str = "",
      item_status: str = "open",
      due_before: str = "",
  ) -> str
  ```
- **技能 CLI** (`xmemo-skill.mjs`):
  - 命令: `node scripts/xmemo-skill.mjs todo-list [--status <open|completed|all>] [--limit <n>] [--due_before <iso>]`
  - 路由: `POST /v1/skill/operations` 或 `GET /v1/reminders`
- **插件现有签名** (`src/tools.ts:895`):
  ```typescript
  name: "xmemo_todo_list",
  parameters: Type.Object({
    status: Type.Optional(Type.String({ default: "open" })),
    bucket: Type.Optional(Type.String()),
  })
  ```
- **核查结论**: 插件已拥有成熟的过滤与别名归一化逻辑，缺少 `limit` 与 `due_before` 可选参数，未对齐服务端 `item_status` 原始键名（目前内部映射后传给 `client.listReminders`）。

---

## 4. 后续实施切片建议 (Subsequent Slice Recommendations)

以下是历史微切片建议，执行前需重新核对当前接口和测试基线；197项是历史记录。已交付部分从待办中移除，其余可按3片推进：

### 建议切片 P1 (Client Transport Layer)
- **目标**: 在 `D:\repos\xmemo-openclaw-memory\src\client.ts` 接入标准的 `skillOperations` 请求基础设施。
- **改动范围**:
  - 新增 `executeSkillOperation(operation: string, args: Record<string, unknown>, signal?: AbortSignal)`
  - 实现 `overview`、`activity`、`listLedgerTransactions`、`getMemoryStats` 方法。
  - 已交付：`getLedgerMonthlySummary` 使用 `POST /v1/skill/operations`；保留既有授权与错误行为，避免重复迁移。
  - 单测覆盖：4 个新客户端方法的 URL、入参 allow-list、401/403 鉴权透传。

### 建议切片 P2 (Diagnostic Tools Parity)
- **目标**: 在 `src/tools.ts` 注册只读诊断工具。
- **改动范围**:
  - 注册 `xmemo_memory_overview`（别名兼容 `memory_overview`）
  - 注册 `xmemo_memory_stats`（别名兼容 `memory_stats`）
  - 注册 `xmemo_memory_activity`（别名兼容 `memory_activity`）
  - 补充成功、无权限 (403)、空数据的单元测试。

### 建议切片 P3 (Ledger & TODO Parity)
- **目标**: 补全账本交易流水工具，并向后兼容扩展已有汇总与待办工具。
- **改动范围**:
  - 注册新工具 `xmemo_ledger_list`（对齐 `list_ledger_transactions`）。
  - 已交付：`xmemo_ledger_monthly_summary` 支持 `months`，保留 `month`/`year` 兼容；新切片不得重复实现或破坏旧参数。
  - `xmemo_todo_list` 扩展支持 `limit`、`due_before` 及 `item_status` 参数别名。
  - 补充对应工具级测试。
