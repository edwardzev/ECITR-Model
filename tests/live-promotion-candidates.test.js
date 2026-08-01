const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const {
  LivePromotionCandidateStore,
  buildLiveInvariantCandidates,
  processLivePromotionCandidates,
  stageLivePromotionCandidates,
} = require("../src/runtime/live-promotion-candidates");
const { buildPromotionJudge } = require("../src/runtime/promotion-judge");

test("live invariant generation clusters semantically similar active cases with different wording", () => {
  const generatedAt = "2099-01-01T00:00:00.000Z";
  const candidates = buildLiveInvariantCandidates({
    activeCases: [
      makeCase({
        case_id: "case_lancedb_scope_refresh_a",
        problem_statement: "LanceDB index refresh reused stale support graph cache before catalog refresh.",
        action_taken: "Move support graph refresh after case approval and rebuild the LanceDB index with workspace scoped catalog hash.",
        outcome: "Refresh stopped returning stale support graph nodes.",
        failure_mode: "Stale support graph cache allowed old inactive candidates to remain eligible.",
      }),
      makeCase({
        case_id: "case_lancedb_scope_refresh_b",
        problem_statement: "Semantic index refresh kept outdated support graph entries because catalog hash was not rebuilt first.",
        action_taken: "Rebuild the support graph after case approval before syncing the LanceDB semantic index for the workspace.",
        outcome: "The refreshed index stopped surfacing outdated support graph records.",
        failure_mode: "Outdated support graph entries stayed eligible when semantic sync ran before graph refresh.",
      }),
    ],
    activeInvariants: [],
    generatedAt,
    maxCandidates: 5,
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].artifact_type, "live_invariant_candidate");
  assert.deepEqual(candidates[0].source_case_refs.sort(), [
    "case_lancedb_scope_refresh_a",
    "case_lancedb_scope_refresh_b",
  ]);
});

test("live invariant generation does not cluster mixed workspaces", () => {
  const generatedAt = "2099-01-01T00:00:00.000Z";
  const candidates = buildLiveInvariantCandidates({
    activeCases: [
      makeCase({ case_id: "case_mixed_workspace_a", workspace_id: "ecitr_model" }),
      makeCase({ case_id: "case_mixed_workspace_b", workspace_id: "agent_ops" }),
    ],
    activeInvariants: [],
    generatedAt,
    maxCandidates: 5,
  });

  assert.equal(candidates.length, 0);
});

test("live invariant generation prioritizes uncovered active cases", () => {
  const generatedAt = "2099-01-01T00:00:00.000Z";
  const activeCases = [
    makeCase({ case_id: "case_covered_pair_a" }),
    makeCase({ case_id: "case_covered_pair_b" }),
  ];
  const candidates = buildLiveInvariantCandidates({
    activeCases,
    activeInvariants: [
      {
        id: "inv_existing_coverage",
        source_case_refs: activeCases.map((record) => record.case_id),
      },
    ],
    generatedAt,
    maxCandidates: 5,
  });

  assert.equal(candidates.length, 0);
});

test("live staging is idempotent for unchanged candidates", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-live-stage-"));
  const catalog = new FileBackedCatalog({ rootDir });
  catalog.writeRecord("case", makeCase({ case_id: "case_stage_repeat_a" }));
  catalog.writeRecord("case", makeCase({ case_id: "case_stage_repeat_b" }));

  const first = stageLivePromotionCandidates({
    catalogRoot: rootDir,
    generatedAt: "2099-01-01T00:00:00.000Z",
    maxInvariantCandidates: 5,
    maxTacticCandidates: 0,
  });
  const second = stageLivePromotionCandidates({
    catalogRoot: rootDir,
    generatedAt: "2099-01-01T00:00:00.000Z",
    maxInvariantCandidates: 5,
    maxTacticCandidates: 0,
  });

  assert.equal(first.invariants.written_count, 1);
  assert.equal(second.invariants.written_count, 0);
  assert.equal(second.invariants.unchanged_count, 1);
});

