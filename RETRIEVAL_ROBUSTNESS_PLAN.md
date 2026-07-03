# @xmemo/openclaw-memory Retrieval Robustness Plan

## Context

Repository: `D:\repos\xmemo-openclaw-memory`

Current package version: `1.0.6`

This plan focuses only on the latest active issue: existing XMemo memories can be hard to find when the user's query does not match the wording, path, or writing agent of the saved memory.

Historical issues that are out of scope for this work:

- Initial `v1.0.0` / pre-release state.
- `v1.0.5` CI publish failure.
- TypeScript tarball entrypoint issue. Current `package.json#main` is `./dist/index.js`.
- `xmemo_memory_list` missing-query HTTP 422. The tool now requires a query.
- `xmemo_todo_complete` / restart snapshot server 500 blockers.
- Long manual config UX. The plugin now has `openclaw xmemo setup`, `openclaw xmemo login`, and `openclaw xmemo status`.
- npm / ClawHub release workflow cleanup.

Do not assume the plugin currently has `memory_activity` or `explain_memory` APIs. Activity-log fallback belongs in a later service/API phase unless those endpoints are added first.

## Goal

Reduce the failure rate for "memory exists but retrieval misses it" to near zero for common phrasing, path, and agent-boundary mismatches.

Primary regression case:

- A memory is saved with wording/path such as `自注册`, `功能改造`, `Agent Identity`.
- The user queries `免注册`.
- The plugin should find the memory without requiring the user to manually provide the original wording.

## Acceptance Criteria

- Query `免注册` can match mock memories containing `自注册`, `无需预注册`, `功能改造`, or `Agent Identity`.
- Cross-agent visible memory remains the default read behavior through `readBucket: "%"`, with `readScope` unset unless configured.
- `memory_search` does not stop after a weak or empty first `recall_context` result.
- `xmemo_memory_list` can use path hints and expanded queries.
- Empty results return actionable next-step guidance instead of implying that no memory exists.
- `debug: true` returns a retrieval trace with strategies tried, counts, path hints, and expanded queries, without leaking full memory content in `details`.

## Phase 0: Restore Local Verification

Before changing retrieval logic, make the local verification chain reliable.

Current known local issue:

- After cleaning `node_modules`, `pnpm test` may fail during frozen install because `package.json` `pnpm.overrides` and the lockfile configuration are mismatched for the bundled pnpm runtime.

Tasks:

1. Inspect `package.json`, `pnpm-lock.yaml`, and `pnpm-workspace.yaml`.
2. Update the pnpm override location or lockfile so install/test works with the declared package manager.
3. Verify these commands:

```powershell
pnpm test
pnpm typecheck
pnpm lint
pnpm build
node scripts/verify-plugin.mjs .
```

Do not commit `node_modules/`, `dist/`, `tmp-pack/`, `*.tgz`, or `reports/`.

## Phase 1: Add Retrieval Strategy Module

Create:

```text
src/retrieval-strategy.ts
src/retrieval-strategy.test.ts
```

Implement these helpers:

```ts
export type RetrievalTrace = {
  originalQuery: string;
  expandedQueries: string[];
  pathHint?: string;
  agentHint?: string;
  strategies: Array<{
    name: string;
    query?: string;
    path?: string;
    count: number;
    fromCache?: boolean;
    error?: string;
  }>;
};
```

Required functions:

- `expandQuery(query: string): string[]`
  - Include the original query.
  - Add a small, explicit synonym set for high-value XMemo terms.
  - Initial required examples:
    - `免注册` -> `自注册`, `无需预注册`, `自动创建`, `guest mode`
    - `自注册` -> `免注册`, `无需预注册`, `自动创建`, `guest mode`
    - `功能改造` -> `功能改进`, `升级计划`, `feature improvement`
- `tokenizeQuery(query: string): string[]`
  - Split English tokens and conservative Chinese chunks.
  - Keep this dependency-free.
- `extractRetrievalHints(query: string)`
  - Extract path-like hints such as `Projects/Xmemo/功能改造`.
  - Extract simple agent hints such as `chatgpt`, `openclaw`, `codex`.
  - Time hints can be recorded in trace but do not need filtering in this phase.
- `dedupeAndRank(results)`
  - Dedupe by memory id.
  - Prefer original-query results, then higher score, then path-hint matches.
  - Do not expose full content through trace/details.

