const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { runAutonomousRefresh } = require("../src/cli/refresh-autonomous");

test("autonomous refresh still refreshes the support graph after upstream failures", async () => {
  const events = [];

  const result = await runAutonomousRefresh({
    skipLanceDbSync: true,
    refreshCodexIndexImpl() {
      events.push("codex");
      throw new Error("codex import failed");
    },
    refreshAgentOpsIndexImpl() {
      events.push("agent_ops");
      throw new Error("agent-ops import failed");
    },
    refreshParametersImpl() {
      events.push("parameters");
      return { errors: 1, conflicts: 1 };
    },
    refreshCasesImpl(options) {
      assert.equal(options.includeLegacyAutodistill, false);
      events.push("cases");
      return { errors: 2 };
    },
    runGovernedPromotionImpl() {
      events.push("promotions");
      throw new Error("promotion failed");
    },
    refreshSupportGraphImpl() {
      events.push("support_graph");
      return {
        status: "updated",
        catalog_root: "/Users/edwardzev/ECITR-Model/.local/catalog",
        graph_root: "/Users/edwardzev/ECITR-Model/.local/support-graph",
      };
    },
    now: () => "2026-05-04T12:00:00.000Z",
  });

  assert.deepEqual(events, ["codex", "agent_ops", "parameters", "cases", "promotions", "support_graph"]);
  assert.equal(result.ok, false);
  assert.equal(result.support_graph.status, "updated");
  assert.deepEqual(result.errors.map((error) => error.stage), ["codex", "agent_ops", "parameters", "cases", "promotions"]);
});

test("autonomous refresh reuses support graph refreshed by governed promotion", async () => {
  const events = [];

  const result = await runAutonomousRefresh({
    skipLanceDbSync: true,
    refreshCodexIndexImpl() {
      events.push("codex");
      return { imported: 0 };
    },
    refreshAgentOpsIndexImpl() {
      events.push("agent_ops");
      return { runs: { written: 1 }, sessions: { written: 1 } };
    },
    refreshParametersImpl() {
      events.push("parameters");
      return { errors: 0, conflicts: 0 };
    },
    refreshCasesImpl(options) {
      assert.equal(options.includeLegacyAutodistill, false);
      events.push("cases");
      return { errors: 0 };
    },
    runGovernedPromotionImpl({ supportGraphRefresher }) {
      events.push("promotions");
      const supportGraph = supportGraphRefresher({ graphRoot: "/tmp/promotion-graph" });
      return { support_graph: supportGraph };
    },
    refreshSupportGraphImpl(options) {
      events.push(`support_graph:${options.graphRoot}`);
      return {
        status: "updated",
        graph_root: options.graphRoot,
      };
    },
    now: () => "2026-05-04T12:00:00.000Z",
  });

  assert.deepEqual(events, ["codex", "agent_ops", "parameters", "cases", "promotions", "support_graph:/tmp/promotion-graph"]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.agent_ops, { runs: { written: 1 }, sessions: { written: 1 } });
  assert.equal(result.support_graph.graph_root, "/tmp/promotion-graph");
});

test("autonomous refresh treats benign parameter conflicts as warnings", async () => {
  const result = await runAutonomousRefresh({
    skipLanceDbSync: true,
    refreshCodexIndexImpl() {
      return { imported: 0 };
    },
    refreshAgentOpsIndexImpl() {
      return { runs: { imported: 0 }, sessions: { imported: 0 } };
    },
    refreshParametersImpl() {
      return { errors: 0, conflicts: 0, benign_conflicts: 7 };
    },
    refreshCasesImpl() {
      return { errors: 0 };
    },
    runGovernedPromotionImpl({ supportGraphRefresher }) {
      return { support_graph: supportGraphRefresher({ graphRoot: "/tmp/benign-graph" }) };
    },
    refreshSupportGraphImpl(options) {
      return {
        status: "updated",
        graph_root: options.graphRoot,
      };
    },
    now: () => "2026-05-07T03:30:00.000Z",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].stage, "parameters");
  assert.deepEqual(result.warnings[0].details, { benign_conflicts: 7 });
});

