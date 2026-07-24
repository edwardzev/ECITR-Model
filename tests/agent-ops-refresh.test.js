const test = require("node:test");
const assert = require("node:assert/strict");

const { refreshAgentOpsIndex } = require("../src/importers/agent-ops-refresh");

test("agent-ops refresh runs imports before sync and smoke validation", async () => {
  const calls = [];
  const catalogs = {
    tactics: [],
    invariants: [],
    cases: [],
    evidence: [{ evidence_id: "ev_001" }],
    atomic_claim_sets: [],
    review_audit_entries: [],
  };

  const summary = await refreshAgentOpsIndex({
    agentOpsRoot: "/tmp/agent-ops",
    catalogRoot: "/tmp/catalog",
    qdrantUrl: "http://127.0.0.1:6333",
    collectionName: "ecitr-local-catalog-v1",
    skipQdrantSync: false,
    importRuns(options) {
      calls.push({ step: "runs", dryRun: options.dryRun });
      return { errors: 0, conflicts: 0, imported: 2, skipped_existing: 3 };
    },
    importSessions(options) {
      calls.push({ step: "sessions", dryRun: options.dryRun });
      return { errors: 0, conflicts: 0, imported: 4, skipped_existing: 5, skipped_non_terminal: 1 };
    },
    loadCatalogs() {
      calls.push({ step: "loadCatalogs" });
      return catalogs;
    },
    async syncCatalog(options) {
      calls.push({ step: "sync", recreateCollection: options.recreateCollection });
      return { points_upserted: 1 };
    },
    async smokeCheck() {
      calls.push({ step: "smoke" });
      return { passed: 3, failed: 0, scenarios: [] };
    },
  });

  assert.deepEqual(calls, [
    { step: "runs", dryRun: false },
    { step: "sessions", dryRun: false },
    { step: "loadCatalogs" },
    { step: "sync", recreateCollection: false },
    { step: "smoke" },
  ]);
  assert.equal(summary.catalog_counts.evidence, 1);
  assert.equal(summary.smoke_checks.failed, 0);
});

test("agent-ops refresh dry-run skips sync and smoke validation", async () => {
  const calls = [];

  const summary = await refreshAgentOpsIndex({
    agentOpsRoot: "/tmp/agent-ops",
    catalogRoot: "/tmp/catalog",
    dryRun: true,
    importRuns(options) {
      calls.push({ step: "runs", dryRun: options.dryRun });
      return { errors: 0, conflicts: 0, planned: 2 };
    },
    importSessions(options) {
      calls.push({ step: "sessions", dryRun: options.dryRun });
      return { errors: 0, conflicts: 0, planned: 3, skipped_non_terminal: 1 };
    },
    loadCatalogs() {
      throw new Error("loadCatalogs should not be called during dry-run");
    },
  });

  assert.deepEqual(calls, [
    { step: "runs", dryRun: true },
    { step: "sessions", dryRun: true },
  ]);
  assert.equal(summary.qdrant_sync.status, "skipped_dry_run");
  assert.equal(summary.smoke_checks.status, "skipped_dry_run");
});

test("agent-ops refresh fails fast when an import summary reports conflicts", async () => {
  await assert.rejects(
    () =>
      refreshAgentOpsIndex({
        agentOpsRoot: "/tmp/agent-ops",
        catalogRoot: "/tmp/catalog",
        importRuns() {
          return { errors: 0, conflicts: 1 };
        },
        importSessions() {
          throw new Error("sessions should not run after conflicting runs import");
        },
      }),
    /runs refresh reported conflicts or errors/,
  );
});
