const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DEFAULT_ENVIRONMENT_VARIABLES,
  DEFAULT_HOUR,
  DEFAULT_LABEL,
  DEFAULT_MINUTE,
  buildLaunchdPlan,
  renderLaunchdPlist,
  rotateLaunchdLogs,
} = require("../src/runtime/codex-refresh-launchd");
const {
  writeAutonomousRefreshReport,
} = require("../src/cli/run-autonomous-refresh-launchd");

test("launchd plan defaults to the ECITR autonomous refresh job", () => {
  const plan = buildLaunchdPlan({
    repoRoot: "/tmp/ecitr",
    nodePath: "/opt/homebrew/bin/node",
  });

  assert.equal(plan.label, DEFAULT_LABEL);
  assert.equal(plan.hour, DEFAULT_HOUR);
  assert.equal(plan.minute, DEFAULT_MINUTE);
  assert.equal(plan.scriptPath, path.join(
    "/tmp/ecitr",
    "src",
    "cli",
    "run-autonomous-refresh-launchd.js",
  ));
  assert.equal(plan.stdoutPath, path.join("/tmp/ecitr", ".local", "logs", "autonomous-refresh-launchd.stdout.log"));
  assert.equal(plan.stderrPath, path.join("/tmp/ecitr", ".local", "logs", "autonomous-refresh-launchd.stderr.log"));
  assert.deepEqual(plan.environmentVariables, DEFAULT_ENVIRONMENT_VARIABLES);
});

test("launchd plist renders the exact command and overnight schedule", () => {
  const plan = buildLaunchdPlan({
    repoRoot: "/tmp/ecitr",
    nodePath: "/opt/homebrew/bin/node",
    label: "com.example.ecitr",
    hour: 4,
    minute: 15,
  });

  const plist = renderLaunchdPlist(plan);

  assert.match(plist, /<string>com\.example\.ecitr<\/string>/);
  assert.match(plist, /<string>\/opt\/homebrew\/bin\/node<\/string>/);
  assert.match(plist, /<string>\/tmp\/ecitr\/src\/cli\/run-autonomous-refresh-launchd\.js<\/string>/);
  assert.match(plist, /<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>ECITR_PROMOTION_JUDGE<\/key>\s*<string>local<\/string>/);
  assert.match(plist, /<key>Hour<\/key>\s*<integer>4<\/integer>/);
  assert.match(plist, /<key>Minute<\/key>\s*<integer>15<\/integer>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/);
});

test("launchd log rotation bounds oversized redirected logs", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-launchd-logs-"));
  const plan = buildLaunchdPlan({ repoRoot: rootDir });
  fs.mkdirSync(path.dirname(plan.stdoutPath), { recursive: true });
  fs.writeFileSync(plan.stdoutPath, "x".repeat(101), "utf8");

  const result = rotateLaunchdLogs(plan, {
    maxBytes: 100,
    retention: 2,
  });

  assert.equal(result.stdout_rotated, true);
  assert.equal(result.stderr_rotated, false);
  assert.equal(fs.existsSync(plan.stdoutPath), false);
  assert.equal(fs.readFileSync(`${plan.stdoutPath}.1`, "utf8").length, 101);
});

test("launchd runner keeps only the configured structured report history", () => {
  const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-launchd-reports-"));

  for (let index = 0; index < 4; index += 1) {
    writeAutonomousRefreshReport({
      reportRoot,
      retention: 2,
      summary: {
        ok: true,
        started_at: `2026-07-2${index}T04:15:00.000Z`,
        completed_at: `2026-07-2${index}T04:16:00.000Z`,
        warnings: [],
        errors: [],
      },
    });
  }

  const reports = fs.readdirSync(reportRoot)
    .filter((entry) => entry.endsWith(".json") && entry !== "latest.json");
  assert.deepEqual(reports, [
    "20260722041600000.json",
    "20260723041600000.json",
  ]);
  const latest = JSON.parse(fs.readFileSync(path.join(reportRoot, "latest.json"), "utf8"));
  assert.equal(latest.completed_at, "2026-07-23T04:16:00.000Z");
});
