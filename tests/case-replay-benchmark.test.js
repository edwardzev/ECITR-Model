const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { runCaseReplayBenchmark } = require("../src/cases/case-replay-benchmark");
const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");

test("case replay benchmark reconstructs original draft state from compilation packets", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-replay-"));
  const catalog = new FileBackedCatalog({ rootDir });
  const payloadDir = path.join(rootDir, "payloads", "evidence", "tests");
  const stagingDir = path.join(rootDir, "staging", "case-compilation-packets");
  fs.mkdirSync(payloadDir, { recursive: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  fs.writeFileSync(
    path.join(payloadDir, "ev_replay_001.json"),
    `${JSON.stringify({
      objective: "Repair the active export path.",
      steps_completed: [
        "Patched the exporter to write the canonical file",
        "Verified the canonical output path",
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
    evidence_id: "ev_replay_001",
    substrate_ref: "file:///tmp/replay.json",
    source_type: "file",
    source_locator: "/tmp/replay.json",
    captured_at: "2026-04-11T14:00:00.000Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: "payloads/evidence/tests/ev_replay_001.json",
    payload_hash: "sha256:test",
    source_hash: "sha256:test",
    redaction_state: "none",
    immutable: true,
  });

  const mutatedCurrentCase = {
    case_id: "case_replay_001",
    case_version: 2,
    status: "active",
    problem_statement: "Repair the active export path.",
    context: {
      constraints: [
        "The old snapshot was still being served.",
      ],
      project_scope: "project",
      toolchain: [],
    },
    action_taken: "Patched the exporter to write the canonical file.",
    outcome: "The canonical file became current again.",
    failure_mode: "The old snapshot was still being served.",
    applicability: {
      when_to_apply: [
        "When the exporter writes to the wrong canonical path.",
      ],
      when_not_to_apply: [
        "When the active output path is already current.",
      ],
    },
    evidence_refs: ["ev_replay_001"],
    review_state: "approved",
    confidence: 0.8,
    derived_at: "2026-04-11T14:30:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
    open_questions: [],
  };
  catalog.writeRecord("case", mutatedCurrentCase);

  fs.writeFileSync(
    path.join(stagingDir, "ccp_replay_001.json"),
    `${JSON.stringify({
      compilation_id: "ccp_replay_001",
      proposed_case_id: "case_replay_001",
      evidence_refs: ["ev_replay_001"],
      problem_statement: "Repair the active export path.",
      context: {
        constraints: ["The old snapshot was still being served."],
        project_scope: "project",
        toolchain: [],
      },
      action_taken: "Patched the exporter to write the canonical file.",
      outcome: "The canonical file became current again.",
      failure_mode: "The old snapshot was still being served.",
      confidence: 0.8,
      derived_at: "2026-04-11T14:05:00.000Z",
      derivation_rule_id: "case-autodistill-run-v1",
      open_questions: [
        "Confirm applicability.when_to_apply before approval.",
        "Confirm applicability.when_not_to_apply before approval.",
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  const manifestPath = path.join(rootDir, "case-replay-benchmark.json");
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({
      benchmark_id: "case_replay_test",
      entries: [
        {
          case_id: "case_replay_001",
          expected_bucket: "viable",
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  const result = runCaseReplayBenchmark({
    manifestPath,
    catalogRoot: rootDir,
  });

  assert.equal(result.total_entries, 1);
  assert.equal(result.bucket_summary.viable.total, 1);
  assert.equal(result.results[0].replayed, true);
  assert.equal(result.results[0].actual_decision, "approve");
  assert.equal(result.results[0].completion_preview.when_to_apply.length > 0, true);
});

test("case replay benchmark reports a blocked replay when no compilation packet exists", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-replay-"));
  const manifestPath = path.join(rootDir, "case-replay-benchmark.json");
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({
      benchmark_id: "case_replay_missing_packet",
      entries: [
        {
          case_id: "case_missing_packet",
          expected_bucket: "non_qualifying",
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  const result = runCaseReplayBenchmark({
    manifestPath,
    catalogRoot: rootDir,
  });

  assert.equal(result.bucket_summary.non_qualifying.total, 1);
  assert.equal(result.results[0].actual_decision, "block");
  assert.equal(result.results[0].replayed, false);
  assert.match(result.results[0].reasons[0], /missing compilation packet/i);
});
