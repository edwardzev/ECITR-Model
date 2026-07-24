#!/usr/bin/env node

const path = require("node:path");

const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const { DEFAULT_BENCHMARK_MANIFEST, runTacticDiscoveryBenchmark } = require("../tactics/discovery-benchmark");

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = runTacticDiscoveryBenchmark({
    manifestPath: options.manifestPath,
    catalogRoot: options.catalogRoot,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if ((result.mismatches_expected ?? 0) > 0) {
    process.exitCode = 1;
  }
}

function parseArgs(args) {
  const options = {
    catalogRoot: DEFAULT_CATALOG_ROOT,
    manifestPath: DEFAULT_BENCHMARK_MANIFEST,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--catalog-root":
        options.catalogRoot = path.resolve(args[++index]);
        break;
      case "--manifest":
        options.manifestPath = path.resolve(args[++index]);
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
