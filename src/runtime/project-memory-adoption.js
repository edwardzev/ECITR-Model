const path = require("node:path");
const { deduplicateArtifacts, summarizeTelemetryArtifacts } = require("./project-memory-telemetry-report");

const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const {
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
    const loadedArtifacts = artifactRoots.flatMap((artifactRoot) =>
      loadMemoryInvocationArtifacts({ artifactRoot, since, until }));
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
  const allArtifacts = workspaces.flatMap((entry) => entry._artifacts);
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
      .filter((entry) => entry.recorded_invocations === 0)
      .map((entry) => entry.workspace_id),
    totals: withoutArtifacts(totals),
    workspaces: workspaces.map(withoutArtifacts),
  };
}

function summarizeArtifacts(artifacts) {
  return { ...summarizeTelemetryArtifacts(artifacts), _artifacts: artifacts };
}

function buildArtifactRoots({ project, catalogRoot }) {
  return [...new Set([
    ...project.workspace_roots.map((workspaceRoot) =>
      path.join(path.resolve(workspaceRoot), ".local", "memory-invocations")),
    path.join(path.resolve(catalogRoot), "_memory-invocations", project.id),
  ])].sort();
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

module.exports = {
  buildArtifactRoots,
  deduplicateArtifacts,
  summarizeArtifacts,
  summarizeRegisteredMemoryAdoption,
};
