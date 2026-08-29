const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  loadWorkspaceSourceMap,
  resolveWorkspaceAttributionForAgentOps,
  resolveWorkspaceAttributionForCodex,
  resolveWorkspaceIdForAgentOps,
  resolveWorkspaceIdForCodex,
  resolveWorkspaceRootForWorkspaceId,
} = require("../src/workspace/source-mapping");

test("workspace source map resolves registered project ids and aliases", () => {
  const fixture = createSourceMapFixture();
  const sourceMap = loadWorkspaceSourceMap({ filePath: fixture.sourceMapPath });

  assert.equal(resolveWorkspaceIdForAgentOps({
    projectId: "project_alpha",
    sourceMap,
  }), "project_alpha");
  assert.equal(resolveWorkspaceIdForAgentOps({
    projectId: "Alpha Project",
    sourceMap,
  }), "project_alpha");
});

test("agent-ops attribution preserves inactive historical project identity", () => {
  const fixture = createSourceMapFixture();
  const sourceMap = loadWorkspaceSourceMap({ filePath: fixture.sourceMapPath });

  assert.deepEqual(
    sourceMap.agent_ops_registry_projects.map((entry) => entry.id),
    ["project_alpha"],
  );
  assert.deepEqual(
    sourceMap.agent_ops_registry_all_projects.map((entry) => entry.id),
    ["project_alpha", "inactive_project"],
  );
  assert.deepEqual(resolveWorkspaceAttributionForAgentOps({
    projectId: "inactive_project",
    sourceMap,
  }), {
    workspace_id: "inactive_project",
    source: "agent_ops_registry",
    authoritative: true,
  });
});

test("inactive registry workspaces stay excluded from Codex discovery and root lookup", () => {
  const fixture = createSourceMapFixture();
  const sourceMap = loadWorkspaceSourceMap({ filePath: fixture.sourceMapPath });

  assert.deepEqual(resolveWorkspaceAttributionForCodex({
    cwd: path.join(fixture.rootDir, "inactive", "src"),
    catalogRoot: fixture.centralCatalogRoot,
    sourceMap,
  }), {
    workspace_id: null,
    source: "catalog_fallback",
    authoritative: false,
  });
  assert.equal(resolveWorkspaceRootForWorkspaceId({
    workspaceId: "inactive_project",
    sourceMap,
  }), null);
});

test("codex attribution accepts a workspace marker independently of catalog routing", () => {
  const fixture = createSourceMapFixture();
  writeJson(path.join(fixture.workspaceRoot, "ecitr.project.json"), {
    schema_version: 1,
    workspace_id: "marker_workspace",
    catalog_root: ".local/catalog",
    default_project_scope: "project",
    preflight_retrieval_mandatory: false,
    failure_retry_retrieval_mandatory: false,
  });
  const sourceMap = loadWorkspaceSourceMap({ filePath: fixture.sourceMapPath });

  assert.equal(resolveWorkspaceIdForCodex({
    cwd: path.join(fixture.workspaceRoot, "src"),
    catalogRoot: fixture.centralCatalogRoot,
    sourceMap,
  }), "marker_workspace");
});

test("codex attribution and workspace-root lookup fall back to the active registry", () => {
  const fixture = createSourceMapFixture();
  const sourceMap = loadWorkspaceSourceMap({ filePath: fixture.sourceMapPath });

  assert.equal(resolveWorkspaceIdForCodex({
    cwd: path.join(fixture.workspaceRoot, "src"),
    catalogRoot: fixture.centralCatalogRoot,
    sourceMap,
  }), "project_alpha");
  assert.equal(resolveWorkspaceRootForWorkspaceId({
    workspaceId: "project_alpha",
    sourceMap,
  }), fixture.workspaceRoot);
});

