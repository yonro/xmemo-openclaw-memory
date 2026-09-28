# ADR-Q01: Retrieval, capture, and continuity evaluation protocol

- Status: **Accepted protocol; dataset authorship remains open**
- Date: 2026-09-28
- Scope: preregistered quality claims for a future Local/Hybrid release; this is not a claim that Local/Hybrid exists in 1.0.18.
- Related proposal: Hybrid plan v2 §§11 and 20.1 (2026-09-27).

## Decision

Freeze the protocol below before opening sealed results. Report retrieval, capture, continuity, and resource outcomes separately. A result that lacks the required sample count, fixed versions, integrity check, or confidence interval is **inconclusive**, not a pass. Do not loosen a threshold, change the comparison set, or remove a scenario after sealed evaluation. Any protocol change requires a new versioned registration and a new untouched sealed set.

This ADR does not authorize creating, labeling, or opening a 1,000-query sealed dataset. Who owns the query content, relevance labels, licensing, and review is an open decision for a human product/data owner.

## Retrieval dataset and split

Each record contains:

| Field | Meaning |
|---|---|
| `record_id` | Stable, non-personal row identifier, unique within the dataset |
| `query` | Query text as evaluated |
| `language` | `en`, `zh`, `ja`, or `ko` |
| `labels` | Map of expected memory ID to graded relevance (`0`–`3`) |
| `expected_ids` | Exact relevant memory IDs; must equal IDs whose grade is greater than zero |
| `scenario_tags` | One or more registered scenario labels, including cross-tag cases |
| `leakage_group` | Opaque grouping key for the same user/project and related memories; never an identity value |
| `retrieved_ids` | Ordered IDs returned by the evaluated run, used by the minimal metric runner |

Keep development and sealed sets in separate files and storage. Assign the split by `leakage_group` before writing or labeling queries; all queries, paraphrases, memories, and projects in a group stay on one side. Remove exact and near-duplicate queries across splits. Do not tune prompts, thresholds, ranking, or code on sealed examples or aggregate feedback that reveals them. The checked-in synthetic development fixture demonstrates format only and is not evidence of product quality.

Sealed bytes must remain outside this repository. The evaluator accepts a sealed file only when its SHA-256 is supplied and matches the exact bytes; keep only the digest and non-sensitive run metadata in a public record. Compare opaque `leakage_group` values against the dev set before scoring. Encrypted storage is permitted, but the digest must cover the precise encrypted artifact used for custody, and evaluation must verify the decrypted dataset against its separately authorized digest before use.

## Retrieval acceptance and statistics

- Seal at least **1,000** queries: at least **200 per language** for English, Chinese, Japanese, and Korean, plus at least **50 cross-tag scenarios**. Report the counts and no silent exclusions. A shortfall is inconclusive.
- Primary metrics are **Recall@10** and **nDCG@10**. Report overall macro averages and each registered language/scenario group. Define Recall@k as retrieved relevant IDs divided by `expected_ids`; define nDCG using graded labels and logarithmic rank discount.
- Compare each candidate with the best baseline that is actually comparable in mode, data, hardware, and allowed network access. Calculate paired bootstrap confidence intervals over query-level differences for each key language group, using **10,000 resamples** and the frozen seed `20260927`; report two-sided **95% confidence intervals**.
- Non-inferiority margin is an absolute **0.02**: the lower confidence bound for candidate minus baseline must be at least `-0.02`. If the interval is too wide or the sample is too small, the result is inconclusive.
- A “leading” claim is allowed only when the multiplicity-adjusted lower confidence bound is greater than zero for the registered comparison. Use **Holm–Bonferroni** across the registered primary metric × language-group × baseline comparisons. Publish the comparison family and adjusted intervals; do not select favorable groups after seeing results.
- Keep default-experience results and same-model results separate. Do not treat download counts as quality. Mark an inapplicable metric N/A with a reason rather than as zero or a pass.

