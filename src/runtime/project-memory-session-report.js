const path = require("node:path");
const { loadMemoryInvocationArtifactsStrict } = require("./project-memory");
const { contextFromSessionFile, inspectEpisodeAttribution } = require("./project-memory-context");
const { deduplicateArtifacts, summarizeTelemetryArtifacts } = require("./project-memory-telemetry-report");
const { validateTelemetry, buildUseEvidence } = require("./project-memory-telemetry");
const { readerError, structuralHash } = require("./project-memory-reader");

const THREAD_REF = /^codex-thread:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const identity = (entry) => JSON.stringify([entry.workspace_id, entry.invocation_id]);
const validDate = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const sourceHashes = (attribution) => ["source_map", "registry", "session", "run"]
  .map((key) => attribution[key]?.sha256 ?? null).join(":");
const same = (left, right) => structuralHash(left) === structuralHash(right);

function checkUsage(artifact) {
  const invalid = () => { throw readerError("invalid_usage_callback_shape"); };
  for (const field of ["used_record_ids", "used_returned_record_ids", "selected_record_ids"]) {
    const ids = artifact[field];
    if (ids != null && (!Array.isArray(ids) || ids.length > 100 || ids.some((id) =>
      typeof id !== "string" || !id || Buffer.byteLength(id) > 160))) invalid();
  }
  if (artifact.usage_recorded_at == null) return;
  if (!validDate(artifact.usage_recorded_at) || typeof artifact.used_memory !== "boolean") invalid();
  const returned = new Set();
  for (const layer of ["tactics", "invariants", "cases", "evidence"]) {
    const ids = artifact.returned_record_ids?.[layer] ?? [];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id)) invalid();
    for (const id of ids) returned.add(id);
  }
  // The writer permits reported IDs that were not returned, but excludes them
  // from used_returned_record_ids and from the used_memory declaration.
  const expectedUsed = [...new Set(artifact.used_record_ids ?? [])].filter((id) => returned.has(id)).sort();
  if ((artifact.used_returned_record_ids != null && !same(artifact.used_returned_record_ids, expectedUsed))
    || artifact.used_memory !== (expectedUsed.length > 0)) invalid();
  if (artifact.use_evidence != null) {
    const evidence = artifact.use_evidence;
    if (evidence.schema_version !== 1 || !Array.isArray(evidence.links)) invalid();
    const links = evidence.links.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) invalid();
      const { corroboration, ...declaration } = entry;
      return declaration;
    });
    // Reuse the writer's type, size and reference rules; comparison also rejects
    // invented corroboration/benefit metadata or unsupported evidence fields.
    const expected = buildUseEvidence({ inspectedRecordIds: evidence.inspected_record_ids, useEvidence: links });
    if (!same(evidence, expected) || links.some((entry) => !expectedUsed.includes(entry.record_id))) invalid();
  }
}

function checkEnvelope(artifact) {
  if (typeof artifact.invocation_id !== "string" || !/^meminv_[A-Za-z0-9_-]{1,129}$/.test(artifact.invocation_id)
    || typeof artifact.workspace_id !== "string" || !artifact.workspace_id
    || !validDate(artifact.consulted_at) || typeof artifact.memory_consulted !== "boolean") {
    throw readerError("invalid_invocation_shape");
  }
  checkUsage(artifact);
  // Exercise the existing projection before accepting metadata. Invalid nested
  // receipt/evidence shapes cannot disappear as an apparent zero-callback gap.
  summarizeTelemetryArtifacts([artifact]);
}

