const { structuralHash, readerError } = require("./project-memory-reader");
const { unavailable, validateTelemetry } = require("./project-memory-telemetry");

const TRIGGERS = ["discretionary", "preflight", "failure_retry", "explicit_request"];
const unique = (values) => [...new Set(values)].sort();
const ratio = (numerator, denominator) => denominator ? numerator / denominator : null;

function deliveryKey(artifact) {
  return JSON.stringify([artifact.workspace_id ?? null, artifact.invocation_id ?? structuralHash(artifact)]);
}

function deduplicateArtifacts(artifacts) {
  const groups = new Map();
  for (const artifact of artifacts) {
    const key = deliveryKey(artifact);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(artifact);
  }
  const conflicts = [];
  const accepted = [];
  for (const group of groups.values()) {
    const reasons = new Set();
    for (let i = 0; i < group.length; i += 1) for (let j = i + 1; j < group.length; j += 1) {
      for (const reason of deliveryConflicts(group[i], group[j])) reasons.add(reason);
    }
    if (reasons.size) conflicts.push({ workspace_id: group[0].workspace_id ?? null,
      invocation_id: group[0].invocation_id ?? null, reasons: [...reasons].sort(), deliveries: group.length });
    else accepted.push(group.reduce((current, entry) => deliveryRank(entry) > deliveryRank(current) ? entry : current));
  }
  accepted.sort((left, right) => String(left.consulted_at).localeCompare(String(right.consulted_at))
    || deliveryKey(left).localeCompare(deliveryKey(right)));
  Object.defineProperty(accepted, "delivery_conflicts", { value: conflicts });
  return accepted;
}

function deliveryConflicts(left, right) {
  const reasons = [];
  const same = (a, b) => structuralHash(a ?? null) === structuralHash(b ?? null);
  const immutable = (entry) => [entry.invocation_id, entry.workspace_id, entry.catalog_root, entry.marker_path,
    entry.consulted_at, entry.task_id, entry.telemetry?.schema_version, entry.telemetry?.opportunity?.opportunity_id,
    entry.telemetry?.opportunity?.binding, entry.telemetry?.opportunity?.attribution,
    entry.telemetry?.opportunity?.identity_basis, entry.telemetry?.opportunity?.capture_boundary];
  if (!same(immutable(left), immutable(right))) reasons.push("immutable_identity_conflict");
  const l = left.telemetry?.attempt;
  const r = right.telemetry?.attempt;
  const terminal = (attempt) => attempt && attempt.status !== "running";
  if (l && r && !same([l.attempt_id, l.invocation_id, l.started_at, l.context, l.trigger, l.retry_of],
    [r.attempt_id, r.invocation_id, r.started_at, r.context, r.trigger, r.retry_of])) reasons.push("attempt_identity_conflict");
  if (terminal(l) && terminal(r) && !same(l, r)) reasons.push("terminal_attempt_conflict");
  const ld = left.telemetry?.opportunity?.decision;
  const rd = right.telemetry?.opportunity?.decision;
  if (ld && rd && ld !== "pending" && rd !== "pending" && ld !== rd) reasons.push("opportunity_decision_conflict");
  if (left.request && right.request && !same(left.request, right.request)) reasons.push("request_identity_conflict");
  if (terminal(l) && terminal(r) && !same([left.returned_record_ids, left.retrieval_basis], [right.returned_record_ids, right.retrieval_basis])) reasons.push("retrieval_result_conflict");
  const usage = (entry) => [entry.usage_recorded_at, entry.used_memory, entry.used_record_ids, entry.selected_record_ids, entry.used_returned_record_ids, entry.use_evidence];
  if (left.usage_recorded_at && right.usage_recorded_at && !same(usage(left), usage(right))) reasons.push("usage_callback_conflict");
  const receipts = (entry) => new Map((entry.read_receipts ?? []).map((receipt) => [receipt.receipt_id, structuralHash(receipt)]));
  const lr = receipts(left); const rr = receipts(right);
  for (const [id, hash] of lr) if (rr.has(id) && rr.get(id) !== hash) reasons.push("read_receipt_conflict");
  const subset = (a, b) => [...a.keys()].every((key) => b.has(key));
  if (!subset(lr, rr) && !subset(rr, lr)) reasons.push("read_receipt_fork");
  if (!isProgression(left, right) && !isProgression(right, left)) reasons.push("incomparable_snapshot_progression");
  return unique(reasons);
}

