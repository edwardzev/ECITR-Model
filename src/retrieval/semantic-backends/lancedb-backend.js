const fs = require("node:fs");
const path = require("node:path");

const { REPO_ROOT } = require("../../validation/schema-registry");
const { SemanticRetrievalBackend } = require("../semantic-backend-interface");
const {
  assertSemanticCatalogs,
  assertSemanticEmbedder,
  buildSemanticCatalogIndex,
  buildSemanticExportRecords,
  computeSemanticQueryLimit,
  createSemanticContentHash,
  embedSemanticExportRecords,
} = require("../semantic-export");

const DEFAULT_LANCEDB_URI = path.join(REPO_ROOT, ".local", "lancedb");
const DEFAULT_TABLE_NAME = "ecitr_semantic_records_v1";
const DEFAULT_QUERY_LIMIT = 10;
const LANCEDB_BASIS_SCHEMA_VERSION = 1;

class LanceDbSemanticBackend extends SemanticRetrievalBackend {
  constructor({
    uri = DEFAULT_LANCEDB_URI,
    tableName = DEFAULT_TABLE_NAME,
    catalogs = null,
    embedder,
    connectImpl = defaultConnect,
    lancedbModule = null,
    defaultQueryLimit = DEFAULT_QUERY_LIMIT,
    createFtsIndex = true,
    maximumDistance = null,
    fsImpl = fs,
  } = {}) {
    super({
      backendId: "lancedb-local-semantic-v1",
      capabilities: [
        "derived-index",
        "embedded-local",
        "vector-search",
        "metadata-filtering",
        "fts-index-ready",
      ],
    });

    if (!uri) {
      throw new Error("LanceDbSemanticBackend requires a uri.");
    }

    if (!tableName) {
      throw new Error("LanceDbSemanticBackend requires a tableName.");
    }

    this.uri = uri;
    this.tableName = tableName;
    this.catalogs = catalogs;
    this.embedder = assertEmbedder(embedder);
    this.connectImpl = connectImpl;
    this.lancedbModule = lancedbModule;
    this.defaultQueryLimit = defaultQueryLimit;
    this.createFtsIndex = createFtsIndex;
    this.maximumDistance = normalizeOptionalNumber(maximumDistance);
    this.fsImpl = fsImpl;
  }

  async connect() {
    return this.connectImpl(this.uri);
  }

  async openTable() {
    const db = await this.connect();
    return db.openTable(this.tableName);
  }

  async buildRows({ catalogs = this.catalogs } = {}) {
    return exportCatalogToLanceDbRows({
      catalogs,
      embedder: this.embedder,
    });
  }

  async syncCatalog({ catalogs = this.catalogs } = {}) {
    assertCatalogs(catalogs);
    const rows = await this.buildRows({ catalogs });
    clearLanceDbCatalogBasis({
      uri: this.uri,
      tableName: this.tableName,
      fsImpl: this.fsImpl,
    });
    if (rows.length === 0) {
      return {
        status: "empty_skipped",
        uri: this.uri,
        table_name: this.tableName,
        rows_total: 0,
        embedding_signature: this.embedder.embeddingSignature ?? null,
      };
    }

    const db = await this.connect();
    const table = await db.createTable(this.tableName, rows, { mode: "overwrite" });
    if (this.createFtsIndex) {
      await createTextIndex({ table, lancedbModule: this.lancedbModule });
    }
    const basis = writeLanceDbCatalogBasis({
      uri: this.uri,
      tableName: this.tableName,
      catalogs,
      embeddingSignature: this.embedder.embeddingSignature ?? null,
      fsImpl: this.fsImpl,
    });

    return {
      status: "synced",
      uri: this.uri,
      table_name: this.tableName,
      rows_total: rows.length,
      embedding_signature: this.embedder.embeddingSignature ?? null,
      basis_path: basis.filePath,
      catalog_hash: basis.manifest.catalog_hash,
    };
  }

  async retrieve({ request, plan, catalogs = this.catalogs, now = new Date() }) {
    assertCatalogs(catalogs);
    assertLanceDbCatalogBasis({
      uri: this.uri,
      tableName: this.tableName,
      catalogs,
      embeddingSignature: this.embedder.embeddingSignature ?? null,
      fsImpl: this.fsImpl,
    });
    const table = await this.openTable();
    const queryEmbedding = await this.embedder.embedQuery({ query: request.query });
    const limit = computeSemanticQueryLimit(plan, this.defaultQueryLimit);
    const whereClause = buildLanceDbWhereClause({ request, plan, now });

    let query = table
      .vectorSearch(queryEmbedding.dense)
      .where(whereClause)
      .limit(limit)
      .select([
        "row_id",
        "layer",
        "record_id",
        "_distance",
      ]);

    if (typeof query.distanceType === "function") {
      query = query.distanceType("cosine");
    }

    const rows = await query.toArray();
    return mapLanceDbRowsToCandidates({
      rows,
      catalogs,
      maximumDistance: this.maximumDistance,
    });
  }
}

