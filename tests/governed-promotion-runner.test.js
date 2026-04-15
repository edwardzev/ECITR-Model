const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  promoteApprovedBenchmarkCandidates,
  runGovernedPromotion,
} = require("../src/runtime/governed-promotion-runner");

test("governed promotion promotes approved benchmark candidates and skips active ones", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-governed-promotion-"));
  const manifestPath = path.join(rootDir, "invariants.json");
  const tacticManifestPath = path.join(rootDir, "tactics.json");
  const reportDir = path.join(rootDir, "reports");

  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({
      entries: [
        { label: "promote_me", expected_decision: "approve" },
        { label: "already_live", expected_decision: "approve" },
        { label: "ignore_block", expected_decision: "block" },
      ],
    }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    tacticManifestPath,
    `${JSON.stringify({ entries: [] }, null, 2)}\n`,
    "utf8",
  );

  const promotedLabels = [];
  const invariantReviewSurface = createFakeReviewSurface({
    kind: "invariant",
    identities: {
      promote_me: { proposedId: "inv_promote_me", status: null },
      already_live: { proposedId: "inv_already_live", status: "active" },
    },
    onPromote(entry) {
      promotedLabels.push(entry.label);
      return { dry_run: false };
    },
  });

  const tacticReviewSurface = createFakeReviewSurface({
    kind: "tactic",
    identities: {},
  });

  const result = await runGovernedPromotion({
    catalogRoot: rootDir,
    reportDir,
    dryRun: false,
    skipQdrantSync: true,
    caseBatchRunner() {
      return {
        batch_id: "batch-999",
        total_cases: 0,
        approved: 0,
        errors: 0,
        results: [],
      };
    },
    invariantManifestPath: manifestPath,
    tacticManifestPath,
    invariantBenchmarkRunner() {
      return createCleanBenchmark("invariant-bench");
    },
    tacticBenchmarkRunner() {
      return createCleanBenchmark("tactic-bench");
    },
    invariantReviewSurface,
    tacticReviewSurface,
  });

  assert.deepEqual(promotedLabels, ["promote_me"]);
  assert.equal(result.invariants.promoted_count, 1);
  assert.equal(result.invariants.skipped_count, 1);
  assert.equal(result.invariants.promoted[0].proposed_id, "inv_promote_me");
  assert.equal(result.invariants.skipped[0].proposed_id, "inv_already_live");
  assert.equal(result.qdrant_sync.status, "skipped");
  assert.ok(result.output_path);
  assert.ok(fs.existsSync(result.output_path));
});