test("terminal live candidates retain decided semantics and stage changed semantics as a new revision", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-live-terminal-revision-"));
  const store = new LivePromotionCandidateStore({ rootDir, kind: "invariant" });
  const original = makeInvariantCandidate("lic_terminal_001", "terminal_001");
  store.upsertCandidate(original);
  store.updateCandidate(original.candidate_id, {
    status: "activated",
    decision_history: [
      {
        decided_at: "2099-01-01T01:00:00.000Z",
        decision: "activated",
        rationale: "approved original semantics",
      },
    ],
  });

  const changed = {
    ...original,
    last_seen_at: "2099-01-02T00:00:00.000Z",
    entry: {
      ...original.entry,
      title: "Changed terminal candidate semantics",
    },
  };
  const result = store.upsertCandidate(changed);
  const base = store.getCandidate(original.candidate_id);
  const revision = store.getCandidate(result.candidateId);

  assert.equal(result.status, "revision_created");
  assert.notEqual(result.candidateId, original.candidate_id);
  assert.equal(base.status, "activated");
  assert.equal(base.entry.title, original.entry.title);
  assert.deepEqual(base.decision_history.map((entry) => entry.decision), ["activated"]);
  assert.equal(revision.status, "staged");
  assert.equal(revision.revision, 2);
  assert.equal(revision.candidate_series_id, original.candidate_id);
  assert.equal(revision.supersedes_candidate_id, original.candidate_id);
  assert.equal(revision.entry.title, "Changed terminal candidate semantics");
  assert.deepEqual(revision.decision_history, []);

  const repeated = store.upsertCandidate(changed);
  assert.equal(repeated.candidateId, result.candidateId);
  assert.equal(repeated.status, "updated");
  assert.equal(repeated.changed, false);
  assert.equal(store.listCandidates().length, 2);
});

test("regenerated discovery semantics do not overwrite judge-narrowed terminal semantics", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-live-terminal-narrowed-"));
  const store = new LivePromotionCandidateStore({ rootDir, kind: "invariant" });
  const generated = makeInvariantCandidate("lic_terminal_narrowed_001", "terminal_narrowed_001");
  store.upsertCandidate(generated);
  const persisted = store.getCandidate(generated.candidate_id);
  store.updateCandidate(generated.candidate_id, {
    ...persisted,
    status: "activated",
    entry: {
      ...persisted.entry,
      title: "Human-reviewed narrow title",
      scope: ["Only the reviewed workspace boundary"],
    },
    decision_history: [
      {
        decided_at: "2099-01-01T01:00:00.000Z",
        decision: "narrowed",
        rationale: "narrowed before activation",
      },
      {
        decided_at: "2099-01-01T01:01:00.000Z",
        decision: "activated",
        rationale: "approved narrowed semantics",
      },
    ],
  });

  const result = store.upsertCandidate({
    ...generated,
    last_seen_at: "2099-01-02T00:00:00.000Z",
  });
  const terminal = store.getCandidate(generated.candidate_id);

  assert.equal(result.status, "updated");
  assert.equal(result.changed, false);
  assert.equal(store.listCandidates().length, 1);
  assert.equal(terminal.status, "activated");
  assert.equal(terminal.entry.title, "Human-reviewed narrow title");
  assert.deepEqual(terminal.entry.scope, ["Only the reviewed workspace boundary"]);
  assert.deepEqual(terminal.decision_history.map((entry) => entry.decision), ["narrowed", "activated"]);
});