async function exportCatalogToLanceDbRows({ catalogs, embedder } = {}) {
  assertCatalogs(catalogs);
  const exportedRecords = buildSemanticExportRecords(catalogs, {
    embeddingSignature: embedder.embeddingSignature ?? null,
  });
  const embeddedRecords = await embedSemanticExportRecords({ exportedRecords, embedder });

  return embeddedRecords.map(({ exportRecord, embedding }) => {
    const payload = exportRecord.payload ?? {};
    return {
      row_id: String(exportRecord.documentId),
      layer: stringColumn(payload.layer),
      record_id: stringColumn(payload.record_id),
      workspace_id: stringColumn(payload.workspace_id),
      project_scope: stringColumn(payload.project_scope),
      status: stringColumn(payload.status),
      review_state: stringColumn(payload.review_state),
      text: stringColumn(payload.text),
      embedding_signature: stringColumn(payload.embedding_signature),
      content_hash: stringColumn(payload.content_hash),
      updated_at: stringColumn(payload.updated_at),
      captured_at: stringColumn(payload.captured_at),
      derived_at: stringColumn(payload.derived_at),
      source_type: stringColumn(payload.source_type),
      actor_scope: stringColumn(payload.actor_scope),
      has_invalidation_markers: Boolean(payload.has_invalidation_markers),
      fresh_until: stringColumn(payload.fresh_until),
      record_json: JSON.stringify(payload.record ?? null),
      vector: embedding.dense,
    };
  });
}

function buildLanceDbWhereClause({ request, plan, now = new Date() }) {
  const clauses = [
    `layer IN (${sqlStringList(plan.allowed_layers ?? [])})`,
    "status IN ('active', 'immutable')",
    "project_scope != 'blocked'",
  ];

  if (request.project_scope && request.project_scope !== "global") {
    clauses.push(`project_scope IN (${sqlStringList([request.project_scope, "global"])})`);
  }

  if (request.workspace_id) {
    clauses.push(`workspace_id = ${sqlString(request.workspace_id)}`);
  }

  if (plan.freshness_mode === "strict" && (plan.allowed_layers ?? []).includes("tactics")) {
    clauses.push(
      [
        "(",
        "layer != 'tactics'",
        "OR",
        "(",
        "has_invalidation_markers = false",
        "AND fresh_until != ''",
        `AND fresh_until >= ${sqlString(new Date(now).toISOString())}`,
        ")",
        ")",
      ].join(" "),
    );
  }

  return clauses.join(" AND ");
}

function mapLanceDbRowsToCandidates({
  rows,
  catalogs,
  maximumDistance = null,
}) {
  const canonicalIndex = buildSemanticCatalogIndex(catalogs);

  return (rows ?? [])
    .map((row) => {
      const layer = normalizeLayer(row.layer);
      const recordId = row.record_id ? String(row.record_id) : null;
      const record = layer && recordId
        ? canonicalIndex.get(`${layer}:${recordId}`)
        : null;

      if (!layer || !recordId || !record) {
        return null;
      }

      return {
        recordId,
        layer,
        laneId: "semantic",
        score: scoreFromLanceDbRow(row),
        record,
        reasons: ["lancedb local semantic retrieval"],
        semanticQualified: isLanceDbRowQualified({ row, maximumDistance }),
      };
    })
    .filter(Boolean);
}

function isLanceDbRowQualified({ row, maximumDistance }) {
  if (maximumDistance == null) {
    return false;
  }
  const distance = Number(row._distance);
  return Number.isFinite(distance) && distance <= maximumDistance;
}

function scoreFromLanceDbRow(row) {
  if (Number.isFinite(Number(row._relevance_score))) {
    return Number(row._relevance_score);
  }

  if (Number.isFinite(Number(row._score))) {
    return Number(row._score);
  }

  const distance = Number(row._distance);
  if (Number.isFinite(distance)) {
    return 1 / (1 + Math.max(distance, 0));
  }

  return 0;
}

