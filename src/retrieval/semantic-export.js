const crypto = require("node:crypto");

const { buildEvidenceRetrievalText } = require("./evidence-text");
const { withCurrentEvidenceRecords } = require("../evidence/corrections");
const { buildParameterIndexes, buildParameterSummaryForRecord } = require("../parameters/retrieval");
const { getRecordWorkspaceId } = require("../workspace/identity");

const SEMANTIC_EXPORT_LAYERS = Object.freeze(["tactics", "invariants", "cases", "evidence"]);

function buildSemanticExportRecords(catalogs, { embeddingSignature = null } = {}) {
  assertSemanticCatalogs(catalogs);
  const currentCatalogs = withCurrentEvidenceRecords(catalogs);

  const atomicClaimsByEvidence = buildAtomicClaimIndex(currentCatalogs.atomic_claim_sets ?? []);
  const parameterIndexes = buildParameterIndexes(currentCatalogs);
  const exported = [];

  for (const layer of SEMANTIC_EXPORT_LAYERS) {
    for (const record of currentCatalogs[layer] ?? []) {
      if (!isSemanticRetrievableRecord(layer, record)) {
        continue;
      }

      const recordId = getSemanticRecordId(layer, record);
      const contextualText = buildContextualText(layer, record, atomicClaimsByEvidence, {
        catalogRoot: currentCatalogs.__catalogRoot,
        parameterIndexes,
      });
      const exportRecord = {
        layer,
        recordId,
        documentId: toSemanticDocumentId(layer, recordId),
        workspaceId: getSemanticWorkspaceId(layer, record),
        projectScope: getSemanticProjectScope(layer, record),
        status: getSemanticStatus(layer, record),
        reviewState: layer === "cases" ? record.review_state ?? null : null,
        contextualText,
        record: structuredClone(record),
      };

      exportRecord.payload = buildSemanticPayload({
        layer: exportRecord.layer,
        recordId: exportRecord.recordId,
        workspaceId: exportRecord.workspaceId,
        projectScope: exportRecord.projectScope,
        status: exportRecord.status,
        reviewState: exportRecord.reviewState,
        contextualText: exportRecord.contextualText,
        record: exportRecord.record,
        embeddingSignature,
      });
      exported.push(exportRecord);
    }
  }

  return exported;
}

async function embedSemanticExportRecords({ exportedRecords, embedder } = {}) {
  if (!Array.isArray(exportedRecords)) {
    throw new Error("embedSemanticExportRecords requires an exportedRecords array.");
  }
  assertSemanticEmbedder(embedder);

  const embeddings = await embedder.embedDocuments({
    documents: exportedRecords.map((entry) => entry.contextualText),
  });

  if (!Array.isArray(embeddings) || embeddings.length !== exportedRecords.length) {
    throw new Error("Embedder returned an invalid document embedding set.");
  }

  return exportedRecords.map((entry, index) => {
    const embedding = embeddings[index];
    assertSemanticEmbedding(embedding, "document");
    return {
      exportRecord: entry,
      embedding,
    };
  });
}

function buildContextualText(layer, record, atomicClaimsByEvidence, { catalogRoot, parameterIndexes } = {}) {
  const header = [
    `Layer: ${layer}.`,
    `Workspace: ${getSemanticWorkspaceId(layer, record) ?? "unscoped"}.`,
    `Project scope: ${getSemanticProjectScope(layer, record)}.`,
    `Status: ${getSemanticStatus(layer, record)}.`,
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
        buildParameterSummaryForRecord(layer, record, parameterIndexes),
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
        buildParameterSummaryForRecord(layer, record, parameterIndexes),
      ].filter(Boolean).join(" ");
    case "evidence":
      return [
        ...header,
        buildEvidenceRetrievalText(record, {
          catalogRoot,
          atomicClaims: atomicClaimsByEvidence.get(record.evidence_id) ?? [],
          parameterIndexes,
        }),
      ].join(" ");
    default:
      throw new Error(`Unsupported export layer: ${layer}`);
  }
}

