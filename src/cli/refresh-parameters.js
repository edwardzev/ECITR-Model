#!/usr/bin/env node

const path = require("node:path");

const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const { refreshParameters } = require("../parameters/refresh");

function main() {
  const options = parseArgs(process.argv.slice(2));
  const summary = refreshParameters(options);
  if ((summary.errors ?? 0) > 0 || (summary.conflicts ?? 0) > 0) {
    const error = new Error("parameter refresh reported conflicts or errors.");
    error.summary = summary;
    throw error;
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function parseArgs(args) {
  const options = {
    catalogRoot: DEFAULT_CATALOG_ROOT,
    dryRun: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--catalog-root":
        options.catalogRoot = path.resolve(args[++index]);
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

try {
  main();
} catch (error) {
  process.stderr.write(`${JSON.stringify(error.summary ?? { ok: false, error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
}
