const fs = require("node:fs");
const path = require("node:path");

const { CaseReviewSurface, evaluateCaseReadiness } = require("./case-review");
const { DEFAULT_CATALOG_ROOT } = require("./case-refresh");

const DEFAULT_BENCHMARK_MANIFEST = path.resolve(
  DEFAULT_CATALOG_ROOT,
  "..",
  "benchmarks",
  "case-review-benchmark.v1.json",
);

function runCaseReviewBenchmark({ manifestPath = DEFAULT_BENCHMARK_MANIFEST, catalogRoot = DEFAULT_CATALOG_ROOT }) {
  const resolvedManifestPath = path.resolve(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(resolvedManifestPath, "utf8"));
  const surface = new CaseReviewSurface({ catalogRoot });

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
  const inspection = surface.inspectCase(entry.case_id);
  const record = inspection.case;
  const mode = entry.mode ?? "readiness";

  if (mode === "readiness") {
    const readiness = evaluateCaseReadiness(record);
    return finalizeBenchmarkEntry({
      entry,
      status: record.status,
      reviewState: record.review_state,
      actualDecision: readiness.approval_ready ? "approve" : "block",
      reasons: readiness.reasons,
    });
  }

  if (mode === "draft_flow") {
    if (record.status !== "draft") {
      return finalizeBenchmarkEntry({
        entry,
        status: record.status,
        reviewState: record.review_state,
        actualDecision: "block",
        reasons: [`draft_flow requires a draft case, but current status is ${record.status}`],
      });
    }

    const completion = surface.completeDraft({
      caseId: entry.case_id,
      reviewer: "benchmark-runner",
      rationale: "Dry-run benchmark evaluation only.",
      amendedAt: entry.amended_at ?? "2099-01-01T00:00:00.000Z",
      preparedAt: entry.prepared_at ?? "2099-01-01T00:00:00.000Z",
      preparedBy: entry.prepared_by ?? "case-review-benchmark",
      strategyId: entry.strategy_id ?? "case-review-benchmark",
      dryRun: true,
    });

    return finalizeBenchmarkEntry({
      entry,
      status: record.status,
      reviewState: record.review_state,
      actualDecision: completion.review_readiness.approval_ready ? "approve" : "block",
      reasons: completion.review_readiness.reasons,
      completionPreview: {
        next_case_version: completion.nextRecord.case_version,
        when_to_apply: completion.nextRecord.applicability?.when_to_apply ?? [],
        when_not_to_apply: completion.nextRecord.applicability?.when_not_to_apply ?? [],
      },
    });
  }

  throw new Error(`Unsupported benchmark mode: ${mode}`);
}

function finalizeBenchmarkEntry({ entry, status, reviewState, actualDecision, reasons, completionPreview = null }) {
  const expectedDecision = entry.expected_decision;
  const matchesExpected = actualDecision === expectedDecision;
  let mismatchType = null;

  if (!matchesExpected) {
    mismatchType = expectedDecision === "approve" ? "false_negative" : "false_positive";
  }

  return {
    case_id: entry.case_id,
    label: entry.label ?? null,
    mode: entry.mode ?? "readiness",
    expected_decision: expectedDecision,
    actual_decision: actualDecision,
    matches_expected: matchesExpected,
    mismatch_type: mismatchType,
    note: entry.note ?? null,
    status,
    review_state: reviewState,
    reasons,
    completion_preview: completionPreview,
  };
}

module.exports = {
  DEFAULT_BENCHMARK_MANIFEST,
  runCaseReviewBenchmark,
};
