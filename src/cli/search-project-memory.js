#!/usr/bin/env node

const path = require("node:path");

const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const {
  ProjectMemorySurface,
  createProjectMemoryRetrievalRuntime,
} = require("../runtime/project-memory");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { resolveProjectMemoryConfig } = require("../workspace/project-memory-config");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { projectConfig, artifactRoot, workspaceRoot } = resolveProjectMemoryConfig(options);
  const catalog = new FileBackedCatalog({ rootDir: options.catalogRoot });
  const surface = new ProjectMemorySurface({
    catalog,
    retrievalRuntime: createProjectMemoryRetrievalRuntime({
      lancedbUri: options.lancedbUri,
      lancedbTableName: options.lancedbTableName,
      embedderType: options.embedderType,
      embeddingModel: options.embeddingModel,
    }),
    projectConfig,
    artifactRoot,
  });

  const allowedLayers = options.allowedLayers?.length ? options.allowedLayers : undefined;
  const maxResultsPerLayer = options.maxResults
    ? buildMaxResultsPerLayer({
      allowedLayers,
      maxResults: options.maxResults,
    })
    : undefined;
  const result = await surface.searchProjectMemory({
    query: options.query,
    taskPacket: {
      task_id: options.taskId ?? `cli_project_memory_${Date.now()}`,
      title: options.taskTitle ?? options.query,
    },
    projectScope: options.projectScope ?? projectConfig.default_project_scope,
    intent: options.intent,
    allowedLayers,
    maxResultsPerLayer,
    trigger: options.trigger,
  });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    workspace_id: projectConfig.workspace_id,
    workspace_root: workspaceRoot,
    query: options.query,
    returned_record_ids: result.memory_invocation?.returned_record_ids ?? null,
    ...result,
  }, null, 2)}\n`);
}

function parseArgs(args) {
  const options = {
    catalogRoot: DEFAULT_CATALOG_ROOT,
    workspaceRoot: null,
    workspaceId: null,
    query: null,
    intent: "analysis",
    projectScope: undefined,
    allowedLayers: undefined,
    maxResults: undefined,
    lancedbUri: process.env.ECITR_LANCEDB_URI,
    lancedbTableName: process.env.ECITR_LANCEDB_TABLE,
    embedderType: process.env.ECITR_PROJECT_MEMORY_EMBEDDER
      ?? process.env.ECITR_LANCEDB_EMBEDDER
      ?? "hash",
    embeddingModel: process.env.ECITR_PROJECT_MEMORY_EMBEDDING_MODEL
      ?? process.env.ECITR_LANCEDB_EMBEDDING_MODEL,
    trigger: "discretionary",
    taskId: null,
    taskTitle: null,
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
      case "--query":
        options.query = args[++index];
        break;
      case "--intent":
        options.intent = args[++index];
        break;
      case "--project-scope":
        options.projectScope = args[++index];
        break;
      case "--allowed-layers":
        options.allowedLayers = args[++index].split(",").map((value) => value.trim()).filter(Boolean);
        break;
      case "--max-results":
        options.maxResults = Number.parseInt(args[++index], 10);
        break;
      case "--lancedb-uri":
        options.lancedbUri = args[++index];
        break;
      case "--lancedb-table":
        options.lancedbTableName = args[++index];
        break;
      case "--embedder":
        options.embedderType = args[++index];
        break;
      case "--embedding-model":
        options.embeddingModel = args[++index];
        break;
      case "--trigger":
        options.trigger = args[++index];
        break;
      case "--task-id":
        options.taskId = args[++index];
        break;
      case "--task-title":
        options.taskTitle = args[++index];
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.query || !options.query.trim()) {
    throw new Error("search-project-memory requires --query");
  }
  if (!options.workspaceRoot && !options.workspaceId) {
    options.workspaceRoot = process.cwd();
  }
  if (options.maxResults != null && (!Number.isInteger(options.maxResults) || options.maxResults < 1)) {
    throw new Error("search-project-memory --max-results must be a positive integer.");
  }

  return options;
}

function buildMaxResultsPerLayer({ allowedLayers, maxResults }) {
  const layers = allowedLayers?.length
    ? allowedLayers
    : ["tactics", "invariants", "cases", "evidence"];
  return Object.fromEntries(layers.map((layer) => [layer, maxResults]));
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildMaxResultsPerLayer,
  main,
  parseArgs,
};