test("candidate approval never transfers when an older semantic revision is rediscovered", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-terminal-transfer-"));
  const store = new LivePromotionCandidateStore({ rootDir, kind: "invariant" });
  const seriesId = "lic_terminal_transfer";
  const makeCandidate = (title, day) => {
    const candidate = makeInvariantCandidate(seriesId, "terminal_transfer");
    return {
      ...candidate,
      entry: { ...candidate.entry, title },
      last_seen_at: `2099-01-0${day}T00:00:00.000Z`,
    };
  };

  const first = store.upsertCandidate(makeCandidate("A", 1));
  store.updateCandidate(first.candidateId, {
    status: "activated",
    decision_history: [{
      decided_at: "2099-01-01T00:10:00.000Z",
      decision: "activated",
      rationale: "A reviewed",
    }],
  });
  const second = store.upsertCandidate(makeCandidate("B", 2));
  const third = store.upsertCandidate(makeCandidate("C", 3));
  store.updateCandidate(third.candidateId, {
    status: "activated",
    decision_history: [{
      decided_at: "2099-01-03T00:10:00.000Z",
      decision: "activated",
      rationale: "C reviewed",
    }],
  });

  const rediscovered = store.upsertCandidate(makeCandidate("B", 4));

  assert.notEqual(second.candidateId, third.candidateId);
  assert.notEqual(third.candidateId, rediscovered.candidateId);
  assert.equal(rediscovered.status, "revision_created");
  assert.equal(rediscovered.candidate.status, "staged");
  assert.deepEqual(rediscovered.candidate.decision_history, []);
  assert.equal(rediscovered.candidate.supersedes_candidate_id, third.candidateId);
  assert.notEqual(rediscovered.candidate.supersedes_candidate_id, rediscovered.candidateId);
  assert.equal(store.getCandidate(third.candidateId).status, "activated");
  assert.deepEqual(
    store.getCandidate(third.candidateId).decision_history.map((entry) => entry.rationale),
    ["C reviewed"],
  );
});

test("live processing marks candidates judge-skipped when the judge is unavailable", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-live-process-"));
  const store = new LivePromotionCandidateStore({ rootDir, kind: "invariant" });
  store.upsertCandidate(makeInvariantCandidate("lic_unavailable_001", "unavailable_001"));

  const result = await processLivePromotionCandidates({
    catalogRoot: rootDir,
    invariantStore: store,
    tacticStore: new LivePromotionCandidateStore({ rootDir, kind: "tactic" }),
    invariantReviewSurface: createFakeReviewSurface("invariant"),
    tacticReviewSurface: createFakeReviewSurface("tactic"),
    promotionJudge: buildPromotionJudge({ mode: "unavailable" }),
    reviewedAt: "2099-01-01T00:00:00.000Z",
  });

  assert.equal(result.invariants.judge_skipped_count, 1);
  assert.equal(result.warnings.length, 1);
  assert.equal(store.getCandidate("lic_unavailable_001").status, "judge_skipped");
});

test("live processing treats thrown judge errors as judge-skipped", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-live-process-"));
  const store = new LivePromotionCandidateStore({ rootDir, kind: "invariant" });
  store.upsertCandidate(makeInvariantCandidate("lic_throwing_001", "throwing_001"));

  const result = await processLivePromotionCandidates({
    catalogRoot: rootDir,
    invariantStore: store,
    tacticStore: new LivePromotionCandidateStore({ rootDir, kind: "tactic" }),
    invariantReviewSurface: createFakeReviewSurface("invariant"),
    tacticReviewSurface: createFakeReviewSurface("tactic"),
    promotionJudge: {
      async judgeCandidate() {
        throw new Error("model adapter crashed");
      },
    },
    reviewedAt: "2099-01-01T00:00:00.000Z",
  });

  assert.equal(result.invariants.judge_skipped_count, 1);
  assert.match(store.getCandidate("lic_throwing_001").decision_history[0].rationale, /model adapter crashed/);
});

test("live processing preserves narrowing history before activation", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-live-process-"));
  const store = new LivePromotionCandidateStore({ rootDir, kind: "invariant" });
  store.upsertCandidate(makeInvariantCandidate("lic_narrow_001", "narrow_001"));
  const promoted = [];

  const result = await processLivePromotionCandidates({
    catalogRoot: rootDir,
    invariantStore: store,
    tacticStore: new LivePromotionCandidateStore({ rootDir, kind: "tactic" }),
    invariantReviewSurface: createFakeReviewSurface("invariant", { promoted }),
    tacticReviewSurface: createFakeReviewSurface("tactic"),
    promotionJudge: {
      async judgeCandidate() {
        return {
          decision: "narrow",
          rationale: "nearby counterexample requires workspace-only scope",
          narrowed_entry: {
            scope: ["Workspace-only daemon migration cases"],
          },
        };
      },
    },
    reviewedAt: "2099-01-01T00:00:00.000Z",
  });

  const candidate = store.getCandidate("lic_narrow_001");
  assert.equal(result.invariants.narrowed_count, 1);
  assert.equal(result.invariants.activated_count, 1);
  assert.deepEqual(promoted[0].scope, ["Workspace-only daemon migration cases"]);
  assert.equal(candidate.status, "activated");
  assert.equal(candidate.revision, 2);
  assert.deepEqual(candidate.decision_history.map((entry) => entry.decision), ["narrowed", "activated"]);
});

