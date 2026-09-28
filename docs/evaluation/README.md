# Retrieval evaluation skeleton

This folder contains only a tiny synthetic **development** fixture. It is a format and runner check, not a product-quality result. Do not add sealed queries, expected memory IDs, labels, or retrieval outputs here.

## Dataset contract

The JSON document has `dataset_version: "1"`, one `split` (`dev` or `sealed`), and a non-empty `records` array. Each record contains:

| Field | Type | Rule |
|---|---|---|
| `record_id` | string | Unique, non-personal row ID |
| `query` | string | Non-empty query text |
| `language` | string | `en`, `zh`, `ja`, or `ko` |
| `labels` | object | Memory ID to integer relevance grade `0`–`3` |
| `expected_ids` | string array | Exactly the IDs labeled above zero |
| `scenario_tags` | string array | One or more registered scenario labels |
| `leakage_group` | string | Opaque, non-identifying user/project grouping key |
| `retrieved_ids` | string array | Ordered candidate output IDs, without duplicates |

## Split and custody rules

Split by `leakage_group` before creating or labeling queries. All examples, paraphrases, memories, and projects associated with one user/project remain entirely in dev or entirely in sealed. Deduplicate exact and near-duplicate queries across splits. Do not tune code, prompts, thresholds, ranking, or evaluator instructions against sealed records. Keep sealed content and outputs outside Git; store only the exact artifact SHA-256 and non-sensitive run metadata. Encrypted custody is allowed. The evaluation runner requires an expected hash for sealed data and verifies the exact file bytes before it scores. It also requires a dev comparison file and refuses overlapping `leakage_group` keys.

Only a human data owner may approve query authorship, labels, licensing, access, and the sealed artifact. That decision is open. This slice creates no sealed dataset.

## Run

```bash
node scripts/retrieval-eval.mjs docs/evaluation/dev-fixture.json --k 10
```

A sealed run must supply the independently recorded file digest and the dev file:

```bash
node scripts/retrieval-eval.mjs /secure/path/sealed.json --sha256 <recorded-sha256> --compare-dev docs/evaluation/dev-fixture.json --k 10
```

The output contains aggregate and per-language/per-scenario macro Recall@k and nDCG@k. The runner does not perform bootstrap inference or establish any acceptance result; use the registered paired-bootstrap protocol in [ADR-Q01](../architecture/ADR-Q01-RETRIEVAL-CAPTURE-EVALUATION.md).

Unit checks:

```bash
node --test scripts/retrieval-eval.test.mjs
```
