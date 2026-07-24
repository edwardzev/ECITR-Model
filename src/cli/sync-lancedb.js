#!/usr/bin/env node

const path = require("node:path");

const {
  DEFAULT_LANCEDB_URI,
  DEFAULT_TABLE_NAME,
  LanceDbSemanticBackend,
} = require("../retrieval/semantic-backends/lancedb-backend");
const { buildSemanticEmbedder } = require("../retrieval/embedders/factory");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { seedExampleCatalog } = require("../storage/seed-example-catalog");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { catalog, rootDir } = loadOrSeedCatalog(options);
  const catalogs = catalog.loadRuntimeCatalogs();
  const embedder = buildSemanticEmbedder({
    embedderType: options.embedderType,
    embeddingModel: options.embeddingModel,
    denseVectorSize: options.denseVectorSize,
    sparseBucketCount: options.sparseBucketCount ?? 2048,
    openAIApiKey: options.openAIApiKey ?? process.env.OPENAI_API_KEY,
    openAIBaseUrl: options.openAIBaseUrl ?? process.env.OPENAI_BASE_URL,
    openAIOrganization: process.env.OPENAI_ORGANIZATION,
    openAIProject: process.env.OPENAI_PROJECT,
  });

  const backend = new LanceDbSemanticBackend({
    uri: options.uri,
    tableName: options.table,
    catalogs,
    embedder,
    createFtsIndex: options.createFtsIndex,
  });

  const result = await backend.syncCatalog();

  process.stdout.write(`${JSON.stringify({
    ok: true,
    catalog_root: rootDir,
    lancedb_uri: options.uri,
    table_name: options.table,
    rows_total: result.rows_total,
    status: result.status,
    dense_vector_size: embedder.denseVectorSize,
    sparse_bucket_count: embedder.sparseBucketCount,
    embedding_signature: embedder.embeddingSignature ?? null,
  }, null, 2)}\n`);
}

function loadOrSeedCatalog(options) {
  if (options.seedExamples) {
    return seedExampleCatalog({ rootDir: options.catalogRoot });
  }

  const rootDir = options.catalogRoot ?? process.env.ECITR_CATALOG_ROOT;
  if (!rootDir) {
    throw new Error("sync-lancedb requires --catalog-root or --seed-examples.");
  }

  return {
    rootDir: path.resolve(rootDir),
    catalog: new FileBackedCatalog({ rootDir }),
  };
}

function parseArgs(args) {
  const options = {
    uri: process.env.ECITR_LANCEDB_URI ?? DEFAULT_LANCEDB_URI,
    table: process.env.ECITR_LANCEDB_TABLE ?? DEFAULT_TABLE_NAME,
    seedExamples: false,
    embedderType: process.env.ECITR_EMBEDDER ?? "hash",
    createFtsIndex: true,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--uri":
        options.uri = args[++index];
        break;
      case "--table":
        options.table = args[++index];
        break;
      case "--catalog-root":
        options.catalogRoot = args[++index];
        break;
      case "--dense-vector-size":
        options.denseVectorSize = Number.parseInt(args[++index], 10);
        break;
      case "--sparse-bucket-count":
        options.sparseBucketCount = Number.parseInt(args[++index], 10);
        break;
      case "--embedder":
        options.embedderType = args[++index];
        break;
      case "--embedding-model":
        options.embeddingModel = args[++index];
        break;
      case "--openai-api-key":
        options.openAIApiKey = args[++index];
        break;
      case "--openai-base-url":
        options.openAIBaseUrl = args[++index];
        break;
      case "--skip-fts-index":
        options.createFtsIndex = false;
        break;
      case "--seed-examples":
        options.seedExamples = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
