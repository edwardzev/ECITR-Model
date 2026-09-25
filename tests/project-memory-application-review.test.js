const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const { ProjectMemorySurface, createProjectMemoryRetrievalRuntime } = require("../src/runtime/project-memory");
const { READER_LIMITS } = require("../src/runtime/project-memory-reader");
const { loadExample } = require("./helpers/load-example");

const NOW = new Date("2026-09-25T12:00:00Z");
const SCENARIOS = [
  { id: "applicable", influence: true,
    decision: "Supported specific application: this data-seed migration selects existing rows. The case informed the decision to verify selected-row count and stored values after the migration, rather than treating its success log as row-effect proof." },
  { id: "excluded", influence: false,
    decision: "Excluded and not applied: this migration adds a nullable schema column only. The case explicitly excludes schema-only changes. No case guidance influenced the implementation or validation." },
  { id: "analogous", influence: true,
    decision: "Broad analogy only: this schema-only change falls outside the data-seed case. Its general distinction between a success log and observed effect prompted an extra observation. This does not demonstrate application of the case's row-selector mechanism." },
];

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-application-review-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "ecitr.project.json"), JSON.stringify({
    ...loadExample("ecitr_project"), catalog_root: "catalog", default_project_scope: "project_family",
  }));
  const catalog = new FileBackedCatalog({ rootDir: path.join(root, "catalog") });
  const record = loadExample("case");
  Object.assign(record, {
    problem_statement: "A data-seed migration reports success while its row selector matches zero rows.",
    action_taken: "Verify the selected-row count and effective stored data after the data-seed migration.",
    outcome: "The incorrect selector was found through a zero-row readback and corrected.",
    applicability: {
      when_to_apply: ["A data-seed migration selects existing rows and the effective row count or stored values need verification."],
      when_not_to_apply: ["The migration changes schema only, without a data-selection predicate."],
    },
  });
  catalog.writeRecord("case", record);
  const surface = new ProjectMemorySurface({ catalog, retrievalRuntime: createProjectMemoryRetrievalRuntime({
    tableExists: () => false, graphRoot: path.join(root, "absent-graph"),
  }) });
  return { root, record, surface };
}

// These are controlled caller decisions, not an automatic semantic classifier.
for (const scenario of SCENARIOS) {
  test(`application review preserves the ${scenario.id} decision without promoting declarations into proof`, async (t) => {
    const f = fixture(t);
    const search = await f.surface.searchProjectMemory({ query: "data seed migration row selector count verification",
      taskPacket: { task_id: `application_${scenario.id}`, title: "Controlled applicability example" }, now: NOW });
    const invocation = search.memory_invocation;
    const id = f.record.case_id;
    assert.ok(invocation.returned_record_ids.cases.includes(id));
    const response = f.surface.readProjectMemoryRecords({ invocationId: invocation.invocation_id, recordIds: [id], now: NOW });
    assert.equal(response.results[0].result, "available");
    assert.deepEqual(response.results[0].record.applicability, f.record.applicability);
    assert.equal(response.application_review.status, "caller_review_required");
    assert.match(response.application_review.guidance, /matching exclusion/);
    assert.match(response.application_review.guidance, /broad analogy/);
    assert.ok(Buffer.byteLength(JSON.stringify(response)) <= READER_LIMITS.response_bytes);
    const outputRef = path.join(f.root, `${scenario.id}-decision.md`);
    fs.writeFileSync(outputRef, `${scenario.decision}\n`);
    const usage = f.surface.recordMemoryUsage({ invocationId: invocation.invocation_id,
      inspectedRecordIds: [id], selectedRecordIds: [id], usedRecordIds: scenario.influence ? [id] : [],
      useEvidence: scenario.influence ? [{ record_id: id, decision_ref: outputRef }] : [], now: NOW });
    assert.equal(usage.used_memory, scenario.influence);
    const review = usage.usage_followthrough.application_review;
    assert.deepEqual(review.prepared_used_record_ids, scenario.influence ? [id] : []);
    assert.deepEqual(review.used_record_ids_without_available_read_receipts, []);
    assert.equal(review.preparation_scope, "available_at_receipt_time_only");
    assert.equal(review.specific_application.value, null);
    assert.equal(review.measured_benefit.value, null);
    const stored = JSON.parse(fs.readFileSync(invocation.artifact_path, "utf8"));
    assert.deepEqual(stored.use_evidence.inspected_record_ids, [id]);
    assert.equal(stored.use_evidence.measured_benefit.value, null);
    for (const link of stored.use_evidence.links) assert.equal(link.corroboration.value, null);
  });
}

test("a linked use declaration without a read receipt stays unverified; an empty callback remains valid", async (t) => {
  const f = fixture(t);
  const search = await f.surface.searchProjectMemory({ query: "data seed migration row count",
    taskPacket: { task_id: "unread-use", title: "Controlled unverified use" }, now: NOW });
  const id = f.record.case_id;
  const invocationId = search.memory_invocation.invocation_id;
  const usage = f.surface.recordMemoryUsage({ invocationId, usedRecordIds: [id],
    useEvidence: [{ record_id: id, output_ref: "/does-not-exist/declared-only.md#application" }], now: NOW });
  assert.deepEqual(usage.usage_followthrough.used_record_ids_without_references, []);
  assert.deepEqual(usage.usage_followthrough.application_review.prepared_used_record_ids, []);
  assert.deepEqual(usage.usage_followthrough.application_review.used_record_ids_without_available_read_receipts, [id]);
  assert.equal(usage.usage_followthrough.application_review.specific_application.value, null);
  const empty = f.surface.recordMemoryUsage({ invocationId, now: NOW });
  assert.equal(empty.usage_followthrough.callback_status, "recorded");
  assert.equal(empty.used_memory, false);
  assert.deepEqual(empty.usage_followthrough.application_review.used_record_ids_without_available_read_receipts, []);
});
