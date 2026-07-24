const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  collectPreviouslyFailedCaseIds,
  nextBatchId,
  runCaseBatch,
} = require("../src/cases/case-batch-runner");
const { CaseReviewSurface } = require("../src/cases/case-review");
const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");

test("case batch runner skips previously failed case ids", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-batch-"));
  const batchLogDir = path.join(rootDir, "review-drafts");
  fs.mkdirSync(batchLogDir, { recursive: true });

  fs.writeFileSync(
    path.join(batchLogDir, "batch-009-results.json"),
    `${JSON.stringify({
      batch_id: "batch-009",
      results: [
        { case_id: "case_a", status: "error", error: "pipeline failed" },
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
  assert.equal(result.skipped_previously_failed_count, 1);
  assert.equal(result.approved, 1);
});

test("case batch runner computes the next batch id from existing logs", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-batch-"));
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, "batch-001-results.json"), "{}\n", "utf8");
  fs.writeFileSync(path.join(rootDir, "batch-009-results.json"), "{}\n", "utf8");

  assert.equal(nextBatchId({ batchLogDir: rootDir }), "batch-010");
  assert.deepEqual(
    Array.from(collectPreviouslyFailedCaseIds({ batchLogDir: rootDir })),
    [],
  );
});

test("case batch runner approves already-ready seed cases without completion", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-batch-"));
  seedReadySeedDraft(rootDir, {
    caseId: "case_seed_ready",
    evidenceId: "ev_seed_ready",
  });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });
  const result = runCaseBatch({
    surface,
    limit: Number.MAX_SAFE_INTEGER,
    batchLogDir: path.join(rootDir, "review-drafts"),
    dryRun: true,
    skipPreviouslyFailed: false,
    rejectErrors: true,
  });

  assert.equal(result.approved, 1);
  assert.equal(result.rejected, 0);
  assert.equal(result.results[0].status, "approved");
  assert.equal(result.results[0].completion_skipped_reason, "already_approval_ready");
  assert.equal(result.results[0].completion_id, null);
});

test("case batch runner auto-amends seed cases before approval", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-batch-"));
  seedAmendableSeedDraft(rootDir, {
    caseId: "case_seed_amendable",
    evidenceId: "ev_seed_amendable",
  });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });
  const result = runCaseBatch({
    surface,
    limit: Number.MAX_SAFE_INTEGER,
    batchLogDir: path.join(rootDir, "review-drafts"),
    dryRun: false,
    skipPreviouslyFailed: false,
    rejectErrors: true,
  });

  assert.equal(result.approved, 1);
  assert.equal(result.rejected, 0);
  assert.equal(result.results[0].status, "approved");
  assert.match(result.results[0].completion_id, /^ccx_case_seed_amendable_/);
  assert.match(result.results[0].amendment_id, /^cam_case_seed_amendable_/);

  const nextRecord = new FileBackedCatalog({ rootDir }).getRecord("case", "case_seed_amendable");
  assert.equal(nextRecord.status, "active");
  assert.equal(nextRecord.review_state, "approved");
  assert.equal(nextRecord.case_version, 2);
  assert.deepEqual(nextRecord.open_questions, []);
});

test("case batch runner rejects unusable seed cases instead of blocking them", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-batch-"));
  seedUnusableSeedDraft(rootDir, {
    caseId: "case_seed_unusable",
    evidenceId: "ev_seed_unusable",
  });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });
  const result = runCaseBatch({
    surface,
    limit: Number.MAX_SAFE_INTEGER,
    batchLogDir: path.join(rootDir, "review-drafts"),
    dryRun: false,
    skipPreviouslyFailed: false,
    rejectErrors: true,
  });

  assert.equal(result.approved, 0);
  assert.equal(result.rejected, 1);
  assert.equal(result.errors, 0);
  assert.equal(result.results[0].status, "rejected");
  assert.match(result.results[0].error, /not approval-ready/);

  const nextRecord = new FileBackedCatalog({ rootDir }).getRecord("case", "case_seed_unusable");
  assert.equal(nextRecord.status, "deprecated");
  assert.equal(nextRecord.review_state, "reviewed");
  assert.equal(nextRecord.case_version, 2);
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

function seedReadySeedDraft(rootDir, { caseId, evidenceId }) {
  const catalog = new FileBackedCatalog({ rootDir });
  catalog.writeRecord("case", {
    case_id: caseId,
    case_version: 1,
    status: "draft",
    problem_statement: "A closeout-authored seed captured a reusable implementation decision.",
    context: {
      constraints: [
        "Seed semantics must remain authored by the acting agent.",
      ],
      project_scope: "project",
      toolchain: [],
    },
    action_taken: "Replaced the MCP field with a discriminated union for candidate, none, and not_applicable closeouts.",
    outcome: "Future closeouts expose accurate reusable seed semantics.",
    failure_mode: "Generic completion can rewrite seed-authored applicability into boilerplate.",
    applicability: {
      when_to_apply: [
        "A future agent is deciding whether the same closeout-authored implementation pattern applies.",
        "The run evidence includes ecitr_closeout.decision = candidate.",
      ],
      when_not_to_apply: [
        "The work was only a read-only status inspection with no intervention or evidence-capture result.",
      ],
    },
    evidence_refs: [evidenceId],
    review_state: "draft",
    confidence: 0.82,
    derived_at: "2099-01-01T00:00:00.000Z",
    derivation_rule_id: "case-seed-closeout-v1",
    open_questions: [],
  });
}

function seedAmendableSeedDraft(rootDir, { caseId, evidenceId }) {
  const catalog = new FileBackedCatalog({ rootDir });
  const payloadDir = path.join(rootDir, "payloads", "evidence", "tests");
  fs.mkdirSync(payloadDir, { recursive: true });

  fs.writeFileSync(
    path.join(payloadDir, `${evidenceId}.json`),
    `${JSON.stringify({
      objective: "Implement seed-driven promotion semantics.",
      steps_completed: [
        "Patched the case batch runner to complete draft cases before approval.",
        "Updated promotion docs to avoid a parked case lifecycle.",
      ],
      findings: [
        "Drafts with bounded evidence can be amended immediately instead of accumulating.",
      ],
      blockers: [
        "Future promotion must not retain unusable draft cases in the live queue.",
      ],
    }, null, 2)}\n`,
    "utf8",
  );

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
    problem_statement: "Seed case needs deterministic applicability framing.",
    context: {
      constraints: [
        "Future promotion must not retain unusable draft cases in the live queue.",
      ],
      project_scope: "project",
      toolchain: [],
    },
    action_taken: "Patched the case batch runner to complete draft cases before approval.",
    outcome: "Drafts with bounded evidence can be amended immediately instead of accumulating.",
    failure_mode: "Future promotion must not retain unusable draft cases in the live queue.",
    evidence_refs: [evidenceId],
    review_state: "draft",
    confidence: 0.78,
    derived_at: "2099-01-01T00:00:00.000Z",
    derivation_rule_id: "case-seed-closeout-v1",
    open_questions: [
      "Confirm applicability.when_to_apply before approval.",
      "Confirm applicability.when_not_to_apply before approval.",
    ],
  });
}

function seedUnusableSeedDraft(rootDir, { caseId, evidenceId }) {
  const catalog = new FileBackedCatalog({ rootDir });
  const payloadDir = path.join(rootDir, "payloads", "evidence", "tests");
  fs.mkdirSync(payloadDir, { recursive: true });

  fs.writeFileSync(
    path.join(payloadDir, `${evidenceId}.json`),
    `${JSON.stringify({
      objective: "Inspect scheduler status.",
      steps_completed: [
        "Inspected launchd jobs, Codex automations, crontab, and ECITR refresh-autonomous code.",
      ],
      findings: [
        "The current scheduler state was observed.",
      ],
      blockers: [
        "No substantive intervention was attempted.",
      ],
    }, null, 2)}\n`,
    "utf8",
  );

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
    problem_statement: "A closeout seed captured only a status inspection.",
    context: {
      constraints: [
        "No substantive intervention was attempted.",
      ],
      project_scope: "project",
      toolchain: [],
    },
    action_taken: "Inspected launchd jobs, Codex automations, crontab, and ECITR refresh-autonomous code.",
    outcome: "The current scheduler state was observed.",
    failure_mode: "Status-only cases should not become active reusable cases.",
    applicability: {
      when_to_apply: [
        "A future agent is only checking whether the scheduler is currently alive.",
      ],
      when_not_to_apply: [
        "The future task requires an implementation or artifact-changing intervention.",
      ],
    },
    evidence_refs: [evidenceId],
    review_state: "draft",
    confidence: 0.65,
    derived_at: "2099-01-01T00:00:00.000Z",
    derivation_rule_id: "case-seed-closeout-v1",
    open_questions: [],
  });
}
