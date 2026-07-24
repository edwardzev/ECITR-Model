const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const {
  buildParameterIndexes,
  getObservationsForRecord,
} = require("../src/parameters/retrieval");
const { buildSupportGraphSnapshot } = require("../src/support-graph/build");
const { buildSupportGraphDiff } = require("../src/support-graph/diff");
const { expandRelated, findShortestPath, listNeighbors } = require("../src/support-graph/query");
const {
  loadFreshSnapshot,
  loadLatestDiff,
  loadLatestManifest,
  loadLatestSnapshot,
  refreshSupportGraph,
} = require("../src/support-graph/refresh");
const { buildExampleCatalog } = require("./helpers/example-catalog");
const { loadExample } = require("./helpers/load-example");

test("support-graph snapshot is deterministic for the example catalog", () => {
  const builtAt = "2026-04-15T10:00:00.000Z";
  const first = buildSupportGraphSnapshot({
    catalogs: buildExampleCatalog(),
    builtAt,
  });
  const second = buildSupportGraphSnapshot({
    catalogs: buildExampleCatalog(),
    builtAt,
  });

  assert.deepEqual(first, second);
  assert.equal(first.node_count, 8);
  assert.ok(first.edges.some((edge) => edge.kind === "evidence_parameter_observation"));
  assert.ok(first.edges.some((edge) => edge.kind === "tactic_supporting_invariant"));
});

test("support-graph query helpers return neighbors, shortest paths, and related canonical records", () => {
  const snapshot = buildSupportGraphSnapshot({
    catalogs: buildExampleCatalog(),
    builtAt: "2026-04-15T10:05:00.000Z",
  });

  const neighbors = listNeighbors({
    snapshot,
    nodeId: "tac_metadata_prune_before_vector_rank_001",
  });
  assert.ok(neighbors.some((entry) => entry.node.record_id === "case_retrieval_scope_drift_001"));
  assert.ok(neighbors.some((entry) => entry.node.record_id === "inv_scope_filter_before_rank_001"));

  const pathResult = findShortestPath({
    snapshot,
    from: "tac_metadata_prune_before_vector_rank_001",
    to: "paramdef_d69439bfc78f10ee3367",
  });
  assert.deepEqual(pathResult.node_path, [
    "tactic:tac_metadata_prune_before_vector_rank_001",
    "parameter_observation:paramobs_01041f2d5c6ded7a1520",
    "parameter_definition:paramdef_d69439bfc78f10ee3367",
  ]);

  const related = expandRelated({
    snapshot,
    nodeId: "ev_mem_20260410_001",
    maxDepth: 2,
  });
  assert.ok(related.some((entry) => entry.node.record_id === "case_retrieval_scope_drift_001"));
  assert.ok(related.some((entry) => entry.node.record_id === "tac_metadata_prune_before_vector_rank_001"));
});

test("support-graph queries suppress wrong-workspace nodes when a workspace filter is provided", () => {
  const catalogs = buildExampleCatalog();
  catalogs.tactics[0].workspace_id = "workspace_other";
  const snapshot = buildSupportGraphSnapshot({
    catalogs,
    builtAt: "2026-04-15T10:06:00.000Z",
  });

  const neighbors = listNeighbors({
    snapshot,
    nodeId: "case_retrieval_scope_drift_001",
    workspaceId: "ecitr_model",
  });

  assert.ok(neighbors.every((entry) => entry.node.workspace_id === "ecitr_model" || entry.node.workspace_id == null));
  assert.ok(!neighbors.some((entry) => entry.node.record_id === "tac_metadata_prune_before_vector_rank_001"));
});

test("support graph preserves declared evidence refs and adds correction-leaf support", () => {
  const catalogs = buildExampleCatalog();
  const original = catalogs.evidence[0];
  original.workspace_id = "legacy_workspace";
  const corrected = {
    ...structuredClone(original),
    evidence_id: "ev_mem_20260410_001_corrected",
    correction_of: original.evidence_id,
    workspace_id: "ecitr_model",
    captured_at: "2026-04-11T12:00:00.000Z",
  };
  catalogs.evidence.push(corrected);

  const snapshot = buildSupportGraphSnapshot({
    catalogs,
    builtAt: "2026-04-15T10:07:00.000Z",
  });
  const neighbors = listNeighbors({
    snapshot,
    nodeId: catalogs.cases[0].case_id,
    workspaceId: "ecitr_model",
  });

  assert.ok(snapshot.edges.some((edge) =>
    edge.kind === "case_evidence"
    && edge.to === `evidence:${original.evidence_id}`));
  assert.ok(neighbors.some((entry) =>
    entry.edge.kind === "case_current_evidence"
    && entry.node.record_id === corrected.evidence_id));

  const indexes = buildParameterIndexes({
    ...catalogs,
    evidence: [corrected],
  });
  assert.deepEqual(
    getObservationsForRecord("cases", catalogs.cases[0], indexes),
    [],
  );
});

