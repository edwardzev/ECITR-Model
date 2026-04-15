#!/usr/bin/env node

const path = require("node:path");

const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const { InvariantHypothesisDeriver } = require("../invariants/hypothesis-deriver");

function main() {
  const options = parseArgs(process.argv.slice(2));
  const deriver = new InvariantHypothesisDeriver({
    catalogRoot: options.catalogRoot,
  });
  const manifest = deriver.deriveManifest({
    includeCoveredCases: options.includeCoveredCases,
    maxCandidates: options.maxCandidates,
    maxCandidatesPerCase: options.maxCandidatesPerCase,
    maxRareTokenDocumentFrequency: options.maxRareTokenDocumentFrequency,
    minSharedClauses: options.minSharedClauses,
    minSharedRareTokens: options.minSharedRareTokens,
    minRareTokenScore: options.minRareTokenScore,
    generatedAt: options.generatedAt,
  });

  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(buildSummary({ manifest, outputPath: null, dryRun: true }), null, 2)}\n`);
    return;
  }

  const write = deriver.writeManifest({
    manifest,
    overwrite: options.overwrite,
    outputPath: options.outputPath,
  });
  process.stdout.write(`${JSON.stringify(buildSummary({ manifest, outputPath: write.filePath, dryRun: false }), null, 2)}\n`);
}

function parseArgs(args) {
  const options = {
    catalogRoot: DEFAULT_CATALOG_ROOT,
    outputPath: undefined,
    includeCoveredCases: false,
    maxCandidates: 25,
    maxCandidatesPerCase: 4,
    maxRareTokenDocumentFrequency: 6,
    minSharedClauses: 1,
    minSharedRareTokens: 4,
    minRareTokenScore: 3,
    generatedAt: new Date().toISOString(),
    dryRun: false,
    overwrite: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--catalog-root":
        options.catalogRoot = path.resolve(args[++index]);
        break;
      case "--output-path":
        options.outputPath = path.resolve(args[++index]);
        break;
      case "--include-covered":
        options.includeCoveredCases = true;
        break;
      case "--max-candidates":
        options.maxCandidates = Number.parseInt(args[++index], 10);
        break;
      case "--max-candidates-per-case":
        options.maxCandidatesPerCase = Number.parseInt(args[++index], 10);
        break;
      case "--max-rare-token-df":
        options.maxRareTokenDocumentFrequency = Number.parseInt(args[++index], 10);
        break;
      case "--min-shared-clauses":
        options.minSharedClauses = Number.parseInt(args[++index], 10);
        break;
      case "--min-shared-rare-tokens":
        options.minSharedRareTokens = Number.parseInt(args[++index], 10);
        break;
      case "--min-rare-score":
        options.minRareTokenScore = Number.parseFloat(args[++index]);
        break;
      case "--generated-at":
        options.generatedAt = args[++index];
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--overwrite":
        options.overwrite = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  assertIntegerOption("--max-candidates", options.maxCandidates, 1);
  assertIntegerOption("--max-candidates-per-case", options.maxCandidatesPerCase, 1);
  assertIntegerOption("--max-rare-token-df", options.maxRareTokenDocumentFrequency, 1);
  assertIntegerOption("--min-shared-clauses", options.minSharedClauses, 0);
  assertIntegerOption("--min-shared-rare-tokens", options.minSharedRareTokens, 2);
  if (!Number.isFinite(options.minRareTokenScore) || options.minRareTokenScore <= 0) {
    throw new Error(`Invalid --min-rare-score: ${options.minRareTokenScore}`);
  }

  return options;
}

function assertIntegerOption(label, value, minimum) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function buildSummary({ manifest, outputPath, dryRun }) {
  return {
    dry_run: dryRun,
    derivation_id: manifest.derivation_id,
    output_path: outputPath,
    source_pool: manifest.source_pool,
    total_active_cases: manifest.total_active_cases,
    total_source_cases: manifest.total_source_cases,
    total_seed_pairs: manifest.total_seed_pairs,
    total_selected_candidates: manifest.total_selected_candidates,
    approved_candidate_count: manifest.approved_candidate_labels.length,
    blocked_candidate_count: manifest.blocked_candidate_labels.length,
    first_candidate_labels: manifest.entries.slice(0, 10).map((entry) => ({
      label: entry.label,
      expected_decision: entry.expected_decision,
      source_case_refs: entry.source_case_refs,
      shared_rare_tokens: entry.derivation_metadata.shared_rare_tokens,
    })),
  };
}

try {
  main();
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
}
