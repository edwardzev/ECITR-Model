const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const { TacticDiscoverySurface } = require("../src/tactics/discovery");
const { runTacticDiscoveryBenchmark } = require("../src/tactics/discovery-benchmark");
const { loadExample } = require("./helpers/load-example");

test("tactic discovery approves a supported tactic candidate grounded in active cases and invariants", (t) => {
  useFixedClock(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-tactic-discovery-"));

  try {
    const catalog = new FileBackedCatalog({ rootDir });
    const caseOne = buildCase({
      caseId: "case_lancedb_sync_001",
      evidenceRef: "ev_lancedb_sync_001",
      problem: "The embedded LanceDB index was rebuilt ad hoc and drifted outside the repository-owned derived path.",
      action: "Implemented an explicit lancedb:sync command with a repository-owned index path.",
      outcome: "The embedded LanceDB index now rebuilds from the canonical catalog under the repository-owned path.",
      failure: "A partial rebuild can leave the derived index basis stale.",
      applyWhen: ["A derived LanceDB index is being rebuilt from the canonical catalog"],
      doNotApply: ["No embedded LanceDB index exists"],
    });
    const caseTwo = buildCase({
      caseId: "case_lancedb_sync_002",
      evidenceRef: "ev_lancedb_sync_002",
      problem: "The embedded index retained a stale embedding signature after the tokenizer changed.",
      action: "Rebuilt LanceDB from the canonical catalog and verified the stored embedding signature and catalog basis.",
      outcome: "The derived LanceDB backend now syncs and benchmarks successfully with the current signature.",
      failure: "If the backend shape changes again, rerun sync and benchmark before trusting retrieval.",
      applyWhen: ["The embedded LanceDB backend is being changed or resynced"],
      doNotApply: ["No derived LanceDB index exists"],
    });
    const invariant = buildInvariant({
      invariantId: "inv_lancedb_subordinate_001",
      evidenceRefs: ["ev_lancedb_sync_001", "ev_lancedb_sync_002"],
      title: "Derived backends remain subordinate to canonical contracts",
      summary: "Derived semantic backends may improve retrieval but remain subordinate to canonical records.",
      statement: "A derived semantic backend may improve retrieval, but it must remain subordinate to canonical contracts and be resynced from the governed catalog.",
      whyStable: "The canonical store remains authoritative while the backend is operational support only.",
      scope: ["derived backends", "retrieval operations"],
      applicability: ["A governed canonical catalog already exists"],
      nonApplicability: ["The backend itself is canonical"],
      breakers: ["The sync path drifts from canonical contracts"],
    });

    catalog.writeRecord("case", caseOne);
    catalog.writeRecord("case", caseTwo);
    catalog.writeRecord("invariant", invariant);

    const surface = new TacticDiscoverySurface({ catalogRoot: rootDir });
    const result = surface.evaluateCandidate({
      title: "Resync the embedded LanceDB index after semantic backend changes",
      summary: "Rebuild the embedded index from the canonical catalog after backend changes.",
      action: "Run the LanceDB catalog sync, verify the embedding signature and catalog basis, and rerun the semantic benchmark after backend changes.",
      source_case_refs: [caseOne.case_id, caseTwo.case_id],
      supporting_invariant_refs: [invariant.id],
      tool_binding: ["lancedb:sync", "semantic-benchmark"],
      tool_version_bounds: ">=0.27.2 <1.0.0",
      environment_bounds: ["local ECITR workspace", "derived semantic backend"],
      prerequisites: ["Repository-owned LanceDB path is writable", "Canonical catalog exists before sync"],
      steps: [
        "Run lancedb:sync against the repository-owned derived index",
        "Verify the embedding signature and catalog basis",
        "Rerun the semantic benchmark after sync completes"
      ],
      fallbacks: ["If sync fails, preserve the canonical catalog and rebuild the derived LanceDB path"],
      rollback: ["Restore the previous derived index", "Revert the backend change before resyncing"],
      revalidate_at: "2026-07-01T00:00:00Z",
      validated_on: ["@lancedb/lancedb 0.27.2"],
      confidence: 0.84,
    });

    assert.equal(result.actual_decision, "approve");
    assert.equal(result.packet_preview.evidence_ref_count, 2);
    assert.equal(result.draft_preview.activated_status, "active");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("tactic discovery blocks a mismatched candidate even when cases and invariant exist", (t) => {
  useFixedClock(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-tactic-discovery-"));

  try {
    const catalog = new FileBackedCatalog({ rootDir });
    const lanceDbCase = buildCase({
      caseId: "case_lancedb_sync_003",
      evidenceRef: "ev_lancedb_sync_003",
      problem: "The embedded LanceDB index drifted outside the repository-owned derived path.",
      action: "Implemented an explicit lancedb:sync command with a repository-owned path.",
      outcome: "LanceDB now rebuilds from the canonical catalog under the workspace.",
      failure: "A partial rebuild can leave a stale derived index.",
      applyWhen: ["An embedded LanceDB index exists"],
      doNotApply: ["No embedded LanceDB index exists"],
    });
    const reviewCase = buildCase({
      caseId: "case_operator_review_001",
      evidenceRef: "ev_operator_review_001",
      problem: "Operator review surfaces must project from persisted artifacts rather than mutable queues.",
      action: "Projected the operator review surface from persisted draft and report artifacts.",
      outcome: "Operator review now reads from canonical persisted artifacts.",
      failure: "Ingress paths were previously treated as managed truth.",
      applyWhen: ["Persisted artifacts exist"],
      doNotApply: ["A scratch queue is intentionally canonical"],
    });
    const invariant = buildInvariant({
      invariantId: "inv_operator_surfaces_001",
      evidenceRefs: ["ev_operator_review_001"],
      title: "Operator surfaces should project from persisted artifacts",
      summary: "Operator-facing surfaces stay projections over persisted artifacts.",
      statement: "Operator-facing surfaces should project from persisted artifacts instead of inventing mutable truth.",
      whyStable: "Persisted artifacts remain authoritative.",
      scope: ["operator surfaces"],
      applicability: ["Persisted artifacts exist"],
      nonApplicability: ["The operator wants a scratch queue"],
      breakers: ["Mutable ingress paths become authority"],
    });

    catalog.writeRecord("case", lanceDbCase);
    catalog.writeRecord("case", reviewCase);
    catalog.writeRecord("invariant", invariant);

    const surface = new TacticDiscoverySurface({ catalogRoot: rootDir });
    const result = surface.evaluateCandidate({
      title: "Rebuild LanceDB and operator morning review in one tactic",
      summary: "This deliberately mixes unrelated domains.",
      action: "Rebuild LanceDB and rebuild the operator morning review surface in one procedure.",
      source_case_refs: [lanceDbCase.case_id, reviewCase.case_id],
      supporting_invariant_refs: [invariant.id],
      tool_binding: ["lancedb:sync", "morning-review"],
      tool_version_bounds: ">=1.0.0 <2.0.0",
      environment_bounds: ["mixed domains"],
      prerequisites: ["Both domains exist"],
      steps: ["Inspect both domains together and apply one combined procedure"],
      fallbacks: ["Manual review"],
      rollback: ["Undo the mixed change"],
      revalidate_at: "2026-07-01T00:00:00Z",
      validated_on: ["mixed benchmark"],
      confidence: 0.42,
    });

    assert.equal(result.actual_decision, "block");
    assert.match(result.reasons.join(" "), /not strongly supported|aligned/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("tactic discovery benchmark reports expected decisions", (t) => {
  useFixedClock(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-tactic-discovery-"));
  const manifestPath = path.join(rootDir, "benchmark.json");

  try {
    const catalog = new FileBackedCatalog({ rootDir });
    const caseOne = buildCase({
      caseId: "case_lancedb_sync_004",
      evidenceRef: "ev_lancedb_sync_004",
      problem: "The embedded LanceDB index drifted outside the repository-owned derived path.",
      action: "Implemented an explicit lancedb:sync command with a repository-owned path.",
      outcome: "LanceDB now rebuilds from the canonical catalog under the workspace.",
      failure: "A partial rebuild can leave a stale derived index.",
      applyWhen: ["An embedded LanceDB index exists"],
      doNotApply: ["No embedded LanceDB index exists"],
    });
    const caseTwo = buildCase({
      caseId: "case_lancedb_sync_005",
      evidenceRef: "ev_lancedb_sync_005",
      problem: "The embedded index retained a stale embedding signature after the backend shape changed.",
      action: "Rebuilt the derived index and verified its embedding signature and catalog basis before benchmarking.",
      outcome: "LanceDB sync and the semantic benchmark both pass against the embedded index.",
      failure: "Backend changes require rerunning sync and benchmark before trusting retrieval.",
      applyWhen: ["A LanceDB backend change is being rolled out"],
      doNotApply: ["No embedded LanceDB backend exists"],
    });
    const invariant = buildInvariant({
      invariantId: "inv_lancedb_subordinate_002",
      evidenceRefs: ["ev_lancedb_sync_004", "ev_lancedb_sync_005"],
      title: "Derived backends remain subordinate to canonical contracts",
      summary: "Derived backends stay subordinate to the canonical catalog.",
      statement: "Derived semantic backends must be resynced from the canonical catalog and may not replace it as source of truth.",
      whyStable: "Canonical contracts remain authoritative while the backend is operational support.",
      scope: ["derived backends"],
      applicability: ["A governed canonical catalog exists"],
      nonApplicability: ["The backend is canonical"],
      breakers: ["The backend becomes semantic authority"],
    });

    catalog.writeRecord("case", caseOne);
    catalog.writeRecord("case", caseTwo);
    catalog.writeRecord("invariant", invariant);

    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        benchmark_id: "tactic_discovery_test_v1",
        evaluation_at: "2026-06-30T00:00:00Z",
        entries: [
          {
            label: "approve_lancedb_sync",
            expected_decision: "approve",
            title: "Resync the embedded LanceDB index after semantic backend changes",
            summary: "Rebuild the embedded index from the canonical catalog after backend changes.",
            action: "Run the LanceDB catalog sync, verify the embedding signature and catalog basis, and rerun the semantic benchmark after backend changes.",
            source_case_refs: [caseOne.case_id, caseTwo.case_id],
            supporting_invariant_refs: [invariant.id],
            tool_binding: ["lancedb:sync", "semantic-benchmark"],
            tool_version_bounds: ">=0.27.2 <1.0.0",
            environment_bounds: ["local ECITR workspace", "derived semantic backend"],
            prerequisites: ["Repository-owned LanceDB path is writable", "Canonical catalog exists before sync"],
            steps: [
              "Run lancedb:sync against the repository-owned derived index",
              "Verify the embedding signature and catalog basis",
              "Rerun the semantic benchmark after sync completes"
            ],
            fallbacks: ["Preserve the canonical catalog and rebuild the derived index before retrying"],
            rollback: ["Restore the previous derived index", "Revert the backend change"],
            revalidate_at: "2026-07-01T00:00:00Z",
            validated_on: ["@lancedb/lancedb 0.27.2"],
            confidence: 0.84
          },
          {
            label: "block_without_invariant",
            expected_decision: "block",
            title: "Missing invariant support should block",
            summary: "A tactic candidate without active invariant support should block.",
            action: "Rebuild the embedded LanceDB index from the canonical catalog.",
            source_case_refs: [caseOne.case_id, caseTwo.case_id],
            supporting_invariant_refs: [],
            tool_binding: ["lancedb:sync"],
            tool_version_bounds: ">=0.27.2 <1.0.0",
            environment_bounds: ["local ECITR workspace"],
            prerequisites: ["Repository-owned LanceDB path is writable"],
            steps: ["Run lancedb:sync", "Verify the derived index basis"],
            fallbacks: ["Inspect logs"],
            rollback: ["Stop the helper"],
            revalidate_at: "2026-07-01T00:00:00Z",
            validated_on: ["@lancedb/lancedb 0.27.2"],
            confidence: 0.55
          }
        ]
      }, null, 2),
    );

    t.mock.timers.setTime(new Date("2026-07-02T00:00:00.000Z").getTime());
    const result = runTacticDiscoveryBenchmark({
      manifestPath,
      catalogRoot: rootDir,
    });

    assert.equal(result.matches_expected, 2);
    assert.equal(result.evaluation_at, "2026-06-30T00:00:00Z");
    assert.equal(result.false_positives, 0);
    assert.equal(result.false_negatives, 0);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("tactic discovery blocks process-only tactics even with strong case and invariant overlap", (t) => {
  useFixedClock(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-tactic-discovery-"));

  try {
    const catalog = new FileBackedCatalog({ rootDir });
    const caseOne = buildCase({
      caseId: "case_memory_gate_001",
      evidenceRef: "ev_memory_gate_001",
      problem: "Higher-order memory changes need explicit schemas and review artifacts before activation.",
      action: "Implemented schema validation, staging packets, and auditable review artifacts before activating higher-order memory changes.",
      outcome: "Higher-order memory writes now stay explicit and auditable.",
      failure: "Direct semantic writes bypass the canonical gate.",
      applyWhen: ["Higher-order memory is being introduced"],
      doNotApply: ["Only raw evidence capture is being changed"],
    });
    const caseTwo = buildCase({
      caseId: "case_memory_gate_002",
      evidenceRef: "ev_memory_gate_002",
      problem: "Review persistence and semantic backend evolution need explicit seams and audit artifacts.",
      action: "Persisted review audit entries and moved semantic retrieval behind a pluggable backend seam.",
      outcome: "Higher-order review and backend evolution now remain auditable and contract-first.",
      failure: "Missing review artifacts let higher-order changes bypass governance.",
      applyWhen: ["A higher-order retrieval or review surface is changing"],
      doNotApply: ["A temporary note is being written"],
    });
    const invariant = buildInvariant({
      invariantId: "inv_memory_gate_001",
      evidenceRefs: ["ev_memory_gate_001", "ev_memory_gate_002"],
      title: "Higher-order memory must pass explicit gates",
      summary: "Higher-order memory changes should go through schemas, staging packets, and review artifacts.",
      statement: "Higher-order memory should be introduced through explicit schemas, staging packets, and auditable review artifacts rather than direct semantic writes.",
      whyStable: "These gates preserve canonical auditability.",
      scope: ["higher-order memory", "review governance"],
      applicability: ["Canonical memory must remain auditable"],
      nonApplicability: ["The change is limited to raw evidence ingest"],
      breakers: ["Direct semantic writes bypass canonical gates"],
    });

    catalog.writeRecord("case", caseOne);
    catalog.writeRecord("case", caseTwo);
    catalog.writeRecord("invariant", invariant);

    const surface = new TacticDiscoverySurface({ catalogRoot: rootDir });
    const result = surface.evaluateCandidate({
      title: "Prepare higher-order memory work by reviewing docs and opening sessions",
      summary: "This candidate intentionally uses process scaffolding only.",
      action: "Open a memory session and review the docs before discussing higher-order memory changes.",
      source_case_refs: [caseOne.case_id, caseTwo.case_id],
      supporting_invariant_refs: [invariant.id],
      tool_binding: ["memory_service", "schema-registry"],
      tool_version_bounds: ">=1.0.0 <2.0.0",
      environment_bounds: ["canonical file-backed catalog"],
      prerequisites: ["The repo exists"],
      steps: [
        "Open a memory session for the repo",
        "Review the current docs and inspect the runtime surface",
        "Discuss possible next steps for the higher-order change"
      ],
      fallbacks: ["Write notes"],
      rollback: ["Close the session"],
      revalidate_at: "2026-07-01T00:00:00Z",
      validated_on: ["manual inspection"],
      confidence: 0.31,
    });

    assert.equal(result.actual_decision, "block");
    assert.match(result.reasons.join(" "), /substantive operational steps/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

function buildCase({ caseId, evidenceRef, problem, action, outcome, failure, applyWhen, doNotApply }) {
  const record = structuredClone(loadExample("case"));
  record.case_id = caseId;
  record.evidence_refs = [evidenceRef];
  record.problem_statement = problem;
  record.action_taken = action;
  record.outcome = outcome;
  record.failure_mode = failure;
  record.context = {
    project_scope: "project",
    constraints: [],
    toolchain: [],
  };
  record.applicability = {
    when_to_apply: applyWhen,
    when_not_to_apply: doNotApply,
  };
  return record;
}

function buildInvariant({ invariantId, evidenceRefs, title, summary, statement, whyStable, scope, applicability, nonApplicability, breakers }) {
  const record = structuredClone(loadExample("invariant"));
  record.id = invariantId;
  record.evidence_refs = evidenceRefs;
  record.title = title;
  record.summary = summary;
  record.statement = statement;
  record.why_it_is_stable = whyStable;
  record.scope = scope;
  record.applicability_conditions = applicability;
  record.non_applicability_conditions = nonApplicability;
  record.known_breakers = breakers;
  return record;
}

function useFixedClock(t) {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-05-01T00:00:00.000Z"),
  });
}
