const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  collectPreviouslyBlockedCaseIds,
  nextBatchId,
  runCaseBatch,
} = require("../src/cases/case-batch-runner");
const { CaseReviewSurface } = require("../src/cases/case-review");
const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");

test("case batch runner skips previously blocked case ids", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-batch-"));
  const batchLogDir = path.join(rootDir, "review-drafts");
  fs.mkdirSync(batchLogDir, { recursive: true });

  fs.writeFileSync(
    path.join(batchLogDir, "batch-009-results.json"),
    `${JSON.stringify({
      batch_id: "batch-009",
      results: [
        { case_id: "case_a", status: "error", error: "blocked" },
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  seedCompletableDraft(rootDir, {
    caseId: "case_a",
    evidenceId: "ev_a",
    derivedAt: "2026-04-11T10:00:00.000Z",
  });
  seedCompletableDraft(rootDir, {
    caseId: "case_b",
    evidenceId: "ev_b",
    derivedAt: "2026-04-11T11:00:00.000Z",
  });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });
  const result = runCaseBatch({
    surface,
    limit: 1,
    batchLogDir,
    dryRun: true,
  });

  assert.equal(result.total_cases, 1);
  assert.equal(result.case_ids[0], "case_b");
  assert.equal(result.skipped_previously_blocked_count, 1);
  assert.equal(result.approved, 1);
});

test("case batch runner computes the next batch id from existing logs", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-batch-"));
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, "batch-001-results.json"), "{}\n", "utf8");
  fs.writeFileSync(path.join(rootDir, "batch-009-results.json"), "{}\n", "utf8");

  assert.equal(nextBatchId({ batchLogDir: rootDir }), "batch-010");
  assert.deepEqual(
    Array.from(collectPreviouslyBlockedCaseIds({ batchLogDir: rootDir })),
    [],
  );
});

function seedCompletableDraft(rootDir, { caseId, evidenceId, derivedAt }) {
  const catalog = new FileBackedCatalog({ rootDir });
  const payloadDir = path.join(rootDir, "payloads", "evidence", "tests");
  fs.mkdirSync(payloadDir, { recursive: true });

  fs.writeFileSync(
    path.join(payloadDir, `${evidenceId}.json`),
    `${JSON.stringify({
      objective: `Implement ${caseId}`,
      steps_completed: [
        `Patched ${caseId}`,
        `Verified ${caseId}`,
      ],
      findings: [
        `Failure boundary for ${caseId}`,
      ],
      blockers: [
        `Boundary for ${caseId}`,
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  catalog.writeRecord("evidence", {
    evidence_id: evidenceId,
    substrate_ref: `file:///tmp/${evidenceId}.json`,
    source_type: "file",
    source_locator: `/tmp/${evidenceId}.json`,
    captured_at: derivedAt,
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
    problem_statement: `Problem for ${caseId}`,
    context: {
      constraints: [`Boundary for ${caseId}`],
      project_scope: "project",
      toolchain: [],
    },
    action_taken: `Patched ${caseId}.`,
    outcome: `Outcome for ${caseId}.`,
    failure_mode: `Failure boundary for ${caseId}.`,
    evidence_refs: [evidenceId],
    review_state: "draft",
    confidence: 0.8,
    derived_at: derivedAt,
    derivation_rule_id: "case-autodistill-run-v1",
    open_questions: [
      "Confirm applicability.when_to_apply before approval.",
      "Confirm applicability.when_not_to_apply before approval.",
    ],
  });
}