function isProgression(before, after) {
  if (before.usage_recorded_at && !after.usage_recorded_at) return false;
  const afterReceipts = new Set((after.read_receipts ?? []).map((receipt) => receipt.receipt_id));
  if ((before.read_receipts ?? []).some((receipt) => !afterReceipts.has(receipt.receipt_id))) return false;
  const b = before.telemetry; const a = after.telemetry;
  if (b?.attempt && !a?.attempt) return false;
  if (b?.attempt?.status !== "running" && b?.attempt && a?.attempt?.status === "running") return false;
  if (b?.opportunity?.decision !== "pending" && b?.opportunity && a?.opportunity?.decision === "pending") return false;
  if (b?.opportunity?.gate_observation && !a?.opportunity?.gate_observation) return false;
  return true;
}

function deliveryRank(artifact) {
  // Rank only after immutable/terminal/callback conflicts have been excluded.
  // A timestamp by itself cannot override a contradictory fact.
  return `${artifact.usage_recorded_at ? 1 : 0}:${String(artifact.read_receipts?.length ?? 0).padStart(3, "0")}:${artifact.telemetry?.attempt?.status && artifact.telemetry.attempt.status !== "running" ? 1 : 0}:${artifact.telemetry?.attempt ? 1 : 0}:${artifact.telemetry?.opportunity?.decision !== "pending" ? 1 : 0}:${artifact.telemetry?.opportunity?.gate_observation ? 1 : 0}`;
}

