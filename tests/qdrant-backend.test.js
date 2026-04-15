const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  QdrantSemanticBackend,
  exportCatalogToQdrantPoints,
  buildQdrantPayloadFilter,
  toQdrantPointId,
} = require("../src/retrieval/semantic-backends/qdrant-backend");
const { buildExampleCatalog } = require("./helpers/example-catalog");

class FakeEmbedder {
  constructor() {
    this.denseVectorSize = 3;
    this.embeddingSignature = "fake:3:2";
  }

  async embedDocuments({ documents }) {
    return documents.map((document, index) => ({
      dense: [index + 0.1, index + 0.2, index + 0.3],
      sparse: {
        indices: [0, 1],
        values: [document.length / 1000, 0.5],
      },
    }));
  }

  async embedQuery() {
    return {
      dense: [0.01, 0.02, 0.03],
      sparse: {
        indices: [1, 4],
        values: [0.7, 0.4],
      },
    };
  }
}

test("qdrant exporter builds contextual points from the runtime catalog", async () => {
  const catalogs = buildExampleCatalog();
  catalogs.cases[0].status = "draft";
  catalogs.cases[0].review_state = "draft";
  const points = await exportCatalogToQdrantPoints({
    catalogs,
    embedder: new FakeEmbedder(),
  });

  assert.equal(points.length, 3);
  assert.match(points[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(points[0].id, toQdrantPointId("tactics", "tac_metadata_prune_before_vector_rank_001"));
  assert.equal(points[0].payload.layer, "tactics");
  assert.equal(points[0].payload.embedding_signature, "fake:3:2");
  assert.match(points[0].payload.content_hash, /^sha256:/);
  assert.ok(points[2].payload.text.includes("Claims:"));
});

test("qdrant exporter includes payload-derived evidence text from the catalog sidecar", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-qdrant-export-"));
  const payloadRef = "payloads/evidence/agent-ops/runs/2026/04/ev_aops_run_test_002.json";
  const payloadPath = path.join(tempRoot, payloadRef);

  fs.mkdirSync(path.dirname(payloadPath), { recursive: true });
  fs.writeFileSync(payloadPath, `${JSON.stringify({
    id: "run_test_002",
    objective: "Import the live agent-ops evidence catalog into Qdrant.",
    findings: [
      "The current corpus contains imported run and session evidence.",
    ],
  }, null, 2)}\n`);

  const catalogs = {
    tactics: [],
    invariants: [],
    cases: [],
    evidence: [
      {
        evidence_id: "ev_aops_run_test_002",
        substrate_ref: "file:///tmp/run_test_002.json",
        source_type: "file",
        source_locator: "/tmp/run_test_002.json",
        captured_at: "2026-04-11T10:00:00.000Z",
        project_scope: "project",
        actor_scope: "mixed",
        verbatim_payload_ref: payloadRef,
        payload_hash: "sha256:test",
        source_hash: "sha256:test",
        redaction_state: "none",
        immutable: true,
      },
    ],
    atomic_claim_sets: [],
  };

  Object.defineProperty(catalogs, "__catalogRoot", {
    value: tempRoot,
    enumerable: false,
  });

  const points = await exportCatalogToQdrantPoints({
    catalogs,
    embedder: new FakeEmbedder(),
  });

  assert.equal(points.length, 1);
  assert.ok(points[0].payload.text.includes("objective: Import the live agent-ops evidence catalog into Qdrant."));
  assert.ok(points[0].payload.text.includes("findings: The current corpus contains imported run and session evidence."));
});

test("qdrant payload filter constrains layers and scope", () => {
  const filter = buildQdrantPayloadFilter({
    request: {
      request_id: "req_filter_001",
      query: "scope filtering",
      project_scope: "project_family",
      intent: "analysis",
    },
    plan: {
      allowed_layers: ["tactics", "invariants", "cases", "evidence"],
      max_results_per_layer: {
        tactics: 3,
        invariants: 5,
        cases: 6,
        evidence: 3,
      },
    },
  });

  assert.deepEqual(filter.must[0].match.any, ["tactics", "invariants", "cases", "evidence"]);
  assert.equal(filter.should[0].match.value, "project_family");
  assert.equal(filter.should[1].match.value, "global");
});

test("qdrant payload filter pushes strict tactic freshness into qdrant", () => {
  const filter = buildQdrantPayloadFilter({
    request: {
      request_id: "req_filter_002",
      query: "latest tactic guidance",
      project_scope: "project_family",
      intent: "action",
    },
    plan: {
      allowed_layers: ["tactics", "evidence"],
      freshness_mode: "strict",
      max_results_per_layer: {
        tactics: 3,
        evidence: 3,
      },
    },
    now: new Date("2026-05-01T00:00:00.000Z"),
  });

  const freshnessClause = filter.must.at(-1);
  assert.deepEqual(freshnessClause.should[0].match.any, ["invariants", "cases", "evidence"]);
  assert.equal(freshnessClause.should[1].must[0].match.value, "tactics");
  assert.equal(freshnessClause.should[1].must[2].range.gte, "2026-05-01T00:00:00.000Z");
});

test("qdrant backend builds a hybrid query and maps payload-backed results", async () => {
  const catalogs = buildExampleCatalog();
  const fetchCalls = [];
  const backend = new QdrantSemanticBackend({
    endpoint: "http://qdrant.local",
    collectionName: "ecitr-semantic",
    catalogs,
    embedder: new FakeEmbedder(),
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      return {
        ok: true,
        json: async () => ({
          result: {
            points: [
              {
                id: "invariants:inv_scope_filter_before_rank_001",
                score: 0.93,
                payload: {
                  layer: "invariants",
                  record_id: "inv_scope_filter_before_rank_001",
                  record: catalogs.invariants[0],
                },
              },
            ],
          },
        }),
      };
    },
  });

  const candidates = await backend.retrieve({
    request: {
      request_id: "req_qdrant_query_001",
      query: "prevent unrelated project records from influencing ranking",
      project_scope: "project_family",
      intent: "analysis",
    },
    plan: {
      allowed_layers: ["tactics", "invariants", "cases", "evidence"],
      max_results_per_layer: {
        tactics: 3,
        invariants: 5,
        cases: 6,
        evidence: 3,
      },
    },
  });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "http://qdrant.local/collections/ecitr-semantic/points/query");
  const body = JSON.parse(fetchCalls[0].options.body);
  assert.equal(body.prefetch.length, 2);
  assert.equal(body.query.fusion, "rrf");
  assert.equal(candidates[0].recordId, "inv_scope_filter_before_rank_001");
});

