const test = require("node:test");
const assert = require("node:assert/strict");

const { SemanticRetrievalBackend } = require("../src/retrieval/semantic-backend-interface");
const { SemanticLane } = require("../src/retrieval/lanes");
const { buildExampleCatalog } = require("./helpers/example-catalog");

class StubSemanticBackend extends SemanticRetrievalBackend {
  constructor({ catalogs }) {
    super({
      backendId: "stub-semantic-backend",
      capabilities: ["test-double"],
    });
    this.catalogs = catalogs;
  }

  async retrieve() {
    return [
      {
        recordId: this.catalogs.invariants[0].id,
        layer: "invariants",
        laneId: "semantic",
        score: 0.99,
        record: this.catalogs.invariants[0],
        reasons: ["stub semantic backend"],
      },
    ];
  }
}

test("semantic lane can be driven by a pluggable backend", async () => {
  const catalogs = buildExampleCatalog();
  const lane = new SemanticLane({
    catalogs,
    backend: new StubSemanticBackend({ catalogs }),
  });

  const candidates = await lane.execute({
    request: {
      request_id: "req_semantic_backend_stub_001",
      query: "scope guard",
      project_scope: "project_family",
      intent: "analysis",
    },
    plan: {
      allowed_layers: ["invariants"],
    },
  });

  assert.equal(candidates[0].recordId, "inv_scope_filter_before_rank_001");
  assert.equal(candidates[0].laneId, "semantic");
});
