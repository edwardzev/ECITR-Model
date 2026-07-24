const test = require("node:test");
const assert = require("node:assert/strict");

const { refreshCodexIndex, runStructuralCheck } = require("../src/importers/codex-refresh");

test("codex refresh imports before sync and structural validation", async () => {
  const calls = [];
  const catalogs = {
    tactics: [],
    invariants: [],
    cases: [],
    evidence: [{ evidence_id: "ev_codex_thread_001", source_locator: "codex-thread://thread_001" }],
    atomic_claim_sets: [],
    review_audit_entries: [],
  };

  const summary = await refreshCodexIndex({
    codexRoot: "/tmp/.codex",
    catalogRoot: "/tmp/catalog",
    skipQdrantSync: false,
    importRollouts(options) {
      calls.push({ step: "rollouts", dryRun: options.dryRun });
      return {
        errors: 0,
        conflicts: 0,
        candidate_rollouts: 3,
        eligible_rollouts: 3,
        imported: 1,
        skipped_existing: 1,
        skipped_unchanged: 1,
        skipped_checkpoint: 0,
        skipped_duplicate_source: 0,
        skipped_no_visible_messages: 0,
      };
    },
    loadCatalogs() {
      calls.push({ step: "loadCatalogs" });
      return catalogs;
    },
    async syncCatalog(options) {
      calls.push({ step: "sync", recreateCollection: options.recreateCollection });
      return { points_upserted: 5 };
    },
    structuralCheck({ importSummary }) {
      calls.push({ step: "structural" });
      return runStructuralCheck({ importSummary, catalogs });
    },
  });

  assert.deepEqual(calls, [
    { step: "rollouts", dryRun: false },
    { step: "loadCatalogs" },
    { step: "sync", recreateCollection: false },
    { step: "structural" },
  ]);
  assert.equal(summary.structural_checks.failed, 0);
});

test("codex refresh dry-run skips sync and structural validation", async () => {
  const calls = [];

  const summary = await refreshCodexIndex({
    codexRoot: "/tmp/.codex",
    catalogRoot: "/tmp/catalog",
    dryRun: true,
    importRollouts(options) {
      calls.push({ step: "rollouts", dryRun: options.dryRun });
      return {
        errors: 0,
        conflicts: 0,
        candidate_rollouts: 2,
        eligible_rollouts: 2,
        planned: 2,
        skipped_unchanged: 0,
        skipped_checkpoint: 0,
      };
    },
  });

  assert.deepEqual(calls, [{ step: "rollouts", dryRun: true }]);
  assert.equal(summary.qdrant_sync.status, "skipped_dry_run");
  assert.equal(summary.structural_checks.status, "skipped_dry_run");
});

test("codex refresh can skip qdrant sync while still running structural validation", async () => {
  const calls = [];
  const catalogs = {
    tactics: [],
    invariants: [],
    cases: [],
    evidence: [{ evidence_id: "ev_codex_thread_001", source_locator: "codex-thread://thread_001" }],
    atomic_claim_sets: [],
    parameter_definitions: [],
    parameter_observations: [],
    review_audit_entries: [],
  };

  const summary = await refreshCodexIndex({
    codexRoot: "/tmp/.codex",
    catalogRoot: "/tmp/catalog",
    skipQdrantSync: true,
    importRollouts() {
      calls.push({ step: "rollouts" });
      return {
        errors: 0,
        conflicts: 0,
        candidate_rollouts: 1,
        eligible_rollouts: 1,
        imported: 1,
        skipped_existing: 0,
        skipped_unchanged: 0,
        skipped_checkpoint: 0,
        skipped_duplicate_source: 0,
        skipped_no_visible_messages: 0,
      };
    },
    loadCatalogs() {
      calls.push({ step: "loadCatalogs" });
      return catalogs;
    },
    async syncCatalog() {
      throw new Error("syncCatalog should not run when skipQdrantSync=true");
    },
    structuralCheck({ importSummary }) {
      calls.push({ step: "structural" });
      return runStructuralCheck({ importSummary, catalogs });
    },
  });

  assert.deepEqual(calls, [
    { step: "rollouts" },
    { step: "loadCatalogs" },
    { step: "structural" },
  ]);
  assert.equal(summary.qdrant_sync.status, "skipped");
  assert.equal(summary.structural_checks.failed, 0);
});

test("codex refresh fails fast when rollout import reports conflicts", async () => {
  await assert.rejects(
    () =>
      refreshCodexIndex({
        codexRoot: "/tmp/.codex",
        catalogRoot: "/tmp/catalog",
        importRollouts() {
          return { errors: 0, conflicts: 1 };
        },
      }),
    /codex rollout refresh reported conflicts or errors/,
  );
});
