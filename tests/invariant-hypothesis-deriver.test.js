const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { runInvariantDiscoveryBenchmark } = require("../src/invariants/discovery-benchmark");
const { InvariantHypothesisDeriver } = require("../src/invariants/hypothesis-deriver");
const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const { loadExample } = require("./helpers/load-example");

test("invariant hypothesis deriver emits benchmark-compatible candidates from uncovered active cases", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-invariant-hypothesis-"));

  try {
    const catalog = new FileBackedCatalog({ rootDir });
    const caseOne = buildCase({
      caseId: "case_memory_surface_001",
      evidenceRef: "ev_memory_surface_001",
      problem: "Morning review projected from raw inbox files instead of canonical persisted artifacts.",
      action: "Project morning review from persisted artifacts and canonical draft refs.",
      outcome: "Morning review now projects from canonical persisted artifacts only.",
      failure: "Do not let scratch queues displace canonical artifacts.",
      applyWhen: ["Project morning review from persisted artifacts and canonical draft refs."],
      doNotApply: ["Do not let scratch queues displace canonical artifacts."],
    });
    const caseTwo = buildCase({
      caseId: "case_memory_surface_002",
      evidenceRef: "ev_memory_surface_002",
      problem: "Operator-facing memory review used a parallel queue instead of canonical persisted artifacts.",
      action: "Project morning review from persisted artifacts and canonical draft refs.",
      outcome: "Operator-facing memory review now stays thin because it reads canonical artifacts only.",
      failure: "Do not let scratch queues displace canonical artifacts.",
      applyWhen: ["Project morning review from persisted artifacts and canonical draft refs."],
      doNotApply: ["Do not let scratch queues displace canonical artifacts."],
    });
    const unrelated = buildCase({
      caseId: "case_bc_ocr_001",
      evidenceRef: "ev_bc_ocr_001",
      problem: "Incoming OCR documents should auto-queue and auto-poll in Business Central.",
      action: "Built the OCR background automation flow with explicit permission setup and queue polling.",
      outcome: "OCR processing now runs in the intended automation lane.",
      failure: "Permission errors blocked the queue execution path.",
      applyWhen: ["Business Central OCR automation is being implemented"],
      doNotApply: ["The system does not use Business Central OCR"],
    });
    catalog.writeRecord("case", caseOne);
    catalog.writeRecord("case", caseTwo);
    catalog.writeRecord("case", unrelated);

    const deriver = new InvariantHypothesisDeriver({ catalogRoot: rootDir });
    const manifest = deriver.deriveManifest({
      maxCandidates: 10,
      maxCandidatesPerCase: 2,
      maxRareTokenDocumentFrequency: 2,
      minSharedClauses: 1,
      minSharedRareTokens: 4,
      minRareTokenScore: 2.5,
      generatedAt: "2026-04-14T09:00:00.000Z",
    });

    assert.equal(manifest.total_active_cases, 3);
    assert.equal(manifest.total_source_cases, 3);
    assert.ok(manifest.entries.length >= 1);

    const candidate = manifest.entries[0];
    assert.deepEqual(candidate.source_case_refs, [caseOne.case_id, caseTwo.case_id]);
    assert.equal(candidate.expected_decision, "approve");
    assert.ok(candidate.derivation_metadata.shared_clauses.length >= 1);
    assert.ok(candidate.derivation_metadata.shared_rare_tokens.length >= 4);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("invariant hypothesis deriver excludes cases already covered by active invariants by default", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-invariant-hypothesis-"));

  try {
    const catalog = new FileBackedCatalog({ rootDir });
    const coveredOne = buildCase({
      caseId: "case_covered_memory_001",
      evidenceRef: "ev_covered_memory_001",
      problem: "Morning review used raw inbox files instead of canonical persisted artifacts.",
      action: "Project morning review from persisted artifacts and canonical draft refs.",
      outcome: "Morning review now reads canonical persisted artifacts only.",
      failure: "Do not let scratch queues displace canonical artifacts.",
      applyWhen: ["Project morning review from persisted artifacts and canonical draft refs."],
      doNotApply: ["Do not let scratch queues displace canonical artifacts."],
    });
    const coveredTwo = buildCase({
      caseId: "case_covered_memory_002",
      evidenceRef: "ev_covered_memory_002",
      problem: "Operator review used a mutable queue instead of canonical persisted artifacts.",
      action: "Project morning review from persisted artifacts and canonical draft refs.",
      outcome: "Operator review now reads canonical artifacts only.",
      failure: "Do not let scratch queues displace canonical artifacts.",
      applyWhen: ["Project morning review from persisted artifacts and canonical draft refs."],
      doNotApply: ["Do not let scratch queues displace canonical artifacts."],
    });
    const uncoveredOne = buildCase({
      caseId: "case_uncovered_inventory_001",
      evidenceRef: "ev_uncovered_inventory_001",
      problem: "Supplier inventory mapping collapsed color-level truth across headwear SKUs.",
      action: "Preserve color-level supplier truth and keep manual image mapping explicit.",
      outcome: "Headwear import now preserves color-level source truth without guessing.",
      failure: "Do not collapse supplier color truth across headwear SKUs.",
      applyWhen: ["Preserve color-level supplier truth and keep manual image mapping explicit."],
      doNotApply: ["Do not collapse supplier color truth across headwear SKUs."],
    });
    const uncoveredTwo = buildCase({
      caseId: "case_uncovered_inventory_002",
      evidenceRef: "ev_uncovered_inventory_002",
      problem: "Approved manual headwear image mapping must preserve supplier color truth for blocked SKUs.",
      action: "Preserve color-level supplier truth and keep manual image mapping explicit.",
      outcome: "Manual mapping now preserves explicit color truth at SKU level.",
      failure: "Do not collapse supplier color truth across headwear SKUs.",
      applyWhen: ["Preserve color-level supplier truth and keep manual image mapping explicit."],
      doNotApply: ["Do not collapse supplier color truth across headwear SKUs."],
    });

    catalog.writeRecord("case", coveredOne);
    catalog.writeRecord("case", coveredTwo);
    catalog.writeRecord("case", uncoveredOne);
    catalog.writeRecord("case", uncoveredTwo);
    catalog.writeRecord("invariant", buildInvariant({
      invariantId: "inv_covered_memory_surface",
      caseRefs: [coveredOne.case_id, coveredTwo.case_id],
      evidenceRefs: [coveredOne.evidence_refs[0], coveredTwo.evidence_refs[0]],
    }));

    const deriver = new InvariantHypothesisDeriver({ catalogRoot: rootDir });
    const manifest = deriver.deriveManifest({
      maxCandidates: 10,
      maxCandidatesPerCase: 2,
      maxRareTokenDocumentFrequency: 2,
      minSharedClauses: 1,
      minSharedRareTokens: 3,
      minRareTokenScore: 1.5,
      generatedAt: "2026-04-14T09:05:00.000Z",
    });

    assert.equal(manifest.source_pool, "uncovered_active_cases");
    assert.equal(manifest.total_active_cases, 4);
    assert.equal(manifest.total_source_cases, 2);
    assert.ok(manifest.entries.every((entry) => entry.source_case_refs.every((caseId) => caseId.startsWith("case_uncovered_"))));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("derived manifest round-trips through the invariant benchmark runner", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-invariant-hypothesis-"));
  const manifestPath = path.join(rootDir, "derived.json");

  try {
    const catalog = new FileBackedCatalog({ rootDir });
    const caseOne = buildCase({
      caseId: "case_scope_001",
      evidenceRef: "ev_scope_001",
      problem: "Retrieval planner leaked cross-project candidates because scope filtering happened after ranking.",
      action: "Apply scope filtering before ranking so unauthorized candidates never enter the scoring window.",
      outcome: "Scope-safe retrieval became explainable and stable.",
      failure: "Late scope filtering lets unauthorized candidates shape ranking.",
      applyWhen: ["Apply scope filtering before ranking so unauthorized candidates never enter the scoring window."],
      doNotApply: ["Late scope filtering lets unauthorized candidates shape ranking."],
    });
    const caseTwo = buildCase({
      caseId: "case_scope_002",
      evidenceRef: "ev_scope_002",
      problem: "Authority boundaries were ignored until after retrieval scoring and candidate fusion.",
      action: "Apply scope filtering before ranking so unauthorized candidates never enter the scoring window.",
      outcome: "Authority-safe retrieval stopped unauthorized candidates before ranking and fusion.",
      failure: "Late scope filtering lets unauthorized candidates shape ranking.",
      applyWhen: ["Apply scope filtering before ranking so unauthorized candidates never enter the scoring window."],
      doNotApply: ["Late scope filtering lets unauthorized candidates shape ranking."],
    });
    catalog.writeRecord("case", caseOne);
    catalog.writeRecord("case", caseTwo);

    const deriver = new InvariantHypothesisDeriver({ catalogRoot: rootDir });
    const manifest = deriver.deriveManifest({
      includeCoveredCases: true,
      maxCandidates: 10,
      maxCandidatesPerCase: 2,
      maxRareTokenDocumentFrequency: 2,
      minSharedClauses: 1,
      minSharedRareTokens: 4,
      minRareTokenScore: 2,
      generatedAt: "2026-04-14T09:10:00.000Z",
    });
    deriver.writeManifest({
      manifest,
      outputPath: manifestPath,
    });

    const benchmark = runInvariantDiscoveryBenchmark({
      manifestPath,
      catalogRoot: rootDir,
    });

    assert.equal(benchmark.total_entries, manifest.entries.length);
    assert.equal(benchmark.mismatches_expected, 0);
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

function buildInvariant({ invariantId, caseRefs, evidenceRefs }) {
  const record = structuredClone(loadExample("invariant"));
  record.id = invariantId;
  record.status = "active";
  record.version = 1;
  record.title = "Covered memory surface invariant";
  record.summary = "Covered cases should not be re-derived by default.";
  record.statement = "Covered cases already belong to an active invariant.";
  record.source_case_refs = caseRefs;
  record.evidence_refs = evidenceRefs;
  record.why_it_is_stable = "The covered case set already has canonical invariant support.";
  record.scope = ["memory", "coverage"];
  record.non_scope = [];
  record.applicability_conditions = ["Cases are already covered by an active invariant"];
  record.non_applicability_conditions = ["No active invariant covers the cases"];
  record.known_breakers = ["Coverage map is stale"];
  record.tool_agnosticity_level = "high";
  record.confidence = 0.9;
  record.created_at = "2026-04-14T00:00:00.000Z";
  record.updated_at = "2026-04-14T00:00:00.000Z";
  return record;
}
