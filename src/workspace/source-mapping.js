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
      agent_ops_registry_path: null,
      agent_ops_registry_available: false,
      agent_ops_registry_projects: [],
      file_path: resolvedFilePath,
    };
  }

  const parsed = JSON.parse(fs.readFileSync(resolvedFilePath, "utf8"));
  const agentOpsRegistryPath = normalizeConfiguredPath(
    parsed.agent_ops_registry_path ?? process.env.AGENT_OPS_PROJECT_REGISTRY,
    { relativeTo: path.dirname(resolvedFilePath) },
  );
  const agentOpsRegistryAvailable = Boolean(
    agentOpsRegistryPath && fs.existsSync(agentOpsRegistryPath),
  );
  return {
    schema_version: parsed.schema_version ?? 1,
    agent_ops_projects: normalizeAgentOpsProjects(parsed.agent_ops_projects),
    codex_workspaces: normalizeCodexWorkspaces(parsed.codex_workspaces),
    agent_ops_registry_path: agentOpsRegistryPath,
    agent_ops_registry_available: agentOpsRegistryAvailable,
    agent_ops_registry_projects: loadAgentOpsRegistryProjects({
      filePath: agentOpsRegistryPath,
    }),
    file_path: resolvedFilePath,
  };
}

function resolveWorkspaceIdForAgentOps({
  projectId,
  workspaceId = null,
  catalogRoot = null,
  sourceMap = loadWorkspaceSourceMap(),
} = {}) {
  return resolveWorkspaceAttributionForAgentOps({
    projectId,
    workspaceId,
    catalogRoot,
    sourceMap,
  }).workspace_id;
}

function resolveWorkspaceAttributionForAgentOps({
  projectId,
  workspaceId = null,
  catalogRoot = null,
  sourceMap = loadWorkspaceSourceMap(),
} = {}) {
  const explicit = normalizeWorkspaceId(workspaceId);
  if (explicit) {
    return attributionResult(explicit, "explicit");
  }

  const mapped = sourceMap.agent_ops_projects.find((entry) => entry.project_id === projectId);
  if (mapped?.workspace_id) {
    return attributionResult(mapped.workspace_id, "source_map");
  }

  assertConfiguredRegistryAvailable(sourceMap);

  const registered = findAgentOpsRegistryProjectByIdentity({
    projectId,
    projects: sourceMap.agent_ops_registry_projects,
  });
  if (registered) {
    return attributionResult(registered.id, "agent_ops_registry");
  }

  return attributionResult(
    resolveWorkspaceId({ workspaceId, catalogRoot }),
    "catalog_fallback",
    false,
  );
}

function resolveWorkspaceIdForCodex({
  cwd,
  workspaceId = null,
  catalogRoot = null,
  sourceMap = loadWorkspaceSourceMap(),
} = {}) {
  return resolveWorkspaceAttributionForCodex({
    cwd,
    workspaceId,
    catalogRoot,
    sourceMap,
  }).workspace_id;
}

function resolveWorkspaceAttributionForCodex({
  cwd,
  workspaceId = null,
  catalogRoot = null,
  sourceMap = loadWorkspaceSourceMap(),
} = {}) {
  const explicit = normalizeWorkspaceId(workspaceId);
  if (explicit) {
    return attributionResult(explicit, "explicit");
  }

  const markerConfig = loadWorkspaceConfigForCwd({ cwd, catalogRoot });
  if (markerConfig?.workspace_id) {
    return attributionResult(markerConfig.workspace_id, "workspace_marker");
  }

  const mapped = findCodexWorkspaceMapping({ cwd, codexWorkspaces: sourceMap.codex_workspaces });
  if (mapped?.workspace_id) {
    return attributionResult(mapped.workspace_id, "source_map");
  }

  assertConfiguredRegistryAvailable(sourceMap);

  const registered = findAgentOpsRegistryProjectByCwd({
    cwd,
    projects: sourceMap.agent_ops_registry_projects,
  });
  if (registered) {
    return attributionResult(registered.id, "agent_ops_registry");
  }

  return attributionResult(
    resolveWorkspaceId({ workspaceId, catalogRoot }),
    "catalog_fallback",
    false,
  );
}

function attributionResult(workspaceId, source, authoritative = true) {
  return {
    workspace_id: normalizeWorkspaceId(workspaceId),
    source,
    authoritative: Boolean(workspaceId) && authoritative,
  };
}

function resolveWorkspaceRootForWorkspaceId({
  workspaceId,
  sourceMap = loadWorkspaceSourceMap(),
} = {}) {
  const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
  if (!normalizedWorkspaceId) {
    return null;
  }

  const matches = [
    ...sourceMap.codex_workspaces
    .filter((entry) => entry.workspace_id === normalizedWorkspaceId)
    .map((entry) => entry.workspace_root),
    ...sourceMap.agent_ops_registry_projects
      .filter((entry) => entry.id === normalizedWorkspaceId)
      .flatMap((entry) => entry.workspace_roots),
  ];

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

  const candidatePaths = getWorkspaceCandidatePaths(normalizedCwd);
  return codexWorkspaces
    .filter((entry) => candidatePaths.some((candidatePath) =>
      isPathWithinRoot(candidatePath, entry.workspace_root)))
    .sort((left, right) => right.workspace_root.length - left.workspace_root.length)[0] ?? null;
}

