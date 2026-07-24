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
      caseId: "case_qdrant_runtime_001",
      evidenceRef: "ev_qdrant_runtime_001",
      problem: "Local Qdrant was started ad hoc and runtime state drifted outside the managed workspace layout.",
      action: "Implemented a managed qdrant-local helper with install, start, stop, status, and explicit runtime paths.",
      outcome: "Local Qdrant now runs through the managed helper and stays under the repo-owned runtime layout.",
      failure: "Parallel start and status checks can produce a false negative during startup.",
      applyWhen: ["A local derived Qdrant backend is being operated under the repo-managed runtime"],
      doNotApply: ["The backend is not Qdrant or not local"],
    });
    const caseTwo = buildCase({
      caseId: "case_qdrant_runtime_002",
      evidenceRef: "ev_qdrant_runtime_002",
      problem: "Live Qdrant sync initially failed because the prototype used invalid point ids and non-idempotent collection setup.",
      action: "Patched the Qdrant backend to use deterministic UUID point ids, idempotent collection creation, and reran sync plus benchmark successfully.",
      outcome: "The derived Qdrant backend now syncs and benchmarks successfully against a live local process.",
      failure: "If the backend shape changes again, rerun sync and benchmark before trusting retrieval.",
      applyWhen: ["A live local Qdrant-derived backend is being changed or resynced"],
      doNotApply: ["No live Qdrant process exists"],
    });
    const invariant = buildInvariant({
      invariantId: "inv_qdrant_subordinate_001",
      evidenceRefs: ["ev_qdrant_runtime_001", "ev_qdrant_runtime_002"],
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
      title: "Operate local Qdrant through the managed runtime and resync after backend changes",
      summary: "Use the managed local runtime helper and resync the derived collection after backend changes.",
      action: "Run local Qdrant through the managed runtime helper, verify healthy status serially, resync the derived collection, and rerun the semantic benchmark after backend changes.",
      source_case_refs: [caseOne.case_id, caseTwo.case_id],
      supporting_invariant_refs: [invariant.id],
      tool_binding: ["qdrant-local", "sync-qdrant", "semantic-benchmark"],
      tool_version_bounds: ">=1.17.1 <2.0.0",
      environment_bounds: ["local ECITR workspace", "derived semantic backend"],
      prerequisites: ["Managed Qdrant binary is installed", "Canonical catalog exists before sync"],
      steps: [
        "Start Qdrant through the managed local runtime helper",
        "Wait for a healthy serial status check",
        "Run sync-qdrant against the derived collection",
        "Rerun the semantic benchmark after sync completes"
      ],
      fallbacks: ["If the managed helper fails, inspect logs and restart through the same helper"],
      rollback: ["Stop the managed runtime", "Revert the backend change before resyncing"],
      revalidate_at: "2026-07-01T00:00:00Z",
      validated_on: ["qdrant-local 1.17.1"],
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
    const qdrantCase = buildCase({
      caseId: "case_qdrant_runtime_003",
      evidenceRef: "ev_qdrant_runtime_003",
      problem: "Local Qdrant runtime drifted outside the repo-managed layout.",
      action: "Implemented a managed qdrant-local helper with explicit runtime paths.",
      outcome: "Local Qdrant is now managed under the workspace.",
      failure: "Status checks can race during startup.",
      applyWhen: ["A local Qdrant runtime exists"],
      doNotApply: ["No local Qdrant runtime exists"],
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

    catalog.writeRecord("case", qdrantCase);
    catalog.writeRecord("case", reviewCase);
    catalog.writeRecord("invariant", invariant);

    const surface = new TacticDiscoverySurface({ catalogRoot: rootDir });
    const result = surface.evaluateCandidate({
      title: "Run Qdrant locally and rebuild operator morning review in one tactic",
      summary: "This deliberately mixes unrelated domains.",
      action: "Start Qdrant locally and rebuild the operator morning review surface in one procedure.",
      source_case_refs: [qdrantCase.case_id, reviewCase.case_id],
      supporting_invariant_refs: [invariant.id],
      tool_binding: ["qdrant-local", "morning-review"],
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
      caseId: "case_qdrant_runtime_004",
      evidenceRef: "ev_qdrant_runtime_004",
      problem: "Local Qdrant runtime drifted outside the repo-managed layout.",
      action: "Implemented a managed qdrant-local helper with explicit runtime paths.",
      outcome: "Local Qdrant now runs through the managed helper.",
      failure: "Status checks can race during startup.",
      applyWhen: ["A local Qdrant runtime exists"],
      doNotApply: ["No local Qdrant runtime exists"],
    });
    const caseTwo = buildCase({
      caseId: "case_qdrant_runtime_005",
      evidenceRef: "ev_qdrant_runtime_005",
      problem: "Live Qdrant sync failed because point ids and collection setup were not valid for the real backend.",
      action: "Patched deterministic UUID point ids, idempotent ensureCollection behavior, and reran sync plus benchmark.",
      outcome: "Live sync and semantic benchmark both pass against the local Qdrant process.",
      failure: "Backend changes require rerunning sync and benchmark before trusting retrieval.",
      applyWhen: ["A Qdrant backend change is being rolled out"],
      doNotApply: ["No Qdrant backend exists"],
    });
    const invariant = buildInvariant({
      invariantId: "inv_qdrant_subordinate_002",
      evidenceRefs: ["ev_qdrant_runtime_004", "ev_qdrant_runtime_005"],
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
            label: "approve_qdrant_runtime",
            expected_decision: "approve",
            title: "Operate local Qdrant through the managed runtime and resync after backend changes",
            summary: "Use the managed runtime helper and rerun sync after backend changes.",
            action: "Run local Qdrant through the managed runtime helper, verify healthy status serially, resync the derived collection, and rerun the semantic benchmark after backend changes.",
            source_case_refs: [caseOne.case_id, caseTwo.case_id],
            supporting_invariant_refs: [invariant.id],
            tool_binding: ["qdrant-local", "sync-qdrant", "semantic-benchmark"],
            tool_version_bounds: ">=1.17.1 <2.0.0",
            environment_bounds: ["local ECITR workspace", "derived semantic backend"],
            prerequisites: ["Managed Qdrant binary is installed", "Canonical catalog exists before sync"],
            steps: [
              "Start Qdrant through the managed local runtime helper",
              "Wait for a healthy serial status check",
              "Run sync-qdrant against the derived collection",
              "Rerun the semantic benchmark after sync completes"
            ],
            fallbacks: ["Inspect managed runtime logs before retrying"],
            rollback: ["Stop Qdrant", "Revert the backend change"],
            revalidate_at: "2026-07-01T00:00:00Z",
            validated_on: ["qdrant-local 1.17.1"],
            confidence: 0.84
          },
          {
            label: "block_without_invariant",
            expected_decision: "block",
            title: "Missing invariant support should block",
            summary: "A tactic candidate without active invariant support should block.",
            action: "Run local Qdrant through the managed helper and resync it.",
            source_case_refs: [caseOne.case_id, caseTwo.case_id],
            supporting_invariant_refs: [],
            tool_binding: ["qdrant-local"],
            tool_version_bounds: ">=1.17.1 <2.0.0",
            environment_bounds: ["local ECITR workspace"],
            prerequisites: ["Managed Qdrant binary is installed"],
            steps: ["Start the helper", "Run sync-qdrant"],
            fallbacks: ["Inspect logs"],
            rollback: ["Stop the helper"],
            revalidate_at: "2026-07-01T00:00:00Z",
            validated_on: ["qdrant-local 1.17.1"],
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
