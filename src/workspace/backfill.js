const fs = require("node:fs");
const path = require("node:path");

const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { EcitrValidator, readJson } = require("../validation/validator");
const { createDefinitionId, createObservationId } = require("../parameters/common");
const {
  buildEvidenceCorrectionIndex,
  getCurrentEvidenceRecords,
  resolveLatestEvidenceCorrection,
} = require("../evidence/corrections");

const STAGING_PACKET_DEFINITIONS = Object.freeze([
  {
    directory: path.join("staging", "case-compilation-packets"),
    schemaKey: "case_compilation_packet",
    transform(record, { workspaceId, observationIdMap }) {
      return {
        ...record,
        workspace_id: record.workspace_id ?? workspaceId,
        ...(Array.isArray(record.parameter_observation_refs)
          ? {
            parameter_observation_refs: record.parameter_observation_refs.map(
              (value) => observationIdMap.get(value) ?? value,
            ),
          }
          : {}),
      };
    },
  },
  {
    directory: path.join("staging", "invariant-promotion-packets"),
    schemaKey: "invariant_promotion_packet",
    transform(record, { workspaceId }) {
      return {
        ...record,
        workspace_id: record.workspace_id ?? workspaceId,
      };
    },
  },
  {
    directory: path.join("staging", "tactic-promotion-packets"),
    schemaKey: "tactic_promotion_packet",
    transform(record, { workspaceId, observationIdMap }) {
      return {
        ...record,
        workspace_id: record.workspace_id ?? workspaceId,
        ...(Array.isArray(record.parameter_observation_refs)
          ? {
            parameter_observation_refs: record.parameter_observation_refs.map(
              (value) => observationIdMap.get(value) ?? value,
            ),
          }
          : {}),
      };
    },
  },
]);

function backfillWorkspaceIdentity({
  catalogRoot,
  workspaceId,
  dryRun = false,
  includeStaging = true,
  validator = new EcitrValidator(),
} = {}) {
  if (!catalogRoot) {
    throw new Error("backfillWorkspaceIdentity requires a catalogRoot.");
  }
  if (!workspaceId) {
    throw new Error("backfillWorkspaceIdentity requires a workspaceId.");
  }

  const resolvedCatalogRoot = path.resolve(catalogRoot);
  const catalog = new FileBackedCatalog({ rootDir: resolvedCatalogRoot, validator });
  const catalogs = catalog.loadRuntimeCatalogs();
  const evidenceCorrectionIndex = buildEvidenceCorrectionIndex(catalogs.evidence ?? []);
  const evidenceIdMap = new Map();
  const transformedEvidence = getCurrentEvidenceRecords(catalogs.evidence ?? [])
    .filter((record) => !record.workspace_id)
    .map((record) => {
      const correction = {
        ...record,
        evidence_id: `${record.evidence_id}_workspace_${workspaceId}`,
        workspace_id: workspaceId,
        correction_of: record.evidence_id,
      };
      evidenceIdMap.set(record.evidence_id, correction.evidence_id);
      return correction;
    });
  const remapEvidenceId = (evidenceId) => evidenceIdMap.get(evidenceId)
    ?? resolveLatestEvidenceCorrection(evidenceCorrectionIndex, evidenceId)?.evidence_id
    ?? evidenceId;

  const definitionIdMap = new Map();
  const observationIdMap = new Map();
  const transformedDefinitions = dedupeRecords((catalogs.parameter_definitions ?? []).map((record) => {
    const nextWorkspaceId = record.workspace_id ?? workspaceId;
    const nextDefinitionId = createDefinitionId({
      workspaceId: nextWorkspaceId,
      observedKey: record.observed_key,
    });
    definitionIdMap.set(record.definition_id, nextDefinitionId);
    return {
      ...record,
      definition_id: nextDefinitionId,
      workspace_id: nextWorkspaceId,
      first_source_evidence_ref: remapEvidenceId(record.first_source_evidence_ref),
    };
  }), "definition_id");

  const transformedObservations = dedupeRecords((catalogs.parameter_observations ?? []).map((record) => {
    const nextWorkspaceId = record.workspace_id ?? workspaceId;
    const nextSourceEvidenceRefs = record.source_evidence_refs.map(remapEvidenceId);
    const nextObservationId = createObservationId({
      workspaceId: nextWorkspaceId,
      parameterKey: record.parameter_key,
      observationKind: record.observation_kind,
      observedAt: record.observed_at,
      sourceEvidenceRefs: nextSourceEvidenceRefs,
      sourceSpans: record.source_spans,
      rawValueText: record.raw_value_text,
    });
    observationIdMap.set(record.observation_id, nextObservationId);
    return {
      ...record,
      observation_id: nextObservationId,
      workspace_id: nextWorkspaceId,
      definition_id: definitionIdMap.get(record.definition_id) ?? record.definition_id,
      source_evidence_refs: nextSourceEvidenceRefs,
    };
  }).map((record) => ({
    ...record,
    ...(record.supersedes
      ? { supersedes: observationIdMap.get(record.supersedes) ?? record.supersedes }
      : {}),
  })), "observation_id");

  const transformed = {
    evidence: transformedEvidence,
    case: (catalogs.cases ?? []).map((record) => ({
      ...record,
      workspace_id: record.workspace_id ?? workspaceId,
      ...(Array.isArray(record.parameter_observation_refs)
        ? {
          parameter_observation_refs: record.parameter_observation_refs.map(
            (value) => observationIdMap.get(value) ?? value,
          ),
        }
        : {}),
    })),
    invariant: (catalogs.invariants ?? []).map((record) => ({
      ...record,
      workspace_id: record.workspace_id ?? workspaceId,
    })),
    tactic: (catalogs.tactics ?? []).map((record) => ({
      ...record,
      workspace_id: record.workspace_id ?? workspaceId,
      ...(Array.isArray(record.parameter_observation_refs)
        ? {
          parameter_observation_refs: record.parameter_observation_refs.map(
            (value) => observationIdMap.get(value) ?? value,
          ),
        }
        : {}),
    })),
    parameter_definition: transformedDefinitions,
    parameter_observation: transformedObservations,
  };

  for (const record of transformed.evidence) validator.validateRecord("evidence", record);
  for (const record of transformed.case) validator.validateRecord("case", record);
  for (const record of transformed.invariant) validator.validateRecord("invariant", record);
  for (const record of transformed.tactic) validator.validateRecord("tactic", record);
  for (const record of transformed.parameter_definition) validator.validateRecord("parameter_definition", record);
  for (const record of transformed.parameter_observation) validator.validateRecord("parameter_observation", record);

  const summary = {
    dry_run: dryRun,
    catalog_root: resolvedCatalogRoot,
    workspace_id: workspaceId,
    record_counts: {
      evidence: transformed.evidence.length,
      cases: transformed.case.length,
      invariants: transformed.invariant.length,
      tactics: transformed.tactic.length,
      parameter_definitions: transformed.parameter_definition.length,
      parameter_observations: transformed.parameter_observation.length,
    },
    evidence_corrections: countMissingTargetIds({
      catalog,
      recordType: "evidence",
      records: transformed.evidence,
      idKey: "evidence_id",
    }),
    parameter_definition_renames: countMissingTargetIds({
      catalog,
      recordType: "parameter_definition",
      records: transformed.parameter_definition,
      idKey: "definition_id",
    }),
    parameter_observation_renames: countMissingTargetIds({
      catalog,
      recordType: "parameter_observation",
      records: transformed.parameter_observation,
      idKey: "observation_id",
    }),
    staging_packets_updated: 0,
  };

  if (dryRun) {
    if (includeStaging) {
      summary.staging_packets_updated = countStagingPackets({ catalogRoot: resolvedCatalogRoot });
    }
    return summary;
  }

  writeRecords({ catalog, recordType: "evidence", previous: catalogs.evidence ?? [], next: transformed.evidence });
  writeRecords({ catalog, recordType: "case", previous: catalogs.cases ?? [], next: transformed.case });
  writeRecords({ catalog, recordType: "invariant", previous: catalogs.invariants ?? [], next: transformed.invariant });
  writeRecords({ catalog, recordType: "tactic", previous: catalogs.tactics ?? [], next: transformed.tactic });
  writeRecords({
    catalog,
    recordType: "parameter_definition",
    previous: catalogs.parameter_definitions ?? [],
    next: transformed.parameter_definition,
  });
  writeRecords({
    catalog,
    recordType: "parameter_observation",
    previous: catalogs.parameter_observations ?? [],
    next: transformed.parameter_observation,
  });

  if (includeStaging) {
    summary.staging_packets_updated = rewriteStagingPackets({
      catalogRoot: resolvedCatalogRoot,
      workspaceId,
      observationIdMap,
      validator,
    });
  }

  return summary;
}