function isPathWithinRoots(candidatePath, workspaceRoots = []) {
  const normalizedCandidatePath = normalizeAbsolutePath(candidatePath);
  if (!normalizedCandidatePath) {
    return false;
  }

  return getWorkspaceCandidatePaths(normalizedCandidatePath).some((resolvedCandidatePath) =>
    workspaceRoots.some((workspaceRoot) => isPathWithinRoot(resolvedCandidatePath, workspaceRoot)));
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

function loadWorkspaceConfigForCwd({ cwd, catalogRoot, requireCatalogMatch = false } = {}) {
  const normalizedCwd = normalizeAbsolutePath(cwd);
  if (!normalizedCwd) {
    return null;
  }

  const projectConfig = loadEcitrProjectConfig({ startDir: normalizedCwd });
  if (!projectConfig) {
    return null;
  }

  if (!catalogRoot || !requireCatalogMatch) {
    return projectConfig;
  }

  const normalizedCatalogRoot = normalizeAbsolutePath(catalogRoot);
  if (projectConfig.catalog_root !== normalizedCatalogRoot) {
    return null;
  }

  return projectConfig;
}

function loadAgentOpsRegistryProjects({ filePath } = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    return [];
  }

  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(parsed?.projects)) {
    throw new Error(`Agent-ops project registry is missing projects: ${filePath}`);
  }

  return parsed.projects
    .map((entry) => ({
      id: normalizeWorkspaceId(entry?.id),
      status: typeof entry?.status === "string" ? entry.status.trim() : "",
      aliases: normalizeUniqueStrings(entry?.aliases),
      workspace_roots: normalizeUniquePaths(entry?.workspace_roots),
    }))
    .filter((entry) => entry.id && entry.status === "active");
}

function findAgentOpsRegistryProjectByIdentity({ projectId, projects = [] } = {}) {
  const normalizedProjectId = normalizeWorkspaceId(projectId);
  if (!normalizedProjectId) {
    return null;
  }

  return projects.find((entry) =>
    entry.id === normalizedProjectId || entry.aliases.includes(normalizedProjectId)) ?? null;
}

function findAgentOpsRegistryProjectByCwd({ cwd, projects = [] } = {}) {
  const normalizedCwd = normalizeAbsolutePath(cwd);
  if (!normalizedCwd) {
    return null;
  }

  const candidatePaths = getWorkspaceCandidatePaths(normalizedCwd);
  return projects
    .flatMap((entry) => entry.workspace_roots.flatMap((workspaceRoot) => candidatePaths.map((candidatePath) => ({
      entry,
      workspaceRoot,
      candidatePath,
    }))))
    .filter(({ candidatePath, workspaceRoot }) => isPathWithinRoot(candidatePath, workspaceRoot))
    .sort((left, right) => right.workspaceRoot.length - left.workspaceRoot.length)[0]?.entry ?? null;
}

function getWorkspaceCandidatePaths(candidatePath) {
  const normalizedCandidatePath = normalizeAbsolutePath(candidatePath);
  if (!normalizedCandidatePath) {
    return [];
  }
  const canonicalRoot = resolveCanonicalGitWorktreeRoot(normalizedCandidatePath);
  return [...new Set([normalizedCandidatePath, canonicalRoot].filter(Boolean))];
}

function resolveCanonicalGitWorktreeRoot(candidatePath) {
  let current = normalizeAbsolutePath(candidatePath);
  if (!current) {
    return null;
  }
  if (fs.existsSync(current) && !fs.statSync(current).isDirectory()) {
    current = path.dirname(current);
  }

  while (true) {
    const gitPath = path.join(current, ".git");
    if (fs.existsSync(gitPath)) {
      if (fs.statSync(gitPath).isDirectory()) {
        return current;
      }
      const match = fs.readFileSync(gitPath, "utf8").match(/^gitdir:\s*(.+)$/m);
      if (!match) {
        return null;
      }
      const gitDir = path.resolve(current, match[1].trim());
      const commonDirPath = path.join(gitDir, "commondir");
      if (!fs.existsSync(commonDirPath)) {
        return null;
      }
      const commonDir = path.resolve(gitDir, fs.readFileSync(commonDirPath, "utf8").trim());
      return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : null;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function assertConfiguredRegistryAvailable(sourceMap) {
  if (sourceMap.agent_ops_registry_path && sourceMap.agent_ops_registry_available === false) {
    throw new Error(
      `Configured agent-ops project registry is unavailable: ${sourceMap.agent_ops_registry_path}`,
    );
  }
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

function normalizeUniqueStrings(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }

  return [...new Set(entries
    .map((entry) => normalizeWorkspaceId(entry))
    .filter(Boolean))].sort();
}

function normalizeUniquePaths(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }

  return [...new Set(entries
    .map((entry) => normalizeAbsolutePath(entry))
    .filter(Boolean))].sort();
}

function normalizeConfiguredPath(value, { relativeTo }) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  return path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(relativeTo, value);
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
  findAgentOpsRegistryProjectByCwd,
  findAgentOpsRegistryProjectByIdentity,
  findCodexWorkspaceMapping,
  isPathWithinRoot,
  isPathWithinRoots,
  loadAgentOpsRegistryProjects,
  loadWorkspaceConfigForCwd,
  loadWorkspaceSourceMap,
  resolveWorkspaceAttributionForAgentOps,
  resolveWorkspaceAttributionForCodex,
  resolveCanonicalGitWorktreeRoot,
  resolveWorkspaceIdForAgentOps,
  resolveWorkspaceIdForCodex,
  resolveWorkspaceRootForWorkspaceId,
};
