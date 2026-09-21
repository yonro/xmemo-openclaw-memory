# S3 Bug 4 TODO 全链路取证与归因报告

- **日期**: 2026-09-21
- **任务编号**: `INBOX-20260921-S3-TODO-CHAIN-EVIDENCE`
- **执行依据**: `docs/plans/2026-09-21-openclaw-bug-audit-and-repair-plan.md` (§3 Bug 4 / §6 S3 / §7 TODO 矩阵)
- **目标服务**: `https://xmemo.dev` (生产环境 REST API)
- **凭据类型**: 专用测试凭据（包含 `memory:read`, `memory:write` 权限）
- **测试脚本**: `scripts/evidence-todo-chain.mjs`
- **单测套件**: `src/tools.todo.test.ts` (8/8 通过，全套 193/193 通过)

---

## 1. 结论与执行摘要

1. **Bug 4 现象在同空间基线下未复现**：
   - 在严格隔离的测试空间（`bucket: test-todo-s3-...`, `scope: scope-s3-...`）下，分别创建**无 `due_at`** 和**有未来 `due_at`**（`2026-12-31T23:59:59Z`）的 TODO。
   - **创建后立即查询**（未经 `complete`）：Plugin 默认查询、Plugin 显式 `open`、Plugin `%`、直接 REST `open`、直接 REST `%` **均 100% 立即返回新创建的 TODO**。
   - 目标 ID、正文、空间属性、`due_at` 完全一致，断言全部通过（19/19 checks PASS）。

2. **插件 REST 请求与直接 REST 表现完全一致（100% Parity）**：
   - 直接 REST `/v1/reminders` 与插件工具 `xmemo_todo_list` 提取字段与候选集合完全一致，不存在“REST 可见而插件过滤丢弃”的现象。
   - 因而根据计划原则“REST 可见而插件不可见才修插件，未取证前不得修改读取范围默认值”，**不盲目修改插件读取范围默认值**。

3. **原报告“新建 TODO 在 open 列表中不见”的深度归因**：
   - **空间范围错配风险**：`xmemo_todo_create` 写入时使用 `cfg.bucket`（默认 `openclaw`）及 `cfg.scope`；而 `xmemo_todo_list` 工具内部默认 `targetBucket = cfg.bucket`（而非 `readBucket: "%"`）。若用户通过 CLI/MCP 或其他 agent 在 `work` 等其他 bucket 创建了 reminder，OpenClaw 调用未传 bucket 的 `xmemo_todo_list` 将无法查询到跨 bucket 的 reminder。
   - **服务端访问过滤分页截断缺陷（Critical Server-side Finding）**：
     在服务端 `D:\repos\memory-os\src\memory_manager\services\action_items.py` 行 124–126：
     ```python
     rows = manager._filter_accessible_rows(rows, ...)
     # ...
     if len(rows) < page_size:
         break
     offset += len(rows)
     ```
     数据库单页抓取 `page_size` 条记录后，在内存中执行 `_filter_accessible_rows`。若当前页中存在无权限访问的记录，过滤后的 `len(rows)` 将小于 `page_size`，导致代码**误判已到末页而执行 `break`**，或者后续查询使用的 `offset += len(rows)` 出现重叠和错位，导致后续可见的 TODO 被截断而不可见。

---

## 2. 全链路取证步骤与真实数据

### (1) 创建测试夹具与存储语义核对
- **Run ID**: `s3-muau369o-p1xr`
- **专用 Bucket**: `test-todo-s3-muau369o-p1xr`
- **专用 Scope**: `scope-s3-muau369o-p1xr`

| 夹具 | 创建途径 | 输入参数 | 响应 ID | 服务返回存储语义 |
|---|---|---|---|---|
| **Todo A (无 due_at)** | `xmemo_todo_create` 工具 | `content: TODO-A-s3-muau369o-p1xr-no-due` | `681441b7-4c29-4bf1-acb4-dc359fdd5a1e` | `item_kind: reminder`, `item_status: open`, `due_at: null`, `scope: test-todo-...` |
| **Todo B (有未来 due_at)** | `client.createReminder` | `content: TODO-B-s3-muau369o-p1xr-future-due`, `due_at: 2026-12-31T23:59:59Z` | `ee0ceed7-4adc-41b9-ab4e-5e8a0123b2fe` | `item_kind: reminder`, `item_status: open`, `due_at: 2026-12-31T23:59:59Z` |

> 存储语义发现：服务端 `POST /v1/reminders` 响应 payload 为 `{ id, item_kind, item_status, due_at, scope }`，不重复返回 `content`。插件 `tools.ts` 中使用 `reminder.content?.trim() || content` 兜底展现正文完全符合后端接口语义。

### (2) 同一凭据下立即查询（未经过 complete）

