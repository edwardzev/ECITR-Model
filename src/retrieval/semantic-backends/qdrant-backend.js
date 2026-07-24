const { SemanticRetrievalBackend } = require("../semantic-backend-interface");
const {
  assertSemanticCatalogs,
  assertSemanticEmbedder,
  assertSemanticEmbedding,
  buildContextualText,
  buildSemanticCatalogIndex,
  buildSemanticExportRecords,
  computeSemanticQueryLimit,
  embedSemanticExportRecords,
  toSemanticDocumentId,
} = require("../semantic-export");

const DEFAULT_DENSE_VECTOR_NAME = "dense";
const DEFAULT_SPARSE_VECTOR_NAME = "sparse";
const DEFAULT_PREFETCH_LIMIT = 20;
const DEFAULT_QUERY_LIMIT = 10;
const DEFAULT_DISTANCE = "Cosine";
const DEFAULT_SCROLL_LIMIT = 256;
const STRICT_TACTIC_FRESHNESS_NON_TACTIC_LAYERS = Object.freeze(["invariants", "cases", "evidence"]);

class QdrantSemanticBackend extends SemanticRetrievalBackend {
  constructor({
    endpoint,
    collectionName,
    catalogs = null,
    embedder,
    fetchImpl = globalThis.fetch,
    denseVectorName = DEFAULT_DENSE_VECTOR_NAME,
    sparseVectorName = DEFAULT_SPARSE_VECTOR_NAME,
    prefetchLimit = DEFAULT_PREFETCH_LIMIT,
    defaultQueryLimit = DEFAULT_QUERY_LIMIT,
    minimumRelevanceScore = null,
  }) {
    super({
      backendId: "qdrant-hybrid-prototype-v1",
      capabilities: [
        "derived-index",
        "dense-sparse-hybrid",
        "payload-filtering",
        "rrf-fusion",
      ],
    });

    if (!endpoint) {
      throw new Error("QdrantSemanticBackend requires an endpoint.");
    }

    if (!collectionName) {
      throw new Error("QdrantSemanticBackend requires a collectionName.");
    }

    this.endpoint = stripTrailingSlash(endpoint);
    this.collectionName = collectionName;
    this.catalogs = catalogs;
    this.embedder = assertEmbedder(embedder);
    this.fetchImpl = assertFetch(fetchImpl);
    this.denseVectorName = denseVectorName;
    this.sparseVectorName = sparseVectorName;
    this.prefetchLimit = prefetchLimit;
    this.defaultQueryLimit = defaultQueryLimit;
    this.minimumRelevanceScore = normalizeOptionalNumber(minimumRelevanceScore);
  }

  async ensureCollection({ denseVectorSize, recreate = false } = {}) {
    const size = denseVectorSize ?? this.embedder.denseVectorSize;
    if (!Number.isInteger(size) || size <= 0) {
      throw new Error("QdrantSemanticBackend.ensureCollection requires a positive dense vector size.");
    }

    if (recreate) {
      await executeQdrantDeleteIfExists({
        fetchImpl: this.fetchImpl,
        endpoint: this.endpoint,
        path: `/collections/${this.collectionName}`,
      });
    }

    const path = `/collections/${this.collectionName}`;
    const body = {
      vectors: {
        [this.denseVectorName]: {
          size,
          distance: DEFAULT_DISTANCE,
        },
      },
      sparse_vectors: {
        [this.sparseVectorName]: {},
      },
    };

    return executeQdrantCreateCollection({
      fetchImpl: this.fetchImpl,
      endpoint: this.endpoint,
      path,
      body,
    });
  }

  async buildUpsertOperation({ catalogs = this.catalogs } = {}) {
    assertCatalogs(catalogs);
    const exportedRecords = buildSemanticExportRecords(catalogs, {
      embeddingSignature: this.embedder.embeddingSignature ?? null,
    });
    const points = await exportRecordsToQdrantPoints({
      exportedRecords,
      embedder: this.embedder,
      denseVectorName: this.denseVectorName,
      sparseVectorName: this.sparseVectorName,
    });

    return {
      method: "PUT",
      path: `/collections/${this.collectionName}/points?wait=true`,
      body: { points },
      points,
    };
  }

