#!/usr/bin/env node

const path = require("node:path");

const { CaseReviewSurface } = require("../cases/case-review");
const { DEFAULT_CATALOG_ROOT, refreshCases } = require("../cases/case-refresh");
const { resolveDefaultAgentOpsRoot } = require("../importers/agent-ops-refresh");
const { importAgentOpsRuns } = require("../importers/agent-ops-runs");
const { importAgentOpsSessions } = require("../importers/agent-ops-sessions");
const { importCodexRollouts, resolveDefaultCodexRoot } = require("../importers/codex-rollouts");
const { migrateWorkspaceIdentityBySource } = require("../workspace/selective-migration");
const { resolveWorkspaceRootForWorkspaceId } = require("../workspace/source-mapping");

function main() {
  const options = parseArgs(process.argv.slice(2));
  const summary = {
    dry_run: options.dryRun,
    catalog_root: options.catalogRoot,
    workspace_id: options.workspaceId,
    workspace_root: options.workspaceRoot,
    agent_ops_root: options.agentOpsRoot,
    codex_root: options.codexRoot,
  };

  if (!options.skipMigration) {
    summary.migration = migrateWorkspaceIdentityBySource({
      catalogRoot: options.catalogRoot,
      targetWorkspaceId: options.workspaceId,
      agentOpsProjectIds: [options.projectId],
      codexWorkspaceRoots: [options.workspaceRoot],
      dryRun: options.dryRun,
    });
    assertSummaryClean("migration", summary.migration);
  } else {
    summary.migration = { status: "skipped" };
  }

  summary.agent_ops_runs = importAgentOpsRuns({
    agentOpsRoot: options.agentOpsRoot,
    catalogRoot: options.catalogRoot,
    projectId: options.projectId,
    dryRun: options.dryRun,
  });
  assertSummaryClean("agent_ops_runs", summary.agent_ops_runs);

  summary.agent_ops_sessions = importAgentOpsSessions({
    agentOpsRoot: options.agentOpsRoot,
    catalogRoot: options.catalogRoot,
    projectId: options.projectId,
    dryRun: options.dryRun,
  });
  assertSummaryClean("agent_ops_sessions", summary.agent_ops_sessions);

  summary.codex_rollouts = importCodexRollouts({
    codexRoot: options.codexRoot,
    catalogRoot: options.catalogRoot,
    workspaceRoot: options.workspaceRoot,
    dryRun: options.dryRun,
  });
  assertSummaryClean("codex_rollouts", summary.codex_rollouts);

  summary.cases = refreshCases({
    catalogRoot: options.catalogRoot,
    workspaceId: options.workspaceId,
    dryRun: options.dryRun,
  });
  assertSummaryClean("cases", summary.cases);

  const surface = new CaseReviewSurface({
    catalogRoot: options.catalogRoot,
  });
  summary.pending_cases = surface.listPendingCases({
    workspaceId: options.workspaceId,
    status: "draft",
    limit: options.pendingLimit,
  });

  process.stdout.write(`${JSON.stringify({ ok: true, ...summary }, null, 2)}\n`);
}

function parseArgs(args) {
  const workspaceId = "ms_business_central";
  const workspaceRoot = resolveWorkspaceRootForWorkspaceId({ workspaceId });
  const options = {
    catalogRoot: DEFAULT_CATALOG_ROOT,
    workspaceId,
    workspaceRoot,
    projectId: workspaceId,
    agentOpsRoot: resolveDefaultAgentOpsRoot(),
    codexRoot: resolveDefaultCodexRoot(),
    pendingLimit: 25,
    dryRun: false,
    skipMigration: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--catalog-root":
        options.catalogRoot = path.resolve(args[++index]);
        break;
      case "--workspace-id":
        options.workspaceId = args[++index];
        break;
      case "--workspace-root":
        options.workspaceRoot = path.resolve(args[++index]);
        break;
      case "--project-id":
        options.projectId = args[++index];
        break;
      case "--agent-ops-root":
        options.agentOpsRoot = path.resolve(args[++index]);
        break;
      case "--codex-root":
        options.codexRoot = path.resolve(args[++index]);
        break;
      case "--pending-limit":
        options.pendingLimit = Number.parseInt(args[++index], 10);
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--skip-migration":
        options.skipMigration = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.workspaceRoot) {
    throw new Error("refresh-msbc-memory requires --workspace-root or a configured workspace-source-map entry.");
  }
  if (!options.agentOpsRoot) {
    throw new Error("refresh-msbc-memory requires an agent-ops root.");
  }
  if (!options.codexRoot) {
    throw new Error("refresh-msbc-memory requires a Codex root.");
  }

  return options;
}

function assertSummaryClean(label, summary) {
  if ((summary.errors ?? 0) > 0 || (summary.conflicts ?? 0) > 0) {
    const error = new Error(`${label} reported conflicts or errors.`);
    error.summary = summary;
    throw error;
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message, summary: error.summary ?? null }, null, 2)}\n`);
  process.exitCode = 1;
}
