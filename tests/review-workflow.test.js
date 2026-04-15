const test = require("node:test");
const assert = require("node:assert/strict");

const { CaseCompiler } = require("../src/cases/case-compiler");
const { InvariantPromotionPipeline } = require("../src/invariants/promotion");
const { ReviewWorkflow } = require("../src/review/workflow");
const { loadExample } = require("./helpers/load-example");

test("review workflow approves a draft case into an active approved case", () => {
  const reviewWorkflow = new ReviewWorkflow();
  const caseCompiler = new CaseCompiler();
  const draftCase = caseCompiler.compile(loadExample("case_compilation_packet"));

  const { nextRecord, auditEntry } = reviewWorkflow.applyDecision({
    recordType: "case",
    record: draftCase,
    decisionPacket: {
      decision_id: "review_case_approve_001",
      record_type: "case",
      record_id: draftCase.case_id,
      decision: "approve",
      reviewer: "governance-qa-steward",
      rationale: "The case is ready for activation.",
      reviewed_at: "2026-04-10T12:00:00Z",
    },
  });

  assert.equal(nextRecord.status, "active");
  assert.equal(nextRecord.review_state, "approved");
  assert.equal(auditEntry.resulting_status, "active");
  assert.match(auditEntry.audit_id, /^audit_/);
  assert.ok(auditEntry.record_snapshot_hash.startsWith("sha256:"));
});

test("review workflow rejects a draft invariant", () => {
  const reviewWorkflow = new ReviewWorkflow();
  const draft = new InvariantPromotionPipeline().compileDraft(loadExample("invariant_promotion_packet"));

  const { nextRecord } = reviewWorkflow.applyDecision({
    recordType: "invariant",
    record: draft,
    decisionPacket: {
      decision_id: "review_invariant_reject_001",
      record_type: "invariant",
      record_id: draft.id,
      decision: "reject",
      reviewer: "governance-qa-steward",
      rationale: "The invariant is not stable enough yet.",
      reviewed_at: "2026-04-10T12:05:00Z",
    },
  });

  assert.equal(nextRecord.status, "rejected");
});
