const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { runCaseBatch } = require("../src/cases/case-batch-runner");
const { CaseReviewSurface } = require("../src/cases/case-review");
const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");

test("case batch runner rejects blocked draft cases when configured to drain the waiting pool", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-batch-reject-"));
  seedPrimitiveDraft(rootDir, { caseId: "case_blocked", evidenceId: "ev_blocked" });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });
  const result = runCaseBatch({
    surface,
    limit: Number.MAX_SAFE_INTEGER,
    batchLogDir: path.join(rootDir, "review-drafts"),
    dryRun: false,
    skipPreviouslyBlocked: false,
    rejectErrors: true,
  });

  assert.equal(result.rejected, 1);
  assert.equal(result.results[0].status, "rejected");
  const nextRecord = new FileBackedCatalog({ rootDir }).getRecord("case", "case_blocked");
  assert.equal(nextRecord.status, "deprecated");
  assert.equal(nextRecord.review_state, "reviewed");
});

function seedPrimitiveDraft(rootDir, { caseId, evidenceId }) {
  const catalog = new FileBackedCatalog({ rootDir });
  catalog.writeRecord("evidence", {
    evidence_id: evidenceId,
    substrate_ref: `file:///tmp/${evidenceId}.json`,
    source_type: "file",
    source_locator: `/tmp/${evidenceId}.json`,
    captured_at: "2099-01-01T00:00:00.000Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: `payloads/evidence/tests/${evidenceId}.json`,
    payload_hash: "sha256:test",
    source_hash: "sha256:test",
    redaction_state: "none",
    immutable: true,
  });

  catalog.writeRecord("case", {
    case_id: caseId,
    case_version: 1,
    status: "draft",
    review_state: "draft",
    problem_statement: "Primitive draft with missing bounded failure structure.",
    context: {
      constraints: [],
      project_scope: "project",
      toolchain: [],
    },
    action_taken: "Opened a session and inspected the current runtime.",
    outcome: "Observed the runtime.",
    failure_mode: "No bounded failure boundary has been established yet for this primitive draft.",
    evidence_refs: [evidenceId],
    confidence: 0.4,
    derived_at: "2099-01-01T00:00:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
    open_questions: [
      "Confirm applicability.when_to_apply before approval.",
      "Confirm applicability.when_not_to_apply before approval."
    ],
  });
}
