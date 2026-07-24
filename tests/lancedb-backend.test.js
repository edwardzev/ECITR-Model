const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  LanceDbSemanticBackend,
  buildLanceDbWhereClause,
  exportCatalogToLanceDbRows,
  getLanceDbBasisPath,
  writeLanceDbCatalogBasis,
} = require("../src/retrieval/semantic-backends/lancedb-backend");
const { buildExampleCatalog } = require("./helpers/example-catalog");

class FakeEmbedder {
  constructor() {
    this.denseVectorSize = 3;
    this.embeddingSignature = "fake:3";
  }

  async embedDocuments({ documents }) {
    return documents.map((document, index) => ({
      dense: [index + 0.1, index + 0.2, index + 0.3],
      sparse: {
        indices: [0],
        values: [document.length / 1000],
      },
    }));
  }

  async embedQuery() {
    return {
      dense: [0.1, 0.2, 0.3],
      sparse: {
        indices: [0],
        values: [1],
      },
    };
  }
}

test("lancedb exporter builds local rows from ECITR contextual records", async () => {
  const catalogs = buildExampleCatalog();
  catalogs.cases[0].status = "draft";
  catalogs.cases[0].review_state = "draft";

  const rows = await exportCatalogToLanceDbRows({
    catalogs,
    embedder: new FakeEmbedder(),
  });

  assert.equal(rows.length, 3);
  assert.equal(rows[0].layer, "tactics");
  assert.equal(rows[0].workspace_id, "ecitr_model");
  assert.equal(rows[0].embedding_signature, "fake:3");
  assert.ok(rows[0].text.includes("Layer: tactics."));
  assert.deepEqual(rows[0].vector, [0.1, 0.2, 0.3]);
  assert.equal(JSON.parse(rows[0].record_json).id, "tac_metadata_prune_before_vector_rank_001");
  assert.equal(rows.some((row) => Object.values(row).some((value) => value === null)), false);
});

test("lancedb backend sync overwrites the derived table and creates an FTS index", async () => {
  const catalogs = buildExampleCatalog();
  const calls = [];
  const uri = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-lancedb-sync-"));
  const backend = new LanceDbSemanticBackend({
    uri,
    tableName: "semantic_records",
    catalogs,
    embedder: new FakeEmbedder(),
    lancedbModule: {
      Index: {
        fts() {
          return { type: "fts" };
        },
      },
    },
    connectImpl: async (uri) => ({
      async createTable(tableName, rows, options) {
        calls.push({ type: "createTable", uri, tableName, rows, options });
        return {
          async createIndex(column, indexOptions) {
            calls.push({ type: "createIndex", column, indexOptions });
          },
        };
      },
    }),
  });

  const result = await backend.syncCatalog();

  assert.equal(result.status, "synced");
  assert.equal(calls[0].type, "createTable");
  assert.equal(calls[0].tableName, "semantic_records");
  assert.equal(calls[0].options.mode, "overwrite");
  assert.equal(calls[0].rows.length, 4);
  assert.deepEqual(calls[1], {
    type: "createIndex",
    column: "text",
    indexOptions: { config: { type: "fts" } },
  });
  const basisPath = getLanceDbBasisPath({ uri, tableName: "semantic_records" });
  const basis = JSON.parse(fs.readFileSync(basisPath, "utf8"));
  assert.equal(basis.rows_total, 4);
  assert.equal(basis.embedding_signature, "fake:3");
  assert.match(basis.catalog_hash, /^sha256:/);
});

