#!/usr/bin/env node

const { refreshSupportGraph } = require("../support-graph/refresh");

function main() {
  const options = parseArgs(process.argv.slice(2));
  const summary = refreshSupportGraph(options);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function parseArgs(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--catalog-root":
        options.catalogRoot = args[++index];
        break;
      case "--graph-root":
        options.graphRoot = args[++index];
        break;
      case "--built-at":
        options.builtAt = args[++index];
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
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
