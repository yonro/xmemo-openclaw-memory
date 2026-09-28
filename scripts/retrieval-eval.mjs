#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const LANGUAGES = new Set(["en", "zh", "ja", "ko"]);

export function validateDataset(dataset) {
  if (!dataset || dataset.dataset_version !== "1") throw new Error('dataset_version must be "1"');
  if (!new Set(["dev", "sealed"]).has(dataset.split)) throw new Error('split must be "dev" or "sealed"');
  if (!Array.isArray(dataset.records) || dataset.records.length === 0) throw new Error("records must be a non-empty array");

  const recordIds = new Set();
  for (const row of dataset.records) {
    if (!row || typeof row.record_id !== "string" || !row.record_id.trim()) throw new Error("each record needs a record_id");
    if (recordIds.has(row.record_id)) throw new Error(`duplicate record_id: ${row.record_id}`);
    recordIds.add(row.record_id);
    if (typeof row.query !== "string" || !row.query.trim()) throw new Error(`${row.record_id}: query must be non-empty`);
    if (!LANGUAGES.has(row.language)) throw new Error(`${row.record_id}: unsupported language`);
    if (!row.labels || typeof row.labels !== "object" || Array.isArray(row.labels)) throw new Error(`${row.record_id}: labels must be an object`);
    for (const [id, grade] of Object.entries(row.labels)) {
      if (!id || !Number.isInteger(grade) || grade < 0 || grade > 3) throw new Error(`${row.record_id}: labels must map IDs to grades 0-3`);
    }
    if (!Array.isArray(row.expected_ids) || row.expected_ids.length === 0) throw new Error(`${row.record_id}: expected_ids must be non-empty`);
    if (new Set(row.expected_ids).size !== row.expected_ids.length) throw new Error(`${row.record_id}: expected_ids contains duplicates`);
    const positiveIds = Object.entries(row.labels).filter(([, grade]) => grade > 0).map(([id]) => id).sort();
    if (JSON.stringify([...row.expected_ids].sort()) !== JSON.stringify(positiveIds)) {
      throw new Error(`${row.record_id}: expected_ids must match IDs with positive labels`);
    }
    if (!Array.isArray(row.scenario_tags) || row.scenario_tags.length === 0 || row.scenario_tags.some((tag) => typeof tag !== "string" || !tag.trim())) {
      throw new Error(`${row.record_id}: scenario_tags must be non-empty strings`);
    }
    if (typeof row.leakage_group !== "string" || !row.leakage_group.trim()) throw new Error(`${row.record_id}: leakage_group must be an opaque grouping key`);
    if (!Array.isArray(row.retrieved_ids) || row.retrieved_ids.some((id) => typeof id !== "string" || !id)) {
      throw new Error(`${row.record_id}: retrieved_ids must be an ordered string array`);
    }
    if (new Set(row.retrieved_ids).size !== row.retrieved_ids.length) throw new Error(`${row.record_id}: retrieved_ids contains duplicates`);
  }
  return dataset;
}

export function scoreRecord(row, k = 10) {
  if (!Number.isInteger(k) || k < 1) throw new Error("k must be a positive integer");
  const ranked = row.retrieved_ids.slice(0, k);
  const expected = new Set(row.expected_ids);
  const hits = ranked.filter((id) => expected.has(id)).length;
  const recall = hits / expected.size;
  const dcg = ranked.reduce((sum, id, index) => {
    const grade = row.labels[id] ?? 0;
    return sum + (2 ** grade - 1) / Math.log2(index + 2);
  }, 0);
  const idealGrades = Object.values(row.labels).filter((grade) => grade > 0).sort((a, b) => b - a).slice(0, k);
  const idcg = idealGrades.reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
  return { recallAtK: recall, ndcgAtK: idcg === 0 ? 0 : dcg / idcg };
}

function mean(rows) {
  return rows.reduce((sum, row) => sum + row.score, 0) / rows.length;
}

export function scoreDataset(dataset, k = 10) {
  validateDataset(dataset);
  const scores = dataset.records.map((record) => ({
    record_id: record.record_id,
    language: record.language,
    scenario_tags: record.scenario_tags,
    ...scoreRecord(record, k),
  }));
  const grouped = new Map();
  for (const row of scores) {
    const keys = [`language:${row.language}`, ...row.scenario_tags.map((tag) => `scenario:${tag}`)];
    for (const key of keys) {
      const group = grouped.get(key) ?? [];
      group.push(row);
      grouped.set(key, group);
    }
  }
  const summarize = (rows) => ({
    queries: rows.length,
    [`Recall@${k}`]: mean(rows.map((row) => ({ score: row.recallAtK }))),
    [`nDCG@${k}`]: mean(rows.map((row) => ({ score: row.ndcgAtK }))),
  });
  return {
    dataset_version: dataset.dataset_version,
    split: dataset.split,
    queries: scores.length,
    [`Recall@${k}`]: mean(scores.map((row) => ({ score: row.recallAtK }))),
    [`nDCG@${k}`]: mean(scores.map((row) => ({ score: row.ndcgAtK }))),
    groups: Object.fromEntries([...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => [key, summarize(rows)])),
  };
}

export function loadDataset(filePath, { expectedSha256, compareDevPath } = {}) {
  const bytes = readFileSync(filePath);
  const dataset = JSON.parse(bytes.toString("utf8"));
  if (dataset.split === "sealed") {
    if (!expectedSha256) throw new Error("sealed data requires --sha256");
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expectedSha256.toLowerCase()) throw new Error(`sealed SHA-256 mismatch (actual ${actual})`);
    if (!compareDevPath) throw new Error("sealed data requires --compare-dev");
    const dev = validateDataset(JSON.parse(readFileSync(compareDevPath, "utf8")));
    if (dev.split !== "dev") throw new Error("--compare-dev must point to a dev dataset");
    const devGroups = new Set(dev.records.map((row) => row.leakage_group));
    const leaked = dataset.records?.find((row) => devGroups.has(row.leakage_group));
    if (leaked) throw new Error(`sealed leakage_group overlaps dev: ${leaked.leakage_group}`);
  } else if (expectedSha256) {
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expectedSha256.toLowerCase()) throw new Error(`SHA-256 mismatch (actual ${actual})`);
  }
  return validateDataset(dataset);
}

function parseArgs(argv) {
  const args = { file: undefined, k: 10, expectedSha256: undefined, compareDevPath: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--k") args.k = Number(argv[++index]);
    else if (arg === "--sha256") args.expectedSha256 = argv[++index];
    else if (arg === "--compare-dev") args.compareDevPath = argv[++index];
    else if (arg.startsWith("--") || args.file) throw new Error(`unknown or repeated argument: ${arg}`);
    else args.file = arg;
  }
  if (!args.file) throw new Error("usage: node scripts/retrieval-eval.mjs <dataset.json> [--k N] [--sha256 HEX --compare-dev dev.json]");
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const dataset = loadDataset(options.file, options);
    const report = scoreDataset(dataset, options.k);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
