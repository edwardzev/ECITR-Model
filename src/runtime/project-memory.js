const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const { performance } = require("node:perf_hooks");
const { summarizeTelemetryArtifacts } = require("./project-memory-telemetry-report");
const {
  validateTelemetry, buildOpportunity, startAttempt, observeBackend, getBackendObservation,
  buildUseEvidence, isTelemetryExcluded, unavailable,
} = require("./project-memory-telemetry");

const { buildSemanticEmbedder } = require("../retrieval/embedders/factory");
const { buildDefaultLanes } = require("../retrieval/lanes");
const { RetrievalGate } = require("../retrieval/retrieval-gate");
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
  READER_LIMITS,
  assertBoundedString,
  buildRetrievalBasis,
  prepareSelectedRecords,
  readerError,
  structuralHash,
  validateSelection,
} = require("./project-memory-reader");
const {
  WORKSPACE_MARKER_FILENAME,
  assertCatalogRootMatches,
  findWorkspaceMarker,
  loadEcitrProjectConfig,
} = require("../workspace/config");
const DEFAULT_MEMORY_TOOL_NAME = "search_project_memory";
const DEFAULT_MEMORY_USAGE_TOOL_NAME = "record_memory_usage";
const DEFAULT_MEMORY_READER_TOOL_NAME = "read_project_memory_records";
const INVOCATION_UPDATE_WAIT_MS = 2000;
const MAX_INVOCATION_BYTES = 4 * 1024 * 1024;
const MEMORY_CONSULT_TRIGGERS = Object.freeze([
  "discretionary",
  "preflight",
  "failure_retry",
]);

