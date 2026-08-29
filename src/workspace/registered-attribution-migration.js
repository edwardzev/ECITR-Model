const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const {
  applyWorkspaceIdentityMigration,
  planWorkspaceIdentityBySource,
  preflightWorkspaceIdentityMigration,
  summarizeMigrationPlan,
} = require("./selective-migration");
const { loadWorkspaceSourceMap } = require("./source-mapping");

function migrateRegisteredWorkspaceAttribution({
  catalogRoot,
  workspaceIds = [],
  dryRun = true,
  includeStaging = true,
  sourceMap = loadWorkspaceSourceMap(),
  plannedAt = new Date().toISOString(),
  createdBy = "registered-workspace-attribution-migrator-v1",
} = {}) {
  if (!catalogRoot) {
    throw new Error("migrateRegisteredWorkspaceAttribution requires a catalogRoot.");
  }
  if (sourceMap.agent_ops_registry_path && sourceMap.agent_ops_registry_available === false) {
    throw new Error(
      `Configured agent-ops project registry is unavailable: ${sourceMap.agent_ops_registry_path}`,
    );
  }

  const availableWorkspaceIds = collectConfiguredWorkspaceIds(sourceMap);
  const selectableWorkspaceIds = collectConfiguredWorkspaceIds(sourceMap, {
    includeInactiveRegistry: true,
  });
  const selectedWorkspaceIds = workspaceIds.length > 0
    ? [...new Set(workspaceIds)].sort()
    : availableWorkspaceIds;
  const unknown = selectedWorkspaceIds.filter((workspaceId) =>
    !selectableWorkspaceIds.includes(workspaceId));
  if (unknown.length > 0) {
    throw new Error(`Workspace attribution selectors are not configured for: ${unknown.join(", ")}`);
  }

  const catalog = new FileBackedCatalog({ rootDir: catalogRoot });
  const runtimeCatalogs = catalog.loadRuntimeCatalogs();
  const payloadCache = new Map();
  const attributionCache = new Map();
  const plans = selectedWorkspaceIds.map((targetWorkspaceId) =>
    planWorkspaceIdentityBySource({
      catalogRoot,
      targetWorkspaceId,
      includeStaging,
      sourceMap,
      plannedAt,
      createdBy,
      catalogInstance: catalog,
      runtimeCatalogs,
      payloadCache,
      attributionCache,
    }));
  assertDisjointMigrationTargets(plans);

  if (!dryRun) {
    for (const plan of plans) {
      preflightWorkspaceIdentityMigration({
        catalogRoot: plan.catalogRoot,
        manifest: plan.manifest,
        catalogInstance: catalog,
      });
    }
  }

  const results = plans.map((plan) => {
    if (dryRun) {
      return summarizeMigrationPlan(plan, { dryRun: true });
    }
    if (plan.manifest.operations.length === 0) {
      return {
        ...summarizeMigrationPlan(plan, { dryRun: false }),
        status: plan.manifest.blockers.length > 0 ? "blocked_no_changes" : "no_changes",
      };
    }
    const manifest = applyWorkspaceIdentityMigration({
      catalogRoot: plan.catalogRoot,
      manifest: plan.manifest,
      appliedAt: plannedAt,
      catalogInstance: catalog,
    });
    return summarizeMigrationPlan({ ...plan, manifest }, { dryRun: false });
  });

  return {
    dry_run: dryRun,
    catalog_root: results[0]?.catalog_root ?? catalogRoot,
    planned_at: plannedAt,
    workspace_count: results.length,
    totals: summarizeResults(results),
    workspaces: results,
  };
}

function assertDisjointMigrationTargets(plans) {
  const ownerByTarget = new Map();
  for (const plan of plans) {
    for (const operation of plan.manifest.operations) {
      const target = operation.file_path
        ? `file:${operation.file_path}`
        : `${operation.record_type}:${operation.target_record_id}`;
      const existingOwner = ownerByTarget.get(target);
      if (existingOwner && existingOwner !== plan.manifest.target_workspace_id) {
        throw new Error(
          `Workspace attribution target ${target} was claimed by both ${existingOwner} and ${plan.manifest.target_workspace_id}.`,
        );
      }
      ownerByTarget.set(target, plan.manifest.target_workspace_id);
    }
  }
}

function collectConfiguredWorkspaceIds(sourceMap, { includeInactiveRegistry = false } = {}) {
  const registryProjects = includeInactiveRegistry
    ? sourceMap.agent_ops_registry_all_projects ?? sourceMap.agent_ops_registry_projects
    : sourceMap.agent_ops_registry_projects;
  return [...new Set([
    ...sourceMap.agent_ops_projects.map((entry) => entry.workspace_id),
    ...sourceMap.codex_workspaces.map((entry) => entry.workspace_id),
    ...registryProjects.map((entry) => entry.id),
  ].filter(Boolean))].sort();
}

function summarizeResults(results) {
  const totals = {
    evidence: 0,
    cases: 0,
    invariants: 0,
    tactics: 0,
    parameter_definitions: 0,
    parameter_observations: 0,
    staging_packets: 0,
    blocked_records: 0,
  };
  for (const result of results) {
    for (const key of [
      "evidence",
      "cases",
      "invariants",
      "tactics",
      "parameter_definitions",
      "parameter_observations",
    ]) {
      totals[key] += result.updated_record_counts[key] ?? 0;
    }
    totals.staging_packets += result.staging_packets_updated ?? 0;
    totals.blocked_records += result.blocked_records ?? 0;
  }
  return totals;
}

module.exports = {
  assertDisjointMigrationTargets,
  collectConfiguredWorkspaceIds,
  migrateRegisteredWorkspaceAttribution,
};