test("live processing retires token-bag candidates even when judge says activate", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-live-process-"));
  const store = new LivePromotionCandidateStore({ rootDir, kind: "invariant" });
  store.upsertCandidate(makeNoisyInvariantCandidate("lic_noisy_activate_001", "noisy_activate_001"));
  const promoted = [];

  const result = await processLivePromotionCandidates({
    catalogRoot: rootDir,
    invariantStore: store,
    tacticStore: new LivePromotionCandidateStore({ rootDir, kind: "tactic" }),
    invariantReviewSurface: createFakeReviewSurface("invariant", { promoted }),
    tacticReviewSurface: createFakeReviewSurface("tactic"),
    promotionJudge: {
      async judgeCandidate() {
        return {
          decision: "activate",
          rationale: "model missed generated wording",
        };
      },
    },
    reviewedAt: "2099-01-01T00:00:00.000Z",
  });

  const candidate = store.getCandidate("lic_noisy_activate_001");
  assert.equal(result.invariants.activated_count, 0);
  assert.equal(result.invariants.retired_count, 1);
  assert.match(result.invariants.retired[0].reason, /generated/);
  assert.equal(candidate.status, "retired");
  assert.deepEqual(candidate.decision_history.map((entry) => entry.decision), ["retired"]);
  assert.equal(promoted.length, 0);
});

test("live processing activates noisy invariant only after semantic-field rewrite", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-live-process-"));
  const store = new LivePromotionCandidateStore({ rootDir, kind: "invariant" });
  store.upsertCandidate(makeNoisyInvariantCandidate("lic_rewrite_001", "rewrite_001"));
  const promoted = [];

  const result = await processLivePromotionCandidates({
    catalogRoot: rootDir,
    invariantStore: store,
    tacticStore: new LivePromotionCandidateStore({ rootDir, kind: "tactic" }),
    invariantReviewSurface: createFakeReviewSurface("invariant", { promoted }),
    tacticReviewSurface: createFakeReviewSurface("tactic"),
    promotionJudge: {
      async judgeCandidate() {
        return {
          decision: "narrow",
          rationale: "rewrite noisy activation-facing fields",
          narrowed_entry: {
            title: "Refresh support graph before semantic sync",
            summary: "Use this when a workspace semantic index depends on support graph state and stale graph nodes can leak into retrieval.",
            statement: "Refresh the support graph after case approval and before syncing the semantic index when retrieval depends on graph-derived context.",
            why_it_is_stable: "Both source cases required ordering graph refresh before semantic sync to prevent stale support graph records from remaining eligible.",
            scope: ["Workspace semantic retrieval refreshes that consume support graph records."],
          },
        };
      },
    },
    reviewedAt: "2099-01-01T00:00:00.000Z",
  });

  const candidate = store.getCandidate("lic_rewrite_001");
  assert.equal(result.invariants.narrowed_count, 1);
  assert.equal(result.invariants.activated_count, 1);
  assert.equal(promoted[0].title, "Refresh support graph before semantic sync");
  assert.equal(promoted[0].summary, "Use this when a workspace semantic index depends on support graph state and stale graph nodes can leak into retrieval.");
  assert.equal(candidate.status, "activated");
  assert.equal(candidate.revision, 2);
  assert.deepEqual(candidate.decision_history.map((entry) => entry.decision), ["narrowed", "activated"]);
});