class ProjectMemorySurface {
  constructor({
    catalog,
    retrievalRuntime,
    retrievalGate = new RetrievalGate(),
    projectConfig = loadEcitrProjectConfig({ startDir: catalog?.rootDir }),
    artifactRoot,
    monotonicNow = () => performance.now(),
    wallNow = () => new Date(),
  } = {}) {
    this.monotonicNow = monotonicNow;
    this.wallNow = wallNow;
    this.catalog = catalog;
    this.retrievalRuntime = retrievalRuntime;
    this.retrievalGate = retrievalGate;
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
        reader_tool_name: DEFAULT_MEMORY_READER_TOOL_NAME,
      };
    }

    return {
      available: true,
      tool_name: DEFAULT_MEMORY_TOOL_NAME,
      usage_tool_name: DEFAULT_MEMORY_USAGE_TOOL_NAME,
      reader_tool_name: DEFAULT_MEMORY_READER_TOOL_NAME,
      marker_path: this.projectConfig.marker_path,
      catalog_root: this.projectConfig.catalog_root,
      workspace_id: this.projectConfig.workspace_id,
      default_project_scope: this.projectConfig.default_project_scope,
      preflight_retrieval_mandatory: this.projectConfig.preflight_retrieval_mandatory,
      failure_retry_retrieval_mandatory: this.projectConfig.failure_retry_retrieval_mandatory,
      discretionary_only: !this.projectConfig.preflight_retrieval_mandatory
        && !this.projectConfig.failure_retry_retrieval_mandatory,
      retrieval_gate: {
        gate_id: this.retrievalGate.gateId,
        mode: "shadow",
        enforcement: "disabled",
      },
    };
  }

  evaluateRetrievalGate({
    query,
    intent = "analysis",
    trigger = "discretionary",
  } = {}) {
    if (!this.projectConfig) {
      return null;
    }

    return this.retrievalGate.evaluate({
      query,
      intent,
      trigger,
      projectConfig: this.projectConfig,
    });
  }

  beginTaskOpportunity({ taskPacket, telemetryContext = {}, query, intent = "analysis", trigger = "discretionary", captureBoundary = "caller_selected_before_dispatch", now = new Date() } = {}) {
    if (!this.projectConfig || isTelemetryExcluded(telemetryContext)) return null;
    const telemetry = buildOpportunity({ projectConfig: this.projectConfig, taskPacket, context: telemetryContext, now, captureBoundary });
    const invocationId = `meminv_opportunity_${telemetry.opportunity.opportunity_id.slice(7)}`;
    const existingPath = findInvocationArtifactPath({ artifactRoot: this.artifactRoot, invocationId });
    let invocation;
    if (existingPath) {
      invocation = updateMemoryInvocation({ artifactRoot: this.artifactRoot, invocationId,
        update: (artifact, artifactPath) => ({ result: invocationSummary(artifact, artifactPath) }) });
    } else {
      try {
        invocation = writeMemoryInvocation({ artifactRoot: this.artifactRoot, projectConfig: this.projectConfig,
          consultedAt: now, taskPacket, memoryConsulted: false, consultTrigger: null, request: null, retrieval: null,
          telemetry, invocationId });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        // Atomic creation may lose to another process at the same lifecycle boundary.
        invocation = updateMemoryInvocation({ artifactRoot: this.artifactRoot, invocationId,
          update: (artifact, artifactPath) => ({ result: invocationSummary(artifact, artifactPath) }) });
      }
    }
    return updateMemoryInvocation({ artifactRoot: this.artifactRoot, invocationId, update: (artifact, artifactPath) => {
      if (Object.hasOwn(artifact.telemetry.opportunity, "gate_observation")) {
        return { result: invocationSummary(artifact, artifactPath) };
      }
      const actualQuery = query ?? taskPacket?.objective ?? taskPacket?.title ?? null;
      const started = this.monotonicNow();
      let evaluation = null;
      let gap = null;
      if (typeof actualQuery !== "string" || !actualQuery.trim()) gap = "query_not_available";
      else {
        try {
          const { actual_behavior, ...observation } = this.evaluateRetrievalGate({ query: actualQuery, intent, trigger });
          evaluation = observation;
        } catch { gap = "gate_evaluation_failed"; }
      }
      artifact.telemetry.opportunity.gate_observation = {
        evaluation, reason: gap,
        observed_at: this.wallNow().toISOString(),
        duration_ms: this.monotonicNow() - started,
        input_source: query != null ? "query" : taskPacket?.objective != null ? "task_objective" : taskPacket?.title != null ? "task_title" : null,
        query_sha256: actualQuery == null ? null : structuralHash(actualQuery),
      };
      return { nextArtifact: artifact, result: invocationSummary(artifact, artifactPath) };
    } });
  }

  decideTaskOpportunity({ opportunity, decision, reason = null, trigger = "discretionary", now = new Date() }) {
    if (!opportunity) return null;
    return updateMemoryInvocation({ artifactRoot: this.artifactRoot, invocationId: opportunity.invocation_id,
      update: (artifact, artifactPath) => {
        const current = artifact.telemetry.opportunity;
        const satisfyingMandatory = current.decision === "blocked" && current.decision_reason === "mandatory_retrieval_required" && decision === "consult";
        if (current.decision !== "pending" && current.decision !== decision && !satisfyingMandatory) throw readerError("opportunity_decision_conflict");
        if (current.decision === decision) return { result: invocationSummary(artifact, artifactPath) };
        const skipForbidden = decision === "skip" && (this.projectConfig.preflight_retrieval_mandatory
          || (trigger === "failure_retry" && this.projectConfig.failure_retry_retrieval_mandatory));
        const resolvedDecision = skipForbidden ? "blocked" : decision;
        artifact.telemetry.opportunity = { ...current, decision: resolvedDecision,
          decision_reason: skipForbidden ? "mandatory_retrieval_required" : reason,
          decision_at: now.toISOString() };
        const gate = current.gate_observation?.evaluation;
        artifact.retrieval_gate = gate ? { ...gate,
          actual_behavior: resolvedDecision === "skip" ? "not_consulted" : resolvedDecision === "blocked" ? "blocked" : "retrieve_always" } : null;
        return { nextArtifact: artifact, result: invocationSummary(artifact, artifactPath) };
      } });
  }

  logTaskOpportunity({ taskPacket, telemetryContext = {}, query, trigger = "discretionary", now = new Date() } = {}) {
    const opportunity = this.beginTaskOpportunity({ taskPacket, telemetryContext, query, trigger, now });
    const result = this.decideTaskOpportunity({ opportunity, decision: "skip", reason: telemetryContext.decision_reason ?? "no_consult_reported", trigger, now: this.wallNow() });
    if (result?.decision === "blocked") {
      const error = readerError("mandatory_retrieval_required");
      error.memory_invocation = result;
      throw error;
    }
    return result;
  }

  // Compatibility for external producers that already finished retrieval. Do not
  // fabricate pre-decision coverage or elapsed time for these post-hoc records.
  logConsultation({ taskPacket, consultTrigger, request = null, retrieval = null, catalogs,
    gateEvaluation = null, telemetryContext = {}, now = new Date() } = {}) {
    if (!this.projectConfig || isTelemetryExcluded(telemetryContext)) return null;
    const telemetry = buildOpportunity({ projectConfig: this.projectConfig, taskPacket, context: telemetryContext, now, captureBoundary: "post_execution" });
    telemetry.opportunity.decision = "consult";
    telemetry.opportunity.decision_at = now.toISOString();
    telemetry.opportunity.decision_reason = "post_execution_consultation";
    return writeMemoryInvocation({ artifactRoot: this.artifactRoot, projectConfig: this.projectConfig,
      consultedAt: now, taskPacket, memoryConsulted: true, consultTrigger, request, retrieval, catalogs,
      gateEvaluation, telemetry });
  }

  async executeConsultation({ opportunity = null, taskPacket, telemetryContext = {}, query, intent = "analysis",
    trigger = "discretionary", request = null, execute, signal, now = new Date() } = {}) {
    if (isTelemetryExcluded(telemetryContext)) throw readerError("memory_telemetry_excluded");
    if (!this.projectConfig) return { ...await execute({ measure: async (_phase, action) => action(), captureCatalogs() {} }), memory_invocation: null };
    const anchor = opportunity ?? this.beginTaskOpportunity({ taskPacket, telemetryContext, query: query ?? request?.query, intent, trigger, now });
    this.decideTaskOpportunity({ opportunity: anchor, decision: "consult", trigger,
      reason: telemetryContext.decision_reason ?? "explicit_consultation", now: this.wallNow() });
    let invocation = updateMemoryInvocation({ artifactRoot: this.artifactRoot, invocationId: anchor.invocation_id,
      update: (artifact, artifactPath) => {
        if (artifact.telemetry.attempt) return { result: { prior: artifact } };
        artifact.memory_consulted = true;
        artifact.consult_trigger = trigger;
        artifact.request = request ? structuredClone(request) : null;
        artifact.telemetry.attempt = startAttempt({ invocationId: artifact.invocation_id, requestId: request?.request_id, trigger, context: telemetryContext, now });
        return { nextArtifact: artifact, result: invocationSummary(artifact, artifactPath) };
      } });
    if (invocation.prior) {
      const telemetry = { ...structuredClone(invocation.prior.telemetry), attempt: null };
      const invocationId = `meminv_${crypto.randomUUID()}`;
      telemetry.attempt = startAttempt({ invocationId, requestId: request?.request_id, trigger, context: telemetryContext, now });
      invocation = writeMemoryInvocation({ artifactRoot: this.artifactRoot, projectConfig: this.projectConfig,
        consultedAt: now, taskPacket, memoryConsulted: true, consultTrigger: trigger, request, retrieval: null, telemetry, invocationId });
    }
    const phases = {};
    let catalogs = null;
    let corpusSha256 = null;
    let result = null;
    let failure = null;
    const started = this.monotonicNow();
    try {
      if (signal?.aborted) throw Object.assign(readerError("retrieval_cancelled"), { name: "AbortError" });
      result = await execute({
        measure: async (phase, action) => {
          const before = this.monotonicNow();
          try {
            const value = await action();
            if (phase === "corpus_fingerprint") corpusSha256 = value;
            return value;
          }
          finally { phases[phase] = { value: this.monotonicNow() - before, reason: null }; }
        },
        captureCatalogs: (snapshot) => { catalogs = snapshot; },
      });
    } catch (error) { failure = error; }
    const duration = this.monotonicNow() - started;
    const cancelled = failure?.name === "AbortError" || failure?.code === "ABORT_ERR";
    invocation = updateMemoryInvocation({ artifactRoot: this.artifactRoot, invocationId: invocation.invocation_id,
      update: (artifact, artifactPath) => {
        const attempt = artifact.telemetry.attempt;
        if (attempt.status !== "running") throw readerError("attempt_terminal_already_recorded");
        artifact.telemetry.attempt = { ...attempt,
          status: failure ? cancelled ? "cancelled" : "failed" : "succeeded",
          finished_at: this.wallNow().toISOString(), duration_ms: duration, duration_reason: null,
          phases_ms: { ...attempt.phases_ms, ...phases },
          error_code: failure ? cancelled ? "retrieval_cancelled" : "retrieval_failed" : null,
          corpus_sha256: result?.corpus_sha256 ?? corpusSha256 ?? unavailable(catalogs ? "catalog_fingerprint_not_recorded" : "catalog_not_loaded"),
          ...getBackendObservation(catalogs),
        };
        if (result) {
          artifact.request = result.request ?? artifact.request;
          artifact.telemetry.attempt.request_id = artifact.request?.request_id ?? null;
          artifact.telemetry.attempt.request_id_reason = artifact.request?.request_id ? null : "request_not_exposed";
          artifact.returned_counts = buildReturnedCounts(result.retrieval);
          artifact.returned_record_ids = buildReturnedRecordIds(result.retrieval);
          const basis = buildRetrievalBasis(artifact.returned_record_ids, catalogs);
          if (basis) artifact.retrieval_basis = basis;
          artifact.retrieval_gate = result.gateEvaluation ?? artifact.retrieval_gate;
        }
        return { nextArtifact: artifact, result: invocationSummary(artifact, artifactPath) };
      } });
    if (failure) {
      const error = readerError(cancelled ? "retrieval_cancelled" : "retrieval_failed");
      error.memory_invocation = invocation;
      throw error;
    }
    return { ...result, memory_invocation: invocation };
  }

  async searchProjectMemory({ query, taskPacket, projectScope = this.projectConfig?.default_project_scope,
    intent = "analysis", allowedLayers, maxResultsPerLayer, trigger = "discretionary",
    telemetryContext = {}, signal, now = new Date() } = {}) {
    if (!this.projectConfig) throw new Error("Project memory is not configured for this workspace.");
    const result = await this.executeConsultation({ taskPacket, query, intent, trigger, telemetryContext, signal, now,
      execute: async ({ measure, captureCatalogs }) => {
        if (!query || !String(query).trim()) throw new Error("search_project_memory requires a non-empty query.");
        if (!MEMORY_CONSULT_TRIGGERS.includes(trigger)) throw new Error("Invalid search_project_memory trigger.");
        const request = { request_id: buildRequestId({ query, trigger, now }), query: String(query).trim(),
          workspace_id: this.projectConfig.workspace_id, project_scope: projectScope, intent };
        if (allowedLayers) request.allowed_layers = [...allowedLayers];
        if (maxResultsPerLayer) request.max_results_per_layer = structuredClone(maxResultsPerLayer);
        const catalogs = await measure("catalog_load", () => this.catalog.loadRuntimeCatalogs());
        captureCatalogs(catalogs);
        const corpusSha256 = await measure("corpus_fingerprint", () => ({ value: structuralHash(catalogs), reason: null }));
        const retrieval = await measure("retrieval", () => this.retrievalRuntime.execute({ request, catalogs, now }));
        return { request, retrieval, corpus_sha256: corpusSha256 };
      } });
    return { retrieval: result.retrieval, retrieval_gate: result.memory_invocation.retrieval_gate,
      memory_surface: this.describe(), memory_invocation: result.memory_invocation };
  }

  async search_project_memory(args) {
    return this.searchProjectMemory(args);
  }

  readProjectMemoryRecords({ invocationId, recordIds, evidenceExcerpt = null, now = new Date() } = {}) {
    validateSelection({ recordIds, evidenceExcerpt });
    if (!this.projectConfig || !this.catalog) throw readerError("project_memory_not_configured");
    return updateMemoryInvocation({
      artifactRoot: this.artifactRoot,
      invocationId,
      update: (artifact) => {
        const currentConfig = this.projectConfig.marker_path
          ? loadEcitrProjectConfig({ filePath: this.projectConfig.marker_path })
          : this.projectConfig;
        assertReaderBinding({ artifact, projectConfig: currentConfig, catalog: this.catalog });
        const prepared = prepareSelectedRecords({ catalog: this.catalog, artifact, recordIds, evidenceExcerpt, now });
        const receipts = artifact.read_receipts ?? [];
        if (!Array.isArray(receipts) || receipts.length > READER_LIMITS.receipts
          || receipts.some((receipt) => !/^read_[a-f0-9]{64}$/.test(receipt?.receipt_id ?? "")
            || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(receipt?.prepared_at ?? ""))
          || new Set(receipts.map((receipt) => receipt.receipt_id)).size !== receipts.length) {
          throw readerError("invalid_read_receipts");
        }
        const existing = receipts.find((receipt) => receipt.receipt_id === prepared.receipt.receipt_id);
        if (existing) {
          prepared.response.receipt.prepared_at = existing.prepared_at;
          prepared.response.receipt.reused = true;
          return { result: prepared.response };
        }
        if (receipts.length === READER_LIMITS.receipts) throw readerError("read_receipt_cap_reached");
        return {
          nextArtifact: { ...artifact, read_receipts: [...receipts, prepared.receipt] },
          result: prepared.response,
        };
      },
    });
  }

  read_project_memory_records(args) {
    return this.readProjectMemoryRecords(args);
  }

  recordMemoryUsage({
    invocationId,
    usedRecordIds = [],
    selectedRecordIds = [],
    inspectedRecordIds = [],
    useEvidence = [],
    now = new Date(),
  } = {}) {
    if (!invocationId) {
      throw new Error("record_memory_usage requires an invocationId.");
    }
    if (!this.projectConfig) {
      throw new Error("Project memory is not configured for this workspace.");
    }

    return updateMemoryInvocation({
      artifactRoot: this.artifactRoot,
      invocationId,
      update: (artifact, artifactPath) => {
        if (artifact.workspace_id !== this.projectConfig.workspace_id) throw readerError("invocation_workspace_mismatch");
        const returnedRecordIds = new Set(flattenReturnedRecordIds(artifact.returned_record_ids));
        for (const ids of [usedRecordIds, selectedRecordIds]) {
          if (!Array.isArray(ids) || ids.length > 100 || ids.some((id) => typeof id !== "string" || !id.length || Buffer.byteLength(id) > 160)) throw readerError("invalid_usage_record_ids");
        }
        const normalizedUsedRecordIds = normalizeUniqueStrings(usedRecordIds);
        const normalizedSelectedRecordIds = normalizeUniqueStrings(selectedRecordIds);
        const usedReturnedRecordIds = normalizedUsedRecordIds.filter((recordId) => returnedRecordIds.has(recordId));
        const useEvidenceReport = buildUseEvidence({ inspectedRecordIds, useEvidence });
        if (useEvidenceReport.links.some((entry) => !usedReturnedRecordIds.includes(entry.record_id))) throw readerError("use_evidence_record_not_used");
        const nextArtifact = {
          ...artifact,
          use_evidence: useEvidenceReport,
          usage_recorded_at: now.toISOString(),
          used_record_ids: normalizedUsedRecordIds,
          selected_record_ids: normalizedSelectedRecordIds,
          used_returned_record_ids: usedReturnedRecordIds,
          used_memory: usedReturnedRecordIds.length > 0,
        };
        return {
          nextArtifact,
          result: {
            invocation_id: nextArtifact.invocation_id,
            artifact_path: artifactPath,
            used_memory: nextArtifact.used_memory,
            used_returned_record_ids: nextArtifact.used_returned_record_ids,
            selected_record_ids: nextArtifact.selected_record_ids,
          },
        };
      },
    });
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
    lanesFactory({ catalogs, canonicalCatalogs = catalogs, plan }) {
      const indexed = tableExists({
        uri: effectiveLanceDbUri,
        tableName: effectiveLanceDbTableName,
        catalogRoot: canonicalCatalogs?.__catalogRoot,
        catalogs: canonicalCatalogs,
        expectedEmbeddingSignature: () => getEmbedder().embeddingSignature ?? null,
        constrainDefaultUriToDefaultCatalog,
      });
      const semanticBackend = indexed
        ? buildLanceDbBackend({
          uri: effectiveLanceDbUri,
          tableName: effectiveLanceDbTableName,
          catalogs: canonicalCatalogs,
          embedder: getEmbedder(),
          maximumDistance: lancedbMaximumDistance,
        })
        : buildFallbackBackend({ catalogs });
      observeBackend(canonicalCatalogs, { backend: semanticBackend, indexed,
        indexBasisPath: path.join(String(effectiveLanceDbUri), `${effectiveLanceDbTableName}.basis.json`) });
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
  catalogs,
  gateEvaluation = null,
  telemetry,
  invocationId: explicitInvocationId,
}) {
  const invocationId = explicitInvocationId ?? buildInvocationId({
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
    retrieval_gate: gateEvaluation ? structuredClone(gateEvaluation) : null,
    returned_counts: buildReturnedCounts(retrieval),
    returned_record_ids: buildReturnedRecordIds(retrieval),
    usage_recorded_at: null,
    used_record_ids: [],
    selected_record_ids: [],
    used_returned_record_ids: [],
    used_memory: false,
    ...(telemetry ? { telemetry } : {}),
  };
  if (artifact.telemetry) validateTelemetry(artifact.telemetry);
  const retrievalBasis = buildRetrievalBasis(artifact.returned_record_ids, catalogs);
  if (retrievalBasis) artifact.retrieval_basis = retrievalBasis;

  const artifactPath = buildArtifactPath({
    artifactRoot,
    invocationId,
    consultedAt,
  });
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  const temporaryPath = `${artifactPath}.${crypto.randomUUID()}.tmp`;
  let descriptor;
  try {
    const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    if (bytes.length > MAX_INVOCATION_BYTES) throw readerError("invocation_budget_exceeded");
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporaryPath, artifactPath); // Publish the complete file without replacing another writer.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
  return invocationSummary(artifact, artifactPath);
}

function invocationSummary(artifact, artifactPath) {
  return {
    invocation_id: artifact.invocation_id,
    artifact_path: artifactPath,
    memory_consulted: artifact.memory_consulted,
    consult_trigger: artifact.consult_trigger,
    returned_counts: artifact.returned_counts,
    returned_record_ids: artifact.returned_record_ids,
    retrieval_gate: artifact.retrieval_gate,
    ...(artifact.telemetry ? { opportunity_id: artifact.telemetry.opportunity.opportunity_id,
      decision: artifact.telemetry.opportunity.decision, attempt: artifact.telemetry.attempt } : {}),
  };
}

function summarizeMemoryInvocations({ artifactRoot, since = null, until = null, eligiblePopulation = null } = {}) {
  const artifacts = loadMemoryInvocationArtifacts({ artifactRoot, since, until });
  return {
    artifact_root: path.resolve(artifactRoot),
    since: since ? new Date(since).toISOString() : null,
    until: until ? new Date(until).toISOString() : null,
    ...summarizeTelemetryArtifacts(artifacts, { eligiblePopulation }),
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
  return `req_project_memory_${timestamp}_${digest}_${crypto.randomUUID().slice(0, 8)}`;
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
  if (invocationId.startsWith("meminv_opportunity_")) return path.join(artifactRoot, "anchors", "v1", `${invocationId}.json`);
  const year = String(consultedAt.getUTCFullYear());
  const month = String(consultedAt.getUTCMonth() + 1).padStart(2, "0");
  return path.join(artifactRoot, year, month, `${invocationId}.json`);
}

function findInvocationArtifactPath({ artifactRoot, invocationId }) {
  assertBoundedString(invocationId, 136, "invalid_invocation_id");
  if (!/^meminv_[A-Za-z0-9_-]+$/.test(invocationId)) throw readerError("invalid_invocation_id");
  if (!fs.existsSync(artifactRoot)) {
    return null;
  }

  const matches = [];
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
        matches.push(candidate);
      }
    }
  }

  if (matches.length > 1) throw readerError("duplicate_invocation_matches");
  return matches[0] ?? null;
}