test("lancedb backend retrieves metadata-filtered candidates through the semantic lane", async () => {
  const catalogs = buildExampleCatalog();
  const observed = {};
  const uri = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-lancedb-retrieve-"));
  writeLanceDbCatalogBasis({
    uri,
    tableName: "semantic_records",
    catalogs,
    embeddingSignature: "fake:3",
  });
  const backend = new LanceDbSemanticBackend({
    uri,
    tableName: "semantic_records",
    catalogs,
    embedder: new FakeEmbedder(),
    maximumDistance: 0.3,
    connectImpl: async () => ({
      async openTable() {
        return {
          vectorSearch(vector) {
            observed.vector = vector;
            return makeFakeQuery(observed, [
              {
                layer: "invariants",
                record_id: "inv_missing_from_canonical_catalog",
                record_json: JSON.stringify({
                  id: "inv_missing_from_canonical_catalog",
                  status: "active",
                }),
                _distance: 0.1,
              },
              {
                layer: "invariants",
                record_id: "inv_scope_filter_before_rank_001",
                record_json: JSON.stringify({
                  ...catalogs.invariants[0],
                  summary: "stale derived summary that must never be returned",
                }),
                _distance: 0.25,
              },
            ]);
          },
        };
      },
    }),
  });

  const candidates = await backend.retrieve({
    request: {
      request_id: "req_lancedb_001",
      query: "prevent unrelated project records from influencing ranking",
      workspace_id: "ecitr_model",
      project_scope: "project_family",
      intent: "analysis",
    },
    plan: {
      allowed_layers: ["tactics", "invariants", "cases", "evidence"],
      freshness_mode: "strict",
      max_results_per_layer: {
        tactics: 3,
        invariants: 5,
        cases: 6,
        evidence: 3,
      },
    },
    now: new Date("2026-05-01T00:00:00.000Z"),
  });

  assert.deepEqual(observed.vector, [0.1, 0.2, 0.3]);
  assert.match(observed.where, /workspace_id = 'ecitr_model'/);
  assert.match(observed.where, /project_scope IN \('project_family', 'global'\)/);
  assert.match(observed.where, /fresh_until != ''/);
  assert.match(observed.where, /fresh_until >= '2026-05-01T00:00:00.000Z'/);
  assert.equal(observed.limit, 17);
  assert.equal(observed.distanceType, "cosine");
  assert.equal(observed.select.includes("record_json"), false);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].recordId, "inv_scope_filter_before_rank_001");
  assert.equal(candidates[0].score, 0.8);
  assert.equal(candidates[0].semanticQualified, true);
  assert.strictEqual(candidates[0].record, catalogs.invariants[0]);
});

test("lancedb backend rejects stale basis after canonical status or workspace changes", async (t) => {
  for (const scenario of [
    {
      name: "canonical record is deprecated",
      mutate(catalogs) {
        catalogs.invariants[0].status = "deprecated";
      },
    },
    {
      name: "canonical workspace is corrected",
      mutate(catalogs) {
        catalogs.invariants[0].workspace_id = "corrected_workspace";
      },
    },
  ]) {
    await t.test(scenario.name, async () => {
      const catalogs = buildExampleCatalog();
      const uri = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-lancedb-stale-basis-"));
      writeLanceDbCatalogBasis({
        uri,
        tableName: "semantic_records",
        catalogs,
        embeddingSignature: "fake:3",
      });
      scenario.mutate(catalogs);
      const backend = new LanceDbSemanticBackend({
        uri,
        tableName: "semantic_records",
        catalogs,
        embedder: new FakeEmbedder(),
        connectImpl: async () => {
          throw new Error("stale index must be rejected before opening the table");
        },
      });

      await assert.rejects(
        () => backend.retrieve({
          request: {
            request_id: "req_lancedb_stale_basis",
            query: "canonical authority",
            workspace_id: "ecitr_model",
            project_scope: "project_family",
            intent: "analysis",
          },
          plan: {
            allowed_layers: ["invariants"],
            freshness_mode: "strict",
            max_results_per_layer: { invariants: 5 },
          },
        }),
        /basis does not match the canonical catalog/,
      );
    });
  }
});

test("lancedb where clause escapes literal values", () => {
  const where = buildLanceDbWhereClause({
    request: {
      query: "literal escape",
      workspace_id: "edward's-workspace",
      project_scope: "project's-family",
    },
    plan: {
      allowed_layers: ["cases"],
    },
  });

  assert.match(where, /workspace_id = 'edward''s-workspace'/);
  assert.match(where, /project_scope IN \('project''s-family', 'global'\)/);
});

function makeFakeQuery(observed, rows) {
  return {
    where(value) {
      observed.where = value;
      return this;
    },
    limit(value) {
      observed.limit = value;
      return this;
    },
    select(value) {
      observed.select = value;
      return this;
    },
    distanceType(value) {
      observed.distanceType = value;
      return this;
    },
    async toArray() {
      return rows;
    },
  };
}
