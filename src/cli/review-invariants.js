#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const { InvariantReviewSurface } = require("../invariants/review");

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const surface = new InvariantReviewSurface({
    catalogRoot: options.catalogRoot,
  });

  if (command === "promote-candidate") {
    if (!options.manifestPath) {
      throw new Error("promote-candidate requires --manifest");
    }
    if (!options.label) {
      throw new Error("promote-candidate requires --label");
    }
    if (!options.reviewer) {
      throw new Error("promote-candidate requires --reviewer");
    }
    if (!options.rationale) {
      throw new Error("promote-candidate requires --rationale");
    }

    const entry = loadManifestEntry(options.manifestPath, options.label);
    process.stdout.write(`${JSON.stringify(surface.promoteCandidate({
      entry,
      reviewer: options.reviewer,
      rationale: options.rationale,
      reviewedAt: options.reviewedAt,
      dryRun: options.dryRun,
    }), null, 2)}\n`);
    return;
  }

  if (command === "show") {
    if (!options.invariantId) {
      throw new Error("show requires --invariant-id");
    }
    process.stdout.write(`${JSON.stringify(surface.inspectInvariant(options.invariantId), null, 2)}\n`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function parseArgs(args) {
  const options = {
    catalogRoot: DEFAULT_CATALOG_ROOT,
    manifestPath: undefined,
    label: undefined,
    invariantId: undefined,
    reviewer: undefined,
    rationale: undefined,
    reviewedAt: new Date().toISOString(),
    dryRun: false,
  };
  let command = "show";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "promote-candidate":
      case "show":
        command = arg;
        break;
      case "--catalog-root":
        options.catalogRoot = path.resolve(args[++index]);
        break;
      case "--manifest":
        options.manifestPath = path.resolve(args[++index]);
        break;
      case "--label":
        options.label = args[++index];
        break;
      case "--invariant-id":
        options.invariantId = args[++index];
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
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { command, options };
}

function loadManifestEntry(manifestPath, label) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const entry = (manifest.entries ?? []).find((candidate) => candidate.label === label);
  if (!entry) {
    throw new Error(`manifest entry not found: ${label}`);
  }
  return entry;
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
