#!/usr/bin/env node

const path = require("node:path");

const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const { ProjectMemorySurface } = require("../runtime/project-memory");
const { resolveProjectMemoryConfig } = require("../workspace/project-memory-config");

function main() {
  const options = parseArgs(process.argv.slice(2));
  const resolved = resolveProjectMemoryConfig(options);
  const surface = new ProjectMemorySurface({
    projectConfig: resolved.projectConfig,
    artifactRoot: resolved.artifactRoot,
  });
  const result = surface.recordMemoryUsage({
    invocationId: options.invocationId,
    usedRecordIds: options.usedRecordIds,
    selectedRecordIds: options.selectedRecordIds,
  });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    workspace_id: resolved.projectConfig.workspace_id,
    ...result,
  }, null, 2)}\n`);
}

function parseArgs(args) {
  const options = {
    catalogRoot: DEFAULT_CATALOG_ROOT,
    workspaceRoot: null,
    workspaceId: null,
    invocationId: null,
    usedRecordIds: [],
    selectedRecordIds: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--catalog-root":
        options.catalogRoot = path.resolve(args[++index]);
        break;
      case "--workspace-root":
        options.workspaceRoot = path.resolve(args[++index]);
        break;
      case "--workspace-id":
        options.workspaceId = args[++index];
        break;
      case "--invocation-id":
        options.invocationId = args[++index];
        break;
      case "--used-record-ids":
        options.usedRecordIds = splitList(args[++index]);
        break;
      case "--selected-record-ids":
        options.selectedRecordIds = splitList(args[++index]);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.workspaceRoot && !options.workspaceId) {
    options.workspaceRoot = process.cwd();
  }
  if (!options.invocationId) {
    throw new Error("record-memory-usage requires --invocation-id.");
  }
  return options;
}

function splitList(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
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
