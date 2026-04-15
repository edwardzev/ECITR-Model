#!/usr/bin/env node

const path = require("node:path");

const { QdrantSemanticBackend } = require("../retrieval/semantic-backends/qdrant-backend");
const { buildSemanticEmbedder } = require("../retrieval/embedders/factory");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { seedExampleCatalog } = require("../storage/seed-example-catalog");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const endpoint = options.qdrantUrl ?? process.env.ECITR_QDRANT_URL;
  const collectionName = options.collection ?? process.env.ECITR_QDRANT_COLLECTION;

  if (!endpoint || !collectionName) {
    throw new Error("sync-qdrant requires --qdrant-url and --collection, or matching ECITR_QDRANT_URL and ECITR_QDRANT_COLLECTION env vars.");
  }

  const { catalog, rootDir } = loadOrSeedCatalog(options);
  const catalogs = catalog.loadRuntimeCatalogs();
  const embedder = buildSemanticEmbedder({
    embedderType: options.embedderType,
    embeddingModel: options.embeddingModel,
    denseVectorSize: options.denseVectorSize,
    sparseBucketCount: options.sparseBucketCount ?? 2048,
    openAIApiKey: options.openAIApiKey ?? process.env.OPENAI_API_KEY,
    openAIBaseUrl: options.openAIBaseUrl ?? process.env.OPENAI_BASE_URL,
    openAIOrganization: options.openAIOrganization ?? process.env.OPENAI_ORGANIZATION,
    openAIProject: options.openAIProject ?? process.env.OPENAI_PROJECT,
  });

  const backend = new QdrantSemanticBackend({
    endpoint,
    collectionName,
    catalogs,
    embedder,
  });

  if (options.ensureCollection) {
    await backend.ensureCollection({
      denseVectorSize: embedder.denseVectorSize,
      recreate: options.recreateCollection,
    });
  }

  const result = await backend.syncCatalog();

  process.stdout.write(`${JSON.stringify({
    ok: true,
    endpoint,
    collectionName,
    catalog_root: rootDir,
    points_upserted: result.plan.pointsToUpsert.length,
    points_deleted: result.plan.pointIdsToDelete.length,
    points_total: result.plan.exportedRecords.length,
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
    throw new Error("sync-qdrant requires --catalog-root or --seed-examples.");
  }

  return {
    rootDir: path.resolve(rootDir),
    catalog: new FileBackedCatalog({ rootDir }),
  };
}

function parseArgs(args) {
  const options = {
    ensureCollection: true,
    recreateCollection: false,
    seedExamples: false,
    embedderType: process.env.ECITR_EMBEDDER ?? "openai",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--qdrant-url":
        options.qdrantUrl = args[++index];
        break;
      case "--collection":
        options.collection = args[++index];
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
      case "--skip-ensure-collection":
        options.ensureCollection = false;
        break;
      case "--recreate-collection":
        options.recreateCollection = true;
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
