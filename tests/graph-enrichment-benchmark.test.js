const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { REPO_ROOT } = require("../src/validation/schema-registry");
const { readJson } = require("../src/validation/validator");
const { RetrievalRuntime } = require("../src/retrieval/runtime");
const { generateSupportGraphEnrichment } = require("../src/retrieval/support-graph-enricher");
const { refreshSupportGraph } = require("../src/support-graph/refresh");
const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const { loadExample } = require("./helpers/load-example");

test("graph enrichment benchmark scenarios stay stable", async () => {
  const scenarios = readJson(`${REPO_ROOT}/benchmarks/graph-enrichment.baseline.json`);

  for (const scenario of scenarios) {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-graph-enrichment-"));
    const graphRoot = path.join(rootDir, ".local", "support-graph");
    const catalog = materializeExampleCatalog(rootDir);
    if (scenario.graph_mode !== "missing") {
      refreshSupportGraph({
        catalogRoot: rootDir,
        graphRoot,
        builtAt: "2026-05-01T00:00:00.000Z",
      });
    }

    const catalogs = catalog.loadRuntimeCatalogs();
    if (scenario.graph_mode === "stale") {
      catalogs.tactics[0].revalidate_at = "2026-08-01T00:00:00Z";
    }

    const request = {
      request_id: `req_${scenario.scenario_id}`,
      query: "scope filter ranking project retrieval",
      project_scope: "project_family",
      intent: "analysis",
    };
    const baseRuntime = new RetrievalRuntime({ responseEnricher: null });
    const enrichedRuntime = new RetrievalRuntime({ graphRoot });
    const { plan, response: baselineResponse } = await baseRuntime.execute({
      request,
      catalogs,
      now: new Date("2026-05-01T00:00:00Z"),
    });
    const { response: enrichedResponse } = await enrichedRuntime.execute({
      request,
      catalogs,
      now: new Date("2026-05-01T00:00:00Z"),
    });
    const enrichment = generateSupportGraphEnrichment({
      response: baselineResponse,
      request,
      plan,
      catalogs,
      graphRoot,
    });

    assert.deepEqual(enrichedResponse.results, baselineResponse.results, scenario.scenario_id);
    assert.deepEqual(
      Object.values(enrichedResponse.results).flat(),
      Object.values(baselineResponse.results).flat(),
      scenario.scenario_id,
    );
    assert.equal(enrichment.diagnostics.graph_snapshot_used, scenario.expected.graph_snapshot_used, scenario.scenario_id);
    assert.equal(enrichment.diagnostics.explanation_count_added, scenario.expected.explanation_count_added, scenario.scenario_id);
    assert.equal(enrichment.diagnostics.stale_or_missing_skip_count, scenario.expected.stale_or_missing_skip_count, scenario.scenario_id);
    assert.equal(enrichment.diagnostics.wrong_scope_suppression_count, scenario.expected.wrong_scope_suppression_count, scenario.scenario_id);
  }
});

function materializeExampleCatalog(rootDir) {
  const catalog = new FileBackedCatalog({ rootDir });

  for (const recordType of [
    "evidence",
    "case",
    "invariant",
    "tactic",
    "atomic_claim_set",
    "parameter_definition",
    "parameter_observation",
  ]) {
    catalog.writeRecord(recordType, loadExample(recordType));
  }

  return catalog;
}