test("autonomous refresh treats material parameter conflicts as errors", async () => {
  const result = await runAutonomousRefresh({
    skipLanceDbSync: true,
    refreshCodexIndexImpl() {
      return { imported: 0 };
    },
    refreshAgentOpsIndexImpl() {
      return { runs: { imported: 0 }, sessions: { imported: 0 } };
    },
    refreshParametersImpl() {
      return { errors: 0, conflicts: 2, benign_conflicts: 7 };
    },
    refreshCasesImpl() {
      return { errors: 0 };
    },
    runGovernedPromotionImpl({ supportGraphRefresher }) {
      return { support_graph: supportGraphRefresher({ graphRoot: "/tmp/material-graph" }) };
    },
    refreshSupportGraphImpl(options) {
      return {
        status: "updated",
        graph_root: options.graphRoot,
      };
    },
    now: () => "2026-05-07T03:35:00.000Z",
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].stage, "parameters");
  assert.deepEqual(result.errors[0].details, {
    errors: 0,
    material_conflicts: 2,
    benign_conflicts: 7,
  });
  assert.deepEqual(result.warnings, []);
});

test("autonomous refresh syncs LanceDB even when promotion gates fail", async () => {
  const events = [];
  const catalogs = { evidence: [] };

  const result = await runAutonomousRefresh({
    refreshCodexIndexImpl() {
      events.push("codex");
      return { imported: 0 };
    },
    refreshAgentOpsIndexImpl() {
      events.push("agent_ops");
      return { imported: 0 };
    },
    refreshParametersImpl() {
      events.push("parameters");
      return { errors: 0, conflicts: 0 };
    },
    refreshCasesImpl() {
      events.push("cases");
      return { errors: 0 };
    },
    runGovernedPromotionImpl(options) {
      assert.equal(options.skipLanceDbSync, true);
      events.push("promotions");
      const error = new Error("tactic discovery benchmark is not clean");
      error.benchmark = {
        benchmark_id: "tactic-live",
        mismatches_expected: 1,
      };
      throw error;
    },
    refreshSupportGraphImpl() {
      events.push("support_graph");
      return { status: "updated" };
    },
    loadRuntimeCatalogsImpl() {
      events.push("load_catalogs");
      return catalogs;
    },
    syncLanceDbCatalogImpl(options) {
      assert.equal(options.catalogs, catalogs);
      events.push("lancedb_sync");
      return { status: "synced", rows_total: 0 };
    },
    now: () => "2026-07-24T04:15:00.000Z",
  });

  assert.deepEqual(events, [
    "codex",
    "agent_ops",
    "parameters",
    "cases",
    "promotions",
    "support_graph",
    "load_catalogs",
    "lancedb_sync",
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.lancedb_sync.status, "synced");
  const promotionError = result.errors.find((error) => error.stage === "promotions");
  assert.equal(promotionError.error.benchmark.benchmark_id, "tactic-live");
});

test("autonomous refresh isolates derived state for a non-default catalog", async () => {
  const catalogRoot = "/tmp/ecitr-autonomous-isolation/.local/catalog";
  const expectedGraphRoot = "/tmp/ecitr-autonomous-isolation/.local/support-graph";
  const expectedLanceDbUri = "/tmp/ecitr-autonomous-isolation/.local/lancedb";
  const catalogs = { evidence: [] };

  const result = await runAutonomousRefresh({
    catalogRoot,
    refreshCodexIndexImpl() {
      return { imported: 0 };
    },
    refreshAgentOpsIndexImpl() {
      return { imported: 0 };
    },
    refreshParametersImpl() {
      return { errors: 0, conflicts: 0 };
    },
    refreshCasesImpl() {
      return { errors: 0 };
    },
    runGovernedPromotionImpl(options) {
      assert.equal(options.catalogRoot, path.resolve(catalogRoot));
      assert.equal(options.supportGraphRoot, path.resolve(expectedGraphRoot));
      throw new Error("promotion blocked");
    },
    refreshSupportGraphImpl(options) {
      assert.equal(options.catalogRoot, path.resolve(catalogRoot));
      assert.equal(options.graphRoot, path.resolve(expectedGraphRoot));
      return { status: "updated", graph_root: options.graphRoot };
    },
    loadRuntimeCatalogsImpl() {
      return catalogs;
    },
    syncLanceDbCatalogImpl(options) {
      assert.equal(options.uri, path.resolve(expectedLanceDbUri));
      assert.equal(options.tableName, "ecitr_semantic_records_v1");
      return { status: "synced" };
    },
    now: () => "2026-07-24T04:15:00.000Z",
  });

  assert.equal(result.catalog_root, path.resolve(catalogRoot));
  assert.equal(result.support_graph.graph_root, path.resolve(expectedGraphRoot));
  assert.equal(result.lancedb_sync.status, "synced");
});