test("qdrant backend can build and execute a catalog upsert operation", async () => {
  const catalogs = buildExampleCatalog();
  const fetchCalls = [];
  const backend = new QdrantSemanticBackend({
    endpoint: "http://qdrant.local",
    collectionName: "ecitr-semantic",
    catalogs,
    embedder: new FakeEmbedder(),
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ status: "ok" }),
      };
    },
  });

  const operation = await backend.buildUpsertOperation();
  assert.equal(operation.points.length, 4);

  const result = await backend.upsertCatalog();
  assert.equal(fetchCalls[0].url, "http://qdrant.local/collections/ecitr-semantic/points?wait=true");
  assert.equal(result.operation.points.length, 4);
});

test("qdrant backend sync only re-embeds changed records", async () => {
  const baselineCatalogs = buildExampleCatalog();
  const baselinePoints = await exportCatalogToQdrantPoints({
    catalogs: baselineCatalogs,
    embedder: new FakeEmbedder(),
  });

  const catalogs = buildExampleCatalog();
  catalogs.invariants[0].summary = "Updated summary to force a content hash change.";

  class RecordingEmbedder extends FakeEmbedder {
    constructor() {
      super();
      this.documentBatches = [];
    }

    async embedDocuments({ documents }) {
      this.documentBatches.push(documents);
      return super.embedDocuments({ documents });
    }
  }

  const embedder = new RecordingEmbedder();
  const fetchCalls = [];
  const backend = new QdrantSemanticBackend({
    endpoint: "http://qdrant.local",
    collectionName: "ecitr-semantic",
    catalogs,
    embedder,
    fetchImpl: async (url, options = {}) => {
      fetchCalls.push({ url, options });
      if (url.endsWith("/points/scroll")) {
        return {
          ok: true,
          json: async () => ({
            result: {
              points: baselinePoints.map((point) => ({
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
        json: async () => ({ status: "ok" }),
      };
    },
  });

  const result = await backend.syncCatalog();

  assert.equal(result.plan.exportedRecords.length, 4);
  assert.equal(result.plan.pointsToUpsert.length, 1);
  assert.deepEqual(embedder.documentBatches.map((batch) => batch.length), [1]);
  assert.equal(fetchCalls[0].url, "http://qdrant.local/collections/ecitr-semantic/points/scroll");
  assert.equal(fetchCalls[1].url, "http://qdrant.local/collections/ecitr-semantic/points?wait=true");
  const upsertBody = JSON.parse(fetchCalls[1].options.body);
  assert.equal(upsertBody.points.length, 1);
  assert.equal(upsertBody.points[0].payload.record_id, "inv_scope_filter_before_rank_001");
});

test("qdrant backend recreates a collection by deleting before create", async () => {
  const catalogs = buildExampleCatalog();
  const fetchCalls = [];
  const backend = new QdrantSemanticBackend({
    endpoint: "http://qdrant.local",
    collectionName: "ecitr-semantic",
    catalogs,
    embedder: new FakeEmbedder(),
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "ok" }),
      };
    },
  });

  await backend.ensureCollection({ recreate: true });

  assert.equal(fetchCalls[0].options.method, "DELETE");
  assert.equal(fetchCalls[1].options.method, "PUT");
  assert.equal(fetchCalls[1].url, "http://qdrant.local/collections/ecitr-semantic");
});

test("qdrant backend treats an existing collection as idempotent success", async () => {
  const catalogs = buildExampleCatalog();
  const backend = new QdrantSemanticBackend({
    endpoint: "http://qdrant.local",
    collectionName: "ecitr-semantic",
    catalogs,
    embedder: new FakeEmbedder(),
    fetchImpl: async () => ({
      ok: false,
      status: 409,
      json: async () => ({ status: "already_exists" }),
      text: async () => '{"status":{"error":"collection exists"}}',
    }),
  });

  const response = await backend.ensureCollection();
  assert.equal(response.status, "already_exists");
});
