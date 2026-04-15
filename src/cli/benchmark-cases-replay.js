#!/usr/bin/env node

const path = require("node:path");

const { runCaseReplayBenchmark, DEFAULT_REPLAY_MANIFEST } = require("../cases/case-replay-benchmark");
const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");

function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = runCaseReplayBenchmark({
    manifestPath: options.manifestPath,
    catalogRoot: options.catalogRoot,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function parseArgs(args) {
  const options = {
    manifestPath: DEFAULT_REPLAY_MANIFEST,
    catalogRoot: DEFAULT_CATALOG_ROOT,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--manifest":
        options.manifestPath = path.resolve(args[++index]);
        break;
      case "--catalog-root":
        options.catalogRoot = path.resolve(args[++index]);
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
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
}
