const path = require("node:path");

const { REPO_ROOT } = require("../validation/schema-registry");
const { EcitrValidator } = require("../validation/validator");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { countCatalogRecords } = require("./agent-ops-refresh");
const { importCodexRollouts, resolveDefaultCodexRoot } = require("./codex-rollouts");

async function refreshCodexIndex({
  codexRoot = resolveDefaultCodexRoot(),
  catalogRoot = path.join(REPO_ROOT, ".local", "catalog"),
  dryRun = false,
  includeSessions = true,
  includeArchived = true,
  workspaceRoot = null,
  skipStructuralCheck = false,
  validator = new EcitrValidator(),
  importRollouts = importCodexRollouts,
  loadCatalogs = defaultLoadCatalogs,
  structuralCheck = runStructuralCheck,
} = {}) {
  if (!codexRoot) {
    throw new Error("refreshCodexIndex requires a codexRoot.");
  }

  if (!catalogRoot) {
    throw new Error("refreshCodexIndex requires a catalogRoot.");
  }

  const resolvedCodexRoot = path.resolve(codexRoot);
  const resolvedCatalogRoot = path.resolve(catalogRoot);
  const summary = {
    dry_run: dryRun,
    codex_root: resolvedCodexRoot,
    catalog_root: resolvedCatalogRoot,
    include_sessions: includeSessions,
    include_archived: includeArchived,
    workspace_root_filter: workspaceRoot ? path.resolve(workspaceRoot) : null,
  };

  summary.rollouts = importRollouts({
    codexRoot: resolvedCodexRoot,
    catalogRoot: resolvedCatalogRoot,
    dryRun,
    includeSessions,
    includeArchived,
    workspaceRoot,
    validator,
  });
  assertImportSummaryClean(summary.rollouts);

  if (dryRun) {
    summary.structural_checks = { status: "skipped_dry_run" };
    return summary;
  }

  const catalogs = loadCatalogs({
    catalogRoot: resolvedCatalogRoot,
    validator,
  });
  summary.catalog_counts = countCatalogRecords(catalogs);

  if (skipStructuralCheck) {
    summary.structural_checks = { status: "skipped" };
    return summary;
  }

  summary.structural_checks = structuralCheck({
    importSummary: summary.rollouts,
    catalogs,
  });
  if (summary.structural_checks.failed > 0) {
    const error = new Error("codex refresh structural checks failed.");
    error.summary = summary;
    throw error;
  }

  return summary;
}

function defaultLoadCatalogs({ catalogRoot, validator }) {
  const catalog = new FileBackedCatalog({
    rootDir: catalogRoot,
    validator,
  });

  return catalog.loadRuntimeCatalogs();
}

function runStructuralCheck({ importSummary, catalogs }) {
  const checks = [];
  const accountedFor =
    (importSummary.imported ?? 0) +
    (importSummary.skipped_existing ?? 0) +
    (importSummary.skipped_unchanged ?? 0) +
    (importSummary.skipped_checkpoint ?? 0) +
    (importSummary.skipped_duplicate_source ?? 0) +
    (importSummary.skipped_no_visible_messages ?? 0) +
    (importSummary.skipped_workspace_filter ?? 0);

  checks.push({
    name: "accounted_rollouts",
    ok: accountedFor === (importSummary.candidate_rollouts ?? 0),
    detail: {
      candidate_rollouts: importSummary.candidate_rollouts ?? 0,
      accounted_rollouts: accountedFor,
    },
  });

  const codexEvidenceCount = (catalogs.evidence ?? []).filter((record) =>
    String(record.source_locator || "").startsWith("codex-thread://"),
  ).length;
  checks.push({
    name: "codex_chat_evidence_present",
    ok: (importSummary.eligible_rollouts ?? 0) === 0 || codexEvidenceCount > 0,
    detail: {
      eligible_rollouts: importSummary.eligible_rollouts ?? 0,
      codex_chat_evidence_count: codexEvidenceCount,
    },
  });

  return {
    passed: checks.filter((check) => check.ok).length,
    failed: checks.filter((check) => !check.ok).length,
    checks,
  };
}

function assertImportSummaryClean(summary) {
  if ((summary.errors ?? 0) > 0 || (summary.conflicts ?? 0) > 0) {
    const error = new Error("codex rollout refresh reported conflicts or errors.");
    error.summary = summary;
    throw error;
  }
}

module.exports = {
  refreshCodexIndex,
  runStructuralCheck,
};
