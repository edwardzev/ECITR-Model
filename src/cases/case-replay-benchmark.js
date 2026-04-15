const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CaseCompiler } = require("./case-compiler");
const { CaseReviewSurface } = require("./case-review");
const { DEFAULT_CATALOG_ROOT } = require("./case-refresh");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { EcitrValidator } = require("../validation/validator");
const { REPO_ROOT } = require("../validation/schema-registry");

const DEFAULT_REPLAY_MANIFEST = path.join(
  REPO_ROOT,
  "fixtures",
  "benchmarks",
  "case-replay-benchmark.example.json",
);

function runCaseReplayBenchmark({
  manifestPath = DEFAULT_REPLAY_MANIFEST,
  catalogRoot = DEFAULT_CATALOG_ROOT,
} = {}) {
  const resolvedManifestPath = path.resolve(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(resolvedManifestPath, "utf8"));
  const liveSurface = new CaseReviewSurface({ catalogRoot });

  const results = manifest.entries.map((entry) => replayBenchmarkEntry(liveSurface, entry));

  return {
    benchmark_id: manifest.benchmark_id ?? path.basename(resolvedManifestPath, ".json"),
    description: manifest.description ?? null,
    manifest_path: resolvedManifestPath,
    total_entries: results.length,
    bucket_summary: summarizeByBucket(results),
    results,
  };
}

function replayBenchmarkEntry(liveSurface, entry) {
  const packet = liveSurface.findPacketForCase(entry.case_id);
  if (!packet) {
    return finalizeReplayEntry({
      entry,
      actualDecision: "block",
      reasons: ["missing compilation packet for case replay"],
      replayed: false,
    });
  }

  const compiler = new CaseCompiler();
  const originalDraft = compiler.compile(packet);
  const evidenceRecords = (originalDraft.evidence_refs ?? [])
    .map((evidenceId) => liveSurface.catalog.getRecord("evidence", evidenceId))
    .filter(Boolean);

  if (evidenceRecords.length === 0) {
    return finalizeReplayEntry({
      entry,
      actualDecision: "block",
      reasons: ["missing linked evidence records for case replay"],
      replayed: false,
    });
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-case-replay-"));
  try {
    seedReplayCatalog({ tempRoot, originalDraft, evidenceRecords, sourceCatalogRoot: liveSurface.catalogRoot });
    const replaySurface = new CaseReviewSurface({ catalogRoot: tempRoot });

    try {
      const completion = replaySurface.completeDraft({
        caseId: originalDraft.case_id,
        reviewer: "case-replay-benchmark",
        rationale: "Dry-run replay benchmark only.",
        amendedAt: entry.amended_at ?? "2099-01-01T00:00:00.000Z",
        preparedAt: entry.prepared_at ?? "2099-01-01T00:00:00.000Z",
        preparedBy: entry.prepared_by ?? "case-replay-benchmark",
        strategyId: entry.strategy_id ?? "case-replay-benchmark",
        dryRun: true,
      });

      return finalizeReplayEntry({
        entry,
        actualDecision: completion.review_readiness.approval_ready ? "approve" : "block",
        reasons: completion.review_readiness.reasons,
        replayed: true,
        completionPreview: {
          next_case_version: completion.nextRecord.case_version,
          when_to_apply: completion.nextRecord.applicability?.when_to_apply ?? [],
          when_not_to_apply: completion.nextRecord.applicability?.when_not_to_apply ?? [],
        },
      });
    } catch (error) {
      return finalizeReplayEntry({
        entry,
        actualDecision: "block",
        reasons: error.readiness?.reasons ?? [error.message],
        replayed: true,
      });
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function seedReplayCatalog({ tempRoot, originalDraft, evidenceRecords, sourceCatalogRoot }) {
  const validator = new EcitrValidator();
  const catalog = new FileBackedCatalog({ rootDir: tempRoot, validator });

  for (const evidenceRecord of evidenceRecords) {
    catalog.writeRecord("evidence", evidenceRecord);
    copyPayloadIntoReplayCatalog({
      verbatimPayloadRef: evidenceRecord.verbatim_payload_ref,
      sourceCatalogRoot,
      tempRoot,
    });
  }

  catalog.writeRecord("case", originalDraft);
}

function copyPayloadIntoReplayCatalog({ verbatimPayloadRef, sourceCatalogRoot, tempRoot }) {
  if (!verbatimPayloadRef) {
    return;
  }
  const sourcePath = path.resolve(sourceCatalogRoot, verbatimPayloadRef);
  if (!fs.existsSync(sourcePath)) {
    return;
  }
  const targetPath = path.resolve(tempRoot, verbatimPayloadRef);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
}

function summarizeByBucket(results) {
  const summary = {};
  for (const result of results) {
    const bucket = result.expected_bucket ?? "unlabeled";
    if (!summary[bucket]) {
      summary[bucket] = {
        total: 0,
        approved: 0,
        blocked: 0,
      };
    }
    summary[bucket].total += 1;
    if (result.actual_decision === "approve") {
      summary[bucket].approved += 1;
    } else {
      summary[bucket].blocked += 1;
    }
  }
  return summary;
}

function finalizeReplayEntry({
  entry,
  actualDecision,
  reasons,
  replayed,
  completionPreview = null,
}) {
  return {
    case_id: entry.case_id,
    label: entry.label ?? null,
    expected_bucket: entry.expected_bucket ?? null,
    note: entry.note ?? null,
    actual_decision: actualDecision,
    replayed,
    reasons,
    completion_preview: completionPreview,
  };
}

module.exports = {
  DEFAULT_REPLAY_MANIFEST,
  runCaseReplayBenchmark,
};
