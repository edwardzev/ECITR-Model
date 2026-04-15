const crypto = require("node:crypto");

const { SemanticRetrievalBackend } = require("../semantic-backend-interface");
const { buildEvidenceRetrievalText } = require("../evidence-text");

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
    const exportedRecords = buildExportRecords(catalogs, {
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
    const exportedRecords = buildExportRecords(catalogs, {
      embeddingSignature: this.embedder.embeddingSignature ?? null,
    });
    const existingPointHashes = await this.fetchExistingPointHashes();
    const desiredPointIds = new Set(exportedRecords.map((entry) => entry.pointId));
    const recordsToUpsert = exportedRecords.filter(
      (entry) => existingPointHashes.get(entry.pointId) !== entry.payload?.content_hash,
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
    const queryEmbedding = await this.embedder.embedQuery({ query: request.query });
    const limit = computeQueryLimit(plan, this.defaultQueryLimit);
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

    return mapQdrantPointsToCandidates({ points, catalogs });
  }
}

async function exportCatalogToQdrantPoints({
  catalogs,
  embedder,
  denseVectorName = DEFAULT_DENSE_VECTOR_NAME,
  sparseVectorName = DEFAULT_SPARSE_VECTOR_NAME,
}) {
  assertCatalogs(catalogs);
  const exportedRecords = buildExportRecords(catalogs, {
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

  const embeddings = await embedder.embedDocuments({
    documents: exportedRecords.map((entry) => entry.contextualText),
  });

  if (!Array.isArray(embeddings) || embeddings.length !== exportedRecords.length) {
    throw new Error("Embedder returned an invalid document embedding set.");
  }

  return exportedRecords.map((entry, index) => {
    const embedding = embeddings[index];
    assertEmbedding(embedding, "document");

    return {
      id: entry.pointId,
      vector: {
        [denseVectorName]: embedding.dense,
        [sparseVectorName]: embedding.sparse,
      },
      payload: entry.payload,
    };
  });
}

function buildExportRecords(catalogs, { embeddingSignature = null } = {}) {
  const atomicClaimsByEvidence = buildAtomicClaimIndex(catalogs.atomic_claim_sets ?? []);
  const exported = [];

  for (const layer of ["tactics", "invariants", "cases", "evidence"]) {
    for (const record of catalogs[layer] ?? []) {
      if (!isRetrievableRecord(layer, record)) {
        continue;
      }
      const recordId = getRecordId(layer, record);
      exported.push({
        layer,
        recordId,
        pointId: toQdrantPointId(layer, recordId),
        projectScope: getProjectScope(layer, record),
        status: getStatus(layer, record),
        reviewState: layer === "cases" ? record.review_state ?? null : null,
        contextualText: buildContextualText(layer, record, atomicClaimsByEvidence, {
          catalogRoot: catalogs.__catalogRoot,
        }),
        record: structuredClone(record),
      });

      const current = exported[exported.length - 1];
      current.payload = buildPointPayload({
        layer: current.layer,
        recordId: current.recordId,
        projectScope: current.projectScope,
        status: current.status,
        reviewState: current.reviewState,
        contextualText: current.contextualText,
        record: current.record,
        embeddingSignature,
      });
    }
  }

  return exported;
}

function buildContextualText(layer, record, atomicClaimsByEvidence, { catalogRoot } = {}) {
  const header = [
    `Layer: ${layer}.`,
    `Project scope: ${getProjectScope(layer, record)}.`,
    `Status: ${getStatus(layer, record)}.`,
  ];

  switch (layer) {
    case "tactics":
      return [
        ...header,
        `Title: ${record.title}.`,
        `Summary: ${record.summary}.`,
        `Action: ${record.action}.`,
        `Steps: ${(record.steps ?? []).join(" ")}`,
        `Fallbacks: ${(record.fallbacks ?? []).join(" ")}`,
      ].join(" ");
    case "invariants":
      return [
        ...header,
        `Title: ${record.title}.`,
        `Summary: ${record.summary}.`,
        `Statement: ${record.statement}.`,
        `Applicability: ${(record.applicability_conditions ?? []).join(" ")}`,
        `Non applicability: ${(record.non_applicability_conditions ?? []).join(" ")}`,
      ].join(" ");
    case "cases":
      return [
        ...header,
        `Problem: ${record.problem_statement}.`,
        `Action: ${record.action_taken}.`,
        `Outcome: ${record.outcome}.`,
        `Failure mode: ${record.failure_mode}.`,
        `Apply when: ${(record.applicability?.when_to_apply ?? []).join(" ")}`,
        `Do not apply when: ${(record.applicability?.when_not_to_apply ?? []).join(" ")}`,
      ].filter(Boolean).join(" ");
    case "evidence":
      return [
        ...header,
        buildEvidenceRetrievalText(record, {
          catalogRoot,
          atomicClaims: atomicClaimsByEvidence.get(record.evidence_id) ?? [],
        }),
      ].join(" ");
    default:
      throw new Error(`Unsupported export layer: ${layer}`);
  }
}

function buildPointPayload({
  layer,
  recordId,
  projectScope,
  status,
  reviewState,
  contextualText,
  record,
  embeddingSignature,
}) {
  const payload = {
    layer,
    record_id: recordId,
    project_scope: projectScope,
    status,
    review_state: reviewState,
    text: contextualText,
    record,
    embedding_signature: embeddingSignature,
    updated_at: getUpdatedAt(layer, record),
    captured_at: layer === "evidence" ? record.captured_at ?? null : null,
    derived_at: layer === "cases" ? record.derived_at ?? null : null,
    source_type: layer === "evidence" ? record.source_type ?? null : null,
    actor_scope: layer === "evidence" ? record.actor_scope ?? null : null,
    has_invalidation_markers: layer === "tactics"
      ? Array.isArray(record.invalidated_by) && record.invalidated_by.length > 0
      : false,
    fresh_until: layer === "tactics" ? computeFreshUntil(record) : null,
  };

  payload.content_hash = createContentHash({
    layer,
    recordId,
    payload,
  });

  return payload;
}

function createContentHash(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function buildAtomicClaimIndex(claimSets) {
  const index = new Map();

  for (const claimSet of claimSets) {
    index.set(
      claimSet.evidence_id,
      (claimSet.claims ?? []).map((claim) => claim.text),
    );
  }

  return index;
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

function mapQdrantPointsToCandidates({ points, catalogs }) {
  const fallbackIndex = buildCatalogIndex(catalogs);

  return points
    .map((point) => {
      const payload = point.payload ?? {};
      const layer = normalizeLayer(payload.layer);
      const recordId = String(payload.record_id ?? point.id).replace(/^[^:]+:/, "");
      const record = payload.record ?? fallbackIndex.get(`${layer}:${recordId}`);

      if (!layer || !record) {
        return null;
      }

      return {
        recordId,
        layer,
        laneId: "semantic",
        score: Number(point.score ?? 0),
        record,
        reasons: ["qdrant hybrid semantic retrieval"],
      };
    })
    .filter(Boolean);
}

function buildCatalogIndex(catalogs) {
  const index = new Map();

  for (const layer of ["tactics", "invariants", "cases", "evidence"]) {
    for (const record of catalogs[layer] ?? []) {
      index.set(`${layer}:${getRecordId(layer, record)}`, record);
    }
  }

  return index;
}

function computeQueryLimit(plan, fallback) {
  const budgetValues = Object.values(plan.max_results_per_layer ?? {}).filter((value) => Number.isInteger(value));
  const summedBudget = budgetValues.reduce((sum, value) => sum + value, 0);
  return Math.max(fallback, summedBudget || fallback);
}

function getRecordId(layer, record) {
  switch (layer) {
    case "tactics":
    case "invariants":
      return record.id;
    case "cases":
      return record.case_id;
    case "evidence":
      return record.evidence_id;
    default:
      throw new Error(`Unsupported layer: ${layer}`);
  }
}

function getProjectScope(layer, record) {
  switch (layer) {
    case "cases":
      return record.context?.project_scope ?? "global";
    case "evidence":
      return record.project_scope ?? "global";
    default:
      return "global";
  }
}

function getStatus(layer, record) {
  if (layer === "evidence") {
    return "immutable";
  }

  return record.status ?? "draft";
}

function getUpdatedAt(layer, record) {
  switch (layer) {
    case "tactics":
    case "invariants":
      return record.updated_at ?? record.created_at ?? null;
    case "cases":
      return record.derived_at ?? null;
    case "evidence":
      return record.captured_at ?? null;
    default:
      return null;
  }
}

function computeFreshUntil(record) {
  const candidates = [record.expiry_at, record.revalidate_at]
    .filter(Boolean)
    .map((value) => new Date(value));

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => left.getTime() - right.getTime());
  return candidates[0].toISOString();
}

function isRetrievableRecord(layer, record) {
  return layer === "evidence" || record.status === "active";
}

function normalizeLayer(value) {
  if (!value) {
    return null;
  }

  return ["tactics", "invariants", "cases", "evidence"].includes(value) ? value : null;
}

function assertCatalogs(catalogs) {
  if (!catalogs) {
    throw new Error("QdrantSemanticBackend requires runtime catalogs.");
  }

  return catalogs;
}

function assertEmbedder(embedder) {
  if (!embedder || typeof embedder.embedQuery !== "function" || typeof embedder.embedDocuments !== "function") {
    throw new Error("QdrantSemanticBackend requires an embedder with embedQuery and embedDocuments.");
  }

  return embedder;
}

function assertFetch(fetchImpl) {
  if (typeof fetchImpl !== "function") {
    throw new Error("QdrantSemanticBackend requires a fetch-compatible implementation.");
  }

  return fetchImpl;
}

function assertEmbedding(embedding, label) {
  if (!embedding || !Array.isArray(embedding.dense) || !embedding.sparse) {
    throw new Error(`Invalid ${label} embedding payload.`);
  }

  return embedding;
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
  const digest = crypto
    .createHash("sha256")
    .update(`${layer}:${recordId}`)
    .digest("hex")
    .slice(0, 32);

  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32),
  ].join("-");
}

module.exports = {
  QdrantSemanticBackend,
  exportCatalogToQdrantPoints,
  buildQdrantPayloadFilter,
  buildContextualText,
  toQdrantPointId,
};
