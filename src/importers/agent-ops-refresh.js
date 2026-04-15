const fs = require("node:fs");
const path = require("node:path");

const { REPO_ROOT } = require("../validation/schema-registry");
const { EcitrValidator } = require("../validation/validator");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { buildSemanticEmbedder } = require("../retrieval/embedders/factory");
const { runEvidenceSmokeChecks } = require("../retrieval/evidence-smoke-check");
const { QdrantSemanticBackend } = require("../retrieval/semantic-backends/qdrant-backend");
const { importAgentOpsRuns } = require("./agent-ops-runs");
const { importAgentOpsSessions } = require("./agent-ops-sessions");

const DEFAULT_QDRANT_URL = "http://127.0.0.1:6333";
const DEFAULT_COLLECTION_NAME = "ecitr-local-catalog-v1";

async function refreshAgentOpsIndex({
  agentOpsRoot = resolveDefaultAgentOpsRoot(),
  catalogRoot = path.join(REPO_ROOT, ".local", "catalog"),
  projectId = null,
  qdrantUrl = DEFAULT_QDRANT_URL,
  collectionName = DEFAULT_COLLECTION_NAME,
  dryRun = false,
  skipSmokeCheck = false,
  recreateCollection = false,
  embedderType = process.env.ECITR_EMBEDDER ?? "openai",
  embeddingModel = process.env.ECITR_EMBEDDING_MODEL,
  denseVectorSize,
  sparseBucketCount = 2048,
  openAIApiKey = process.env.OPENAI_API_KEY,
  openAIBaseUrl = process.env.OPENAI_BASE_URL,
  openAIOrganization = process.env.OPENAI_ORGANIZATION,
  openAIProject = process.env.OPENAI_PROJECT,
  validator = new EcitrValidator(),
  importRuns = importAgentOpsRuns,
  importSessions = importAgentOpsSessions,
  loadCatalogs = defaultLoadCatalogs,
  syncCatalog = defaultSyncCatalog,
  smokeCheck = runEvidenceSmokeChecks,
} = {}) {
  if (!agentOpsRoot) {
    throw new Error("refreshAgentOpsIndex requires an agentOpsRoot.");
  }

  if (!catalogRoot) {
    throw new Error("refreshAgentOpsIndex requires a catalogRoot.");
  }

  const resolvedAgentOpsRoot = path.resolve(agentOpsRoot);
  const resolvedCatalogRoot = path.resolve(catalogRoot);
  const summary = {
    dry_run: dryRun,
    agent_ops_root: resolvedAgentOpsRoot,
    catalog_root: resolvedCatalogRoot,
    qdrant_url: qdrantUrl,
    collection_name: collectionName,
    recreate_collection: recreateCollection,
    embedder_type: embedderType,
    embedding_model: embedderType === "openai" ? (embeddingModel ?? "text-embedding-3-small") : null,
  };

  const importOptions = {
    agentOpsRoot: resolvedAgentOpsRoot,
    catalogRoot: resolvedCatalogRoot,
    projectId,
    dryRun,
    validator,
  };

  summary.runs = importRuns(importOptions);
  assertImportSummaryClean("runs", summary.runs);

  summary.sessions = importSessions(importOptions);
  assertImportSummaryClean("sessions", summary.sessions);

  if (dryRun) {
    summary.qdrant_sync = { status: "skipped_dry_run" };
    summary.smoke_checks = { status: "skipped_dry_run" };
    return summary;
  }

  const catalogs = loadCatalogs({
    catalogRoot: resolvedCatalogRoot,
    validator,
  });
  summary.catalog_counts = countCatalogRecords(catalogs);

  summary.qdrant_sync = await syncCatalog({
    catalogs,
    qdrantUrl,
    collectionName,
    embedderType,
    embeddingModel,
    denseVectorSize,
    sparseBucketCount,
    openAIApiKey,
    openAIBaseUrl,
    openAIOrganization,
    openAIProject,
    recreateCollection,
  });

  if (skipSmokeCheck) {
    summary.smoke_checks = { status: "skipped" };
    return summary;
  }

  summary.smoke_checks = await smokeCheck({
    catalogs,
    endpoint: qdrantUrl,
    collectionName,
    embedder: buildSemanticEmbedder({
      embedderType,
      embeddingModel,
      openAIApiKey,
      openAIBaseUrl,
      openAIOrganization,
      openAIProject,
      denseVectorSize,
      sparseBucketCount,
    }),
  });

  if (summary.smoke_checks.failed > 0) {
    const error = new Error("agent-ops refresh smoke checks failed.");
    error.summary = summary;
    throw error;
  }

  return summary;
}

