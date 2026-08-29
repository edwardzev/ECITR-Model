const path = require("node:path");

const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const {
  MEMORY_CONSULT_TRIGGERS,
  loadMemoryInvocationArtifacts,
} = require("./project-memory");
const { loadWorkspaceSourceMap } = require("../workspace/source-mapping");

function summarizeRegisteredMemoryAdoption({
  catalogRoot = DEFAULT_CATALOG_ROOT,
  sourceMap = loadWorkspaceSourceMap(),
  workspaceIds = [],
  since = null,
  until = null,
} = {}) {
  const projects = selectActiveProjects({ sourceMap, workspaceIds });
  const workspaces = projects.map((project) => {
    const artifactRoots = buildArtifactRoots({
      project,
      catalogRoot,
    });
    const loadedArtifacts = deduplicateArtifacts(artifactRoots.flatMap((artifactRoot) =>
      loadMemoryInvocationArtifacts({ artifactRoot, since, until })));
    const artifacts = loadedArtifacts.filter((artifact) => artifact.workspace_id === project.id);
    const attributionMismatches = loadedArtifacts.length - artifacts.length;
    return {
      workspace_id: project.id,
      workspace_roots: [...project.workspace_roots].sort(),
      artifact_roots: artifactRoots,
      ...summarizeArtifacts(artifacts),
      attribution_mismatch_count: attributionMismatches,
    };
  }).sort((left, right) => left.workspace_id.localeCompare(right.workspace_id));
  const allArtifacts = deduplicateArtifacts(workspaces.flatMap((entry) => entry._artifacts));
  const totals = {
    ...summarizeArtifacts(allArtifacts),
    attribution_mismatch_count: workspaces.reduce(
      (total, entry) => total + entry.attribution_mismatch_count,
      0,
    ),
  };

  return {
    generated_at: new Date().toISOString(),
    catalog_root: path.resolve(catalogRoot),
    since: since ? new Date(since).toISOString() : null,
    until: until ? new Date(until).toISOString() : null,
    workspace_count: workspaces.length,
    zero_opportunity_workspaces: workspaces
      .filter((entry) => entry.task_opportunities === 0)
      .map((entry) => entry.workspace_id),
    totals: withoutArtifacts(totals),
    workspaces: workspaces.map(withoutArtifacts),
  };
}

function summarizeArtifacts(artifacts) {
  const consulted = artifacts.filter((artifact) => artifact.memory_consulted);
  const usageRecorded = consulted.filter((artifact) => artifact.usage_recorded_at);
  const used = consulted.filter((artifact) => artifact.used_memory);
  const returnedRecordsByLayer = {
    tactics: 0,
    invariants: 0,
    cases: 0,
    evidence: 0,
  };
  for (const artifact of consulted) {
    for (const layer of Object.keys(returnedRecordsByLayer)) {
      returnedRecordsByLayer[layer] += Number(artifact.returned_counts?.[layer] ?? 0);
    }
  }

  return {
    task_opportunities: artifacts.length,
    consultations: consulted.length,
    consultation_rate: ratio(consulted.length, artifacts.length),
    consultations_by_trigger: Object.fromEntries(MEMORY_CONSULT_TRIGGERS.map((trigger) => [
      trigger,
      consulted.filter((artifact) => artifact.consult_trigger === trigger).length,
    ])),
    consultations_with_results: consulted.filter((artifact) =>
      Object.values(artifact.returned_counts ?? {}).some((count) => Number(count) > 0)).length,
    returned_records_by_layer: returnedRecordsByLayer,
    usage_callbacks: usageRecorded.length,
    usage_callback_rate: ratio(usageRecorded.length, consulted.length),
    used_memory: used.length,
    used_memory_rate: ratio(used.length, consulted.length),
    used_record_ids: normalizeUniqueStrings(used.flatMap((artifact) =>
      artifact.used_returned_record_ids ?? artifact.used_record_ids ?? [])),
    selected_record_ids: normalizeUniqueStrings(usageRecorded.flatMap((artifact) =>
      artifact.selected_record_ids ?? [])),
    _artifacts: artifacts,
  };
}

function buildArtifactRoots({ project, catalogRoot }) {
  return [...new Set([
    ...project.workspace_roots.map((workspaceRoot) =>
      path.join(path.resolve(workspaceRoot), ".local", "memory-invocations")),
    path.join(path.resolve(catalogRoot), "_memory-invocations", project.id),
  ])].sort();
}

function deduplicateArtifacts(artifacts) {
  const byInvocationId = new Map();
  for (const artifact of artifacts) {
    const key = `${artifact.workspace_id ?? "unknown"}:${artifact.invocation_id ?? "missing"}`;
    const current = byInvocationId.get(key);
    if (!current || (!current.usage_recorded_at && artifact.usage_recorded_at)) {
      byInvocationId.set(key, artifact);
    }
  }
  return [...byInvocationId.values()].sort((left, right) =>
    String(left.consulted_at).localeCompare(String(right.consulted_at))
      || String(left.invocation_id).localeCompare(String(right.invocation_id)));
}

function selectActiveProjects({ sourceMap, workspaceIds }) {
  const projects = sourceMap.agent_ops_registry_projects ?? [];
  const available = new Set(projects.map((entry) => entry.id));
  const selected = workspaceIds.length > 0 ? new Set(workspaceIds) : available;
  const unknown = [...selected].filter((entry) => !available.has(entry)).sort();
  if (unknown.length > 0) {
    throw new Error(`Active workspace selectors are not registered: ${unknown.join(", ")}`);
  }
  return projects.filter((entry) => selected.has(entry.id));
}

function withoutArtifacts(value) {
  const { _artifacts, ...rest } = value;
  return rest;
}

function normalizeUniqueStrings(values) {
  return [...new Set(values.map((value) => String(value)).filter(Boolean))].sort();
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));
}

module.exports = {
  buildArtifactRoots,
  deduplicateArtifacts,
  summarizeArtifacts,
  summarizeRegisteredMemoryAdoption,
};
