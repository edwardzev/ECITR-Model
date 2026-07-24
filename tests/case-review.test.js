const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CaseReviewSurface, evaluateCaseReadiness } = require("../src/cases/case-review");
const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");

function createSeedDerivedCase(overrides = {}) {
  return {
    case_id: "case_seed_readiness",
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
    action_taken: "Replaced the closeout schema with a discriminated union.",
    outcome: "Future closeouts expose accurate reusable seed semantics.",
    failure_mode: "Generic readiness heuristics can reject valid closeout actions.",
    applicability: {
      when_to_apply: [
        "A future agent is deciding whether the same closeout-authored implementation pattern applies.",
        "The run evidence includes ecitr_closeout.decision = candidate.",
      ],
      when_not_to_apply: [
        "The work was only a read-only status inspection with no intervention or evidence-capture result.",
      ],
    },
    evidence_refs: ["ev_seed_readiness"],
    review_state: "draft",
    confidence: 0.82,
    derived_at: "2026-05-05T12:00:00.000Z",
    derivation_rule_id: "case-seed-closeout-v1",
    open_questions: [],
    ...overrides,
  };
}

test("case review surface lists draft cases ordered by open questions then age", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-review-"));
  const catalog = new FileBackedCatalog({ rootDir });

  catalog.writeRecord("case", {
    case_id: "case_b",
    case_version: 1,
    status: "draft",
    problem_statement: "Second case",
    action_taken: "Patched the runtime policy layer and enforced the guarded write path.",
    outcome: "Outcome",
    evidence_refs: ["ev_002"],
    review_state: "draft",
    confidence: 0.7,
    derived_at: "2026-04-11T11:00:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
    open_questions: ["Question one", "Question two"],
  });

  catalog.writeRecord("case", {
    case_id: "case_a",
    case_version: 1,
    status: "draft",
    problem_statement: "First case",
    action_taken: "Patched the runtime policy layer and enforced the guarded write path.",
    outcome: "Outcome",
    evidence_refs: ["ev_001"],
    review_state: "draft",
    confidence: 0.75,
    derived_at: "2026-04-11T10:00:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
    open_questions: ["Question one"],
  });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });
  const result = surface.listPendingCases();

  assert.equal(result.total_pending, 2);
  assert.deepEqual(result.cases.map((entry) => entry.case_id), ["case_a", "case_b"]);
  assert.equal(result.cases[0].approval_ready, false);
});

test("case review surface can filter pending cases by workspace id", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-review-"));
  const catalog = new FileBackedCatalog({ rootDir });

  catalog.writeRecord("case", {
    case_id: "case_msbc",
    case_version: 1,
    status: "draft",
    problem_statement: "MSBC draft",
    action_taken: "Patched report layout handling.",
    outcome: "Outcome",
    evidence_refs: ["ev_msbc"],
    review_state: "draft",
    confidence: 0.7,
    derived_at: "2026-04-11T10:00:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
    open_questions: [],
    workspace_id: "ms_business_central",
  });
  catalog.writeRecord("case", {
    case_id: "case_other",
    case_version: 1,
    status: "draft",
    problem_statement: "Other draft",
    action_taken: "Patched another repo.",
    outcome: "Outcome",
    evidence_refs: ["ev_other"],
    review_state: "draft",
    confidence: 0.7,
    derived_at: "2026-04-11T10:05:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
    open_questions: [],
    workspace_id: "other_workspace",
  });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });
  const result = surface.listPendingCases({ workspaceId: "ms_business_central" });

  assert.equal(result.workspace_id, "ms_business_central");
  assert.equal(result.total_pending, 1);
  assert.deepEqual(result.cases.map((entry) => entry.case_id), ["case_msbc"]);
});

test("case review inspection returns the matching staged packet and evidence headers", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-review-"));
  const catalog = new FileBackedCatalog({ rootDir });
  const stagingDir = path.join(rootDir, "staging", "case-compilation-packets");
  fs.mkdirSync(stagingDir, { recursive: true });

  catalog.writeRecord("evidence", {
    evidence_id: "ev_review_001",
    substrate_ref: "file:///tmp/evidence.json",
    source_type: "file",
    source_locator: "/tmp/evidence.json",
    captured_at: "2026-04-11T12:00:00.000Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: "payloads/evidence/tests/ev_review_001.json",
    payload_hash: "sha256:test",
    source_hash: "sha256:test-source",
    redaction_state: "none",
    immutable: true,
  });

  catalog.writeRecord("case", {
    case_id: "case_review_001",
    case_version: 1,
    status: "draft",
    problem_statement: "Inspect me",
    action_taken: "Patched the runtime policy layer and enforced the guarded write path.",
    outcome: "Outcome",
    evidence_refs: ["ev_review_001"],
    review_state: "draft",
    confidence: 0.7,
    derived_at: "2026-04-11T12:05:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
    open_questions: ["Confirm applicability"],
  });

  fs.writeFileSync(
    path.join(stagingDir, "ccp_review_001.json"),
    `${JSON.stringify({
      compilation_id: "ccp_review_001",
      proposed_case_id: "case_review_001",
      evidence_refs: ["ev_review_001"],
      problem_statement: "Inspect me",
      confidence: 0.7,
      derivation_rule_id: "case-autodistill-run-v1",
      open_questions: ["Confirm applicability"],
    }, null, 2)}\n`,
    "utf8",
  );

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });
  const result = surface.inspectCase("case_review_001");

  assert.equal(result.case.case_id, "case_review_001");
  assert.equal(result.packet.compilation_id, "ccp_review_001");
  assert.equal(result.completions.length, 0);
  assert.equal(result.amendments.length, 0);
  assert.equal(result.evidence[0].evidence_id, "ev_review_001");
  assert.equal(result.review_readiness.approval_ready, false);
});

