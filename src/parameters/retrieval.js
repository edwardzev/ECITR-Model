function buildParameterIndexes(catalogs = {}) {
  const definitionsById = new Map();
  const observationsById = new Map();
  const observationsByEvidenceId = new Map();
  const supersededObservationIds = new Set();

  for (const definition of catalogs.parameter_definitions ?? []) {
    definitionsById.set(definition.definition_id, definition);
  }

  for (const observation of catalogs.parameter_observations ?? []) {
    observationsById.set(observation.observation_id, observation);
    if (observation.supersedes) {
      supersededObservationIds.add(observation.supersedes);
    }

    for (const evidenceId of observation.source_evidence_refs ?? []) {
      if (!observationsByEvidenceId.has(evidenceId)) {
        observationsByEvidenceId.set(evidenceId, []);
      }
      observationsByEvidenceId.get(evidenceId).push(observation);
    }
  }

  return {
    definitionsById,
    observationsById,
    observationsByEvidenceId,
    supersededObservationIds,
  };
}

function getObservationsForRecord(layer, record, parameterIndexes) {
  if (!parameterIndexes) {
    return [];
  }

  if (layer === "evidence") {
    return filterVisibleObservations(
      parameterIndexes.observationsByEvidenceId.get(record.evidence_id) ?? [],
      parameterIndexes,
    );
  }

  if (layer === "cases" || layer === "tactics") {
    const refs = record.parameter_observation_refs ?? [];
    return filterVisibleObservations(
      refs
        .map((observationId) => parameterIndexes.observationsById.get(observationId))
        .filter(Boolean),
      parameterIndexes,
    );
  }

  return [];
}

function buildParameterSummaryForRecord(layer, record, parameterIndexes, { maxItems = 6 } = {}) {
  const observations = getObservationsForRecord(layer, record, parameterIndexes);
  return buildParameterSummary(observations, parameterIndexes, { maxItems });
}

function buildParameterSummary(observations, parameterIndexes, { maxItems = 6 } = {}) {
  const visible = filterVisibleObservations(observations, parameterIndexes).slice(0, maxItems);
  if (visible.length === 0) {
    return "";
  }

  return visible.map((observation) => formatObservation(observation, parameterIndexes)).join(" ");
}

function filterVisibleObservations(observations, parameterIndexes) {
  const superseded = parameterIndexes?.supersededObservationIds ?? new Set();
  return [...new Map(
    observations
      .filter(Boolean)
      .filter((observation) => !superseded.has(observation.observation_id))
      .map((observation) => [observation.observation_id, observation]),
  ).values()].sort((left, right) =>
    String(left.observed_at).localeCompare(String(right.observed_at))
      || String(left.parameter_key).localeCompare(String(right.parameter_key))
      || String(left.observation_id).localeCompare(String(right.observation_id)));
}

function formatObservation(observation, parameterIndexes) {
  const definition = parameterIndexes?.definitionsById.get(observation.definition_id);
  const normalizedKey = definition?.normalized_key;
  const keyLabel = normalizedKey && normalizedKey !== observation.parameter_key.toLowerCase()
    ? `${observation.parameter_key} (${normalizedKey})`
    : observation.parameter_key;

  if (observation.observation_kind === "unset") {
    return `Parameter ${keyLabel} unset.`;
  }

  const valueText = formatObservationValue(observation);
  return `Parameter ${keyLabel} = ${valueText}.`;
}

function formatObservationValue(observation) {
  const value = observation.value_json;
  if (typeof value === "string") {
    return value;
  }

  if (value === null) {
    return "null";
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

module.exports = {
  buildParameterIndexes,
  buildParameterSummary,
  buildParameterSummaryForRecord,
  getObservationsForRecord,
};
