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
const { buildSemanticEmbedder } = require("../retrieval/embedders/factory");
const {
  DEFAULT_INVARIANT_ACTIVATION_CAP,
  DEFAULT_TACTIC_ACTIVATION_CAP,
  processLivePromotionCandidates,
  stageLivePromotionCandidates,
} = require("./live-promotion-candidates");
const { buildPromotionJudge } = require("./promotion-judge");
const {
  DEFAULT_LANCEDB_URI,
  DEFAULT_TABLE_NAME: DEFAULT_LANCEDB_TABLE_NAME,
  LanceDbSemanticBackend,
} = require("../retrieval/semantic-backends/lancedb-backend");
const { defaultSyncCatalog, DEFAULT_COLLECTION_NAME, DEFAULT_QDRANT_URL } = require("../importers/agent-ops-refresh");
const { refreshSupportGraph } = require("../support-graph/refresh");

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
const DEFAULT_SUPPORT_GRAPH_ROOT = path.join(REPO_ROOT, ".local", "support-graph");

async function runGovernedPromotion({
  catalogRoot = DEFAULT_CATALOG_ROOT,
  reportDir,
  supportGraphRoot,
  invariantManifestPath = DEFAULT_INVARIANT_BENCHMARK_MANIFEST,
  tacticManifestPath = DEFAULT_TACTIC_BENCHMARK_MANIFEST,
  caseBatchLimit = Number.MAX_SAFE_INTEGER,
  reviewer = "autonomous-governance-steward",
  reviewedAt = new Date().toISOString(),
  lancedbUri = process.env.ECITR_LANCEDB_URI,
  lancedbTableName = DEFAULT_LANCEDB_TABLE_NAME,
  lancedbEmbedderType = process.env.ECITR_LANCEDB_EMBEDDER ?? "hash",
  lancedbEmbeddingModel = process.env.ECITR_LANCEDB_EMBEDDING_MODEL,
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
  syncLanceDbCatalog = defaultSyncLanceDbCatalog,
  supportGraphRefresher = refreshSupportGraph,
  dryRun = false,
  enableLivePromotions = true,
  maxLiveInvariantCandidates = 25,
  maxLiveTacticCandidates = 25,
  invariantActivationCap = DEFAULT_INVARIANT_ACTIVATION_CAP,
  tacticActivationCap = DEFAULT_TACTIC_ACTIVATION_CAP,
  skipLanceDbSync = false,
  skipQdrantSync = true,
  caseBatchRunner = runCaseBatch,
  invariantBenchmarkRunner = runInvariantDiscoveryBenchmark,
  tacticBenchmarkRunner = runTacticDiscoveryBenchmark,
  liveCandidateGenerator = stageLivePromotionCandidates,
  liveCandidateProcessor = processLivePromotionCandidates,
  promotionJudge,
  caseReviewSurface = new CaseReviewSurface({ catalogRoot }),
  invariantReviewSurface = new InvariantReviewSurface({ catalogRoot }),
  tacticReviewSurface = new TacticReviewSurface({ catalogRoot }),
} = {}) {
  const resolvedCatalogRoot = path.resolve(catalogRoot);
  const resolvedReportDir = resolvePromotionReportDir({
    catalogRoot: resolvedCatalogRoot,
    reportDir,
  });
  const resolvedSupportGraphRoot = resolveSupportGraphRoot({
    catalogRoot: resolvedCatalogRoot,
    supportGraphRoot,
  });
  const resolvedLanceDbUri = resolveLanceDbUri({
    catalogRoot: resolvedCatalogRoot,
    lancedbUri,
  });
  const resolvedPromotionJudge = promotionJudge ?? buildPromotionJudge({
    catalogRoot: resolvedCatalogRoot,
  });
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
    live_candidates: null,
    live_promotions: null,
    promotion_interpretation: null,
    invariants: null,
    tactics: null,
    support_graph: null,
    lancedb_sync: null,
    qdrant_sync: null,
    warnings: [],
  };

  const invariantBenchmark = evaluateDiscoveryBenchmark({
    kind: "invariant",
    manifestPath: invariantManifestPath,
    benchmarkRunner: invariantBenchmarkRunner,
    catalogRoot: resolvedCatalogRoot,
  });
  const tacticBenchmark = evaluateDiscoveryBenchmark({
    kind: "tactic",
    manifestPath: tacticManifestPath,
    benchmarkRunner: tacticBenchmarkRunner,
    catalogRoot: resolvedCatalogRoot,
  });

  const caseBatch = caseBatchRunner({
    surface: caseReviewSurface,
    limit: caseBatchLimit,
    dryRun,
    reviewer,
    skipPreviouslyFailed: false,
    rejectErrors: true,
    rejectionRationale: "Autonomous morning reconciliation rejected this draft case because it could not satisfy the current governed case pipeline.",
  });

  report.case_batch = caseBatch;

  if (enableLivePromotions) {
    report.live_candidates = await liveCandidateGenerator({
      catalogRoot: resolvedCatalogRoot,
      generatedAt: reviewedAt,
      dryRun,
      maxInvariantCandidates: maxLiveInvariantCandidates,
      maxTacticCandidates: maxLiveTacticCandidates,
    });
  } else {
    report.live_candidates = {
      status: "skipped",
      reason: "live promotions disabled",
    };
  }

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
    benchmark: invariantBenchmark,
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
    benchmark: tacticBenchmark,
  });
  report.tactics = tacticSection;

  if (enableLivePromotions) {
    report.live_promotions = await liveCandidateProcessor({
      catalogRoot: resolvedCatalogRoot,
      invariantReviewSurface,
      tacticReviewSurface,
      promotionJudge: resolvedPromotionJudge,
      reviewer,
      reviewedAt,
      invariantActivationCap,
      tacticActivationCap,
      dryRun,
    });
    report.warnings.push(...(report.live_promotions.warnings ?? []));
  } else {
    report.live_promotions = {
      status: "skipped",
      reason: "live promotions disabled",
    };
  }

  report.promotion_interpretation = buildPromotionInterpretation({
    catalogRoot: resolvedCatalogRoot,
    reportDir: resolvedReportDir,
    currentReport: report,
  });

  report.reconciliation = reconcileOpenPools({
    catalogRoot: resolvedCatalogRoot,
    reconciledAt: reviewedAt,
    dryRun,
  });

  report.support_graph = supportGraphRefresher({
    graphRoot: resolvedSupportGraphRoot,
    catalogRoot: resolvedCatalogRoot,
    dryRun,
    builtAt: reviewedAt,
  });

  let catalogsForDerivedSync = null;
  const loadCatalogsForDerivedSync = () => {
    if (!catalogsForDerivedSync) {
      catalogsForDerivedSync = new FileBackedCatalog({ rootDir: resolvedCatalogRoot }).loadRuntimeCatalogs();
    }
    return catalogsForDerivedSync;
  };

  if (skipLanceDbSync || dryRun) {
    report.lancedb_sync = {
      status: dryRun ? "skipped_dry_run" : "skipped",
      uri: resolvedLanceDbUri,
      table_name: lancedbTableName,
    };
  } else {
    report.lancedb_sync = await syncLanceDbCatalog({
      catalogs: loadCatalogsForDerivedSync(),
      uri: resolvedLanceDbUri,
      tableName: lancedbTableName,
      embedderType: lancedbEmbedderType,
      embeddingModel: lancedbEmbeddingModel,
      denseVectorSize,
      sparseBucketCount,
      openAIApiKey,
      openAIBaseUrl,
      openAIOrganization,
      openAIProject,
    });
  }

  if (skipQdrantSync || dryRun) {
    report.qdrant_sync = {
      status: dryRun ? "skipped_dry_run" : "skipped",
      endpoint: qdrantUrl,
      collection_name: collectionName,
    };
  } else {
    report.qdrant_sync = await syncCatalog({
      catalogs: loadCatalogsForDerivedSync(),
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
  benchmark: preflightBenchmark = null,
} = {}) {
  const resolvedManifestPath = path.resolve(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(resolvedManifestPath, "utf8"));
  const benchmark = preflightBenchmark ?? evaluateDiscoveryBenchmark({
    kind,
    manifestPath: resolvedManifestPath,
    benchmarkRunner,
    catalogRoot,
  });

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

function evaluateDiscoveryBenchmark({
  kind,
  manifestPath,
  benchmarkRunner,
  catalogRoot,
} = {}) {
  const resolvedManifestPath = path.resolve(manifestPath);
  const benchmark = benchmarkRunner({
    manifestPath: resolvedManifestPath,
    catalogRoot,
  });

  if ((benchmark.mismatches_expected ?? 0) > 0) {
    const error = new Error(`${kind} discovery benchmark is not clean`);
    error.benchmark = benchmark;
    throw error;
  }

  return benchmark;
}

function buildPromotionInterpretation({
  catalogRoot,
  reportDir,
  currentReport,
  historyLimit = 8,
} = {}) {
  const catalog = new FileBackedCatalog({ rootDir: catalogRoot });
  const activeInvariants = safeActiveRecords(catalog, "invariant");
  const activeTactics = safeActiveRecords(catalog, "tactic");
  const tacticSupportShape = summarizeTacticSupportShape(activeTactics);

  return {
    layer_counts_are_independent: true,
    count_parity_is_not_health_target: true,
    interpretation: "Invariant and tactic counts are independent. Equal active counts or equal activation batches are not a promotion health target.",
    health_signals: [
      "source coverage",
      "provenance quality",
      "judge and deterministic gate outcomes",
      "duplicate retirement",
      "tactic freshness",
      "scope and workspace fit",
    ],
    active_counts: {
      invariants: activeInvariants.length,
      tactics: activeTactics.length,
    },
    tactic_support_shape: tacticSupportShape,
    current_run: {
      activation_caps: currentReport.live_promotions?.activation_caps ?? null,
      benchmark_promoted: {
        invariants: currentReport.invariants?.promoted_count ?? null,
        tactics: currentReport.tactics?.promoted_count ?? null,
      },
      live_candidates: {
        invariants: currentReport.live_candidates?.invariants?.generated_count ?? null,
        tactics: currentReport.live_candidates?.tactics?.generated_count ?? null,
      },
      live_activated: {
        invariants: currentReport.live_promotions?.invariants?.activated_count ?? null,
        tactics: currentReport.live_promotions?.tactics?.activated_count ?? null,
      },
      live_retired: {
        invariants: currentReport.live_promotions?.invariants?.retired_count ?? null,
        tactics: currentReport.live_promotions?.tactics?.retired_count ?? null,
      },
      live_judge_skipped: {
        invariants: currentReport.live_promotions?.invariants?.judge_skipped_count ?? null,
        tactics: currentReport.live_promotions?.tactics?.judge_skipped_count ?? null,
      },
      live_cap_skipped: {
        invariants: currentReport.live_promotions?.invariants?.cap_skipped_count ?? null,
        tactics: currentReport.live_promotions?.tactics?.cap_skipped_count ?? null,
      },
    },
    recent_activation_history: buildRecentActivationHistory({
      reportDir,
      currentReport,
      limit: historyLimit,
    }),
  };
}

function safeActiveRecords(catalog, recordType) {
  try {
    return catalog.listRecords(recordType).filter((record) => record.status === "active");
  } catch (_error) {
    return [];
  }
}

function summarizeTacticSupportShape(activeTactics) {
  let directCaseClusterCount = 0;
  let invariantBackedCount = 0;
  let unknownSupportCount = 0;

  for (const tactic of activeTactics) {
    const refs = tactic.supporting_invariant_refs;
    if ((tactic.promotion_basis ?? null) === "case_cluster" || (Array.isArray(refs) && refs.length === 0)) {
      directCaseClusterCount += 1;
      continue;
    }
    if (Array.isArray(refs) && refs.length > 0) {
      invariantBackedCount += 1;
      continue;
    }
    unknownSupportCount += 1;
  }

  return {
    direct_case_cluster_count: directCaseClusterCount,
    invariant_backed_count: invariantBackedCount,
    unknown_support_count: unknownSupportCount,
  };
}

function buildRecentActivationHistory({ reportDir, currentReport, limit }) {
  const entriesByRunId = new Map();
  for (const report of readPriorPromotionReports(reportDir)) {
    const entry = buildActivationHistoryEntry(report);
    if (entry) {
      entriesByRunId.set(entry.run_id, entry);
    }
  }

  const currentEntry = buildActivationHistoryEntry(currentReport);
  if (currentEntry) {
    entriesByRunId.set(currentEntry.run_id, currentEntry);
  }

  return [...entriesByRunId.values()]
    .sort((left, right) => String(left.started_at).localeCompare(String(right.started_at)))
    .slice(-limit);
}

function readPriorPromotionReports(reportDir) {
  if (!reportDir || !fs.existsSync(reportDir)) {
    return [];
  }

  return fs
    .readdirSync(reportDir)
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(reportDir, entry), "utf8"));
      } catch (_error) {
        return null;
      }
    })
    .filter(Boolean);
}

