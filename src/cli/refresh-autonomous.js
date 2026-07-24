#!/usr/bin/env node

const path = require("node:path");

const { refreshCodexIndex } = require("../importers/codex-refresh");
const { refreshAgentOpsIndex } = require("../importers/agent-ops-refresh");
const { DEFAULT_CATALOG_ROOT, refreshCases } = require("../cases/case-refresh");
const { refreshParameters } = require("../parameters/refresh");
const {
  defaultSyncLanceDbCatalog,
  resolveLanceDbUri,
  resolveSupportGraphRoot,
  runGovernedPromotion,
} = require("../runtime/governed-promotion-runner");
const {
  DEFAULT_TABLE_NAME: DEFAULT_LANCEDB_TABLE_NAME,
} = require("../retrieval/semantic-backends/lancedb-backend");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { refreshSupportGraph } = require("../support-graph/refresh");
const { resolveWorkspaceId } = require("../workspace/config");

async function runAutonomousRefresh({
  catalogRoot = DEFAULT_CATALOG_ROOT,
  refreshCodexIndexImpl = refreshCodexIndex,
  refreshAgentOpsIndexImpl = refreshAgentOpsIndex,
  refreshParametersImpl = refreshParameters,
  refreshCasesImpl = refreshCases,
  runGovernedPromotionImpl = runGovernedPromotion,
  refreshSupportGraphImpl = refreshSupportGraph,
  syncLanceDbCatalogImpl = defaultSyncLanceDbCatalog,
  loadRuntimeCatalogsImpl = () =>
    new FileBackedCatalog({ rootDir: catalogRoot }).loadRuntimeCatalogs(),
  supportGraphRoot,
  lancedbUri = process.env.ECITR_LANCEDB_URI,
  lancedbTableName = process.env.ECITR_LANCEDB_TABLE ?? DEFAULT_LANCEDB_TABLE_NAME,
  lancedbEmbedderType = process.env.ECITR_LANCEDB_EMBEDDER ?? "hash",
  lancedbEmbeddingModel = process.env.ECITR_LANCEDB_EMBEDDING_MODEL,
  skipLanceDbSync = false,
  now = () => new Date().toISOString(),
} = {}) {
  const resolvedCatalogRoot = path.resolve(catalogRoot);
  const resolvedSupportGraphRoot = resolveSupportGraphRoot({
    catalogRoot: resolvedCatalogRoot,
    supportGraphRoot,
  });
  const resolvedLanceDbUri = resolveLanceDbUri({
    catalogRoot: resolvedCatalogRoot,
    lancedbUri,
  });
  const startedAt = now();
  const summary = {
    ok: true,
    run_id: createAutonomousRunId(startedAt),
    started_at: startedAt,
    completed_at: null,
    catalog_root: resolvedCatalogRoot,
    workspace_id: resolveWorkspaceId({ catalogRoot: resolvedCatalogRoot }),
    codex: null,
    agent_ops: null,
    parameters: null,
    cases: null,
    promotions: null,
    support_graph: null,
    lancedb_sync: null,
    warnings: [],
    errors: [],
  };

  summary.codex = await captureStage(summary, "codex", () => refreshCodexIndexImpl({
    catalogRoot: resolvedCatalogRoot,
    skipQdrantSync: true,
  }));
  summary.agent_ops = await captureStage(summary, "agent_ops", () => refreshAgentOpsIndexImpl({
    catalogRoot: resolvedCatalogRoot,
    skipQdrantSync: true,
  }));

  summary.parameters = await captureStage(summary, "parameters", () => refreshParametersImpl({
    catalogRoot: resolvedCatalogRoot,
  }));
  if ((summary.parameters?.errors ?? 0) > 0 || (summary.parameters?.conflicts ?? 0) > 0) {
    recordStageError(summary, {
      stage: "parameters",
      message: "autonomous refresh reported material parameter-distillation errors.",
      details: {
        errors: summary.parameters.errors ?? 0,
        material_conflicts: summary.parameters.conflicts ?? 0,
        benign_conflicts: summary.parameters.benign_conflicts ?? 0,
      },
    });
  } else if ((summary.parameters?.benign_conflicts ?? 0) > 0) {
    recordStageWarning(summary, {
      stage: "parameters",
      message: "autonomous refresh observed benign parameter duplicate conflicts.",
      details: {
        benign_conflicts: summary.parameters.benign_conflicts,
      },
    });
  }

  summary.cases = await captureStage(summary, "cases", () => refreshCasesImpl({
    catalogRoot: resolvedCatalogRoot,
    includeLegacyAutodistill: false,
  }));
  if ((summary.cases?.errors ?? 0) > 0) {
    recordStageError(summary, {
      stage: "cases",
      message: "autonomous refresh reported case-distillation errors.",
      details: {
        errors: summary.cases.errors ?? 0,
      },
    });
  }

  summary.promotions = await captureStage(summary, "promotions", () => runGovernedPromotionImpl({
    catalogRoot: resolvedCatalogRoot,
    supportGraphRoot: resolvedSupportGraphRoot,
    skipLanceDbSync: true,
    supportGraphRefresher(options) {
      const result = refreshSupportGraphImpl(options);
      summary.support_graph = result;
      return result;
    },
  }));
  if (!summary.support_graph && summary.promotions?.support_graph) {
    summary.support_graph = summary.promotions.support_graph;
  }
  for (const warning of summary.promotions?.warnings ?? []) {
    recordStageWarning(summary, warning);
  }

  if (!summary.support_graph) {
    summary.support_graph = await captureStage(summary, "support_graph", () => refreshSupportGraphImpl({
      catalogRoot: resolvedCatalogRoot,
      graphRoot: resolvedSupportGraphRoot,
    }));
  }

  if (skipLanceDbSync) {
    summary.lancedb_sync = {
      status: "skipped",
    };
  } else {
    summary.lancedb_sync = await captureStage(summary, "lancedb_sync", () =>
      syncLanceDbCatalogImpl({
        catalogs: loadRuntimeCatalogsImpl(),
        uri: resolvedLanceDbUri,
        tableName: lancedbTableName,
        embedderType: lancedbEmbedderType,
        embeddingModel: lancedbEmbeddingModel,
      }));
  }

  summary.completed_at = now();
  summary.ok = summary.errors.length === 0;
  return summary;
}

async function main() {
  const summary = await runAutonomousRefresh();
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.ok) {
    process.exitCode = 1;
  }
}

async function captureStage(summary, stage, operation) {
  try {
    return await operation();
  } catch (error) {
    recordStageError(summary, {
      stage,
      message: error?.message ?? String(error),
      error,
    });
    return null;
  }
}

function recordStageError(summary, { stage, message, details = null, error = null }) {
  summary.errors.push({
    stage,
    message,
    details,
    error: error ? serializeError(error) : null,
  });
}

function recordStageWarning(summary, { stage, message, details = null }) {
  summary.warnings.push({
    stage,
    message,
    details,
  });
}

function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    stack: error?.stack ?? null,
    summary: error?.summary ?? null,
    benchmark: error?.benchmark ?? null,
  };
}

function createAutonomousRunId(timestamp) {
  return `autonomous-refresh-${String(timestamp).replaceAll(/[:.]/g, "").replaceAll("-", "")}`;
}

if (require.main === module) {
  main().catch((error) => {
    const summary = {
      ok: false,
      fatal: true,
      errors: [
        {
          stage: "fatal",
          message: error?.message ?? String(error),
          error: serializeError(error),
        },
      ],
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  createAutonomousRunId,
  runAutonomousRefresh,
};
