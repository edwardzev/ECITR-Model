const fs = require("node:fs");
const path = require("node:path");

const { REPO_ROOT } = require("../validation/schema-registry");
const { EcitrValidator } = require("../validation/validator");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { importAgentOpsRuns } = require("./agent-ops-runs");
const { importAgentOpsSessions } = require("./agent-ops-sessions");

async function refreshAgentOpsIndex({
  agentOpsRoot = resolveDefaultAgentOpsRoot(),
  catalogRoot = path.join(REPO_ROOT, ".local", "catalog"),
  projectId = null,
  dryRun = false,
  validator = new EcitrValidator(),
  importRuns = importAgentOpsRuns,
  importSessions = importAgentOpsSessions,
  loadCatalogs = defaultLoadCatalogs,
} = {}) {
  if (!agentOpsRoot) {
    throw new Error("refreshAgentOpsIndex requires an agentOpsRoot.");
  }

  if (!catalogRoot) {
    throw new Error("refreshAgentOpsIndex requires a catalogRoot.");
  }

  const resolvedAgentOpsRoot = path.resolve(agentOpsRoot);
  const resolvedCatalogRoot = path.resolve(catalogRoot);
  const summary = {
    dry_run: dryRun,
    agent_ops_root: resolvedAgentOpsRoot,
    catalog_root: resolvedCatalogRoot,
  };

  const importOptions = {
    agentOpsRoot: resolvedAgentOpsRoot,
    catalogRoot: resolvedCatalogRoot,
    projectId,
    dryRun,
    validator,
  };

  summary.runs = importRuns(importOptions);
  assertImportSummaryClean("runs", summary.runs);

  summary.sessions = importSessions({
    ...importOptions,
    plannedParentEvidenceIds: dryRun
      ? summary.runs.planned_evidence_ids ?? []
      : [],
  });
  assertImportSummaryClean("sessions", summary.sessions);

  if (dryRun) {
    return summary;
  }

  const catalogs = loadCatalogs({
    catalogRoot: resolvedCatalogRoot,
    validator,
  });
  summary.catalog_counts = countCatalogRecords(catalogs);

  return summary;
}

function defaultLoadCatalogs({ catalogRoot, validator }) {
  const catalog = new FileBackedCatalog({
    rootDir: catalogRoot,
    validator,
  });

  return catalog.loadRuntimeCatalogs();
}

function countCatalogRecords(catalogs) {
  return {
    tactics: catalogs.tactics?.length ?? 0,
    invariants: catalogs.invariants?.length ?? 0,
    cases: catalogs.cases?.length ?? 0,
    evidence: catalogs.evidence?.length ?? 0,
    atomic_claim_sets: catalogs.atomic_claim_sets?.length ?? 0,
    parameter_definitions: catalogs.parameter_definitions?.length ?? 0,
    parameter_observations: catalogs.parameter_observations?.length ?? 0,
    review_audit_entries: catalogs.review_audit_entries?.length ?? 0,
  };
}

function assertImportSummaryClean(label, summary) {
  if ((summary.errors ?? 0) > 0 || (summary.conflicts ?? 0) > 0) {
    const error = new Error(`${label} refresh reported conflicts or errors.`);
    error.summary = summary;
    throw error;
  }
}

function resolveDefaultAgentOpsRoot() {
  const siblingRoot = path.resolve(REPO_ROOT, "..", "agent-ops");
  if (fs.existsSync(siblingRoot) && fs.statSync(siblingRoot).isDirectory()) {
    return siblingRoot;
  }

  return null;
}

module.exports = {
  refreshAgentOpsIndex,
  countCatalogRecords,
  resolveDefaultAgentOpsRoot,
};
