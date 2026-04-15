const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  DEFAULT_HOUR,
  DEFAULT_LABEL,
  DEFAULT_MINUTE,
  buildLaunchdPlan,
  renderLaunchdPlist,
} = require("../src/runtime/codex-refresh-launchd");

test("launchd plan defaults to the ECITR autonomous refresh job", () => {
  const plan = buildLaunchdPlan({
    repoRoot: "/tmp/ecitr",
    nodePath: "/opt/homebrew/bin/node",
  });

  assert.equal(plan.label, DEFAULT_LABEL);
  assert.equal(plan.hour, DEFAULT_HOUR);
  assert.equal(plan.minute, DEFAULT_MINUTE);
  assert.equal(plan.scriptPath, path.join("/tmp/ecitr", "src", "cli", "refresh-autonomous.js"));
  assert.equal(plan.stdoutPath, path.join("/tmp/ecitr", ".local", "logs", "autonomous-refresh-launchd.stdout.log"));
  assert.equal(plan.stderrPath, path.join("/tmp/ecitr", ".local", "logs", "autonomous-refresh-launchd.stderr.log"));
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
  assert.match(plist, /<string>\/tmp\/ecitr\/src\/cli\/refresh-autonomous\.js<\/string>/);
  assert.match(plist, /<key>Hour<\/key>\s*<integer>4<\/integer>/);
  assert.match(plist, /<key>Minute<\/key>\s*<integer>15<\/integer>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/);
});
