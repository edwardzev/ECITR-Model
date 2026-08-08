const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DEFAULT_SUPPORT_GRAPH_ROOT,
  promoteApprovedBenchmarkCandidates,
  resolveLanceDbUri,
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
    skipLanceDbSync: true,
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

  let caseBatchCalled = false;
  let liveCandidateStageCalled = false;
  await assert.rejects(
    runGovernedPromotion({
      catalogRoot: rootDir,
      reportDir: path.join(rootDir, "reports"),
      dryRun: true,
      caseBatchRunner() {
        caseBatchCalled = true;
        return { batch_id: "batch-999", total_cases: 0, approved: 0, errors: 0, results: [] };
      },
      liveCandidateGenerator() {
        liveCandidateStageCalled = true;
        return {};
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
  assert.equal(caseBatchCalled, false);
  assert.equal(liveCandidateStageCalled, false);
});

test("governed promotion stages and processes live candidates alongside benchmark replay", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-governed-promotion-"));
  const manifestPath = path.join(rootDir, "empty.json");
  const reportDir = path.join(rootDir, "reports");
  const events = [];

  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({ entries: [] }, null, 2)}\n`,
    "utf8",
  );

  const result = await runGovernedPromotion({
    catalogRoot: rootDir,
    reportDir,
    dryRun: false,
    skipLanceDbSync: true,
    caseBatchRunner() {
      events.push("cases");
      return {
        batch_id: "batch-live",
        total_cases: 0,
        approved: 0,
        errors: 0,
        results: [],
      };
    },
    invariantManifestPath: manifestPath,
    tacticManifestPath: manifestPath,
    invariantBenchmarkRunner() {
      events.push("invariant-benchmark");
      return createCleanBenchmark("invariant-bench");
    },
    tacticBenchmarkRunner() {
      events.push("tactic-benchmark");
      return createCleanBenchmark("tactic-bench");
    },
    liveCandidateGenerator() {
      events.push("live-stage");
      return {
        generated_at: "2099-01-01T00:00:00.000Z",
        invariants: { generated_count: 1 },
        tactics: { generated_count: 0 },
      };
    },
    liveCandidateProcessor() {
      events.push("live-process");
      return {
        invariants: { activated_count: 0, judge_skipped_count: 1 },
        tactics: { activated_count: 0, judge_skipped_count: 0 },
        warnings: [
          {
            stage: "live_promotions",
            message: "judge unavailable",
            details: null,
          },
        ],
      };
    },
    invariantReviewSurface: createFakeReviewSurface({
      kind: "invariant",
      identities: {},
    }),
    tacticReviewSurface: createFakeReviewSurface({
      kind: "tactic",
      identities: {},
    }),
  });

  assert.deepEqual(events, ["invariant-benchmark", "tactic-benchmark", "cases", "live-stage", "live-process"]);
  assert.equal(result.live_candidates.invariants.generated_count, 1);
  assert.equal(result.live_promotions.invariants.judge_skipped_count, 1);
  assert.equal(result.warnings.length, 1);
});

test("governed promotion report makes invariant and tactic counts independent", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-governed-promotion-"));
  const manifestPath = path.join(rootDir, "empty.json");
  const reportDir = path.join(rootDir, "reports");
  fs.mkdirSync(path.join(rootDir, "invariants"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "tactics"), { recursive: true });

  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({ entries: [] }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "invariants", "inv_active.json"),
    `${JSON.stringify({ id: "inv_active", status: "active" }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "tactics", "tac_direct.json"),
    `${JSON.stringify({
      id: "tac_direct",
      status: "active",
      promotion_basis: "case_cluster",
      supporting_invariant_refs: [],
    }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "tactics", "tac_backed.json"),
    `${JSON.stringify({
      id: "tac_backed",
      status: "active",
      promotion_basis: "invariant_backed",
      supporting_invariant_refs: ["inv_active"],
    }, null, 2)}\n`,
    "utf8",
  );

  const result = await runGovernedPromotion({
    catalogRoot: rootDir,
    reportDir,
    dryRun: false,
    skipLanceDbSync: true,
    caseBatchRunner() {
      return {
        batch_id: "batch-independent-counts",
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
    liveCandidateGenerator() {
      return {
        generated_at: "2099-01-01T00:00:00.000Z",
        invariants: { generated_count: 4 },
        tactics: { generated_count: 2 },
      };
    },
    liveCandidateProcessor() {
      return {
        activation_caps: { invariants: 3, tactics: 5 },
        invariants: {
          activated_count: 1,
          retired_count: 2,
          judge_skipped_count: 0,
          cap_skipped_count: 1,
        },
        tactics: {
          activated_count: 0,
          retired_count: 2,
          judge_skipped_count: 0,
          cap_skipped_count: 0,
        },
        warnings: [],
      };
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
      return {
        status: "updated",
        changed: false,
        node_count: 0,
        edge_count: 0,
      };
    },
  });

  assert.equal(result.promotion_interpretation.layer_counts_are_independent, true);
  assert.equal(result.promotion_interpretation.count_parity_is_not_health_target, true);
  assert.deepEqual(result.promotion_interpretation.active_counts, {
    invariants: 1,
    tactics: 2,
  });
  assert.deepEqual(result.promotion_interpretation.tactic_support_shape, {
    direct_case_cluster_count: 1,
    invariant_backed_count: 1,
    unknown_support_count: 0,
  });
  assert.deepEqual(result.promotion_interpretation.current_run.activation_caps, {
    invariants: 3,
    tactics: 5,
  });
  assert.deepEqual(result.promotion_interpretation.current_run.live_activated, {
    invariants: 1,
    tactics: 0,
  });
  assert.equal(result.promotion_interpretation.recent_activation_history.at(-1).run_id, result.run_id);
});

test("governed promotion isolates default support graph output for non-default catalog roots", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-governed-promotion-"));
  const manifestPath = path.join(rootDir, "empty.json");
  const reportDir = path.join(rootDir, "reports");
  let observedGraphRoot = null;
  let observedCatalogRoot = null;

  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({ entries: [] }, null, 2)}\n`,
    "utf8",
  );

  await runGovernedPromotion({
    catalogRoot: rootDir,
    reportDir,
    dryRun: false,
    skipLanceDbSync: true,
    caseBatchRunner() {
      return {
        batch_id: "batch-isolated-graph",
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
    supportGraphRefresher({ graphRoot, catalogRoot }) {
      observedGraphRoot = graphRoot;
      observedCatalogRoot = catalogRoot;
      return {
        status: "updated",
        changed: true,
        node_count: 0,
        edge_count: 0,
      };
    },
  });

  assert.equal(observedCatalogRoot, rootDir);
  assert.equal(observedGraphRoot, path.join(rootDir, ".local", "support-graph"));
  assert.notEqual(observedGraphRoot, DEFAULT_SUPPORT_GRAPH_ROOT);
});

test("non-default catalogs receive an isolated LanceDB root", () => {
  assert.equal(
    resolveLanceDbUri({
      catalogRoot: "/tmp/ecitr-fixture/.local/catalog",
    }),
    path.resolve("/tmp/ecitr-fixture/.local/lancedb"),
  );
  assert.equal(
    resolveLanceDbUri({
      catalogRoot: "/tmp/ecitr-fixture/catalog",
      lancedbUri: "/tmp/explicit-lancedb",
    }),
    path.resolve("/tmp/explicit-lancedb"),
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

test("governed promotion refreshes the support graph before LanceDB sync", async () => {
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
    syncLanceDbCatalog() {
      events.push("lancedb");
      return {
        status: "synced",
      };
    },
  });

  assert.deepEqual(events, ["graph", "lancedb"]);
  assert.equal(result.support_graph.status, "updated");
  assert.equal(result.lancedb_sync.status, "synced");
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
