const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { buildSemanticEmbedder } = require("../retrieval/embedders/factory");
const { buildDefaultLanes } = require("../retrieval/lanes");
const { RetrievalRuntime } = require("../retrieval/runtime");
const { HeuristicSemanticBackend } = require("../retrieval/semantic-backends/heuristic-backend");
const {
  DEFAULT_LANCEDB_URI,
  DEFAULT_TABLE_NAME: DEFAULT_LANCEDB_TABLE_NAME,
  LanceDbSemanticBackend,
  isLanceDbCatalogBasisCurrent,
} = require("../retrieval/semantic-backends/lancedb-backend");
const { REPO_ROOT } = require("../validation/schema-registry");
const { readJson } = require("../validation/validator");
const {
  WORKSPACE_MARKER_FILENAME,
  assertCatalogRootMatches,
  findWorkspaceMarker,
  loadEcitrProjectConfig,
} = require("../workspace/config");
const DEFAULT_MEMORY_TOOL_NAME = "search_project_memory";
const DEFAULT_MEMORY_USAGE_TOOL_NAME = "record_memory_usage";
const MEMORY_CONSULT_TRIGGERS = Object.freeze([
  "discretionary",
  "preflight",
  "failure_retry",
]);

class ProjectMemorySurface {
  constructor({
    catalog,
    retrievalRuntime,
    projectConfig = loadEcitrProjectConfig({ startDir: catalog?.rootDir }),
    artifactRoot,
  } = {}) {
    this.catalog = catalog;
    this.retrievalRuntime = retrievalRuntime;
    this.projectConfig = projectConfig;
    this.artifactRoot = projectConfig
      ? path.resolve(
        artifactRoot
        ?? path.join(projectConfig.workspace_root, ".local", "memory-invocations"),
      )
      : null;

    if (this.projectConfig && this.catalog) {
      assertCatalogRootMatches({
        projectConfig: this.projectConfig,
        catalogRoot: this.catalog.rootDir,
      });
    }
  }

  isAvailable() {
    return Boolean(this.projectConfig);
  }

  describe() {
    if (!this.projectConfig) {
      return {
        available: false,
        tool_name: DEFAULT_MEMORY_TOOL_NAME,
        usage_tool_name: DEFAULT_MEMORY_USAGE_TOOL_NAME,
      };
    }

    return {
      available: true,
      tool_name: DEFAULT_MEMORY_TOOL_NAME,
      usage_tool_name: DEFAULT_MEMORY_USAGE_TOOL_NAME,
      marker_path: this.projectConfig.marker_path,
      catalog_root: this.projectConfig.catalog_root,
      workspace_id: this.projectConfig.workspace_id,
      default_project_scope: this.projectConfig.default_project_scope,
      preflight_retrieval_mandatory: this.projectConfig.preflight_retrieval_mandatory,
      failure_retry_retrieval_mandatory: this.projectConfig.failure_retry_retrieval_mandatory,
      discretionary_only: !this.projectConfig.preflight_retrieval_mandatory
        && !this.projectConfig.failure_retry_retrieval_mandatory,
    };
  }

  logTaskOpportunity({ taskPacket, now = new Date() } = {}) {
    if (!this.projectConfig) {
      return null;
    }

    return writeMemoryInvocation({
      artifactRoot: this.artifactRoot,
      projectConfig: this.projectConfig,
      consultedAt: now,
      taskPacket,
      memoryConsulted: false,
      consultTrigger: null,
      request: null,
      retrieval: null,
    });
  }

  logConsultation({
    taskPacket,
    consultTrigger,
    request = null,
    retrieval = null,
    now = new Date(),
  } = {}) {
    if (!this.projectConfig) {
      return null;
    }

    return writeMemoryInvocation({
      artifactRoot: this.artifactRoot,
      projectConfig: this.projectConfig,
      consultedAt: now,
      taskPacket,
      memoryConsulted: true,
      consultTrigger,
      request,
      retrieval,
    });
  }