function summarizeTelemetryArtifacts(input, { eligiblePopulation = null } = {}) {
  const artifacts = deduplicateArtifacts(input);
  const legacy = artifacts.filter((artifact) => !artifact.telemetry);
  const unsupported = artifacts.filter((artifact) => artifact.telemetry && ![1, 2].includes(artifact.telemetry.schema_version));
  const malformed = [];
  const supported = artifacts.filter((artifact) => {
    if (![1, 2].includes(artifact.telemetry?.schema_version)) return false;
    try { validateTelemetry(artifact.telemetry); return true; }
    catch { malformed.push(artifact); return false; }
  });
  const opportunityGroups = new Map();
  const attemptsById = new Map();
  const attemptConflicts = new Set();
  for (const artifact of supported) {
    const opportunity = artifact.telemetry.opportunity;
    if (!opportunity?.opportunity_id) continue;
    const key = JSON.stringify([artifact.workspace_id, artifact.catalog_root, opportunity.opportunity_id]);
    if (!opportunityGroups.has(key)) opportunityGroups.set(key, []);
    opportunityGroups.get(key).push(artifact);
    const attempt = artifact.telemetry.attempt;
    if (attempt?.attempt_id) {
      const attemptKey = JSON.stringify([key, attempt.attempt_id]);
      if (attemptsById.has(attemptKey)) attemptConflicts.add(attemptKey);
      else attemptsById.set(attemptKey, { ...attempt, artifact });
    }
  }
  const opportunities = [...opportunityGroups.values()].map((group) => {
    const decisions = unique(group.map((entry) => entry.telemetry.opportunity.decision).filter((value) => value !== "pending"));
    const anchor = group.find((entry) => entry.invocation_id?.startsWith("meminv_opportunity_")) ?? group[0];
    const boundaries = unique(group.map((entry) => entry.telemetry.opportunity.capture_boundary));
    const identities = unique(group.map((entry) => structuralHash({ binding: entry.telemetry.opportunity.binding,
      attribution: entry.telemetry.opportunity.attribution ?? null })));
    return { ...anchor.telemetry.opportunity, attribution_conflict: identities.length > 1,
      decision: decisions.length > 1 ? "conflict" : decisions[0] ?? "pending",
      capture_boundary: boundaries.length > 1 ? "conflict" : boundaries[0] };
  });
  const attempts = [...attemptsById.entries()].filter(([key]) => !attemptConflicts.has(key)).map(([, attempt]) => attempt);
  const ambiguousAttemptInvocations = new Set([...attemptConflicts].flatMap((key) => {
    const [opportunityKey, attemptId] = JSON.parse(key);
    const [workspaceId, catalogRoot, opportunityId] = JSON.parse(opportunityKey);
    return supported.filter((entry) => entry.workspace_id === workspaceId && entry.catalog_root === catalogRoot
      && entry.telemetry.opportunity.opportunity_id === opportunityId && entry.telemetry.attempt?.attempt_id === attemptId).map(deliveryKey);
  }));
  const invalid = new Set([...malformed, ...unsupported].map(deliveryKey));
  const metricArtifacts = artifacts.filter((entry) => !invalid.has(deliveryKey(entry)) && !ambiguousAttemptInvocations.has(deliveryKey(entry)));
  const consulted = metricArtifacts.filter((artifact) => artifact.memory_consulted === true);
  const callbacks = consulted.filter((artifact) => typeof artifact.usage_recorded_at === "string");
  const used = callbacks.filter((artifact) => artifact.used_memory === true);
  const usedIds = unique(used.flatMap((artifact) => artifact.used_returned_record_ids ?? artifact.used_record_ids ?? []));
  const returned = Object.fromEntries(["tactics", "invariants", "cases", "evidence"].map((layer) => [layer,
    consulted.reduce((sum, artifact) => sum + Number(artifact.returned_counts?.[layer] ?? 0), 0)]));
  const states = ["running", "succeeded", "failed", "cancelled"];
  const durations = attempts.map((attempt) => attempt.duration_ms).filter((value) => Number.isFinite(value) && value >= 0);
  const legacyConsulted = legacy.filter((artifact) => artifact.memory_consulted === true);
  const attemptRefs = new Set(attempts.flatMap((attempt) => [attempt.attempt_id, attempt.invocation_id]));
  const gateObserved = opportunities.filter((opportunity) => opportunity.gate_observation?.evaluation);
  const beforeExecutorDecision = gateObserved.filter((opportunity) => opportunity.capture_boundary === "before_decision");
  const callerSelected = gateObserved.filter((opportunity) => opportunity.capture_boundary === "caller_selected_before_dispatch");
  const population = summarizePopulation(opportunities, eligiblePopulation);
  const preparedIds = unique(callbacks.concat(consulted.filter((artifact) => !artifact.usage_recorded_at))
    .flatMap((artifact) => (artifact.read_receipts ?? []).flatMap((receipt) =>
      (receipt.results ?? []).filter((entry) => entry.result === "available").map((entry) => entry.record_id))));
  const attributionState = (entry) => entry.attribution_conflict ? "conflict" : entry.attribution?.status ?? "legacy_unverified";
  const missingUseReferences = used.map((artifact) => {
    const linked = new Set((artifact.use_evidence?.links ?? []).filter((entry) => entry.decision_ref || entry.output_ref).map((entry) => entry.record_id));
    return { artifact, missing: (artifact.used_returned_record_ids ?? artifact.used_record_ids ?? []).filter((id) => !linked.has(id)) };
  });
  return {
    report_schema_version: 3,
    recorded_invocations: artifacts.length,
    duplicate_deliveries: input.length - artifacts.length - (artifacts.delivery_conflicts ?? []).reduce((sum, entry) => sum + entry.deliveries, 0),
    conflicting_deliveries: artifacts.delivery_conflicts ?? [],
    conflicting_attempt_ids: [...attemptConflicts].map((entry) => JSON.parse(entry)[1]),
    task_opportunities: opportunities.length,
    declared_lifecycle_task_opportunities: opportunities.filter((entry) => entry.identity_basis !== "unjoined_boundary").length,
    joined_task_opportunities: opportunities.filter((entry) => attributionState(entry) === "verified").length,
    unjoined_task_opportunities: opportunities.filter((entry) => attributionState(entry) !== "verified").length,
    episode_attribution: {
      scope: "source_metadata_and_declared_workspace_relation; outcome_and_business_intent_not_verified",
      by_status: Object.fromEntries(["verified", "absent", "unresolved", "invalid", "legacy_unverified", "conflict"].map((state) =>
        [state, opportunities.filter((entry) => attributionState(entry) === state).length])),
      verified_cross_workspace: opportunities.filter((entry) => attributionState(entry) === "verified"
        && entry.attribution.workspace_relation === "cross_workspace").length,
    },
    opportunities_by_decision: Object.fromEntries(["pending", "consult", "skip", "blocked", "conflict"].map((decision) =>
      [decision, opportunities.filter((entry) => entry.decision === decision).length])),
    consultation_rate: ratio(opportunities.filter((entry) => entry.decision === "consult").length, opportunities.length),
    consultations: consulted.length,
    consultations_by_trigger: Object.fromEntries(TRIGGERS.map((trigger) => [trigger,
      consulted.filter((entry) => entry.consult_trigger === trigger).length])),
    consultations_with_results: consulted.filter((artifact) => Object.values(artifact.returned_counts ?? {}).some((count) => Number(count) > 0)).length,
    returned_records_by_layer: returned,
    retrieval_attempts: attempts.length,
    attempts_by_status: Object.fromEntries(states.map((status) => [status, attempts.filter((entry) => entry.status === status).length])),
    missing_terminal_events: attempts.filter((entry) => entry.status === "running").length,
    declared_retries: attempts.filter((entry) => entry.retry_of !== null).length,
    orphaned_retry_refs_in_loaded_population: unique(attempts.filter((entry) => entry.retry_of && !attemptRefs.has(entry.retry_of)).map((entry) => entry.retry_of)),
    shadow_gate: {
      observed_opportunities: gateObserved.length,
      pre_decision_observations: beforeExecutorDecision.length,
      pre_decision_scope: "instrumented_executor_choice_only",
      caller_selected_before_dispatch_observations: callerSelected.length,
      missing_pre_decision_observations: opportunities.length - beforeExecutorDecision.length,
      missing_gate_observations: opportunities.length - gateObserved.length,
      external_agent_choice_coverage: unavailable("native_agent_decision_boundary_not_observed"),
      proposed_skips: gateObserved.filter((entry) => entry.gate_observation.evaluation.proposed_decision === "skip").length,
      mandatory_overrides: gateObserved.filter((entry) => entry.gate_observation.evaluation.mandatory_override === true).length,
      enforcement: "disabled",
    },
    usage_callbacks: callbacks.length,
    usage_callback_rate: ratio(callbacks.length, consulted.length),
    missing_callbacks: consulted.length - callbacks.length,
    explicit_empty_callbacks: callbacks.filter((entry) => (entry.used_record_ids ?? []).length === 0
      && (entry.selected_record_ids ?? []).length === 0 && (entry.use_evidence?.inspected_record_ids ?? []).length === 0).length,
    reported_no_influence_callbacks: callbacks.filter((entry) => entry.used_memory === false).length,
    used_memory: used.length,
    used_memory_rate: ratio(used.length, consulted.length),
    used_record_ids: usedIds,
    selected_record_ids: unique(callbacks.flatMap((entry) => entry.selected_record_ids ?? [])),
    use_stages: {
      prepared_record_ids: preparedIds,
      reported_inspected_record_ids: unique(callbacks.flatMap((entry) => entry.use_evidence?.inspected_record_ids ?? [])),
      reported_used_record_ids: usedIds,
      evidence_link_declarations: callbacks.reduce((sum, entry) => sum + (entry.use_evidence?.links?.length ?? 0), 0),
      reported_use_callbacks_without_complete_references: missingUseReferences.filter((entry) => entry.missing.length).length,
      reported_used_record_ids_without_references: unique(missingUseReferences.flatMap((entry) => entry.missing)),
      reported_use_reference_coverage: used.length ? {
        callbacks_with_complete_references: missingUseReferences.filter((entry) => !entry.missing.length).length,
        reported_use_callbacks: used.length,
      } : null,
      independently_corroborated_use: unavailable("independent_verifier_not_run"),
      measured_benefit: unavailable("matched_task_outcomes_not_evaluated"),
    },
    timing: {
      observed_attempt_durations: durations.length,
      missing_attempt_durations: attempts.length - durations.length,
      summed_attempt_duration_ms: durations.length ? durations.reduce((sum, value) => sum + value, 0) : null,
      mean_attempt_duration_ms: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
      wall_clock_duration: unavailable("overlapping_attempts_are_not_wall_time"),
      model_usage: unavailable("not_exposed_by_project_memory_runtime"),
      cost: unavailable("not_exposed_by_project_memory_runtime"),
    },
    coverage: {
      ...population,
      legacy_artifacts: legacy.length,
      legacy_task_opportunities: unavailable("legacy_invocations_do_not_identify_episodes"),
      unsupported_telemetry_artifacts: unsupported.length,
      malformed_telemetry_artifacts: malformed.length,
      conflicted_invocations_excluded: artifacts.delivery_conflicts?.length ?? 0,
      post_execution_opportunities: opportunities.filter((entry) => entry.capture_boundary === "post_execution").length,
      caller_selected_before_dispatch_opportunities: opportunities.filter((entry) => entry.capture_boundary === "caller_selected_before_dispatch").length,
      external_agent_choice_coverage: unavailable("native_agent_decision_boundary_not_observed"),
      conflicting_opportunity_capture_boundaries: opportunities.filter((entry) => entry.capture_boundary === "conflict").length,
      gaps: ["Artifacts cannot enumerate tasks that never entered an instrumented boundary.",
        "Direct search/skip calls arrive after caller selection; they do not observe the external agent choice.",
        "Unjoined boundaries cannot be deduplicated into episodes across calls.",
        "Running means no terminal event was recorded; crash or cancellation is unknown.",
        "Usage callbacks and evidence links are declarations; preparation is not attention."],
    },
    legacy_compatibility: {
      task_opportunities: legacy.length,
      consultations: legacyConsulted.length,
      consultation_rate: ratio(legacyConsulted.length, legacy.length),
      meaning: "Historical invocation proxy only; excluded from versioned task denominator.",
    },
  };
}

