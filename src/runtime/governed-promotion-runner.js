const fs = require("node:fs");
const path = require("node:path");

const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const { CaseReviewSurface } = require("../cases/case-review");
const { runCaseBatch } = require("../cases/case-batch-runner");
const { InvariantReviewSurface } = require("../invariants/review");
const { runInvariantDiscoveryBenchmark } = require("../invariants/discovery-benchmark");
const { TacticReviewSurface } = require("../tactics/review");
const { runTacticDiscoveryBenchmark } = require("../tactics/discovery-benchmark");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { reconcileOpenPools } = require("./open-pool-reconciler");
const { REPO_ROOT } = require("../validation/schema-registry");
const { defaultSyncCatalog, DEFAULT_COLLECTION_NAME, DEFAULT_QDRANT_URL } = require("../importers/agent-ops-refresh");

const DEFAULT_INVARIANT_BENCHMARK_MANIFEST = path.join(
  REPO_ROOT,
  ".local",
  "benchmarks",
  "invariant-discovery-benchmark.v1.json",
);
const DEFAULT_TACTIC_BENCHMARK_MANIFEST = path.join(
  REPO_ROOT,
  ".local",
  "benchmarks",
  "tactic-discovery-benchmark.v1.json",
);
const DEFAULT_REPORT_DIR = path.join(REPO_ROOT, ".local", "reports", "governed-promotions");

async function runGovernedPromotion({
  catalogRoot = DEFAULT_CATALOG_ROOT,
  reportDir = DEFAULT_REPORT_DIR,
  invariantManifestPath = DEFAULT_INVARIANT_BENCHMARK_MANIFEST,
  tacticManifestPath = DEFAULT_TACTIC_BENCHMARK_MANIFEST,
  caseBatchLimit = Number.MAX_SAFE_INTEGER,
  reviewer = "autonomous-governance-steward",
  reviewedAt = new Date().toISOString(),
  qdrantUrl = DEFAULT_QDRANT_URL,
  collectionName = DEFAULT_COLLECTION_NAME,
  embedderType = process.env.ECITR_EMBEDDER ?? "openai",
  embeddingModel = process.env.ECITR_EMBEDDING_MODEL,
  denseVectorSize,
  sparseBucketCount = 2048,
  openAIApiKey = process.env.OPENAI_API_KEY,
  openAIBaseUrl = process.env.OPENAI_BASE_URL,
  openAIOrganization = process.env.OPENAI_ORGANIZATION,
  openAIProject = process.env.OPENAI_PROJECT,
  syncCatalog = defaultSyncCatalog,
  dryRun = false,
  skipQdrantSync = false,
  caseBatchRunner = runCaseBatch,
  invariantBenchmarkRunner = runInvariantDiscoveryBenchmark,
  tacticBenchmarkRunner = runTacticDiscoveryBenchmark,
  caseReviewSurface = new CaseReviewSurface({ catalogRoot }),
  invariantReviewSurface = new InvariantReviewSurface({ catalogRoot }),
  tacticReviewSurface = new TacticReviewSurface({ catalogRoot }),
} = {}) {
  const resolvedCatalogRoot = path.resolve(catalogRoot);
  const resolvedReportDir = path.resolve(reportDir);
  const startedAt = new Date().toISOString();

  const report = {
    run_id: createRunId(startedAt),
    started_at: startedAt,
    completed_at: null,
    catalog_root: resolvedCatalogRoot,
    dry_run: dryRun,
    reviewer,
    case_batch: null,
    reconciliation: null,
    invariants: null,
    tactics: null,
    qdrant_sync: null,
  };

  const caseBatch = caseBatchRunner({
    surface: caseReviewSurface,
    limit: caseBatchLimit,
    dryRun,
    reviewer,
    skipPreviouslyBlocked: false,
    rejectErrors: true,
    rejectionRationale: "Autonomous morning reconciliation rejected this draft case because it could not satisfy the current governed case pipeline.",
  });

  report.case_batch = caseBatch;

  const invariantSection = await promoteApprovedBenchmarkCandidates({
    kind: "invariant",
    manifestPath: invariantManifestPath,
    benchmarkRunner: invariantBenchmarkRunner,
    reviewSurface: invariantReviewSurface,
    catalogRoot: resolvedCatalogRoot,
    reviewer,
    reviewedAt,
    rationale: "Autonomous morning promotion run approved a benchmarked invariant candidate.",
    dryRun,
  });
  report.invariants = invariantSection;

  const tacticSection = await promoteApprovedBenchmarkCandidates({
    kind: "tactic",
    manifestPath: tacticManifestPath,
    benchmarkRunner: tacticBenchmarkRunner,
    reviewSurface: tacticReviewSurface,
    catalogRoot: resolvedCatalogRoot,
    reviewer,
    reviewedAt,
    rationale: "Autonomous morning promotion run approved a benchmarked tactic candidate.",
    dryRun,
  });
  report.tactics = tacticSection;

  report.reconciliation = reconcileOpenPools({
    catalogRoot: resolvedCatalogRoot,
    reconciledAt: reviewedAt,
    dryRun,
  });

  if (skipQdrantSync || dryRun) {
    report.qdrant_sync = {
      status: dryRun ? "skipped_dry_run" : "skipped",
      endpoint: qdrantUrl,
      collection_name: collectionName,
    };
  } else {
    const catalogs = new FileBackedCatalog({ rootDir: resolvedCatalogRoot }).loadRuntimeCatalogs();
    report.qdrant_sync = await syncCatalog({
      catalogs,
      qdrantUrl,
      collectionName,
      embedderType,
      embeddingModel,
      denseVectorSize,
      sparseBucketCount,
      openAIApiKey,
      openAIBaseUrl,
      openAIOrganization,
      openAIProject,
      recreateCollection: false,
    });
  }

  report.completed_at = new Date().toISOString();

  if (!dryRun) {
    fs.mkdirSync(resolvedReportDir, { recursive: true });
    const outputPath = path.join(resolvedReportDir, `${report.run_id}.json`);
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    report.output_path = outputPath;
  }

  return report;
}

