const crypto = require("node:crypto");
const fs = require("node:fs");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const { structuralHash, readerError } = require("./project-memory-reader");
const { inspectEpisodeAttribution, SESSION_REF, RUN_REF } = require("./project-memory-context");

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(require("../../schemas/project_memory_telemetry.schema.json"), "project_memory_telemetry.schema.json");
const validators = {
  1: ajv.getSchema("project_memory_telemetry.schema.json"),
  2: ajv.compile(require("../../schemas/project_memory_telemetry_v2.schema.json")),
};
function validateTelemetry(value) {
  if (!validators[value?.schema_version]?.(value)) throw readerError("invalid_memory_telemetry");
  if (value.schema_version === 2) {
    const { binding, attribution } = value.opportunity;
    const invalid = () => { throw readerError("invalid_memory_telemetry"); };
    if (attribution.retrieval_workspace_id !== binding.workspace_id) invalid();
    if (attribution.session && (attribution.session.ref !== binding.session_ref
      || attribution.task_project_id !== attribution.session.project_id
      || SESSION_REF.exec(attribution.session.ref)?.[1] !== attribution.session.id)) invalid();
    if (attribution.run && (RUN_REF.exec(attribution.run.ref)?.[1] !== attribution.run.id
      || attribution.run.ref !== binding.run_ref || attribution.run.session_ref !== binding.session_ref
      || attribution.run.project_id !== attribution.task_project_id)) invalid();
    if (attribution.status === "verified") {
      const expectedRelation = attribution.task_project_id === binding.workspace_id ? "same_workspace" : "cross_workspace";
      if (attribution.workspace_relation !== expectedRelation
        || (binding.task_workspace_relation != null && binding.task_workspace_relation !== expectedRelation)
        || (expectedRelation === "cross_workspace" && binding.task_workspace_relation !== "cross_workspace")
        || (binding.thread_ref != null && binding.thread_ref !== attribution.session.thread_ref)
        || (binding.run_ref != null && (!attribution.run || attribution.run.ref !== binding.run_ref))) invalid();
    }
  }
  return value;
}

const CONTEXT_FIELDS = ["episode_id", "thread_ref", "session_ref", "run_ref", "lane", "audit_mode", "decision_reason", "retry_of", "task_workspace_relation"];
const LANES = ["micro", "diagnostic", "governed-write", "promotion"];
const AUDIT_MODES = ["strict_no_write", "strict no-write audit", "controlled_read_only", "controlled read-only discovery audit"];
const KNOWN_PHASES = ["catalog_load", "gate_evaluation", "retrieval", "corpus_fingerprint"];
const BACKEND_OBSERVATIONS = new WeakMap();
const unavailable = (reason) => ({ value: null, reason });

function validateTelemetryContext(context = {}) {
  if (!context || typeof context !== "object" || Array.isArray(context)
    || Object.keys(context).some((key) => !CONTEXT_FIELDS.includes(key))) throw readerError("invalid_telemetry_context");
  for (const [key, value] of Object.entries(context)) {
    if (value !== null && (typeof value !== "string" || !value.length || Buffer.byteLength(value, "utf8") > 1024)) {
      throw readerError("invalid_telemetry_context");
    }
    if (key === "lane" && value !== null && !LANES.includes(value)) throw readerError("invalid_telemetry_lane");
    if (key === "audit_mode" && value !== null && !AUDIT_MODES.includes(value)) throw readerError("invalid_telemetry_audit_mode");
    if (key === "task_workspace_relation" && value !== null && !["same_workspace", "cross_workspace"].includes(value)) throw readerError("invalid_telemetry_workspace_relation");
  }
  return context;
}

function isTelemetryExcluded(context = {}) {
  validateTelemetryContext(context);
  return context.lane === "micro" || ["strict_no_write", "strict no-write audit"].includes(context.audit_mode);
}

