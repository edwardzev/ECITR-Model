const {
  CONFIDENCE_LABELS,
  NODE_TYPES,
  SNAPSHOT_SCHEMA_VERSION,
  createBuildId,
  createEdgeId,
  createFingerprint,
  createSourceArtifactRecordId,
  dedupeSourceSpans,
  dedupeSupportRefs,
  isCanonicalNodeType,
  mergeProjectScopes,
  toNodeId,
} = require("./types");
const { createSupportGraphBasisHash } = require("./basis");
const {
  buildEvidenceCorrectionIndex,
  resolveLatestEvidenceCorrection,
} = require("../evidence/corrections");
const { mergeWorkspaceIds } = require("../workspace/identity");

function buildSupportGraphSnapshot({
  catalogs,
  builtAt = new Date().toISOString(),
} = {}) {
  assertCatalogs(catalogs);
  const context = createContext(catalogs);
  const nodes = buildNodes(context);
  const nodeIds = new Set(nodes.map((node) => node.node_id));
  const { edges, skippedMissingTargets } = buildEdges(context, nodeIds);
  const fingerprint = createFingerprint({ nodes, edges });
  const basisHash = createSupportGraphBasisHash(catalogs);
  const buildId = createBuildId({ builtAt, fingerprint });

  return {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    build_id: buildId,
    built_at: builtAt,
    catalog_root: catalogs.__catalogRoot ?? null,
    fingerprint,
    basis_hash: basisHash,
    node_count: nodes.length,
    edge_count: edges.length,
    skipped_missing_targets: skippedMissingTargets,
    counts_by_node_type: countBy(nodes, "node_type", NODE_TYPES),
    counts_by_edge_kind: countBy(edges, "kind"),
    nodes,
    edges,
  };
}

function createContext(catalogs) {
  const evidenceById = indexRecords(catalogs.evidence ?? [], (record) => record.evidence_id);
  const casesById = indexRecords(catalogs.cases ?? [], (record) => record.case_id);
  const invariantsById = indexRecords(catalogs.invariants ?? [], (record) => record.id);
  const tacticsById = indexRecords(catalogs.tactics ?? [], (record) => record.id);
  const atomicClaimSetsById = indexRecords(catalogs.atomic_claim_sets ?? [], (record) => record.claim_set_id);
  const parameterDefinitionsById = indexRecords(catalogs.parameter_definitions ?? [], (record) => record.definition_id);
  const parameterObservationsById = indexRecords(catalogs.parameter_observations ?? [], (record) => record.observation_id);
  const evidenceCorrectionIndex = buildEvidenceCorrectionIndex(catalogs.evidence ?? []);

  return {
    catalogs,
    evidenceById,
    casesById,
    invariantsById,
    tacticsById,
    atomicClaimSetsById,
    parameterDefinitionsById,
    parameterObservationsById,
    evidenceCorrectionIndex,
  };
}

function buildNodes(context) {
  const nodes = [
    ...buildEvidenceNodes(context),
    ...buildCaseNodes(context),
    ...buildInvariantNodes(context),
    ...buildTacticNodes(context),
    ...buildAtomicClaimSetNodes(context),
    ...buildParameterDefinitionNodes(context),
    ...buildParameterObservationNodes(context),
    ...buildSourceArtifactNodes(context),
  ];

  return nodes.sort((left, right) => left.node_id.localeCompare(right.node_id));
}

function buildEvidenceNodes(context) {
  return (context.catalogs.evidence ?? []).map((record) => ({
    node_id: toNodeId("evidence", record.evidence_id),
    node_type: "evidence",
    record_type: "evidence",
    record_id: record.evidence_id,
    canonical: true,
    workspace_id: record.workspace_id ?? null,
    project_scope: record.project_scope ?? "global",
    status: "immutable",
    review_state: null,
    display_name: record.evidence_id,
    metadata: {
      source_type: record.source_type,
      source_locator: record.source_locator,
      captured_at: record.captured_at,
    },
  }));
}