  async upsertCatalog({ catalogs = this.catalogs } = {}) {
    const operation = await this.buildUpsertOperation({ catalogs });

    const response = await executeQdrantRequest({
      fetchImpl: this.fetchImpl,
      endpoint: this.endpoint,
      path: operation.path,
      method: operation.method,
      body: operation.body,
    });

    return {
      operation,
      response,
    };
  }

  async buildSyncPlan({ catalogs = this.catalogs } = {}) {
    assertCatalogs(catalogs);
    const exportedRecords = buildSemanticExportRecords(catalogs, {
      embeddingSignature: this.embedder.embeddingSignature ?? null,
    });
    const existingPointHashes = await this.fetchExistingPointHashes();
    const desiredPointIds = new Set(exportedRecords.map((entry) => entry.documentId));
    const recordsToUpsert = exportedRecords.filter(
      (entry) => existingPointHashes.get(entry.documentId) !== entry.payload?.content_hash,
    );
    const pointIdsToDelete = [...existingPointHashes.keys()].filter((pointId) => !desiredPointIds.has(pointId));
    const pointsToUpsert = await exportRecordsToQdrantPoints({
      exportedRecords: recordsToUpsert,
      embedder: this.embedder,
      denseVectorName: this.denseVectorName,
      sparseVectorName: this.sparseVectorName,
    });

    return {
      exportedRecords,
      pointsToUpsert,
      pointIdsToDelete,
      existingCount: existingPointHashes.size,
    };
  }

  async syncCatalog({ catalogs = this.catalogs } = {}) {
    const plan = await this.buildSyncPlan({ catalogs });
    let upsertResponse = null;
    let deleteResponse = null;

    if (plan.pointsToUpsert.length > 0) {
      upsertResponse = await executeQdrantRequest({
        fetchImpl: this.fetchImpl,
        endpoint: this.endpoint,
        path: `/collections/${this.collectionName}/points?wait=true`,
        method: "PUT",
        body: { points: plan.pointsToUpsert },
      });
    }

    if (plan.pointIdsToDelete.length > 0) {
      deleteResponse = await executeQdrantRequest({
        fetchImpl: this.fetchImpl,
        endpoint: this.endpoint,
        path: `/collections/${this.collectionName}/points/delete?wait=true`,
        method: "POST",
        body: {
          points: plan.pointIdsToDelete,
        },
      });
    }

    return {
      plan,
      upsertResponse,
      deleteResponse,
    };
  }

  async fetchExistingPointHashes() {
    const hashes = new Map();
    let offset = undefined;

    do {
      const response = await executeQdrantRequest({
        fetchImpl: this.fetchImpl,
        endpoint: this.endpoint,
        path: `/collections/${this.collectionName}/points/scroll`,
        method: "POST",
        body: {
          limit: DEFAULT_SCROLL_LIMIT,
          offset,
          with_payload: ["content_hash"],
          with_vector: false,
        },
      });

      const points = Array.isArray(response?.result?.points) ? response.result.points : [];
      for (const point of points) {
        hashes.set(String(point.id), point.payload?.content_hash ?? null);
      }

      offset = response?.result?.next_page_offset;
    } while (offset != null);

    return hashes;
  }

  async retrieve({ request, plan, catalogs = this.catalogs, now = new Date() }) {
    assertCatalogs(catalogs);
    await this.assertCurrentCatalogCoverage({ catalogs });
    const queryEmbedding = await this.embedder.embedQuery({ query: request.query });
    const limit = computeSemanticQueryLimit(plan, this.defaultQueryLimit);
    const prefetchLimit = Math.max(this.prefetchLimit, limit);
    const filter = buildQdrantPayloadFilter({ request, plan, now });

    const body = {
      prefetch: [
        {
          query: queryEmbedding.sparse,
          using: this.sparseVectorName,
          limit: prefetchLimit,
          filter,
        },
        {
          query: queryEmbedding.dense,
          using: this.denseVectorName,
          limit: prefetchLimit,
          filter,
        },
      ],
      query: { fusion: "rrf" },
      limit,
      with_payload: true,
    };

    const response = await executeQdrantRequest({
      fetchImpl: this.fetchImpl,
      endpoint: this.endpoint,
      path: `/collections/${this.collectionName}/points/query`,
      method: "POST",
      body,
    });

    const points = Array.isArray(response?.result?.points)
      ? response.result.points
      : Array.isArray(response?.result)
        ? response.result
        : [];

    return mapQdrantPointsToCandidates({
      points,
      catalogs,
      minimumRelevanceScore: this.minimumRelevanceScore,
    });
  }

