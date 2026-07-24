const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CaseSeedStore, buildCaseSeedId } = require("../src/cases/case-seed-store");
const { createSha256 } = require("../src/evidence/file-payload-store");

test("case seed store updates changed uncompiled seeds with revision history", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-seed-store-"));
  const store = new CaseSeedStore({ rootDir });
  const runRef = "memory/runs/2026/04/run_seed_update.json";
  const firstRun = createRunRecord({ confidence: 0.62 });

  const first = store.upsertFromRun({
    runRef,
    runRecord: firstRun,
    runEvidenceRef: "ev_aops_run_run_seed_update",
    workspaceId: "agent_ops_workspace",
    sourceRunArtifactHash: createSha256(JSON.stringify(firstRun)),
    now: "2026-04-11T10:00:00.000Z",
  });

  assert.equal(first.status, "created");
  assert.equal(first.seed.revision, 1);
  assert.equal(first.seed.case_seed_id, buildCaseSeedId(runRef));

  const changedRun = createRunRecord({ confidence: 0.88 });
  const second = store.upsertFromRun({
    runRef,
    runRecord: changedRun,
    runEvidenceRef: "ev_aops_run_run_seed_update",
    workspaceId: "agent_ops_workspace",
    sourceRunArtifactHash: createSha256(JSON.stringify(changedRun)),
    now: "2026-04-11T10:05:00.000Z",
  });

  assert.equal(second.status, "updated");
  assert.equal(second.seed.revision, 2);
  assert.equal(second.seed.seed_packet.confidence, 0.88);
  assert.deepEqual(second.seed.previous_seed_packet_hashes, [first.seed.seed_packet_hash]);
});

test("case seed store detects changed compiled seeds without overwriting semantics", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-seed-store-"));
  const store = new CaseSeedStore({ rootDir });
  const runRef = "memory/runs/2026/04/run_seed_compiled.json";
  const firstRun = createRunRecord({ confidence: 0.7 });

  const first = store.upsertFromRun({
    runRef,
    runRecord: firstRun,
    runEvidenceRef: "ev_aops_run_run_seed_compiled",
    workspaceId: "agent_ops_workspace",
    sourceRunArtifactHash: createSha256(JSON.stringify(firstRun)),
    now: "2026-04-11T10:00:00.000Z",
  });
  store.markCompiled(first.seed.case_seed_id, { now: "2026-04-11T10:01:00.000Z" });

  const changedRun = createRunRecord({ confidence: 0.91 });
  const conflict = store.upsertFromRun({
    runRef,
    runRecord: changedRun,
    runEvidenceRef: "ev_aops_run_run_seed_compiled",
    workspaceId: "agent_ops_workspace",
    sourceRunArtifactHash: createSha256(JSON.stringify(changedRun)),
    now: "2026-04-11T10:05:00.000Z",
  });
  const stored = store.getSeed(first.seed.case_seed_id);

  assert.equal(conflict.status, "compiled_conflict");
  assert.equal(stored.status, "compiled");
  assert.equal(stored.revision, 1);
  assert.equal(stored.seed_packet.confidence, 0.7);
});

function createRunRecord({ confidence }) {
  return {
    id: "run_seed_update",
    project_id: "agent_ops",
    session_ref: "memory/sessions/2026/04/session_seed_update.json",
    thread_ref: "codex-thread://thread-seed-update",
    ecitr_closeout: {
      decision: "candidate",
      seed: {
        future_decision: "Decide whether an uncompiled seed should be refreshed.",
        activate_when: "The same run_ref imports with changed seed semantics before compilation.",
        do_not_apply_when: "The seed has already compiled into a draft case.",
        plan_effect: "Update the staging seed and increment revision.",
        problem: "Uncompiled seed changes need deterministic idempotent handling.",
        constraints: "Identity remains run_ref-based.",
        action_taken: "Re-imported the run-backed closeout seed.",
        outcome: "The staging seed revision changed without duplication.",
        failure_mode: "Duplicated seeds would fork review state.",
        confidence,
      },
    },
    created_at: "2026-04-11T10:00:00.000Z",
  };
}
