#!/usr/bin/env node

const path = require("node:path");

const { DEFAULT_COLLECTION_NAME, DEFAULT_QDRANT_URL } = require("../importers/agent-ops-refresh");
const { refreshCodexIndex } = require("../importers/codex-refresh");
const { resolveDefaultCodexRoot } = require("../importers/codex-rollouts");
const { REPO_ROOT } = require("../validation/schema-registry");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await refreshCodexIndex(options);
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
}

function parseArgs(args) {
  const options = {
    codexRoot: process.env.ECITR_CODEX_ROOT ?? resolveDefaultCodexRoot(),
    catalogRoot: process.env.ECITR_CATALOG_ROOT ?? path.join(REPO_ROOT, ".local", "catalog"),
    qdrantUrl: process.env.ECITR_QDRANT_URL ?? DEFAULT_QDRANT_URL,
    collectionName: process.env.ECITR_QDRANT_COLLECTION ?? DEFAULT_COLLECTION_NAME,
    dryRun: false,
    includeSessions: true,
    includeArchived: true,
    workspaceRoot: null,
    skipStructuralCheck: false,
    recreateCollection: false,
    skipQdrantSync: true,
    embedderType: process.env.ECITR_EMBEDDER ?? "openai",
    embeddingModel: process.env.ECITR_EMBEDDING_MODEL,
    sparseBucketCount: 2048,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--codex-root":
        options.codexRoot = args[++index];
        break;
      case "--catalog-root":
        options.catalogRoot = args[++index];
        break;
      case "--qdrant-url":
        options.qdrantUrl = args[++index];
        break;
      case "--collection":
        options.collectionName = args[++index];
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
      case "--openai-organization":
        options.openAIOrganization = args[++index];
        break;
      case "--openai-project":
        options.openAIProject = args[++index];
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--skip-qdrant-sync":
        options.skipQdrantSync = true;
        break;
      case "--sync-qdrant":
        options.skipQdrantSync = false;
        break;
      case "--workspace-root":
        options.workspaceRoot = args[++index];
        break;
      case "--skip-sessions":
        options.includeSessions = false;
        break;
      case "--skip-archived":
        options.includeArchived = false;
        break;
      case "--skip-structural-check":
        options.skipStructuralCheck = true;
        break;
      case "--recreate-collection":
        options.recreateCollection = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.codexRoot) {
    throw new Error("refresh-codex requires --codex-root, ECITR_CODEX_ROOT, or ~/.codex.");
  }

  return options;
}

main().catch((error) => {
  if (error.summary) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, ...error.summary }, null, 2)}\n`);
  } else {
    process.stderr.write(`${error.message}\n`);
  }
  process.exitCode = 1;
});
