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
const DEFAULT_SNAPSHOT_RETENTION = 14;
const DEFAULT_DIFF_RETENTION = 90;
const SNAPSHOT_MANIFEST_SCHEMA_VERSION = 1;
const MAX_SNAPSHOT_CACHE_ENTRIES = 2;
const snapshotCache = new Map();

function refreshSupportGraph({
  catalogRoot = DEFAULT_CATALOG_ROOT,
  graphRoot = DEFAULT_GRAPH_ROOT,
  dryRun = false,
  builtAt = new Date().toISOString(),
  snapshotRetention = DEFAULT_SNAPSHOT_RETENTION,
  diffRetention = DEFAULT_DIFF_RETENTION,
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
    writeLatestManifest({
      graphRoot: resolvedGraphRoot,
      snapshot,
      snapshotPath,
    });
    snapshotCache.delete(path.resolve(snapshotPath));

    if (diff) {
      diffPath = path.join(resolvedGraphRoot, "diffs", `${diff.diff_id}.json`);
      writeJson(diffPath, diff);
      writeJson(path.join(resolvedGraphRoot, "latest-diff.json"), diff);
    }
  }

  if (!dryRun && !changed && previousSnapshot && !loadLatestManifest({ graphRoot: resolvedGraphRoot })) {
    const previousSnapshotPath = path.join(
      resolvedGraphRoot,
      "snapshots",
      `${previousSnapshot.build_id}.json`,
    );
    if (fs.existsSync(previousSnapshotPath)) {
      writeLatestManifest({
        graphRoot: resolvedGraphRoot,
        snapshot: previousSnapshot,
        snapshotPath: previousSnapshotPath,
      });
    }
  }

  const retention = dryRun
    ? {
      snapshots_removed: 0,
      diffs_removed: 0,
    }
    : applySupportGraphRetention({
      graphRoot: resolvedGraphRoot,
      snapshotRetention,
      diffRetention,
    });

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
    retention,
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

function loadLatestManifest({ graphRoot = DEFAULT_GRAPH_ROOT } = {}) {
  const manifestPath = path.join(path.resolve(graphRoot), "latest-manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  return readJson(manifestPath);
}

function loadSnapshot({ snapshotPath, graphRoot = DEFAULT_GRAPH_ROOT } = {}) {
  if (snapshotPath) {
    return readJson(path.resolve(snapshotPath));
  }

  return loadLatestSnapshot({ graphRoot });
}

function loadFreshSnapshot({ graphRoot = DEFAULT_GRAPH_ROOT, catalogs, snapshotPath } = {}) {
  if (!catalogs) {
    return null;
  }

  try {
    const expectedBasisHash = createSupportGraphBasisHash(catalogs);
    if (snapshotPath) {
      const snapshot = loadCachedSnapshot(path.resolve(snapshotPath));
      return snapshot?.basis_hash === expectedBasisHash ? snapshot : null;
    }

    const manifest = loadLatestManifest({ graphRoot });
    if (manifest) {
      if (manifest.basis_hash !== expectedBasisHash) {
        return null;
      }

      const resolvedSnapshotPath = path.resolve(
        path.resolve(graphRoot),
        manifest.snapshot_path,
      );
      const snapshot = loadCachedSnapshot(resolvedSnapshotPath);
      return snapshot?.basis_hash === expectedBasisHash ? snapshot : null;
    }

    const snapshot = loadLatestSnapshot({ graphRoot });
    return snapshot?.basis_hash === expectedBasisHash ? snapshot : null;
  } catch {
    return null;
  }
}

function isSupportGraphSnapshotFresh({ snapshot, catalogs } = {}) {
  if (!snapshot?.basis_hash || !catalogs) {
    return false;
  }

  return snapshot.basis_hash === createSupportGraphBasisHash(catalogs);
}

function writeJson(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function writeLatestManifest({ graphRoot, snapshot, snapshotPath }) {
  const resolvedGraphRoot = path.resolve(graphRoot);
  writeJson(path.join(resolvedGraphRoot, "latest-manifest.json"), {
    schema_version: SNAPSHOT_MANIFEST_SCHEMA_VERSION,
    build_id: snapshot.build_id,
    built_at: snapshot.built_at,
    basis_hash: snapshot.basis_hash,
    fingerprint: snapshot.fingerprint,
    node_count: snapshot.node_count,
    edge_count: snapshot.edge_count,
    snapshot_path: path.relative(resolvedGraphRoot, snapshotPath),
  });
}

function loadCachedSnapshot(snapshotPath) {
  if (!fs.existsSync(snapshotPath)) {
    snapshotCache.delete(snapshotPath);
    return null;
  }

  const stat = fs.statSync(snapshotPath);
  const cached = snapshotCache.get(snapshotPath);
  if (cached?.mtimeMs === stat.mtimeMs && cached?.size === stat.size) {
    snapshotCache.delete(snapshotPath);
    snapshotCache.set(snapshotPath, cached);
    return cached.snapshot;
  }

  const snapshot = readJson(snapshotPath);
  snapshotCache.set(snapshotPath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    snapshot,
  });
  while (snapshotCache.size > MAX_SNAPSHOT_CACHE_ENTRIES) {
    snapshotCache.delete(snapshotCache.keys().next().value);
  }
  return snapshot;
}

function applySupportGraphRetention({
  graphRoot = DEFAULT_GRAPH_ROOT,
  snapshotRetention = DEFAULT_SNAPSHOT_RETENTION,
  diffRetention = DEFAULT_DIFF_RETENTION,
} = {}) {
  const resolvedGraphRoot = path.resolve(graphRoot);
  const protectedSnapshotPaths = new Set();
  const protectedDiffPaths = new Set();
  try {
    const manifest = loadLatestManifest({ graphRoot: resolvedGraphRoot });
    if (manifest?.snapshot_path) {
      protectedSnapshotPaths.add(path.resolve(resolvedGraphRoot, manifest.snapshot_path));
    }
  } catch {
    // Retention must not delete through an unreadable manifest.
    return {
      snapshots_removed: 0,
      diffs_removed: 0,
    };
  }
  try {
    const latestDiff = loadLatestDiff({ graphRoot: resolvedGraphRoot });
    if (latestDiff?.diff_id) {
      protectedDiffPaths.add(path.join(resolvedGraphRoot, "diffs", `${latestDiff.diff_id}.json`));
    }
  } catch {
    // A malformed latest diff is not authority to prune its history.
    return {
      snapshots_removed: 0,
      diffs_removed: 0,
    };
  }

  return {
    snapshots_removed: pruneJsonFiles({
      directory: path.join(resolvedGraphRoot, "snapshots"),
      retention: normalizeRetentionLimit(snapshotRetention, DEFAULT_SNAPSHOT_RETENTION),
      protectedPaths: protectedSnapshotPaths,
    }),
    diffs_removed: pruneJsonFiles({
      directory: path.join(resolvedGraphRoot, "diffs"),
      retention: normalizeRetentionLimit(diffRetention, DEFAULT_DIFF_RETENTION),
      protectedPaths: protectedDiffPaths,
    }),
  };
}

function pruneJsonFiles({ directory, retention, protectedPaths = new Set() }) {
  if (!fs.existsSync(directory)) {
    return 0;
  }

  const entries = fs.readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => {
      const filePath = path.join(directory, entry);
      const stat = fs.statSync(filePath);
      return {
        filePath,
        name: entry,
        mtimeMs: stat.mtimeMs,
      };
    })
    .sort((left, right) =>
      right.mtimeMs - left.mtimeMs
      || right.name.localeCompare(left.name));

  const protectedEntries = entries.filter((entry) =>
    protectedPaths.has(path.resolve(entry.filePath)));
  const availableSlots = Math.max(0, retention - protectedEntries.length);
  const keptPaths = new Set([
    ...protectedEntries.map((entry) => path.resolve(entry.filePath)),
    ...entries
      .filter((entry) => !protectedPaths.has(path.resolve(entry.filePath)))
      .slice(0, availableSlots)
      .map((entry) => path.resolve(entry.filePath)),
  ]);
  const removals = entries.filter((entry) => !keptPaths.has(path.resolve(entry.filePath)));
  for (const entry of removals) {
    fs.rmSync(entry.filePath, { force: true });
    snapshotCache.delete(path.resolve(entry.filePath));
  }
  return removals.length;
}

function normalizeRetentionLimit(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
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
  DEFAULT_DIFF_RETENTION,
  DEFAULT_GRAPH_ROOT,
  MAX_SNAPSHOT_CACHE_ENTRIES,
  DEFAULT_SNAPSHOT_RETENTION,
  applySupportGraphRetention,
  isSupportGraphSnapshotFresh,
  loadFreshSnapshot,
  loadLatestDiff,
  loadLatestManifest,
  loadLatestSnapshot,
  loadSnapshot,
  refreshSupportGraph,
};