function buildOpportunity({ projectConfig, taskPacket, context = {}, now, captureBoundary = "caller_selected_before_dispatch", sourceMapPath }) {
  validateTelemetryContext(context);
  const taskId = taskPacket?.task_id ?? null;
  if (taskId !== null && (typeof taskId !== "string" || !taskId.length || Buffer.byteLength(taskId) > 1024)) {
    throw readerError("invalid_telemetry_task_id");
  }
  // A task title is not an identity; neither a bare task ID nor a thread is an episode.
  const identityBasis = ["episode_id", "session_ref", "run_ref"].find((field) => context[field] != null) ?? "unjoined_boundary";
  const binding = {
    workspace_id: projectConfig.workspace_id,
    workspace_root: projectConfig.workspace_root,
    catalog_root: projectConfig.catalog_root,
    task_id: taskId,
    episode_id: context.episode_id ?? null,
    thread_ref: context.thread_ref ?? null,
    session_ref: context.session_ref ?? null,
    run_ref: context.run_ref ?? null,
    task_workspace_relation: context.task_workspace_relation ?? null,
  };
  const identity = {
    workspace_id: binding.workspace_id, workspace_root: binding.workspace_root,
    catalog_root: binding.catalog_root, task_id: taskId, identity_basis: identityBasis,
    episode: identityBasis === "unjoined_boundary" ? crypto.randomUUID() : context[identityBasis],
  };
  return {
    schema_version: 2,
    opportunity: {
      opportunity_id: `memopp_${structuralHash(identity).slice(7)}`,
      recorded_at: now.toISOString(),
      identity_basis: identityBasis,
      binding,
      attribution: inspectEpisodeAttribution({ projectConfig, context, now, sourceMapPath }),
      missing_context: Object.fromEntries(Object.entries(binding).filter(([, value]) => value === null)
        .map(([key]) => [key, "not_supplied"])),
      lane: context.lane ?? null,
      audit_mode: context.audit_mode ?? null,
      lane_reason: context.lane == null ? "not_supplied" : null,
      audit_mode_reason: context.audit_mode == null ? "not_supplied" : null,
      capture_boundary: captureBoundary,
      decision: "pending",
      decision_reason: null,
      decision_at: null,
      marker_sha256: hashLocalFile(projectConfig.marker_path, "marker_unavailable"),
      policy: {
        preflight_retrieval_mandatory: projectConfig.preflight_retrieval_mandatory,
        failure_retry_retrieval_mandatory: projectConfig.failure_retry_retrieval_mandatory,
      },
    },
    attempt: null,
  };
}

function startAttempt({ invocationId, requestId = null, trigger, context = {}, now }) {
  return {
    attempt_id: `memattempt_${crypto.randomUUID()}`,
    invocation_id: invocationId,
    request_id: requestId,
    request_id_reason: requestId === null ? "request_not_composed" : null,
    retry_of: context.retry_of ?? null,
    retry_of_reason: context.retry_of == null ? "not_supplied" : null,
    trigger,
    context: Object.fromEntries(["episode_id", "thread_ref", "session_ref", "run_ref"].map((key) => [key, context[key] ?? null])),
    started_at: now.toISOString(),
    finished_at: null,
    status: "running",
    duration_ms: null,
    duration_reason: "terminal_not_recorded",
    phases_ms: Object.fromEntries(KNOWN_PHASES.map((phase) => [phase, unavailable("not_observed")])),
    error_code: null,
    corpus_sha256: unavailable("catalog_not_loaded"),
    semantic_backend: unavailable("backend_not_observed"),
    index_basis_sha256: unavailable("index_not_observed"),
    embedding_signature: unavailable("embedding_not_observed"),
    model_usage: unavailable("not_exposed_by_project_memory_runtime"),
    cost: unavailable("not_exposed_by_project_memory_runtime"),
  };
}

