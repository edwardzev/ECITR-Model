#!/usr/bin/env node

const path = require("node:path");

const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const { migrateWorkspaceIdentityBySource } = require("../workspace/selective-migration");
const { resolveWorkspaceRootForWorkspaceId } = require("../workspace/source-mapping");

function main() {
  const options = parseArgs(process.argv.slice(2));
  const summary = migrateWorkspaceIdentityBySource(options);
  process.stdout.write(`${JSON.stringify({ ok: true, ...summary }, null, 2)}\n`);
}

function parseArgs(args) {
  const options = {
    catalogRoot: DEFAULT_CATALOG_ROOT,
    targetWorkspaceId: "ms_business_central",
    agentOpsProjectIds: [],
    codexWorkspaceRoots: [],
    dryRun: true,
    includeStaging: true,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--catalog-root":
        options.catalogRoot = path.resolve(args[++index]);
        break;
      case "--workspace-id":
        options.targetWorkspaceId = args[++index];
        break;
      case "--project-id":
        options.agentOpsProjectIds.push(args[++index]);
        break;
      case "--workspace-root":
        options.codexWorkspaceRoots.push(path.resolve(args[++index]));
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--apply":
        options.dryRun = false;
        break;
      case "--skip-staging":
        options.includeStaging = false;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.codexWorkspaceRoots.length === 0) {
    const mappedWorkspaceRoot = resolveWorkspaceRootForWorkspaceId({
      workspaceId: options.targetWorkspaceId,
    });
    if (mappedWorkspaceRoot) {
      options.codexWorkspaceRoots = [mappedWorkspaceRoot];
    }
  }

  return options;
}

try {
  main();
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
}
