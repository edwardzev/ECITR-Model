const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const { runCaseReviewBenchmark } = require("../src/cases/case-review-benchmark");

test("case review benchmark reports false positives and false negatives against expectations", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-benchmark-"));
  const catalog = new FileBackedCatalog({ rootDir });
  const payloadDir = path.join(rootDir, "payloads", "evidence", "tests");
  fs.mkdirSync(payloadDir, { recursive: true });

  fs.writeFileSync(
    path.join(payloadDir, "ev_benchmark_001.json"),
    `${JSON.stringify({
      objective: "Repair the canonical export path.",
      steps_completed: [
        "Patched the exporter to write the canonical file",
      ],
      findings: [
        "The old snapshot was stale.",
      ],
      blockers: [
        "The old snapshot was still being served.",
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  catalog.writeRecord("evidence", {
    evidence_id: "ev_benchmark_001",
    substrate_ref: "file:///tmp/benchmark.json",
    source_type: "file",
    source_locator: "/tmp/benchmark.json",
    captured_at: "2026-04-11T14:00:00.000Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: "payloads/evidence/tests/ev_benchmark_001.json",
    payload_hash: "sha256:test",
    source_hash: "sha256:test",
    redaction_state: "none",
    immutable: true,
  });

  catalog.writeRecord("case", {
    case_id: "case_benchmark_pass",
    case_version: 1,
    status: "active",
    problem_statement: "Repair the canonical export path.",
    context: {
      constraints: ["The old snapshot was still being served."],
      project_scope: "project",
      toolchain: [],
    },
    action_taken: "Patched the exporter to write the canonical file.",
    outcome: "The canonical file became current again.",
    failure_mode: "The old snapshot was still being served.",
    applicability: {
      when_to_apply: ["When the operator needs to repeat the same export repair workflow in the same subsystem."],
      when_not_to_apply: ["Do not apply this case when the current workflow targets a different subsystem or output path."],
    },
    evidence_refs: ["ev_benchmark_001"],
    review_state: "approved",
    confidence: 0.8,
    derived_at: "2026-04-11T12:10:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
  });

  catalog.writeRecord("case", {
    case_id: "case_benchmark_fail",
    case_version: 1,
    status: "draft",
    problem_statement: "Record provider email draft state.",
    context: {
      constraints: ["Provider reply pending."],
      project_scope: "project",
      toolchain: [],
    },
    action_taken: "Created a Gmail draft for the provider confirmation request.",
    outcome: "The provider-contact step now exists as a draft ready to send.",
    failure_mode: "Provider reply pending.",
    applicability: {
      when_to_apply: ["When the operator needs to execute the same kind of intervention captured here: Created a Gmail draft for the provider confirmation request."],
      when_not_to_apply: ["Do not apply this case once the decisive blocker or constraint has already been removed: Provider reply pending."],
    },
    evidence_refs: ["ev_benchmark_001"],
    review_state: "draft",
    confidence: 0.8,
    derived_at: "2026-04-11T12:20:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
  });

  catalog.writeRecord("case", {
    case_id: "case_benchmark_draft",
    case_version: 1,
    status: "draft",
    problem_statement: "Repair the canonical export path.",
    context: {
      constraints: ["The old snapshot was still being served."],
      project_scope: "project",
      toolchain: [],
    },
    action_taken: "1. Opened project memory for the repo.\n2. Patched the exporter to write the canonical file.",
    outcome: "The canonical file became current again.",
    failure_mode: "The old snapshot was still being served.",
    evidence_refs: ["ev_benchmark_001"],
    review_state: "draft",
    confidence: 0.8,
    derived_at: "2026-04-11T12:30:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
    open_questions: ["Confirm applicability."],
  });

  const manifestPath = path.join(rootDir, "case-review-benchmark.json");
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({
      benchmark_id: "case_review_benchmark_test",
      entries: [
        {
          case_id: "case_benchmark_pass",
          mode: "readiness",
          expected_decision: "approve",
        },
        {
          case_id: "case_benchmark_fail",
          mode: "readiness",
          expected_decision: "block",
        },
        {
          case_id: "case_benchmark_draft",
          mode: "draft_flow",
          expected_decision: "approve",
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  const result = runCaseReviewBenchmark({
    manifestPath,
    catalogRoot: rootDir,
  });

  assert.equal(result.total_entries, 3);
  assert.equal(result.matches_expected, 3);
  assert.equal(result.mismatches_expected, 0);
  assert.equal(result.false_positives, 0);
  assert.equal(result.false_negatives, 0);
  assert.equal(result.results.find((entry) => entry.case_id === "case_benchmark_fail").mismatch_type, null);
  assert.equal(result.results.find((entry) => entry.case_id === "case_benchmark_draft").completion_preview.next_case_version, 2);
});