function hashLocalFile(filePath, absentReason) {
  if (!filePath) return unavailable(absentReason);
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 1024 * 1024) return unavailable("fingerprint_input_unavailable");
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fs.fstatSync(descriptor);
    if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs
      || after.ctimeMs !== stat.ctimeMs) return unavailable("fingerprint_source_changed");
    return { value: crypto.createHash("sha256").update(bytes.subarray(0, length)).digest("hex"), reason: null };
  } catch { return unavailable(absentReason); }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function observeBackend(catalogs, { backend, indexBasisPath = null, indexed = false }) {
  BACKEND_OBSERVATIONS.set(catalogs, {
    semantic_backend: backend?.backendId ? { value: backend.backendId, reason: null } : unavailable("backend_id_not_exposed"),
    index_basis_sha256: indexed ? hashLocalFile(indexBasisPath, "index_basis_unavailable") : unavailable("no_derived_index_selected"),
    embedding_signature: backend?.embedder?.embeddingSignature
      ? { value: backend.embedder.embeddingSignature, reason: null } : unavailable("embedding_signature_not_exposed"),
  });
}

function getBackendObservation(catalogs) {
  return catalogs ? BACKEND_OBSERVATIONS.get(catalogs) ?? {} : {};
}

function buildUseEvidence({ inspectedRecordIds = [], useEvidence = [] } = {}) {
  if (!Array.isArray(inspectedRecordIds) || inspectedRecordIds.length > 100
    || inspectedRecordIds.some((id) => typeof id !== "string" || !id.length || Buffer.byteLength(id) > 160)
    || !Array.isArray(useEvidence) || useEvidence.length > 100) throw readerError("invalid_use_evidence");
  const links = useEvidence.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).some((key) => !["record_id", "decision_ref", "output_ref", "support_ref", "reviewer_ref"].includes(key))
      || typeof entry.record_id !== "string" || !entry.record_id.length || Buffer.byteLength(entry.record_id) > 160
      || (!entry.decision_ref && !entry.output_ref)) throw readerError("invalid_use_evidence");
    for (const key of ["decision_ref", "output_ref", "support_ref", "reviewer_ref"]) {
      if (entry[key] != null && (typeof entry[key] !== "string" || !entry[key].length || Buffer.byteLength(entry[key]) > 1024)) {
        throw readerError("invalid_use_evidence");
      }
    }
    return {
      record_id: entry.record_id,
      decision_ref: entry.decision_ref ?? null,
      output_ref: entry.output_ref ?? null,
      support_ref: entry.support_ref ?? null,
      reviewer_ref: entry.reviewer_ref ?? null,
      corroboration: unavailable("reference_declarations_only"),
    };
  });
  return {
    schema_version: 1,
    inspected_record_ids: [...new Set(inspectedRecordIds)].sort(),
    links,
    measured_benefit: unavailable("matched_outcome_evaluation_not_provided"),
  };
}

function describeUsageFollowthrough(artifact) {
  const recorded = typeof artifact.usage_recorded_at === "string";
  const linked = new Set((artifact.use_evidence?.links ?? [])
    .filter((entry) => entry.decision_ref || entry.output_ref).map((entry) => entry.record_id));
  const used = recorded && artifact.used_memory === true
    ? artifact.used_returned_record_ids ?? artifact.used_record_ids ?? [] : [];
  return {
    invocation_id: artifact.invocation_id,
    attempt_id: artifact.telemetry?.attempt?.attempt_id ?? null,
    callback_status: artifact.memory_consulted !== true ? "not_applicable" : recorded ? "recorded" : "missing",
    used_record_ids_without_references: used.filter((id) => !linked.has(id)),
  };
}

module.exports = {
  validateTelemetry, buildOpportunity, startAttempt, hashLocalFile, observeBackend, getBackendObservation,
  buildUseEvidence, validateTelemetryContext, isTelemetryExcluded, unavailable,
  describeUsageFollowthrough,
};
