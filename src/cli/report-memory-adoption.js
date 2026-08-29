#!/usr/bin/env node

const path = require("node:path");

const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const {
  summarizeRegisteredMemoryAdoption,
} = require("../runtime/project-memory-adoption");
const { loadWorkspaceSourceMap } = require("../workspace/source-mapping");

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const sourceMap = loadWorkspaceSourceMap({ filePath: options.sourceMapPath });
  const report = summarizeRegisteredMemoryAdoption({
    catalogRoot: options.catalogRoot,
    sourceMap,
    workspaceIds: options.workspaceIds,
    since: options.since,
    until: options.until,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function parseArgs(args) {
  const options = {
    catalogRoot: DEFAULT_CATALOG_ROOT,
    sourceMapPath: undefined,
    workspaceIds: [],
    since: null,
    until: null,
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
      case "--since":
        options.since = args[++index];
        break;
      case "--until":
        options.until = args[++index];
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
