const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const { InvariantReviewSurface } = require("../src/invariants/review");
const { loadExample } = require("./helpers/load-example");

test("invariant review surface promotes a supported candidate and writes canonical artifacts", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-invariant-review-"));

  try {
    const catalog = new FileBackedCatalog({ rootDir });
    const manifestPath = path.join(rootDir, "invariant-manifest.json");
    const caseOne = buildCase({
      caseId: "case_invariant_review_001",
      evidenceRef: "ev_invariant_review_001",
      problem: "Operator surfaces pointed at mutable inbox files instead of canonical artifacts.",
      action: "Project the operator review surface from persisted draft and report artifacts.",
      outcome: "Operator review moved onto stable persisted artifacts.",
      failure: "Mutable ingress files were being treated as managed truth.",
      applyWhen: ["The operator surface is only a projection layer"],
      doNotApply: ["The operator intentionally wants an unmanaged scratch queue"],
    });
    const caseTwo = buildCase({
      caseId: "case_invariant_review_002",
      evidenceRef: "ev_invariant_review_002",
      problem: "Operator views relied on transient paths instead of canonical runtime artifacts.",
      action: "Bind the operator workflow to persisted reports and pending draft records.",
      outcome: "Operator workflows now project from canonical artifacts.",
      failure: "Transient paths were mistaken for authoritative storage.",
      applyWhen: ["Persisted artifacts already exist"],
      doNotApply: ["No canonical artifacts exist yet"],
    });
    catalog.writeRecord("case", caseOne);
    catalog.writeRecord("case", caseTwo);

    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify({
        entries: [
          {
            label: "approve_operator_surfaces",
            promotion_basis: "multi_case",
            series_key: "memory.operator-surfaces-project-from-persisted-artifacts",
            title: "Operator surfaces should project from persisted artifacts",
            summary: "Operator-facing runtime surfaces should project from canonical artifacts.",
            statement: "Operator-facing runtime surfaces should project from persisted reports and draft artifacts rather than inventing parallel mutable queues.",
            source_case_refs: [caseOne.case_id, caseTwo.case_id],
            why_it_is_stable: "Both cases preserve the same governance rule: persisted artifacts remain authoritative while operator surfaces stay projections.",
            scope: ["memory runtime", "operator surfaces"],
            non_scope: ["ui polish"],
            applicability_conditions: ["Canonical artifacts already exist"],
            non_applicability_conditions: ["The operator wants an unmanaged scratch queue"],
            known_breakers: ["Ingress files are treated as authority"],
            tool_agnosticity_level: "high",
            confidence: 0.86,
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    );

    const surface = new InvariantReviewSurface({ catalogRoot: rootDir });
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const result = surface.promoteCandidate({
      entry: manifest.entries[0],
      reviewer: "governance-qa-steward",
      rationale: "The invariant is supported by multiple active cases and is ready for activation.",
      reviewedAt: "2026-04-13T12:00:00.000Z",
    });

    assert.equal(result.next_record.status, "active");
    assert.equal(result.next_record.updated_at, "2026-04-13T12:00:00.000Z");
    assert.ok(result.packet_write.filePath.endsWith(".json"));

    const persistedInvariant = catalog.getRecord("invariant", result.next_record.id);
    assert.equal(persistedInvariant.status, "active");

    const auditEntries = catalog.listRecords("review_audit_entry");
    assert.equal(auditEntries.length, 1);
    assert.equal(auditEntries[0].record_type, "invariant");

    const inspection = surface.inspectInvariant(result.next_record.id);
    assert.equal(inspection.invariant.id, result.next_record.id);
    assert.equal(inspection.staged_promotion_packet.proposed_invariant_id, result.next_record.id);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("invariant review surface blocks non-ready candidates without writing records in dry run", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-invariant-review-"));

  try {
    const catalog = new FileBackedCatalog({ rootDir });
    const caseOne = buildCase({
      caseId: "case_invariant_review_003",
      evidenceRef: "ev_invariant_review_003",
      problem: "One case alone should not satisfy multi-case support.",
      action: "Documented the retrieval scope boundary.",
      outcome: "One strong case exists.",
      failure: "Only one supporting case exists.",
      applyWhen: ["Promotion basis is multi_case"],
      doNotApply: ["At least two supporting cases exist"],
    });
    catalog.writeRecord("case", caseOne);

    const surface = new InvariantReviewSurface({ catalogRoot: rootDir });
    assert.throws(
      () => surface.promoteCandidate({
        entry: {
          label: "block_single_case",
          promotion_basis: "multi_case",
          series_key: "retrieval.single-case-should-block",
          title: "One case is not enough",
          summary: "Multi-case invariant promotion requires more than one case.",
          statement: "A single source case should not satisfy a multi-case invariant basis.",
          source_case_refs: [caseOne.case_id],
          why_it_is_stable: "The promotion contract requires multiple cases.",
          scope: ["promotion governance"],
          non_scope: [],
          applicability_conditions: ["Promotion basis is multi_case"],
          non_applicability_conditions: [],
          known_breakers: ["Only one supporting case exists"],
          tool_agnosticity_level: "high",
          confidence: 0.9,
        },
        reviewer: "governance-qa-steward",
        rationale: "This should block.",
        reviewedAt: "2026-04-13T12:10:00.000Z",
        dryRun: true,
      }),
      (error) => {
        assert.match(error.message, /promotion-ready/);
        assert.equal(error.readiness.actual_decision, "block");
        return true;
      },
    );

    assert.equal(catalog.listRecords("invariant").length, 0);
    assert.equal(catalog.listRecords("review_audit_entry").length, 0);
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