function summarizePopulation(opportunities, population) {
  if (!population) return { denominator_basis: "recorded_opportunities_only", eligible_population: unavailable("independent_population_not_supplied") };
  if (population.schema_version !== 1 || typeof population.enumeration_ref !== "string" || !population.enumeration_ref
    || !Array.isArray(population.opportunities) || population.opportunities.length > 100000
    || population.sha256 !== structuralHash(population.opportunities)) throw readerError("invalid_eligible_population");
  const key = (entry) => JSON.stringify([entry.workspace_id, entry.catalog_root, entry.opportunity_id]);
  for (const entry of population.opportunities) {
    if (!entry || Object.keys(entry).some((field) => !["workspace_id", "catalog_root", "opportunity_id"].includes(field))
      || ![entry.workspace_id, entry.catalog_root, entry.opportunity_id].every((value) => typeof value === "string" && value.length)
      || !/^memopp_[a-f0-9]{64}$/.test(entry.opportunity_id)) throw readerError("invalid_eligible_population");
  }
  const expected = new Set(population.opportunities.map(key));
  if (expected.size !== population.opportunities.length) throw readerError("duplicate_eligible_population_entry");
  const recorded = new Set(opportunities.filter((entry) => entry.identity_basis !== "unjoined_boundary").map((entry) => key({
    workspace_id: entry.binding.workspace_id, catalog_root: entry.binding.catalog_root, opportunity_id: entry.opportunity_id,
  })));
  return {
    denominator_basis: "explicit_population_manifest",
    eligible_population: { value: expected.size, reason: null },
    enumeration_ref: population.enumeration_ref,
    enumeration_sha256: population.sha256,
    independence: unavailable("manifest_independence_requires_external_review"),
    observed_eligible_opportunities: [...expected].filter((entry) => recorded.has(entry)).length,
    missing_eligible_opportunities: [...expected].filter((entry) => !recorded.has(entry)).map((entry) => JSON.parse(entry)),
    orphaned_recorded_opportunities: [...recorded].filter((entry) => !expected.has(entry)).map((entry) => JSON.parse(entry)),
  };
}

module.exports = { deduplicateArtifacts, summarizeTelemetryArtifacts };