test("support-graph refresh writes snapshots, skips unchanged graphs, and emits diffs for structural changes", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-support-graph-"));
  const graphRoot = path.join(rootDir, "support-graph");
  const catalog = new FileBackedCatalog({ rootDir });

  for (const recordType of [
    "evidence",
    "case",
    "invariant",
    "tactic",
    "atomic_claim_set",
    "parameter_definition",
    "parameter_observation",
  ]) {
    catalog.writeRecord(recordType, loadExample(recordType));
  }

  const first = refreshSupportGraph({
    catalogRoot: rootDir,
    graphRoot,
    builtAt: "2026-04-15T10:10:00.000Z",
  });
  assert.equal(first.status, "initialized");
  assert.equal(first.changed, true);
  assert.ok(first.snapshot_path);
  assert.ok(fs.existsSync(first.snapshot_path));

  const second = refreshSupportGraph({
    catalogRoot: rootDir,
    graphRoot,
    builtAt: "2026-04-15T10:11:00.000Z",
  });
  assert.equal(second.status, "unchanged");
  assert.equal(second.changed, false);

  const addedEvidence = structuredClone(loadExample("evidence"));
  addedEvidence.evidence_id = "ev_support_graph_added_001";
  addedEvidence.substrate_ref = "file:///tmp/support-graph-added.json";
  addedEvidence.source_locator = "/tmp/support-graph-added.json";
  addedEvidence.verbatim_payload_ref = "payloads/evidence/tests/support-graph/2026/04/ev_support_graph_added_001.json";
  addedEvidence.payload_hash = "sha256:support-graph-added";
  addedEvidence.source_hash = "sha256:support-graph-added";
  catalog.writeRecord("evidence", addedEvidence);

  const third = refreshSupportGraph({
    catalogRoot: rootDir,
    graphRoot,
    builtAt: "2026-04-15T10:12:00.000Z",
  });
  assert.equal(third.status, "updated");
  assert.equal(third.changed, true);
  assert.ok(third.diff_path);
  assert.ok(third.diff_summary.added_nodes >= 2);

  const latestSnapshot = loadLatestSnapshot({ graphRoot });
  const latestManifest = loadLatestManifest({ graphRoot });
  const latestDiff = loadLatestDiff({ graphRoot });
  assert.equal(latestSnapshot.build_id, third.snapshot_build_id);
  assert.equal(latestManifest.build_id, third.snapshot_build_id);
  assert.equal(latestManifest.basis_hash, third.basis_hash);
  assert.equal(latestDiff.next_snapshot_build_id, third.snapshot_build_id);
});

test("support-graph freshness rejects a stale manifest before loading the snapshot", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-support-graph-fast-stale-"));
  const graphRoot = path.join(rootDir, "support-graph");
  const catalogs = buildExampleCatalog();
  const catalog = new FileBackedCatalog({ rootDir });

  for (const [recordType, records] of [
    ["evidence", catalogs.evidence],
    ["case", catalogs.cases],
    ["invariant", catalogs.invariants],
    ["tactic", catalogs.tactics],
    ["atomic_claim_set", catalogs.atomic_claim_sets],
    ["parameter_definition", catalogs.parameter_definitions],
    ["parameter_observation", catalogs.parameter_observations],
  ]) {
    for (const record of records) {
      catalog.writeRecord(recordType, record);
    }
  }

  refreshSupportGraph({ catalogRoot: rootDir, graphRoot });
  fs.writeFileSync(
    path.join(graphRoot, "snapshots", loadLatestManifest({ graphRoot }).build_id + ".json"),
    "{invalid-json",
    "utf8",
  );
  catalogs.tactics[0].revalidate_at = "2026-08-01T00:00:00Z";

  assert.equal(loadFreshSnapshot({ graphRoot, catalogs }), null);
});