  async searchProjectMemory({
    query,
    taskPacket,
    projectScope = this.projectConfig?.default_project_scope,
    intent = "analysis",
    allowedLayers,
    maxResultsPerLayer,
    trigger = "discretionary",
    now = new Date(),
  } = {}) {
    if (!this.projectConfig) {
      throw new Error("Project memory is not configured for this workspace.");
    }
    if (!query || !String(query).trim()) {
      throw new Error("search_project_memory requires a non-empty query.");
    }
    if (!MEMORY_CONSULT_TRIGGERS.includes(trigger)) {
      throw new Error(
        `search_project_memory trigger must be one of: ${MEMORY_CONSULT_TRIGGERS.join(", ")}.`,
      );
    }

    const request = {
      request_id: buildRequestId({
        query,
        trigger,
        now,
      }),
      query: String(query).trim(),
      workspace_id: this.projectConfig.workspace_id,
      project_scope: projectScope,
      intent,
    };

    if (allowedLayers) {
      request.allowed_layers = [...allowedLayers];
    }

    if (maxResultsPerLayer) {
      request.max_results_per_layer = structuredClone(maxResultsPerLayer);
    }

    const catalogs = this.catalog.loadRuntimeCatalogs();
    const retrieval = await this.retrievalRuntime.execute({ request, catalogs, now });
    const invocation = this.logConsultation({
      taskPacket,
      consultTrigger: trigger,
      request,
      retrieval,
      now,
    });

    return {
      retrieval,
      memory_surface: this.describe(),
      memory_invocation: invocation,
    };
  }

  async search_project_memory(args) {
    return this.searchProjectMemory(args);
  }

  recordMemoryUsage({
    invocationId,
    usedRecordIds = [],
    selectedRecordIds = [],
    now = new Date(),
  } = {}) {
    if (!invocationId) {
      throw new Error("record_memory_usage requires an invocationId.");
    }
    if (!this.projectConfig) {
      throw new Error("Project memory is not configured for this workspace.");
    }

    const artifactPath = findInvocationArtifactPath({
      artifactRoot: this.artifactRoot,
      invocationId,
    });
    if (!artifactPath) {
      throw new Error(`Memory invocation artifact not found: ${invocationId}`);
    }

    const artifact = readJson(artifactPath);
    const returnedRecordIds = new Set(flattenReturnedRecordIds(artifact.returned_record_ids));
    const normalizedUsedRecordIds = normalizeUniqueStrings(usedRecordIds);
    const normalizedSelectedRecordIds = normalizeUniqueStrings(selectedRecordIds);
    const usedReturnedRecordIds = normalizedUsedRecordIds.filter((recordId) => returnedRecordIds.has(recordId));

    const nextArtifact = {
      ...artifact,
      usage_recorded_at: now.toISOString(),
      used_record_ids: normalizedUsedRecordIds,
      selected_record_ids: normalizedSelectedRecordIds,
      used_returned_record_ids: usedReturnedRecordIds,
      used_memory: usedReturnedRecordIds.length > 0,
    };
    writeJson(artifactPath, nextArtifact);

    return {
      invocation_id: nextArtifact.invocation_id,
      artifact_path: artifactPath,
      used_memory: nextArtifact.used_memory,
      used_returned_record_ids: nextArtifact.used_returned_record_ids,
      selected_record_ids: nextArtifact.selected_record_ids,
    };
  }

  record_memory_usage(args) {
    return this.recordMemoryUsage(args);
  }
}

