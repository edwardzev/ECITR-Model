const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const { getCurrentEvidenceRecords } = require("../evidence/corrections");
const {
  DEFAULT_LANCEDB_URI,
  DEFAULT_TABLE_NAME: DEFAULT_LANCEDB_TABLE_NAME,
  getLanceDbBasisPath,
} = require("../retrieval/semantic-backends/lancedb-backend");
const { localLanceDbTableExists } = require("../runtime/project-memory");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const {
  DEFAULT_GRAPH_ROOT,
  loadFreshSnapshot,
} = require("../support-graph/refresh");
const { EcitrValidator } = require("../validation/validator");
const {
  loadWorkspaceSourceMap,
  resolveWorkspaceAttributionForCodex,
} = require("./source-mapping");

const MARKER_FILENAME = "ecitr.project.json";
const DEFAULT_INSTALLED_SKILL_ROOT = path.join(
  process.env.CODEX_HOME ?? path.join(process.env.HOME ?? "", ".codex"),
  "skills",
  "ecitr-memory",
);
const REQUIRED_SKILL_FILES = Object.freeze([
  "SKILL.md",
  path.join("scripts", "search_project_memory"),
  path.join("scripts", "record_memory_usage"),
  path.join("scripts", "log_memory_opportunity"),
]);

function syncRegisteredProjectMemoryMarkers({
  catalogRoot = DEFAULT_CATALOG_ROOT,
  sourceMap = loadWorkspaceSourceMap(),
  workspaceIds = [],
  dryRun = true,
  validator = new EcitrValidator(),
} = {}) {
  const plans = planRegisteredProjectMemoryMarkers({
    catalogRoot,
    sourceMap,
    workspaceIds,
    validator,
  });
  const results = plans.map((plan) => applyMarkerPlan({ plan, dryRun }));

  return {
    ok: results.every((entry) => entry.status !== "blocked"),
    dry_run: dryRun,
    catalog_root: path.resolve(catalogRoot),
    workspace_count: new Set(results.map((entry) => entry.workspace_id)).size,
    root_count: results.length,
    created_count: results.filter((entry) => entry.status === "created").length,
    updated_count: results.filter((entry) => entry.status === "updated").length,
    unchanged_count: results.filter((entry) => entry.status === "unchanged").length,
    blocked_count: results.filter((entry) => entry.status === "blocked").length,
    results,
  };
}

function planRegisteredProjectMemoryMarkers({
  catalogRoot = DEFAULT_CATALOG_ROOT,
  sourceMap = loadWorkspaceSourceMap(),
  workspaceIds = [],
  validator = new EcitrValidator(),
} = {}) {
  const projects = selectActiveProjects({ sourceMap, workspaceIds });
  const resolvedCatalogRoot = path.resolve(catalogRoot);

  return projects
    .flatMap((project) => project.workspace_roots.map((workspaceRoot) => ({
      workspaceId: project.id,
      workspaceRoot: path.resolve(workspaceRoot),
    })))
    .sort(compareWorkspaceEntries)
    .map(({ workspaceId, workspaceRoot }) => planMarker({
      workspaceId,
      workspaceRoot,
      catalogRoot: resolvedCatalogRoot,
      validator,
    }));
}

