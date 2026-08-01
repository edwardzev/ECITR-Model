const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const {
  buildEvidenceCorrectionIndex,
  getCurrentEvidenceRecords,
  resolveLatestEvidenceCorrection,
} = require("../evidence/corrections");
const { createDefinitionId, createObservationId } = require("../parameters/common");
const { EcitrValidator } = require("../validation/validator");
const {
  WorkspaceAttributionMigrationManifestStore,
  createMigrationManifest,
  createMigrationOperation,
  hashRecord,
} = require("./attribution-migration-manifest");
const {
  isPathWithinRoots,
  loadWorkspaceSourceMap,
  resolveWorkspaceAttributionForAgentOps,
  resolveWorkspaceAttributionForCodex,
} = require("./source-mapping");

const DEFAULT_CREATED_BY = "workspace-attribution-migrator-v1";
const STAGING_PACKET_DEFINITIONS = Object.freeze([
  {
    recordType: "case_seed",
    directory: path.join("staging", "case-seeds"),
    idKey: "case_seed_id",
  },
  {
    recordType: "case_compilation_packet",
    directory: path.join("staging", "case-compilation-packets"),
    idKey: "compilation_id",
  },
  {
    recordType: "invariant_promotion_packet",
    directory: path.join("staging", "invariant-promotion-packets"),
    idKey: "promotion_id",
  },
  {
    recordType: "tactic_promotion_packet",
    directory: path.join("staging", "tactic-promotion-packets"),
    idKey: "promotion_id",
  },
  {
    recordType: "live_invariant_candidate",
    directory: path.join("staging", "live-invariant-candidates"),
    idKey: "candidate_id",
  },
  {
    recordType: "live_tactic_candidate",
    directory: path.join("staging", "live-tactic-candidates"),
    idKey: "candidate_id",
  },
]);

function migrateWorkspaceIdentityBySource({
  catalogRoot,
  targetWorkspaceId,
  agentOpsProjectIds = [],
  codexWorkspaceRoots = [],
  dryRun = true,
  includeStaging = true,
  validator = new EcitrValidator(),
  sourceMap = loadWorkspaceSourceMap(),
  plannedAt = new Date().toISOString(),
  createdBy = DEFAULT_CREATED_BY,
} = {}) {
  const plan = planWorkspaceIdentityBySource({
    catalogRoot,
    targetWorkspaceId,
    agentOpsProjectIds,
    codexWorkspaceRoots,
    includeStaging,
    validator,
    sourceMap,
    plannedAt,
    createdBy,
  });

  if (dryRun) {
    return summarizeMigrationPlan(plan, { dryRun: true });
  }
  if (plan.manifest.operations.length === 0) {
    return {
      ...summarizeMigrationPlan(plan, { dryRun: false }),
      status: plan.manifest.blockers.length > 0 ? "blocked_no_changes" : "no_changes",
    };
  }

  const applied = applyWorkspaceIdentityMigration({
    catalogRoot: plan.catalogRoot,
    manifest: plan.manifest,
    validator,
    appliedAt: plannedAt,
  });
  return summarizeMigrationPlan({ ...plan, manifest: applied }, { dryRun: false });
}