function createProjectMemoryRetrievalRuntime({
  lancedbUri,
  lancedbTableName,
  embedderType = process.env.ECITR_PROJECT_MEMORY_EMBEDDER
    ?? process.env.ECITR_LANCEDB_EMBEDDER
    ?? "hash",
  embeddingModel = process.env.ECITR_PROJECT_MEMORY_EMBEDDING_MODEL
    ?? process.env.ECITR_LANCEDB_EMBEDDING_MODEL,
  lancedbMaximumDistance = process.env.ECITR_LANCEDB_MAX_DISTANCE ?? null,
  denseVectorSize,
  sparseBucketCount = 2048,
  openAIApiKey = process.env.OPENAI_API_KEY,
  openAIBaseUrl = process.env.OPENAI_BASE_URL,
  openAIOrganization = process.env.OPENAI_ORGANIZATION,
  openAIProject = process.env.OPENAI_PROJECT,
  tableExists = localLanceDbTableExists,
  buildLanceDbBackend = (options) => new LanceDbSemanticBackend(options),
  buildFallbackBackend = (options) => new HeuristicSemanticBackend(options),
  buildEmbedder = buildSemanticEmbedder,
  responseEnricher,
  graphRoot,
} = {}) {
  const effectiveLanceDbUri = lancedbUri ?? process.env.ECITR_LANCEDB_URI ?? DEFAULT_LANCEDB_URI;
  const effectiveLanceDbTableName = lancedbTableName ?? process.env.ECITR_LANCEDB_TABLE ?? DEFAULT_LANCEDB_TABLE_NAME;
  const constrainDefaultUriToDefaultCatalog = lancedbUri == null && !process.env.ECITR_LANCEDB_URI;
  let embedder = null;
  const getEmbedder = () => {
    if (!embedder) {
      embedder = buildEmbedder({
        embedderType,
        embeddingModel,
        denseVectorSize,
        sparseBucketCount,
        openAIApiKey,
        openAIBaseUrl,
        openAIOrganization,
        openAIProject,
      });
    }
    return embedder;
  };

  return new RetrievalRuntime({
    responseEnricher,
    graphRoot,
    lanesFactory({ catalogs, plan }) {
      const semanticBackend = tableExists({
        uri: effectiveLanceDbUri,
        tableName: effectiveLanceDbTableName,
        catalogRoot: catalogs?.__catalogRoot,
        catalogs,
        expectedEmbeddingSignature: () => getEmbedder().embeddingSignature ?? null,
        constrainDefaultUriToDefaultCatalog,
      })
        ? buildLanceDbBackend({
          uri: effectiveLanceDbUri,
          tableName: effectiveLanceDbTableName,
          catalogs,
          embedder: getEmbedder(),
          maximumDistance: lancedbMaximumDistance,
        })
        : buildFallbackBackend({ catalogs });
      return buildDefaultLanes({ catalogs, plan, semanticBackend });
    },
  });
}

function localLanceDbTableExists({
  uri = DEFAULT_LANCEDB_URI,
  tableName = DEFAULT_LANCEDB_TABLE_NAME,
  catalogRoot = null,
  catalogs = null,
  expectedEmbeddingSignature = null,
  constrainDefaultUriToDefaultCatalog = false,
  fsImpl = fs,
} = {}) {
  if (!uri || !tableName || /^[a-z]+:\/\//i.test(String(uri))) {
    return false;
  }

  if (constrainDefaultUriToDefaultCatalog && catalogRoot) {
    const defaultCatalogRoot = path.join(REPO_ROOT, ".local", "catalog");
    if (path.resolve(catalogRoot) !== path.resolve(defaultCatalogRoot)) {
      return false;
    }
  }

  if (!fsImpl.existsSync(path.join(String(uri), `${tableName}.lance`))) {
    return false;
  }

  if (!catalogs) {
    return true;
  }

  const basisPath = path.join(String(uri), `${tableName}.basis.json`);
  if (!fsImpl.existsSync(basisPath)) {
    return false;
  }

  let embeddingSignature = null;
  try {
    const manifest = JSON.parse(fsImpl.readFileSync(basisPath, "utf8"));
    embeddingSignature = typeof expectedEmbeddingSignature === "function"
      ? expectedEmbeddingSignature()
      : manifest.embedding_signature ?? null;
  } catch {
    return false;
  }

  return isLanceDbCatalogBasisCurrent({
    uri,
    tableName,
    catalogs,
    embeddingSignature,
    fsImpl,
  });
}

