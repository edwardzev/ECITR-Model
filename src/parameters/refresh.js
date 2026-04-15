const path = require("node:path");

const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
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
    conflicts: 0,
    errors: 0,
    conflict_details: [],
    error_details: [],
  };

  for (const evidenceRecord of catalog.listRecords("evidence")) {
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
          if (!recordsEqual(existingDefinition, definition)) {
            summary.conflicts += 1;
            summary.conflict_details.push({
              record_type: "parameter_definition",
              record_id: definition.definition_id,
              evidence_id: evidenceRecord.evidence_id,
            });
          } else {
            summary.skipped_existing_definitions += 1;
          }
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
          if (!recordsEqual(existingObservation, observation)) {
            summary.conflicts += 1;
            summary.conflict_details.push({
              record_type: "parameter_observation",
              record_id: observation.observation_id,
              evidence_id: evidenceRecord.evidence_id,
            });
          } else {
            summary.skipped_existing_observations += 1;
          }
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

function materializeObservations({ entries, evidenceRecord }) {
  const definitionsById = new Map();
  const observations = [];

  for (const entry of entries) {
    const definitionId = createDefinitionId(entry.parameter_key);
    if (!definitionsById.has(definitionId)) {
      definitionsById.set(definitionId, {
        definition_id: definitionId,
        observed_key: entry.parameter_key,
        normalized_key: normalizeParameterKey(entry.parameter_key),
        value_type: inferDefinitionValueType(entry.value_type),
        created_at: entry.extracted_at,
        first_observed_at: entry.observed_at,
        first_source_evidence_ref: evidenceRecord.evidence_id,
        ...(entry.units ? { units: entry.units } : {}),
      });
    }

    const observation = {
      observation_id: createObservationId({
        parameterKey: entry.parameter_key,
        observationKind: entry.observation_kind,
        observedAt: entry.observed_at,
        sourceEvidenceRefs: entry.source_evidence_refs,
        sourceSpans: entry.source_spans,
        rawValueText: entry.raw_value_text,
      }),
      definition_id: definitionId,
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