function writeRecords({ catalog, recordType, next }) {
  const idKey = getIdKey(recordType);

  for (const record of next) {
    const existing = catalog.getRecord(recordType, record[idKey]);
    if (existing && JSON.stringify(existing) === JSON.stringify(record)) {
      continue;
    }
    if (existing && recordType === "evidence") {
      throw new Error(`Evidence backfill correction conflict: ${record[idKey]}`);
    }
    catalog.writeRecord(recordType, record, { overwrite: Boolean(existing) });
  }
}

function rewriteStagingPackets({ catalogRoot, workspaceId, observationIdMap, validator }) {
  let updated = 0;

  for (const definition of STAGING_PACKET_DEFINITIONS) {
    const directory = path.join(catalogRoot, definition.directory);
    if (!fs.existsSync(directory)) {
      continue;
    }

    for (const entry of fs.readdirSync(directory).filter((value) => value.endsWith(".json")).sort()) {
      const filePath = path.join(directory, entry);
      const next = definition.transform(readJson(filePath), {
        workspaceId,
        observationIdMap,
      });
      validator.validateRecord(definition.schemaKey, next);
      fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      updated += 1;
    }
  }

  return updated;
}

function countStagingPackets({ catalogRoot }) {
  let total = 0;
  for (const definition of STAGING_PACKET_DEFINITIONS) {
    const directory = path.join(catalogRoot, definition.directory);
    if (!fs.existsSync(directory)) {
      continue;
    }

    total += fs.readdirSync(directory).filter((value) => value.endsWith(".json")).length;
  }
  return total;
}

function countMissingTargetIds({ catalog, recordType, records, idKey }) {
  return records.filter((record) => !catalog.getRecord(recordType, record[idKey])).length;
}

function dedupeRecords(records, idKey) {
  const byId = new Map();
  for (const record of records) {
    const existing = byId.get(record[idKey]);
    if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
      throw new Error(`Workspace backfill produced conflicting ${idKey}: ${record[idKey]}`);
    }
    byId.set(record[idKey], record);
  }
  return [...byId.values()];
}

function getIdKey(recordType) {
  switch (recordType) {
    case "evidence":
      return "evidence_id";
    case "case":
      return "case_id";
    case "invariant":
    case "tactic":
      return "id";
    case "parameter_definition":
      return "definition_id";
    case "parameter_observation":
      return "observation_id";
    default:
      throw new Error(`Unsupported workspace backfill record type: ${recordType}`);
  }
}

module.exports = {
  backfillWorkspaceIdentity,
};