function writeMemoryInvocation({
  artifactRoot,
  projectConfig,
  consultedAt,
  taskPacket,
  memoryConsulted,
  consultTrigger,
  request,
  retrieval,
}) {
  const invocationId = buildInvocationId({
    taskId: taskPacket?.task_id ?? null,
    consultTrigger,
    consultedAt,
  });
  const artifact = {
    schema_version: 1,
    invocation_id: invocationId,
    consulted_at: consultedAt.toISOString(),
    task_id: taskPacket?.task_id ?? null,
    task_title: taskPacket?.title ?? null,
    memory_available: true,
    memory_consulted: memoryConsulted,
    consult_trigger: consultTrigger,
    tool_name: DEFAULT_MEMORY_TOOL_NAME,
    usage_tool_name: DEFAULT_MEMORY_USAGE_TOOL_NAME,
    marker_path: projectConfig.marker_path,
    catalog_root: projectConfig.catalog_root,
    workspace_id: projectConfig.workspace_id,
    default_project_scope: projectConfig.default_project_scope,
    preflight_retrieval_mandatory: projectConfig.preflight_retrieval_mandatory,
    failure_retry_retrieval_mandatory: projectConfig.failure_retry_retrieval_mandatory,
    request: request ? structuredClone(request) : null,
    returned_counts: buildReturnedCounts(retrieval),
    returned_record_ids: buildReturnedRecordIds(retrieval),
    usage_recorded_at: null,
    used_record_ids: [],
    selected_record_ids: [],
    used_returned_record_ids: [],
    used_memory: false,
  };

  const artifactPath = buildArtifactPath({
    artifactRoot,
    invocationId,
    consultedAt,
  });
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  writeJson(artifactPath, artifact);

  return {
    invocation_id: invocationId,
    artifact_path: artifactPath,
    memory_consulted: artifact.memory_consulted,
    consult_trigger: artifact.consult_trigger,
    returned_counts: artifact.returned_counts,
    returned_record_ids: artifact.returned_record_ids,
  };
}

function summarizeMemoryInvocations({
  artifactRoot,
  since = null,
  until = null,
} = {}) {
  const artifacts = loadMemoryInvocationArtifacts({ artifactRoot, since, until });
  const consulted = artifacts.filter((artifact) => artifact.memory_consulted);
  const usageRecorded = consulted.filter((artifact) => artifact.usage_recorded_at);
  const used = consulted.filter((artifact) => artifact.used_memory);

  return {
    artifact_root: path.resolve(artifactRoot),
    since: since ? new Date(since).toISOString() : null,
    until: until ? new Date(until).toISOString() : null,
    task_opportunities: artifacts.length,
    consultations: consulted.length,
    consultation_rate: ratio(consulted.length, artifacts.length),
    consultations_by_trigger: Object.fromEntries(
      MEMORY_CONSULT_TRIGGERS.map((trigger) => [
        trigger,
        consulted.filter((artifact) => artifact.consult_trigger === trigger).length,
      ]),
    ),
    consultations_with_results: consulted.filter((artifact) =>
      Object.values(artifact.returned_counts ?? {}).some((count) => Number(count) > 0)).length,
    returned_records_by_layer: sumReturnedCounts(consulted),
    usage_callbacks: usageRecorded.length,
    usage_callback_rate: ratio(usageRecorded.length, consulted.length),
    used_memory: used.length,
    used_memory_rate: ratio(used.length, consulted.length),
  };
}

