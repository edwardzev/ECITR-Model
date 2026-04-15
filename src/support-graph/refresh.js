const fs = require("node:fs");
const path = require("node:path");

const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const { REPO_ROOT } = require("../validation/schema-registry");
const { readJson } = require("../validation/validator");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { buildSupportGraphSnapshot } = require("./build");
const { createSupportGraphBasisHash } = require("./basis");
const { buildSupportGraphDiff } = require("./diff");

const DEFAULT_GRAPH_ROOT = path.join(REPO_ROOT, ".local", "support-graph");

function refreshSupportGraph({
  catalogRoot = DEFAULT_CATALOG_ROOT,
  graphRoot = DEFAULT_GRAPH_ROOT,
  dryRun = false,
  builtAt = new Date().toISOString(),
  catalog = new FileBackedCatalog({ rootDir: catalogRoot }),
} = {}) {
  const resolvedCatalogRoot = path.resolve(catalogRoot);
  const resolvedGraphRoot = path.resolve(graphRoot);
  const catalogs = catalog.loadRuntimeCatalogs();
  const snapshot = buildSupportGraphSnapshot({
    catalogs,
    builtAt,
  });
  const previousSnapshot = loadLatestSnapshot({ graphRoot: resolvedGraphRoot });
  const structureChanged = !previousSnapshot || previousSnapshot.fingerprint !== snapshot.fingerprint;
  const basisChanged = !previousSnapshot || previousSnapshot.basis_hash !== snapshot.basis_hash;
  const changed = structureChanged || basisChanged;
  const diff = previousSnapshot && structureChanged
    ? buildSupportGraphDiff({
      previousSnapshot,
      nextSnapshot: snapshot,
      generatedAt: builtAt,
    })
    : null;

  let snapshotPath = null;
  let diffPath = null;
  if (!dryRun && changed) {
    fs.mkdirSync(path.join(resolvedGraphRoot, "snapshots"), { recursive: true });
    fs.mkdirSync(path.join(resolvedGraphRoot, "diffs"), { recursive: true });

    snapshotPath = path.join(resolvedGraphRoot, "snapshots", `${snapshot.build_id}.json`);
    writeJson(snapshotPath, snapshot);
    writeJson(path.join(resolvedGraphRoot, "latest.json"), snapshot);

    if (diff) {
      diffPath = path.join(resolvedGraphRoot, "diffs", `${diff.diff_id}.json`);
      writeJson(diffPath, diff);
      writeJson(path.join(resolvedGraphRoot, "latest-diff.json"), diff);
    }
  }

  return {
    dry_run: dryRun,
    status: determineStatus({ dryRun, changed, hadPrevious: Boolean(previousSnapshot) }),
    catalog_root: resolvedCatalogRoot,
    graph_root: resolvedGraphRoot,
    snapshot_build_id: snapshot.build_id,
    previous_snapshot_build_id: previousSnapshot?.build_id ?? null,
    changed,
    node_count: snapshot.node_count,
    edge_count: snapshot.edge_count,
    fingerprint: snapshot.fingerprint,
    basis_hash: snapshot.basis_hash,
    snapshot_path: snapshotPath,
    diff_path: diffPath,
    diff_summary: diff?.summary ?? null,
  };
}

function loadLatestSnapshot({ graphRoot = DEFAULT_GRAPH_ROOT } = {}) {
  const latestPath = path.join(path.resolve(graphRoot), "latest.json");
  if (!fs.existsSync(latestPath)) {
    return null;
  }

  return readJson(latestPath);
}

function loadLatestDiff({ graphRoot = DEFAULT_GRAPH_ROOT } = {}) {
  const latestPath = path.join(path.resolve(graphRoot), "latest-diff.json");
  if (!fs.existsSync(latestPath)) {
    return null;
  }

  return readJson(latestPath);
}

function loadSnapshot({ snapshotPath, graphRoot = DEFAULT_GRAPH_ROOT } = {}) {
  if (snapshotPath) {
    return readJson(path.resolve(snapshotPath));
  }

  return loadLatestSnapshot({ graphRoot });
}

function loadFreshSnapshot({ graphRoot = DEFAULT_GRAPH_ROOT, catalogs, snapshotPath } = {}) {
  const snapshot = loadSnapshot({ snapshotPath, graphRoot });
  if (!snapshot) {
    return null;
  }

  if (!isSupportGraphSnapshotFresh({ snapshot, catalogs })) {
    return null;
  }

  return snapshot;
}

function isSupportGraphSnapshotFresh({ snapshot, catalogs } = {}) {
  if (!snapshot?.basis_hash || !catalogs) {
    return false;
  }

  return snapshot.basis_hash === createSupportGraphBasisHash(catalogs);
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function determineStatus({ dryRun, changed, hadPrevious }) {
  if (dryRun) {
    return changed ? "dry_run_would_update" : "dry_run_unchanged";
  }

  if (!hadPrevious) {
    return "initialized";
  }

  return changed ? "updated" : "unchanged";
}

module.exports = {
  DEFAULT_GRAPH_ROOT,
  isSupportGraphSnapshotFresh,
  loadFreshSnapshot,
  loadLatestDiff,
  loadLatestSnapshot,
  loadSnapshot,
  refreshSupportGraph,
};
