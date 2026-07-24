const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const { TacticReviewSurface } = require("../src/tactics/review");
const { loadExample } = require("./helpers/load-example");

test("tactic review promotes a supported discovery candidate into canonical state", (t) => {
  useFixedClock(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-tactic-review-"));

  try {
    const catalog = new FileBackedCatalog({ rootDir });
    const caseOne = buildCase({
      caseId: "case_operator_surface_001",
      evidenceRef: "ev_operator_surface_001",
      problem: "Operator morning review should project from persisted overnight artifacts.",
      action: "Rendered morning review from persisted overnight reports and pending drafts.",
      outcome: "Operator morning review now projects from canonical artifacts instead of a mutable queue.",
      failure: "A second queue would become competing truth.",
      applyWhen: ["Persisted overnight artifacts exist"],
      doNotApply: ["The operator intentionally wants a scratch queue"],
    });
    const caseTwo = buildCase({
      caseId: "case_operator_surface_002",
      evidenceRef: "ev_operator_surface_002",
      problem: "Artifact path hardening should keep operator surfaces inside canonical roots.",
      action: "Hardened artifact path resolution and added runtime smoke checks for morning review.",
      outcome: "Operator review now stays projection-only and repo-scoped.",
      failure: "Ingress or staging paths may be mistaken for canonical storage.",
      applyWhen: ["Canonical artifact roots exist"],
      doNotApply: ["Ingress paths are intentionally canonical"],
    });
    const invariant = buildInvariant({
      invariantId: "inv_operator_surfaces_002",
      evidenceRefs: ["ev_operator_surface_001", "ev_operator_surface_002"],
      title: "Operator surfaces should project from persisted artifacts",
      summary: "Operator-facing surfaces should project from persisted artifacts and canonical destinations.",
      statement: "Operator-facing surfaces should project from persisted reports, drafts, and canonical artifact roots rather than inventing a second queue.",
      whyStable: "Persisted artifacts remain authoritative while operator surfaces stay projections.",
      scope: ["operator surfaces", "artifact governance"],
      applicability: ["Persisted artifacts exist"],
      nonApplicability: ["The operator wants a scratch queue to become truth"],
      breakers: ["Ingress paths become canonical storage"],
    });

    catalog.writeRecord("case", caseOne);
    catalog.writeRecord("case", caseTwo);
    catalog.writeRecord("invariant", invariant);

    const surface = new TacticReviewSurface({ catalogRoot: rootDir });
    const result = surface.promoteCandidate({
      entry: {
        label: "approve_operator_review_projection",
        title: "Project operator morning review from persisted overnight artifacts",
        summary: "Render operator morning review from the latest overnight report and pending drafts.",
        action: "Render operator morning review from the latest persisted overnight report, pending drafts, and canonical artifact refs instead of inventing a second queue.",
        source_case_refs: [caseOne.case_id, caseTwo.case_id],
        supporting_invariant_refs: [invariant.id],
        tool_binding: ["get_morning_review", "run_overnight_maintainer", "memory_service"],
        tool_version_bounds: ">=1.0.0 <2.0.0",
        environment_bounds: ["lean memory runtime", "persisted overnight reports"],
        prerequisites: ["Persisted overnight artifacts exist"],
        steps: [
          "Read the latest persisted overnight report and pending draft set from canonical artifact roots",
          "Render morning review as a projection over those persisted artifacts",
          "Run runtime smoke verification after morning review changes"
        ],
        fallbacks: ["If persisted reports are missing, block instead of inventing a queue"],
        rollback: ["Remove the projection change"],
        revalidate_at: "2026-07-01T00:00:00Z",
        validated_on: ["get_morning_review"],
        confidence: 0.84,
      },
      reviewer: "tactic-steward",
      rationale: "Candidate is grounded in active cases and the persisted-artifact invariant.",
      reviewedAt: "2026-04-13T13:15:00.000Z",
    });

    assert.equal(result.dry_run, false);
    assert.equal(result.next_record.status, "active");
    assert.equal(result.next_record.layer, "tactic");
    assert.equal(result.packet_write.packet.source_case_refs.length, 2);

    const persistedTactic = catalog.getRecord("tactic", result.next_record.id);
    assert.equal(persistedTactic.status, "active");

    const inspection = surface.inspectTactic(result.next_record.id);
    assert.equal(inspection.tactic.id, result.next_record.id);
    assert.equal(inspection.staged_promotion_packet.promotion_id, result.packet_write.promotionId);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("tactic review blocks candidates that fail discovery readiness", (t) => {
  useFixedClock(t);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-tactic-review-"));

  try {
    const catalog = new FileBackedCatalog({ rootDir });
    const caseOne = buildCase({
      caseId: "case_memory_gate_010",
      evidenceRef: "ev_memory_gate_010",
      problem: "Higher-order memory changes need explicit schemas and review artifacts.",
      action: "Implemented schema validation and review artifacts for higher-order memory.",
      outcome: "Higher-order memory now stays explicit and auditable.",
      failure: "Direct semantic writes bypass the canonical gate.",
      applyWhen: ["Higher-order memory is changing"],
      doNotApply: ["Only raw evidence ingest is changing"],
    });
    const invariant = buildInvariant({
      invariantId: "inv_memory_gate_010",
      evidenceRefs: ["ev_memory_gate_010"],
      title: "Higher-order memory must pass explicit gates",
      summary: "Higher-order memory changes should go through schemas and review artifacts.",
      statement: "Higher-order memory should be introduced through explicit schemas and auditable review artifacts.",
      whyStable: "These gates preserve canonical auditability.",
      scope: ["higher-order memory"],
      applicability: ["Canonical memory must remain auditable"],
      nonApplicability: ["The change is limited to immutable raw evidence"],
      breakers: ["Direct semantic writes bypass canonical gates"],
    });

    catalog.writeRecord("case", caseOne);
    catalog.writeRecord("invariant", invariant);

    const surface = new TacticReviewSurface({ catalogRoot: rootDir });
    assert.throws(() => {
      surface.promoteCandidate({
        entry: {
          label: "block_process_only_candidate",
          title: "Prepare higher-order memory work by reviewing docs",
          summary: "Process-only candidate should block.",
          action: "Open a session and review the docs before discussing the change.",
          source_case_refs: [caseOne.case_id],
          supporting_invariant_refs: [invariant.id],
          tool_binding: ["memory_service"],
          tool_version_bounds: ">=1.0.0 <2.0.0",
          environment_bounds: ["canonical file-backed catalog"],
          prerequisites: ["The repo exists"],
          steps: [
            "Open a memory session for the repo",
            "Review the docs and inspect the current runtime surface",
            "Discuss possible next steps"
          ],
          fallbacks: ["Write notes"],
          rollback: ["Close the session"],
          revalidate_at: "2026-07-01T00:00:00Z",
          validated_on: ["manual inspection"],
          confidence: 0.31,
        },
        reviewer: "tactic-steward",
        rationale: "Process-only candidate should not promote.",
        reviewedAt: "2026-04-13T13:20:00.000Z",
      });
    }, (error) => {
      assert.equal(error.message, "candidate is not promotion-ready");
      assert.equal(error.readiness.actual_decision, "block");
      return true;
    });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("tactic review revalidates an active supported tactic through an immutable audit packet", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-tactic-revalidation-"));

  try {
    const catalog = new FileBackedCatalog({ rootDir });
    const evidence = buildEvidence("ev_tactic_revalidation_001");
    const sourceCase = buildCase({
      caseId: "case_tactic_revalidation_001",
      evidenceRef: evidence.evidence_id,
      problem: "Active tactics need explicit support-aware revalidation.",
      action: "Validated source lifecycle, evidence, environment, and tool bounds before extending freshness.",
      outcome: "The tactic remains usable with an auditable revalidation boundary.",
      failure: "Blindly moving revalidation dates would bypass semantic review.",
      applyWhen: ["An active tactic reaches its revalidation boundary"],
      doNotApply: ["Any source support is missing, inactive, or invalid"],
    });
    const invariant = buildInvariant({
      invariantId: "inv_tactic_revalidation_001",
      evidenceRefs: [evidence.evidence_id],
      title: "Tactic freshness must remain support-backed",
      summary: "Revalidation should prove current support instead of only changing a timestamp.",
      statement: "An active tactic may be revalidated only while its source cases, invariants, and evidence remain valid.",
      whyStable: "The authority chain must remain intact across freshness boundaries.",
      scope: ["tactic freshness"],
      applicability: ["An active tactic is due for revalidation"],
      nonApplicability: ["The tactic is already deprecated or invalidated"],
      breakers: ["A supporting record is missing or inactive"],
    });
    const tactic = buildTactic({
      tacticId: "tac_tactic_revalidation_001",
      caseRefs: [sourceCase.case_id],
      invariantRefs: [invariant.id],
      evidenceRefs: [evidence.evidence_id],
    });

    catalog.writeRecord("evidence", evidence);
    catalog.writeRecord("case", sourceCase);
    catalog.writeRecord("invariant", invariant);
    catalog.writeRecord("tactic", tactic);

    const surface = new TacticReviewSurface({ catalogRoot: rootDir });
    const result = surface.revalidateTactic({
      tacticId: tactic.id,
      reviewer: "governance-and-qa-steward",
      rationale: "Current source support and the focused runtime contract remain valid.",
      reviewedAt: "2026-07-17T12:00:00.000Z",
      revalidateAt: "2026-09-15T12:00:00.000Z",
      validatedOn: ["focused runtime regression", "environment and tool-bound review"],
    });

    assert.equal(result.next_record.revalidate_at, "2026-09-15T12:00:00.000Z");
    assert.deepEqual(result.packet_write.packet.checks, {
      source_cases_active: true,
      source_cases_lifecycle_valid: true,
      supporting_invariants_active: true,
      evidence_resolvable: true,
      invalidation_markers_clear: true,
      environment_bounds_reviewed: true,
      tool_version_bounds_reviewed: true,
    });
    assert.equal(surface.inspectTactic(tactic.id).revalidations.length, 1);
    assert.equal(catalog.getRecord("tactic", tactic.id).updated_at, "2026-07-17T12:00:00.000Z");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("tactic review blocks unsupported revalidation and can deprecate the stale tactic", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-tactic-revalidation-"));

  try {
    const catalog = new FileBackedCatalog({ rootDir });
    const evidence = buildEvidence("ev_tactic_revalidation_blocked_001");
    const sourceCase = buildCase({
      caseId: "case_tactic_revalidation_blocked_001",
      evidenceRef: evidence.evidence_id,
      problem: "A supporting case is no longer active.",
      action: "Deprecated the source case through review.",
      outcome: "Unsupported guidance is no longer eligible for revalidation.",
      failure: "Leaving the tactic active would conceal broken support.",
      applyWhen: ["A tactic cites this retired source"],
      doNotApply: ["The source case remains active"],
    });
    sourceCase.status = "deprecated";
    const tactic = buildTactic({
      tacticId: "tac_tactic_revalidation_blocked_001",
      caseRefs: [sourceCase.case_id],
      invariantRefs: [],
      evidenceRefs: [evidence.evidence_id],
    });

    catalog.writeRecord("evidence", evidence);
    catalog.writeRecord("case", sourceCase);
    catalog.writeRecord("tactic", tactic);

    const surface = new TacticReviewSurface({ catalogRoot: rootDir });
    assert.throws(() => surface.revalidateTactic({
      tacticId: tactic.id,
      reviewer: "governance-and-qa-steward",
      rationale: "This must fail because its only source is retired.",
      reviewedAt: "2026-07-17T12:00:00.000Z",
      revalidateAt: "2026-09-15T12:00:00.000Z",
      validatedOn: ["support lifecycle audit"],
    }), /source case is not active/);

    const result = surface.applyDecision({
      tacticId: tactic.id,
      decision: "deprecate",
      reviewer: "governance-and-qa-steward",
      rationale: "The only source case is deprecated, so the tactic no longer has active support.",
      reviewedAt: "2026-07-17T12:05:00.000Z",
    });
    assert.equal(result.next_record.status, "deprecated");
    assert.equal(catalog.getRecord("tactic", tactic.id).status, "deprecated");
    assert.equal(catalog.getRecord("review_audit_entry", result.audit_write.recordId).decision, "deprecate");
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

function buildEvidence(evidenceId) {
  const record = structuredClone(loadExample("evidence"));
  record.evidence_id = evidenceId;
  record.source_locator = `test://${evidenceId}`;
  return record;
}

function buildTactic({ tacticId, caseRefs, invariantRefs, evidenceRefs }) {
  const record = structuredClone(loadExample("tactic"));
  record.id = tacticId;
  record.series_key = tacticId;
  record.status = "active";
  record.source_case_refs = caseRefs;
  record.supporting_invariant_refs = invariantRefs;
  record.evidence_refs = evidenceRefs;
  record.revalidate_at = "2026-07-01T00:00:00.000Z";
  delete record.expiry_at;
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
