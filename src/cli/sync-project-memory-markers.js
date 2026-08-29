#!/usr/bin/env node

const path = require("node:path");

const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const { loadWorkspaceSourceMap } = require("../workspace/source-mapping");
const {
  syncRegisteredProjectMemoryMarkers,
} = require("../workspace/project-memory-rollout");

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const sourceMap = loadWorkspaceSourceMap({ filePath: options.sourceMapPath });
  const summary = syncRegisteredProjectMemoryMarkers({
    catalogRoot: options.catalogRoot,
    sourceMap,
    workspaceIds: options.workspaceIds,
    dryRun: options.dryRun,
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.ok) {
    process.exitCode = 1;
  }
}

function parseArgs(args) {
  const options = {
    catalogRoot: DEFAULT_CATALOG_ROOT,
    sourceMapPath: undefined,
    workspaceIds: [],
    dryRun: true,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--catalog-root":
        options.catalogRoot = path.resolve(args[++index]);
        break;
      case "--source-map":
        options.sourceMapPath = path.resolve(args[++index]);
        break;
      case "--workspace-id":
        options.workspaceIds.push(args[++index]);
        break;
      case "--apply":
        options.dryRun = false;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  main,
  parseArgs,
};