## Phase 2: Improve `memory_search`

File:

```text
src/tools.ts
```

Current behavior:

- `memory_search` calls `resilient.recallContext(...)` once and returns empty if no items are found.

New behavior:

1. Add optional parameters:

```ts
debug?: boolean
minResults?: number
```

2. Run L1 semantic recall:

```text
recallContext(original query, maxItems)
```

3. If result count is lower than `minResults` (default `3`), continue to L2:

```text
searchMemory(expanded query variants)
```

4. If a path hint exists, run a path-aware search:

```text
searchMemory({ query, path })
```

5. Merge, dedupe, rank, and render results using the existing safe snippet formatting.

6. Return `details.trace` only when `debug: true`.

7. Empty result text should say:

```text
No matching XMemo memories were found for this query. This does not prove the memory does not exist. Try a different keyword, provide the saved path, specify the source agent, or provide an approximate time.
```

Security rule:

- Keep full memory content out of `details`.
- Continue treating recalled memory as untrusted historical context.

## Phase 3: Improve `xmemo_memory_list`

File:

```text
src/tools.ts
```

Add optional parameters:

```ts
path?: string
debug?: boolean
minResults?: number
```

New behavior:

- `query` remains required unless `path` is provided.
- If only `path` is provided, derive a query hint from the final path segment and the full path.
- Use expanded queries and path-aware search.
- Include path and id in visible output.
- Return `details.trace` only when `debug: true`.

Suggested empty result text:

```text
No XMemo memories matched the query/path. This may be a wording mismatch rather than absence. Try the saved path, source agent, or alternate keywords.
```

## Phase 4: Lightweight Write-Side Metadata

File:

```text
src/tools.ts
```

For `memory_store`, add low-risk metadata enrichment:

- `source_agent`
- `retrieval_tags`
- `expected_queries`

Rules:

- Do not overwrite user-provided metadata fields.
- Do not treat this as a guaranteed retrieval fix unless the XMemo service indexes metadata.
- Keep the enrichment deterministic and small.

## Phase 5: Prompt And Docs

Files:

```text
src/prompt-section.ts
README.md
PLAN.md
```

Update guidance:

- Empty memory search results do not prove absence.
- Use `memory_search` first for semantic recall.
- Use `xmemo_memory_list` when path/list browsing matters.
- When results are sparse, retry with alternate wording, path, agent, or time hint.
- Do not claim activity fallback exists until the API/tool surface supports it.

## Test Matrix

Required unit tests:

- `expandQuery("免注册")` includes `自注册`, `无需预注册`, and `guest mode`.
- `tokenizeQuery` produces useful tokens for mixed Chinese/English queries.
- `extractRetrievalHints` extracts `Projects/Xmemo/功能改造`.
- `dedupeAndRank` dedupes same-id results and prefers stronger matches.

Required tool tests:

- `memory_search` calls `recallContext` first.
- `memory_search` calls `searchMemory` when L1 returns fewer than `minResults`.
- `memory_search` can return a result containing `自注册` for query `免注册`.
- `debug: true` includes trace metadata and does not include full memory content in `details`.
- `xmemo_memory_list` accepts a path hint and includes that path in the search strategy.
- Cross-agent default remains broad: request uses `readBucket: "%"`, with unset/null `readScope`.
- Empty result response includes actionable suggestions.

## Verification Commands

Run:

```powershell
pnpm test
pnpm typecheck
pnpm lint
pnpm build
node scripts/verify-plugin.mjs .
pnpm pack --pack-destination tmp-pack
```

After pack:

- Inspect tarball contents.
- Remove `tmp-pack/` and any `*.tgz` before final handoff unless explicitly needed.
- Confirm `git status --short --ignored` has no accidental artifacts.

## Out Of Scope For This Pass

- Implementing real `memory_activity` fallback.
- Implementing `explain_memory`.
- Adding path-browse API to XMemo service.
- Changing npm/ClawHub release automation.
- Reworking Phase G tool scope.

## Final Handoff Requirements

When complete, report:

- Files changed.
- Behavior changes.
- Test results.
- Any remaining service/API gaps, especially:
  - activity fallback
  - explain memory
  - path browsing
  - whether metadata/expected queries are indexed by XMemo service