function defaultLoadCatalogs({ catalogRoot, validator }) {
  const catalog = new FileBackedCatalog({
    rootDir: catalogRoot,
    validator,
  });

  return catalog.loadRuntimeCatalogs();
}

async function defaultSyncCatalog({
  catalogs,
  qdrantUrl,
  collectionName,
  embedderType,
  embeddingModel,
  denseVectorSize,
  sparseBucketCount,
  openAIApiKey,
  openAIBaseUrl,
  openAIOrganization,
  openAIProject,
  recreateCollection,
  fetchImpl = globalThis.fetch,
} = {}) {
  const embedder = buildSemanticEmbedder({
    embedderType,
    embeddingModel,
    openAIApiKey,
    openAIBaseUrl,
    openAIOrganization,
    openAIProject,
    denseVectorSize,
    sparseBucketCount,
    fetchImpl,
  });
  const backend = new QdrantSemanticBackend({
    endpoint: qdrantUrl,
    collectionName,
    catalogs,
    embedder,
    fetchImpl,
  });

  await backend.ensureCollection({
    denseVectorSize: embedder.denseVectorSize,
    recreate: recreateCollection,
  });
  const syncResult = await backend.syncCatalog();
  const collectionStatus = await fetchCollectionStatus({
    fetchImpl,
    endpoint: qdrantUrl,
    collectionName,
  });

  return {
    endpoint: qdrantUrl,
    collection_name: collectionName,
    points_upserted: syncResult.plan.pointsToUpsert.length,
    points_deleted: syncResult.plan.pointIdsToDelete.length,
    points_total: syncResult.plan.exportedRecords.length,
    points_existing: syncResult.plan.existingCount,
    dense_vector_size: embedder.denseVectorSize,
    sparse_bucket_count: embedder.sparseBucketCount,
    embedding_signature: embedder.embeddingSignature ?? null,
    collection_status: collectionStatus,
  };
}

async function fetchCollectionStatus({ fetchImpl, endpoint, collectionName }) {
  const response = await fetchImpl(`${stripTrailingSlash(endpoint)}/collections/${collectionName}`);
  if (!response.ok) {
    const text = typeof response.text === "function" ? await response.text() : "";
    throw new Error(`Unable to fetch Qdrant collection status for ${collectionName}: ${response.status} ${text}`);
  }

  const payload = await response.json();
  const result = payload?.result ?? {};
  return {
    status: result.status ?? null,
    indexed_vectors_count: result.indexed_vectors_count ?? null,
    points_count: result.points_count ?? null,
    segments_count: result.segments_count ?? null,
  };
}

function countCatalogRecords(catalogs) {
  return {
    tactics: catalogs.tactics?.length ?? 0,
    invariants: catalogs.invariants?.length ?? 0,
    cases: catalogs.cases?.length ?? 0,
    evidence: catalogs.evidence?.length ?? 0,
    atomic_claim_sets: catalogs.atomic_claim_sets?.length ?? 0,
    review_audit_entries: catalogs.review_audit_entries?.length ?? 0,
  };
}

function assertImportSummaryClean(label, summary) {
  if ((summary.errors ?? 0) > 0 || (summary.conflicts ?? 0) > 0) {
    const error = new Error(`${label} refresh reported conflicts or errors.`);
    error.summary = summary;
    throw error;
  }
}

function resolveDefaultAgentOpsRoot() {
  const siblingRoot = path.resolve(REPO_ROOT, "..", "agent-ops");
  if (fs.existsSync(siblingRoot) && fs.statSync(siblingRoot).isDirectory()) {
    return siblingRoot;
  }

  return null;
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

module.exports = {
  DEFAULT_QDRANT_URL,
  DEFAULT_COLLECTION_NAME,
  refreshAgentOpsIndex,
  defaultSyncCatalog,
  fetchCollectionStatus,
  countCatalogRecords,
  resolveDefaultAgentOpsRoot,
};