function planWorkspaceIdentityBySource({
  catalogRoot,
  targetWorkspaceId,
  agentOpsProjectIds = [],
  codexWorkspaceRoots = [],
  includeStaging = true,
  validator = new EcitrValidator(),
  sourceMap = loadWorkspaceSourceMap(),
  plannedAt = new Date().toISOString(),
  createdBy = DEFAULT_CREATED_BY,
  catalogInstance = null,
  runtimeCatalogs = null,
  payloadCache = null,
  attributionCache = null,
} = {}) {
  if (!catalogRoot) {
    throw new Error("planWorkspaceIdentityBySource requires a catalogRoot.");
  }
  if (!targetWorkspaceId) {
    throw new Error("planWorkspaceIdentityBySource requires a targetWorkspaceId.");
  }

  const resolvedCatalogRoot = path.resolve(catalogRoot);
  const resolvedAgentOpsProjectIds = resolveAgentOpsProjectIds({
    agentOpsProjectIds,
    targetWorkspaceId,
    sourceMap,
  });
  const resolvedCodexWorkspaceRoots = resolveCodexWorkspaceRoots({
    codexWorkspaceRoots,
    targetWorkspaceId,
    sourceMap,
  });
  const catalog = catalogInstance
    ?? new FileBackedCatalog({ rootDir: resolvedCatalogRoot, validator });
  if (catalog.rootDir !== resolvedCatalogRoot) {
    throw new Error("Workspace attribution planner catalog root does not match catalogRoot.");
  }
  const catalogs = runtimeCatalogs ?? catalog.loadRuntimeCatalogs();
  const evidencePayloadCache = payloadCache ?? new Map();
  const evidenceAttributionCache = attributionCache ?? new Map();
  const evidenceCorrectionIndex = buildEvidenceCorrectionIndex(catalogs.evidence ?? []);
  const currentEvidence = getCurrentEvidenceRecords(catalogs.evidence ?? []);
  const operations = [];
  const blockers = [];
  const matchedCounts = createRecordCountSummary();

  const matchedEvidence = currentEvidence.filter((record) => isEvidenceMatch({
    record,
    catalogRoot: resolvedCatalogRoot,
    agentOpsProjectIds: new Set(resolvedAgentOpsProjectIds),
    codexWorkspaceRoots: resolvedCodexWorkspaceRoots,
    sourceMap,
    targetWorkspaceId,
    payloadCache: evidencePayloadCache,
    attributionCache: evidenceAttributionCache,
  }));
  const matchedCurrentEvidenceIds = new Set(matchedEvidence.map((record) => record.evidence_id));
  const evidenceTargetIdMap = new Map();
  matchedCounts.evidence = matchedEvidence.length;

  for (const record of matchedEvidence) {
    if (record.workspace_id === targetWorkspaceId) {
      evidenceTargetIdMap.set(record.evidence_id, record.evidence_id);
      continue;
    }

    const correction = {
      ...record,
      evidence_id: buildWorkspaceCorrectionId(record.evidence_id, targetWorkspaceId),
      workspace_id: targetWorkspaceId,
      correction_of: record.evidence_id,
    };
    validator.validateRecord("evidence", correction);
    evidenceTargetIdMap.set(record.evidence_id, correction.evidence_id);
    pushAppendOperation({
      operations,
      catalog,
      recordType: "evidence",
      beforeRecord: record,
      afterRecord: correction,
      targetWorkspaceId,
      blockers,
    });
  }

  const evidenceContext = {
    correctionIndex: evidenceCorrectionIndex,
    matchedCurrentEvidenceIds,
    targetIdMap: evidenceTargetIdMap,
    targetWorkspaceId,
  };
  const parameterPlan = planParameterCorrections({
    catalogs,
    catalog,
    evidenceContext,
    targetWorkspaceId,
    validator,
    operations,
    blockers,
  });
  matchedCounts.parameter_definitions = parameterPlan.definitionIds.size;
  matchedCounts.parameter_observations = parameterPlan.observationIds.size;

  const casePlan = planCaseCorrections({
    cases: catalogs.cases ?? [],
    catalog,
    evidenceContext,
    parameterObservationIdMap: parameterPlan.observationIdMap,
    parameterObservationsById: parameterPlan.observationsById,
    targetWorkspaceId,
    validator,
    operations,
    blockers,
  });
  matchedCounts.cases = casePlan.recordIds.size;

  const invariantPlan = planInvariantCorrections({
    invariants: catalogs.invariants ?? [],
    catalog,
    evidenceContext,
    casesById: casePlan.recordsById,
    targetWorkspaceId,
    validator,
    operations,
    blockers,
  });
  matchedCounts.invariants = invariantPlan.recordIds.size;

  const tacticPlan = planTacticCorrections({
    tactics: catalogs.tactics ?? [],
    catalog,
    evidenceContext,
    casesById: casePlan.recordsById,
    invariantsById: invariantPlan.recordsById,
    parameterObservationIdMap: parameterPlan.observationIdMap,
    parameterObservationsById: parameterPlan.observationsById,
    targetWorkspaceId,
    validator,
    operations,
    blockers,
  });
  matchedCounts.tactics = tacticPlan.recordIds.size;

  if (includeStaging) {
    planStagingPacketCorrections({
      catalogRoot: resolvedCatalogRoot,
      evidenceContext,
      casesById: casePlan.recordsById,
      invariantsById: invariantPlan.recordsById,
      parameterObservationIdMap: parameterPlan.observationIdMap,
      parameterObservationsById: parameterPlan.observationsById,
      targetWorkspaceId,
      agentOpsProjectIds: resolvedAgentOpsProjectIds,
      validator,
      operations,
      blockers,
    });
  }

  const manifest = createMigrationManifest({
    targetWorkspaceId,
    agentOpsProjectIds: resolvedAgentOpsProjectIds,
    codexWorkspaceRoots: resolvedCodexWorkspaceRoots,
    operations,
    blockers,
    plannedAt,
    createdBy,
  });
  validator.validateRecord("workspace_attribution_migration", manifest);

  return {
    catalogRoot: resolvedCatalogRoot,
    manifest,
    matchedCounts,
  };
}