async function createTextIndex({ table, lancedbModule }) {
  if (!table || typeof table.createIndex !== "function") {
    return;
  }

  const module = lancedbModule ?? require("@lancedb/lancedb");
  await table.createIndex("text", { config: module.Index.fts() });
}

function normalizeLayer(value) {
  return ["tactics", "invariants", "cases", "evidence"].includes(value) ? value : null;
}

function sqlStringList(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return "NULL";
  }

  return values.map(sqlString).join(", ");
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function stringColumn(value) {
  return value == null ? "" : String(value);
}

function normalizeOptionalNumber(value) {
  if (value == null || value === "") {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error("Semantic relevance threshold must be a finite number.");
  }
  return number;
}

async function defaultConnect(uri) {
  const lancedb = require("@lancedb/lancedb");
  return lancedb.connect(uri);
}

function assertCatalogs(catalogs) {
  return assertSemanticCatalogs(catalogs);
}

function assertEmbedder(embedder) {
  return assertSemanticEmbedder(embedder);
}

function buildLanceDbCatalogBasis({
  tableName,
  catalogs,
  embeddingSignature = null,
} = {}) {
  assertCatalogs(catalogs);
  const exportedRecords = buildSemanticExportRecords(catalogs, {
    embeddingSignature,
  });
  const entries = exportedRecords
    .map((entry) => ({
      document_id: String(entry.documentId),
      content_hash: String(entry.payload.content_hash),
    }))
    .sort((left, right) => left.document_id.localeCompare(right.document_id));

  return {
    schema_version: LANCEDB_BASIS_SCHEMA_VERSION,
    table_name: tableName,
    catalog_root: catalogs.__catalogRoot ? path.resolve(catalogs.__catalogRoot) : null,
    rows_total: entries.length,
    embedding_signature: embeddingSignature,
    catalog_hash: createSemanticContentHash(entries),
  };
}

function getLanceDbBasisPath({ uri, tableName }) {
  if (!uri || !tableName || /^[a-z]+:\/\//i.test(String(uri))) {
    return null;
  }

  return path.join(String(uri), `${tableName}.basis.json`);
}

function writeLanceDbCatalogBasis({
  uri,
  tableName,
  catalogs,
  embeddingSignature = null,
  fsImpl = fs,
} = {}) {
  const filePath = getLanceDbBasisPath({ uri, tableName });
  if (!filePath) {
    throw new Error("LanceDB catalog basis requires a local uri and tableName.");
  }

  const manifest = buildLanceDbCatalogBasis({
    tableName,
    catalogs,
    embeddingSignature,
  });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  fsImpl.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fsImpl.renameSync(temporaryPath, filePath);
  return { filePath, manifest };
}

function clearLanceDbCatalogBasis({ uri, tableName, fsImpl = fs } = {}) {
  const filePath = getLanceDbBasisPath({ uri, tableName });
  if (filePath) {
    fsImpl.rmSync(filePath, { force: true });
  }
}

function isLanceDbCatalogBasisCurrent({
  uri,
  tableName,
  catalogs,
  embeddingSignature = null,
  fsImpl = fs,
} = {}) {
  const filePath = getLanceDbBasisPath({ uri, tableName });
  if (!filePath || !fsImpl.existsSync(filePath)) {
    return false;
  }

  try {
    const actual = JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
    const expected = buildLanceDbCatalogBasis({
      tableName,
      catalogs,
      embeddingSignature,
    });
    return [
      "schema_version",
      "table_name",
      "catalog_root",
      "rows_total",
      "embedding_signature",
      "catalog_hash",
    ].every((field) => actual[field] === expected[field]);
  } catch {
    return false;
  }
}

function assertLanceDbCatalogBasis(options = {}) {
  if (!isLanceDbCatalogBasisCurrent(options)) {
    const filePath = getLanceDbBasisPath(options) ?? "<unavailable>";
    throw new Error(
      `LanceDB semantic index basis does not match the canonical catalog: ${filePath}`,
    );
  }
}

module.exports = {
  DEFAULT_LANCEDB_URI,
  DEFAULT_TABLE_NAME,
  LanceDbSemanticBackend,
  assertLanceDbCatalogBasis,
  buildLanceDbCatalogBasis,
  buildLanceDbWhereClause,
  exportCatalogToLanceDbRows,
  getLanceDbBasisPath,
  isLanceDbCatalogBasisCurrent,
  mapLanceDbRowsToCandidates,
  writeLanceDbCatalogBasis,
};
