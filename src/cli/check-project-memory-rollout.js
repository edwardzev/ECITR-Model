#!/usr/bin/env node

const path = require("node:path");

const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const {
  DEFAULT_LANCEDB_URI,
  DEFAULT_TABLE_NAME: DEFAULT_LANCEDB_TABLE_NAME,
} = require("../retrieval/semantic-backends/lancedb-backend");
const { DEFAULT_GRAPH_ROOT } = require("../support-graph/refresh");
const {
  DEFAULT_INSTALLED_SKILL_ROOT,
  inspectRegisteredProjectMemory,
} = require("../workspace/project-memory-rollout");
const { loadWorkspaceSourceMap } = require("../workspace/source-mapping");

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const sourceMap = loadWorkspaceSourceMap({ filePath: options.sourceMapPath });
  const report = inspectRegisteredProjectMemory({
    catalogRoot: options.catalogRoot,
    graphRoot: options.graphRoot,
    lancedbUri: options.lancedbUri,
    lancedbTableName: options.lancedbTableName,
    installedSkillRoot: options.installedSkillRoot,
    sourceMap,
    workspaceIds: options.workspaceIds,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

function parseArgs(args) {
  const options = {
    catalogRoot: DEFAULT_CATALOG_ROOT,
    graphRoot: DEFAULT_GRAPH_ROOT,
    lancedbUri: DEFAULT_LANCEDB_URI,
    lancedbTableName: DEFAULT_LANCEDB_TABLE_NAME,
    installedSkillRoot: DEFAULT_INSTALLED_SKILL_ROOT,
    sourceMapPath: undefined,
    workspaceIds: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--catalog-root":
        options.catalogRoot = path.resolve(args[++index]);
        break;
      case "--graph-root":
        options.graphRoot = path.resolve(args[++index]);
        break;
      case "--lancedb-uri":
        options.lancedbUri = path.resolve(args[++index]);
        break;
      case "--lancedb-table":
        options.lancedbTableName = args[++index];
        break;
      case "--skill-root":
        options.installedSkillRoot = path.resolve(args[++index]);
        break;
      case "--source-map":
        options.sourceMapPath = path.resolve(args[++index]);
        break;
      case "--workspace-id":
        options.workspaceIds.push(args[++index]);
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
