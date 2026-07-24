const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const { migrateWorkspaceIdentityBySource } = require("../src/workspace/selective-migration");

test("selective workspace migration updates only MSBC-linked records", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-selective-migration-"));
  const catalog = new FileBackedCatalog({ rootDir });
  const payloadDir = path.join(rootDir, "payloads", "evidence", "tests");
  fs.mkdirSync(payloadDir, { recursive: true });

  fs.writeFileSync(path.join(payloadDir, "ev_msbc_run.json"), `${JSON.stringify({
    id: "run_msbc",
    project_id: "ms_business_central",
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(payloadDir, "ev_other_run.json"), `${JSON.stringify({
    id: "run_other",
    project_id: "other_project",
  }, null, 2)}\n`);

  catalog.writeRecord("evidence", {
    evidence_id: "ev_msbc",
    workspace_id: "ecitr_model",
    substrate_ref: "file:///tmp/ev_msbc_run.json",
    source_type: "file",
    source_locator: "/tmp/ev_msbc_run.json",
    captured_at: "2026-04-11T10:00:00.000Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: "payloads/evidence/tests/ev_msbc_run.json",
    payload_hash: "sha256:test",
    source_hash: "sha256:test",
    redaction_state: "none",
    immutable: true,
  });
  catalog.writeRecord("evidence", {
    evidence_id: "ev_other",
    workspace_id: "ecitr_model",
    substrate_ref: "file:///tmp/ev_other_run.json",
    source_type: "file",
    source_locator: "/tmp/ev_other_run.json",
    captured_at: "2026-04-11T10:01:00.000Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: "payloads/evidence/tests/ev_other_run.json",
    payload_hash: "sha256:test",
    source_hash: "sha256:test",
    redaction_state: "none",
    immutable: true,
  });
  catalog.writeRecord("case", {
    case_id: "case_msbc",
    case_version: 1,
    status: "draft",
    problem_statement: "MSBC case",
    action_taken: "Updated report layout activation.",
    outcome: "Outcome",
    failure_mode: "Manual layout selection still required.",
    evidence_refs: ["ev_msbc"],
    review_state: "draft",
    confidence: 0.7,
    derived_at: "2026-04-11T10:02:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
    open_questions: ["Confirm applicability."],
    applicability: {
      when_to_apply: ["Use for MSBC."],
      when_not_to_apply: ["Do not use elsewhere."],
    },
    workspace_id: "ecitr_model",
  });
  catalog.writeRecord("case", {
    case_id: "case_other",
    case_version: 1,
    status: "draft",
    problem_statement: "Other case",
    action_taken: "Updated another repo.",
    outcome: "Outcome",
    failure_mode: "Other blocker.",
    evidence_refs: ["ev_other"],
    review_state: "draft",
    confidence: 0.7,
    derived_at: "2026-04-11T10:03:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
    open_questions: ["Confirm applicability."],
    applicability: {
      when_to_apply: ["Use for other workspace."],
      when_not_to_apply: ["Do not use for MSBC."],
    },
    workspace_id: "ecitr_model",
  });

  const summary = migrateWorkspaceIdentityBySource({
    catalogRoot: rootDir,
    targetWorkspaceId: "ms_business_central",
    agentOpsProjectIds: ["ms_business_central"],
    codexWorkspaceRoots: [],
    dryRun: false,
  });

  assert.equal(summary.updated_record_counts.evidence, 1);
  assert.equal(summary.updated_record_counts.cases, 1);
  assert.equal(catalog.getRecord("evidence", "ev_msbc").workspace_id, "ecitr_model");
  const correction = catalog.getRecord(
    "evidence",
    "ev_msbc_workspace_ms_business_central",
  );
  assert.equal(correction.workspace_id, "ms_business_central");
  assert.equal(correction.correction_of, "ev_msbc");
  assert.equal(catalog.getRecord("case", "case_msbc").workspace_id, "ms_business_central");
  assert.equal(catalog.getRecord("evidence", "ev_other").workspace_id, "ecitr_model");
  assert.equal(catalog.getRecord("case", "case_other").workspace_id, "ecitr_model");

  const second = migrateWorkspaceIdentityBySource({
    catalogRoot: rootDir,
    targetWorkspaceId: "ms_business_central",
    agentOpsProjectIds: ["ms_business_central"],
    codexWorkspaceRoots: [],
    dryRun: false,
  });
  assert.equal(second.updated_record_counts.evidence, 0);
  assert.equal(second.updated_record_counts.cases, 0);
});