function buildCaseNodes(context) {
  return (context.catalogs.cases ?? []).map((record) => ({
    node_id: toNodeId("case", record.case_id),
    node_type: "case",
    record_type: "case",
    record_id: record.case_id,
    canonical: true,
    workspace_id: record.workspace_id ?? null,
    project_scope: record.context?.project_scope ?? "global",
    status: record.status ?? "draft",
    review_state: record.review_state ?? null,
    display_name: record.case_id,
    metadata: {
      derived_at: record.derived_at ?? null,
      derivation_rule_id: record.derivation_rule_id ?? null,
    },
  }));
}

function buildInvariantNodes(context) {
  return (context.catalogs.invariants ?? []).map((record) => ({
    node_id: toNodeId("invariant", record.id),
    node_type: "invariant",
    record_type: "invariant",
    record_id: record.id,
    canonical: true,
    workspace_id: record.workspace_id ?? null,
    project_scope: "global",
    status: record.status ?? "draft",
    review_state: null,
    display_name: record.title,
    metadata: {
      series_key: record.series_key,
      version: record.version,
    },
  }));
}

function buildTacticNodes(context) {
  return (context.catalogs.tactics ?? []).map((record) => ({
    node_id: toNodeId("tactic", record.id),
    node_type: "tactic",
    record_type: "tactic",
    record_id: record.id,
    canonical: true,
    workspace_id: record.workspace_id ?? null,
    project_scope: "global",
    status: record.status ?? "draft",
    review_state: null,
    display_name: record.title,
    metadata: {
      series_key: record.series_key,
      version: record.version,
    },
  }));
}

function buildAtomicClaimSetNodes(context) {
  return (context.catalogs.atomic_claim_sets ?? []).map((record) => ({
    node_id: toNodeId("atomic_claim_set", record.claim_set_id),
    node_type: "atomic_claim_set",
    record_type: "atomic_claim_set",
    record_id: record.claim_set_id,
    canonical: false,
    workspace_id: context.evidenceById.get(record.evidence_id)?.workspace_id ?? null,
    project_scope: context.evidenceById.get(record.evidence_id)?.project_scope ?? "global",
    status: "support",
    review_state: null,
    display_name: record.claim_set_id,
    metadata: {
      evidence_id: record.evidence_id,
      claim_count: Array.isArray(record.claims) ? record.claims.length : 0,
    },
  }));
}

function buildParameterDefinitionNodes(context) {
  return (context.catalogs.parameter_definitions ?? []).map((record) => {
    const currentEvidence = resolveCurrentEvidence(context, record.first_source_evidence_ref);
    return {
      node_id: toNodeId("parameter_definition", record.definition_id),
      node_type: "parameter_definition",
      record_type: "parameter_definition",
      record_id: record.definition_id,
      canonical: false,
      workspace_id: currentEvidence?.workspace_id ?? null,
      project_scope: currentEvidence?.project_scope ?? "global",
      status: "support",
      review_state: null,
      display_name: record.observed_key,
      metadata: {
        observed_key: record.observed_key,
        normalized_key: record.normalized_key,
        value_type: record.value_type,
      },
    };
  });
}

function buildParameterObservationNodes(context) {
  return (context.catalogs.parameter_observations ?? []).map((record) => ({
    node_id: toNodeId("parameter_observation", record.observation_id),
    node_type: "parameter_observation",
    record_type: "parameter_observation",
    record_id: record.observation_id,
    canonical: false,
    workspace_id: record.workspace_id ?? null,
    project_scope: record.project_scope ?? "global",
    status: "support",
    review_state: null,
    display_name: record.parameter_key,
    metadata: {
      parameter_key: record.parameter_key,
      observation_kind: record.observation_kind,
      observed_at: record.observed_at,
    },
  }));
}

