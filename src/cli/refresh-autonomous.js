#!/usr/bin/env node

const { refreshCodexIndex } = require("../importers/codex-refresh");
const { refreshCases } = require("../cases/case-refresh");
const { runGovernedPromotion } = require("../runtime/governed-promotion-runner");

async function main() {
  const codex = await refreshCodexIndex();
  const cases = refreshCases();
  if ((cases.errors ?? 0) > 0) {
    const error = new Error("autonomous refresh reported case-distillation errors.");
    error.summary = { codex, cases };
    throw error;
  }

  const promotions = await runGovernedPromotion();

  process.stdout.write(`${JSON.stringify({ codex, cases, promotions }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
