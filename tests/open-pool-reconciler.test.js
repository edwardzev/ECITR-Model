const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const { reconcileOpenPools } = require("../src/runtime/open-pool-reconciler");
const { DiscoveryReconciliationPacketStore } = require("../src/runtime/discovery-reconciliation-packet-store");

test("open pool reconciler writes explicit outcomes for evidence, active cases, and active invariants", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-open-pool-"));
  const catalog = new FileBackedCatalog({ rootDir });

  catalog.writeRecord("evidence", buildEvidence("ev_used"));
  catalog.writeRecord("evidence", buildEvidence("ev_unused"));
  catalog.writeRecord("case", buildCase("case_covered", "ev_used"));
  catalog.writeRecord("case", buildCase("case_uncovered", "ev_used_2"));
  catalog.writeRecord("invariant", buildInvariant("inv_covered", ["case_covered"]));
  catalog.writeRecord("invariant", buildInvariant("inv_uncovered", []));
  catalog.writeRecord("tactic", buildTactic("tac_covered", ["inv_covered"]));

  const result = reconcileOpenPools({
    catalogRoot: rootDir,
    reconciledAt: "2099-01-01T00:00:00.000Z",
    dryRun: false,
  });

  assert.equal(result.evidence_to_case.total_records, 2);
  assert.equal(result.case_to_invariant.total_records, 2);
  assert.equal(result.invariant_to_tactic.total_records, 2);

  const store = new DiscoveryReconciliationPacketStore({ rootDir });
  assert.equal(store.getPacket("case", "evidence", "ev_used").outcome, "promoted");
  assert.equal(store.getPacket("case", "evidence", "ev_unused").outcome, "blocked");
  assert.equal(store.getPacket("invariant", "case", "case_covered").outcome, "covered");
  assert.equal(store.getPacket("invariant", "case", "case_uncovered").outcome, "blocked");
  assert.equal(store.getPacket("tactic", "invariant", "inv_covered").outcome, "covered");
  assert.equal(store.getPacket("tactic", "invariant", "inv_uncovered").outcome, "blocked");
});

function buildEvidence(evidenceId) {
  return {
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
  };
}

function buildCase(caseId, evidenceId) {
  return {
    case_id: caseId,
    case_version: 1,
    status: "active",
    review_state: "approved",
    problem_statement: `Problem for ${caseId}`,
    context: {
      constraints: ["Explicit blocker"],
      project_scope: "project",
      toolchain: [],
    },
    action_taken: "Implemented a substantive operational change with explicit verification.",
    outcome: "Outcome preserved.",
    failure_mode: "An explicit blocker remains if the verification surface is unavailable.",
    applicability: {
      when_to_apply: ["Apply when the same blocker remains under the same environment."],
      when_not_to_apply: ["Do not apply when the blocker has already been removed."],
    },
    evidence_refs: [evidenceId],
    confidence: 0.9,
    derived_at: "2099-01-01T00:00:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
    open_questions: [],
  };
}

function buildInvariant(invariantId, sourceCaseRefs) {
  return {
    id: invariantId,
    version: 1,
    layer: "invariant",
    status: "active",
    series_key: invariantId,
    title: `Invariant ${invariantId}`,
    summary: "Summary",
    statement: "Statement with stable reusable cross-case guidance.",
    source_case_refs: sourceCaseRefs,
    evidence_refs: ["ev_used"],
    why_it_is_stable: "Stable because multiple cases converge.",
    scope: ["scope"],
    non_scope: ["non-scope"],
    applicability_conditions: ["condition"],
    non_applicability_conditions: ["non-condition"],
    known_breakers: ["breaker"],
    tool_agnosticity_level: "high",
    confidence: 0.8,
    created_at: "2099-01-01T00:00:00.000Z",
    updated_at: "2099-01-01T00:00:00.000Z",
  };
}

function buildTactic(tacticId, invariantRefs) {
  return {
    id: tacticId,
    version: 1,
    layer: "tactic",
    status: "active",
    series_key: tacticId,
    title: `Tactic ${tacticId}`,
    summary: "Summary",
    action: "Action",
    source_case_refs: ["case_covered"],
    supporting_invariant_refs: invariantRefs,
    evidence_refs: ["ev_used"],
    tool_binding: ["tool"],
    tool_version_bounds: ">=0.1.0 <1.0.0",
    environment_bounds: ["env"],
    prerequisites: ["pre"],
    steps: ["Execute a substantive bounded step under the validated environment."],
    fallbacks: ["fallback"],
    rollback: ["rollback"],
    revalidate_at: "2099-02-01T00:00:00.000Z",
    confidence: 0.8,
    created_at: "2099-01-01T00:00:00.000Z",
    updated_at: "2099-01-01T00:00:00.000Z",
  };
}