| 查询方式 | 参数 | 预期目标 A / B | 实际结果 | 状态 |
|---|---|---|---|---|
| Plugin `xmemo_todo_list` | `{}` (默认) | A (`681441b7...`), B (`ee0ceed7...`) | 查得 2 条，A 与 B 均在列表中 | **PASS** |
| Plugin `xmemo_todo_list` | `{ status: "open" }` | A (`681441b7...`), B (`ee0ceed7...`) | 查得 2 条，A 与 B 均在列表中 | **PASS** |
| Plugin `xmemo_todo_list` | `{ status: "%" }` | A (`681441b7...`), B (`ee0ceed7...`) | 查得 2 条，A 与 B 均在列表中 | **PASS** |
| Direct REST `GET /v1/reminders` | `item_status=open` | A (`681441b7...`), B (`ee0ceed7...`) | HTTP 200，返回 2 条，包含 A、B | **PASS** |
| Direct REST `GET /v1/reminders` | `item_status=%` | A (`681441b7...`), B (`ee0ceed7...`) | HTTP 200，返回 2 条，包含 A、B | **PASS** |

### (3) 精确读取核对底层记忆元数据
通过 `GET /v1/memories/{id}/explain?include_embedding=false` 对两个 ID 进行权威只读检查：

```json
// Todo A (681441b7-4c29-4bf1-acb4-dc359fdd5a1e)
{
  "id": "681441b7-4c29-4bf1-acb4-dc359fdd5a1e",
  "memory_type": "working",
  "status": "active",
  "bucket": "test-todo-s3-muau369o-p1xr",
  "scope": "scope-s3-muau369o-p1xr",
  "metadata": {
    "item_kind": "reminder",
    "item_status": "open",
    "due_at": null
  }
}

// Todo B (ee0ceed7-4adc-41b9-ab4e-5e8a0123b2fe)
{
  "id": "ee0ceed7-4adc-41b9-ab4e-5e8a0123b2fe",
  "memory_type": "working",
  "status": "active",
  "bucket": "test-todo-s3-muau369o-p1xr",
  "scope": "scope-s3-muau369o-p1xr",
  "metadata": {
    "item_kind": "reminder",
    "item_status": "open",
    "due_at": "2026-12-31T23:59:59Z"
  }
}
```
- `memory_type`: **working** (符合契约)
- `status`: **active** (符合契约)
- `metadata.item_kind`: **reminder** (符合契约)
- `metadata.item_status`: **open** (符合契约)

### (4) 插件 REST 与直接 REST 对照
- Plugin 查得 ID 列表: `["681441b7-4c29-4bf1-acb4-dc359fdd5a1e", "ee0ceed7-4adc-41b9-ab4e-5e8a0123b2fe"]`
- REST 查得 ID 列表: `["681441b7-4c29-4bf1-acb4-dc359fdd5a1e", "ee0ceed7-4adc-41b9-ab4e-5e8a0123b2fe"]`
- 差异集: `diffMissingInPlugin = []`, `diffMissingInRest = []`。
- **对照结论**：插件和直接 REST 完全对称，插件层没有产生额外的候选丢失。

### (5) 边界用例覆盖
1. **空间隔离性 (Spatial Isolation)**:
   - 查询 `bucket = test-todo-...-isolated`: 返回 0 条，证明未发生跨空间数据串扰。
2. **非法状态参数 (Illegal Status Handling)**:
   - 查询 `item_status = illegal_status_val`: 服务端返回 HTTP 200 且列表为空（0 条），没有触发 500 异常。
   - 插件层支持别名映射：`pending`/`todo`/`active` 自动标准化为 `open`；`done`/`finish` 映射为 `completed`；`all`/`*` 映射为 `%`。
3. **分页与限制 (Pagination Limit Boundary)**:
   - 指定 `limit=1`: 返回 1 条记录，未丢失游标。

### (6) 完成与永久清理核对
1. **完成状态流转**:
   - 对 A 执行 `xmemo_todo_complete(idA)`: 返回 `details: { action: "completed", id: "681441b7..." }`。
   - 对 B 执行 REST `POST /v1/reminders/{idB}/complete`: 返回 HTTP 200，`item_status: "completed"`。
   - 再次查询 `item_status=open`: 结果为空（`count: 0`），A、B 均不再出现在 open 视图。
   - 再次查询 `item_status=completed`: A、B 均出现在 completed 视图中。
2. **夹具永久清理**:
   - 对 A、B 发送 `POST /v1/memories/{id}/forget` (`mode: soft_delete`)。
   - 最终查询 `test-todo-s3-muau369o-p1xr` 下的 `item_status=%`: 剩余记录为 **0**，夹具完全清除。

---

## 3. 自动化门禁结果

- **线上脚本执行**:
  ```text
  Evidence Run Summary: ALL CHECKS PASSED ✓
  Total Steps: 19
  Failures:    0
  ```
- **测试套件**: `npm test` -> 14 test files, 193 tests passed (100% green).
- **类型检查**: `npm run typecheck` -> 0 errors.
- **代码规范**: `npm run lint` -> 0 warnings, 0 errors.
- **打包验证**: `npm run build` -> 成功输出 `dist/`.
- **插件冒烟**: `node scripts/verify-plugin.mjs .` -> `OK: plugin entrypoint smoke test passed`.