function planParameterCorrections({
  catalogs,
  catalog,
  evidenceContext,
  targetWorkspaceId,
  validator,
  operations,
  blockers,
}) {
  const definitionsById = indexRecords(catalogs.parameter_definitions ?? [], "definition_id");
  const observationsById = indexRecords(catalogs.parameter_observations ?? [], "observation_id");
  const relevant = [];
  const definitionIds = new Set();
  const observationIds = new Set();
  const observationIdMap = new Map();

  for (const observation of catalogs.parameter_observations ?? []) {
    const lineage = classifyEvidenceRefs(observation.source_evidence_refs, evidenceContext);
    if (!lineage.relevant) {
      continue;
    }
    observationIds.add(observation.observation_id);
    definitionIds.add(observation.definition_id);
    if (!lineage.complete) {
      blockers.push(createLineageBlocker(
        "parameter_observation",
        observation.observation_id,
        lineage,
      ));
      continue;
    }
    relevant.push({ observation, lineage });
  }

  const nextDefinitionsByOldId = new Map();
  for (const definitionId of definitionIds) {
    const definition = definitionsById.get(definitionId);
    if (!definition) {
      blockers.push({
        record_type: "parameter_definition",
        record_id: definitionId,
        code: "missing_definition",
        message: `Parameter definition ${definitionId} is missing.`,
      });
      continue;
    }

    const firstObservation = relevant
      .filter((entry) => entry.observation.definition_id === definitionId)
      .map((entry) => entry.observation)
      .sort((left, right) =>
        left.observed_at.localeCompare(right.observed_at)
        || left.observation_id.localeCompare(right.observation_id))[0];
    if (!firstObservation) {
      continue;
    }

    const nextDefinitionId = createDefinitionId({
      workspaceId: targetWorkspaceId,
      observedKey: definition.observed_key,
    });
    const { units: _previousUnits, ...definitionWithoutUnits } = definition;
    const nextDefinition = {
      ...definitionWithoutUnits,
      definition_id: nextDefinitionId,
      workspace_id: targetWorkspaceId,
      value_type: firstObservation.value_type,
      created_at: firstObservation.extracted_at,
      first_observed_at: firstObservation.observed_at,
      first_source_evidence_ref: remapEvidenceRef(firstObservation.source_evidence_refs[0], evidenceContext),
      ...(firstObservation.units ? { units: firstObservation.units } : {}),
    };
    validator.validateRecord("parameter_definition", nextDefinition);
    const existingTargetDefinition = catalog.getRecord(
      "parameter_definition",
      nextDefinition.definition_id,
    );
    if (existingTargetDefinition) {
      if (!parameterDefinitionsCompatible(existingTargetDefinition, nextDefinition)) {
        blockers.push({
          record_type: "parameter_definition",
          record_id: nextDefinition.definition_id,
          code: "target_id_conflict",
          message: `Target parameter_definition ${nextDefinition.definition_id} exists with incompatible key identity.`,
        });
        continue;
      }
      const currentFirstSource = resolveLatestEvidenceCorrection(
        evidenceContext.correctionIndex,
        existingTargetDefinition.first_source_evidence_ref,
      );
      if (!currentFirstSource || currentFirstSource.workspace_id !== targetWorkspaceId) {
        blockers.push({
          record_type: "parameter_definition",
          record_id: nextDefinition.definition_id,
          code: "target_provenance_conflict",
          message: `Target parameter_definition ${nextDefinition.definition_id} has first-seen evidence outside ${targetWorkspaceId}.`,
        });
        continue;
      }
      nextDefinitionsByOldId.set(definitionId, existingTargetDefinition);
      continue;
    }

    nextDefinitionsByOldId.set(definitionId, nextDefinition);
    pushAppendOperation({
      operations,
      catalog,
      recordType: "parameter_definition",
      beforeRecord: definition,
      afterRecord: nextDefinition,
      targetWorkspaceId,
      blockers,
    });
  }

  const candidateObservationIdMap = new Map();
  for (const { observation } of relevant) {
    const nextDefinition = nextDefinitionsByOldId.get(observation.definition_id);
    if (!nextDefinition) {
      continue;
    }
    const sourceEvidenceRefs = observation.source_evidence_refs.map((evidenceId) =>
      remapEvidenceRef(evidenceId, evidenceContext));
    const nextObservationId = createObservationId({
      workspaceId: targetWorkspaceId,
      parameterKey: observation.parameter_key,
      observationKind: observation.observation_kind,
      observedAt: observation.observed_at,
      sourceEvidenceRefs,
      sourceSpans: observation.source_spans,
      rawValueText: observation.raw_value_text,
    });
    candidateObservationIdMap.set(observation.observation_id, nextObservationId);
  }

  const candidates = [];
  for (const { observation } of relevant) {
    const targetObservationId = candidateObservationIdMap.get(observation.observation_id);
    const nextDefinition = nextDefinitionsByOldId.get(observation.definition_id);
    if (!targetObservationId || !nextDefinition) {
      continue;
    }
    const nextObservation = {
      ...observation,
      observation_id: targetObservationId,
      definition_id: nextDefinition.definition_id,
      workspace_id: targetWorkspaceId,
      source_evidence_refs: observation.source_evidence_refs.map((evidenceId) =>
        remapEvidenceRef(evidenceId, evidenceContext)),
      ...(observation.supersedes
        ? {
          supersedes: candidateObservationIdMap.get(observation.supersedes)
            ?? observation.supersedes,
        }
        : {}),
    };
    validator.validateRecord("parameter_observation", nextObservation);
    const existingTarget = catalog.getRecord("parameter_observation", targetObservationId);
    const admissible = !existingTarget || hashRecord(existingTarget) === hashRecord(nextObservation);
    if (!admissible) {
      blockers.push({
        record_type: "parameter_observation",
        record_id: targetObservationId,
        code: "target_id_conflict",
        message: `Target parameter_observation ${targetObservationId} exists with different content.`,
      });
    }
    candidates.push({
      sourceObservation: observation,
      nextObservation,
      admissible,
    });
  }

  const admissibleSourceIds = new Set(candidates
    .filter((entry) => entry.admissible)
    .map((entry) => entry.sourceObservation.observation_id));
  let removedDependency = true;
  while (removedDependency) {
    removedDependency = false;
    for (const candidate of candidates) {
      const supersededSourceId = candidate.sourceObservation.supersedes;
      if (!candidate.admissible
        || !supersededSourceId
        || !candidateObservationIdMap.has(supersededSourceId)
        || admissibleSourceIds.has(supersededSourceId)) {
        continue;
      }
      candidate.admissible = false;
      admissibleSourceIds.delete(candidate.sourceObservation.observation_id);
      blockers.push({
        record_type: "parameter_observation",
        record_id: candidate.nextObservation.observation_id,
        code: "blocked_supersedes_target",
        message: `Parameter observation ${candidate.nextObservation.observation_id} depends on a blocked superseded observation.`,
      });
      removedDependency = true;
    }
  }

  for (const candidate of candidates.filter((entry) => entry.admissible)) {
    const accepted = pushAppendOperation({
      operations,
      catalog,
      recordType: "parameter_observation",
      beforeRecord: candidate.sourceObservation,
      afterRecord: candidate.nextObservation,
      targetWorkspaceId,
      blockers,
    });
    if (accepted) {
      observationIdMap.set(
        candidate.sourceObservation.observation_id,
        candidate.nextObservation.observation_id,
      );
    }
  }

  const effectiveObservationsById = new Map(observationsById);
  for (const operation of operations.filter((entry) => entry.record_type === "parameter_observation")) {
    effectiveObservationsById.set(operation.target_record_id, operation.after_record);
  }

  return {
    definitionIds,
    observationIds,
    observationIdMap,
    observationsById: effectiveObservationsById,
  };
}