function summarizeSessionMemoryInvocations({ artifactRoot, projectConfig, sessionFile = null,
  context = {}, sourceMapPath, now = new Date(), loader = loadMemoryInvocationArtifactsStrict } = {}) {
  const resolved = sessionFile
    ? contextFromSessionFile({ sessionFile, projectConfig, context, sourceMapPath, now }) : { ...context };
  const inspect = (input) => inspectEpisodeAttribution({ projectConfig, context: input, sourceMapPath, now, includeLifecycle: true });
  let attribution = inspect(resolved);
  if (attribution.status !== "verified") throw readerError(attribution.reason);
  const storedRun = attribution.lifecycle.stored_run_ref;
  if (storedRun != null) {
    if (resolved.run_ref != null && resolved.run_ref !== storedRun) throw readerError("session_run_ref_conflict");
    resolved.run_ref = storedRun;
    attribution = inspect(resolved);
    if (attribution.status !== "verified") throw readerError(attribution.reason);
    if (attribution.run.thread_ref !== attribution.session.thread_ref) throw readerError("run_thread_ref_conflict");
  }
  const issues = [];
  const status = attribution.lifecycle.session_status;
  if (!["active", "closed", "abandoned"].includes(status)) issues.push({ reason: "session_status_unrecognized" });
  if (status === "closed" && !storedRun) issues.push({ reason: "closed_session_run_ref_missing" });
  if (status !== "closed" && storedRun) issues.push({ reason: "run_link_on_unclosed_session" });

  const collection = loader({ artifactRoot });
  const rows = [];
  for (const row of collection.artifacts) {
    try { checkEnvelope(row.artifact); rows.push(row); }
    catch (error) { issues.push({ path: row.path, reason: error.code ?? "invalid_invocation_shape" }); }
  }
  // Expand identities before deduplication. A conflicting delivery bound to a
  // different session must remain visible to the existing conflict quarantine.
  const targetKeys = new Set(rows.filter(({ artifact }) =>
    artifact.telemetry?.opportunity?.binding?.session_ref === resolved.session_ref).map(({ artifact }) => identity(artifact)));
  const related = rows.filter(({ artifact }) => targetKeys.has(identity(artifact)));
  const selected = related.map(({ artifact }) => artifact);
  const deduplicated = deduplicateArtifacts(selected);
  const accepted = [];
  for (const artifact of deduplicated) {
    try {
      if (!artifact.telemetry || ![1, 2].includes(artifact.telemetry.schema_version)) throw readerError("unsupported_telemetry_schema");
      validateTelemetry(artifact.telemetry);
      const binding = artifact.telemetry.opportunity.binding;
      if (artifact.workspace_id !== projectConfig.workspace_id || binding.workspace_id !== artifact.workspace_id
        || artifact.catalog_root !== projectConfig.catalog_root || binding.catalog_root !== projectConfig.catalog_root
        || binding.workspace_root !== projectConfig.workspace_root || artifact.marker_path !== projectConfig.marker_path
        || artifact.default_project_scope !== projectConfig.default_project_scope
        || binding.session_ref !== resolved.session_ref || binding.task_id !== (artifact.task_id ?? null)) {
        throw readerError("invocation_binding_conflict");
      }
      const current = inspect({ session_ref: binding.session_ref, thread_ref: binding.thread_ref,
        run_ref: binding.run_ref, task_workspace_relation: binding.task_workspace_relation });
      if (current.status !== "verified") throw readerError(current.reason);
      const capturedSession = artifact.telemetry.opportunity.attribution?.session;
      if (capturedSession && ["ref", "id", "project_id", "thread_ref"].some((key) =>
        capturedSession[key] !== current.session[key])) throw readerError("opportunity_session_identity_changed");
      const attempt = artifact.telemetry.attempt;
      if (attempt && ["episode_id", "session_ref", "thread_ref"].some((key) =>
        (attempt.context[key] ?? null) !== (binding[key] ?? null))) throw readerError("attempt_binding_conflict");
      if (attempt && attempt.invocation_id !== artifact.invocation_id) throw readerError("attempt_invocation_conflict");
      if (attempt?.context.run_ref != null) {
        if (binding.run_ref != null && attempt.context.run_ref !== binding.run_ref) throw readerError("attempt_binding_conflict");
        const attemptAttribution = inspect({ ...attempt.context, task_workspace_relation: binding.task_workspace_relation });
        if (attemptAttribution.status !== "verified") throw readerError(attemptAttribution.reason);
      }
      accepted.push(artifact);
    } catch (error) { issues.push({ invocation_id: artifact.invocation_id, reason: error.code ?? "invalid_invocation_telemetry" }); }
  }
  const summary = summarizeTelemetryArtifacts(accepted);
  const conflictingDeliveries = deduplicated.delivery_conflicts ?? [];
  if (conflictingDeliveries.length || summary.conflicting_attempt_ids.length) issues.push({ reason: "conflicting_invocation_evidence" });
  collection.verifyUnchanged();
  const finalAttribution = inspect(resolved);
  if (finalAttribution.status !== "verified" || sourceHashes(finalAttribution) !== sourceHashes(attribution)) {
    issues.push({ reason: "episode_source_changed_during_report" });
  }
  const allIssues = [...collection.issues, ...issues];
  const thread = attribution.session.thread_ref;
  return {
    report_mode: "session_followthrough",
    checked_at: now.toISOString(),
    workspace_id: projectConfig.workspace_id,
    artifact_root: path.resolve(artifactRoot),
    scope: "exact_session_binding_in_this_artifact_root_only; other_retrieval_workspaces_not_enumerated",
    session: { ...attribution.session, status, stored_run_ref: storedRun },
    native_task_identity: { status: THREAD_REF.test(thread ?? "") ? "canonical_reference" : "unavailable",
      reason: THREAD_REF.test(thread ?? "") ? null : thread == null ? "thread_reference_not_supplied" : "legacy_thread_reference_unverified" },
    episode_attribution: { status: attribution.status, task_project_id: attribution.task_project_id,
      retrieval_workspace_id: attribution.retrieval_workspace_id, workspace_relation: attribution.workspace_relation },
    run_linkage: { status: attribution.run ? "reciprocal" : status === "active" ? "not_recorded_before_closeout" : "unavailable",
      run: attribution.run, execution_outcome: attribution.lifecycle.execution_outcome,
      outcome_basis: "stored_declaration_only; task_quality_and_business_outcome_not_verified" },
    coverage: { enumeration_complete: collection.issues.length === 0, evidence_issues: allIssues,
      files_examined: collection.files_examined, bytes_read: collection.bytes_read,
      artifacts_without_session_binding: rows.filter(({ artifact }) => !artifact.telemetry?.opportunity?.binding?.session_ref).length },
    retrieval_decision: { status: accepted.length ? "observed" : "unobserved", by_decision: summary.opportunities_by_decision },
    recorded_invocations: summary.recorded_invocations,
    consultations: summary.consultations,
    usage_callbacks: summary.usage_callbacks,
    reported_no_influence_callbacks: summary.reported_no_influence_callbacks,
    explicit_empty_callbacks: summary.explicit_empty_callbacks,
    missing_callback_invocations: summary.usage_followthrough.missing_callback_invocations,
    missing_use_reference_invocations: summary.usage_followthrough.missing_use_reference_invocations,
    running_attempts: accepted.filter((artifact) => artifact.telemetry.attempt?.status === "running")
      .map((artifact) => ({ invocation_id: artifact.invocation_id, attempt_id: artifact.telemetry.attempt.attempt_id })),
    conflicting_deliveries: conflictingDeliveries,
    conflicting_attempt_ids: summary.conflicting_attempt_ids,
    limits: ["No artifacts is unobserved, not an explicit skip.",
      "Missing callbacks are never filled automatically; a sibling callback cannot cover another search.",
      "Enumeration or evidence issues prevent a complete-coverage claim even when the missing-callback list is empty.",
      "Unbound artifacts and other workspace roots cannot be assigned to this episode by inference.",
      "This report is read-only and is not a gate on agent-ops session closure or proof of memory benefit."],
  };
}

module.exports = { summarizeSessionMemoryInvocations };
