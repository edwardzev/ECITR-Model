const test = require("node:test");
const assert = require("node:assert/strict");

const { compareSemanticBackends } = require("../src/retrieval/semantic-benchmark");
const { QdrantSemanticBackend } = require("../src/retrieval/semantic-backends/qdrant-backend");
const { HashSemanticEmbedder } = require("../src/retrieval/embedders/hash-embedder");
const { buildExampleCatalog } = require("./helpers/example-catalog");

test("semantic benchmark compares heuristic and qdrant reports on the same scenarios", async () => {
  const catalogs = buildExampleCatalog();
  const backend = new QdrantSemanticBackend({
    endpoint: "http://qdrant.local",
    collectionName: "ecitr-semantic",
    catalogs,
    embedder: new HashSemanticEmbedder({ denseVectorSize: 8, sparseBucketCount: 128 }),
    fetchImpl: async () => ({
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
    }),
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
      },
    ],
    catalogs,
    qdrantBackend: backend,
  });

  assert.equal(report.scenario_count, 1);
  assert.equal(report.scenarios[0].scenario_id, "bench_001");
  assert.ok(report.scenarios[0].qdrant.runtime_results.tactics.includes("tac_metadata_prune_before_vector_rank_001"));
});
