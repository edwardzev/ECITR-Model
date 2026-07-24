const path = require("node:path");

const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const { getCurrentEvidenceRecords } = require("../evidence/corrections");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { EcitrValidator } = require("../validation/validator");
const {
  createDefinitionId,
  createObservationId,
  inferValueType,
  normalizeParameterKey,
  recordsEqual,
} = require("./common");
const { distillParameterEntries } = require("./distillers");

function refreshParameters({
  catalogRoot = DEFAULT_CATALOG_ROOT,
  dryRun = false,
  validator = new EcitrValidator(),
  catalog = new FileBackedCatalog({ rootDir: catalogRoot, validator }),
  extractedBy = "parameter-distiller",
  extractedAt = null,
} = {}) {
  const summary = {
    dry_run: dryRun,
    catalog_root: path.resolve(catalogRoot),
    scanned_evidence: 0,
    supported_evidence: 0,
    skipped_unsupported: 0,
    definitions_written: 0,
    observations_written: 0,
    skipped_existing_definitions: 0,
    skipped_existing_observations: 0,
    repairs_planned: 0,
    repairs_written: 0,
    benign_conflicts: 0,
    conflicts: 0,
    errors: 0,
    repair_details: [],
    benign_conflict_details: [],
    conflict_details: [],
    error_details: [],
  };

  const currentEvidenceRecords = getCurrentEvidenceRecords(catalog.listRecords("evidence"));
  for (const evidenceRecord of currentEvidenceRecords) {
    summary.scanned_evidence += 1;

    try {
      const result = distillParameterEntries({
        evidenceRecord,
        catalogRoot,
        extractedAt: extractedAt ?? evidenceRecord.captured_at,
        extractedBy,
      });

      if (!result.supported) {
        summary.skipped_unsupported += 1;
        continue;
      }

      summary.supported_evidence += 1;
      const materialized = materializeObservations({
        entries: result.entries,
        evidenceRecord,
      });

      for (const definition of materialized.definitions) {
        const existingDefinition = catalog.getRecord("parameter_definition", definition.definition_id);
        if (existingDefinition) {
          const conflict = classifyDefinitionConflict(existingDefinition, definition);
          if (conflict.kind === "material_conflict") {
            summary.conflicts += 1;
            summary.conflict_details.push({
              record_type: "parameter_definition",
              record_id: definition.definition_id,
              evidence_id: evidenceRecord.evidence_id,
              reason: conflict.reason,
              differing_fields: conflict.differing_fields,
            });
            continue;
          }

          if (conflict.kind === "repairable_legacy_mismatch") {
            if (!dryRun) {
              catalog.writeRecord("parameter_definition", conflict.next_record, { overwrite: true });
              summary.repairs_written += 1;
            } else {
              summary.repairs_planned += 1;
            }
            summary.repair_details.push({
              record_type: "parameter_definition",
              record_id: definition.definition_id,
              evidence_id: evidenceRecord.evidence_id,
              reason: conflict.reason,
              differing_fields: conflict.differing_fields,
            });
            continue;
          }

          if (conflict.kind === "benign_duplicate") {
            summary.benign_conflicts += 1;
            summary.benign_conflict_details.push({
              record_type: "parameter_definition",
              record_id: definition.definition_id,
              evidence_id: evidenceRecord.evidence_id,
              reason: conflict.reason,
              differing_fields: conflict.differing_fields,
            });
            continue;
          }

          summary.skipped_existing_definitions += 1;
          continue;
        }

        if (!dryRun) {
          catalog.writeRecord("parameter_definition", definition);
        }
        summary.definitions_written += 1;
      }

      for (const observation of materialized.observations) {
        const existingObservation = catalog.getRecord("parameter_observation", observation.observation_id);
        if (existingObservation) {
          const conflict = classifyObservationConflict(existingObservation, observation);
          if (conflict.kind === "material_conflict") {
            summary.conflicts += 1;
            summary.conflict_details.push({
              record_type: "parameter_observation",
              record_id: observation.observation_id,
              evidence_id: evidenceRecord.evidence_id,
              reason: conflict.reason,
              differing_fields: conflict.differing_fields,
            });
            continue;
          }

          if (conflict.kind === "benign_duplicate") {
            summary.benign_conflicts += 1;
            summary.benign_conflict_details.push({
              record_type: "parameter_observation",
              record_id: observation.observation_id,
              evidence_id: evidenceRecord.evidence_id,
              reason: conflict.reason,
              differing_fields: conflict.differing_fields,
            });
            continue;
          }

          summary.skipped_existing_observations += 1;
          continue;
        }

        if (!dryRun) {
          catalog.writeRecord("parameter_observation", observation);
        }
        summary.observations_written += 1;
      }
    } catch (error) {
      summary.errors += 1;
      summary.error_details.push({
        evidence_id: evidenceRecord.evidence_id,
        message: error.message,
      });
    }
  }

  return summary;
}