function inspectRegisteredProjectMemory({
  catalogRoot = DEFAULT_CATALOG_ROOT,
  graphRoot = DEFAULT_GRAPH_ROOT,
  lancedbUri = DEFAULT_LANCEDB_URI,
  lancedbTableName = DEFAULT_LANCEDB_TABLE_NAME,
  installedSkillRoot = DEFAULT_INSTALLED_SKILL_ROOT,
  sourceMap = loadWorkspaceSourceMap(),
  workspaceIds = [],
  validator = new EcitrValidator(),
} = {}) {
  const resolvedCatalogRoot = path.resolve(catalogRoot);
  const markerPlans = planRegisteredProjectMemoryMarkers({
    catalogRoot: resolvedCatalogRoot,
    sourceMap,
    workspaceIds,
    validator,
  });
  const globalChecks = inspectGlobalRuntime({
    catalogRoot: resolvedCatalogRoot,
    graphRoot,
    lancedbUri,
    lancedbTableName,
    installedSkillRoot,
    validator,
  });
  const recordCounts = globalChecks.catalogs
    ? buildWorkspaceRecordCounts(globalChecks.catalogs)
    : new Map();

  const roots = markerPlans.map((plan) => {
    const attribution = plan.root_exists
      ? resolveWorkspaceAttributionForCodex({ cwd: plan.workspace_root, sourceMap })
      : { workspace_id: null, source: null, authoritative: false };
    const metricsRoot = path.join(plan.workspace_root, ".local", "memory-invocations");
    const metricsWritable = plan.root_exists && isWritableArtifactRoot(metricsRoot);
    const counts = recordCounts.get(plan.workspace_id) ?? emptyRecordCounts();
    const checks = {
      root_exists: plan.root_exists,
      marker_ready: plan.status === "unchanged",
      workspace_attribution_matches: attribution.workspace_id === plan.workspace_id,
      metrics_path_writable: metricsWritable,
    };
    const ready = Object.values(checks).every(Boolean)
      && globalChecks.catalog_readable
      && globalChecks.support_graph_fresh
      && globalChecks.lancedb_basis_current
      && globalChecks.skill_installed;

    return {
      workspace_id: plan.workspace_id,
      workspace_root: plan.workspace_root,
      marker_path: plan.marker_path,
      marker_status: plan.status,
      marker_catalog_root: plan.current_marker?.catalog_root ?? null,
      default_project_scope: plan.current_marker?.default_project_scope ?? null,
      preflight_retrieval_mandatory:
        plan.current_marker?.preflight_retrieval_mandatory ?? null,
      failure_retry_retrieval_mandatory:
        plan.current_marker?.failure_retry_retrieval_mandatory ?? null,
      attribution_source: attribution.source,
      metrics_root: metricsRoot,
      record_counts: counts,
      checks,
      ready,
      blockers: [...plan.blockers],
      warnings: sumRecordCounts(counts) === 0
        ? markerWarnings(plan).concat("workspace_has_no_canonical_records")
        : markerWarnings(plan),
    };
  });
  const failedRoots = roots.filter((entry) => !entry.ready);

  return {
    ok: failedRoots.length === 0,
    checked_at: new Date().toISOString(),
    catalog_root: resolvedCatalogRoot,
    graph_root: path.resolve(graphRoot),
    lancedb_uri: path.resolve(lancedbUri),
    installed_skill_root: path.resolve(installedSkillRoot),
    global_checks: withoutCatalogs(globalChecks),
    summary: {
      workspace_count: new Set(roots.map((entry) => entry.workspace_id)).size,
      root_count: roots.length,
      ready_root_count: roots.length - failedRoots.length,
      failed_root_count: failedRoots.length,
      missing_marker_count: roots.filter((entry) => entry.marker_status === "created").length,
      misrouted_marker_count: roots.filter((entry) => entry.marker_status === "updated").length,
      blocked_marker_count: roots.filter((entry) => entry.marker_status === "blocked").length,
      no_record_root_count: roots.filter((entry) =>
        entry.warnings.includes("workspace_has_no_canonical_records")).length,
    },
    roots,
  };
}

function planMarker({ workspaceId, workspaceRoot, catalogRoot, validator }) {
  const markerPath = path.join(workspaceRoot, MARKER_FILENAME);
  const base = {
    workspace_id: workspaceId,
    workspace_root: workspaceRoot,
    marker_path: markerPath,
    root_exists: isDirectory(workspaceRoot),
    current_marker: null,
    desired_marker: null,
    basis_hash: null,
    git: inspectMarkerGitState({ workspaceRoot, markerPath }),
    blockers: [],
  };

  if (!base.root_exists) {
    return {
      ...base,
      status: "blocked",
      blockers: ["workspace_root_missing"],
    };
  }

  if (!fs.existsSync(markerPath)) {
    return {
      ...base,
      status: "created",
      desired_marker: buildDefaultMarker({ workspaceId, catalogRoot }),
    };
  }

  let markerBytes;
  let currentMarker;
  try {
    markerBytes = fs.readFileSync(markerPath, "utf8");
    currentMarker = JSON.parse(markerBytes);
    validator.validateRecord("ecitr_project", currentMarker);
  } catch (error) {
    return {
      ...base,
      status: "blocked",
      blockers: [`invalid_marker:${error.message}`],
    };
  }

  if (currentMarker.workspace_id !== workspaceId) {
    return {
      ...base,
      status: "blocked",
      current_marker: currentMarker,
      basis_hash: sha256(markerBytes),
      blockers: [
        `workspace_id_conflict:${currentMarker.workspace_id}:${workspaceId}`,
      ],
    };
  }

  const catalogAlreadyRouted = path.resolve(
    workspaceRoot,
    currentMarker.catalog_root,
  ) === catalogRoot;
  const desiredMarker = catalogAlreadyRouted
    ? currentMarker
    : {
      ...currentMarker,
      catalog_root: catalogRoot,
    };
  validator.validateRecord("ecitr_project", desiredMarker);

  if (!catalogAlreadyRouted && base.git.git_root) {
    if (!base.git.marker_tracked) {
      return {
        ...base,
        status: "blocked",
        current_marker: currentMarker,
        desired_marker: desiredMarker,
        basis_hash: sha256(markerBytes),
        blockers: ["untracked_marker_requires_owner"],
      };
    }
    if (base.git.marker_status) {
      return {
        ...base,
        status: "blocked",
        current_marker: currentMarker,
        desired_marker: desiredMarker,
        basis_hash: sha256(markerBytes),
        blockers: ["modified_marker_requires_owner"],
      };
    }
  }

  return {
    ...base,
    status: catalogAlreadyRouted ? "unchanged" : "updated",
    current_marker: currentMarker,
    desired_marker: desiredMarker,
    basis_hash: sha256(markerBytes),
  };
}