function buildSourceArtifactNodes(context) {
  const artifacts = new Map();

  for (const evidenceRecord of context.catalogs.evidence ?? []) {
    const locator = String(evidenceRecord.source_locator ?? "").trim();
    if (!locator) {
      continue;
    }

    const workspaceId = evidenceRecord.workspace_id ?? null;
    const recordId = createSourceArtifactRecordId(locator, workspaceId);
    const existing = artifacts.get(recordId);
    const projectScope = evidenceRecord.project_scope ?? "global";
    if (!existing) {
      artifacts.set(recordId, {
        node_id: toNodeId("source_artifact", recordId),
        node_type: "source_artifact",
        record_type: "source_artifact",
        record_id: recordId,
        canonical: false,
        workspace_id: workspaceId,
        project_scope: projectScope,
        status: "support",
        review_state: null,
        display_name: locator,
        metadata: {
          source_locator: locator,
        },
      });
      continue;
    }

    existing.project_scope = mergeProjectScopes(existing.project_scope, projectScope);
    existing.workspace_id = mergeWorkspaceIds(existing.workspace_id, workspaceId);
  }

  return [...artifacts.values()];
}

function buildEdges(context, nodeIds) {
  const edgeMap = new Map();
  const state = {
    edgeMap,
    skippedMissingTargets: [],
  };

  for (const evidenceRecord of context.catalogs.evidence ?? []) {
    const evidenceNodeId = toNodeId("evidence", evidenceRecord.evidence_id);

    if (evidenceRecord.parent_evidence_id) {
      addEdge(state, {
        from: evidenceNodeId,
        to: toNodeId("evidence", evidenceRecord.parent_evidence_id),
        kind: "evidence_parent",
        confidenceLabel: "DECLARED",
        projectScope: evidenceRecord.project_scope ?? "global",
        supportRefs: [makeSupportRef("evidence", evidenceRecord.evidence_id)],
        originField: "parent_evidence_id",
      }, nodeIds);
    }

    if (evidenceRecord.correction_of) {
      addEdge(state, {
        from: evidenceNodeId,
        to: toNodeId("evidence", evidenceRecord.correction_of),
        kind: "evidence_correction",
        confidenceLabel: "DECLARED",
        projectScope: evidenceRecord.project_scope ?? "global",
        supportRefs: [makeSupportRef("evidence", evidenceRecord.evidence_id)],
        originField: "correction_of",
      }, nodeIds);
    }

    if (evidenceRecord.source_locator) {
      addEdge(state, {
        from: evidenceNodeId,
        to: toNodeId(
          "source_artifact",
          createSourceArtifactRecordId(evidenceRecord.source_locator, evidenceRecord.workspace_id ?? null),
        ),
        kind: "evidence_source_artifact",
        confidenceLabel: "DECLARED",
        projectScope: evidenceRecord.project_scope ?? "global",
        supportRefs: [makeSupportRef("evidence", evidenceRecord.evidence_id)],
        originField: "source_locator",
      }, nodeIds);
    }
  }

  for (const claimSet of context.catalogs.atomic_claim_sets ?? []) {
    addEdge(state, {
      from: toNodeId("evidence", claimSet.evidence_id),
      to: toNodeId("atomic_claim_set", claimSet.claim_set_id),
      kind: "evidence_claim_set",
      confidenceLabel: "EXTRACTED",
      projectScope: context.evidenceById.get(claimSet.evidence_id)?.project_scope ?? "global",
      supportRefs: [
        makeSupportRef("evidence", claimSet.evidence_id),
        makeSupportRef("atomic_claim_set", claimSet.claim_set_id),
      ],
    }, nodeIds);
    addCurrentEvidenceEdge(state, {
      context,
      evidenceId: claimSet.evidence_id,
      otherNodeId: toNodeId("atomic_claim_set", claimSet.claim_set_id),
      direction: "from_evidence",
      kind: "current_evidence_claim_set",
      projectScope: context.evidenceById.get(claimSet.evidence_id)?.project_scope ?? "global",
      supportRefs: [
        makeSupportRef("evidence", claimSet.evidence_id),
        makeSupportRef("atomic_claim_set", claimSet.claim_set_id),
      ],
    }, nodeIds);
  }

  for (const observation of context.catalogs.parameter_observations ?? []) {
    for (const evidenceId of observation.source_evidence_refs ?? []) {
      addEdge(state, {
        from: toNodeId("evidence", evidenceId),
        to: toNodeId("parameter_observation", observation.observation_id),
        kind: "evidence_parameter_observation",
        confidenceLabel: "EXTRACTED",
        projectScope: mergeProjectScopes(
          context.evidenceById.get(evidenceId)?.project_scope ?? "global",
          observation.project_scope ?? "global",
        ),
        supportRefs: [
          makeSupportRef("evidence", evidenceId),
          makeSupportRef("parameter_observation", observation.observation_id),
        ],
        sourceSpans: observation.source_spans ?? [],
      }, nodeIds);
      addCurrentEvidenceEdge(state, {
        context,
        evidenceId,
        otherNodeId: toNodeId("parameter_observation", observation.observation_id),
        direction: "from_evidence",
        kind: "current_evidence_parameter_observation",
        projectScope: observation.project_scope ?? "global",
        supportRefs: [
          makeSupportRef("evidence", evidenceId),
          makeSupportRef("parameter_observation", observation.observation_id),
        ],
        sourceSpans: observation.source_spans ?? [],
      }, nodeIds);
    }

    addEdge(state, {
      from: toNodeId("parameter_observation", observation.observation_id),
      to: toNodeId("parameter_definition", observation.definition_id),
      kind: "parameter_observation_definition",
      confidenceLabel: "EXTRACTED",
      projectScope: observation.project_scope ?? "global",
      supportRefs: [makeSupportRef("parameter_observation", observation.observation_id)],
      sourceSpans: observation.source_spans ?? [],
    }, nodeIds);
  }

  for (const caseRecord of context.catalogs.cases ?? []) {
    const caseNodeId = toNodeId("case", caseRecord.case_id);
    const projectScope = caseRecord.context?.project_scope ?? "global";

    for (const evidenceId of caseRecord.evidence_refs ?? []) {
      addEdge(state, {
        from: caseNodeId,
        to: toNodeId("evidence", evidenceId),
        kind: "case_evidence",
        confidenceLabel: "DECLARED",
        projectScope: mergeProjectScopes(projectScope, context.evidenceById.get(evidenceId)?.project_scope ?? "global"),
        supportRefs: [makeSupportRef("case", caseRecord.case_id)],
        originField: "evidence_refs",
      }, nodeIds);
      addCurrentEvidenceEdge(state, {
        context,
        evidenceId,
        otherNodeId: caseNodeId,
        direction: "to_evidence",
        kind: "case_current_evidence",
        projectScope,
        supportRefs: [makeSupportRef("case", caseRecord.case_id)],
      }, nodeIds);
    }

    for (const observationId of caseRecord.parameter_observation_refs ?? []) {
      addEdge(state, {
        from: caseNodeId,
        to: toNodeId("parameter_observation", observationId),
        kind: "case_parameter_observation",
        confidenceLabel: "DECLARED",
        projectScope,
        supportRefs: [makeSupportRef("case", caseRecord.case_id)],
        originField: "parameter_observation_refs",
      }, nodeIds);
    }

    if (caseRecord.derived_from_case_id) {
      addEdge(state, {
        from: caseNodeId,
        to: toNodeId("case", caseRecord.derived_from_case_id),
        kind: "case_derived_from_case",
        confidenceLabel: "DECLARED",
        projectScope,
        supportRefs: [makeSupportRef("case", caseRecord.case_id)],
        originField: "derived_from_case_id",
      }, nodeIds);
    }

    if (caseRecord.supersedes_case_id) {
      addEdge(state, {
        from: caseNodeId,
        to: toNodeId("case", caseRecord.supersedes_case_id),
        kind: "case_supersedes_case",
        confidenceLabel: "DECLARED",
        projectScope,
        supportRefs: [makeSupportRef("case", caseRecord.case_id)],
        originField: "supersedes_case_id",
      }, nodeIds);
    }
  }

  for (const invariant of context.catalogs.invariants ?? []) {
    const invariantNodeId = toNodeId("invariant", invariant.id);

    for (const caseId of invariant.source_case_refs ?? []) {
      addEdge(state, {
        from: invariantNodeId,
        to: toNodeId("case", caseId),
        kind: "invariant_source_case",
        confidenceLabel: "DECLARED",
        projectScope: mergeProjectScopes("global", context.casesById.get(caseId)?.context?.project_scope ?? "global"),
        supportRefs: [makeSupportRef("invariant", invariant.id)],
        originField: "source_case_refs",
      }, nodeIds);
    }

    for (const evidenceId of invariant.evidence_refs ?? []) {
      addEdge(state, {
        from: invariantNodeId,
        to: toNodeId("evidence", evidenceId),
        kind: "invariant_evidence",
        confidenceLabel: "DECLARED",
        projectScope: mergeProjectScopes("global", context.evidenceById.get(evidenceId)?.project_scope ?? "global"),
        supportRefs: [makeSupportRef("invariant", invariant.id)],
        originField: "evidence_refs",
      }, nodeIds);
      addCurrentEvidenceEdge(state, {
        context,
        evidenceId,
        otherNodeId: invariantNodeId,
        direction: "to_evidence",
        kind: "invariant_current_evidence",
        projectScope: "global",
        supportRefs: [makeSupportRef("invariant", invariant.id)],
      }, nodeIds);
    }

    if (invariant.supersedes) {
      addEdge(state, {
        from: invariantNodeId,
        to: toNodeId("invariant", invariant.supersedes),
        kind: "invariant_supersedes",
        confidenceLabel: "DECLARED",
        projectScope: "global",
        supportRefs: [makeSupportRef("invariant", invariant.id)],
        originField: "supersedes",
      }, nodeIds);
    }
  }

  for (const tactic of context.catalogs.tactics ?? []) {
    const tacticNodeId = toNodeId("tactic", tactic.id);

    for (const caseId of tactic.source_case_refs ?? []) {
      addEdge(state, {
        from: tacticNodeId,
        to: toNodeId("case", caseId),
        kind: "tactic_source_case",
        confidenceLabel: "DECLARED",
        projectScope: mergeProjectScopes("global", context.casesById.get(caseId)?.context?.project_scope ?? "global"),
        supportRefs: [makeSupportRef("tactic", tactic.id)],
        originField: "source_case_refs",
      }, nodeIds);
    }

    for (const invariantId of tactic.supporting_invariant_refs ?? []) {
      addEdge(state, {
        from: tacticNodeId,
        to: toNodeId("invariant", invariantId),
        kind: "tactic_supporting_invariant",
        confidenceLabel: "DECLARED",
        projectScope: "global",
        supportRefs: [makeSupportRef("tactic", tactic.id)],
        originField: "supporting_invariant_refs",
      }, nodeIds);
    }

    for (const evidenceId of tactic.evidence_refs ?? []) {
      addEdge(state, {
        from: tacticNodeId,
        to: toNodeId("evidence", evidenceId),
        kind: "tactic_evidence",
        confidenceLabel: "DECLARED",
        projectScope: mergeProjectScopes("global", context.evidenceById.get(evidenceId)?.project_scope ?? "global"),
        supportRefs: [makeSupportRef("tactic", tactic.id)],
        originField: "evidence_refs",
      }, nodeIds);
      addCurrentEvidenceEdge(state, {
        context,
        evidenceId,
        otherNodeId: tacticNodeId,
        direction: "to_evidence",
        kind: "tactic_current_evidence",
        projectScope: "global",
        supportRefs: [makeSupportRef("tactic", tactic.id)],
      }, nodeIds);
    }

    for (const observationId of tactic.parameter_observation_refs ?? []) {
      addEdge(state, {
        from: tacticNodeId,
        to: toNodeId("parameter_observation", observationId),
        kind: "tactic_parameter_observation",
        confidenceLabel: "DECLARED",
        projectScope: "global",
        supportRefs: [makeSupportRef("tactic", tactic.id)],
        originField: "parameter_observation_refs",
      }, nodeIds);
    }

    if (tactic.supersedes) {
      addEdge(state, {
        from: tacticNodeId,
        to: toNodeId("tactic", tactic.supersedes),
        kind: "tactic_supersedes",
        confidenceLabel: "DECLARED",
        projectScope: "global",
        supportRefs: [makeSupportRef("tactic", tactic.id)],
        originField: "supersedes",
      }, nodeIds);
    }
  }

  return {
    edges: [...edgeMap.values()].sort((left, right) => left.edge_id.localeCompare(right.edge_id)),
    skippedMissingTargets: state.skippedMissingTargets.sort((left, right) =>
      left.kind.localeCompare(right.kind)
      || left.from.localeCompare(right.from)
      || left.to.localeCompare(right.to)),
  };
}