const DEFINITION_MATERIAL_FIELDS = Object.freeze([
  "definition_id",
  "workspace_id",
  "observed_key",
  "normalized_key",
  "units",
]);

const OBSERVATION_MATERIAL_FIELDS = Object.freeze([
  "observation_id",
  "workspace_id",
  "definition_id",
  "parameter_key",
  "raw_value_text",
  "value_type",
  "value_json",
  "observation_kind",
  "observed_at",
  "project_scope",
  "source_evidence_refs",
  "source_spans",
  "units",
  "tool_binding",
  "environment_bounds",
  "valid_from",
  "valid_to",
  "supersedes",
]);

function classifyDefinitionConflict(existingRecord, nextRecord) {
  if (recordsEqual(existingRecord, nextRecord)) {
    return { kind: "exact" };
  }

  const differingFields = getDifferingFields(existingRecord, nextRecord, DEFINITION_MATERIAL_FIELDS);
  if (isRepairableDefinitionWorkspaceMismatch(existingRecord, nextRecord, differingFields)) {
    return {
      kind: "repairable_legacy_mismatch",
      reason: "parameter definition workspace_id differs from the workspace encoded by its stable id",
      differing_fields: differingFields,
      next_record: {
        ...existingRecord,
        workspace_id: nextRecord.workspace_id,
      },
    };
  }

  if (differingFields.length > 0) {
    return {
      kind: "material_conflict",
      reason: "parameter definition material fields differ",
      differing_fields: differingFields,
    };
  }

  const nonMaterialDifferingFields = getDifferingFields(existingRecord, nextRecord, Object.keys({
    ...existingRecord,
    ...nextRecord,
  }));
  if (nonMaterialDifferingFields.length === 0) {
    return { kind: "exact" };
  }

  return {
    kind: "benign_duplicate",
    reason: "parameter definition differs only in non-authoritative descriptor metadata",
    differing_fields: nonMaterialDifferingFields,
  };
}

function isRepairableDefinitionWorkspaceMismatch(existingRecord, nextRecord, differingFields) {
  if (differingFields.length !== 1 || differingFields[0] !== "workspace_id") {
    return false;
  }
  if (!nextRecord.workspace_id || existingRecord.observed_key !== nextRecord.observed_key) {
    return false;
  }

  const nextId = createDefinitionId({
    workspaceId: nextRecord.workspace_id,
    observedKey: nextRecord.observed_key,
  });
  if (nextId !== nextRecord.definition_id) {
    return false;
  }

  if (!existingRecord.workspace_id) {
    return true;
  }

  const existingWorkspaceId = createDefinitionId({
    workspaceId: existingRecord.workspace_id,
    observedKey: existingRecord.observed_key,
  });
  return existingWorkspaceId !== existingRecord.definition_id;
}

function classifyObservationConflict(existingRecord, nextRecord) {
  if (recordsEqual(existingRecord, nextRecord)) {
    return { kind: "exact" };
  }

  const differingFields = getDifferingFields(existingRecord, nextRecord, OBSERVATION_MATERIAL_FIELDS);
  if (differingFields.length > 0) {
    return {
      kind: "material_conflict",
      reason: "parameter observation material fields differ",
      differing_fields: differingFields,
    };
  }

  const nonMaterialDifferingFields = getDifferingFields(existingRecord, nextRecord, Object.keys({
    ...existingRecord,
    ...nextRecord,
  }));
  if (nonMaterialDifferingFields.length === 0) {
    return { kind: "exact" };
  }

  return {
    kind: "benign_duplicate",
    reason: "parameter observation differs only in extraction metadata",
    differing_fields: nonMaterialDifferingFields,
  };
}

