# S2 Bug 2 本地文件陈旧引用取证与归因报告

- **日期**: 2026-09-21
- **任务编号**: `INBOX-20260921-4D2361`
- **执行依据**: `docs/plans/2026-09-21-openclaw-bug-audit-and-repair-plan.md` (§3 Bug 2 / §6 S2 / §7 本地引用矩阵)
- **测试脚本**: `scripts/evidence-local-stale-ref.mjs`
- **测试环境**: 严格隔离临时工作区（不触及任何用户真实记忆文件）

---

## 1. 结论与四来源逐项判定

| 来源分类 | 判定结果 | 核心证据与结论 |
|---|---|---|
| **来源 1：宿主本地索引 (memory-core/QMD)** | **成立 (FOUNDED)** | 引用格式 `Source: MEMORY.md#L22-L23` **100% 来源于 OpenClaw `memory-core` 的 `tools.citations.ts`**。当本地 `MEMORY.md` 在文件系统被删除后、下一次同步尚未执行的窗口期内，SQLite 数据库索引保留历史切片，搜索即产生该陈旧引用；一旦 `manager-sync-ops.ts` 执行 `deleteStaleRows()` 完成同步，该文件引用立即彻底清除。 |
| **来源 2：工具提供者路由 (Provider Slot)** | **条件成立 / 分离判定** | 当配置 `plugins.slots.memory = "xmemo-memory"` 生效时，`memory_search` 与 `memory_get` 完全由远程插件接管，**绝不扫描本地目录，也不生成行号锚点**；若配置未生效或未配置 slot，宿主回退至默认 `memory-core`，从而调用本地文件索引。 |
| **来源 3：云端历史记忆正文引用** | **部分可能（纯文本形态）** | 若用户或 LLM 先前将含有 `MEMORY.md#L22-L23` 的文本存入云端 XMemo，该文本会被检索返回。但此记录具有明确的云端 UUID、bucket 路径与时间戳，属于历史正文内容，绝不会被插件包装为当前存在的本地文件。 |
| **来源 4：插件检索缓存陈旧** | **排除作为本格式根因** | 插件缓存仅缓存远程 REST 响应；且在 S1 修复后已实现写入即失效（`invalidateRecallCache`）和仅瞬态网络故障降级。它不会主动构造 `MEMORY.md#L22-L23` 这类本地行号引用。 |

---

## 2. 取证细节与溯源证据

### (1) 引用格式 `MEMORY.md#L22-L23` 的代码溯源
在 `D:\repos\openclaw\extensions\memory-core\src\tools.citations.ts` 第 32–38 行：
```typescript
function formatCitation(entry: MemorySearchResult): string {
  const lineRange =
    entry.startLine === entry.endLine
      ? `#L${entry.startLine}`
      : `#L${entry.startLine}-L${entry.endLine}`;
  return `${entry.path}${lineRange}`;
}
// 组合输出格式：
const snippet = `${entry.snippet.trim()}\n\nSource: ${citation}`;
```
当 `entry.path` 为 `MEMORY.md`、起始行为 22、结束行为 23 时，输出确凿为：
`Source: MEMORY.md#L22-L23`。
对比：`xmemo-openclaw-memory` 的 `search-manager.ts` 中行号恒固定为 1，格式为 `[id: <uuid>]`，**从未生成过 `#L22-L23` 形式的锚点**。

### (2) 隔离工作区文件删除与同步时序验证
在临时工作区创建带唯一标识 token 的 `MEMORY.md`（含第 22–23 行特征内容）：
1. **删除前检索**: 索引库包含该文件切片，检索命中，返回 `Source: MEMORY.md#L22-L23`。
2. **物理删除文件后、同步执行前（Un-synced Window）**:
   - 文件系统 `fs.existsSync(testMemoryFile) === false`。
   - 此时 SQLite 数据库尚未感知删除事件，检索依然命中已删除文件的残留切片，返回 `Source: MEMORY.md#L22-L23`。
   - **这完整复现了用户报告的“文件已删但引用还在”的现场原因**。
3. **执行同步清理（`deleteStaleRows`）后**:
   - `openclaw/extensions/memory-core/src/memory/manager-sync-ops.ts:1830`:
     `deleteFileByPathAndSource.run(stale.path, "memory")`
     `deleteChunksByPathAndSource.run(stale.path, "memory")`
   - 清理后再次检索：切片为 0，陈旧引用彻底消失。

### (3) `xmemo-memory` Slot 接管与远程隔离验证
当配置生效时：
- `openclaw/src/plugins/slots.ts` 确保 slot `memory` 独占分配给 `xmemo-memory`。
- `XMemoSearchManager.search()` 仅请求 XMemo 远程接口（`/v1/memories/recall` 或 `/v1/memories/search`），返回路径统一为 `openclaw/<id>` 或 `memory/<id>`。
- `XMemoSearchManager.readFile({ relPath: "MEMORY.md" })`：经 S1 修复后，对未带有效 UUID 的纯本地文件名直接抛出 `Memory not found for path: MEMORY.md`，**绝不回退至宿主本地磁盘文件系统**。

---

## 3. 防护建议与现场指导

1. **若用户希望纯使用 XMemo 云记忆**:
   - 检查 OpenClaw 配置 `openclaw.json`，确保 `plugins.slots.memory` 设置为 `"xmemo-memory"`。
   - 禁用或忽略 `memory-core` 对工作区本地 `MEMORY.md` 的监听，避免本地与云端两套系统并存引起混淆。
2. **若本地文件已被删除但仍看到引用**:
   - 触发一次本地记忆同步（如 `openclaw memory sync`）即可促使 `deleteStaleRows` 剔除残留切片。
3. **用户真实记忆安全性**:
   - 本次调查与复现全部在进程临时目录中完成，未修改、删除或重建用户的真实记忆库与文件。
