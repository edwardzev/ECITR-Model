#!/usr/bin/env node

const path = require("node:path");

const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const { summarizeMemoryInvocations } = require("../runtime/project-memory");
const { resolveProjectMemoryConfig } = require("../workspace/project-memory-config");

function main() {
  const options = parseArgs(process.argv.slice(2));
  const resolved = options.artifactRoot
    ? null
    : resolveProjectMemoryConfig(options);
  const artifactRoot = options.artifactRoot
    ?? resolved.artifactRoot
    ?? path.join(resolved.projectConfig.workspace_root, ".local", "memory-invocations");
  const report = summarizeMemoryInvocations({
    artifactRoot,
    since: options.since,
    until: options.until,
  });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    workspace_id: resolved?.projectConfig.workspace_id ?? null,
    ...report,
  }, null, 2)}\n`);
}

function parseArgs(args) {
  const options = {
    catalogRoot: DEFAULT_CATALOG_ROOT,
    workspaceRoot: null,
    workspaceId: null,
    artifactRoot: null,
    since: null,
    until: null,
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
      case "--artifact-root":
        options.artifactRoot = path.resolve(args[++index]);
        break;
      case "--since":
        options.since = args[++index];
        break;
      case "--until":
        options.until = args[++index];
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.artifactRoot && !options.workspaceRoot && !options.workspaceId) {
    options.workspaceRoot = process.cwd();
  }
  return options;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  main,
  parseArgs,
};
