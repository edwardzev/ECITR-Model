const fs = require("node:fs");
const path = require("node:path");

const { explainCaseCompleteness, hasCompleteCaseFraming } = require("../lifecycle/rules");
const { REPO_ROOT } = require("../validation/schema-registry");

const DEFAULT_BATCH_LOG_DIR = path.join(REPO_ROOT, ".local", "review-drafts");

function runCaseBatch({
  surface,
  limit = 10,
  status = "draft",
  reviewState,
  workspaceId,
  batchLogDir = DEFAULT_BATCH_LOG_DIR,
  skipPreviouslyFailed,
  dryRun = false,
  reviewer = "governance-qa-steward",
  decisionRationale = "Approved after bounded completion and current benchmark-governed readiness gate.",
  completionReviewer = "case-steward",
  completionRationale = "Completed via bounded applicability generation under the current gate.",
  rejectErrors = true,
  rejectionRationale = "Autonomous reconciliation rejected this draft because it could not satisfy the current governed case gate.",
} = {}) {
  if (!surface) {
    throw new Error("runCaseBatch requires a case review surface");
  }

  const shouldSkipPreviouslyFailed = skipPreviouslyFailed ?? true;
  const failedCaseIds = shouldSkipPreviouslyFailed ? collectPreviouslyFailedCaseIds({ batchLogDir }) : new Set();
  const queue = surface.listPendingCases({
    limit: Number.MAX_SAFE_INTEGER,
    reviewState,
    status,
    workspaceId,
  }).cases;

  const selectedCases = [];
  const skippedFailedCases = [];
  for (const item of queue) {
    if (failedCaseIds.has(item.case_id)) {
      skippedFailedCases.push(item.case_id);
      continue;
    }
    selectedCases.push(item);
    if (selectedCases.length >= limit) {
      break;
    }
  }

  const nowBase = Date.now();
  const batchId = nextBatchId({ batchLogDir });
  const results = [];
  let approved = 0;
  let errors = 0;
  let rejected = 0;

  for (const [index, item] of selectedCases.entries()) {
    const caseId = item.case_id;
    const preparedAt = new Date(nowBase + index).toISOString();
    const reviewedAt = new Date(nowBase + 1000 + index).toISOString();
    let caseRecord = null;

    try {
      caseRecord = getCaseRecord(surface, caseId);
      const initialReadiness = caseRecord ? evaluateApprovalReadiness(caseRecord) : null;
      if (initialReadiness?.approval_ready) {
        const decision = dryRun
          ? applyApprovalDryRun({
              surface,
              caseRecord,
              reviewer,
              rationale: decisionRationale,
              reviewedAt,
            })
          : surface.applyDecision({
              caseId,
              decision: "approve",
              reviewer,
              rationale: decisionRationale,
              reviewedAt,
              dryRun,
            });

        approved += 1;
        results.push({
          case_id: caseId,
          status: "approved",
          completion_id: null,
          amendment_id: null,
          completion_skipped_reason: "already_approval_ready",
          audit_id: decision.auditEntry.audit_id,
          readiness: initialReadiness,
        });
        continue;
      }

      const completion = surface.completeDraft({
        caseId,
        reviewer: completionReviewer,
        rationale: completionRationale,
        amendedAt: preparedAt,
        preparedAt,
        dryRun,
      });

      const decision = dryRun
        ? applyApprovalDryRun({
            surface,
            caseRecord: completion.nextRecord,
            reviewer,
            rationale: decisionRationale,
            reviewedAt,
          })
        : surface.applyDecision({
            caseId,
            decision: "approve",
            reviewer,
            rationale: decisionRationale,
            reviewedAt,
            dryRun,
          });

      approved += 1;
      results.push({
        case_id: caseId,
        status: "approved",
        completion_id: completion.completionPacket.completion_id,
        amendment_id: completion.amendmentPacket.amendment_id,
        audit_id: decision.auditEntry.audit_id,
        readiness: completion.review_readiness,
      });
    } catch (error) {
      if (!dryRun && rejectErrors) {
        try {
          const rejection = surface.applyDecision({
            caseId,
            decision: "reject",
            reviewer,
            rationale: `${rejectionRationale} ${error.message}`,
            reviewedAt,
            dryRun,
          });
          rejected += 1;
          results.push({
            case_id: caseId,
            status: "rejected",
            error: error.message,
            readiness: error.readiness ?? null,
            audit_id: rejection.auditEntry.audit_id,
          });
          continue;
        } catch (rejectError) {
          errors += 1;
          results.push({
            case_id: caseId,
            status: "error",
            error: rejectError.message,
            readiness: rejectError.readiness ?? error.readiness ?? null,
          });
          continue;
        }
      }

      errors += 1;
      results.push({
        case_id: caseId,
        status: "error",
        error: error.message,
        readiness: error.readiness ?? null,
      });
    }
  }

  const report = {
    batch_id: batchId,
    started_at: new Date(nowBase).toISOString(),
    completed_at: new Date().toISOString(),
    total_cases: selectedCases.length,
    approved,
    rejected,
    errors,
    reject_errors: rejectErrors,
    skip_previously_failed: shouldSkipPreviouslyFailed,
    skipped_previously_failed_count: skippedFailedCases.length,
    case_ids: selectedCases.map((item) => item.case_id),
    results,
  };

  if (!dryRun) {
    fs.mkdirSync(batchLogDir, { recursive: true });
    const outputPath = path.join(batchLogDir, `${batchId}-results.json`);
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    report.output_path = outputPath;
  }

  return report;
}