test("case review complete builds a support-linked completion packet and approval-ready draft", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-review-"));
  const catalog = new FileBackedCatalog({ rootDir });
  const payloadDir = path.join(rootDir, "payloads", "evidence", "tests");
  fs.mkdirSync(payloadDir, { recursive: true });

  fs.writeFileSync(
    path.join(payloadDir, "ev_complete_001.json"),
    `${JSON.stringify({
      objective: "Implement repo-level memory enforcement for Codex Desktop work.",
      steps_completed: [
        "Created the enforcement instructions",
        "Verified the watcher behavior",
      ],
      findings: [
        "A watcher alone cannot guarantee pre-reply memory loading.",
      ],
      blockers: [
        "Codex Desktop does not provide a guaranteed pre-thread hook.",
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  catalog.writeRecord("evidence", {
    evidence_id: "ev_complete_001",
    substrate_ref: "file:///tmp/complete.json",
    source_type: "file",
    source_locator: "/tmp/complete.json",
    captured_at: "2026-04-11T14:00:00.000Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: "payloads/evidence/tests/ev_complete_001.json",
    payload_hash: "sha256:test",
    source_hash: "sha256:test",
    redaction_state: "none",
    immutable: true,
  });

  catalog.writeRecord("case", {
    case_id: "case_complete_001",
    case_version: 1,
    status: "draft",
    problem_statement: "Implement repo-level Codex memory enforcement.",
    context: {
      constraints: [
        "Automation cadence is limited by the current scheduler.",
      ],
      project_scope: "project",
      toolchain: [],
    },
    action_taken: "Added the enforcement surface.",
    outcome: "The workflow became enforceable at review time.",
    failure_mode: "A watcher alone cannot guarantee pre-reply memory loading.",
    evidence_refs: ["ev_complete_001"],
    review_state: "draft",
    confidence: 0.75,
    derived_at: "2026-04-11T14:05:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
    open_questions: [
      "Confirm or add applicability.when_to_apply before approval.",
      "Confirm or add applicability.when_not_to_apply before approval."
    ]
  });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });
  const result = surface.completeDraft({
    caseId: "case_complete_001",
    reviewer: "case-steward",
    rationale: "Generate bounded applicability from extracted facts and boundaries.",
    amendedAt: "2026-04-11T14:30:00.000Z",
    preparedAt: "2026-04-11T14:29:00.000Z",
    dryRun: true,
  });

  assert.equal(result.completionPacket.case_id, "case_complete_001");
  assert.equal(result.completionPacket.facts.length > 0, true);
  assert.equal(result.completionPacket.boundaries.length > 0, true);
  assert.equal(result.completionPacket.suggested_applicability.when_to_apply.length > 0, true);
  assert.equal(result.amendmentPacket.completion_id, result.completionPacket.completion_id);
  assert.equal(result.nextRecord.case_version, 2);
  assert.equal(result.review_readiness.approval_ready, true);
});

test("case review complete skips incidental setup lines when choosing the primary intervention", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-review-"));
  const catalog = new FileBackedCatalog({ catalogRoot: rootDir, rootDir });
  const payloadDir = path.join(rootDir, "payloads", "evidence", "tests");
  fs.mkdirSync(payloadDir, { recursive: true });

  fs.writeFileSync(
    path.join(payloadDir, "ev_complete_003.json"),
    `${JSON.stringify({
      objective: "Repair the active export path.",
      steps_completed: [
        "Opened project memory for the repo",
        "Patched the exporter to write the canonical file",
      ],
      findings: [
        "The canonical file was stale.",
      ],
      blockers: [
        "The old snapshot was still being served.",
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  catalog.writeRecord("evidence", {
    evidence_id: "ev_complete_003",
    substrate_ref: "file:///tmp/complete3.json",
    source_type: "file",
    source_locator: "/tmp/complete3.json",
    captured_at: "2026-04-11T14:00:00.000Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: "payloads/evidence/tests/ev_complete_003.json",
    payload_hash: "sha256:test",
    source_hash: "sha256:test",
    redaction_state: "none",
    immutable: true,
  });

  catalog.writeRecord("case", {
    case_id: "case_complete_003",
    case_version: 1,
    status: "draft",
    problem_statement: "Repair the active export path.",
    context: {
      constraints: [
        "The old snapshot was still being served.",
      ],
      project_scope: "project",
      toolchain: [],
    },
    action_taken: "1. Opened project memory for the repo.\n2. Patched the exporter to write the canonical file.\n3. Verified the canonical output path.",
    outcome: "The canonical file became current again.",
    failure_mode: "The old snapshot was still being served.",
    evidence_refs: ["ev_complete_003"],
    review_state: "draft",
    confidence: 0.75,
    derived_at: "2026-04-11T14:05:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
    open_questions: [
      "Confirm applicability.when_to_apply before approval.",
      "Confirm applicability.when_not_to_apply before approval."
    ]
  });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });
  const result = surface.completeDraft({
    caseId: "case_complete_003",
    reviewer: "case-steward",
    rationale: "Generate bounded applicability from extracted facts and boundaries.",
    amendedAt: "2026-04-11T14:30:00.000Z",
    preparedAt: "2026-04-11T14:29:00.000Z",
    dryRun: true,
  });

  assert.match(
    result.completionPacket.suggested_applicability.when_to_apply[0].text,
    /Patched the exporter to write the canonical file/,
  );
  assert.equal(result.review_readiness.approval_ready, true);
});

test("case review complete recovers a missing failure boundary from linked evidence blockers", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-review-"));
  const catalog = new FileBackedCatalog({ rootDir });
  const payloadDir = path.join(rootDir, "payloads", "evidence", "tests");
  fs.mkdirSync(payloadDir, { recursive: true });

  fs.writeFileSync(
    path.join(payloadDir, "ev_complete_004_recovery.json"),
    `${JSON.stringify({
      objective: "Enable the live OCR automation path.",
      steps_completed: [
        "Added the OCR automation flags to the runtime configuration.",
        "Patched the setup API to persist the OCR automation values."
      ],
      findings: [
        "The setup surface now exposes the OCR automation controls.",
        "Fresh end-to-end verification still depends on a new incoming-document upload after version 0.1.0.30."
      ],
      blockers: []
    }, null, 2)}\n`,
    "utf8",
  );

  catalog.writeRecord("evidence", {
    evidence_id: "ev_complete_004_recovery",
    substrate_ref: "file:///tmp/complete4-recovery.json",
    source_type: "file",
    source_locator: "/tmp/complete4-recovery.json",
    captured_at: "2026-04-13T11:00:00.000Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: "payloads/evidence/tests/ev_complete_004_recovery.json",
    payload_hash: "sha256:test",
    source_hash: "sha256:test",
    redaction_state: "none",
    immutable: true,
  });

  catalog.writeRecord("case", {
    case_id: "case_complete_004_recovery",
    case_version: 1,
    status: "draft",
    problem_statement: "Enable the live OCR automation path.",
    context: {
      constraints: [],
      project_scope: "project",
      toolchain: []
    },
    action_taken:
      "1. Added the OCR automation flags to the runtime configuration.\n" +
      "2. Patched the setup API to persist the OCR automation values.",
    outcome: "The setup surface now exposes the OCR automation controls.",
    evidence_refs: ["ev_complete_004_recovery"],
    review_state: "draft",
    confidence: 0.82,
    derived_at: "2026-04-13T11:05:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
    open_questions: [
      "Confirm applicability.when_to_apply before approval.",
      "Confirm applicability.when_not_to_apply before approval.",
      "Source evidence does not record an explicit failure_mode; confirm whether none was observed or add the specific failure mode before approval."
    ]
  });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });
  const result = surface.completeDraft({
    caseId: "case_complete_004_recovery",
    reviewer: "case-steward",
    rationale: "Recover the missing boundary from evidence blockers.",
    amendedAt: "2026-04-13T11:20:00.000Z",
    preparedAt: "2026-04-13T11:19:00.000Z",
    dryRun: true,
  });

  assert.equal(result.recoveryPacket.case_id, "case_complete_004_recovery");
  assert.equal(result.recoveryPacket.candidate_boundaries.length, 1);
  assert.match(result.recoveryPacket.suggested_failure_mode.text, /fresh end-to-end verification still depends/i);
  assert.match(result.nextRecord.failure_mode, /fresh end-to-end verification still depends/i);
  assert.equal(result.review_readiness.approval_ready, true);
});

test("case review complete refuses primitive drafts when recovery finds no bounded boundary", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-review-"));
  const catalog = new FileBackedCatalog({ rootDir });
  const payloadDir = path.join(rootDir, "payloads", "evidence", "tests");
  fs.mkdirSync(payloadDir, { recursive: true });

  fs.writeFileSync(
    path.join(payloadDir, "ev_complete_005_recovery.json"),
    `${JSON.stringify({
      objective: "Implement the initial memory infrastructure.",
      steps_completed: [
        "Defined architecture and principles.",
        "Created the folder structure."
      ],
      findings: [
        "Structured memory requires strict enforcement from the start.",
        "Simple tools are sufficient to bootstrap system behavior."
      ],
      blockers: []
    }, null, 2)}\n`,
    "utf8",
  );

  catalog.writeRecord("evidence", {
    evidence_id: "ev_complete_005_recovery",
    substrate_ref: "file:///tmp/complete5-recovery.json",
    source_type: "file",
    source_locator: "/tmp/complete5-recovery.json",
    captured_at: "2026-04-13T11:30:00.000Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: "payloads/evidence/tests/ev_complete_005_recovery.json",
    payload_hash: "sha256:test",
    source_hash: "sha256:test",
    redaction_state: "none",
    immutable: true,
  });

  catalog.writeRecord("case", {
    case_id: "case_complete_005_recovery",
    case_version: 1,
    status: "draft",
    problem_statement: "Implement the initial memory infrastructure.",
    context: {
      constraints: [],
      project_scope: "project",
      toolchain: []
    },
    action_taken:
      "1. Defined architecture and principles.\n" +
      "2. Created the folder structure.",
    outcome: "Structured memory requires strict enforcement from the start.",
    evidence_refs: ["ev_complete_005_recovery"],
    review_state: "draft",
    confidence: 0.68,
    derived_at: "2026-04-13T11:35:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
    open_questions: [
      "Confirm applicability.when_to_apply before approval.",
      "Confirm applicability.when_not_to_apply before approval.",
      "Source evidence does not record an explicit failure_mode; confirm whether none was observed or add the specific failure mode before approval."
    ]
  });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });
  assert.throws(
    () => surface.completeDraft({
      caseId: "case_complete_005_recovery",
      reviewer: "case-steward",
      rationale: "Try recovery on a primitive draft without a real blocker.",
      amendedAt: "2026-04-13T11:45:00.000Z",
      preparedAt: "2026-04-13T11:44:00.000Z",
      dryRun: true,
    }),
    /produced no bounded boundaries for completion/,
  );
});

