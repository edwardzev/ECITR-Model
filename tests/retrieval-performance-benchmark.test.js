const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPerformanceFixture, runPerformanceBenchmark } = require("../src/retrieval/retrieval-performance-benchmark");
const { FileBackedCatalog, RECORD_DEFINITIONS } = require("../src/storage/file-backed-catalog");
const { assertLifecycleRecord } = require("../src/lifecycle/rules");

test("performance fixtures are deterministic and valid, with full response equivalence and input drift refusal", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-performance-contract-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const first = path.join(parent, "first");
  const second = path.join(parent, "second");
  const a = createPerformanceFixture({ rootDir: first, evidenceCount: 3 });
  const b = createPerformanceFixture({ rootDir: second, evidenceCount: 3 });
  assert.deepEqual(a, b);
  assert.throws(() => createPerformanceFixture({ rootDir: first }), /already exist/);
  const catalog = new FileBackedCatalog({ rootDir: first });
  for (const [type, definition] of Object.entries(RECORD_DEFINITIONS)) {
    for (const record of catalog.listRecords(type)) {
      catalog.validator.validateRecord(definition.schemaKey, record);
      if (definition.lifecycle) assertLifecycleRecord(definition.schemaKey, record);
    }
  }
  const report = await runPerformanceBenchmark({ rootDir: first, iterations: 2 });
  assert.equal(report.fixture_sha256, a.files_sha256);
  assert.equal(report.samples.length, 10);
  for (let index = 0; index < 5; index += 1) {
    assert.equal(report.samples[index].result_sha256, report.samples[index + 5].result_sha256);
    assert.deepEqual(report.samples[index].result, report.samples[index + 5].result);
    assert.equal(report.samples[index].corpus_sha256, report.samples[index + 5].corpus_sha256);
    assert.equal(report.samples[index].result.response.results.tactics.includes("tac_perf_expired"), false);
  }
  const empty = report.samples.find((sample) => sample.scenario_id === "empty");
  assert.equal(Object.values(empty.result.response.results).flat().length, 0);
  fs.writeFileSync(path.join(first, a.files[0].ref), "{}\n");
  await assert.rejects(runPerformanceBenchmark({ rootDir: first, iterations: 1 }), /fixture changed/);
});