  async assertCurrentCatalogCoverage({ catalogs = this.catalogs } = {}) {
    assertCatalogs(catalogs);
    const exportedRecords = buildSemanticExportRecords(catalogs, {
      embeddingSignature: this.embedder.embeddingSignature ?? null,
    });
    const existingPointHashes = await this.fetchExistingPointHashes();
    const mismatches = diffSemanticIndexCoverage({
      exportedRecords,
      existingPointHashes,
    });

    if (mismatches.length > 0) {
      throw new Error(
        `Qdrant semantic index does not match the canonical catalog: ${mismatches.join("; ")}`,
      );
    }
  }
}

async function exportCatalogToQdrantPoints({
  catalogs,
  embedder,
  denseVectorName = DEFAULT_DENSE_VECTOR_NAME,
  sparseVectorName = DEFAULT_SPARSE_VECTOR_NAME,
}) {
  assertCatalogs(catalogs);
  const exportedRecords = buildSemanticExportRecords(catalogs, {
    embeddingSignature: embedder.embeddingSignature ?? null,
  });

  return exportRecordsToQdrantPoints({
    exportedRecords,
    embedder,
    denseVectorName,
    sparseVectorName,
  });
}

async function exportRecordsToQdrantPoints({
  exportedRecords,
  embedder,
  denseVectorName = DEFAULT_DENSE_VECTOR_NAME,
  sparseVectorName = DEFAULT_SPARSE_VECTOR_NAME,
}) {
  if (!Array.isArray(exportedRecords)) {
    throw new Error("exportRecordsToQdrantPoints requires an exportedRecords array.");
  }

  const embeddedRecords = await embedSemanticExportRecords({ exportedRecords, embedder });
  return embeddedRecords.map(({ exportRecord, embedding }) => {
    assertEmbedding(embedding, "document");

    return {
      id: exportRecord.documentId,
      vector: {
        [denseVectorName]: embedding.dense,
        [sparseVectorName]: embedding.sparse,
      },
      payload: exportRecord.payload,
    };
  });
}

function buildQdrantPayloadFilter({ request, plan, now = new Date() }) {
  const filter = {
    must: [
      {
        key: "layer",
        match: {
          any: plan.allowed_layers,
        },
      },
      {
        key: "status",
        match: {
          any: ["active", "immutable"],
        },
      },
    ],
    must_not: [
      {
        key: "project_scope",
        match: {
          value: "blocked",
        },
      },
    ],
  };

  if (plan.freshness_mode === "strict" && plan.allowed_layers.includes("tactics")) {
    filter.must.push(buildStrictTacticFreshnessFilter({ now }));
  }

  if (request.project_scope !== "global") {
    filter.should = [
      {
        key: "project_scope",
        match: {
          value: request.project_scope,
        },
      },
      {
        key: "project_scope",
        match: {
          value: "global",
        },
      },
    ];
  }

  if (request.workspace_id) {
    filter.must.push({
      key: "workspace_id",
      match: {
        value: request.workspace_id,
      },
    });
  }

  return filter;
}

function buildStrictTacticFreshnessFilter({ now }) {
  return {
    should: [
      {
        key: "layer",
        match: {
          any: STRICT_TACTIC_FRESHNESS_NON_TACTIC_LAYERS,
        },
      },
      {
        must: [
          {
            key: "layer",
            match: {
              value: "tactics",
            },
          },
          {
            key: "has_invalidation_markers",
            match: {
              value: false,
            },
          },
          {
            key: "fresh_until",
            range: {
              gte: new Date(now).toISOString(),
            },
          },
        ],
      },
    ],
  };
}

