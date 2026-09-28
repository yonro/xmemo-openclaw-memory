# Tool schema catalog / 工具参数目录

This catalog records the OpenClaw tool schemas captured from `registerXMemoTools`. Parameter names, required fields, types, constraints, explicit defaults, and descriptions below come from the registered TypeBox schema. Defaults mentioned only in a description remain descriptive defaults; optional fields may be omitted. The test `src/documentation-parity.test.ts` verifies this snapshot and all four public inventories against current registrations.

本目录直接记录 `registerXMemoTools` 注册给 OpenClaw 的参数 schema。参数名称、必填项、类型、约束、显式默认值和描述均取自注册 schema。仅写在描述中的默认值属于说明性默认值；可选字段仍可省略。测试 `src/documentation-parity.test.ts` 会将本快照及四份工具清单与当前注册结果逐项核对。

## Parameter summary / 参数速览

“Required” follows the registered schema. A tool can also enforce a runtime condition such as “provide either `path` or `id`”; those conditions are stated separately. Defaults below are effective omission behavior; the JSON snapshot distinguishes schema defaults from defaults described in text. / “必填”按注册 schema 判定。执行逻辑还可能要求满足例如“`path` 或 `id` 至少提供一个”的条件，此类条件会单独说明。下表默认值表示省略参数时的实际行为；schema 显式默认与文字描述的默认值可在下方 JSON 快照中区分。

| Tool / 工具 | Required / 必填 | Optional parameters, constraints, and defaults / 可选参数、约束与默认值 |
|---|---|---|
| `memory_search` | `query` — query text / 查询文本 | `maxResults` ≥1, default 8 / 默认8; `minResults` ≥1, default 3 / 默认3; `minScore` 0–1, unknown scores excluded / 未知分数不通过; `debug` default false / 默认false |
| `memory_get` | None in schema; runtime requires `path` or `id` / schema 无必填，执行时需提供path或id | `path`, `id`; `from` start line ≥1 / 起始行≥1; `lines` ≥1 / 行数≥1; no default / 无默认值 |
| `memory_store` | `content` — memory content / 记忆正文 | `path` defaults to configured bucket / 默认配置bucket; `memory_type` enum `auto`, `semantic`, `episodic`, `procedural`, `working`, `identity` / 类型枚举; omission writes `semantic` / 省略时写入semantic; `importance` 0–1, default 0.7 / 默认0.7 |
| `memory_forget` | `path` — exact memory path / 精确记忆路径 | `mode` enum `soft_delete`, `hard_delete`, `redact`; default `soft_delete` / 默认软删除 |
| `xmemo_todo_create` | `content` — reminder text / 待办内容 | `due_at` ISO 8601 / ISO 8601到期时间; otherwise no default / 无默认值 |
| `xmemo_todo_list` | None / 无 | `status` `open`, `completed`, or `%`; default `open` / 默认open; aliases `all` and `*` map to `%` / `all`、`*`映射为%; `bucket` defaults to all visible buckets `%` / 默认全部可见bucket |
| `xmemo_todo_complete` | `id` — reminder ID / 待办ID | None / 无 |
| `xmemo_record_event` | `content` — event description / 事件描述 | `event_type`; default `note` / 默认note |
| `xmemo_memory_list` | None in schema; runtime requires `query` or `path` / schema 无必填，执行时需提供query或path | `maxResults` ≥1, default 20 / 默认20; `debug` default false / 默认false; `memory_type` enum `semantic`, `episodic`, `working`, `procedural`, `identity` / 类型枚举; `full` default false / 默认false; `maxChars` 1–100000, default 500 / 默认500; `include_deleted` default false / 默认false |
| `xmemo_memory_get` | None in schema; runtime requires `id` or `path` / schema 无必填，执行时需提供id或path | `from` start line ≥1 / 起始行≥1; `lines` ≥1 / 行数≥1; no default / 无默认值 |
| `xmemo_memory_update` | `id` — memory ID / 记忆ID | `content`, `path`, `memory_type`, `status`; `importance` 0–1 / 重要度0–1; `base_revision` expected current local revision for a version-aware update / 本地版本更新时的预期当前版本; no default / 无默认值 |
| `xmemo_restart_snapshot_save` | None / 无 | `label` optional / 可选标签 |
| `xmemo_restart_snapshot_restore` | None / 无 | `snapshot_id`, `bucket`, `scope` optional / 均可选; no schema default / schema未声明默认值 |
| `xmemo_ledger_monthly_summary` | None / 无 | `months` 1–24, default 6 / 默认6; `month` 1–12 and `year` are legacy aliases / 旧版兼容参数; optional `currency`, `transaction_type` / 可选币种与交易类型 |
| `xmemo_audit_events` | None / 无 | `action`, `target_id`, `since`, `until` optional / 均可选; `limit` ≥1, default 50 / 默认50 |
| `xmemo_audit_consolidation` | None / 无 | `action_type`, `since`, `until` optional / 均可选; `limit` ≥1, default 50 / 默认50 |

