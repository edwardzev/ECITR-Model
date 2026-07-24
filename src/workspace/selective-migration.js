const fs = require("node:fs");
const path = require("node:path");

const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const {
  buildEvidenceCorrectionIndex,
  resolveLatestEvidenceCorrection,
} = require("../evidence/corrections");
const { EcitrValidator } = require("../validation/validator");
const { isPathWithinRoots, loadWorkspaceSourceMap } = require("./source-mapping");

const STAGING_PACKET_DEFINITIONS = Object.freeze([
  {
    recordType: "case_compilation_packet",
    directory: path.join("staging", "case-compilation-packets"),
    matches(packet, { evidenceIds }) {
      return hasIntersection(packet.evidence_refs, evidenceIds);
    },
  },
  {
    recordType: "invariant_promotion_packet",
    directory: path.join("staging", "invariant-promotion-packets"),
    matches(packet, { parameterObservationIds }) {
      return hasIntersection(packet.parameter_observation_refs, parameterObservationIds);
    },
  },
  {
    recordType: "tactic_promotion_packet",
    directory: path.join("staging", "tactic-promotion-packets"),
    matches(packet, { parameterObservationIds }) {
      return hasIntersection(packet.parameter_observation_refs, parameterObservationIds);
    },
  },
]);

function migrateWorkspaceIdentityBySource({
  catalogRoot,
  targetWorkspaceId,
  agentOpsProjectIds = [],
  codexWorkspaceRoots = [],
  dryRun = false,
  includeStaging = true,
  validator = new EcitrValidator(),
  sourceMap = loadWorkspaceSourceMap(),
} = {}) {
  if (!catalogRoot) {
    throw new Error("migrateWorkspaceIdentityBySource requires a catalogRoot.");
  }
  if (!targetWorkspaceId) {
    throw new Error("migrateWorkspaceIdentityBySource requires a targetWorkspaceId.");
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
  const catalog = new FileBackedCatalog({ rootDir: resolvedCatalogRoot, validator });
  const catalogs = catalog.loadRuntimeCatalogs();
  const evidenceCorrectionIndex = buildEvidenceCorrectionIndex(catalogs.evidence ?? []);
  const summary = {
    dry_run: dryRun,
    catalog_root: resolvedCatalogRoot,
    target_workspace_id: targetWorkspaceId,
    agent_ops_project_ids: resolvedAgentOpsProjectIds,
    codex_workspace_roots: resolvedCodexWorkspaceRoots,
    matched_record_counts: {
      evidence: 0,
      cases: 0,
      invariants: 0,
      tactics: 0,
      parameter_definitions: 0,
      parameter_observations: 0,
    },
    updated_record_counts: {
      evidence: 0,
      cases: 0,
      invariants: 0,
      tactics: 0,
      parameter_definitions: 0,
      parameter_observations: 0,
    },
    staging_packets_updated: 0,
    errors: 0,
    error_details: [],
  };

  const evidenceIds = collectMatchingEvidenceIds({
    evidenceRecords: catalogs.evidence ?? [],
    catalogRoot: resolvedCatalogRoot,
    agentOpsProjectIds: new Set(resolvedAgentOpsProjectIds),
    codexWorkspaceRoots: resolvedCodexWorkspaceRoots,
    summary,
  });
  summary.matched_record_counts.evidence = evidenceIds.size;

  const parameterObservationIds = new Set(
    (catalogs.parameter_observations ?? [])
      .filter((record) => hasIntersection(record.source_evidence_refs, evidenceIds))
      .map((record) => record.observation_id),
  );
  summary.matched_record_counts.parameter_observations = parameterObservationIds.size;

  const parameterDefinitionIds = new Set(
    (catalogs.parameter_definitions ?? [])
      .filter((record) =>
        (catalogs.parameter_observations ?? []).some((observation) =>
          parameterObservationIds.has(observation.observation_id)
          && observation.definition_id === record.definition_id),
      )
      .map((record) => record.definition_id),
  );
  summary.matched_record_counts.parameter_definitions = parameterDefinitionIds.size;

  const matchedCases = (catalogs.cases ?? []).filter((record) => hasIntersection(record.evidence_refs, evidenceIds));
  const matchedInvariants = (catalogs.invariants ?? []).filter((record) =>
    hasIntersection(record.parameter_observation_refs, parameterObservationIds));
  const matchedTactics = (catalogs.tactics ?? []).filter((record) =>
    hasIntersection(record.parameter_observation_refs, parameterObservationIds));
  summary.matched_record_counts.cases = matchedCases.length;
  summary.matched_record_counts.invariants = matchedInvariants.length;
  summary.matched_record_counts.tactics = matchedTactics.length;

  summary.updated_record_counts.evidence = rewriteWorkspaceId({
    catalog,
    recordType: "evidence",
    records: (catalogs.evidence ?? []).filter((record) => evidenceIds.has(record.evidence_id)),
    targetWorkspaceId,
    dryRun,
    evidenceCorrectionIndex,
  });
  summary.updated_record_counts.cases = rewriteWorkspaceId({
    catalog,
    recordType: "case",
    records: matchedCases,
    targetWorkspaceId,
    dryRun,
  });
  summary.updated_record_counts.invariants = rewriteWorkspaceId({
    catalog,
    recordType: "invariant",
    records: matchedInvariants,
    targetWorkspaceId,
    dryRun,
  });
  summary.updated_record_counts.tactics = rewriteWorkspaceId({
    catalog,
    recordType: "tactic",
    records: matchedTactics,
    targetWorkspaceId,
    dryRun,
  });
  summary.updated_record_counts.parameter_definitions = rewriteWorkspaceId({
    catalog,
    recordType: "parameter_definition",
    records: (catalogs.parameter_definitions ?? []).filter((record) =>
      parameterDefinitionIds.has(record.definition_id)),
    targetWorkspaceId,
    dryRun,
  });
  summary.updated_record_counts.parameter_observations = rewriteWorkspaceId({
    catalog,
    recordType: "parameter_observation",
    records: (catalogs.parameter_observations ?? []).filter((record) =>
      parameterObservationIds.has(record.observation_id)),
    targetWorkspaceId,
    dryRun,
  });

  if (includeStaging) {
    summary.staging_packets_updated = rewriteStagingPackets({
      catalogRoot: resolvedCatalogRoot,
      targetWorkspaceId,
      dryRun,
      validator,
      evidenceIds,
      parameterObservationIds,
      summary,
    });
  }

  return summary;
}

function collectMatchingEvidenceIds({
  evidenceRecords,
  catalogRoot,
  agentOpsProjectIds,
  codexWorkspaceRoots,
  summary,
}) {
  const evidenceIds = new Set();

  for (const record of evidenceRecords) {
    try {
      if (isAgentOpsEvidenceMatch({ record, catalogRoot, agentOpsProjectIds })) {
        evidenceIds.add(record.evidence_id);
        continue;
      }

      if (isCodexEvidenceMatch({ record, catalogRoot, codexWorkspaceRoots })) {
        evidenceIds.add(record.evidence_id);
      }
    } catch (error) {
      summary.errors += 1;
      summary.error_details.push({
        record_type: "evidence",
        record_id: record.evidence_id,
        message: error.message,
      });
    }
  }

  return evidenceIds;
}

function isAgentOpsEvidenceMatch({ record, catalogRoot, agentOpsProjectIds }) {
  if (agentOpsProjectIds.size === 0 || record.source_type !== "file") {
    return false;
  }

  const payload = loadPayload(record, { catalogRoot });
  return agentOpsProjectIds.has(payload?.project_id);
}

function isCodexEvidenceMatch({ record, catalogRoot, codexWorkspaceRoots }) {
  if (codexWorkspaceRoots.length === 0 || record.source_type !== "chat") {
    return false;
  }

  const payload = loadPayload(record, { catalogRoot });
  return isPathWithinRoots(payload?.cwd, codexWorkspaceRoots);
}

function rewriteWorkspaceId({
  catalog,
  recordType,
  records,
  targetWorkspaceId,
  dryRun,
  evidenceCorrectionIndex = null,
}) {
  let updated = 0;

  for (const record of records) {
    const currentRecord = recordType === "evidence"
      ? resolveLatestEvidenceCorrection(evidenceCorrectionIndex, record.evidence_id) ?? record
      : record;
    if (currentRecord.workspace_id === targetWorkspaceId) {
      continue;
    }

    updated += 1;
    if (dryRun) {
      continue;
    }

    if (recordType === "evidence") {
      const correction = {
        ...currentRecord,
        evidence_id: buildWorkspaceCorrectionId(currentRecord.evidence_id, targetWorkspaceId),
        workspace_id: targetWorkspaceId,
        correction_of: currentRecord.evidence_id,
      };
      const persisted = catalog.writeRecord("evidence", correction);
      evidenceCorrectionIndex.byId.set(correction.evidence_id, persisted.record);
      evidenceCorrectionIndex.childByParent.set(currentRecord.evidence_id, correction.evidence_id);
      continue;
    }

    catalog.writeRecord(recordType, {
      ...currentRecord,
      workspace_id: targetWorkspaceId,
    }, { overwrite: true });
  }

  return updated;
}

function buildWorkspaceCorrectionId(evidenceId, targetWorkspaceId) {
  return `${evidenceId}_workspace_${targetWorkspaceId}`;
}

function rewriteStagingPackets({
  catalogRoot,
  targetWorkspaceId,
  dryRun,
  validator,
  evidenceIds,
  parameterObservationIds,
  summary,
}) {
  let updated = 0;

  for (const definition of STAGING_PACKET_DEFINITIONS) {
    const directory = path.join(catalogRoot, definition.directory);
    if (!fs.existsSync(directory)) {
      continue;
    }

    for (const entry of fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort()) {
      const filePath = path.join(directory, entry);
      try {
        const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (!definition.matches(record, { evidenceIds, parameterObservationIds })) {
          continue;
        }

        if (record.workspace_id === targetWorkspaceId) {
          continue;
        }

        const nextRecord = {
          ...record,
          workspace_id: targetWorkspaceId,
        };
        validator.validateRecord(definition.recordType, nextRecord);
        updated += 1;

        if (!dryRun) {
          fs.writeFileSync(filePath, `${JSON.stringify(nextRecord, null, 2)}\n`, "utf8");
        }
      } catch (error) {
        summary.errors += 1;
        summary.error_details.push({
          record_type: definition.recordType,
          record_id: filePath,
          message: error.message,
        });
      }
    }
  }

  return updated;
}

function loadPayload(record, { catalogRoot }) {
  if (!record.verbatim_payload_ref) {
    return null;
  }

  const payloadPath = path.isAbsolute(record.verbatim_payload_ref)
    ? record.verbatim_payload_ref
    : path.resolve(catalogRoot, record.verbatim_payload_ref);
  if (!fs.existsSync(payloadPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(payloadPath, "utf8"));
}

function hasIntersection(values, matchSet) {
  if (!Array.isArray(values) || matchSet.size === 0) {
    return false;
  }

  return values.some((value) => matchSet.has(value));
}

function resolveAgentOpsProjectIds({ agentOpsProjectIds, targetWorkspaceId, sourceMap }) {
  if (Array.isArray(agentOpsProjectIds) && agentOpsProjectIds.length > 0) {
    return [...new Set(agentOpsProjectIds.filter(Boolean))];
  }

  return sourceMap.agent_ops_projects
    .filter((entry) => entry.workspace_id === targetWorkspaceId)
    .map((entry) => entry.project_id);
}

function resolveCodexWorkspaceRoots({ codexWorkspaceRoots, targetWorkspaceId, sourceMap }) {
  if (Array.isArray(codexWorkspaceRoots) && codexWorkspaceRoots.length > 0) {
    return [...new Set(codexWorkspaceRoots.filter(Boolean).map((entry) => path.resolve(entry)))];
  }

  return sourceMap.codex_workspaces
    .filter((entry) => entry.workspace_id === targetWorkspaceId)
    .map((entry) => entry.workspace_root);
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
      throw new Error(`Unsupported selective-migration record type: ${recordType}`);
  }
}

module.exports = {
  migrateWorkspaceIdentityBySource,
};
