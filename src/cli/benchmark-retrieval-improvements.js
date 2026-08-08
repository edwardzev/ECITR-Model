#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const { REPO_ROOT } = require("../validation/schema-registry");
const { readJson } = require("../validation/validator");
const {
  compareRetrievalTokenizers,
  runRetrievalGateBenchmark,
} = require("../retrieval/retrieval-improvement-benchmark");

function main() {
  const options = parseArgs(process.argv.slice(2));
  const tokenizationScenarios = readJson(options.tokenizationScenarios);
  const gateScenarios = readJson(options.gateScenarios);
  const tokenization = compareRetrievalTokenizers({ scenarios: tokenizationScenarios });
  const gate = runRetrievalGateBenchmark({ scenarios: gateScenarios });
  const output = {
    ok: tokenization.variants.unicode_v2.failing_scenarios === 0
      && gate.acceptance.passes,
    generated_at: new Date().toISOString(),
    tokenization_scenario_file: options.tokenizationScenarios,
    gate_scenario_file: options.gateScenarios,
    tokenization,
    gate,
  };

  if (options.outputFile) {
    fs.writeFileSync(options.outputFile, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!output.ok) {
    process.exitCode = 1;
  }
}

function parseArgs(args) {
  const options = {
    tokenizationScenarios: path.join(REPO_ROOT, "benchmarks", "retrieval-tokenization.scenarios.json"),
    gateScenarios: path.join(REPO_ROOT, "benchmarks", "retrieval-gate.scenarios.json"),
    outputFile: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--tokenization-scenarios":
        options.tokenizationScenarios = path.resolve(args[++index]);
        break;
      case "--gate-scenarios":
        options.gateScenarios = path.resolve(args[++index]);
        break;
      case "--output-file":
        options.outputFile = path.resolve(args[++index]);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  main,
  parseArgs,
};
