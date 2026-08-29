const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DEFAULT_TABLE_NAME,
  writeLanceDbCatalogBasis,
} = require("../src/retrieval/semantic-backends/lancedb-backend");
const {
  summarizeRegisteredMemoryAdoption,
} = require("../src/runtime/project-memory-adoption");
const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const { refreshSupportGraph } = require("../src/support-graph/refresh");
const {
  inspectRegisteredProjectMemory,
  syncRegisteredProjectMemoryMarkers,
} = require("../src/workspace/project-memory-rollout");

test("registered marker sync creates missing markers and only rewrites catalog routing", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-marker-rollout-"));
  const alphaRoot = path.join(rootDir, "alpha");
  const betaRoot = path.join(rootDir, "beta");
  const catalogRoot = path.join(rootDir, "shared", "catalog");
  fs.mkdirSync(alphaRoot, { recursive: true });
  fs.mkdirSync(betaRoot, { recursive: true });
  writeJson(path.join(betaRoot, "ecitr.project.json"), marker({
    workspaceId: "beta",
    catalogRoot: ".local/catalog",
    preflightMandatory: true,
  }));
  const sourceMap = buildSourceMap([
    project("alpha", alphaRoot),
    project("beta", betaRoot),
  ]);

  const dryRun = syncRegisteredProjectMemoryMarkers({
    catalogRoot,
    sourceMap,
    dryRun: true,
  });
  assert.equal(dryRun.created_count, 1);
  assert.equal(dryRun.updated_count, 1);
  assert.equal(fs.existsSync(path.join(alphaRoot, "ecitr.project.json")), false);
  assert.equal(readJson(path.join(betaRoot, "ecitr.project.json")).catalog_root, ".local/catalog");

  const applied = syncRegisteredProjectMemoryMarkers({
    catalogRoot,
    sourceMap,
    dryRun: false,
  });
  assert.equal(applied.ok, true);
  assert.equal(readJson(path.join(alphaRoot, "ecitr.project.json")).catalog_root, catalogRoot);
  const betaMarker = readJson(path.join(betaRoot, "ecitr.project.json"));
  assert.equal(betaMarker.catalog_root, catalogRoot);
  assert.equal(betaMarker.preflight_retrieval_mandatory, true);
  assert.equal(betaMarker.failure_retry_retrieval_mandatory, false);
});

test("registered marker sync skips direct workspace conflicts while applying safe roots", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-marker-conflict-"));
  const safeRoot = path.join(rootDir, "safe");
  const conflictRoot = path.join(rootDir, "conflict");
  const catalogRoot = path.join(rootDir, "shared", "catalog");
  fs.mkdirSync(safeRoot, { recursive: true });
  fs.mkdirSync(conflictRoot, { recursive: true });
  writeJson(path.join(conflictRoot, "ecitr.project.json"), marker({
    workspaceId: "someone_else",
    catalogRoot: ".local/catalog",
  }));
  const sourceMap = buildSourceMap([
    project("safe", safeRoot),
    project("conflict", conflictRoot),
  ]);

  const summary = syncRegisteredProjectMemoryMarkers({
    catalogRoot,
    sourceMap,
    dryRun: false,
  });

  assert.equal(summary.ok, false);
  assert.equal(summary.created_count, 1);
  assert.equal(summary.blocked_count, 1);
  assert.equal(readJson(path.join(safeRoot, "ecitr.project.json")).workspace_id, "safe");
  assert.equal(readJson(path.join(conflictRoot, "ecitr.project.json")).workspace_id, "someone_else");
});

test("registered marker sync does not rewrite an existing untracked marker", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-marker-untracked-"));
  const workspaceRoot = path.join(rootDir, "workspace");
  const catalogRoot = path.join(rootDir, "shared", "catalog");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  childProcess.execFileSync("git", ["init", "--quiet", workspaceRoot]);
  const markerPath = path.join(workspaceRoot, "ecitr.project.json");
  writeJson(markerPath, marker({
    workspaceId: "workspace",
    catalogRoot: ".local/catalog",
  }));
  const originalBytes = fs.readFileSync(markerPath, "utf8");

  const summary = syncRegisteredProjectMemoryMarkers({
    catalogRoot,
    sourceMap: buildSourceMap([project("workspace", workspaceRoot)]),
    dryRun: false,
  });

  assert.equal(summary.ok, false);
  assert.equal(summary.blocked_count, 1);
  assert.deepEqual(summary.results[0].blockers, ["untracked_marker_requires_owner"]);
  assert.equal(summary.results[0].git.marker_tracked, false);
  assert.equal(fs.readFileSync(markerPath, "utf8"), originalBytes);
});

