const fs = require("node:fs");
const path = require("node:path");

const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { EcitrValidator, readJson } = require("../validation/validator");
const { createDefinitionId, createObservationId } = require("../parameters/common");

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

  const definitionIdMap = new Map();
  const observationIdMap = new Map();
  const transformedDefinitions = (catalogs.parameter_definitions ?? []).map((record) => {
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
    };
  });

  const transformedObservations = (catalogs.parameter_observations ?? []).map((record) => {
    const nextWorkspaceId = record.workspace_id ?? workspaceId;
    const nextObservationId = createObservationId({
      workspaceId: nextWorkspaceId,
      parameterKey: record.parameter_key,
      observationKind: record.observation_kind,
      observedAt: record.observed_at,
      sourceEvidenceRefs: record.source_evidence_refs,
      sourceSpans: record.source_spans,
      rawValueText: record.raw_value_text,
    });
    observationIdMap.set(record.observation_id, nextObservationId);
    return {
      ...record,
      observation_id: nextObservationId,
      workspace_id: nextWorkspaceId,
      definition_id: definitionIdMap.get(record.definition_id) ?? record.definition_id,
    };
  }).map((record) => ({
    ...record,
    ...(record.supersedes
      ? { supersedes: observationIdMap.get(record.supersedes) ?? record.supersedes }
      : {}),
  }));

  const transformed = {
    evidence: (catalogs.evidence ?? []).map((record) => ({
      ...record,
      workspace_id: record.workspace_id ?? workspaceId,
    })),
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
    parameter_definition_renames: countChangedIds(catalogs.parameter_definitions ?? [], transformed.parameter_definition, "definition_id"),
    parameter_observation_renames: countChangedIds(catalogs.parameter_observations ?? [], transformed.parameter_observation, "observation_id"),
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

function writeRecords({ catalog, recordType, previous, next }) {
  const idKey = getIdKey(recordType);

  for (const record of next) {
    const filePath = catalog.getRecordPath(recordType, record[idKey]);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  for (const previousRecord of previous) {
    const nextRecord = next.find((candidate) => candidate[idKey] === previousRecord[idKey]);
    if (nextRecord) {
      continue;
    }

    const nextId = findNextIdForPrevious({ previousRecord, next, recordType });
    if (!nextId || nextId === previousRecord[idKey]) {
      continue;
    }

    const previousPath = catalog.getRecordPath(recordType, previousRecord[idKey]);
    if (fs.existsSync(previousPath)) {
      fs.unlinkSync(previousPath);
    }
  }

  return;
}

function findNextIdForPrevious({ previousRecord, next, recordType }) {
  switch (recordType) {
    case "parameter_definition":
      return next.find((record) => record.observed_key === previousRecord.observed_key)?.definition_id ?? null;
    case "parameter_observation":
      return next.find((record) =>
        record.parameter_key === previousRecord.parameter_key
        && record.observed_at === previousRecord.observed_at
        && record.raw_value_text === previousRecord.raw_value_text)?.observation_id ?? null;
    default:
      return previousRecord[getIdKey(recordType)];
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

function countChangedIds(previous, next, idKey) {
  const nextBySignature = new Map(next.map((record) => [signatureFor(record, idKey), record[idKey]]));
  return previous.reduce((count, record) =>
    count + (nextBySignature.get(signatureFor(record, idKey)) !== record[idKey] ? 1 : 0), 0);
}

function signatureFor(record, idKey) {
  if (idKey === "definition_id") {
    return `definition:${record.observed_key}`;
  }

  return `observation:${record.parameter_key}:${record.observed_at}:${record.raw_value_text}`;
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
