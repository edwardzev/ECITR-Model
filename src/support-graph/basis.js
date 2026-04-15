const crypto = require("node:crypto");

function createSupportGraphBasisHash(catalogs = {}) {
  const projected = {
    evidence: projectEvidence(catalogs.evidence ?? []),
    cases: projectCases(catalogs.cases ?? []),
    invariants: projectInvariants(catalogs.invariants ?? []),
    tactics: projectTactics(catalogs.tactics ?? []),
    atomic_claim_sets: projectAtomicClaimSets(catalogs.atomic_claim_sets ?? []),
    parameter_definitions: projectParameterDefinitions(catalogs.parameter_definitions ?? []),
    parameter_observations: projectParameterObservations(catalogs.parameter_observations ?? []),
  };

  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(projected)).digest("hex")}`;
}

function projectEvidence(records) {
  return [...records]
    .map((record) => ({
      evidence_id: record.evidence_id,
      project_scope: record.project_scope ?? "global",
      parent_evidence_id: record.parent_evidence_id ?? null,
      correction_of: record.correction_of ?? null,
      source_locator: record.source_locator ?? null,
    }))
    .sort(compareById("evidence_id"));
}

function projectCases(records) {
  return [...records]
    .map((record) => ({
      case_id: record.case_id,
      status: record.status ?? null,
      review_state: record.review_state ?? null,
      project_scope: record.context?.project_scope ?? "global",
      evidence_refs: sortStrings(record.evidence_refs),
      parameter_observation_refs: sortStrings(record.parameter_observation_refs),
      derived_from_case_id: record.derived_from_case_id ?? null,
      supersedes_case_id: record.supersedes_case_id ?? null,
    }))
    .sort(compareById("case_id"));
}

function projectInvariants(records) {
  return [...records]
    .map((record) => ({
      id: record.id,
      status: record.status ?? null,
      source_case_refs: sortStrings(record.source_case_refs),
      evidence_refs: sortStrings(record.evidence_refs),
      supersedes: record.supersedes ?? null,
    }))
    .sort(compareById("id"));
}

function projectTactics(records) {
  return [...records]
    .map((record) => ({
      id: record.id,
      status: record.status ?? null,
      source_case_refs: sortStrings(record.source_case_refs),
      supporting_invariant_refs: sortStrings(record.supporting_invariant_refs),
      evidence_refs: sortStrings(record.evidence_refs),
      parameter_observation_refs: sortStrings(record.parameter_observation_refs),
      supersedes: record.supersedes ?? null,
      expiry_at: record.expiry_at ?? null,
      revalidate_at: record.revalidate_at ?? null,
      invalidated_at: record.invalidated_at ?? null,
    }))
    .sort(compareById("id"));
}

function projectAtomicClaimSets(records) {
  return [...records]
    .map((record) => ({
      claim_set_id: record.claim_set_id,
      evidence_id: record.evidence_id,
    }))
    .sort(compareById("claim_set_id"));
}

function projectParameterDefinitions(records) {
  return [...records]
    .map((record) => ({
      definition_id: record.definition_id,
      observed_key: record.observed_key,
      normalized_key: record.normalized_key,
      first_source_evidence_ref: record.first_source_evidence_ref ?? null,
    }))
    .sort(compareById("definition_id"));
}

function projectParameterObservations(records) {
  return [...records]
    .map((record) => ({
      observation_id: record.observation_id,
      definition_id: record.definition_id,
      project_scope: record.project_scope ?? "global",
      source_evidence_refs: sortStrings(record.source_evidence_refs),
    }))
    .sort(compareById("observation_id"));
}

function sortStrings(values = []) {
  return [...(values ?? [])].map((value) => String(value)).sort();
}

function compareById(key) {
  return (left, right) => String(left[key]).localeCompare(String(right[key]));
}

module.exports = {
  createSupportGraphBasisHash,
};