test("registered marker sync does not rewrite an existing modified marker", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-marker-modified-"));
  const workspaceRoot = path.join(rootDir, "workspace");
  const catalogRoot = path.join(rootDir, "shared", "catalog");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  childProcess.execFileSync("git", ["init", "--quiet", workspaceRoot]);
  const markerPath = path.join(workspaceRoot, "ecitr.project.json");
  writeJson(markerPath, marker({
    workspaceId: "workspace",
    catalogRoot: ".local/catalog",
  }));
  childProcess.execFileSync("git", ["-C", workspaceRoot, "add", "ecitr.project.json"]);
  childProcess.execFileSync("git", [
    "-C",
    workspaceRoot,
    "-c",
    "user.name=ECITR Test",
    "-c",
    "user.email=ecitr-test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Add marker",
  ]);
  const modifiedMarker = readJson(markerPath);
  modifiedMarker.default_project_scope = "global";
  writeJson(markerPath, modifiedMarker);
  const modifiedBytes = fs.readFileSync(markerPath, "utf8");

  const summary = syncRegisteredProjectMemoryMarkers({
    catalogRoot,
    sourceMap: buildSourceMap([project("workspace", workspaceRoot)]),
    dryRun: false,
  });

  assert.equal(summary.ok, false);
  assert.equal(summary.blocked_count, 1);
  assert.deepEqual(summary.results[0].blockers, ["modified_marker_requires_owner"]);
  assert.equal(summary.results[0].git.marker_tracked, true);
  assert.equal(summary.results[0].git.marker_status, "M ecitr.project.json");
  assert.equal(fs.readFileSync(markerPath, "utf8"), modifiedBytes);
});

test("registered marker sync preserves an equivalent relative catalog route", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-marker-equivalent-"));
  const workspaceRoot = path.join(rootDir, "workspace");
  const catalogRoot = path.join(rootDir, "shared", "catalog");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const markerPath = path.join(workspaceRoot, "ecitr.project.json");
  writeJson(markerPath, marker({
    workspaceId: "workspace",
    catalogRoot: "../shared/catalog",
  }));
  const originalBytes = fs.readFileSync(markerPath, "utf8");

  const summary = syncRegisteredProjectMemoryMarkers({
    catalogRoot,
    sourceMap: buildSourceMap([project("workspace", workspaceRoot)]),
    dryRun: false,
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.unchanged_count, 1);
  assert.equal(fs.readFileSync(markerPath, "utf8"), originalBytes);
});

test("project memory doctor requires markers, current derived state, and installed skill", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-memory-doctor-"));
  const workspaceRoot = path.join(rootDir, "alpha");
  const catalogRoot = path.join(rootDir, "shared", "catalog");
  const graphRoot = path.join(rootDir, "graph");
  const lancedbUri = path.join(rootDir, "lancedb");
  const skillRoot = path.join(rootDir, "skills", "ecitr-memory");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const sourceMap = buildSourceMap([project("alpha", workspaceRoot)]);

  syncRegisteredProjectMemoryMarkers({
    catalogRoot,
    sourceMap,
    dryRun: false,
  });
  const catalog = new FileBackedCatalog({ rootDir: catalogRoot });
  const catalogs = catalog.loadRuntimeCatalogs();
  refreshSupportGraph({ catalogRoot, graphRoot });
  writeLanceDbCatalogBasis({
    uri: lancedbUri,
    tableName: DEFAULT_TABLE_NAME,
    catalogs,
    embeddingSignature: "hash:test-v1",
  });
  const lanceTablePath = path.join(lancedbUri, `${DEFAULT_TABLE_NAME}.lance`);
  fs.mkdirSync(lanceTablePath, { recursive: true });
  for (const relativePath of [
    "SKILL.md",
    path.join("scripts", "search_project_memory"),
    path.join("scripts", "record_memory_usage"),
    path.join("scripts", "log_memory_opportunity"),
  ]) {
    const filePath = path.join(skillRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "test\n", "utf8");
  }

  const report = inspectRegisteredProjectMemory({
    catalogRoot,
    graphRoot,
    lancedbUri,
    installedSkillRoot: skillRoot,
    sourceMap,
  });

  assert.equal(report.ok, true);
  assert.equal(report.summary.ready_root_count, 1);
  assert.equal(report.global_checks.catalog_readable, true);
  assert.equal(report.global_checks.support_graph_fresh, true);
  assert.equal(report.global_checks.lancedb_table_exists, true);
  assert.equal(report.global_checks.lancedb_basis_current, true);
  assert.equal(report.global_checks.skill_installed, true);
  assert.equal(report.roots[0].checks.workspace_attribution_matches, true);

  fs.rmSync(lanceTablePath, { recursive: true });
  const missingTableReport = inspectRegisteredProjectMemory({
    catalogRoot,
    graphRoot,
    lancedbUri,
    installedSkillRoot: skillRoot,
    sourceMap,
  });
  assert.equal(missingTableReport.global_checks.lancedb_table_exists, false);
  assert.equal(missingTableReport.global_checks.lancedb_basis_current, false);
  assert.equal(missingTableReport.roots[0].ready, false);

  fs.mkdirSync(lanceTablePath, { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, ".local"), "not a directory\n", "utf8");
  const invalidMetricsPathReport = inspectRegisteredProjectMemory({
    catalogRoot,
    graphRoot,
    lancedbUri,
    installedSkillRoot: skillRoot,
    sourceMap,
  });
  assert.equal(invalidMetricsPathReport.roots[0].checks.metrics_path_writable, false);
  assert.equal(invalidMetricsPathReport.roots[0].ready, false);
});

