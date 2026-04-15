const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const { InvariantDiscoverySurface } = require("../src/invariants/discovery");
const { runInvariantDiscoveryBenchmark } = require("../src/invariants/discovery-benchmark");
const { loadExample } = require("./helpers/load-example");

test("invariant discovery approves a supported multi-case candidate and unions evidence refs", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-invariant-discovery-"));

  try {
    const catalog = new FileBackedCatalog({ rootDir });
    const caseOne = buildCase({
      caseId: "case_scope_filter_001",
      evidenceRef: "ev_scope_filter_001",
      problem: "Retrieval leaked cross-project candidates because scope filtering happened after ranking.",
      action: "Move scope filtering into the planner before ranking and reject out-of-scope candidates early.",
      outcome: "Cross-project leakage stopped and ranking stayed explainable under explicit scope constraints.",
      failure: "Late filtering let unauthorized candidates influence ranking.",
      applyWhen: ["Multiple project scopes share vocabulary"],
      doNotApply: ["Search is intentionally global"],
    });
    const caseTwo = buildCase({
      caseId: "case_scope_filter_002",
      evidenceRef: "ev_scope_filter_002",
      problem: "Metadata filtering happened after retrieval scoring and let unrelated project candidates shape the result set.",
      action: "Apply authority scope filters before rank and fusion so unrelated candidates never enter the scoring window.",
      outcome: "Scope-safe retrieval removed unauthorized candidates before ranking and improved explainability.",
      failure: "Authority boundaries applied too late.",
      applyWhen: ["Candidate pools span multiple projects"],
      doNotApply: ["No scope boundaries exist"],
    });
    catalog.writeRecord("case", caseOne);
    catalog.writeRecord("case", caseTwo);

    const surface = new InvariantDiscoverySurface({ catalogRoot: rootDir });
    const result = surface.evaluateCandidate({
      promotion_basis: "multi_case",
      title: "Scope boundaries must be enforced before ranking",
      summary: "Authority scope should prune candidates before ranking.",
      statement: "When records carry scope or authority boundaries, those boundaries must be enforced before ranking so unauthorized candidates cannot influence the result set.",
      source_case_refs: [caseOne.case_id, caseTwo.case_id],
      why_it_is_stable: "Authority boundaries survive backend changes because they are governance constraints rather than a ranking trick.",
      scope: ["retrieval planning", "authority preservation"],
      non_scope: ["intentionally global search"],
      applicability_conditions: ["Multiple project scopes can appear in one candidate pool"],
      non_applicability_conditions: ["The caller explicitly requested global search"],
      known_breakers: ["Missing scope metadata"],
      tool_agnosticity_level: "high",
      confidence: 0.86,
    });

    assert.equal(result.actual_decision, "approve");
    assert.equal(result.packet_preview.evidence_ref_count, 2);
    assert.equal(result.draft_preview.activated_status, "active");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("invariant discovery blocks mismatched supporting cases", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-invariant-discovery-"));

  try {
    const catalog = new FileBackedCatalog({ rootDir });
    const retrievalCase = buildCase({
      caseId: "case_scope_filter_003",
      evidenceRef: "ev_scope_filter_003",
      problem: "Retrieval leaked cross-project candidates because scope filtering happened after ranking.",
      action: "Move scope filtering into the planner before ranking.",
      outcome: "Scope-safe retrieval became explainable.",
      failure: "Late scope filtering let unauthorized candidates influence ranking.",
      applyWhen: ["Multiple project scopes share vocabulary"],
      doNotApply: ["Search is intentionally global"],
    });
    const variantCase = buildCase({
      caseId: "case_variant_truth_001",
      evidenceRef: "ev_variant_truth_001",
      problem: "Variant inventory was collapsed across colors and the frontend lied about SKU-level availability.",
      action: "Expose color as a first-class SKU dimension and disable unavailable variants explicitly.",
      outcome: "Frontend truth now matches SKU-level inventory instead of aggregate product-level guesses.",
      failure: "Color inventory was previously aggregated and misleading.",
      applyWhen: ["Variant inventory differs by color"],
      doNotApply: ["All variants truly share one inventory pool"],
    });
    catalog.writeRecord("case", retrievalCase);
    catalog.writeRecord("case", variantCase);

    const surface = new InvariantDiscoverySurface({ catalogRoot: rootDir });
    const result = surface.evaluateCandidate({
      promotion_basis: "multi_case",
      title: "Scope truth must be explicit before ranking",
      summary: "Mismatched cases should not form one invariant.",
      statement: "Variant truth and retrieval scope should both be explicit before ranking because they are authority boundaries.",
      source_case_refs: [retrievalCase.case_id, variantCase.case_id],
      why_it_is_stable: "Both cases preserve explicit truth.",
      scope: ["mixed"],
      non_scope: [],
      applicability_conditions: ["Boundaries exist"],
      non_applicability_conditions: [],
      known_breakers: ["No shared support"],
      tool_agnosticity_level: "high",
      confidence: 0.54,
    });

    assert.equal(result.actual_decision, "block");
    assert.match(result.reasons.join(" "), /not strongly supported|do not share enough stable common support/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("invariant discovery benchmark reports expected decisions", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-invariant-discovery-"));
  const manifestPath = path.join(rootDir, "benchmark.json");

  try {
    const catalog = new FileBackedCatalog({ rootDir });
    const first = buildCase({
      caseId: "case_scope_filter_004",
      evidenceRef: "ev_scope_filter_004",
      problem: "Retrieval leaked cross-project candidates because scope filtering happened after ranking.",
      action: "Move scope filtering into the planner before ranking.",
      outcome: "Scope-safe retrieval removed unauthorized candidates before ranking.",
      failure: "Late filtering let unauthorized candidates influence ranking.",
      applyWhen: ["Multiple project scopes share vocabulary"],
      doNotApply: ["Search is intentionally global"],
    });
    const second = buildCase({
      caseId: "case_scope_filter_005",
      evidenceRef: "ev_scope_filter_005",
      problem: "Authority boundaries were ignored until after candidate scoring.",
      action: "Apply scope boundaries before retrieval ranking and fusion.",
      outcome: "Authority-safe retrieval became explainable and stable.",
      failure: "Scope boundaries applied after candidate ranking.",
      applyWhen: ["Candidate pools span multiple projects"],
      doNotApply: ["No scope boundaries exist"],
    });
    catalog.writeRecord("case", first);
    catalog.writeRecord("case", second);

    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          benchmark_id: "invariant_discovery_test_v1",
          entries: [
            {
              label: "approve",
              expected_decision: "approve",
              promotion_basis: "multi_case",
              title: "Scope boundaries must be enforced before ranking",
              summary: "Authority scope should prune candidates before ranking.",
              statement: "When records carry scope or authority boundaries, those boundaries must be enforced before ranking so unauthorized candidates cannot influence the result set.",
              source_case_refs: [first.case_id, second.case_id],
              why_it_is_stable: "Authority boundaries survive backend changes because they are governance constraints.",
              scope: ["retrieval planning"],
              non_scope: [],
              applicability_conditions: ["Multiple project scopes can appear in one candidate pool"],
              non_applicability_conditions: [],
              known_breakers: ["Missing scope metadata"],
              tool_agnosticity_level: "high",
              confidence: 0.84,
            },
            {
              label: "block",
              expected_decision: "block",
              promotion_basis: "multi_case",
              title: "One case is not enough",
              summary: "Multi-case promotion must use more than one case.",
              statement: "A single source case cannot satisfy a multi-case invariant basis.",
              source_case_refs: [first.case_id],
              why_it_is_stable: "The promotion contract requires multiple cases for multi-case discovery.",
              scope: ["promotion governance"],
              non_scope: [],
              applicability_conditions: ["Promotion basis is multi_case"],
              non_applicability_conditions: [],
              known_breakers: ["Only one case supplied"],
              tool_agnosticity_level: "high",
              confidence: 0.9,
            },
          ],
        },
        null,
        2,
      ),
    );

    const result = runInvariantDiscoveryBenchmark({
      manifestPath,
      catalogRoot: rootDir,
    });

    assert.equal(result.matches_expected, 2);
    assert.equal(result.false_positives, 0);
    assert.equal(result.false_negatives, 0);
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