function getDifferingFields(left, right, fields) {
  return fields.filter((field) => !valuesEqual(left?.[field], right?.[field]));
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function materializeObservations({ entries, evidenceRecord }) {
  const definitionsById = new Map();
  const observations = [];

  for (const entry of entries) {
    const definitionId = createDefinitionId({
      workspaceId: entry.workspace_id ?? evidenceRecord.workspace_id ?? null,
      observedKey: entry.parameter_key,
    });
    if (!definitionsById.has(definitionId)) {
      const effectiveWorkspaceId = entry.workspace_id ?? evidenceRecord.workspace_id ?? null;
      definitionsById.set(definitionId, {
        definition_id: definitionId,
        ...(effectiveWorkspaceId ? { workspace_id: effectiveWorkspaceId } : {}),
        observed_key: entry.parameter_key,
        normalized_key: normalizeParameterKey(entry.parameter_key),
        value_type: inferDefinitionValueType(entry.value_type),
        created_at: entry.extracted_at,
        first_observed_at: entry.observed_at,
        first_source_evidence_ref: evidenceRecord.evidence_id,
        ...(entry.units ? { units: entry.units } : {}),
      });
    }

    const effectiveWorkspaceId = entry.workspace_id ?? evidenceRecord.workspace_id ?? null;
    const observation = {
      observation_id: createObservationId({
        workspaceId: effectiveWorkspaceId,
        parameterKey: entry.parameter_key,
        observationKind: entry.observation_kind,
        observedAt: entry.observed_at,
        sourceEvidenceRefs: entry.source_evidence_refs,
        sourceSpans: entry.source_spans,
        rawValueText: entry.raw_value_text,
      }),
      definition_id: definitionId,
      ...(effectiveWorkspaceId ? { workspace_id: effectiveWorkspaceId } : {}),
      parameter_key: entry.parameter_key,
      raw_value_text: entry.raw_value_text,
      value_type: entry.value_type,
      value_json: entry.value_json,
      observation_kind: entry.observation_kind,
      observed_at: entry.observed_at,
      project_scope: entry.project_scope,
      source_evidence_refs: entry.source_evidence_refs,
      source_spans: entry.source_spans,
      strategy_id: entry.strategy_id,
      extracted_at: entry.extracted_at,
      extracted_by: entry.extracted_by,
      confidence: entry.confidence,
    };

    assignOptional(observation, "units", entry.units);
    assignOptional(observation, "tool_binding", entry.tool_binding);
    assignOptional(observation, "environment_bounds", entry.environment_bounds);
    assignOptional(observation, "valid_from", entry.valid_from);
    assignOptional(observation, "valid_to", entry.valid_to);

    observations.push(observation);
  }

  const supersedesByEntry = new Map();
  const grouped = new Map();
  for (const [index, entry] of entries.entries()) {
    if (!grouped.has(entry.parameter_key)) {
      grouped.set(entry.parameter_key, []);
    }
    grouped.get(entry.parameter_key).push({ index, entry });
  }

  for (const group of grouped.values()) {
    group.sort((left, right) =>
      left.entry.source_spans[0].start_line - right.entry.source_spans[0].start_line
      || left.entry.source_spans[0].start_char - right.entry.source_spans[0].start_char);

    for (let index = 1; index < group.length; index += 1) {
      supersedesByEntry.set(group[index].index, observations[group[index - 1].index].observation_id);
    }
  }

  observations.forEach((observation, index) => {
    if (supersedesByEntry.has(index)) {
      observation.supersedes = supersedesByEntry.get(index);
    }
  });

  return {
    definitions: [...definitionsById.values()],
    observations,
  };
}

function inferDefinitionValueType(valueType) {
  return inferValueTypeName(valueType) ?? "unknown";
}

function inferValueTypeName(valueType) {
  return ["string", "number", "boolean", "null", "object", "array", "unknown"].includes(valueType)
    ? valueType
    : null;
}

function assignOptional(target, key, value) {
  if (value === undefined || value === null) {
    return;
  }

  if (Array.isArray(value) && value.length === 0) {
    return;
  }

  target[key] = value;
}

module.exports = {
  refreshParameters,
  materializeObservations,
};
