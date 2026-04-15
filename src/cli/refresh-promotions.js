#!/usr/bin/env node

const path = require("node:path");

const {
  DEFAULT_INVARIANT_BENCHMARK_MANIFEST,
  DEFAULT_REPORT_DIR,
  DEFAULT_TACTIC_BENCHMARK_MANIFEST,
  runGovernedPromotion,
} = require("../runtime/governed-promotion-runner");
const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const { DEFAULT_COLLECTION_NAME, DEFAULT_QDRANT_URL } = require("../importers/agent-ops-refresh");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runGovernedPromotion(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseArgs(args) {
  const options = {
    catalogRoot: DEFAULT_CATALOG_ROOT,
    reportDir: DEFAULT_REPORT_DIR,
    invariantManifestPath: DEFAULT_INVARIANT_BENCHMARK_MANIFEST,
    tacticManifestPath: DEFAULT_TACTIC_BENCHMARK_MANIFEST,
    caseBatchLimit: Number.MAX_SAFE_INTEGER,
    reviewer: "autonomous-governance-steward",
    reviewedAt: new Date().toISOString(),
    qdrantUrl: DEFAULT_QDRANT_URL,
    collectionName: DEFAULT_COLLECTION_NAME,
    dryRun: false,
    skipQdrantSync: false,
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
      case "--qdrant-url":
        options.qdrantUrl = args[++index];
        break;
      case "--collection":
        options.collectionName = args[++index];
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--skip-qdrant-sync":
        options.skipQdrantSync = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.caseBatchLimit) || options.caseBatchLimit < 0) {
    throw new Error(`Invalid --case-batch-limit: ${options.caseBatchLimit}`);
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