test("case review complete leaves the draft non-approval-ready when action_taken has no substantive intervention", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-review-"));
  const catalog = new FileBackedCatalog({ rootDir });
  const payloadDir = path.join(rootDir, "payloads", "evidence", "tests");
  fs.mkdirSync(payloadDir, { recursive: true });

  fs.writeFileSync(
    path.join(payloadDir, "ev_complete_004.json"),
    `${JSON.stringify({
      objective: "Record the provider confirmation request state.",
      steps_completed: [
        "Created a Gmail draft for the provider confirmation request.",
        "Recorded the operator hosting direction.",
      ],
      findings: [
        "Provider reply is still pending.",
      ],
      blockers: [
        "Provider reply is still pending.",
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  catalog.writeRecord("evidence", {
    evidence_id: "ev_complete_004",
    substrate_ref: "file:///tmp/complete4.json",
    source_type: "file",
    source_locator: "/tmp/complete4.json",
    captured_at: "2026-04-11T14:00:00.000Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: "payloads/evidence/tests/ev_complete_004.json",
    payload_hash: "sha256:test",
    source_hash: "sha256:test",
    redaction_state: "none",
    immutable: true,
  });

  catalog.writeRecord("case", {
    case_id: "case_complete_004",
    case_version: 1,
    status: "draft",
    problem_statement: "Record the provider confirmation request state.",
    context: {
      constraints: [
        "Provider reply is still pending.",
      ],
      project_scope: "project",
      toolchain: [],
    },
    action_taken: "1. Created a Gmail draft for the provider confirmation request.\n2. Recorded the operator hosting direction.",
    outcome: "The provider-contact step now exists as a draft ready to send.",
    failure_mode: "Provider reply is still pending.",
    evidence_refs: ["ev_complete_004"],
    review_state: "draft",
    confidence: 0.75,
    derived_at: "2026-04-11T14:05:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
    open_questions: [
      "Confirm applicability.when_to_apply before approval.",
      "Confirm applicability.when_not_to_apply before approval."
    ]
  });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });
  const result = surface.completeDraft({
    caseId: "case_complete_004",
    reviewer: "case-steward",
    rationale: "Generate bounded applicability from extracted facts and boundaries.",
    amendedAt: "2026-04-11T14:30:00.000Z",
    preparedAt: "2026-04-11T14:29:00.000Z",
    dryRun: true,
  });

  assert.equal(result.review_readiness.approval_ready, false);
  assert.match(
    result.review_readiness.reasons.join(" ; "),
    /substantive reuse condition/,
  );
});

test("case review readiness accepts substantive closeout seed action phrasing", () => {
  const actionCases = [
    "Replaced the MCP field with a discriminated union for candidate, none, and not_applicable closeouts.",
    "Generated positive and negative pilot zips using source invoice headers as templates and updated record counts.",
    "Exported 2024 source data from Business Central and generated a reconciled workbook.",
    "Introduced shared heartbeat lease defaults, ECS env wiring, and regression tests.",
  ];

  for (const action_taken of actionCases) {
    const readiness = evaluateCaseReadiness(createSeedDerivedCase({ action_taken }));

    assert.equal(
      readiness.approval_ready,
      true,
      `${action_taken} should be approval-ready: ${readiness.reasons.join("; ")}`,
    );
  }
});

test("case review readiness still blocks read-only closeout seed action phrasing", () => {
  const readiness = evaluateCaseReadiness(createSeedDerivedCase({
    action_taken: "Inspected launchd jobs, Codex automations, crontab, and ECITR refresh-autonomous code.",
  }));

  assert.equal(readiness.approval_ready, false);
  assert.match(
    readiness.reasons.join(" ; "),
    /action_taken must contain at least one substantive intervention or evidence-capture step/,
  );
});

test("case review amendment writes a staged packet, increments version, and clears prior review state", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-review-"));
  const catalog = new FileBackedCatalog({ rootDir });

  catalog.writeRecord("case", {
    case_id: "case_review_amend_001",
    case_version: 1,
    status: "draft",
    problem_statement: "Amend me",
    context: {
      constraints: [],
      project_scope: "project",
      toolchain: [],
    },
    action_taken: "Patched the runtime policy layer and enforced the guarded write path.",
    outcome: "Outcome",
    failure_mode: "Failure mode",
    evidence_refs: ["ev_amend_001"],
    review_state: "reviewed",
    confidence: 0.75,
    derived_at: "2026-04-11T13:00:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
    open_questions: ["Add applicability"],
  });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });
  const result = surface.amendDraft({
    caseId: "case_review_amend_001",
    reviewer: "case-steward",
    rationale: "Complete applicability and resolve open questions.",
    amendedAt: "2026-04-11T13:30:00.000Z",
    changes: {
      applicability: {
        when_to_apply: ["When the same workspace policy gap appears again"],
        when_not_to_apply: ["When the runtime already enforces the policy natively"],
      },
      open_questions: [],
    },
  });

  const stored = catalog.getRecord("case", "case_review_amend_001");
  const inspected = surface.inspectCase("case_review_amend_001");

  assert.equal(result.nextRecord.case_version, 2);
  assert.equal(result.nextRecord.review_state, "draft");
  assert.equal(stored.case_version, 2);
  assert.equal(stored.review_state, "draft");
  assert.equal(stored.derived_at, "2026-04-11T13:30:00.000Z");
  assert.equal(inspected.amendments.length, 1);
  assert.equal(inspected.amendments[0].base_case_version, 1);
  assert.equal(inspected.review_readiness.approval_ready, true);
});

test("case review surface persists approval and writes an audit entry", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-review-"));
  const catalog = new FileBackedCatalog({ rootDir });

  catalog.writeRecord("case", {
    case_id: "case_review_ready_001",
    case_version: 1,
    status: "draft",
    problem_statement: "Ready case",
    context: {
      constraints: [],
      project_scope: "project",
      toolchain: [],
    },
    action_taken: "Patched the runtime policy layer and enforced the guarded write path.",
    outcome: "Outcome",
    failure_mode: "Failure mode",
    applicability: {
      when_to_apply: ["When the operator needs to repeat the same local repair workflow in the same subsystem."],
      when_not_to_apply: ["Do not apply this case when the current workflow targets a different subsystem or outcome."],
    },
    evidence_refs: ["ev_ready_001"],
    review_state: "draft",
    confidence: 0.8,
    derived_at: "2026-04-11T12:10:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
  });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });
  const result = surface.applyDecision({
    caseId: "case_review_ready_001",
    decision: "approve",
    reviewer: "governance-qa-steward",
    rationale: "Framing is complete and the case is ready.",
    reviewedAt: "2026-04-11T12:30:00.000Z",
  });

  const stored = catalog.getRecord("case", "case_review_ready_001");
  assert.equal(result.nextRecord.status, "active");
  assert.equal(stored.status, "active");
  assert.equal(stored.review_state, "approved");
  assert.equal(catalog.countRecords("review_audit_entry"), 1);
});

test("case review surface refuses approval when applicability is boilerplate-only", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-review-"));
  const catalog = new FileBackedCatalog({ rootDir });

  catalog.writeRecord("case", {
    case_id: "case_review_boilerplate_001",
    case_version: 1,
    status: "draft",
    problem_statement: "Rejected by boilerplate applicability",
    context: {
      constraints: ["The same blocker still exists."],
      project_scope: "project",
      toolchain: [],
    },
    action_taken: "Executed the repair sequence.",
    outcome: "The issue was resolved locally.",
    failure_mode: "The same blocker still exists.",
    applicability: {
      when_to_apply: ["When handling the same case-shaped problem: Rejected by boilerplate applicability"],
      when_not_to_apply: [
        "When any of the recorded constraints or blockers no longer holds for the current situation.",
        "When the runtime, scheduling surface, or enforcement mechanism is materially different from the recorded boundaries in this case.",
      ],
    },
    evidence_refs: ["ev_boilerplate_001"],
    review_state: "draft",
    confidence: 0.8,
    derived_at: "2026-04-11T12:10:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
  });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });

  assert.throws(
    () =>
      surface.applyDecision({
        caseId: "case_review_boilerplate_001",
        decision: "approve",
        reviewer: "governance-qa-steward",
        rationale: "Try to approve a boilerplate-only draft.",
        reviewedAt: "2026-04-11T12:30:00.000Z",
        dryRun: true,
      }),
    /not approval-ready/,
  );
});

test("case review surface refuses approval when the only reuse line is incidental setup", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-review-"));
  const catalog = new FileBackedCatalog({ rootDir });

  catalog.writeRecord("case", {
    case_id: "case_review_incidental_001",
    case_version: 1,
    status: "draft",
    problem_statement: "Rejected by incidental applicability",
    context: {
      constraints: ["The same blocker still exists."],
      project_scope: "project",
      toolchain: [],
    },
    action_taken: "Executed the repair sequence.",
    outcome: "The issue was resolved locally.",
    failure_mode: "The same blocker still exists.",
    applicability: {
      when_to_apply: [
        "When the operator needs to execute the same kind of intervention captured here: Opened a new memory session for the execution pass.",
        "When the expected operating conditions still match this record, especially these decisive boundaries: The same blocker still exists.",
      ],
      when_not_to_apply: [
        "Do not apply this case once the decisive blocker or constraint has already been removed: The same blocker still exists.",
        "Do not apply this case when the current workflow aims at a materially different outcome than the one achieved here: The issue was resolved locally.",
      ],
    },
    evidence_refs: ["ev_incidental_001"],
    review_state: "draft",
    confidence: 0.8,
    derived_at: "2026-04-11T12:10:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
  });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });

  assert.throws(
    () =>
      surface.applyDecision({
        caseId: "case_review_incidental_001",
        decision: "approve",
        reviewer: "governance-qa-steward",
        rationale: "Try to approve an incidental-setup draft.",
        reviewedAt: "2026-04-11T12:30:00.000Z",
        dryRun: true,
      }),
    /not approval-ready/,
  );
});

test("case review surface can deprecate an active case that no longer satisfies the current gate", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-review-"));
  const catalog = new FileBackedCatalog({ rootDir });
  const surface = new CaseReviewSurface({ catalogRoot: rootDir });
  const seeded = {
    case_id: "case_review_deprecate_001",
    case_version: 2,
    status: "active",
    problem_statement: "Historical case that was approved under an older gate.",
    context: {
      constraints: ["The old browser-lock blocker was present during the original run."],
      project_scope: "project",
      toolchain: [],
    },
    action_taken: "Investigated the old browser-lock issue and recorded the result.",
    outcome: "The old workflow was captured and approved historically.",
    failure_mode: "The old browser-lock blocker was present during the original run.",
    applicability: {
      when_to_apply: [
        "When the operator needs to execute the same kind of intervention captured here: Opened a memory session for the browser-lock check.",
      ],
      when_not_to_apply: [
        "Do not apply this case once the decisive blocker or constraint has already been removed: The old browser-lock blocker was present during the original run.",
      ],
    },
    evidence_refs: ["ev_deprecate_001"],
    review_state: "approved",
    confidence: 0.7,
    derived_at: "2026-04-12T20:00:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
  };
  fs.mkdirSync(path.join(rootDir, "cases"), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, "cases", "case_review_deprecate_001.json"),
    `${JSON.stringify(seeded, null, 2)}\n`,
    "utf8",
  );

  const deprecated = surface.applyDecision({
    caseId: "case_review_deprecate_001",
    decision: "deprecate",
    reviewer: "governance-qa-steward",
    rationale: "Deprecated after replay against the stricter gate.",
    reviewedAt: "2026-04-12T20:10:00.000Z",
  });

  assert.equal(deprecated.nextRecord.status, "deprecated");
  assert.equal(deprecated.nextRecord.review_state, "approved");
  assert.equal(catalog.countRecords("review_audit_entry"), 1);
});

test("case review surface blocks approval when applicability is a communication or checkpoint record", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-review-"));
  const catalog = new FileBackedCatalog({ rootDir });

  catalog.writeRecord("case", {
    case_id: "case_review_checkpoint_001",
    case_version: 1,
    status: "draft",
    problem_statement: "Record provider confirmation state.",
    context: {
      constraints: ["Provider reply pending."],
      project_scope: "project",
      toolchain: [],
    },
    action_taken: "Recorded provider capability confirmation in the notes.",
    outcome: "The provider-contact step now exists as a draft ready to send.",
    failure_mode: "Provider reply pending.",
    applicability: {
      when_to_apply: [
        "When the operator needs to execute the same kind of intervention captured here: Created a Gmail draft for the provider confirmation request.",
        "When the expected operating conditions still match this record, especially these decisive boundaries: Provider reply pending.",
      ],
      when_not_to_apply: [
        "Do not apply this case once the decisive blocker or constraint has already been removed: Provider reply pending.",
        "Do not apply this case when the current workflow aims at a materially different outcome than the one achieved here: The provider-contact step now exists as a draft ready to send.",
      ],
    },
    evidence_refs: ["ev_checkpoint_001"],
    review_state: "draft",
    confidence: 0.8,
    derived_at: "2026-04-11T12:10:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
  });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });

  assert.throws(
    () =>
      surface.applyDecision({
        caseId: "case_review_checkpoint_001",
        decision: "approve",
        reviewer: "governance-qa-steward",
        rationale: "Try to approve a checkpoint-style draft.",
        reviewedAt: "2026-04-11T12:30:00.000Z",
        dryRun: true,
      }),
    /not approval-ready/,
  );
});

test("case review complete skips workflow and discovery scaffolding when choosing the primary intervention", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-review-"));
  const catalog = new FileBackedCatalog({ rootDir });
  const payloadDir = path.join(rootDir, "payloads", "evidence", "tests");
  fs.mkdirSync(payloadDir, { recursive: true });

  fs.writeFileSync(
    path.join(payloadDir, "ev_complete_005.json"),
    `${JSON.stringify({
      objective: "Diagnose a deployment failure with real telemetry evidence.",
      steps_completed: [
        "Read repository deployment notes in docs/SETUP_PROGRESS.md.",
        "Enumerated available Azure subscriptions.",
        "Queried live Production automation API endpoints for deployment status.",
      ],
      findings: [
        "The deployment failed after upload and telemetry access was missing.",
      ],
      blockers: [
        "Application Insights is not configured for this environment.",
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  catalog.writeRecord("evidence", {
    evidence_id: "ev_complete_005",
    substrate_ref: "file:///tmp/complete-005.json",
    source_type: "file",
    source_locator: "/tmp/complete-005.json",
    captured_at: "2026-04-12T09:00:00.000Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: "payloads/evidence/tests/ev_complete_005.json",
    payload_hash: "sha256:test",
    source_hash: "sha256:test",
    redaction_state: "none",
    immutable: true,
  });

  catalog.writeRecord("case", {
    case_id: "case_complete_005",
    case_version: 1,
    status: "draft",
    problem_statement: "Diagnose deployment failure with missing telemetry visibility.",
    context: {
      constraints: ["Application Insights is not configured for this environment."],
      project_scope: "project",
      toolchain: [],
    },
    action_taken: "1. Read repository deployment notes in docs/SETUP_PROGRESS.md.\n2. Enumerated available Azure subscriptions.\n3. Queried live Production automation API endpoints for deployment status.",
    outcome: "The deployment failed after upload and telemetry access was missing.",
    failure_mode: "Application Insights is not configured for this environment.",
    evidence_refs: ["ev_complete_005"],
    review_state: "draft",
    confidence: 0.75,
    derived_at: "2026-04-12T09:05:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
    open_questions: [
      "Confirm applicability.when_to_apply before approval.",
      "Confirm applicability.when_not_to_apply before approval.",
    ],
  });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });
  const result = surface.completeDraft({
    caseId: "case_complete_005",
    reviewer: "case-steward",
    rationale: "Generate bounded applicability from extracted facts and boundaries.",
    amendedAt: "2026-04-12T09:30:00.000Z",
    preparedAt: "2026-04-12T09:29:00.000Z",
    dryRun: true,
  });

  assert.match(
    result.nextRecord.applicability.when_to_apply[0],
    /Queried live Production automation API endpoints for deployment status\./,
  );
});

test("case review surface blocks approval when failure_mode describes a resolved blocker state", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-review-"));
  const catalog = new FileBackedCatalog({ rootDir });

  catalog.writeRecord("case", {
    case_id: "case_review_resolved_boundary_001",
    case_version: 1,
    status: "draft",
    problem_statement: "Validate the newly deployed OCR control path.",
    context: {
      constraints: ["No blocker remains for the basic queue/submit/poll path."],
      project_scope: "project",
      toolchain: [],
    },
    action_taken: "Deployed the new OCR control APIs and validated a production run.",
    outcome: "The OCR path is live and basic queue/submit/poll now works.",
    failure_mode: "No blocker remains for the basic queue/submit/poll path.",
    applicability: {
      when_to_apply: ["When the operator needs to repeat the same deployment validation in the same runtime surface."],
      when_not_to_apply: ["Do not apply this case once the decisive blocker or constraint has already been removed: No blocker remains for the basic queue/submit/poll path."],
    },
    evidence_refs: ["ev_ready_001"],
    review_state: "draft",
    confidence: 0.8,
    derived_at: "2026-04-12T10:00:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
  });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });
  const result = surface.inspectCase("case_review_resolved_boundary_001");

  assert.equal(result.review_readiness.approval_ready, false);
  assert.match(
    result.review_readiness.reasons.join(" ; "),
    /failure_mode must describe an actual unresolved failure or limitation/,
  );
});

