const path = require("node:path");

const { loadEcitrProjectConfig } = require("./config");
const { resolveWorkspaceRootForWorkspaceId } = require("./source-mapping");

function resolveProjectMemoryConfig({
  workspaceRoot = null,
  workspaceId = null,
  catalogRoot,
} = {}) {
  const resolvedWorkspaceRoot = workspaceRoot
    ?? resolveWorkspaceRootForWorkspaceId({ workspaceId });
  if (resolvedWorkspaceRoot) {
    const loaded = loadEcitrProjectConfig({ startDir: resolvedWorkspaceRoot });
    if (loaded) {
      return {
        workspaceRoot: resolvedWorkspaceRoot,
        projectConfig: loaded,
        artifactRoot: undefined,
      };
    }
  }

  const resolvedWorkspaceId = workspaceId
    ?? loadEcitrProjectConfig({ startDir: resolvedWorkspaceRoot })?.workspace_id;
  if (!resolvedWorkspaceId) {
    throw new Error("Unable to resolve workspace configuration for project memory.");
  }

  const resolvedCatalogRoot = path.resolve(catalogRoot);
  return {
    workspaceRoot: resolvedWorkspaceRoot ?? null,
    projectConfig: {
      schema_version: 1,
      marker_path: null,
      workspace_root: resolvedWorkspaceRoot ?? resolvedCatalogRoot,
      catalog_root: resolvedCatalogRoot,
      workspace_id: resolvedWorkspaceId,
      default_project_scope: "project",
      preflight_retrieval_mandatory: false,
      failure_retry_retrieval_mandatory: false,
    },
    artifactRoot: path.join(
      resolvedCatalogRoot,
      "_memory-invocations",
      resolvedWorkspaceId,
    ),
  };
}

module.exports = {
  resolveProjectMemoryConfig,
};
