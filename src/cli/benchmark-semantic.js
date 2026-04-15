#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const { REPO_ROOT } = require("../validation/schema-registry");
const { readJson } = require("../validation/validator");
const { compareSemanticBackends } = require("../retrieval/semantic-benchmark");
const { buildSemanticEmbedder } = require("../retrieval/embedders/factory");
const { QdrantSemanticBackend } = require("../retrieval/semantic-backends/qdrant-backend");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { seedExampleCatalog } = require("../storage/seed-example-catalog");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const endpoint = options.qdrantUrl ?? process.env.ECITR_QDRANT_URL;
  const collectionName = options.collection ?? process.env.ECITR_QDRANT_COLLECTION;

  if (!endpoint || !collectionName) {
    throw new Error("benchmark-semantic requires --qdrant-url and --collection, or matching ECITR_QDRANT_URL and ECITR_QDRANT_COLLECTION env vars.");
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

  if (options.syncBeforeRun) {
    await backend.ensureCollection({
      denseVectorSize: embedder.denseVectorSize,
      recreate: options.recreateCollection,
    });
    await backend.syncCatalog();
  }

  const scenarios = loadScenarios(options.scenarioFile);
  const report = await compareSemanticBackends({
    scenarios,
    catalogs,
    qdrantBackend: backend,
  });

  const output = {
    ok: true,
    endpoint,
    collectionName,
    catalog_root: rootDir,
    scenario_file: options.scenarioFile ?? path.join(REPO_ROOT, "benchmarks", "semantic-backend-comparison.scenarios.json"),
    report,
  };

  if (options.outputFile) {
    fs.writeFileSync(options.outputFile, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

function loadScenarios(scenarioFile) {
  const resolvedPath = scenarioFile
    ? path.resolve(scenarioFile)
    : path.join(REPO_ROOT, "benchmarks", "semantic-backend-comparison.scenarios.json");

  return readJson(resolvedPath);
}

function loadOrSeedCatalog(options) {
  if (options.seedExamples) {
    return seedExampleCatalog({ rootDir: options.catalogRoot });
  }

  const rootDir = options.catalogRoot ?? process.env.ECITR_CATALOG_ROOT;
  if (!rootDir) {
    throw new Error("benchmark-semantic requires --catalog-root or --seed-examples.");
  }

  return {
    rootDir: path.resolve(rootDir),
    catalog: new FileBackedCatalog({ rootDir }),
  };
}

function parseArgs(args) {
  const options = {
    syncBeforeRun: true,
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
      case "--scenario-file":
        options.scenarioFile = args[++index];
        break;
      case "--output-file":
        options.outputFile = args[++index];
        break;
      case "--skip-sync":
        options.syncBeforeRun = false;
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