function planCaseCorrections({
  cases,
  catalog,
  evidenceContext,
  parameterObservationIdMap,
  parameterObservationsById,
  targetWorkspaceId,
  validator,
  operations,
  blockers,
}) {
  const recordsById = indexRecords(cases, "case_id");
  const recordIds = new Set();

  for (const record of cases) {
    const lineage = classifyEvidenceRefs(record.evidence_refs, evidenceContext);
    if (!lineage.relevant) {
      continue;
    }
    recordIds.add(record.case_id);
    if (!lineage.complete) {
      blockers.push(createLineageBlocker("case", record.case_id, lineage));
      continue;
    }
    if (!parameterRefsCanMove({
      refs: record.parameter_observation_refs,
      parameterObservationIdMap,
      parameterObservationsById,
      targetWorkspaceId,
    })) {
      blockers.push(createParameterBlocker("case", record.case_id));
      continue;
    }

    const next = {
      ...record,
      workspace_id: targetWorkspaceId,
      ...remapParameterObservationRefs(record, parameterObservationIdMap),
    };
    validator.validateRecord("case", next);
    recordsById.set(record.case_id, next);
    pushReplaceOperation({
      operations,
      catalog,
      recordType: "case",
      recordId: record.case_id,
      beforeRecord: record,
      afterRecord: next,
      targetWorkspaceId,
    });
  }

  return { recordsById, recordIds };
}

function planInvariantCorrections({
  invariants,
  catalog,
  evidenceContext,
  casesById,
  targetWorkspaceId,
  validator,
  operations,
  blockers,
}) {
  const recordsById = indexRecords(invariants, "id");
  const recordIds = new Set();

  for (const record of invariants) {
    const lineage = classifyCanonicalLineage({
      evidenceRefs: record.evidence_refs,
      evidenceContext,
      linkedRecords: (record.source_case_refs ?? []).map((id) => casesById.get(id)),
      targetWorkspaceId,
    });
    if (!lineage.relevant) {
      continue;
    }
    recordIds.add(record.id);
    if (!lineage.complete) {
      blockers.push(createLineageBlocker("invariant", record.id, lineage));
      continue;
    }

    const next = { ...record, workspace_id: targetWorkspaceId };
    validator.validateRecord("invariant", next);
    recordsById.set(record.id, next);
    pushReplaceOperation({
      operations,
      catalog,
      recordType: "invariant",
      recordId: record.id,
      beforeRecord: record,
      afterRecord: next,
      targetWorkspaceId,
    });
  }

  return { recordsById, recordIds };
}

function planTacticCorrections({
  tactics,
  catalog,
  evidenceContext,
  casesById,
  invariantsById,
  parameterObservationIdMap,
  parameterObservationsById,
  targetWorkspaceId,
  validator,
  operations,
  blockers,
}) {
  const recordsById = indexRecords(tactics, "id");
  const recordIds = new Set();

  for (const record of tactics) {
    const lineage = classifyCanonicalLineage({
      evidenceRefs: record.evidence_refs,
      evidenceContext,
      linkedRecords: [
        ...(record.source_case_refs ?? []).map((id) => casesById.get(id)),
        ...(record.supporting_invariant_refs ?? []).map((id) => invariantsById.get(id)),
      ],
      targetWorkspaceId,
    });
    if (!lineage.relevant) {
      continue;
    }
    recordIds.add(record.id);
    if (!lineage.complete) {
      blockers.push(createLineageBlocker("tactic", record.id, lineage));
      continue;
    }
    if (!parameterRefsCanMove({
      refs: record.parameter_observation_refs,
      parameterObservationIdMap,
      parameterObservationsById,
      targetWorkspaceId,
    })) {
      blockers.push(createParameterBlocker("tactic", record.id));
      continue;
    }

    const next = {
      ...record,
      workspace_id: targetWorkspaceId,
      environment_bounds: remapWorkspaceBounds(
        record.environment_bounds,
        record.workspace_id,
        targetWorkspaceId,
      ),
      ...remapParameterObservationRefs(record, parameterObservationIdMap),
    };
    validator.validateRecord("tactic", next);
    recordsById.set(record.id, next);
    pushReplaceOperation({
      operations,
      catalog,
      recordType: "tactic",
      recordId: record.id,
      beforeRecord: record,
      afterRecord: next,
      targetWorkspaceId,
    });
  }

  return { recordsById, recordIds };
}

function planStagingPacketCorrections({
  catalogRoot,
  evidenceContext,
  casesById,
  invariantsById,
  parameterObservationIdMap,
  parameterObservationsById,
  targetWorkspaceId,
  agentOpsProjectIds,
  validator,
  operations,
  blockers,
}) {
  for (const definition of STAGING_PACKET_DEFINITIONS) {
    const directory = path.join(catalogRoot, definition.directory);
    if (!fs.existsSync(directory)) {
      continue;
    }

    const records = loadStagingRecords({ directory, recordType: definition.recordType });
    for (const { filePath, record } of records) {
      const evidenceRefs = getStagingEvidenceRefs(definition.recordType, record);
      const linkedRecords = getStagingLinkedRecords({
        recordType: definition.recordType,
        record,
        casesById,
        invariantsById,
      });
      const lineage = definition.recordType === "case_seed"
        ? classifyCaseSeedLineage({
          record,
          evidenceRefs,
          evidenceContext,
          agentOpsProjectIds,
        })
        : classifyCanonicalLineage({
          evidenceRefs,
          evidenceContext,
          linkedRecords,
          targetWorkspaceId,
        });
      if (!lineage.relevant) {
        continue;
      }
      const recordId = record[definition.idKey] ?? filePath;
      if (!lineage.complete) {
        blockers.push(createLineageBlocker(definition.recordType, recordId, lineage));
        continue;
      }
      if (!parameterRefsCanMove({
        refs: getStagingParameterRefs(definition.recordType, record),
        parameterObservationIdMap,
        parameterObservationsById,
        targetWorkspaceId,
      })) {
        blockers.push(createParameterBlocker(definition.recordType, recordId));
        continue;
      }

      const next = transformStagingRecord({
        recordType: definition.recordType,
        record,
        targetWorkspaceId,
        parameterObservationIdMap,
      });
      validator.validateRecord(definition.recordType, next);
      if (hashRecord(record) === hashRecord(next)) {
        continue;
      }
      const appendCandidateRevision = isLiveCandidateRecordType(definition.recordType);
      const targetFilePath = appendCandidateRevision
        ? path.join(directory, `${next.candidate_id}.json`)
        : filePath;
      operations.push(createMigrationOperation({
        action: appendCandidateRevision ? "append" : "replace",
        recordType: definition.recordType,
        recordId,
        targetRecordId: appendCandidateRevision ? next.candidate_id : recordId,
        filePath: targetFilePath,
        ...(appendCandidateRevision ? { sourceFilePath: filePath } : {}),
        targetWorkspaceId,
        beforeRecord: record,
        afterRecord: next,
      }));
    }
  }
}