test("support-graph retention bounds snapshots and diffs while preserving latest", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-support-graph-retention-"));
  const graphRoot = path.join(rootDir, "support-graph");
  const catalog = new FileBackedCatalog({ rootDir });

  for (const recordType of [
    "evidence",
    "case",
    "invariant",
    "tactic",
    "atomic_claim_set",
    "parameter_definition",
    "parameter_observation",
  ]) {
    catalog.writeRecord(recordType, loadExample(recordType));
  }

  let latest = null;
  for (let index = 0; index < 4; index += 1) {
    const evidence = structuredClone(loadExample("evidence"));
    evidence.evidence_id = `ev_support_graph_retention_${index}`;
    evidence.substrate_ref = `file:///tmp/support-graph-retention-${index}.json`;
    evidence.source_locator = `/tmp/support-graph-retention-${index}.json`;
    evidence.verbatim_payload_ref = `payloads/evidence/tests/support-graph/retention-${index}.json`;
    evidence.payload_hash = `sha256:retention-${index}`;
    evidence.source_hash = `sha256:retention-${index}`;
    catalog.writeRecord("evidence", evidence);

    latest = refreshSupportGraph({
      catalogRoot: rootDir,
      graphRoot,
      builtAt: `2026-04-15T10:3${index}:00.000Z`,
      snapshotRetention: 2,
      diffRetention: 2,
    });
  }

  const snapshots = fs.readdirSync(path.join(graphRoot, "snapshots"))
    .filter((entry) => entry.endsWith(".json"));
  const diffs = fs.readdirSync(path.join(graphRoot, "diffs"))
    .filter((entry) => entry.endsWith(".json"));
  const manifest = loadLatestManifest({ graphRoot });

  assert.equal(snapshots.length, 2);
  assert.equal(diffs.length, 2);
  assert.equal(manifest.build_id, latest.snapshot_build_id);
  assert.ok(fs.existsSync(path.join(graphRoot, manifest.snapshot_path)));
});

test("support-graph diff reports edge and neighborhood changes for canonical records", () => {
  const catalogs = buildExampleCatalog();
  const previousSnapshot = buildSupportGraphSnapshot({
    catalogs,
    builtAt: "2026-04-15T10:15:00.000Z",
  });

  const nextCatalogs = buildExampleCatalog();
  nextCatalogs.tactics[0].supporting_invariant_refs = [];
  const nextSnapshot = buildSupportGraphSnapshot({
    catalogs: nextCatalogs,
    builtAt: "2026-04-15T10:16:00.000Z",
  });

  const diff = buildSupportGraphDiff({
    previousSnapshot,
    nextSnapshot,
    generatedAt: "2026-04-15T10:16:30.000Z",
  });

  assert.equal(diff.summary.removed_edges, 1);
  assert.ok(diff.removed_edges.some((edge) => edge.kind === "tactic_supporting_invariant"));
  assert.ok(diff.changed_neighborhoods.some((entry) => entry.node_id === "tactic:tac_metadata_prune_before_vector_rank_001"));
});

test("support-graph refresh rewrites stale basis hashes even when the graph structure is unchanged", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-support-graph-basis-"));
  const graphRoot = path.join(rootDir, "support-graph");
  const catalog = new FileBackedCatalog({ rootDir });

  for (const recordType of [
    "evidence",
    "case",
    "invariant",
    "tactic",
    "atomic_claim_set",
    "parameter_definition",
    "parameter_observation",
  ]) {
    catalog.writeRecord(recordType, loadExample(recordType));
  }

  const first = refreshSupportGraph({
    catalogRoot: rootDir,
    graphRoot,
    builtAt: "2026-04-15T10:20:00.000Z",
  });
  const stored = structuredClone(loadExample("tactic"));
  stored.revalidate_at = "2026-08-01T00:00:00Z";
  catalog.writeRecord("tactic", stored, { overwrite: true });

  const second = refreshSupportGraph({
    catalogRoot: rootDir,
    graphRoot,
    builtAt: "2026-04-15T10:21:00.000Z",
  });

  assert.equal(second.status, "updated");
  assert.equal(second.changed, true);
  assert.equal(second.fingerprint, first.fingerprint);
  assert.notEqual(second.basis_hash, first.basis_hash);
  assert.equal(second.diff_path, null);
  assert.equal(second.diff_summary, null);
});
