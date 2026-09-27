#!/usr/bin/env node

const path = require("node:path");
const fs = require("node:fs");

const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const { summarizeMemoryInvocations } = require("../runtime/project-memory");
const { summarizeSessionMemoryInvocations } = require("../runtime/project-memory-session-report");
const { resolveProjectMemoryConfig } = require("../workspace/project-memory-config");
const { readTelemetryOption } = require("./project-memory-telemetry-options");

function main() {
  const options = parseArgs(process.argv.slice(2));
  const sessionMode = options.sessionFile != null || options.telemetryContext?.session_ref != null;
  const resolved = options.artifactRoot && !sessionMode
    ? null
    : resolveProjectMemoryConfig(options);
  if (sessionMode && ((options.workspaceId != null && options.workspaceId !== resolved.projectConfig.workspace_id)
    || (options.catalogRootExplicit && options.catalogRoot !== resolved.projectConfig.catalog_root))) {
    throw new Error("Explicit workspace or catalog selector conflicts with the resolved workspace configuration.");
  }
  const artifactRoot = options.artifactRoot
    ?? resolved.artifactRoot
    ?? path.join(resolved.projectConfig.workspace_root, ".local", "memory-invocations");
  const report = sessionMode ? summarizeSessionMemoryInvocations({
    artifactRoot, projectConfig: resolved.projectConfig, sessionFile: options.sessionFile,
    context: options.telemetryContext,
  }) : summarizeMemoryInvocations({
    artifactRoot,
    since: options.since,
    until: options.until,
    eligiblePopulation: options.populationFile ? JSON.parse(fs.readFileSync(options.populationFile, "utf8")) : null,
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
  const selectors = new Map();
  const selector = (flag, value, resolvePath = false) => {
    if (typeof value !== "string" || !value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    const resolved = resolvePath ? path.resolve(value) : value;
    if (!selectors.has(flag)) selectors.set(flag, new Set());
    selectors.get(flag).add(resolved);
    return resolved;
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (["--session-file", "--session-ref", "--thread-ref", "--run-ref", "--task-workspace-relation"].includes(arg)) {
      readTelemetryOption(options, arg, args[++index]);
      continue;
    }
    switch (arg) {
      case "--catalog-root":
        options.catalogRoot = selector(arg, args[++index], true);
        options.catalogRootExplicit = true;
        break;
      case "--workspace-root":
        options.workspaceRoot = selector(arg, args[++index], true);
        break;
      case "--workspace-id":
        options.workspaceId = selector(arg, args[++index]);
        break;
      case "--artifact-root":
        options.artifactRoot = selector(arg, args[++index], true);
        break;
      case "--population-file":
        options.populationFile = path.resolve(args[++index]);
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

  const sessionMode = options.sessionFile != null || options.telemetryContext?.session_ref != null;
  if (sessionMode && [...selectors.values()].some((values) => values.size > 1)) {
    throw new Error("Conflicting exact-session report selectors.");
  }
  if (sessionMode && (options.since != null || options.until != null || options.populationFile != null)) {
    throw new Error("Exact-session follow-through cannot use a time or population filter that could hide a callback.");
  }
  if (options.telemetryContext && !sessionMode) throw new Error("Task context reporting requires an explicit session-file or session-ref.");
  if ((sessionMode || !options.artifactRoot) && !options.workspaceRoot && !options.workspaceId) {
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
