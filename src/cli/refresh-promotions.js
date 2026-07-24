#!/usr/bin/env node

const path = require("node:path");

const {
  DEFAULT_INVARIANT_BENCHMARK_MANIFEST,
  DEFAULT_TACTIC_BENCHMARK_MANIFEST,
  runGovernedPromotion,
} = require("../runtime/governed-promotion-runner");
const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const {
  DEFAULT_TABLE_NAME: DEFAULT_LANCEDB_TABLE_NAME,
} = require("../retrieval/semantic-backends/lancedb-backend");
const { DEFAULT_COLLECTION_NAME, DEFAULT_QDRANT_URL } = require("../importers/agent-ops-refresh");
const {
  DEFAULT_INVARIANT_ACTIVATION_CAP,
  DEFAULT_TACTIC_ACTIVATION_CAP,
} = require("../runtime/live-promotion-candidates");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runGovernedPromotion(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseArgs(args) {
  const options = {
    catalogRoot: DEFAULT_CATALOG_ROOT,
    reportDir: undefined,
    invariantManifestPath: DEFAULT_INVARIANT_BENCHMARK_MANIFEST,
    tacticManifestPath: DEFAULT_TACTIC_BENCHMARK_MANIFEST,
    caseBatchLimit: Number.MAX_SAFE_INTEGER,
    reviewer: "autonomous-governance-steward",
    reviewedAt: new Date().toISOString(),
    lancedbUri: process.env.ECITR_LANCEDB_URI,
    lancedbTableName: process.env.ECITR_LANCEDB_TABLE ?? DEFAULT_LANCEDB_TABLE_NAME,
    lancedbEmbedderType: process.env.ECITR_LANCEDB_EMBEDDER ?? "hash",
    lancedbEmbeddingModel: process.env.ECITR_LANCEDB_EMBEDDING_MODEL,
    qdrantUrl: DEFAULT_QDRANT_URL,
    collectionName: DEFAULT_COLLECTION_NAME,
    dryRun: false,
    enableLivePromotions: true,
    maxLiveInvariantCandidates: 25,
    maxLiveTacticCandidates: 25,
    invariantActivationCap: DEFAULT_INVARIANT_ACTIVATION_CAP,
    tacticActivationCap: DEFAULT_TACTIC_ACTIVATION_CAP,
    skipLanceDbSync: false,
    skipQdrantSync: true,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--catalog-root":
        options.catalogRoot = path.resolve(args[++index]);
        break;
      case "--report-dir":
        options.reportDir = path.resolve(args[++index]);
        break;
      case "--invariant-manifest":
        options.invariantManifestPath = path.resolve(args[++index]);
        break;
      case "--tactic-manifest":
        options.tacticManifestPath = path.resolve(args[++index]);
        break;
      case "--case-batch-limit":
        options.caseBatchLimit = Number.parseInt(args[++index], 10);
        break;
      case "--reviewer":
        options.reviewer = args[++index];
        break;
      case "--reviewed-at":
        options.reviewedAt = args[++index];
        break;
      case "--lancedb-uri":
        options.lancedbUri = args[++index];
        break;
      case "--lancedb-table":
        options.lancedbTableName = args[++index];
        break;
      case "--lancedb-embedder":
        options.lancedbEmbedderType = args[++index];
        break;
      case "--lancedb-embedding-model":
        options.lancedbEmbeddingModel = args[++index];
        break;
      case "--skip-lancedb-sync":
        options.skipLanceDbSync = true;
        break;
      case "--qdrant-url":
        options.qdrantUrl = args[++index];
        break;
      case "--collection":
        options.collectionName = args[++index];
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--disable-live-promotions":
        options.enableLivePromotions = false;
        break;
      case "--max-live-invariant-candidates":
        options.maxLiveInvariantCandidates = Number.parseInt(args[++index], 10);
        break;
      case "--max-live-tactic-candidates":
        options.maxLiveTacticCandidates = Number.parseInt(args[++index], 10);
        break;
      case "--invariant-activation-cap":
        options.invariantActivationCap = Number.parseInt(args[++index], 10);
        break;
      case "--tactic-activation-cap":
        options.tacticActivationCap = Number.parseInt(args[++index], 10);
        break;
      case "--skip-qdrant-sync":
        options.skipQdrantSync = true;
        break;
      case "--sync-qdrant":
        options.skipQdrantSync = false;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.caseBatchLimit) || options.caseBatchLimit < 0) {
    throw new Error(`Invalid --case-batch-limit: ${options.caseBatchLimit}`);
  }
  for (const optionName of [
    "maxLiveInvariantCandidates",
    "maxLiveTacticCandidates",
    "invariantActivationCap",
    "tacticActivationCap",
  ]) {
    if (!Number.isInteger(options[optionName]) || options[optionName] < 0) {
      throw new Error(`Invalid --${optionName.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}: ${options[optionName]}`);
    }
  }

  return options;
}

main().catch((error) => {
  const payload = {
    ok: false,
    error: error.message,
  };

  if (error.benchmark) {
    payload.benchmark = error.benchmark;
  }

  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
});