test("live processing retires noisy tactic unless action fields are rewritten", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-live-process-"));
  const store = new LivePromotionCandidateStore({ rootDir, kind: "tactic" });
  store.upsertCandidate(makeNoisyTacticCandidate("ltc_noisy_tactic_001", "noisy_tactic_001"));
  const promoted = [];

  const result = await processLivePromotionCandidates({
    catalogRoot: rootDir,
    invariantStore: new LivePromotionCandidateStore({ rootDir, kind: "invariant" }),
    tacticStore: store,
    invariantReviewSurface: createFakeReviewSurface("invariant"),
    tacticReviewSurface: createFakeReviewSurface("tactic", { promoted }),
    promotionJudge: {
      async judgeCandidate() {
        return {
          decision: "narrow",
          rationale: "scope was narrowed but action stayed generated",
          narrowed_entry: {
            prerequisites: ["The current task depends on refreshed support graph records."],
          },
        };
      },
    },
    reviewedAt: "2099-01-01T00:00:00.000Z",
  });

  const candidate = store.getCandidate("ltc_noisy_tactic_001");
  assert.equal(result.tactics.activated_count, 0);
  assert.equal(result.tactics.narrowed_count, 1);
  assert.equal(result.tactics.retired_count, 1);
  assert.match(result.tactics.retired[0].reason, /generated/);
  assert.equal(candidate.status, "retired");
  assert.deepEqual(candidate.decision_history.map((entry) => entry.decision), ["narrowed", "retired"]);
  assert.equal(promoted.length, 0);
});

test("live processing retires narrowed tactic that duplicates an active tactic", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-live-process-"));
  const store = new LivePromotionCandidateStore({ rootDir, kind: "tactic" });
  store.upsertCandidate(makeNoisyTacticCandidate("ltc_duplicate_tactic_001", "duplicate_tactic_001"));
  const promoted = [];

  const result = await processLivePromotionCandidates({
    catalogRoot: rootDir,
    invariantStore: new LivePromotionCandidateStore({ rootDir, kind: "invariant" }),
    tacticStore: store,
    invariantReviewSurface: createFakeReviewSurface("invariant"),
    tacticReviewSurface: createFakeReviewSurface("tactic", {
      promoted,
      activeRecords: [
        {
          id: "tac_existing_upload_flow",
          status: "active",
          workspace_id: "ecitr_model",
          title: "Deploy a Business Central extension to Production using the automation API upload flow",
          summary: "Deploy an AL .app through extensionUpload, PATCH extensionContent with If-Match, call Microsoft.NAV.upload with a zero-length body, and verify the installed version.",
          action: "Use the Business Central automation API upload flow and verify the installed extension version.",
          source_case_refs: ["case_existing_a", "case_existing_b"],
          evidence_refs: ["ev_shared_upload_flow", "ev_existing_b"],
        },
      ],
    }),
    promotionJudge: {
      async judgeCandidate() {
        return {
          decision: "narrow",
          rationale: "rewrite into the shared upload-flow tactic",
          narrowed_entry: {
            title: "Deploy a Business Central extension to Production using the Automation API upload flow",
            summary: "When direct AL publish is unreliable, deploy a built .app by creating an extensionUpload, PATCHing extensionContent with If-Match, invoking Microsoft.NAV.upload, then verifying installation via the extensions endpoint.",
            action: "Use the Business Central automation API upload flow and verify the installed extension version.",
            source_case_refs: ["case_new_a", "case_existing_b"],
            evidence_refs: ["ev_shared_upload_flow", "ev_new_b"],
            tool_binding: ["business-central-automation-api"],
            steps: [
              "Build the .app package.",
              "Create an extensionUpload record.",
              "PATCH extensionContent with If-Match.",
              "Call Microsoft.NAV.upload and verify the installed version.",
            ],
          },
        };
      },
    },
    reviewedAt: "2099-01-01T00:00:00.000Z",
  });

  const candidate = store.getCandidate("ltc_duplicate_tactic_001");
  assert.equal(result.tactics.activated_count, 0);
  assert.equal(result.tactics.retired_count, 1);
  assert.equal(result.tactics.duplicate_count, 1);
  assert.equal(result.tactics.duplicates[0].duplicate_record_id, "tac_existing_upload_flow");
  assert.match(result.tactics.retired[0].reason, /duplicates active tactic tac_existing_upload_flow/);
  assert.equal(candidate.status, "retired");
  assert.deepEqual(candidate.decision_history.map((entry) => entry.decision), ["narrowed", "retired"]);
  assert.equal(promoted.length, 0);
});