function applyMarkerPlan({ plan, dryRun }) {
  if (plan.status === "blocked" || plan.status === "unchanged") {
    return publicMarkerResult(plan, plan.status);
  }
  if (dryRun) {
    return publicMarkerResult(plan, plan.status);
  }

  if (plan.basis_hash) {
    const currentBytes = fs.readFileSync(plan.marker_path, "utf8");
    if (sha256(currentBytes) !== plan.basis_hash) {
      return publicMarkerResult({
        ...plan,
        blockers: [...plan.blockers, "marker_changed_after_plan"],
      }, "blocked");
    }
  } else if (fs.existsSync(plan.marker_path)) {
    return publicMarkerResult({
      ...plan,
      blockers: [...plan.blockers, "marker_created_after_plan"],
    }, "blocked");
  }

  writeJsonAtomic(plan.marker_path, plan.desired_marker);
  return publicMarkerResult(plan, plan.status);
}

function inspectGlobalRuntime({
  catalogRoot,
  graphRoot,
  lancedbUri,
  lancedbTableName,
  installedSkillRoot,
  validator,
}) {
  let catalogs = null;
  let catalogError = null;
  try {
    catalogs = new FileBackedCatalog({ rootDir: catalogRoot, validator })
      .loadRuntimeCatalogs();
  } catch (error) {
    catalogError = error.message;
  }

  const supportGraphFresh = Boolean(
    catalogs && loadFreshSnapshot({ graphRoot, catalogs }),
  );
  const basisPath = getLanceDbBasisPath({ uri: lancedbUri, tableName: lancedbTableName });
  let embeddingSignature = null;
  try {
    embeddingSignature = JSON.parse(fs.readFileSync(basisPath, "utf8")).embedding_signature;
  } catch {
    embeddingSignature = null;
  }
  const lancedbBasisCurrent = Boolean(
    catalogs && embeddingSignature && localLanceDbTableExists({
      uri: lancedbUri,
      tableName: lancedbTableName,
      catalogRoot,
      catalogs,
      expectedEmbeddingSignature: () => embeddingSignature,
    }),
  );
  const lancedbTableExists = localLanceDbTableExists({
    uri: lancedbUri,
    tableName: lancedbTableName,
  });
  const skillFiles = REQUIRED_SKILL_FILES.map((relativePath) => ({
    relative_path: relativePath,
    exists: fs.existsSync(path.join(installedSkillRoot, relativePath)),
  }));

  return {
    catalog_readable: Boolean(catalogs),
    catalog_error: catalogError,
    support_graph_fresh: supportGraphFresh,
    lancedb_table_exists: lancedbTableExists,
    lancedb_basis_current: lancedbBasisCurrent,
    skill_installed: skillFiles.every((entry) => entry.exists),
    skill_files: skillFiles,
    catalogs,
  };
}

function buildWorkspaceRecordCounts(catalogs) {
  const counts = new Map();
  const add = (workspaceId, layer) => {
    if (!workspaceId) {
      return;
    }
    if (!counts.has(workspaceId)) {
      counts.set(workspaceId, emptyRecordCounts());
    }
    counts.get(workspaceId)[layer] += 1;
  };

  for (const record of getCurrentEvidenceRecords(catalogs.evidence ?? [])) {
    add(record.workspace_id, "evidence");
  }
  for (const record of catalogs.cases ?? []) {
    add(record.workspace_id, "cases");
  }
  for (const record of catalogs.invariants ?? []) {
    add(record.workspace_id, "invariants");
  }
  for (const record of catalogs.tactics ?? []) {
    add(record.workspace_id, "tactics");
  }
  for (const record of catalogs.parameter_definitions ?? []) {
    add(record.workspace_id, "parameter_definitions");
  }
  for (const record of catalogs.parameter_observations ?? []) {
    add(record.workspace_id, "parameter_observations");
  }
  return counts;
}