test("governed promotion blocks when a benchmark is not clean", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-governed-promotion-"));
  const manifestPath = path.join(rootDir, "invariants.json");

  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({ entries: [{ label: "candidate_a", expected_decision: "approve" }] }, null, 2)}\n`,
    "utf8",
  );

  await assert.rejects(
    runGovernedPromotion({
      catalogRoot: rootDir,
      reportDir: path.join(rootDir, "reports"),
      dryRun: true,
      skipQdrantSync: true,
      caseBatchRunner() {
        return { batch_id: "batch-999", total_cases: 0, approved: 0, errors: 0, results: [] };
      },
      invariantManifestPath: manifestPath,
      tacticManifestPath: manifestPath,
      invariantBenchmarkRunner() {
        return {
          ...createCleanBenchmark("invariant-bench"),
          mismatches_expected: 1,
        };
      },
      tacticBenchmarkRunner() {
        return createCleanBenchmark("tactic-bench");
      },
      invariantReviewSurface: createFakeReviewSurface({
        kind: "invariant",
        identities: { candidate_a: { proposedId: "inv_a", status: null } },
      }),
      tacticReviewSurface: createFakeReviewSurface({
        kind: "tactic",
        identities: {},
      }),
    }),
    /invariant discovery benchmark is not clean/,
  );
});

test("candidate promotion helper records blocked promotions without aborting the section", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-governed-promotion-"));
  const manifestPath = path.join(rootDir, "tactics.json");

  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({
      entries: [
        { label: "good", expected_decision: "approve" },
        { label: "bad", expected_decision: "approve" },
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  const result = await promoteApprovedBenchmarkCandidates({
    kind: "tactic",
    manifestPath,
    benchmarkRunner() {
      return createCleanBenchmark("tactic-bench");
    },
    reviewSurface: createFakeReviewSurface({
      kind: "tactic",
      identities: {
        good: { proposedId: "tac_good", status: null },
        bad: { proposedId: "tac_bad", status: null },
      },
      onPromote(entry) {
        if (entry.label === "bad") {
          throw new Error("candidate is not promotion-ready");
        }
        return { dry_run: true };
      },
    }),
    catalogRoot: rootDir,
    reviewer: "tester",
    reviewedAt: "2099-01-01T00:00:00.000Z",
    rationale: "test rationale",
    dryRun: true,
  });

  assert.equal(result.promoted_count, 1);
  assert.equal(result.blocked_count, 1);
  assert.equal(result.blocked[0].label, "bad");
  assert.equal(result.blocked[0].proposed_id, "tac_bad");
});

test("governed promotion refreshes the support graph before downstream sync", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-governed-promotion-"));
  const manifestPath = path.join(rootDir, "empty.json");
  const events = [];

  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({ entries: [] }, null, 2)}\n`,
    "utf8",
  );

  const result = await runGovernedPromotion({
    catalogRoot: rootDir,
    reportDir: path.join(rootDir, "reports"),
    supportGraphRoot: path.join(rootDir, "support-graph"),
    dryRun: false,
    skipQdrantSync: false,
    caseBatchRunner() {
      return {
        batch_id: "batch-graph-order",
        total_cases: 0,
        approved: 0,
        errors: 0,
        results: [],
      };
    },
    invariantManifestPath: manifestPath,
    tacticManifestPath: manifestPath,
    invariantBenchmarkRunner() {
      return createCleanBenchmark("invariant-bench");
    },
    tacticBenchmarkRunner() {
      return createCleanBenchmark("tactic-bench");
    },
    invariantReviewSurface: createFakeReviewSurface({
      kind: "invariant",
      identities: {},
    }),
    tacticReviewSurface: createFakeReviewSurface({
      kind: "tactic",
      identities: {},
    }),
    supportGraphRefresher() {
      events.push("graph");
      return {
        status: "updated",
        changed: true,
        node_count: 0,
        edge_count: 0,
      };
    },
    syncCatalog() {
      events.push("qdrant");
      return {
        status: "synced",
      };
    },
  });

  assert.deepEqual(events, ["graph", "qdrant"]);
  assert.equal(result.support_graph.status, "updated");
});

function createCleanBenchmark(benchmarkId) {
  return {
    benchmark_id: benchmarkId,
    total_entries: 1,
    matches_expected: 1,
    mismatches_expected: 0,
    false_positives: 0,
    false_negatives: 0,
    results: [],
  };
}

function createFakeReviewSurface({ kind, identities, onPromote } = {}) {
  return {
    discovery: {
      preparePromotionPacket(entry) {
        const identity = identities?.[entry.label];
        if (!identity) {
          throw new Error(`unknown candidate: ${entry.label}`);
        }

        return {
          packet: kind === "invariant"
            ? { proposed_invariant_id: identity.proposedId }
            : { proposed_tactic_id: identity.proposedId },
        };
      },
    },
    catalog: {
      getRecord(_recordType, recordId) {
        const identity = Object.values(identities ?? {}).find((candidate) => candidate.proposedId === recordId);
        return identity?.status ? { id: recordId, status: identity.status } : null;
      },
    },
    promoteCandidate({ entry }) {
      try {
        return onPromote ? onPromote(entry) : { dry_run: false };
      } catch (error) {
        const packet = this.discovery.preparePromotionPacket(entry);
        error.proposed_id = kind === "invariant"
          ? packet.packet.proposed_invariant_id
          : packet.packet.proposed_tactic_id;
        throw error;
      }
    },
  };
}
