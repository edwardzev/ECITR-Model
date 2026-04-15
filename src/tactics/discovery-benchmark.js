const fs = require("node:fs");
const path = require("node:path");

const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const { REPO_ROOT } = require("../validation/schema-registry");
const { TacticDiscoverySurface } = require("./discovery");

const DEFAULT_BENCHMARK_MANIFEST = path.join(
  REPO_ROOT,
  "fixtures",
  "benchmarks",
  "tactic-discovery-benchmark.example.json",
);

function runTacticDiscoveryBenchmark({
  manifestPath = DEFAULT_BENCHMARK_MANIFEST,
  catalogRoot = DEFAULT_CATALOG_ROOT,
} = {}) {
  const resolvedManifestPath = path.resolve(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(resolvedManifestPath, "utf8"));
  const surface = new TacticDiscoverySurface({ catalogRoot });

  const results = manifest.entries.map((entry) => evaluateBenchmarkEntry(surface, entry));
  const matches = results.filter((entry) => entry.matches_expected).length;
  const mismatches = results.length - matches;

  return {
    benchmark_id: manifest.benchmark_id ?? path.basename(resolvedManifestPath, ".json"),
    description: manifest.description ?? null,
    manifest_path: resolvedManifestPath,
    total_entries: results.length,
    matches_expected: matches,
    mismatches_expected: mismatches,
    false_positives: results.filter((entry) => entry.mismatch_type === "false_positive").length,
    false_negatives: results.filter((entry) => entry.mismatch_type === "false_negative").length,
    results,
  };
}

function evaluateBenchmarkEntry(surface, entry) {
  const evaluation = surface.evaluateCandidate(entry);
  const matchesExpected = evaluation.actual_decision === entry.expected_decision;

  return {
    label: entry.label ?? null,
    expected_decision: entry.expected_decision,
    actual_decision: evaluation.actual_decision,
    matches_expected: matchesExpected,
    mismatch_type: matchesExpected ? null : entry.expected_decision === "approve" ? "false_negative" : "false_positive",
    note: entry.note ?? null,
    packet_preview: evaluation.packet_preview,
    support_summary: evaluation.support_summary,
    reasons: evaluation.reasons,
    draft_preview: evaluation.draft_preview ?? null,
  };
}

module.exports = {
  DEFAULT_BENCHMARK_MANIFEST,
  runTacticDiscoveryBenchmark,
};
