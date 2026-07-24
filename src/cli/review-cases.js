#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const { DEFAULT_BATCH_LOG_DIR, runCaseBatch } = require("../cases/case-batch-runner");
const { CaseReviewSurface } = require("../cases/case-review");
const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const surface = new CaseReviewSurface({
    catalogRoot: options.catalogRoot,
  });

  if (command === "list") {
    process.stdout.write(`${JSON.stringify(surface.listPendingCases({
      limit: options.limit,
      reviewState: options.reviewState,
      status: options.status,
      workspaceId: options.workspaceId,
    }), null, 2)}\n`);
    return;
  }

  if (command === "show") {
    if (!options.caseId) {
      throw new Error("show requires --case-id");
    }
    process.stdout.write(`${JSON.stringify(surface.inspectCase(options.caseId), null, 2)}\n`);
    return;
  }

  if (command === "decide") {
    assertDecisionOptions(options);
    process.stdout.write(`${JSON.stringify(surface.applyDecision({
      caseId: options.caseId,
      decision: options.decision,
      reviewer: options.reviewer,
      rationale: options.rationale,
      reviewedAt: options.reviewedAt,
      dryRun: options.dryRun,
    }), null, 2)}\n`);
    return;
  }

  if (command === "amend") {
    assertAmendmentOptions(options);
    process.stdout.write(`${JSON.stringify(surface.amendDraft({
      caseId: options.caseId,
      changes: options.patch,
      reviewer: options.reviewer,
      rationale: options.rationale,
      amendedAt: options.amendedAt,
      baseCaseVersion: options.baseCaseVersion,
      dryRun: options.dryRun,
    }), null, 2)}\n`);
    return;
  }

  if (command === "complete") {
    assertCompletionOptions(options);
    process.stdout.write(`${JSON.stringify(surface.completeDraft({
      caseId: options.caseId,
      reviewer: options.reviewer,
      rationale: options.rationale,
      amendedAt: options.amendedAt,
      preparedAt: options.preparedAt,
      preparedBy: options.preparedBy,
      strategyId: options.strategyId,
      baseCaseVersion: options.baseCaseVersion,
      dryRun: options.dryRun,
    }), null, 2)}\n`);
    return;
  }

  if (command === "batch") {
    process.stdout.write(`${JSON.stringify(runCaseBatch({
      surface,
      limit: options.limit,
      status: options.status,
      reviewState: options.reviewState,
      workspaceId: options.workspaceId,
      batchLogDir: options.batchLogDir,
      skipPreviouslyFailed: options.skipPreviouslyFailed,
      dryRun: options.dryRun,
    }), null, 2)}\n`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function parseArgs(args) {
  const options = {
    catalogRoot: DEFAULT_CATALOG_ROOT,
    limit: 25,
    status: "draft",
    reviewState: undefined,
    workspaceId: undefined,
    caseId: undefined,
    decision: undefined,
    reviewer: undefined,
    rationale: undefined,
    reviewedAt: new Date().toISOString(),
    amendedAt: new Date().toISOString(),
    preparedAt: new Date().toISOString(),
    preparedBy: "case-completion-bounded-v1",
    strategyId: "bounded-case-completion-template-v1",
    baseCaseVersion: undefined,
    batchLogDir: DEFAULT_BATCH_LOG_DIR,
    skipPreviouslyFailed: true,
    patch: undefined,
    dryRun: false,
  };
  let command = "list";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "list":
      case "show":
      case "amend":
      case "complete":
      case "decide":
      case "batch":
        command = arg;
        break;
      case "--catalog-root":
        options.catalogRoot = path.resolve(args[++index]);
        break;
      case "--limit":
        options.limit = Number.parseInt(args[++index], 10);
        break;
      case "--status":
        options.status = args[++index];
        break;
      case "--review-state":
        options.reviewState = args[++index];
        break;
      case "--workspace-id":
        options.workspaceId = args[++index];
        break;
      case "--case-id":
        options.caseId = args[++index];
        break;
      case "--decision":
        options.decision = args[++index];
        break;
      case "--reviewer":
        options.reviewer = args[++index];
        break;
      case "--rationale":
        options.rationale = args[++index];
        break;
      case "--reviewed-at":
        options.reviewedAt = args[++index];
        break;
      case "--amended-at":
        options.amendedAt = args[++index];
        break;
      case "--prepared-at":
        options.preparedAt = args[++index];
        break;
      case "--prepared-by":
        options.preparedBy = args[++index];
        break;
      case "--strategy-id":
        options.strategyId = args[++index];
        break;
      case "--patch-file":
        options.patch = JSON.parse(fs.readFileSync(path.resolve(args[++index]), "utf8"));
        break;
      case "--base-case-version":
        options.baseCaseVersion = Number.parseInt(args[++index], 10);
        break;
      case "--batch-log-dir":
        options.batchLogDir = path.resolve(args[++index]);
        break;
      case "--include-previously-failed":
        options.skipPreviouslyFailed = false;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { command, options };
}

function assertDecisionOptions(options) {
  if (!options.caseId) {
    throw new Error("decide requires --case-id");
  }
  if (!options.decision) {
    throw new Error("decide requires --decision");
  }
  if (!options.reviewer) {
    throw new Error("decide requires --reviewer");
  }
  if (!options.rationale) {
    throw new Error("decide requires --rationale");
  }
}

function assertAmendmentOptions(options) {
  if (!options.caseId) {
    throw new Error("amend requires --case-id");
  }
  if (!options.reviewer) {
    throw new Error("amend requires --reviewer");
  }
  if (!options.rationale) {
    throw new Error("amend requires --rationale");
  }
  if (!options.patch) {
    throw new Error("amend requires --patch-file");
  }
}

function assertCompletionOptions(options) {
  if (!options.caseId) {
    throw new Error("complete requires --case-id");
  }
  if (!options.reviewer) {
    throw new Error("complete requires --reviewer");
  }
  if (!options.rationale) {
    throw new Error("complete requires --rationale");
  }
}

try {
  main();
} catch (error) {
  const payload = {
    ok: false,
    error: error.message,
  };

  if (error.readiness) {
    payload.readiness = error.readiness;
  }

  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
}