function loadStagingRecords({ directory, recordType }) {
  const records = fs.readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((entry) => {
      const filePath = path.join(directory, entry);
      return {
        filePath,
        record: JSON.parse(fs.readFileSync(filePath, "utf8")),
      };
    });
  if (!isLiveCandidateRecordType(recordType)) {
    return records;
  }

  const latestBySeries = new Map();
  for (const entry of records) {
    const seriesId = entry.record.candidate_series_id ?? entry.record.candidate_id;
    const current = latestBySeries.get(seriesId);
    if (!current
      || entry.record.revision > current.record.revision
      || (entry.record.revision === current.record.revision
        && String(entry.record.last_seen_at).localeCompare(String(current.record.last_seen_at)) > 0)
      || (entry.record.revision === current.record.revision
        && entry.record.last_seen_at === current.record.last_seen_at
        && entry.record.candidate_id.localeCompare(current.record.candidate_id) > 0)) {
      latestBySeries.set(seriesId, entry);
    }
  }
  return [...latestBySeries.values()];
}

function getStagingEvidenceRefs(recordType, record) {
  if (recordType !== "case_seed") {
    return record.evidence_refs ?? [];
  }
  return [
    record.evidence_links?.run_evidence_ref,
    record.evidence_links?.session_evidence_ref,
    ...(record.evidence_links?.chat_evidence_refs ?? []),
  ].filter(Boolean);
}

function getStagingLinkedRecords({ recordType, record, casesById, invariantsById }) {
  if (recordType === "case_seed" || recordType === "case_compilation_packet") {
    return [];
  }
  return [
    ...(record.source_case_refs ?? []).map((id) => casesById.get(id)),
    ...(record.counterexample_case_refs ?? []).map((id) => casesById.get(id)),
    ...(record.supporting_invariant_refs ?? []).map((id) => invariantsById.get(id)),
  ];
}

function getStagingParameterRefs(recordType, record) {
  const topLevel = record.parameter_observation_refs ?? [];
  const nested = ["live_invariant_candidate", "live_tactic_candidate"].includes(recordType)
    ? record.entry?.parameter_observation_refs ?? []
    : [];
  return [...new Set([...topLevel, ...nested])];
}

function classifyCaseSeedLineage({
  record,
  evidenceRefs,
  evidenceContext,
  agentOpsProjectIds,
}) {
  const evidence = classifyEvidenceRefs(evidenceRefs, evidenceContext);
  const projectRelevant = agentOpsProjectIds.includes(record.project_id);
  return {
    relevant: projectRelevant || evidence.relevant,
    complete: projectRelevant && (evidenceRefs.length === 0 || evidence.complete),
    workspace_ids: evidence.workspace_ids,
  };
}

function transformStagingRecord({
  recordType,
  record,
  targetWorkspaceId,
  parameterObservationIdMap,
}) {
  const base = {
    ...record,
    workspace_id: targetWorkspaceId,
    ...(Array.isArray(record.environment_bounds)
      ? {
        environment_bounds: remapWorkspaceBounds(
          record.environment_bounds,
          record.workspace_id,
          targetWorkspaceId,
        ),
      }
      : {}),
    ...remapParameterObservationRefs(record, parameterObservationIdMap),
  };
  if (!["live_invariant_candidate", "live_tactic_candidate"].includes(recordType)) {
    return base;
  }

  const entry = { ...record.entry };
  if (entry.workspace_id === record.workspace_id) {
    entry.workspace_id = targetWorkspaceId;
  }
  if (Array.isArray(entry.environment_bounds)) {
    entry.environment_bounds = remapWorkspaceBounds(
      entry.environment_bounds,
      record.workspace_id,
      targetWorkspaceId,
    );
  }
  if (Array.isArray(entry.parameter_observation_refs)) {
    entry.parameter_observation_refs = entry.parameter_observation_refs.map((observationId) =>
      parameterObservationIdMap.get(observationId) ?? observationId);
  }
  const corrected = { ...base, entry };
  const semanticChanged = corrected.workspace_id !== record.workspace_id
    || hashRecord(corrected.entry) !== hashRecord(record.entry);
  if (!semanticChanged) {
    return record;
  }

  const { discovery_semantics_hash: _staleHash, ...candidate } = corrected;
  const candidateSeriesId = record.candidate_series_id ?? record.candidate_id;
  const revision = record.revision + 1;
  const digest = crypto
    .createHash("sha1")
    .update(`workspace-attribution:${targetWorkspaceId}:${record.candidate_id}:${hashRecord(corrected.entry)}`)
    .digest("hex")
    .slice(0, 12);
  return {
    ...candidate,
    candidate_id: `${candidateSeriesId}_rev_${revision}_${digest}`,
    candidate_series_id: candidateSeriesId,
    supersedes_candidate_id: record.candidate_id,
    status: "staged",
    revision,
    decision_history: [],
  };
}

function isLiveCandidateRecordType(recordType) {
  return ["live_invariant_candidate", "live_tactic_candidate"].includes(recordType);
}