function buildActivationHistoryEntry(report) {
  if (!report?.run_id) {
    return null;
  }

  return {
    run_id: report.run_id,
    started_at: report.started_at ?? null,
    activation_caps: report.live_promotions?.activation_caps ?? null,
    live_activated: {
      invariants: report.live_promotions?.invariants?.activated_count ?? null,
      tactics: report.live_promotions?.tactics?.activated_count ?? null,
    },
    live_judge_skipped: {
      invariants: report.live_promotions?.invariants?.judge_skipped_count ?? null,
      tactics: report.live_promotions?.tactics?.judge_skipped_count ?? null,
    },
    live_cap_skipped: {
      invariants: report.live_promotions?.invariants?.cap_skipped_count ?? null,
      tactics: report.live_promotions?.tactics?.cap_skipped_count ?? null,
    },
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

async function defaultSyncLanceDbCatalog({
  catalogs,
  uri = DEFAULT_LANCEDB_URI,
  tableName = DEFAULT_LANCEDB_TABLE_NAME,
  embedderType = "hash",
  embeddingModel,
  denseVectorSize,
  sparseBucketCount = 2048,
  openAIApiKey,
  openAIBaseUrl,
  openAIOrganization,
  openAIProject,
} = {}) {
  const embedder = buildSemanticEmbedder({
    embedderType,
    embeddingModel,
    denseVectorSize,
    sparseBucketCount,
    openAIApiKey,
    openAIBaseUrl,
    openAIOrganization,
    openAIProject,
  });
  const backend = new LanceDbSemanticBackend({
    uri,
    tableName,
    catalogs,
    embedder,
  });
  const result = await backend.syncCatalog();

  return {
    status: result.status,
    uri,
    table_name: tableName,
    rows_total: result.rows_total,
    dense_vector_size: embedder.denseVectorSize,
    sparse_bucket_count: embedder.sparseBucketCount,
    embedding_signature: embedder.embeddingSignature ?? null,
  };
}

function resolveSupportGraphRoot({ catalogRoot = DEFAULT_CATALOG_ROOT, supportGraphRoot } = {}) {
  if (supportGraphRoot !== undefined && supportGraphRoot !== null) {
    return path.resolve(supportGraphRoot);
  }

  const resolvedCatalogRoot = path.resolve(catalogRoot);
  if (resolvedCatalogRoot === path.resolve(DEFAULT_CATALOG_ROOT)) {
    return DEFAULT_SUPPORT_GRAPH_ROOT;
  }

  const parentDir = path.dirname(resolvedCatalogRoot);
  if (path.basename(resolvedCatalogRoot) === "catalog" && path.basename(parentDir) === ".local") {
    return path.join(parentDir, "support-graph");
  }

  return path.join(resolvedCatalogRoot, ".local", "support-graph");
}

function resolveLanceDbUri({ catalogRoot = DEFAULT_CATALOG_ROOT, lancedbUri } = {}) {
  if (lancedbUri !== undefined && lancedbUri !== null) {
    const value = String(lancedbUri);
    return /^[a-z]+:\/\//i.test(value) ? value : path.resolve(value);
  }

  const resolvedCatalogRoot = path.resolve(catalogRoot);
  if (resolvedCatalogRoot === path.resolve(DEFAULT_CATALOG_ROOT)) {
    return DEFAULT_LANCEDB_URI;
  }

  const parentDir = path.dirname(resolvedCatalogRoot);
  if (path.basename(resolvedCatalogRoot) === "catalog" && path.basename(parentDir) === ".local") {
    return path.join(parentDir, "lancedb");
  }

  return path.join(resolvedCatalogRoot, ".local", "lancedb");
}

function resolvePromotionReportDir({ catalogRoot = DEFAULT_CATALOG_ROOT, reportDir } = {}) {
  if (reportDir !== undefined && reportDir !== null) {
    return path.resolve(reportDir);
  }

  const resolvedCatalogRoot = path.resolve(catalogRoot);
  if (resolvedCatalogRoot === path.resolve(DEFAULT_CATALOG_ROOT)) {
    return DEFAULT_REPORT_DIR;
  }

  const parentDir = path.dirname(resolvedCatalogRoot);
  if (path.basename(resolvedCatalogRoot) === "catalog" && path.basename(parentDir) === ".local") {
    return path.join(parentDir, "reports", "governed-promotions");
  }

  return path.join(resolvedCatalogRoot, ".local", "reports", "governed-promotions");
}

module.exports = {
  DEFAULT_INVARIANT_BENCHMARK_MANIFEST,
  DEFAULT_REPORT_DIR,
  DEFAULT_SUPPORT_GRAPH_ROOT,
  DEFAULT_TACTIC_BENCHMARK_MANIFEST,
  createRunId,
  defaultSyncLanceDbCatalog,
  evaluateDiscoveryBenchmark,
  promoteApprovedBenchmarkCandidates,
  resolveLanceDbUri,
  resolvePromotionReportDir,
  resolveSupportGraphRoot,
  runGovernedPromotion,
};
