#!/usr/bin/env node

const path = require("node:path");

const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const { ProjectMemorySurface } = require("../runtime/project-memory");
const { resolveProjectMemoryConfig } = require("../workspace/project-memory-config");

function main() {
  const options = parseArgs(process.argv.slice(2));
  const resolved = resolveProjectMemoryConfig(options);
  const surface = new ProjectMemorySurface({
    projectConfig: resolved.projectConfig,
    artifactRoot: resolved.artifactRoot,
  });
  const invocation = surface.logTaskOpportunity({
    taskPacket: {
      task_id: options.taskId,
      title: options.taskTitle,
    },
  });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    workspace_id: resolved.projectConfig.workspace_id,
    workspace_root: resolved.workspaceRoot,
    memory_invocation: invocation,
  }, null, 2)}\n`);
}

function parseArgs(args) {
  const options = {
    catalogRoot: DEFAULT_CATALOG_ROOT,
    workspaceRoot: null,
    workspaceId: null,
    taskId: null,
    taskTitle: null,
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
      case "--task-id":
        options.taskId = args[++index];
        break;
      case "--task-title":
        options.taskTitle = args[++index];
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.workspaceRoot && !options.workspaceId) {
    options.workspaceRoot = process.cwd();
  }
  if (!options.taskId || !options.taskTitle) {
    throw new Error("log-memory-opportunity requires --task-id and --task-title.");
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
