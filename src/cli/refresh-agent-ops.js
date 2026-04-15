#!/usr/bin/env node

const path = require("node:path");

const {
  DEFAULT_COLLECTION_NAME,
  DEFAULT_QDRANT_URL,
  refreshAgentOpsIndex,
  resolveDefaultAgentOpsRoot,
} = require("../importers/agent-ops-refresh");
const { REPO_ROOT } = require("../validation/schema-registry");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await refreshAgentOpsIndex(options);
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
}

function parseArgs(args) {
  const options = {
    agentOpsRoot: process.env.ECITR_AGENT_OPS_ROOT ?? resolveDefaultAgentOpsRoot(),
    catalogRoot: process.env.ECITR_CATALOG_ROOT ?? path.join(REPO_ROOT, ".local", "catalog"),
    qdrantUrl: process.env.ECITR_QDRANT_URL ?? DEFAULT_QDRANT_URL,
    collectionName: process.env.ECITR_QDRANT_COLLECTION ?? DEFAULT_COLLECTION_NAME,
    projectId: null,
    dryRun: false,
    skipSmokeCheck: false,
    recreateCollection: false,
    embedderType: process.env.ECITR_EMBEDDER ?? "openai",
    embeddingModel: process.env.ECITR_EMBEDDING_MODEL,
    sparseBucketCount: 2048,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--agent-ops-root":
        options.agentOpsRoot = args[++index];
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
      case "--project-id":
        options.projectId = args[++index];
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
      case "--skip-smoke-check":
        options.skipSmokeCheck = true;
        break;
      case "--recreate-collection":
        options.recreateCollection = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.agentOpsRoot) {
    throw new Error("refresh-agent-ops requires --agent-ops-root, ECITR_AGENT_OPS_ROOT, or a sibling ../agent-ops checkout.");
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