function applyApprovalDryRun({ surface, caseRecord, reviewer, rationale, reviewedAt }) {
  const readiness = {
    approval_ready: hasCompleteCaseFraming(caseRecord) && explainCaseCompleteness(caseRecord).length === 0,
    reasons: explainCaseCompleteness(caseRecord),
  };

  if (!readiness.approval_ready) {
    const error = new Error(
      `Case ${caseRecord.case_id} is not approval-ready: ${readiness.reasons.join("; ")}`,
    );
    error.readiness = readiness;
    throw error;
  }

  const decisionPacket = {
    decision_id: `review_${caseRecord.case_id}_approve_${String(reviewedAt).replaceAll(/[^0-9TZ]/g, "").replaceAll(":", "").replaceAll("-", "")}`,
    record_type: "case",
    record_id: caseRecord.case_id,
    decision: "approve",
    reviewer,
    rationale,
    reviewed_at: reviewedAt,
  };

  return surface.reviewWorkflow.applyDecision({
    recordType: "case",
    record: caseRecord,
    decisionPacket,
  });
}

function getCaseRecord(surface, caseId) {
  if (surface?.catalog && typeof surface.catalog.getRecord === "function") {
    return surface.catalog.getRecord("case", caseId);
  }
  return null;
}

function evaluateApprovalReadiness(caseRecord) {
  const reasons = explainCaseCompleteness(caseRecord);
  return {
    approval_ready: hasCompleteCaseFraming(caseRecord) && reasons.length === 0,
    reasons,
  };
}

function collectPreviouslyFailedCaseIds({ batchLogDir = DEFAULT_BATCH_LOG_DIR } = {}) {
  const failed = new Set();
  for (const logPath of listBatchLogPaths({ batchLogDir })) {
    const log = JSON.parse(fs.readFileSync(logPath, "utf8"));
    for (const result of log.results ?? []) {
      if (isFailedResult(result)) {
        failed.add(result.case_id);
      }
    }
  }
  return failed;
}

function listBatchLogPaths({ batchLogDir = DEFAULT_BATCH_LOG_DIR } = {}) {
  if (!fs.existsSync(batchLogDir)) {
    return [];
  }
  return fs
    .readdirSync(batchLogDir)
    .filter((entry) => /^batch-\d+-results\.json$/.test(entry))
    .sort()
    .map((entry) => path.join(batchLogDir, entry));
}

function nextBatchId({ batchLogDir = DEFAULT_BATCH_LOG_DIR } = {}) {
  const paths = listBatchLogPaths({ batchLogDir });
  let max = 0;
  for (const logPath of paths) {
    const match = path.basename(logPath).match(/^batch-(\d+)-results\.json$/);
    if (!match) {
      continue;
    }
    max = Math.max(max, Number.parseInt(match[1], 10));
  }
  return `batch-${String(max + 1).padStart(3, "0")}`;
}

function isFailedResult(result) {
  if (!result || !result.case_id) {
    return false;
  }
  return result.status === "error" || result.status === "failed_precondition";
}

module.exports = {
  DEFAULT_BATCH_LOG_DIR,
  collectPreviouslyFailedCaseIds,
  listBatchLogPaths,
  nextBatchId,
  runCaseBatch,
};
