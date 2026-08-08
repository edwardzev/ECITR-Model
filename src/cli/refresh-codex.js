#!/usr/bin/env node

const path = require("node:path");

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
    dryRun: false,
    includeSessions: true,
    includeArchived: true,
    workspaceRoot: null,
    skipStructuralCheck: false,
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
      case "--dry-run":
        options.dryRun = true;
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
