const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CaseCompiler } = require("../src/cases/case-compiler");
const { readJson } = require("../src/validation/validator");
const { REPO_ROOT } = require("../src/validation/schema-registry");
const { OrchestratorExecutionLoop } = require("../src/orchestrator/execution-loop");
const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const { loadExample } = require("./helpers/load-example");

test("orchestrator execution loop runs against the catalog and returns next actions", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-loop-"));
  const catalog = new FileBackedCatalog({ rootDir });

  for (const recordType of ["evidence", "case", "invariant", "tactic", "atomic_claim_set"]) {
    catalog.writeRecord(recordType, loadExample(recordType));
  }

  const loop = new OrchestratorExecutionLoop({ catalog });
  const result = await loop.run({
    taskPacket: loadExample("orchestrator_task_packet"),
    retrievalRequest: loadExample("retrieval_request"),
    now: new Date("2026-05-01T00:00:00Z"),
  });

  assert.equal(result.routing_plan.primary_role, "Retrieval Architect");
  assert.equal(result.retrieval.response.results.tactics[0], "tac_metadata_prune_before_vector_rank_001");
  assert.ok(result.next_actions.some((action) => action.includes("governance review required")));
});

test("workflow baseline scenarios remain stable", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-loop-"));
  const catalog = new FileBackedCatalog({ rootDir });

  for (const recordType of ["evidence", "case", "invariant", "tactic", "atomic_claim_set"]) {
    catalog.writeRecord(recordType, loadExample(recordType));
  }

  const loop = new OrchestratorExecutionLoop({ catalog });
  const scenarios = readJson(`${REPO_ROOT}/benchmarks/workflow.baseline.json`);

  for (const scenario of scenarios) {
    const result = await loop.run({
      taskPacket: scenario.task,
      retrievalRequest: scenario.request,
      now: new Date("2026-05-01T00:00:00Z"),
    });

    assert.equal(result.routing_plan.primary_role, scenario.expected.primary_role);
    assert.equal(result.routing_plan.requires_governance_review, scenario.expected.requires_governance_review);
    assert.equal(result.routing_plan.requires_research, scenario.expected.requires_research);
    assert.equal(result.retrieval.response.results.tactics[0], scenario.expected.top_tactic);
  }
});

test("persisted review writes both the updated record and an audit entry", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-review-"));
  const catalog = new FileBackedCatalog({ rootDir });
  const loop = new OrchestratorExecutionLoop({ catalog });
  const caseCompiler = new CaseCompiler();
  const packet = {
    ...loadExample("case_compilation_packet"),
    proposed_case_id: "case_review_persist_001",
  };
  const draftCase = caseCompiler.compile(packet);

  const result = loop.applyReview({
    recordType: "case",
    record: draftCase,
    decisionPacket: {
      decision_id: "review_case_persist_001",
      record_type: "case",
      record_id: draftCase.case_id,
      decision: "approve",
      reviewer: "governance-qa-steward",
      rationale: "Persist this review trail.",
      reviewed_at: "2026-04-10T13:00:00Z",
    },
    persist: true,
  });

  assert.equal(result.nextRecord.status, "active");
  assert.equal(catalog.countRecords("case"), 1);
  assert.equal(catalog.countRecords("review_audit_entry"), 1);
  assert.equal(result.auditWrite.recordId, result.auditEntry.audit_id);
});