test("live processing respects invariant activation caps", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-live-process-"));
  const store = new LivePromotionCandidateStore({ rootDir, kind: "invariant" });
  for (let index = 0; index < 4; index += 1) {
    store.upsertCandidate(makeInvariantCandidate(`lic_cap_00${index}`, `cap_00${index}`));
  }

  const result = await processLivePromotionCandidates({
    catalogRoot: rootDir,
    invariantStore: store,
    tacticStore: new LivePromotionCandidateStore({ rootDir, kind: "tactic" }),
    invariantReviewSurface: createFakeReviewSurface("invariant"),
    tacticReviewSurface: createFakeReviewSurface("tactic"),
    promotionJudge: {
      async judgeCandidate() {
        return {
          decision: "activate",
          rationale: "candidate is narrow and supported",
        };
      },
    },
    invariantActivationCap: 3,
    reviewedAt: "2099-01-01T00:00:00.000Z",
  });

  assert.equal(result.invariants.activated_count, 3);
  assert.equal(result.invariants.cap_skipped_count, 1);
  assert.equal(store.getCandidate("lic_cap_003").status, "cap_skipped");
});

test("live processing does not duplicate activations across repeated runs", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-live-process-"));
  const store = new LivePromotionCandidateStore({ rootDir, kind: "invariant" });
  store.upsertCandidate(makeInvariantCandidate("lic_repeat_001", "repeat_001"));
  const promoted = [];
  const options = {
    catalogRoot: rootDir,
    invariantStore: store,
    tacticStore: new LivePromotionCandidateStore({ rootDir, kind: "tactic" }),
    invariantReviewSurface: createFakeReviewSurface("invariant", { promoted }),
    tacticReviewSurface: createFakeReviewSurface("tactic"),
    promotionJudge: {
      async judgeCandidate() {
        return {
          decision: "activate",
          rationale: "candidate is narrow and supported",
        };
      },
    },
    reviewedAt: "2099-01-01T00:00:00.000Z",
  };

  const first = await processLivePromotionCandidates(options);
  const second = await processLivePromotionCandidates(options);

  assert.equal(first.invariants.activated_count, 1);
  assert.equal(second.invariants.total_candidates, 0);
  assert.equal(promoted.length, 1);
});

function makeCase({
  case_id,
  workspace_id = "ecitr_model",
  problem_statement = "Support graph refresh reused stale catalog index entries during semantic retrieval.",
  action_taken = "Rebuild support graph after case approval and sync LanceDB with a workspace scoped catalog hash.",
  outcome = "Semantic retrieval stopped surfacing stale support graph records.",
  failure_mode = "Refreshing semantic retrieval before support graph rebuild left stale graph nodes eligible.",
} = {}) {
  return {
    case_id,
    case_version: 1,
    workspace_id,
    status: "active",
    problem_statement,
    context: {
      constraints: [
        "The catalog is workspace scoped.",
        "Semantic retrieval consumes support graph state.",
      ],
      project_scope: "project",
      toolchain: ["support-graph", "lancedb", "semantic-retrieval"],
    },
    action_taken,
    outcome,
    failure_mode,
    applicability: {
      when_to_apply: [
        "A workspace scoped semantic index depends on refreshed support graph records.",
      ],
      when_not_to_apply: [
        "The retrieval run intentionally ignores support graph context.",
      ],
    },
    evidence_refs: [`ev_${case_id}`],
    review_state: "approved",
    confidence: 0.82,
    derived_at: "2099-01-01T00:00:00.000Z",
    derivation_rule_id: "test-case-rule",
  };
}

function makeInvariantCandidate(candidateId, label) {
  return {
    artifact_type: "live_invariant_candidate",
    candidate_id: candidateId,
    layer: "invariant",
    status: "staged",
    workspace_id: "ecitr_model",
    derivation_method: "test-live-case-cluster",
    source_case_refs: ["case_source_a", "case_source_b"],
    evidence_refs: ["ev_source_a", "ev_source_b"],
    entry: {
      label,
      title: "Workspace scoped daemon migration",
      scope: ["Daemon migration workspaces"],
    },
    support_signals: {
      score: 0.9,
      shared_tokens: ["daemon", "migration", "workspace", "healthcheck"],
    },
    counterexample_case_refs: [],
    created_at: "2099-01-01T00:00:00.000Z",
    last_seen_at: "2099-01-01T00:00:00.000Z",
    revision: 1,
    decision_history: [],
  };
}