function assertReaderBinding({ artifact, projectConfig, catalog }) {
  if (artifact.memory_consulted !== true || artifact.tool_name !== DEFAULT_MEMORY_TOOL_NAME) throw readerError("not_a_consultation");
  if (!artifact.request) throw readerError("missing_retrieval_request");
  try { catalog.validator.validateRecord("retrieval_request", artifact.request); }
  catch { throw readerError("invalid_retrieval_request"); }
  assertBoundedString(artifact.workspace_id, 128, "invalid_invocation_workspace");
  if (artifact.workspace_id !== projectConfig.workspace_id
    || artifact.request.workspace_id !== projectConfig.workspace_id) throw readerError("invocation_workspace_mismatch");
  if (artifact.catalog_root !== projectConfig.catalog_root || catalog.rootDir !== projectConfig.catalog_root) throw readerError("invocation_catalog_mismatch");
  if (artifact.marker_path !== projectConfig.marker_path
    || artifact.default_project_scope !== projectConfig.default_project_scope) throw readerError("invocation_marker_mismatch");
}

function updateMemoryInvocation({ artifactRoot, invocationId, update }) {
  const artifactPath = findInvocationArtifactPath({ artifactRoot, invocationId });
  if (!artifactPath) throw readerError("invocation_not_found");
  const root = fs.realpathSync(artifactRoot);
  const realArtifactPath = fs.realpathSync(artifactPath);
  const relative = path.relative(root, realArtifactPath);
  const expectedPath = path.join(root, path.relative(path.resolve(artifactRoot), artifactPath));
  if (realArtifactPath !== expectedPath || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw readerError("unsafe_invocation_path");
  }
  const lockPath = `${artifactPath}.lock`;
  const deadline = Date.now() + INVOCATION_UPDATE_WAIT_MS;
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  let descriptor;
  while (descriptor === undefined) {
    try { descriptor = fs.openSync(lockPath, "wx", 0o600); }
    catch (error) {
      if (error.code !== "EEXIST") throw readerError("invocation_lock_failed");
      if (Date.now() >= deadline) throw readerError("invocation_update_contended");
      Atomics.wait(waitBuffer, 0, 0, 20);
    }
  }
  const ownedLock = fs.fstatSync(descriptor);
  try {
    if (findInvocationArtifactPath({ artifactRoot, invocationId }) !== artifactPath
      || fs.realpathSync(artifactPath) !== realArtifactPath) throw readerError("invocation_changed_during_update");
    const snapshot = readInvocationSnapshot(artifactPath, realArtifactPath);
    const artifact = JSON.parse(snapshot.text);
    if (artifact.invocation_id !== invocationId) throw readerError("invocation_identity_mismatch");
    const { nextArtifact, result } = update(artifact, artifactPath);
    if (nextArtifact) replaceInvocationAtomically(artifactPath, nextArtifact, snapshot);
    else assertInvocationSnapshotUnchanged(artifactPath, snapshot);
    return result;
  } finally {
    try {
      const currentLock = fs.lstatSync(lockPath);
      if (currentLock.ino === ownedLock.ino && currentLock.dev === ownedLock.dev) fs.unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    } finally { fs.closeSync(descriptor); }
  }
}