test("case review complete skips token-location and doc-review scaffolding when choosing the primary intervention", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-review-"));
  const catalog = new FileBackedCatalog({ rootDir });
  const payloadDir = path.join(rootDir, "payloads", "evidence", "tests");
  fs.mkdirSync(payloadDir, { recursive: true });

  fs.writeFileSync(
    path.join(payloadDir, "ev_complete_006.json"),
    `${JSON.stringify({
      objective: "Configure an app with real credentials and verify the runtime path.",
      steps_completed: [
        "Located the Airtable token in an existing repo.",
        "Reviewed the current setup docs.",
        "Built the app with the real config and verified the runtime response.",
      ],
      findings: [
        "The app now renders in configured mode with live metadata.",
      ],
      blockers: [
        "Submitting the form would create a real Airtable record.",
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  catalog.writeRecord("evidence", {
    evidence_id: "ev_complete_006",
    substrate_ref: "file:///tmp/complete-006.json",
    source_type: "file",
    source_locator: "/tmp/complete-006.json",
    captured_at: "2026-04-12T12:00:00.000Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: "payloads/evidence/tests/ev_complete_006.json",
    payload_hash: "sha256:test",
    source_hash: "sha256:test",
    redaction_state: "none",
    immutable: true,
  });

  catalog.writeRecord("case", {
    case_id: "case_complete_006",
    case_version: 1,
    status: "draft",
    problem_statement: "Configure the local app with real credentials and verify it runs.",
    context: {
      constraints: ["Submitting the form would create a real Airtable record."],
      project_scope: "project",
      toolchain: [],
    },
    action_taken: "1. Located the Airtable token in an existing repo.\n2. Reviewed the current setup docs.\n3. Built the app with the real config and verified the runtime response.",
    outcome: "The app now renders in configured mode with live metadata.",
    failure_mode: "Submitting the form would create a real Airtable record.",
    evidence_refs: ["ev_complete_006"],
    review_state: "draft",
    confidence: 0.75,
    derived_at: "2026-04-12T12:05:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
    open_questions: [
      "Confirm applicability.when_to_apply before approval.",
      "Confirm applicability.when_not_to_apply before approval.",
    ],
  });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });
  const result = surface.completeDraft({
    caseId: "case_complete_006",
    reviewer: "case-steward",
    rationale: "Generate bounded applicability from extracted facts and boundaries.",
    amendedAt: "2026-04-12T12:30:00.000Z",
    preparedAt: "2026-04-12T12:29:00.000Z",
    dryRun: true,
  });

  assert.match(
    result.nextRecord.applicability.when_to_apply[0],
    /Built the app with the real config and verified the runtime response\./,
  );
});

test("case review complete skips fresh-memory-session and local-inspection scaffolding when choosing the primary intervention", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-review-"));
  const catalog = new FileBackedCatalog({ rootDir });
  const payloadDir = path.join(rootDir, "payloads", "evidence", "tests");
  fs.mkdirSync(payloadDir, { recursive: true });

  fs.writeFileSync(
    path.join(payloadDir, "ev_complete_007.json"),
    `${JSON.stringify({
      objective: "Backfill agent-ops runs into the ECITR evidence catalog.",
      steps_completed: [
        "Opened a fresh ecitr_model memory session for the importer task.",
        "Inspected the local agent-ops project registry and record counts.",
        "Mapped run JSONs into EvidenceRecord payload copies and verified the dry-run importer output.",
      ],
      findings: [
        "The importer can ingest the run corpus into the canonical evidence layer once the target repo is writable.",
      ],
      blockers: [
        "The target ECITR repo is outside the current writable roots.",
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  catalog.writeRecord("evidence", {
    evidence_id: "ev_complete_007",
    substrate_ref: "file:///tmp/complete-007.json",
    source_type: "file",
    source_locator: "/tmp/complete-007.json",
    captured_at: "2026-04-12T13:00:00.000Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: "payloads/evidence/tests/ev_complete_007.json",
    payload_hash: "sha256:test",
    source_hash: "sha256:test",
    redaction_state: "none",
    immutable: true,
  });

  catalog.writeRecord("case", {
    case_id: "case_complete_007",
    case_version: 1,
    status: "draft",
    problem_statement: "Backfill agent-ops runs into ECITR evidence with a dry-run importer.",
    context: {
      constraints: ["The target ECITR repo is outside the current writable roots."],
      project_scope: "project",
      toolchain: [],
    },
    action_taken: "1. Opened a fresh ecitr_model memory session for the importer task.\n2. Inspected the local agent-ops project registry and record counts.\n3. Mapped run JSONs into EvidenceRecord payload copies and verified the dry-run importer output.",
    outcome: "The importer can ingest the run corpus into the canonical evidence layer once the target repo is writable.",
    failure_mode: "The target ECITR repo is outside the current writable roots.",
    evidence_refs: ["ev_complete_007"],
    review_state: "draft",
    confidence: 0.75,
    derived_at: "2026-04-12T13:05:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
    open_questions: [
      "Confirm applicability.when_to_apply before approval.",
      "Confirm applicability.when_not_to_apply before approval.",
    ],
  });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });
  const result = surface.completeDraft({
    caseId: "case_complete_007",
    reviewer: "case-steward",
    rationale: "Generate bounded applicability from extracted facts and boundaries.",
    amendedAt: "2026-04-12T13:30:00.000Z",
    preparedAt: "2026-04-12T13:29:00.000Z",
    dryRun: true,
  });

  assert.match(
    result.nextRecord.applicability.when_to_apply[0],
    /Mapped run JSONs into EvidenceRecord payload copies and verified the dry-run importer output\./,
  );
});

test("case review complete skips coordination and env-setup scaffolding when choosing the primary intervention", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-review-"));
  const catalog = new FileBackedCatalog({ rootDir });
  const payloadDir = path.join(rootDir, "payloads", "evidence", "tests");
  fs.mkdirSync(payloadDir, { recursive: true });

  fs.writeFileSync(
    path.join(payloadDir, "ev_complete_008.json"),
    `${JSON.stringify({
      objective: "Stand up a real configured app flow without treating issue tracking or env setup as the reusable intervention.",
      steps_completed: [
        "Added a GitHub issue comment to note the pending provider reply.",
        "Wrote the required Airtable variables into .env.local.",
        "Implemented the deterministic benchmark runner and verified its local dry-run output.",
      ],
      findings: [
        "The benchmark runner now executes locally with governed config.",
      ],
      blockers: [
        "Provider reply pending before live external validation.",
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  catalog.writeRecord("evidence", {
    evidence_id: "ev_complete_008",
    substrate_ref: "file:///tmp/complete-008.json",
    source_type: "file",
    source_locator: "/tmp/complete-008.json",
    captured_at: "2026-04-13T10:00:00.000Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: "payloads/evidence/tests/ev_complete_008.json",
    payload_hash: "sha256:test",
    source_hash: "sha256:test",
    redaction_state: "none",
    immutable: true,
  });

  catalog.writeRecord("case", {
    case_id: "case_complete_008",
    case_version: 1,
    status: "draft",
    problem_statement: "Stand up a real configured app flow with a deterministic benchmark runner.",
    context: {
      constraints: ["Provider reply pending before live external validation."],
      project_scope: "project",
      toolchain: [],
    },
    action_taken:
      "1. Added a GitHub issue comment to note the pending provider reply.\n2. Wrote the required Airtable variables into .env.local.\n3. Implemented the deterministic benchmark runner and verified its local dry-run output.",
    outcome: "The benchmark runner now executes locally with governed config.",
    failure_mode: "Provider reply pending before live external validation.",
    evidence_refs: ["ev_complete_008"],
    review_state: "draft",
    confidence: 0.75,
    derived_at: "2026-04-13T10:05:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
    open_questions: [
      "Confirm applicability.when_to_apply before approval.",
      "Confirm applicability.when_not_to_apply before approval.",
    ],
  });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });
  const result = surface.completeDraft({
    caseId: "case_complete_008",
    reviewer: "case-steward",
    rationale: "Generate bounded applicability from extracted facts and boundaries.",
    amendedAt: "2026-04-13T10:30:00.000Z",
    preparedAt: "2026-04-13T10:29:00.000Z",
    dryRun: true,
  });

  assert.match(
    result.nextRecord.applicability.when_to_apply[0],
    /Implemented the deterministic benchmark runner and verified its local dry-run output\./,
  );
});

test("case review complete skips worktree, benchmark-meta, and access-attempt scaffolding when choosing the primary intervention", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-review-"));
  const catalog = new FileBackedCatalog({ rootDir });
  const payloadDir = path.join(rootDir, "payloads", "evidence", "tests");
  fs.mkdirSync(payloadDir, { recursive: true });

  fs.writeFileSync(
    path.join(payloadDir, "ev_complete_009.json"),
    `${JSON.stringify({
      objective: "Validate a real recovery path rather than elevating repo-state or access attempts into the case substance.",
      steps_completed: [
        "Created a clean temporary worktree from main to avoid the current dirty workspace.",
        "Attempted to access chatgpt.com through Playwright automation.",
        "Checked reasoning baseline and confirmed supported efforts.",
        "Implemented the recovery importer and verified the replay output against the copied payload set.",
      ],
      findings: [
        "The recovery importer can rebuild the payload lineage from the copied set.",
      ],
      blockers: [
        "Live authenticated ChatGPT access is still unavailable in this browser context.",
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  catalog.writeRecord("evidence", {
    evidence_id: "ev_complete_009",
    substrate_ref: "file:///tmp/complete-009.json",
    source_type: "file",
    source_locator: "/tmp/complete-009.json",
    captured_at: "2026-04-13T11:00:00.000Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: "payloads/evidence/tests/ev_complete_009.json",
    payload_hash: "sha256:test",
    source_hash: "sha256:test",
    redaction_state: "none",
    immutable: true,
  });

  catalog.writeRecord("case", {
    case_id: "case_complete_009",
    case_version: 1,
    status: "draft",
    problem_statement: "Validate a real recovery path from copied payloads.",
    context: {
      constraints: ["Live authenticated ChatGPT access is still unavailable in this browser context."],
      project_scope: "project",
      toolchain: [],
    },
    action_taken:
      "1. Created a clean temporary worktree from main to avoid the current dirty workspace.\n2. Attempted to access chatgpt.com through Playwright automation.\n3. Checked reasoning baseline and confirmed supported efforts.\n4. Implemented the recovery importer and verified the replay output against the copied payload set.",
    outcome: "The recovery importer can rebuild the payload lineage from the copied set.",
    failure_mode: "Live authenticated ChatGPT access is still unavailable in this browser context.",
    evidence_refs: ["ev_complete_009"],
    review_state: "draft",
    confidence: 0.75,
    derived_at: "2026-04-13T11:05:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
    open_questions: [
      "Confirm applicability.when_to_apply before approval.",
      "Confirm applicability.when_not_to_apply before approval.",
    ],
  });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });
  const result = surface.completeDraft({
    caseId: "case_complete_009",
    reviewer: "case-steward",
    rationale: "Generate bounded applicability from extracted facts and boundaries.",
    amendedAt: "2026-04-13T11:30:00.000Z",
    preparedAt: "2026-04-13T11:29:00.000Z",
    dryRun: true,
  });

  assert.match(
    result.nextRecord.applicability.when_to_apply[0],
    /Implemented the recovery importer and verified the replay output against the copied payload set\./,
  );
});

test("case review surface blocks approval when failure_mode describes a non-blocking observational state", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-review-"));
  const catalog = new FileBackedCatalog({ rootDir });

  catalog.writeRecord("case", {
    case_id: "case_review_nonblocking_boundary_001",
    case_version: 1,
    status: "draft",
    problem_statement: "Verify the local app render path with real config.",
    context: {
      constraints: ["No blocker for local viewing."],
      project_scope: "project",
      toolchain: [],
    },
    action_taken: "Configured the app and verified the local render path.",
    outcome: "The app now renders locally with live metadata.",
    failure_mode: "No blocker for local viewing.",
    applicability: {
      when_to_apply: ["When the operator needs to repeat the same local verification in the same runtime surface."],
      when_not_to_apply: ["Do not apply this case once the decisive blocker or constraint has already been removed: No blocker for local viewing."],
    },
    evidence_refs: ["ev_ready_001"],
    review_state: "draft",
    confidence: 0.8,
    derived_at: "2026-04-12T12:10:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
  });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });
  const result = surface.inspectCase("case_review_nonblocking_boundary_001");

  assert.equal(result.review_readiness.approval_ready, false);
  assert.match(
    result.review_readiness.reasons.join(" ; "),
    /failure_mode must describe an actual unresolved failure or limitation/,
  );
});

test("case review surface refuses approval when framing is incomplete", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-review-"));
  const catalog = new FileBackedCatalog({ rootDir });

  catalog.writeRecord("case", {
    case_id: "case_review_incomplete_001",
    case_version: 1,
    status: "draft",
    problem_statement: "Incomplete case",
    action_taken: "Action",
    outcome: "Outcome",
    evidence_refs: ["ev_incomplete_001"],
    review_state: "draft",
    confidence: 0.7,
    derived_at: "2026-04-11T12:40:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
    open_questions: ["Add applicability"],
  });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });

  assert.throws(
    () =>
      surface.applyDecision({
        caseId: "case_review_incomplete_001",
        decision: "approve",
        reviewer: "governance-qa-steward",
        rationale: "Try to approve an incomplete draft.",
        reviewedAt: "2026-04-11T12:45:00.000Z",
        dryRun: true,
      }),
    /not approval-ready/,
  );
});