test("attribution details distinguish authoritative mappings from catalog fallback", () => {
  const fixture = createSourceMapFixture();
  writeJson(path.join(fixture.centralCatalogRoot, "ecitr.project.json"), {
    schema_version: 1,
    workspace_id: "central_catalog",
    catalog_root: ".",
    default_project_scope: "project",
    preflight_retrieval_mandatory: false,
    failure_retry_retrieval_mandatory: false,
  });
  const sourceMap = loadWorkspaceSourceMap({ filePath: fixture.sourceMapPath });

  assert.deepEqual(resolveWorkspaceAttributionForAgentOps({
    projectId: "project_alpha",
    catalogRoot: fixture.centralCatalogRoot,
    sourceMap,
  }), {
    workspace_id: "project_alpha",
    source: "agent_ops_registry",
    authoritative: true,
  });
  assert.deepEqual(resolveWorkspaceAttributionForCodex({
    cwd: path.join(fixture.rootDir, "unknown"),
    catalogRoot: fixture.centralCatalogRoot,
    sourceMap,
  }), {
    workspace_id: "central_catalog",
    source: "catalog_fallback",
    authoritative: false,
  });
});

test("codex attribution resolves markerless git worktrees through commondir", () => {
  const fixture = createSourceMapFixture();
  const worktreeRoot = path.join(fixture.rootDir, "codex-worktree");
  const gitDir = path.join(fixture.workspaceRoot, ".git", "worktrees", "codex-worktree");
  fs.mkdirSync(path.join(worktreeRoot, "src"), { recursive: true });
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(worktreeRoot, ".git"), `gitdir: ${gitDir}\n`, "utf8");
  fs.writeFileSync(path.join(gitDir, "commondir"), "../..\n", "utf8");
  const sourceMap = loadWorkspaceSourceMap({ filePath: fixture.sourceMapPath });

  assert.equal(resolveWorkspaceIdForCodex({
    cwd: path.join(worktreeRoot, "src"),
    catalogRoot: fixture.centralCatalogRoot,
    sourceMap,
  }), "project_alpha");
});

test("configured missing registries fail closed before catalog fallback", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-missing-registry-"));
  const sourceMapPath = path.join(rootDir, "workspace-source-map.json");
  const missingRegistryPath = path.join(rootDir, "missing-registry.json");
  writeJson(sourceMapPath, {
    schema_version: 1,
    agent_ops_registry_path: missingRegistryPath,
    agent_ops_projects: [],
    codex_workspaces: [],
  });
  const sourceMap = loadWorkspaceSourceMap({ filePath: sourceMapPath });

  assert.equal(sourceMap.agent_ops_registry_available, false);
  assert.throws(() => resolveWorkspaceIdForAgentOps({
    projectId: "unknown_project",
    catalogRoot: rootDir,
    sourceMap,
  }), /registry is unavailable/);
});

function createSourceMapFixture() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-source-map-"));
  const workspaceRoot = path.join(rootDir, "workspace-alpha");
  const centralCatalogRoot = path.join(rootDir, "central-catalog");
  const registryPath = path.join(rootDir, "project-registry.json");
  const sourceMapPath = path.join(rootDir, "workspace-source-map.json");
  fs.mkdirSync(path.join(workspaceRoot, "src"), { recursive: true });
  fs.mkdirSync(centralCatalogRoot, { recursive: true });
  writeJson(registryPath, {
    version: 1,
    projects: [
      {
        id: "project_alpha",
        status: "active",
        memory_root: "memory/projects/project_alpha",
        workspace_roots: [workspaceRoot],
        aliases: ["Alpha Project"],
      },
      {
        id: "inactive_project",
        status: "inactive",
        memory_root: "memory/projects/inactive_project",
        workspace_roots: [path.join(rootDir, "inactive")],
      },
    ],
  });
  writeJson(sourceMapPath, {
    schema_version: 1,
    agent_ops_registry_path: registryPath,
    agent_ops_projects: [],
    codex_workspaces: [],
  });

  return {
    centralCatalogRoot,
    rootDir,
    sourceMapPath,
    workspaceRoot,
  };
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