function sameInvocationFileState(left, right) {
  return left.isFile() && right.isFile() && left.ino === right.ino && left.dev === right.dev
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function readInvocationSnapshot(artifactPath, realArtifactPath) {
  let descriptor;
  try {
    const pathStat = fs.lstatSync(artifactPath);
    if (!pathStat.isFile() || pathStat.size > MAX_INVOCATION_BYTES) throw readerError("invalid_invocation_artifact");
    descriptor = fs.openSync(artifactPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(descriptor);
    if (!sameInvocationFileState(pathStat, stat) || fs.realpathSync(artifactPath) !== realArtifactPath) {
      throw readerError("invocation_changed_during_update");
    }
    if (stat.size > MAX_INVOCATION_BYTES) throw readerError("invalid_invocation_artifact");
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length !== stat.size || !sameInvocationFileState(stat, fs.fstatSync(descriptor))
      || !sameInvocationFileState(stat, fs.lstatSync(artifactPath))
      || fs.realpathSync(artifactPath) !== realArtifactPath) throw readerError("invocation_changed_during_update");
    const bytes = buffer.subarray(0, length);
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw readerError("invalid_invocation_utf8"); }
    return { bytes, text, stat, realArtifactPath };
  } catch (error) {
    if (error.code && !/^[A-Z]/.test(error.code)) throw error;
    if (["ENOENT", "ELOOP"].includes(error.code)) throw readerError("invocation_changed_during_update");
    throw readerError("invocation_read_failed");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertInvocationSnapshotUnchanged(artifactPath, snapshot) {
  try {
    const current = readInvocationSnapshot(artifactPath, snapshot.realArtifactPath);
    if (!sameInvocationFileState(snapshot.stat, current.stat) || !snapshot.bytes.equals(current.bytes)) {
      throw readerError("invocation_changed_during_update");
    }
  } catch { throw readerError("invocation_changed_during_update"); }
}

function replaceInvocationAtomically(artifactPath, artifact, snapshot) {
  if (artifact.telemetry) validateTelemetry(artifact.telemetry);
  const tempPath = `${artifactPath}.${crypto.randomUUID()}.tmp`;
  let descriptor;
  try {
    const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    if (bytes.length > MAX_INVOCATION_BYTES) throw readerError("invocation_budget_exceeded");
    descriptor = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    assertInvocationSnapshotUnchanged(artifactPath, snapshot);
    fs.renameSync(tempPath, artifactPath);
  } catch (error) {
    if (error.code === "invocation_changed_during_update") throw error;
    throw readerError("invocation_persistence_failed");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
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
  DEFAULT_MEMORY_READER_TOOL_NAME,
  MEMORY_CONSULT_TRIGGERS,
  ProjectMemorySurface,
  WORKSPACE_MARKER_FILENAME,
  assertCatalogRootMatches,
  createProjectMemoryRetrievalRuntime,
  findWorkspaceMarker,
  localLanceDbTableExists,
  loadEcitrProjectConfig,
  loadMemoryInvocationArtifacts,
  summarizeMemoryInvocations,
};
