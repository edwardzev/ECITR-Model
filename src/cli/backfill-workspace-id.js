#!/usr/bin/env node

const path = require("node:path");

const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const { backfillWorkspaceIdentity } = require("../workspace/backfill");

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const summary = backfillWorkspaceIdentity({
    catalogRoot: args.catalogRoot,
    workspaceId: args.workspaceId,
    dryRun: args.dryRun,
  });

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function parseArgs(argv) {
  let catalogRoot = DEFAULT_CATALOG_ROOT;
  let workspaceId = null;
  let dryRun = true;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--catalog-root") {
      catalogRoot = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (value === "--workspace-id") {
      workspaceId = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (value === "--apply") {
      dryRun = false;
      continue;
    }
    throw new Error(`Unsupported argument: ${value}`);
  }

  if (!workspaceId) {
    throw new Error("--workspace-id is required.");
  }

  return {
    catalogRoot,
    workspaceId,
    dryRun,
  };
}

if (require.main === module) {
  main();
}
