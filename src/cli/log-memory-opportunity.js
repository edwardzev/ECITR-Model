#!/usr/bin/env node

const path = require("node:path");
const { readTelemetryOption, resolveTelemetryOptions, captureGap } = require("./project-memory-telemetry-options");

const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const { ProjectMemorySurface } = require("../runtime/project-memory");
const { resolveProjectMemoryConfig } = require("../workspace/project-memory-config");

function main() {
  const options = parseArgs(process.argv.slice(2));
  const resolved = resolveProjectMemoryConfig(options);
  if (!resolved.projectConfig.marker_path) throw new Error("A governed workspace marker is required before telemetry capture.");
  if (options.catalogRootExplicit && options.catalogRoot !== resolved.projectConfig.catalog_root) throw new Error("Explicit catalog root does not match workspace marker.");
  if (options.workspaceId && options.workspaceId !== resolved.projectConfig.workspace_id) throw new Error("Explicit workspace identity does not match marker.");
  const telemetryContext = resolveTelemetryOptions(options, resolved.projectConfig);
  const surface = new ProjectMemorySurface({
    projectConfig: resolved.projectConfig,
    artifactRoot: resolved.artifactRoot,
  });
  const invocation = surface.logTaskOpportunity({
    telemetryContext,
    query: options.query,
    trigger: options.trigger ?? "discretionary",
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
    if (readTelemetryOption(options, arg, args[index + 1])) { index += 1; continue; }
    switch (arg) {
      case "--catalog-root":
        options.catalogRoot = path.resolve(args[++index]);
        options.catalogRootExplicit = true;
        break;
      case "--workspace-root":
        options.workspaceRoot = path.resolve(args[++index]);
        break;
      case "--workspace-id":
        options.workspaceId = args[++index];
        break;
      case "--query":
        options.query = args[++index];
        break;
      case "--trigger":
        options.trigger = args[++index];
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
    process.stderr.write(`${JSON.stringify(captureGap(error), null, 2)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  main,
  parseArgs,
};
