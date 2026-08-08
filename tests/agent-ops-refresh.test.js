const test = require("node:test");
const assert = require("node:assert/strict");

const { refreshAgentOpsIndex } = require("../src/importers/agent-ops-refresh");

test("agent-ops refresh runs imports before loading catalog counts", async () => {
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
  });

  assert.deepEqual(calls, [
    { step: "runs", dryRun: false },
    { step: "sessions", dryRun: false },
    { step: "loadCatalogs" },
  ]);
  assert.equal(summary.catalog_counts.evidence, 1);
});

test("agent-ops refresh dry-run skips catalog loading", async () => {
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
  assert.equal(summary.catalog_counts, undefined);
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