function applyWorkspaceIdentityMigration({
  catalogRoot,
  manifest,
  validator = new EcitrValidator(),
  appliedAt = new Date().toISOString(),
  catalogInstance = null,
}) {
  const catalog = catalogInstance ?? new FileBackedCatalog({ rootDir: catalogRoot, validator });
  if (catalog.rootDir !== path.resolve(catalogRoot)) {
    throw new Error("Workspace attribution apply catalog root does not match catalogRoot.");
  }
  const store = new WorkspaceAttributionMigrationManifestStore({
    rootDir: catalogRoot,
    validator,
  });
  const existingManifest = store.getManifest(manifest.migration_id);
  if (existingManifest?.status === "applied" || existingManifest?.status === "applied_with_blockers") {
    return existingManifest;
  }

  store.writeManifest(manifest, { overwrite: Boolean(existingManifest) });
  let applying = { ...manifest, status: "applying" };
  store.writeManifest(applying, { overwrite: true });

  try {
    for (const operation of manifest.operations) {
      preflightMigrationOperation({ catalog, operation });
    }
    for (const operation of manifest.operations) {
      applyMigrationOperation({ catalog, operation });
    }
    applying = {
      ...applying,
      status: manifest.blockers.length > 0 ? "applied_with_blockers" : "applied",
      applied_at: appliedAt,
    };
    store.writeManifest(applying, { overwrite: true });
    return applying;
  } catch (error) {
    const failed = {
      ...applying,
      status: "failed",
      failure: error.message,
    };
    store.writeManifest(failed, { overwrite: true });
    throw error;
  }
}

function preflightWorkspaceIdentityMigration({
  catalogRoot,
  manifest,
  validator = new EcitrValidator(),
  catalogInstance = null,
}) {
  const catalog = catalogInstance ?? new FileBackedCatalog({ rootDir: catalogRoot, validator });
  if (catalog.rootDir !== path.resolve(catalogRoot)) {
    throw new Error("Workspace attribution preflight catalog root does not match catalogRoot.");
  }
  for (const operation of manifest.operations) {
    preflightMigrationOperation({ catalog, operation });
  }
}

function preflightMigrationOperation({ catalog, operation }) {
  if (operation.file_path) {
    if (operation.action === "append") {
      if (!operation.source_file_path || !fs.existsSync(operation.source_file_path)) {
        throw new Error(`Migration staging source disappeared: ${operation.source_file_path}`);
      }
      const source = JSON.parse(fs.readFileSync(operation.source_file_path, "utf8"));
      if (hashRecord(source) !== operation.before_hash) {
        throw new Error(`Migration basis drift for staging source: ${operation.source_file_path}`);
      }
      if (fs.existsSync(operation.file_path)) {
        const target = JSON.parse(fs.readFileSync(operation.file_path, "utf8"));
        if (hashRecord(target) !== operation.after_hash) {
          throw new Error(`Migration target conflict for staging artifact: ${operation.file_path}`);
        }
      }
      return;
    }
    if (!fs.existsSync(operation.file_path)) {
      throw new Error(`Migration staging packet disappeared: ${operation.file_path}`);
    }
    const current = JSON.parse(fs.readFileSync(operation.file_path, "utf8"));
    if (hashRecord(current) !== operation.before_hash
      && hashRecord(current) !== operation.after_hash) {
      throw new Error(`Migration basis drift for staging packet: ${operation.file_path}`);
    }
    return;
  }

  const current = catalog.getRecord(operation.record_type, operation.target_record_id);
  if (operation.action === "append") {
    if (current && hashRecord(current) !== operation.after_hash) {
      throw new Error(
        `Migration target conflict for ${operation.record_type}:${operation.target_record_id}.`,
      );
    }
    return;
  }

  if (!current
    || (hashRecord(current) !== operation.before_hash
      && hashRecord(current) !== operation.after_hash)) {
    throw new Error(
      `Migration basis drift for ${operation.record_type}:${operation.target_record_id}.`,
    );
  }
}

function applyMigrationOperation({ catalog, operation }) {
  if (operation.file_path) {
    return applyStagingOperation(operation);
  }

  const current = catalog.getRecord(operation.record_type, operation.target_record_id);
  if (operation.action === "append") {
    if (current) {
      if (hashRecord(current) !== operation.after_hash) {
        throw new Error(
          `Migration target conflict for ${operation.record_type}:${operation.target_record_id}.`,
        );
      }
      return;
    }
    catalog.writeRecord(operation.record_type, operation.after_record);
    return;
  }

  if (current && hashRecord(current) === operation.after_hash) {
    return;
  }
  if (!current || hashRecord(current) !== operation.before_hash) {
    throw new Error(
      `Migration basis drift for ${operation.record_type}:${operation.target_record_id}.`,
    );
  }
  catalog.writeRecord(operation.record_type, operation.after_record, { overwrite: true });
}

function applyStagingOperation(operation) {
  if (operation.action === "append") {
    if (!operation.source_file_path || !fs.existsSync(operation.source_file_path)) {
      throw new Error(`Migration staging source disappeared: ${operation.source_file_path}`);
    }
    const source = JSON.parse(fs.readFileSync(operation.source_file_path, "utf8"));
    if (hashRecord(source) !== operation.before_hash) {
      throw new Error(`Migration basis drift for staging source: ${operation.source_file_path}`);
    }
    if (fs.existsSync(operation.file_path)) {
      const target = JSON.parse(fs.readFileSync(operation.file_path, "utf8"));
      if (hashRecord(target) !== operation.after_hash) {
        throw new Error(`Migration target conflict for staging artifact: ${operation.file_path}`);
      }
      return;
    }
    fs.writeFileSync(operation.file_path, `${JSON.stringify(operation.after_record, null, 2)}\n`, "utf8");
    return;
  }
  if (!fs.existsSync(operation.file_path)) {
    throw new Error(`Migration staging packet disappeared: ${operation.file_path}`);
  }
  const current = JSON.parse(fs.readFileSync(operation.file_path, "utf8"));
  if (hashRecord(current) === operation.after_hash) {
    return;
  }
  if (hashRecord(current) !== operation.before_hash) {
    throw new Error(`Migration basis drift for staging packet: ${operation.file_path}`);
  }
  fs.writeFileSync(operation.file_path, `${JSON.stringify(operation.after_record, null, 2)}\n`, "utf8");
}

