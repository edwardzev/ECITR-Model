#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const { runAutonomousRefresh } = require("./refresh-autonomous");
const {
  buildLaunchdPlan,
  rotateLaunchdLogs,
} = require("../runtime/codex-refresh-launchd");
const { REPO_ROOT } = require("../validation/schema-registry");

const DEFAULT_REPORT_ROOT = path.join(
  REPO_ROOT,
  ".local",
  "reports",
  "autonomous-refresh",
);
const DEFAULT_REPORT_RETENTION = 30;

async function main() {
  const logRotation = rotateLaunchdLogs(buildLaunchdPlan());
  const summary = await runAutonomousRefresh();
  const report = writeAutonomousRefreshReport({ summary });
  process.stdout.write(`${JSON.stringify({
    ok: summary.ok,
    completed_at: summary.completed_at,
    report_path: report.report_path,
    reports_removed: report.reports_removed,
    log_rotation: logRotation,
    error_count: summary.errors.length,
    warning_count: summary.warnings.length,
  })}\n`);
  if (!summary.ok) {
    process.exitCode = 1;
  }
}

function writeAutonomousRefreshReport({
  summary,
  reportRoot = DEFAULT_REPORT_ROOT,
  retention = DEFAULT_REPORT_RETENTION,
} = {}) {
  const completedAt = summary.completed_at ?? summary.started_at ?? new Date().toISOString();
  const reportPath = path.join(
    path.resolve(reportRoot),
    `${sanitizeTimestamp(completedAt)}.json`,
  );
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  writeJsonAtomic(reportPath, summary);
  writeJsonAtomic(path.join(path.resolve(reportRoot), "latest.json"), summary);

  const reportsRemoved = pruneReports({
    reportRoot,
    retention,
  });
  return {
    report_path: reportPath,
    reports_removed: reportsRemoved,
  };
}

function pruneReports({
  reportRoot = DEFAULT_REPORT_ROOT,
  retention = DEFAULT_REPORT_RETENTION,
} = {}) {
  const resolvedRoot = path.resolve(reportRoot);
  if (!fs.existsSync(resolvedRoot)) {
    return 0;
  }

  const limit = normalizeRetention(retention);
  const reports = fs.readdirSync(resolvedRoot)
    .filter((entry) => entry.endsWith(".json") && entry !== "latest.json")
    .sort((left, right) => right.localeCompare(left));
  for (const report of reports.slice(limit)) {
    fs.rmSync(path.join(resolvedRoot, report), { force: true });
  }
  return Math.max(0, reports.length - limit);
}

function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function normalizeRetention(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 1
    ? parsed
    : DEFAULT_REPORT_RETENTION;
}

function sanitizeTimestamp(value) {
  return String(value).replace(/[-:.TZ]/g, "");
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: error?.message ?? String(error),
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_REPORT_RETENTION,
  DEFAULT_REPORT_ROOT,
  main,
  pruneReports,
  writeAutonomousRefreshReport,
};