function loadMemoryInvocationArtifacts({ artifactRoot, since = null, until = null }) {
  const resolvedRoot = path.resolve(artifactRoot);
  if (!fs.existsSync(resolvedRoot)) {
    return [];
  }

  const sinceMs = since ? new Date(since).getTime() : Number.NEGATIVE_INFINITY;
  const untilMs = until ? new Date(until).getTime() : Number.POSITIVE_INFINITY;
  if (Number.isNaN(sinceMs) || Number.isNaN(untilMs)) {
    throw new Error("Memory invocation report received an invalid time boundary.");
  }

  return listJsonFiles(resolvedRoot)
    .map((filePath) => {
      try {
        return readJson(filePath);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((artifact) => {
      const consultedAtMs = new Date(artifact.consulted_at).getTime();
      return Number.isFinite(consultedAtMs)
        && consultedAtMs >= sinceMs
        && consultedAtMs <= untilMs;
    });
}

function listJsonFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsonFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

function sumReturnedCounts(artifacts) {
  const totals = {
    tactics: 0,
    invariants: 0,
    cases: 0,
    evidence: 0,
  };
  for (const artifact of artifacts) {
    for (const layer of Object.keys(totals)) {
      totals[layer] += Number(artifact.returned_counts?.[layer] ?? 0);
    }
  }
  return totals;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function buildReturnedCounts(retrieval) {
  const results = retrieval?.response?.results ?? {};
  return {
    tactics: (results.tactics ?? []).length,
    invariants: (results.invariants ?? []).length,
    cases: (results.cases ?? []).length,
    evidence: (results.evidence ?? []).length,
  };
}

function buildReturnedRecordIds(retrieval) {
  const results = retrieval?.response?.results ?? {};
  return {
    tactics: [...(results.tactics ?? [])],
    invariants: [...(results.invariants ?? [])],
    cases: [...(results.cases ?? [])],
    evidence: [...(results.evidence ?? [])],
  };
}

function buildRequestId({ query, trigger, now }) {
  const digest = crypto
    .createHash("sha256")
    .update(`${trigger}:${query}`)
    .digest("hex")
    .slice(0, 10);
  const timestamp = sanitizeTimestamp(now.toISOString()).slice(0, 14);
  return `req_project_memory_${timestamp}_${digest}`;
}

function buildInvocationId({ taskId, consultTrigger, consultedAt }) {
  const digest = crypto
    .createHash("sha256")
    .update(`${taskId ?? "taskless"}:${consultTrigger ?? "available"}:${consultedAt.toISOString()}`)
    .digest("hex")
    .slice(0, 10);
  const timestamp = sanitizeTimestamp(consultedAt.toISOString()).slice(0, 14);
  return `meminv_${timestamp}_${digest}`;
}

function buildArtifactPath({ artifactRoot, invocationId, consultedAt }) {
  const year = String(consultedAt.getUTCFullYear());
  const month = String(consultedAt.getUTCMonth() + 1).padStart(2, "0");
  return path.join(artifactRoot, year, month, `${invocationId}.json`);
}

function findInvocationArtifactPath({ artifactRoot, invocationId }) {
  if (!fs.existsSync(artifactRoot)) {
    return null;
  }

  const yearDirs = fs.readdirSync(artifactRoot, { withFileTypes: true });
  for (const yearEntry of yearDirs) {
    if (!yearEntry.isDirectory()) {
      continue;
    }
    const yearPath = path.join(artifactRoot, yearEntry.name);
    const monthEntries = fs.readdirSync(yearPath, { withFileTypes: true });
    for (const monthEntry of monthEntries) {
      if (!monthEntry.isDirectory()) {
        continue;
      }
      const candidate = path.join(yearPath, monthEntry.name, `${invocationId}.json`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function flattenReturnedRecordIds(returnedRecordIds = {}) {
  return [
    ...(returnedRecordIds.tactics ?? []),
    ...(returnedRecordIds.invariants ?? []),
    ...(returnedRecordIds.cases ?? []),
    ...(returnedRecordIds.evidence ?? []),
  ];
}

function normalizeUniqueStrings(values = []) {
  return [...new Set((values ?? []).map((value) => String(value)).filter(Boolean))].sort();
}

function sanitizeTimestamp(value) {
  return String(value).replace(/[-:.TZ]/g, "");
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

module.exports = {
  DEFAULT_MEMORY_TOOL_NAME,
  DEFAULT_MEMORY_USAGE_TOOL_NAME,
  MEMORY_CONSULT_TRIGGERS,
  ProjectMemorySurface,
  WORKSPACE_MARKER_FILENAME,
  assertCatalogRootMatches,
  createProjectMemoryRetrievalRuntime,
  findWorkspaceMarker,
  localLanceDbTableExists,
  loadEcitrProjectConfig,
  summarizeMemoryInvocations,
};