function buildSemanticPayload({
  layer,
  recordId,
  workspaceId,
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
    workspace_id: workspaceId ?? null,
    project_scope: projectScope,
    status,
    review_state: reviewState,
    text: contextualText,
    record,
    embedding_signature: embeddingSignature,
    updated_at: getSemanticUpdatedAt(layer, record),
    captured_at: layer === "evidence" ? record.captured_at ?? null : null,
    derived_at: layer === "cases" ? record.derived_at ?? null : null,
    source_type: layer === "evidence" ? record.source_type ?? null : null,
    actor_scope: layer === "evidence" ? record.actor_scope ?? null : null,
    has_invalidation_markers: layer === "tactics"
      ? Array.isArray(record.invalidated_by) && record.invalidated_by.length > 0
      : false,
    fresh_until: layer === "tactics" ? computeSemanticFreshUntil(record) : null,
  };

  payload.content_hash = createSemanticContentHash({
    layer,
    recordId,
    payload,
  });

  return payload;
}

function buildSemanticCatalogIndex(catalogs) {
  const currentCatalogs = withCurrentEvidenceRecords(catalogs);
  const index = new Map();

  for (const layer of SEMANTIC_EXPORT_LAYERS) {
    for (const record of currentCatalogs[layer] ?? []) {
      index.set(`${layer}:${getSemanticRecordId(layer, record)}`, record);
    }
  }

  return index;
}

function computeSemanticQueryLimit(plan, fallback) {
  const budgetValues = Object.values(plan.max_results_per_layer ?? {}).filter((value) => Number.isInteger(value));
  const summedBudget = budgetValues.reduce((sum, value) => sum + value, 0);
  return Math.max(fallback, summedBudget || fallback);
}

function createSemanticContentHash(value) {
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

function getSemanticRecordId(layer, record) {
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

function getSemanticProjectScope(layer, record) {
  switch (layer) {
    case "cases":
      return record.context?.project_scope ?? "global";
    case "evidence":
      return record.project_scope ?? "global";
    default:
      return "global";
  }
}

function getSemanticWorkspaceId(layer, record) {
  return getRecordWorkspaceId(layer, record);
}

function getSemanticStatus(layer, record) {
  if (layer === "evidence") {
    return "immutable";
  }

  return record.status ?? "draft";
}

function getSemanticUpdatedAt(layer, record) {
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

function computeSemanticFreshUntil(record) {
  const candidates = [record.expiry_at, record.revalidate_at]
    .filter(Boolean)
    .map((value) => new Date(value));

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => left.getTime() - right.getTime());
  return candidates[0].toISOString();
}

function isSemanticRetrievableRecord(layer, record) {
  return layer === "evidence" || record.status === "active";
}

function toSemanticDocumentId(layer, recordId) {
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

function assertSemanticCatalogs(catalogs) {
  if (!catalogs) {
    throw new Error("Semantic export requires runtime catalogs.");
  }

  return catalogs;
}

function assertSemanticEmbedder(embedder) {
  if (!embedder || typeof embedder.embedQuery !== "function" || typeof embedder.embedDocuments !== "function") {
    throw new Error("Semantic export requires an embedder with embedQuery and embedDocuments.");
  }

  return embedder;
}

function assertSemanticEmbedding(embedding, label) {
  if (!embedding || !Array.isArray(embedding.dense) || !embedding.sparse) {
    throw new Error(`Invalid ${label} embedding payload.`);
  }

  return embedding;
}

module.exports = {
  SEMANTIC_EXPORT_LAYERS,
  assertSemanticCatalogs,
  assertSemanticEmbedder,
  assertSemanticEmbedding,
  buildContextualText,
  buildSemanticCatalogIndex,
  buildSemanticExportRecords,
  buildSemanticPayload,
  computeSemanticFreshUntil,
  computeSemanticQueryLimit,
  createSemanticContentHash,
  embedSemanticExportRecords,
  getSemanticProjectScope,
  getSemanticRecordId,
  getSemanticStatus,
  getSemanticUpdatedAt,
  getSemanticWorkspaceId,
  isSemanticRetrievableRecord,
  toSemanticDocumentId,
};