function mapQdrantPointsToCandidates({
  points,
  catalogs,
  minimumRelevanceScore = null,
}) {
  const canonicalIndex = buildSemanticCatalogIndex(catalogs);

  return points
    .map((point) => {
      const payload = point.payload ?? {};
      const layer = normalizeLayer(payload.layer);
      const recordId = String(payload.record_id ?? point.id).replace(/^[^:]+:/, "");
      const record = layer
        ? canonicalIndex.get(`${layer}:${recordId}`)
        : null;

      if (!layer || !recordId || !record) {
        return null;
      }

      return {
        recordId,
        layer,
        laneId: "semantic",
        score: Number(point.score ?? 0),
        record,
        reasons: ["qdrant hybrid semantic retrieval"],
        semanticQualified: minimumRelevanceScore != null
          && Number(point.score ?? 0) >= minimumRelevanceScore,
      };
    })
    .filter(Boolean);
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

function diffSemanticIndexCoverage({ exportedRecords, existingPointHashes }) {
  const expectedPointHashes = new Map(
    exportedRecords.map((entry) => [String(entry.documentId), entry.payload?.content_hash ?? null]),
  );
  const mismatches = [];

  if (expectedPointHashes.size !== existingPointHashes.size) {
    mismatches.push(`expected ${expectedPointHashes.size} point(s), found ${existingPointHashes.size}`);
  }

  for (const [pointId, contentHash] of expectedPointHashes) {
    if (!existingPointHashes.has(pointId)) {
      mismatches.push(`missing canonical point ${pointId}`);
      continue;
    }
    if (existingPointHashes.get(pointId) !== contentHash) {
      mismatches.push(`content hash mismatch for ${pointId}`);
    }
  }

  for (const pointId of existingPointHashes.keys()) {
    if (!expectedPointHashes.has(pointId)) {
      mismatches.push(`unexpected derived point ${pointId}`);
    }
  }

  return mismatches.slice(0, 10);
}

function normalizeLayer(value) {
  if (!value) {
    return null;
  }

  return ["tactics", "invariants", "cases", "evidence"].includes(value) ? value : null;
}

function assertCatalogs(catalogs) {
  return assertSemanticCatalogs(catalogs);
}

function assertEmbedder(embedder) {
  return assertSemanticEmbedder(embedder);
}

function assertFetch(fetchImpl) {
  if (typeof fetchImpl !== "function") {
    throw new Error("QdrantSemanticBackend requires a fetch-compatible implementation.");
  }

  return fetchImpl;
}

function assertEmbedding(embedding, label) {
  return assertSemanticEmbedding(embedding, label);
}

async function executeQdrantRequest({ fetchImpl, endpoint, path, method, body }) {
  const response = await fetchImpl(`${endpoint}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = typeof response.text === "function" ? await response.text() : "";
    throw new Error(`Qdrant request failed: ${response.status} ${text}`.trim());
  }

  return response.json();
}

async function executeQdrantDeleteIfExists({ fetchImpl, endpoint, path }) {
  const response = await fetchImpl(`${endpoint}${path}`, {
    method: "DELETE",
  });

  if (response.ok || response.status === 404) {
    return;
  }

  const text = typeof response.text === "function" ? await response.text() : "";
  throw new Error(`Qdrant delete failed: ${response.status} ${text}`.trim());
}

async function executeQdrantCreateCollection({ fetchImpl, endpoint, path, body }) {
  const response = await fetchImpl(`${endpoint}${path}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (response.ok || response.status === 409) {
    return typeof response.json === "function" ? response.json() : { status: "ok" };
  }

  const text = typeof response.text === "function" ? await response.text() : "";
  throw new Error(`Qdrant create collection failed: ${response.status} ${text}`.trim());
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function toQdrantPointId(layer, recordId) {
  return toSemanticDocumentId(layer, recordId);
}

module.exports = {
  QdrantSemanticBackend,
  diffSemanticIndexCoverage,
  exportCatalogToQdrantPoints,
  buildQdrantPayloadFilter,
  buildContextualText,
  mapQdrantPointsToCandidates,
  toQdrantPointId,
};