## Source schema snapshot / 源 schema 快照

<!-- BEGIN TOOL SCHEMA SNAPSHOT -->

```json
[
  {
    "name": "memory_forget",
    "parameters": {
      "type": "object",
      "required": [
        "path"
      ],
      "properties": {
        "path": {
          "type": "string",
          "description": "Memory path (e.g. openclaw/<uuid>)"
        },
        "mode": {
          "type": "string",
          "description": "Deletion mode",
          "enum": [
            "soft_delete",
            "hard_delete",
            "redact"
          ],
          "default": "soft_delete"
        }
      }
    }
  },
  {
    "name": "memory_get",
    "parameters": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "Memory path (e.g. openclaw/<uuid>)"
        },
        "id": {
          "type": "string",
          "description": "Memory id or UUID"
        },
        "from": {
          "type": "integer",
          "description": "Start line",
          "minimum": 1
        },
        "lines": {
          "type": "integer",
          "description": "Line count",
          "minimum": 1
        }
      }
    }
  },
  {
    "name": "memory_search",
    "parameters": {
      "type": "object",
      "required": [
        "query"
      ],
      "properties": {
        "query": {
          "type": "string",
          "description": "Search query"
        },
        "maxResults": {
          "type": "integer",
          "description": "Max results (default: 8)",
          "minimum": 1
        },
        "minResults": {
          "type": "integer",
          "description": "Min results threshold for L2 fallback (default: 3)",
          "minimum": 1
        },
        "minScore": {
          "type": "number",
          "description": "Minimum real XMemo similarity score (0-1); unknown scores are excluded",
          "minimum": 0,
          "maximum": 1
        },
        "debug": {
          "type": "boolean",
          "description": "Return retrieval trace (default: false)"
        }
      }
    }
  },
  {
    "name": "memory_store",
    "parameters": {
      "type": "object",
      "required": [
        "content"
      ],
      "properties": {
        "content": {
          "type": "string",
          "description": "Information to remember"
        },
        "path": {
          "type": "string",
          "description": "Optional path/category (defaults to the configured bucket)"
        },
        "memory_type": {
          "type": "string",
          "description": "Memory type",
          "enum": [
            "auto",
            "semantic",
            "episodic",
            "procedural",
            "working",
            "identity"
          ]
        },
        "importance": {
          "type": "number",
          "description": "Importance 0-1 (default: 0.7)",
          "minimum": 0,
          "maximum": 1
        }
      }
    }
  },
  {
    "name": "xmemo_audit_consolidation",
    "parameters": {
      "type": "object",
      "properties": {
        "action_type": {
          "type": "string",
          "description": "Filter by consolidation action type"
        },
        "limit": {
          "type": "integer",
          "description": "Max results (default: 50)",
          "minimum": 1
        },
        "since": {
          "type": "string",
          "description": "ISO 8601 start time"
        },
        "until": {
          "type": "string",
          "description": "ISO 8601 end time"
        }
      }
    }
  },
  {
    "name": "xmemo_audit_events",
    "parameters": {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "description": "Filter by action type"
        },
        "target_id": {
          "type": "string",
          "description": "Filter by target id"
        },
        "limit": {
          "type": "integer",
          "description": "Max results (default: 50)",
          "minimum": 1
        },
        "since": {
          "type": "string",
          "description": "ISO 8601 start time"
        },
        "until": {
          "type": "string",
          "description": "ISO 8601 end time"
        }
      }
    }
  },
  {
    "name": "xmemo_ledger_monthly_summary",
    "parameters": {
      "type": "object",
      "properties": {
        "months": {
          "type": "integer",
          "description": "Number of rolling months to summarize (1-24, default: 6)",
          "default": 6
        },
        "month": {
          "type": "integer",
          "description": "Specific calendar month (1-12, legacy alias)"
        },
        "year": {
          "type": "integer",
          "description": "Specific calendar year (legacy alias)"
        },
        "currency": {
          "type": "string",
          "description": "Currency code (e.g. CNY)"
        },
        "transaction_type": {
          "type": "string",
          "description": "Filter by transaction type (e.g. expense, income)"
        }
      }
    }
  },
  {
    "name": "xmemo_memory_get",
    "parameters": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "Memory UUID or record identifier"
        },
        "path": {
          "type": "string",
          "description": "Memory or document path"
        },
        "from": {
          "type": "integer",
          "description": "Start line (1-indexed)",
          "minimum": 1
        },
        "lines": {
          "type": "integer",
          "description": "Line count to read",
          "minimum": 1
        }
      }
    }
  },
  {
    "name": "xmemo_memory_list",
    "parameters": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "Search query"
        },
        "path": {
          "type": "string",
          "description": "Path/category hint"
        },
        "maxResults": {
          "type": "integer",
          "description": "Max results (default: 20)",
          "minimum": 1
        },
        "debug": {
          "type": "boolean",
          "description": "Return retrieval trace (default: false)"
        },
        "memory_type": {
          "type": "string",
          "description": "Filter by memory type (semantic, episodic, working, procedural, identity)",
          "enum": [
            "semantic",
            "episodic",
            "working",
            "procedural",
            "identity"
          ]
        },
        "full": {
          "type": "boolean",
          "description": "Return full content without truncation (default: false)"
        },
        "maxChars": {
          "type": "integer",
          "description": "Max characters per snippet when truncating (default: 500, max: 100000)",
          "minimum": 1,
          "maximum": 100000
        },
        "include_deleted": {
          "type": "boolean",
          "description": "Include soft-deleted memories (default: false)"
        }
      }
    }
  },
  {
    "name": "xmemo_memory_update",
    "parameters": {
      "type": "object",
      "required": [
        "id"
      ],
      "properties": {
        "id": {
          "type": "string",
          "description": "Memory id (or bucket/id path)"
        },
        "content": {
          "type": "string",
          "description": "New memory content"
        },
        "path": {
          "type": "string",
          "description": "New path/category"
        },
        "memory_type": {
          "type": "string",
          "description": "New memory type"
        },
        "importance": {
          "type": "number",
          "description": "New importance 0-1",
          "minimum": 0,
          "maximum": 1
        },
        "status": {
          "type": "string",
          "description": "New status"
        },
        "base_revision": {
          "type": "string",
          "description": "Expected current local revision for a version-aware update"
        }
      }
    }
  },
  {
    "name": "xmemo_record_event",
    "parameters": {
      "type": "object",
      "required": [
        "content"
      ],
      "properties": {
        "content": {
          "type": "string",
          "description": "Event description"
        },
        "event_type": {
          "type": "string",
          "description": "Event type (e.g. milestone, decision, note)"
        }
      }
    }
  },
  {
    "name": "xmemo_restart_snapshot_restore",
    "parameters": {
      "type": "object",
      "properties": {
        "snapshot_id": {
          "type": "string",
          "description": "Snapshot id to restore"
        },
        "bucket": {
          "type": "string",
          "description": "Optional bucket override"
        },
        "scope": {
          "type": "string",
          "description": "Optional scope override"
        }
      }
    }
  },
  {
    "name": "xmemo_restart_snapshot_save",
    "parameters": {
      "type": "object",
      "properties": {
        "label": {
          "type": "string",
          "description": "Optional snapshot label"
        }
      }
    }
  },
  {
    "name": "xmemo_todo_complete",
    "parameters": {
      "type": "object",
      "required": [
        "id"
      ],
      "properties": {
        "id": {
          "type": "string",
          "description": "Reminder id"
        }
      }
    }
  },
  {
    "name": "xmemo_todo_create",
    "parameters": {
      "type": "object",
      "required": [
        "content"
      ],
      "properties": {
        "content": {
          "type": "string",
          "description": "Reminder text"
        },
        "due_at": {
          "type": "string",
          "description": "ISO 8601 due date (optional)"
        }
      }
    }
  },
  {
    "name": "xmemo_todo_list",
    "parameters": {
      "type": "object",
      "properties": {
        "status": {
          "type": "string",
          "description": "Filter by status ('open', 'completed', or '%' for all)",
          "default": "open"
        },
        "bucket": {
          "type": "string",
          "description": "Filter by bucket (defaults to all buckets '%')"
        }
      }
    }
  }
]
```

<!-- END TOOL SCHEMA SNAPSHOT -->