function makeNoisyInvariantCandidate(candidateId, label) {
  return {
    ...makeInvariantCandidate(candidateId, label),
    entry: {
      label,
      title: "Live candidate: Marketing_development_framework Run_overnight_maintainer Runtime-Surface",
      summary: "Active cases repeat a higher-order pattern around marketing_development_framework, run_overnight_maintainer, runtime-surface, schema-tighten.",
      statement: "When active cases share marketing_development_framework, run_overnight_maintainer, runtime-surface, schema-tighten, treat that repeated boundary as a narrow reusable rule only inside the cited workspace and evidence context.",
      why_it_is_stable: "The supporting active cases share the same decision signals: marketing_development_framework, run_overnight_maintainer, runtime-surface, schema-tighten.",
      scope: ["marketing_development_framework", "run_overnight_maintainer"],
    },
  };
}

function makeNoisyTacticCandidate(candidateId, label) {
  return {
    artifact_type: "live_tactic_candidate",
    candidate_id: candidateId,
    layer: "tactic",
    status: "staged",
    workspace_id: "ecitr_model",
    promotion_basis: "case_cluster",
    derivation_method: "test-live-case-cluster",
    source_case_refs: ["case_source_a", "case_source_b"],
    supporting_invariant_refs: [],
    evidence_refs: ["ev_source_a", "ev_source_b"],
    entry: {
      label,
      title: "Live direct tactic: Marketing_development_framework Run_overnight_maintainer Runtime-Surface",
      summary: "Use the repeated active-case procedure around marketing_development_framework, run_overnight_maintainer, runtime-surface.",
      action: "Apply the repeated procedure from the cited active cases: run the overnight maintainer and write the automation memory summary.",
      source_case_refs: ["case_source_a", "case_source_b"],
      supporting_invariant_refs: [],
      evidence_refs: ["ev_source_a", "ev_source_b"],
      tool_binding: ["overnight-maintainer-workflow"],
      tool_version_bounds: ">=0.1.0 <1.0.0",
      environment_bounds: ["workspace:ecitr_model"],
      prerequisites: ["The current task matches the cited case cluster."],
      steps: ["Run the overnight maintainer and update the automation memory summary."],
      fallbacks: ["Use case-level retrieval if the task diverges."],
      rollback: ["Stop applying the tactic and fall back to the source cases."],
      revalidate_at: "2099-03-01T00:00:00.000Z",
      confidence: 0.9,
      created_at: "2099-01-01T00:00:00.000Z",
    },
    support_signals: {
      score: 0.9,
      shared_tokens: ["marketing_development_framework", "run_overnight_maintainer", "runtime-surface"],
      shared_action_tokens: ["run", "overnight", "maintainer"],
    },
    counterexample_case_refs: [],
    created_at: "2099-01-01T00:00:00.000Z",
    last_seen_at: "2099-01-01T00:00:00.000Z",
    revision: 1,
    decision_history: [],
  };
}

function createFakeReviewSurface(kind, { promoted = [], activeRecords = [] } = {}) {
  return {
    discovery: {
      preparePromotionPacket(entry) {
        const id = kind === "invariant"
          ? `inv_${entry.label}`
          : `tac_${entry.label}`;
        return {
          packet: kind === "invariant"
            ? { proposed_invariant_id: id }
            : { proposed_tactic_id: id },
        };
      },
      evaluateCandidate() {
        return {
          actual_decision: "approve",
          reasons: [],
          support_summary: [],
        };
      },
    },
    catalog: {
      getRecord(_recordType, recordId) {
        return activeRecords.find((record) => record.id === recordId) ?? null;
      },
      listRecords(recordType) {
        return recordType === kind ? activeRecords : [];
      },
    },
    promoteCandidate({ entry, dryRun = false }) {
      promoted.push(entry);
      return {
        dry_run: dryRun,
        next_record: {
          id: kind === "invariant" ? `inv_${entry.label}` : `tac_${entry.label}`,
          status: "active",
        },
      };
    },
  };
}