async function promoteApprovedBenchmarkCandidates({
  kind,
  manifestPath,
  benchmarkRunner,
  reviewSurface,
  catalogRoot,
  reviewer,
  reviewedAt,
  rationale,
  dryRun,
} = {}) {
  const resolvedManifestPath = path.resolve(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(resolvedManifestPath, "utf8"));
  const benchmark = benchmarkRunner({
    manifestPath: resolvedManifestPath,
    catalogRoot,
  });

  if ((benchmark.mismatches_expected ?? 0) > 0) {
    const error = new Error(`${kind} discovery benchmark is not clean`);
    error.benchmark = benchmark;
    throw error;
  }

  const promoted = [];
  const skipped = [];
  const blocked = [];

  for (const entry of manifest.entries ?? []) {
    if (entry.expected_decision !== "approve") {
      continue;
    }

    let proposedId = null;
    try {
      const identity = prepareCandidateIdentity({ kind, reviewSurface, entry });
      proposedId = identity.proposedId;
      const { currentRecord } = identity;
      if (currentRecord?.status === "active") {
        skipped.push({
          label: entry.label ?? null,
          proposed_id: proposedId,
          reason: "already_active",
        });
        continue;
      }

      const result = reviewSurface.promoteCandidate({
        entry,
        reviewer,
        rationale,
        reviewedAt,
        dryRun,
      });

      promoted.push({
        label: entry.label ?? null,
        proposed_id: proposedId,
        dry_run: Boolean(result.dry_run),
      });
    } catch (error) {
      blocked.push({
        label: entry.label ?? null,
        proposed_id: error.proposed_id ?? proposedId,
        error: error.message,
        readiness: error.readiness ?? null,
      });
    }
  }

  return {
    manifest_path: resolvedManifestPath,
    benchmark_summary: {
      benchmark_id: benchmark.benchmark_id,
      total_entries: benchmark.total_entries,
      matches_expected: benchmark.matches_expected,
      mismatches_expected: benchmark.mismatches_expected,
      false_positives: benchmark.false_positives,
      false_negatives: benchmark.false_negatives,
    },
    promoted_count: promoted.length,
    skipped_count: skipped.length,
    blocked_count: blocked.length,
    promoted,
    skipped,
    blocked,
  };
}

function prepareCandidateIdentity({ kind, reviewSurface, entry }) {
  const prepared = reviewSurface.discovery.preparePromotionPacket(entry);
  const proposedId = kind === "invariant"
    ? prepared.packet.proposed_invariant_id
    : prepared.packet.proposed_tactic_id;
  const currentRecord = reviewSurface.catalog.getRecord(kind, proposedId);
  return {
    proposedId,
    currentRecord,
  };
}

function createRunId(timestamp) {
  return `governed-promotion-${String(timestamp).replaceAll(/[:.]/g, "").replaceAll("-", "")}`;
}

module.exports = {
  DEFAULT_INVARIANT_BENCHMARK_MANIFEST,
  DEFAULT_REPORT_DIR,
  DEFAULT_TACTIC_BENCHMARK_MANIFEST,
  createRunId,
  promoteApprovedBenchmarkCandidates,
  runGovernedPromotion,
};