function addCurrentEvidenceEdge(state, {
  context,
  evidenceId,
  otherNodeId,
  direction,
  kind,
  projectScope,
  supportRefs,
  sourceSpans = [],
}, nodeIds) {
  const currentEvidence = resolveCurrentEvidence(context, evidenceId);
  if (!currentEvidence || currentEvidence.evidence_id === evidenceId) {
    return;
  }

  const currentEvidenceNodeId = toNodeId("evidence", currentEvidence.evidence_id);
  addEdge(state, {
    from: direction === "from_evidence" ? currentEvidenceNodeId : otherNodeId,
    to: direction === "from_evidence" ? otherNodeId : currentEvidenceNodeId,
    kind,
    confidenceLabel: "EXTRACTED",
    projectScope: mergeProjectScopes(
      projectScope ?? "global",
      currentEvidence.project_scope ?? "global",
    ),
    supportRefs: [
      ...(supportRefs ?? []),
      makeSupportRef("evidence", currentEvidence.evidence_id),
    ],
    sourceSpans,
    originField: "resolved_evidence_correction",
  }, nodeIds);
}

function resolveCurrentEvidence(context, evidenceId) {
  if (!evidenceId) {
    return null;
  }

  return resolveLatestEvidenceCorrection(
    context.evidenceCorrectionIndex,
    evidenceId,
  ) ?? context.evidenceById.get(evidenceId) ?? null;
}

