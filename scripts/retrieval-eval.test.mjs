import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadDataset, scoreDataset, scoreRecord, validateDataset } from "./retrieval-eval.mjs";

const fixture = JSON.parse(readFileSync(new URL("../docs/evaluation/dev-fixture.json", import.meta.url), "utf8"));

test("Recall@k and graded nDCG@k are perfect when results are ideally ranked", () => {
  const row = {
    expected_ids: ["a", "b"],
    labels: { a: 3, b: 1 },
    retrieved_ids: ["a", "b", "x"],
  };
  assert.deepEqual(scoreRecord(row, 2), { recallAtK: 1, ndcgAtK: 1 });
});

test("dataset validation rejects disagreement between graded labels and expected IDs", () => {
  const broken = structuredClone(fixture);
  broken.records[0].expected_ids = ["synthetic-memory-theme"];
  assert.throws(() => validateDataset(broken), /expected_ids must match IDs with positive labels/);
});

test("tiny dev fixture produces aggregate and per-language metrics", () => {
  const report = scoreDataset(fixture, 2);
  assert.equal(report.split, "dev");
  assert.equal(report.queries, 3);
  assert.equal(report.groups["language:ja"]["Recall@2"], 1);
  assert.equal(report.groups["language:ja"]["nDCG@2"], 1);
  assert.ok(report["Recall@2"] > 0 && report["Recall@2"] <= 1);
});

test("sealed data requires a matching hash, dev comparison, and disjoint leakage groups", () => {
  const dir = mkdtempSync(join(tmpdir(), "xmemo-eval-test-"));
  try {
    const devPath = join(dir, "dev.json");
    writeFileSync(devPath, JSON.stringify(fixture));
    const sealed = {
      dataset_version: "1",
      split: "sealed",
      records: [{
        record_id: "sealed-row",
        query: "Synthetic sealed query",
        language: "en",
        labels: { "sealed-memory": 1 },
        expected_ids: ["sealed-memory"],
        scenario_tags: ["synthetic"],
        leakage_group: "synthetic-sealed-project",
        retrieved_ids: ["sealed-memory"],
      }],
    };
    const sealedPath = join(dir, "sealed.json");
    const bytes = Buffer.from(JSON.stringify(sealed));
    writeFileSync(sealedPath, bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");

    assert.throws(() => loadDataset(sealedPath), /requires --sha256/);
    assert.throws(() => loadDataset(sealedPath, { expectedSha256: "0".repeat(64), compareDevPath: devPath }), /SHA-256 mismatch/);
    assert.equal(loadDataset(sealedPath, { expectedSha256: digest, compareDevPath: devPath }).split, "sealed");

    sealed.records[0].leakage_group = fixture.records[0].leakage_group;
    const overlappingBytes = Buffer.from(JSON.stringify(sealed));
    writeFileSync(sealedPath, overlappingBytes);
    const overlappingDigest = createHash("sha256").update(overlappingBytes).digest("hex");
    assert.throws(
      () => loadDataset(sealedPath, { expectedSha256: overlappingDigest, compareDevPath: devPath }),
      /overlaps dev/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