test("case review amendment refuses stale base versions during persistence", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-review-"));
  const catalog = new FileBackedCatalog({ rootDir });

  catalog.writeRecord("case", {
    case_id: "case_review_stale_001",
    case_version: 2,
    status: "draft",
    problem_statement: "Stale amendment",
    action_taken: "Action",
    outcome: "Outcome",
    evidence_refs: ["ev_stale_001"],
    review_state: "draft",
    confidence: 0.7,
    derived_at: "2026-04-11T13:40:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
    open_questions: ["Resolve this"],
  });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });

  assert.throws(
    () =>
      surface.amendDraft({
        caseId: "case_review_stale_001",
        reviewer: "case-steward",
        rationale: "Should fail because the base version is stale.",
        amendedAt: "2026-04-11T13:45:00.000Z",
        changes: {
          open_questions: [],
        },
        dryRun: false,
        baseCaseVersion: 1,
      }),
    /base case_version/,
  );
});

test("case review complete persists completion and amendment packets before updating the draft", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-review-"));
  const catalog = new FileBackedCatalog({ rootDir });
  const payloadDir = path.join(rootDir, "payloads", "evidence", "tests");
  fs.mkdirSync(payloadDir, { recursive: true });

  fs.writeFileSync(
    path.join(payloadDir, "ev_complete_002.json"),
    `${JSON.stringify({
      objective: "Enforce first-turn memory opening.",
      steps_completed: [
        "Added a workspace instruction surface",
      ],
      findings: [
        "A watcher cannot guarantee the first reply already consumed memory.",
      ],
      blockers: [
        "The runtime still lacks a pre-thread hook.",
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  catalog.writeRecord("evidence", {
    evidence_id: "ev_complete_002",
    substrate_ref: "file:///tmp/complete2.json",
    source_type: "file",
    source_locator: "/tmp/complete2.json",
    captured_at: "2026-04-11T14:40:00.000Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: "payloads/evidence/tests/ev_complete_002.json",
    payload_hash: "sha256:test",
    source_hash: "sha256:test",
    redaction_state: "none",
    immutable: true,
  });

  catalog.writeRecord("case", {
    case_id: "case_complete_002",
    case_version: 1,
    status: "draft",
    problem_statement: "Enforce first-turn memory opening.",
    context: {
      constraints: [
        "Scheduler cadence is limited.",
      ],
      project_scope: "project",
      toolchain: [],
    },
    action_taken: "Added the runtime enforcement layer.",
    outcome: "Memory governance became explicit.",
    failure_mode: "Without a pre-thread hook, a watcher remains post-hoc only.",
    evidence_refs: ["ev_complete_002"],
    review_state: "draft",
    confidence: 0.75,
    derived_at: "2026-04-11T14:45:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
    open_questions: [
      "Confirm applicability."
    ]
  });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });
  const result = surface.completeDraft({
    caseId: "case_complete_002",
    reviewer: "case-steward",
    rationale: "Persist bounded completion output.",
    amendedAt: "2026-04-11T15:00:00.000Z",
    preparedAt: "2026-04-11T14:59:00.000Z",
  });

  const inspected = surface.inspectCase("case_complete_002");
  const stored = catalog.getRecord("case", "case_complete_002");

  assert.equal(result.nextRecord.case_version, 2);
  assert.equal(stored.case_version, 2);
  assert.equal(inspected.completions.length, 1);
  assert.equal(inspected.amendments.length, 1);
  assert.equal(inspected.completions[0].completion_id, result.completionPacket.completion_id);
  assert.equal(inspected.amendments[0].completion_id, result.completionPacket.completion_id);
});

test("case review complete prefers a stronger later intervention over weak analytical lead-in", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-review-"));
  const catalog = new FileBackedCatalog({ catalogRoot: rootDir, rootDir });
  const payloadDir = path.join(rootDir, "payloads", "evidence", "tests");
  fs.mkdirSync(payloadDir, { recursive: true });

  fs.writeFileSync(
    path.join(payloadDir, "ev_complete_012.json"),
    `${JSON.stringify({
      objective: "Repair the live telemetry path without centering the repo-reading lead-in.",
      steps_completed: [
        "Reviewed the current telemetry notes before changing the runtime.",
        "Created the telemetry resource group and provisioned Application Insights.",
        "Set the live environment key and reproduced the failing deployment.",
      ],
      findings: [
        "The fresh validation trace now appears in Application Insights.",
      ],
      blockers: [
        "Permission-set validation still fails until the package is rebuilt with the missing objects.",
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  catalog.writeRecord("evidence", {
    evidence_id: "ev_complete_012",
    substrate_ref: "file:///tmp/complete-012.json",
    source_type: "file",
    source_locator: "/tmp/complete-012.json",
    captured_at: "2026-04-13T15:00:00.000Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: "payloads/evidence/tests/ev_complete_012.json",
    payload_hash: "sha256:test",
    source_hash: "sha256:test",
    redaction_state: "none",
    immutable: true,
  });

  catalog.writeRecord("case", {
    case_id: "case_complete_012",
    case_version: 1,
    status: "draft",
    problem_statement: "Repair the live telemetry path for failed extension deployments.",
    context: {
      constraints: [
        "Permission-set validation still fails until the package is rebuilt with the missing objects.",
      ],
      project_scope: "project",
      toolchain: [],
    },
    action_taken:
      "1. Reviewed the current telemetry notes before changing the runtime.\n" +
      "2. Created the telemetry resource group and provisioned Application Insights.\n" +
      "3. Set the live environment key and reproduced the failing deployment.",
    outcome: "The fresh validation trace now appears in Application Insights.",
    failure_mode: "Permission-set validation still fails until the package is rebuilt with the missing objects.",
    evidence_refs: ["ev_complete_012"],
    review_state: "draft",
    confidence: 0.8,
    derived_at: "2026-04-13T15:10:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
    open_questions: [
      "Confirm applicability.when_to_apply before approval.",
      "Confirm applicability.when_not_to_apply before approval.",
    ],
  });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });
  const completed = surface.completeDraft({
    caseId: "case_complete_012",
    reviewer: "case-steward",
    rationale: "Use the stronger later intervention instead of the analytical lead-in.",
    completedAt: "2026-04-13T15:15:00.000Z",
    preparedAt: "2026-04-13T15:14:00.000Z",
    amendedAt: "2026-04-13T15:15:00.000Z",
    dryRun: true,
  });

  assert.equal(completed.review_readiness.approval_ready, true);
  assert.match(
    completed.nextRecord.applicability.when_to_apply[0],
    /(created the telemetry resource group and provisioned application insights|set the live environment key and reproduced the failing deployment)/i,
  );
});

test("case review surface blocks documentation-only cases even after completion", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-review-"));
  const catalog = new FileBackedCatalog({ catalogRoot: rootDir, rootDir });
  const payloadDir = path.join(rootDir, "payloads", "evidence", "tests");
  fs.mkdirSync(payloadDir, { recursive: true });

  fs.writeFileSync(
    path.join(payloadDir, "ev_complete_013.json"),
    `${JSON.stringify({
      objective: "Document the current audit doctrine without changing the live operating surface.",
      steps_completed: [
        "Re-read the repository doctrine before extending the audit.",
        "Created a canonical audit runbook for future operators.",
        "Updated the target architecture and governance notes.",
      ],
      findings: [
        "The audit contract is now documented for future use.",
      ],
      blockers: [
        "Publishability and grouping rules are still unknown from current evidence.",
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  catalog.writeRecord("evidence", {
    evidence_id: "ev_complete_013",
    substrate_ref: "file:///tmp/complete-013.json",
    source_type: "file",
    source_locator: "/tmp/complete-013.json",
    captured_at: "2026-04-13T16:00:00.000Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: "payloads/evidence/tests/ev_complete_013.json",
    payload_hash: "sha256:test",
    source_hash: "sha256:test",
    redaction_state: "none",
    immutable: true,
  });

  catalog.writeRecord("case", {
    case_id: "case_complete_013",
    case_version: 1,
    status: "draft",
    problem_statement: "Document the current audit doctrine without changing the live operating surface.",
    context: {
      constraints: [
        "Publishability and grouping rules are still unknown from current evidence.",
      ],
      project_scope: "project",
      toolchain: [],
    },
    action_taken:
      "1. Re-read the repository doctrine before extending the audit.\n" +
      "2. Created a canonical audit runbook for future operators.\n" +
      "3. Updated the target architecture and governance notes.",
    outcome: "The audit contract is now documented for future use.",
    failure_mode: "Publishability and grouping rules are still unknown from current evidence.",
    evidence_refs: ["ev_complete_013"],
    review_state: "draft",
    confidence: 0.72,
    derived_at: "2026-04-13T16:10:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
    open_questions: [
      "Confirm applicability.when_to_apply before approval.",
      "Confirm applicability.when_not_to_apply before approval.",
    ],
  });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });
  const completed = surface.completeDraft({
    caseId: "case_complete_013",
    reviewer: "case-steward",
    rationale: "Try to complete a documentation-only case.",
    completedAt: "2026-04-13T16:15:00.000Z",
    preparedAt: "2026-04-13T16:14:00.000Z",
    amendedAt: "2026-04-13T16:15:00.000Z",
    dryRun: true,
  });

  assert.equal(completed.review_readiness.approval_ready, false);
  assert.match(
    completed.review_readiness.reasons.join(" ; "),
    /action_taken must contain at least one substantive intervention or evidence-capture step/,
  );
  assert.match(
    completed.review_readiness.reasons.join(" ; "),
    /applicability\.when_to_apply must contain at least one substantive reuse condition/,
  );
});

test("case review surface blocks generic smoke-check records even with unresolved audit notes", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-review-"));
  const catalog = new FileBackedCatalog({ rootDir });

  catalog.writeRecord("case", {
    case_id: "case_review_smoke_only_001",
    case_version: 2,
    status: "draft",
    problem_statement: "Audit the runtime hardening state.",
    context: {
      constraints: [],
      project_scope: "project",
      toolchain: [],
    },
    action_taken: "Ran the shipped test suite and runtime smoke check.",
    outcome: "The runtime contract and hardening are solid.",
    failure_mode: "The system still tolerates unlinked runs because run_summary.schema.json does not require session_ref.",
    applicability: {
      when_to_apply: [
        "When the operator needs to execute the same kind of intervention captured here: Ran the shipped test suite and runtime smoke check."
      ],
      when_not_to_apply: [
        "Do not apply this case once the decisive blocker or constraint has already been removed: The system still tolerates unlinked runs because run_summary.schema.json does not require session_ref."
      ]
    },
    evidence_refs: ["ev_smoke_only_001"],
    review_state: "draft",
    confidence: 0.74,
    derived_at: "2026-04-13T17:00:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
  });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });
  const readiness = surface.inspectCase("case_review_smoke_only_001").review_readiness;

  assert.equal(readiness.approval_ready, false);
  assert.match(
    readiness.reasons.join(" ; "),
    /action_taken must contain at least one substantive intervention or evidence-capture step/,
  );
});

test("case review surface blocks resolved-positive boundaries from counting as failure mode", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-review-"));
  const catalog = new FileBackedCatalog({ rootDir });

  catalog.writeRecord("case", {
    case_id: "case_review_resolved_positive_001",
    case_version: 2,
    status: "draft",
    problem_statement: "Fix the mobile orders layout.",
    context: {
      constraints: [],
      project_scope: "project",
      toolchain: [],
    },
    action_taken: "Added mobile-specific CSS for the orders header, actions, filters, and order cards.",
    outcome: "The mobile header now stacks cleanly without horizontal overflow.",
    failure_mode: "The mobile header now stacks cleanly without horizontal overflow, and the filter panel no longer wastes height on a broken count sentence.",
    applicability: {
      when_to_apply: [
        "When the operator needs to execute the same kind of intervention captured here: Added mobile-specific CSS for the orders header, actions, filters, and order cards."
      ],
      when_not_to_apply: [
        "Do not apply this case once the decisive blocker or constraint has already been removed: The mobile header now stacks cleanly without horizontal overflow, and the filter panel no longer wastes height on a broken count sentence."
      ]
    },
    evidence_refs: ["ev_resolved_positive_001"],
    review_state: "draft",
    confidence: 0.8,
    derived_at: "2026-04-13T17:05:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
  });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });
  const readiness = surface.inspectCase("case_review_resolved_positive_001").review_readiness;

  assert.equal(readiness.approval_ready, false);
  assert.match(
    readiness.reasons.join(" ; "),
    /failure_mode must describe an actual unresolved failure or limitation/,
  );
});

test("case review surface blocks corpus-health meta audits from counting as substantive action", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-review-"));
  const catalog = new FileBackedCatalog({ rootDir });

  catalog.writeRecord("case", {
    case_id: "case_review_meta_audit_001",
    case_version: 2,
    status: "draft",
    problem_statement: "Audit session and run hygiene in the live corpus.",
    context: {
      constraints: [],
      project_scope: "project",
      toolchain: [],
    },
    action_taken: "Queried the current morning review surface and scanned the live corpus for session/run/draft health.",
    outcome: "The runtime contract and hardening are solid.",
    failure_mode: "The system still tolerates unlinked runs because run_summary.schema.json does not require session_ref.",
    applicability: {
      when_to_apply: [
        "When the operator needs to execute the same kind of intervention captured here: Queried the current morning review surface and scanned the live corpus for session/run/draft health."
      ],
      when_not_to_apply: [
        "Do not apply this case once the decisive blocker or constraint has already been removed: The system still tolerates unlinked runs because run_summary.schema.json does not require session_ref."
      ]
    },
    evidence_refs: ["ev_meta_audit_001"],
    review_state: "draft",
    confidence: 0.72,
    derived_at: "2026-04-13T17:10:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
  });

  const surface = new CaseReviewSurface({ catalogRoot: rootDir });
  const readiness = surface.inspectCase("case_review_meta_audit_001").review_readiness;

  assert.equal(readiness.approval_ready, false);
  assert.match(
    readiness.reasons.join(" ; "),
    /action_taken must contain at least one substantive intervention or evidence-capture step/,
  );
});