function selectActiveProjects({ sourceMap, workspaceIds }) {
  const projects = sourceMap.agent_ops_registry_projects ?? [];
  const available = new Set(projects.map((entry) => entry.id));
  const selected = workspaceIds.length > 0
    ? new Set(workspaceIds)
    : available;
  const unknown = [...selected].filter((entry) => !available.has(entry)).sort();
  if (unknown.length > 0) {
    throw new Error(`Active workspace selectors are not registered: ${unknown.join(", ")}`);
  }
  return projects.filter((entry) => selected.has(entry.id));
}

function buildDefaultMarker({ workspaceId, catalogRoot }) {
  return {
    schema_version: 1,
    workspace_id: workspaceId,
    catalog_root: catalogRoot,
    default_project_scope: "project",
    preflight_retrieval_mandatory: false,
    failure_retry_retrieval_mandatory: false,
  };
}

function publicMarkerResult(plan, status) {
  return {
    workspace_id: plan.workspace_id,
    workspace_root: plan.workspace_root,
    marker_path: plan.marker_path,
    status,
    catalog_root: plan.desired_marker?.catalog_root
      ?? plan.current_marker?.catalog_root
      ?? null,
    blockers: [...plan.blockers],
    git: plan.git,
  };
}

function markerWarnings(plan) {
  if (!plan.git?.git_root || plan.git.marker_tracked) {
    return [];
  }
  return ["marker_untracked"];
}

function inspectMarkerGitState({ workspaceRoot, markerPath }) {
  const rootResult = runGit(["-C", workspaceRoot, "rev-parse", "--show-toplevel"]);
  if (rootResult.status !== 0) {
    return {
      git_root: null,
      marker_tracked: false,
      marker_status: null,
    };
  }

  const gitRoot = canonicalizePath(rootResult.stdout.trim());
  const markerRelativePath = path.relative(gitRoot, canonicalizePath(markerPath));
  const markerTracked = runGit([
    "-C",
    gitRoot,
    "ls-files",
    "--error-unmatch",
    "--",
    markerRelativePath,
  ]).status === 0;
  const markerStatus = runGit([
    "-C",
    gitRoot,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    markerRelativePath,
  ]).stdout.trim();

  return {
    git_root: gitRoot,
    marker_tracked: markerTracked,
    marker_status: markerStatus || null,
  };
}

function runGit(args) {
  return childProcess.spawnSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function canonicalizePath(filePath) {
  if (fs.existsSync(filePath)) {
    return fs.realpathSync(filePath);
  }
  return path.join(
    fs.realpathSync(path.dirname(filePath)),
    path.basename(filePath),
  );
}

function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function withoutCatalogs(value) {
  const { catalogs, ...rest } = value;
  return rest;
}

function emptyRecordCounts() {
  return {
    evidence: 0,
    cases: 0,
    invariants: 0,
    tactics: 0,
    parameter_definitions: 0,
    parameter_observations: 0,
  };
}

function sumRecordCounts(counts) {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

function compareWorkspaceEntries(left, right) {
  return left.workspaceId.localeCompare(right.workspaceId)
    || left.workspaceRoot.localeCompare(right.workspaceRoot);
}

function isDirectory(filePath) {
  return fs.existsSync(filePath) && fs.statSync(filePath).isDirectory();
}

function isWritable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function isWritableArtifactRoot(filePath) {
  let currentPath = path.resolve(filePath);
  while (!fs.existsSync(currentPath)) {
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return false;
    }
    currentPath = parentPath;
  }
  return fs.statSync(currentPath).isDirectory() && isWritable(currentPath);
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

module.exports = {
  DEFAULT_INSTALLED_SKILL_ROOT,
  MARKER_FILENAME,
  REQUIRED_SKILL_FILES,
  buildWorkspaceRecordCounts,
  inspectRegisteredProjectMemory,
  planRegisteredProjectMemoryMarkers,
  syncRegisteredProjectMemoryMarkers,
};
