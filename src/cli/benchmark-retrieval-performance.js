#!/usr/bin/env node
const path = require("node:path");
const { createPerformanceFixture, runPerformanceBenchmark } = require("../retrieval/retrieval-performance-benchmark");

async function main(args = process.argv.slice(2)) {
  const [command, ...flags] = args;
  const options = {};
  for (let index = 0; index < flags.length; index += 2) {
    const value = flags[index + 1];
    if (!value || value.startsWith("--")) throw new Error("Missing benchmark argument value.");
    switch (flags[index]) {
      case "--fixture-root": options.rootDir = path.resolve(value); break;
      case "--runtime-root": options.runtimeRoot = path.resolve(value); break;
      case "--evidence-count": options.evidenceCount = Number(value); break;
      case "--iterations": options.iterations = Number(value); break;
      default: throw new Error(`Unknown benchmark argument: ${flags[index]}`);
    }
  }
  if (!options.rootDir) throw new Error("Benchmark requires --fixture-root.");
  const result = command === "create" ? createPerformanceFixture(options)
    : command === "run" ? await runPerformanceBenchmark(options)
      : (() => { throw new Error("Expected benchmark command create or run."); })();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { main };
