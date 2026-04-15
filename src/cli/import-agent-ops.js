#!/usr/bin/env node

const { importAgentOpsRuns } = require("../importers/agent-ops-runs");
const { importAgentOpsSessions } = require("../importers/agent-ops-sessions");

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));

  let result;
  switch (command) {
    case "runs":
      result = importAgentOpsRuns(options);
      break;
    case "sessions":
      result = importAgentOpsSessions(options);
      break;
    default:
      throw new Error(`Unsupported agent-ops import command: ${command}`);
  }

  process.stdout.write(`${JSON.stringify({ ok: true, command, ...result }, null, 2)}\n`);
}

function parseArgs(args) {
  const options = {
    dryRun: true,
    limit: Number.POSITIVE_INFINITY,
    projectId: null,
    agentOpsRoot: process.env.ECITR_AGENT_OPS_ROOT,
    catalogRoot: process.env.ECITR_CATALOG_ROOT,
  };

  const [command = "runs", ...rest] = args;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    switch (arg) {
      case "--agent-ops-root":
        options.agentOpsRoot = rest[++index];
        break;
      case "--catalog-root":
        options.catalogRoot = rest[++index];
        break;
      case "--project-id":
        options.projectId = rest[++index];
        break;
      case "--limit":
        options.limit = Number.parseInt(rest[++index], 10);
        break;
      case "--write":
        options.dryRun = false;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.agentOpsRoot) {
    throw new Error("import-agent-ops requires --agent-ops-root or ECITR_AGENT_OPS_ROOT.");
  }

  if (!options.catalogRoot) {
    throw new Error("import-agent-ops requires --catalog-root or ECITR_CATALOG_ROOT.");
  }

  if (options.limit !== Number.POSITIVE_INFINITY && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new Error("import-agent-ops --limit must be a positive integer.");
  }

  return {
    command,
    options,
  };
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