function summarizeMigrationPlan(plan, { dryRun }) {
  const operationCounts = plan.manifest.summary.operation_counts;
  return {
    dry_run: dryRun,
    status: dryRun ? "planned" : plan.manifest.status,
    catalog_root: plan.catalogRoot,
    target_workspace_id: plan.manifest.target_workspace_id,
    agent_ops_project_ids: plan.manifest.source_selectors.agent_ops_project_ids,
    codex_workspace_roots: plan.manifest.source_selectors.codex_workspace_roots,
    migration_id: plan.manifest.migration_id,
    manifest_path: path.join(
      plan.catalogRoot,
      "state",
      "workspace-attribution-migrations",
      `${plan.manifest.migration_id}.json`,
    ),
    matched_record_counts: plan.matchedCounts,
    updated_record_counts: {
      evidence: operationCounts.evidence ?? 0,
      cases: operationCounts.case ?? 0,
      invariants: operationCounts.invariant ?? 0,
      tactics: operationCounts.tactic ?? 0,
      parameter_definitions: operationCounts.parameter_definition ?? 0,
      parameter_observations: operationCounts.parameter_observation ?? 0,
    },
    staging_packets_updated: STAGING_PACKET_DEFINITIONS.reduce(
      (total, definition) => total + (operationCounts[definition.recordType] ?? 0),
      0,
    ),
    blocked_records: plan.manifest.blockers.length,
    blockers: plan.manifest.blockers,
    errors: 0,
    error_details: [],
  };
}

function pushAppendOperation({
  operations,
  catalog,
  recordType,
  beforeRecord,
  afterRecord,
  targetWorkspaceId,
  blockers,
}) {
  if (hashRecord(beforeRecord) === hashRecord(afterRecord)) {
    return true;
  }
  const targetRecordId = getRecordId(recordType, afterRecord);
  const existing = catalog.getRecord(recordType, targetRecordId);
  if (existing) {
    if (hashRecord(existing) !== hashRecord(afterRecord)) {
      blockers.push({
        record_type: recordType,
        record_id: targetRecordId,
        code: "target_id_conflict",
        message: `Target ${recordType} ${targetRecordId} exists with different content.`,
      });
      return false;
    }
    return true;
  }

  operations.push(createMigrationOperation({
    action: "append",
    recordType,
    recordId: getRecordId(recordType, beforeRecord),
    targetRecordId,
    targetWorkspaceId,
    beforeRecord,
    afterRecord,
  }));
  return true;
}

function pushReplaceOperation({
  operations,
  catalog,
  recordType,
  recordId,
  beforeRecord,
  afterRecord,
  targetWorkspaceId,
}) {
  if (hashRecord(beforeRecord) === hashRecord(afterRecord)) {
    return;
  }
  const current = catalog.getRecord(recordType, recordId);
  if (!current || hashRecord(current) !== hashRecord(beforeRecord)) {
    throw new Error(`Catalog changed while planning ${recordType}:${recordId}.`);
  }
  operations.push(createMigrationOperation({
    action: "replace",
    recordType,
    recordId,
    targetWorkspaceId,
    beforeRecord,
    afterRecord,
  }));
}

function isEvidenceMatch({
  record,
  catalogRoot,
  agentOpsProjectIds,
  codexWorkspaceRoots,
  sourceMap,
  targetWorkspaceId,
  payloadCache,
  attributionCache,
}) {
  const payload = loadPayload(record, { catalogRoot, payloadCache });
  if (record.source_type === "file" && agentOpsProjectIds.size > 0) {
    const projectId = payload?.project_id;
    if (!projectId) {
      return false;
    }
    const cacheKey = `agent_ops:${projectId}`;
    const attribution = attributionCache.get(cacheKey)
      ?? resolveWorkspaceAttributionForAgentOps({ projectId, catalogRoot, sourceMap });
    attributionCache.set(cacheKey, attribution);
    return attribution.authoritative
      ? attribution.workspace_id === targetWorkspaceId
      : agentOpsProjectIds.has(projectId);
  }
  if (record.source_type === "chat" && codexWorkspaceRoots.length > 0) {
    const cwd = payload?.cwd;
    if (!cwd) {
      return false;
    }
    const cacheKey = `codex:${cwd}`;
    const attribution = attributionCache.get(cacheKey)
      ?? resolveWorkspaceAttributionForCodex({ cwd, catalogRoot, sourceMap });
    attributionCache.set(cacheKey, attribution);
    return attribution.authoritative
      ? attribution.workspace_id === targetWorkspaceId
      : isPathWithinRoots(cwd, codexWorkspaceRoots);
  }
  return false;
}

function classifyEvidenceRefs(refs = [], evidenceContext) {
  const resolved = refs.map((evidenceId) =>
    resolveLatestEvidenceCorrection(evidenceContext.correctionIndex, evidenceId));
  const targetMatches = resolved.map((record) =>
    Boolean(record && evidenceContext.matchedCurrentEvidenceIds.has(record.evidence_id)));
  const workspaceIds = resolved.map((record) => record?.workspace_id).filter(Boolean);
  return {
    relevant: targetMatches.some(Boolean),
    complete: refs.length > 0 && resolved.every(Boolean) && targetMatches.every(Boolean),
    workspace_ids: [...new Set(workspaceIds)].sort(),
  };
}

function classifyCanonicalLineage({
  evidenceRefs = [],
  evidenceContext,
  linkedRecords = [],
  targetWorkspaceId,
}) {
  const evidence = classifyEvidenceRefs(evidenceRefs, evidenceContext);
  const linkedWorkspaceIds = linkedRecords.map((record) => record?.workspace_id).filter(Boolean);
  const hasMissingLinkedRecord = linkedRecords.some((record) => !record);
  const linkedRelevant = linkedWorkspaceIds.includes(targetWorkspaceId);
  const relevant = evidence.relevant || linkedRelevant;
  const evidenceComplete = evidenceRefs.length === 0 || evidence.complete;
  const linkedComplete = !hasMissingLinkedRecord
    && linkedWorkspaceIds.every((workspaceId) => workspaceId === targetWorkspaceId);
  return {
    relevant,
    complete: relevant && evidenceComplete && linkedComplete,
    workspace_ids: [...new Set([...evidence.workspace_ids, ...linkedWorkspaceIds])].sort(),
  };
}

