const test = require("node:test");
const assert = require("node:assert/strict");

const { compareSemanticBackends } = require("../src/retrieval/semantic-benchmark");
const { SemanticRetrievalBackend } = require("../src/retrieval/semantic-backend-interface");
const {
  QdrantSemanticBackend,
  exportCatalogToQdrantPoints,
} = require("../src/retrieval/semantic-backends/qdrant-backend");
const { HashSemanticEmbedder } = require("../src/retrieval/embedders/hash-embedder");
const { buildExampleCatalog } = require("./helpers/example-catalog");

test("semantic benchmark compares heuristic and qdrant reports on the same scenarios", async () => {
  const catalogs = buildExampleCatalog();
  const embedder = new HashSemanticEmbedder({ denseVectorSize: 8, sparseBucketCount: 128 });
  const indexedPoints = await exportCatalogToQdrantPoints({ catalogs, embedder });
  const backend = new QdrantSemanticBackend({
    endpoint: "http://qdrant.local",
    collectionName: "ecitr-semantic",
    catalogs,
    embedder,
    fetchImpl: async (url) => {
      if (url.endsWith("/points/scroll")) {
        return {
          ok: true,
          json: async () => ({
            result: {
              points: indexedPoints.map((point) => ({
                id: point.id,
                payload: { content_hash: point.payload.content_hash },
              })),
              next_page_offset: null,
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          result: {
            points: [
              {
                id: "tactics:tac_metadata_prune_before_vector_rank_001",
                score: 0.9,
                payload: {
                  layer: "tactics",
                  record_id: "tac_metadata_prune_before_vector_rank_001",
                  record: catalogs.tactics[0],
                },
              },
            ],
          },
        }),
      };
    },
  });

  const report = await compareSemanticBackends({
    scenarios: [
      {
        scenario_id: "bench_001",
        request: {
          request_id: "req_bench_001",
          query: "scope filter ranking project retrieval",
          project_scope: "project_family",
          intent: "analysis",
        },
        expected_results: {
          tactics: ["tac_metadata_prune_before_vector_rank_001"],
        },
      },
      {
        scenario_id: "bench_002",
        request: {
          request_id: "req_bench_002",
          query: "ECITR_QDRANT_URL",
          project_scope: "project_family",
          intent: "analysis",
        },
      },
    ],
    catalogs,
    qdrantBackend: backend,
  });

  assert.equal(report.scenario_count, 2);
  assert.equal(report.scenarios[0].scenario_id, "bench_001");
  assert.equal(report.scenarios[1].scenario_id, "bench_002");
  assert.ok(report.scenarios[0].qdrant.runtime_results.tactics.includes("tac_metadata_prune_before_vector_rank_001"));
  assert.equal(typeof report.scenarios[0].qdrant.timing_ms.semantic, "number");
  assert.equal(report.scenarios[0].qdrant.quality.passes, true);
  assert.equal(report.quality_summary.qdrant.passing_scenarios, 1);
});

test("semantic benchmark can compare heuristic and lancedb-labeled candidate backends", async () => {
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