## Capture and continuity acceptance

- Capture set: at least **400** balanced samples, including ordinary non-interactive messages, quoted instructions, negation, corrections, fake credentials, and explicit save requests. Minimum gates: precision **95%**, recall on-worthy examples **85%**, duplicate rate at most **1%**, and **zero** safety-boundary violations. Every explicit save must persist or return a visible failure.
- Continuity set: at least **100** multi-turn tasks covering restart, compaction, fact updates, and multi-person cases. Report task success, stale-fact injection, human interventions, and context tokens separately.
- Blindly audit a sample of automatic scores against human judgments. Freeze evaluator model, prompt, model version, and rubric before the sealed run. Report both automatic and audited results; a disagreement cannot be hidden by the aggregate score.

## First-version performance proposals (not measurements)

The values below are proposed initial budgets for a future Local/Hybrid implementation. They are **not measured**, are not current 1.0.18 performance, and must not be advertised as achieved. Baseline: local SSD, 8 CPU cores, 16 GB RAM, CPU-only inference; record exact machine, OS, Node, model, and data distribution. Report Windows, Linux, and macOS separately.

| Operation / load | First-version proposal, not measured |
|---|---|
| Small durable commit, body ≤4 KB | P95 ≤50 ms; also report P99 |
| Exact get / structured list | P95 ≤30 ms |
| Full-text query at 10k records | P95 ≤80 ms |
| Hybrid retrieval with hot query embedding | P95 ≤250 ms |
| Auto-injection deadline | ≤350 ms |
| Explicit hybrid search deadline | ≤1.5 s |
| Plugin cold start to basic availability | P95 ≤1 s; model readiness reported separately |
| Local-model cold load | Target ≤3 s |
| Hot memory | ≤600 MB |
| Idle CPU | <1% of one core |
| Main-thread P99 | <10 ms |

Measure 10k records averaging 500 characters as the daily baseline and 100k as the scale check. 1M records are research-only until capacity is demonstrated. Include latency distributions, throughput, memory, CPU, failures, timeouts, and model load state; never call a target a result.

## Frozen G0 version record

| Component | Frozen reference for protocol setup | Qualification |
|---|---|---|
| Plugin | `@xmemo/openclaw-memory` 1.0.18 | Current cloud baseline; not Local/Hybrid |
| OpenClaw host | 2026.6.9 | Declared minimum host reference; this alone does not prove gateway acceptance |
| Node.js | v26.9.0 | Audit environment snapshot only, not a supported-runtime claim |
| XMemo audit baseline | `e22df8a1981c522469b1b620d64097d995beb432` | Local source reference from the audit |
| Mem0 | `94c3fe9f238f3dbf29c9ce98643bd71eb13077cd` | Reference source commit, not necessarily latest release |
| Honcho | `7d98107298b0f7e1e31bd3fb9ddd3f1ff18ca50e` | Reference source commit, not necessarily latest release |
| OpenViking | `a09a9d20a8e07d08973aee177802d00e08df29e6` | Reference source commit, not necessarily latest release |
| TencentDB Agent Memory | `bd88cc83870bf9e7dbd2ec36aa13608d2295c7f4` | Reference source commit, not necessarily latest release |
| OpenClaw LanceDB | `5f3781df412caf60e3258428cf0bb7e406f19a76` | Reference source commit, not necessarily latest release |

Record exact installed package/model versions, commit, configuration, platform, data hash, random seed, and run command again at execution time. These references are not a performance comparison or a ranking.

## Implementation included in this slice

`docs/evaluation/README.md` defines the data contract and leakage rules, `docs/evaluation/dev-fixture.json` is a tiny synthetic development example, and `scripts/retrieval-eval.mjs` computes Recall@k and nDCG@k. Unit tests run with `node --test scripts/retrieval-eval.test.mjs`. No sealed set or product runtime behavior is included.
