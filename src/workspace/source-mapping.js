const fs = require("node:fs");
const path = require("node:path");

const { REPO_ROOT } = require("../validation/schema-registry");
const { loadEcitrProjectConfig, resolveWorkspaceId } = require("./config");

const DEFAULT_SOURCE_MAP_PATH = path.join(REPO_ROOT, "config", "workspace-source-map.json");

function loadWorkspaceSourceMap({ filePath = DEFAULT_SOURCE_MAP_PATH } = {}) {
  const resolvedFilePath = path.resolve(filePath);
  if (!fs.existsSync(resolvedFilePath)) {
    return {
      schema_version: 1,
      agent_ops_projects: [],
      codex_workspaces: [],
      file_path: resolvedFilePath,
    };
  }

  const parsed = JSON.parse(fs.readFileSync(resolvedFilePath, "utf8"));
  return {
    schema_version: parsed.schema_version ?? 1,
    agent_ops_projects: normalizeAgentOpsProjects(parsed.agent_ops_projects),
    codex_workspaces: normalizeCodexWorkspaces(parsed.codex_workspaces),
    file_path: resolvedFilePath,
  };
}

function resolveWorkspaceIdForAgentOps({
  projectId,
  workspaceId = null,
  catalogRoot = null,
  sourceMap = loadWorkspaceSourceMap(),
} = {}) {
  const explicit = normalizeWorkspaceId(workspaceId);
  if (explicit) {
    return explicit;
  }

  const mapped = sourceMap.agent_ops_projects.find((entry) => entry.project_id === projectId);
  if (mapped?.workspace_id) {
    return mapped.workspace_id;
  }

  return resolveWorkspaceId({ workspaceId, catalogRoot });
}

function resolveWorkspaceIdForCodex({
  cwd,
  workspaceId = null,
  catalogRoot = null,
  sourceMap = loadWorkspaceSourceMap(),
} = {}) {
  const explicit = normalizeWorkspaceId(workspaceId);
  if (explicit) {
    return explicit;
  }

  const markerConfig = loadWorkspaceConfigForCwd({ cwd, catalogRoot });
  if (markerConfig?.workspace_id) {
    return markerConfig.workspace_id;
  }

  const mapped = findCodexWorkspaceMapping({ cwd, codexWorkspaces: sourceMap.codex_workspaces });
  if (mapped?.workspace_id) {
    return mapped.workspace_id;
  }

  return resolveWorkspaceId({ workspaceId, catalogRoot });
}

function resolveWorkspaceRootForWorkspaceId({
  workspaceId,
  sourceMap = loadWorkspaceSourceMap(),
} = {}) {
  const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
  if (!normalizedWorkspaceId) {
    return null;
  }

  const matches = sourceMap.codex_workspaces
    .filter((entry) => entry.workspace_id === normalizedWorkspaceId)
    .map((entry) => entry.workspace_root);

  if (matches.length === 0) {
    return null;
  }

  return matches.sort((left, right) => right.length - left.length)[0];
}

function findCodexWorkspaceMapping({ cwd, codexWorkspaces = [] } = {}) {
  const normalizedCwd = normalizeAbsolutePath(cwd);
  if (!normalizedCwd) {
    return null;
  }

  return codexWorkspaces
    .filter((entry) => isPathWithinRoot(normalizedCwd, entry.workspace_root))
    .sort((left, right) => right.workspace_root.length - left.workspace_root.length)[0] ?? null;
}

function isPathWithinRoots(candidatePath, workspaceRoots = []) {
  const normalizedCandidatePath = normalizeAbsolutePath(candidatePath);
  if (!normalizedCandidatePath) {
    return false;
  }

  return workspaceRoots.some((workspaceRoot) => isPathWithinRoot(normalizedCandidatePath, workspaceRoot));
}

function isPathWithinRoot(candidatePath, workspaceRoot) {
  const normalizedCandidatePath = normalizeAbsolutePath(candidatePath);
  const normalizedWorkspaceRoot = normalizeAbsolutePath(workspaceRoot);
  if (!normalizedCandidatePath || !normalizedWorkspaceRoot) {
    return false;
  }

  return (
    normalizedCandidatePath === normalizedWorkspaceRoot
    || normalizedCandidatePath.startsWith(`${normalizedWorkspaceRoot}${path.sep}`)
  );
}

function loadWorkspaceConfigForCwd({ cwd, catalogRoot } = {}) {
  const normalizedCwd = normalizeAbsolutePath(cwd);
  if (!normalizedCwd) {
    return null;
  }

  const projectConfig = loadEcitrProjectConfig({ startDir: normalizedCwd });
  if (!projectConfig) {
    return null;
  }

  if (!catalogRoot) {
    return projectConfig;
  }

  const normalizedCatalogRoot = normalizeAbsolutePath(catalogRoot);
  if (projectConfig.catalog_root !== normalizedCatalogRoot) {
    return null;
  }

  return projectConfig;
}

function normalizeAgentOpsProjects(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries
    .map((entry) => ({
      project_id: typeof entry?.project_id === "string" ? entry.project_id.trim() : "",
      workspace_id: normalizeWorkspaceId(entry?.workspace_id),
    }))
    .filter((entry) => entry.project_id && entry.workspace_id);
}

function normalizeCodexWorkspaces(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries
    .map((entry) => ({
      workspace_root: normalizeAbsolutePath(entry?.workspace_root),
      workspace_id: normalizeWorkspaceId(entry?.workspace_id),
    }))
    .filter((entry) => entry.workspace_root && entry.workspace_id);
}

function normalizeWorkspaceId(value) {
  if (value == null || value === "") {
    return null;
  }

  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeAbsolutePath(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  return path.resolve(value);
}

module.exports = {
  DEFAULT_SOURCE_MAP_PATH,
  findCodexWorkspaceMapping,
  isPathWithinRoot,
  isPathWithinRoots,
  loadWorkspaceConfigForCwd,
  loadWorkspaceSourceMap,
  resolveWorkspaceIdForAgentOps,
  resolveWorkspaceIdForCodex,
  resolveWorkspaceRootForWorkspaceId,
};