test("aggregate adoption report covers consulted and skipped opportunities across roots", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-adoption-report-"));
  const alphaRoot = path.join(rootDir, "alpha");
  const betaRoot = path.join(rootDir, "beta");
  fs.mkdirSync(alphaRoot, { recursive: true });
  fs.mkdirSync(betaRoot, { recursive: true });
  const sourceMap = buildSourceMap([
    project("alpha", alphaRoot),
    project("beta", betaRoot),
  ]);
  writeInvocation(alphaRoot, {
    invocationId: "meminv_alpha_skip",
    workspaceId: "alpha",
    consultedAt: "2026-08-01T00:00:00.000Z",
    consulted: false,
  });
  writeInvocation(alphaRoot, {
    invocationId: "meminv_alpha_use",
    workspaceId: "alpha",
    consultedAt: "2026-08-01T01:00:00.000Z",
    consulted: true,
    usedRecordIds: ["case_alpha"],
  });
  writeInvocation(betaRoot, {
    invocationId: "meminv_wrong_workspace",
    workspaceId: "alpha",
    consultedAt: "2026-08-01T03:00:00.000Z",
    consulted: false,
  });

  const report = summarizeRegisteredMemoryAdoption({
    catalogRoot: path.join(rootDir, "shared", "catalog"),
    sourceMap,
    since: "2026-08-01T00:00:00.000Z",
    until: "2026-08-02T00:00:00.000Z",
  });

  assert.equal(report.workspace_count, 2);
  assert.deepEqual(report.zero_opportunity_workspaces, ["beta"]);
  assert.equal(report.totals.task_opportunities, 2);
  assert.equal(report.totals.consultations, 1);
  assert.equal(report.totals.consultation_rate, 0.5);
  assert.equal(report.totals.usage_callback_rate, 1);
  assert.equal(report.totals.attribution_mismatch_count, 1);
  assert.deepEqual(report.totals.used_record_ids, ["case_alpha"]);
  assert.equal(report.workspaces.find((entry) => entry.workspace_id === "alpha").used_memory, 1);
  const beta = report.workspaces.find((entry) => entry.workspace_id === "beta");
  assert.equal(beta.task_opportunities, 0);
  assert.equal(beta.attribution_mismatch_count, 1);
});

function buildSourceMap(projects) {
  return {
    agent_ops_projects: [],
    codex_workspaces: [],
    agent_ops_registry_projects: projects,
    agent_ops_registry_all_projects: projects,
  };
}

function project(id, workspaceRoot) {
  return {
    id,
    status: "active",
    aliases: [],
    workspace_roots: [workspaceRoot],
  };
}

function marker({ workspaceId, catalogRoot, preflightMandatory = false }) {
  return {
    schema_version: 1,
    workspace_id: workspaceId,
    catalog_root: catalogRoot,
    default_project_scope: "project",
    preflight_retrieval_mandatory: preflightMandatory,
    failure_retry_retrieval_mandatory: false,
  };
}

function writeInvocation(workspaceRoot, {
  invocationId,
  workspaceId,
  consultedAt,
  consulted,
  usedRecordIds = [],
}) {
  const filePath = path.join(
    workspaceRoot,
    ".local",
    "memory-invocations",
    "2026",
    "08",
    `${invocationId}.json`,
  );
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeJson(filePath, {
    schema_version: 1,
    invocation_id: invocationId,
    consulted_at: consultedAt,
    workspace_id: workspaceId,
    memory_consulted: consulted,
    consult_trigger: consulted ? "discretionary" : null,
    returned_counts: consulted
      ? { tactics: 0, invariants: 0, cases: 1, evidence: 0 }
      : { tactics: 0, invariants: 0, cases: 0, evidence: 0 },
    usage_recorded_at: consulted ? "2026-08-01T02:00:00.000Z" : null,
    used_memory: usedRecordIds.length > 0,
    used_record_ids: usedRecordIds,
    used_returned_record_ids: usedRecordIds,
    selected_record_ids: usedRecordIds,
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