function remapEvidenceRef(evidenceId, evidenceContext) {
  const current = resolveLatestEvidenceCorrection(evidenceContext.correctionIndex, evidenceId);
  if (!current) {
    return evidenceId;
  }
  return evidenceContext.targetIdMap.get(current.evidence_id) ?? current.evidence_id;
}

function parameterRefsCanMove({
  refs = [],
  parameterObservationIdMap,
  parameterObservationsById,
  targetWorkspaceId,
}) {
  return refs.every((observationId) => {
    if (parameterObservationIdMap.has(observationId)) {
      return true;
    }
    return parameterObservationsById.get(observationId)?.workspace_id === targetWorkspaceId;
  });
}

function remapParameterObservationRefs(record, observationIdMap) {
  if (!Array.isArray(record.parameter_observation_refs)) {
    return {};
  }
  return {
    parameter_observation_refs: record.parameter_observation_refs.map((observationId) =>
      observationIdMap.get(observationId) ?? observationId),
  };
}

function remapWorkspaceBounds(values = [], previousWorkspaceId, targetWorkspaceId) {
  return values.map((value) =>
    value === `workspace:${previousWorkspaceId}` ? `workspace:${targetWorkspaceId}` : value);
}

function parameterDefinitionsCompatible(left, right) {
  return left.workspace_id === right.workspace_id
    && left.observed_key === right.observed_key
    && left.normalized_key === right.normalized_key
    && left.value_type === right.value_type
    && (left.units ?? null) === (right.units ?? null);
}

function createLineageBlocker(recordType, recordId, lineage) {
  return {
    record_type: recordType,
    record_id: recordId,
    code: "mixed_or_unresolved_lineage",
    message: `Record ${recordId} has mixed or unresolved workspace lineage and was not changed.`,
    ...(lineage.workspace_ids.length > 0 ? { workspace_ids: lineage.workspace_ids } : {}),
  };
}

function createParameterBlocker(recordType, recordId) {
  return {
    record_type: recordType,
    record_id: recordId,
    code: "mixed_or_unresolved_parameter_lineage",
    message: `Record ${recordId} has parameter references outside the target workspace and was not changed.`,
  };
}

function buildWorkspaceCorrectionId(evidenceId, targetWorkspaceId) {
  return `${evidenceId}_workspace_${targetWorkspaceId}`;
}

function loadPayload(record, { catalogRoot, payloadCache = null }) {
  if (!record.verbatim_payload_ref) {
    return null;
  }
  const payloadPath = path.isAbsolute(record.verbatim_payload_ref)
    ? record.verbatim_payload_ref
    : path.resolve(catalogRoot, record.verbatim_payload_ref);
  if (payloadCache?.has(payloadPath)) {
    return payloadCache.get(payloadPath);
  }
  if (!fs.existsSync(payloadPath)) {
    payloadCache?.set(payloadPath, null);
    return null;
  }
  const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
  payloadCache?.set(payloadPath, payload);
  return payload;
}

function resolveAgentOpsProjectIds({ agentOpsProjectIds, targetWorkspaceId, sourceMap }) {
  if (Array.isArray(agentOpsProjectIds) && agentOpsProjectIds.length > 0) {
    return [...new Set(agentOpsProjectIds.filter(Boolean))].sort();
  }
  const manual = sourceMap.agent_ops_projects
    .filter((entry) => entry.workspace_id === targetWorkspaceId)
    .map((entry) => entry.project_id);
  const registered = sourceMap.agent_ops_registry_projects
    .filter((entry) => entry.id === targetWorkspaceId)
    .flatMap((entry) => [entry.id, ...entry.aliases]);
  return [...new Set([...manual, ...registered])].sort();
}

function resolveCodexWorkspaceRoots({ codexWorkspaceRoots, targetWorkspaceId, sourceMap }) {
  if (Array.isArray(codexWorkspaceRoots) && codexWorkspaceRoots.length > 0) {
    return [...new Set(codexWorkspaceRoots.filter(Boolean).map((entry) => path.resolve(entry)))].sort();
  }
  const manual = sourceMap.codex_workspaces
    .filter((entry) => entry.workspace_id === targetWorkspaceId)
    .map((entry) => entry.workspace_root);
  const registered = sourceMap.agent_ops_registry_projects
    .filter((entry) => entry.id === targetWorkspaceId)
    .flatMap((entry) => entry.workspace_roots);
  return [...new Set([...manual, ...registered].map((entry) => path.resolve(entry)))].sort();
}

function createRecordCountSummary() {
  return {
    evidence: 0,
    cases: 0,
    invariants: 0,
    tactics: 0,
    parameter_definitions: 0,
    parameter_observations: 0,
  };
}

function indexRecords(records, idKey) {
  return new Map(records.map((record) => [record[idKey], record]));
}

function getRecordId(recordType, record) {
  switch (recordType) {
    case "evidence":
      return record.evidence_id;
    case "case":
      return record.case_id;
    case "invariant":
    case "tactic":
      return record.id;
    case "parameter_definition":
      return record.definition_id;
    case "parameter_observation":
      return record.observation_id;
    default:
      throw new Error(`Unsupported workspace-attribution record type: ${recordType}`);
  }
}

module.exports = {
  applyWorkspaceIdentityMigration,
  buildWorkspaceCorrectionId,
  migrateWorkspaceIdentityBySource,
  planWorkspaceIdentityBySource,
  preflightWorkspaceIdentityMigration,
  summarizeMigrationPlan,
};