function addEdge(state, edge, nodeIds) {
  if (!CONFIDENCE_LABELS.includes(edge.confidenceLabel)) {
    throw new Error(`Unsupported support-graph confidence label: ${edge.confidenceLabel}`);
  }

  if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
    state.skippedMissingTargets.push({
      kind: edge.kind,
      from: edge.from,
      to: edge.to,
    });
    return;
  }

  const edgeId = createEdgeId(edge);
  const nextEdge = {
    edge_id: edgeId,
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    confidence_label: edge.confidenceLabel,
    project_scope: edge.projectScope ?? "global",
    support_refs: dedupeSupportRefs(edge.supportRefs ?? []),
    source_spans: dedupeSourceSpans(edge.sourceSpans ?? []),
  };

  if (edge.originField) {
    nextEdge.origin_field = edge.originField;
  }

  const existing = state.edgeMap.get(edgeId);
  if (!existing) {
    state.edgeMap.set(edgeId, nextEdge);
    return;
  }

  existing.project_scope = mergeProjectScopes(existing.project_scope, nextEdge.project_scope);
  existing.support_refs = dedupeSupportRefs([...(existing.support_refs ?? []), ...(nextEdge.support_refs ?? [])]);
  existing.source_spans = dedupeSourceSpans([...(existing.source_spans ?? []), ...(nextEdge.source_spans ?? [])]);
}

function makeSupportRef(recordType, recordId) {
  return {
    record_type: recordType,
    record_id: recordId,
  };
}

function indexRecords(records, getId) {
  return new Map((records ?? []).map((record) => [getId(record), record]));
}

function countBy(entries, key, seedValues = []) {
  const counts = Object.fromEntries((seedValues ?? []).map((value) => [value, 0]));
  for (const entry of entries) {
    counts[entry[key]] = (counts[entry[key]] ?? 0) + 1;
  }
  return counts;
}

function assertCatalogs(catalogs) {
  if (!catalogs || typeof catalogs !== "object") {
    throw new Error("buildSupportGraphSnapshot requires runtime catalogs.");
  }

  return catalogs;
}

module.exports = {
  buildSupportGraphSnapshot,
  isCanonicalNodeType,
};
