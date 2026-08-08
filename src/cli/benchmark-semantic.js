#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const { REPO_ROOT } = require("../validation/schema-registry");
const { readJson } = require("../validation/validator");
const { compareSemanticBackends } = require("../retrieval/semantic-benchmark");
const { buildSemanticEmbedder } = require("../retrieval/embedders/factory");
const {
  DEFAULT_LANCEDB_URI,
  DEFAULT_TABLE_NAME: DEFAULT_LANCEDB_TABLE_NAME,
  LanceDbSemanticBackend,
} = require("../retrieval/semantic-backends/lancedb-backend");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { seedExampleCatalog } = require("../storage/seed-example-catalog");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { catalog, rootDir } = loadOrSeedCatalog(options);
  const catalogs = catalog.loadRuntimeCatalogs();
  const embedderType = options.embedderType
    ?? process.env.ECITR_LANCEDB_EMBEDDER
    ?? "hash";
  const embedder = buildSemanticEmbedder({
    embedderType,
    embeddingModel: options.embeddingModel,
    denseVectorSize: options.denseVectorSize,
    sparseBucketCount: options.sparseBucketCount ?? 2048,
    openAIApiKey: options.openAIApiKey ?? process.env.OPENAI_API_KEY,
    openAIBaseUrl: options.openAIBaseUrl ?? process.env.OPENAI_BASE_URL,
    openAIOrganization: options.openAIOrganization ?? process.env.OPENAI_ORGANIZATION,
    openAIProject: options.openAIProject ?? process.env.OPENAI_PROJECT,
  });
  const backendConfig = await buildCandidateBackend({
    options,
    catalogs,
    embedder,
  });

  const scenarios = loadScenarios(options.scenarioFile);
  const report = await compareSemanticBackends({
    scenarios,
    catalogs,
    candidateBackend: backendConfig.backend,
    candidateLabel: backendConfig.label,
  });
  const candidateQuality = report.quality_summary?.[backendConfig.label] ?? null;
  const qualityPassed = !candidateQuality || candidateQuality.failing_scenarios === 0;

  const output = {
    ok: qualityPassed,
    backend: backendConfig.label,
    backend_target: backendConfig.target,
    catalog_root: rootDir,
    scenario_file: options.scenarioFile ?? path.join(REPO_ROOT, "benchmarks", "semantic-backend-comparison.scenarios.json"),
    report,
  };

  if (options.outputFile) {
    fs.writeFileSync(options.outputFile, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!output.ok) {
    process.exitCode = 1;
  }
}

async function buildCandidateBackend({ options, catalogs, embedder }) {
  const uri = options.lancedbUri ?? process.env.ECITR_LANCEDB_URI ?? DEFAULT_LANCEDB_URI;
  const tableName = options.lancedbTable ?? process.env.ECITR_LANCEDB_TABLE ?? DEFAULT_LANCEDB_TABLE_NAME;
  const backend = new LanceDbSemanticBackend({
    uri,
    tableName,
    catalogs,
    embedder,
  });

  if (options.syncBeforeRun) {
    await backend.syncCatalog();
  }

  return {
    label: "lancedb",
    target: {
      uri,
      table_name: tableName,
    },
    backend,
  };
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
    backend: "lancedb",
    syncBeforeRun: true,
    seedExamples: false,
    embedderType: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--backend":
        options.backend = args[++index];
        break;
      case "--lancedb-uri":
        options.lancedbUri = args[++index];
        break;
      case "--lancedb-table":
        options.lancedbTable = args[++index];
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
      case "--seed-examples":
        options.seedExamples = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.backend !== "lancedb") {
    throw new Error(`Unsupported --backend: ${options.backend}`);
  }

  return options;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
