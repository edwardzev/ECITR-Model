const test = require("node:test");
const assert = require("node:assert/strict");

const { compareSemanticBackends } = require("../src/retrieval/semantic-benchmark");
const { SemanticRetrievalBackend } = require("../src/retrieval/semantic-backend-interface");
const { buildExampleCatalog } = require("./helpers/example-catalog");

test("semantic benchmark compares heuristic and LanceDB-labeled candidate backends", async () => {
  const catalogs = buildExampleCatalog();
  const backend = new FixedSemanticBackend({
    layer: "cases",
    recordId: "case_retrieval_scope_drift_001",
    record: catalogs.cases[0],
  });

  const report = await compareSemanticBackends({
    scenarios: [
      {
        scenario_id: "bench_lancedb_001",
        request: {
          request_id: "req_bench_lancedb_001",
          query: "scope filter ranking project retrieval",
          project_scope: "project_family",
          intent: "analysis",
        },
        forbidden_results: {
          cases: ["case_retrieval_scope_drift_001"],
        },
      },
    ],
    catalogs,
    candidateBackend: backend,
    candidateLabel: "lancedb",
  });

  assert.equal(report.scenario_count, 1);
  assert.deepEqual(report.scenarios[0].lancedb.semantic_candidates.cases, ["case_retrieval_scope_drift_001"]);
  assert.equal(typeof report.scenarios[0].lancedb.timing_ms.runtime, "number");
  assert.equal(report.scenarios[0].lancedb.quality.passes, false);
  assert.deepEqual(report.scenarios[0].lancedb.quality.present_forbidden.cases, [
    "case_retrieval_scope_drift_001",
  ]);
});

test("semantic benchmark requires an explicit candidate backend", async () => {
  await assert.rejects(
    compareSemanticBackends({
      scenarios: [],
      catalogs: buildExampleCatalog(),
    }),
    /requires a candidateBackend/,
  );
});

class FixedSemanticBackend extends SemanticRetrievalBackend {
  constructor({ layer, recordId, record }) {
    super({
      backendId: "fixed-semantic-benchmark-test-backend",
      capabilities: ["test"],
    });
    this.layer = layer;
    this.recordId = recordId;
    this.record = record;
  }

  async retrieve() {
    return [
      {
        recordId: this.recordId,
        layer: this.layer,
        laneId: "semantic",
        score: 1,
        record: this.record,
        reasons: ["fixed semantic benchmark candidate"],
        semanticQualified: true,
      },
    ];
  }
}
