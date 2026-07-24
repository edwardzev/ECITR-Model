const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { REPO_ROOT } = require("../validation/schema-registry");

const DEFAULT_LABEL = "com.ecitr.autonomous-refresh";
const DEFAULT_HOUR = 4;
const DEFAULT_MINUTE = 15;
const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_LOG_RETENTION = 5;
const DEFAULT_ENVIRONMENT_VARIABLES = {
  ECITR_PROMOTION_JUDGE: "local",
};

function buildLaunchdPlan({
  repoRoot = REPO_ROOT,
  nodePath = process.execPath,
  label = DEFAULT_LABEL,
  hour = DEFAULT_HOUR,
  minute = DEFAULT_MINUTE,
  environmentVariables = DEFAULT_ENVIRONMENT_VARIABLES,
} = {}) {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedNodePath = path.resolve(nodePath);
  const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const plistPath = path.join(launchAgentsDir, `${label}.plist`);
  const stdoutPath = path.join(resolvedRepoRoot, ".local", "logs", "autonomous-refresh-launchd.stdout.log");
  const stderrPath = path.join(resolvedRepoRoot, ".local", "logs", "autonomous-refresh-launchd.stderr.log");
  const scriptPath = path.join(
    resolvedRepoRoot,
    "src",
    "cli",
    "run-autonomous-refresh-launchd.js",
  );

  return {
    label,
    hour,
    minute,
    repoRoot: resolvedRepoRoot,
    nodePath: resolvedNodePath,
    launchAgentsDir,
    plistPath,
    stdoutPath,
    stderrPath,
    scriptPath,
    environmentVariables: normalizeEnvironmentVariables(environmentVariables),
    domainTarget: `gui/${process.getuid()}`,
    serviceTarget: `gui/${process.getuid()}/${label}`,
  };
}

function renderLaunchdPlist(plan) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(plan.label)}</string>
  <key>WorkingDirectory</key>
  <string>${escapeXml(plan.repoRoot)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(plan.nodePath)}</string>
    <string>${escapeXml(plan.scriptPath)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${renderEnvironmentVariables(plan.environmentVariables)}
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${plan.hour}</integer>
    <key>Minute</key>
    <integer>${plan.minute}</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${escapeXml(plan.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(plan.stderrPath)}</string>
</dict>
</plist>
`;
}

function installLaunchdJob(options = {}) {
  const plan = buildLaunchdPlan(options);
  ensureLaunchdDirectories(plan);
  rotateLaunchdLogs(plan);
  fs.writeFileSync(plan.plistPath, renderLaunchdPlist(plan), "utf8");
  runLaunchctl(["bootout", plan.serviceTarget], { allowFailure: true });
  runLaunchctl(["bootstrap", plan.domainTarget, plan.plistPath]);
  runLaunchctl(["enable", plan.serviceTarget]);
  return {
    ...plan,
    installed: true,
  };
}

function rotateLaunchdLogs(
  plan,
  {
    maxBytes = DEFAULT_LOG_MAX_BYTES,
    retention = DEFAULT_LOG_RETENTION,
  } = {},
) {
  return {
    stdout_rotated: rotateFileIfOversize(plan.stdoutPath, { maxBytes, retention }),
    stderr_rotated: rotateFileIfOversize(plan.stderrPath, { maxBytes, retention }),
  };
}

function rotateFileIfOversize(filePath, { maxBytes, retention }) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size <= maxBytes) {
    return false;
  }

  for (let index = retention - 1; index >= 1; index -= 1) {
    const source = `${filePath}.${index}`;
    const target = `${filePath}.${index + 1}`;
    if (fs.existsSync(source)) {
      fs.renameSync(source, target);
    }
  }
  fs.renameSync(filePath, `${filePath}.1`);
  return true;
}

function uninstallLaunchdJob(options = {}) {
  const plan = buildLaunchdPlan(options);
  runLaunchctl(["bootout", plan.serviceTarget], { allowFailure: true });
  if (fs.existsSync(plan.plistPath)) {
    fs.unlinkSync(plan.plistPath);
  }

  return {
    ...plan,
    installed: false,
  };
}

function getLaunchdStatus(options = {}) {
  const plan = buildLaunchdPlan(options);
  const plistExists = fs.existsSync(plan.plistPath);
  const loaded = inspectLaunchctl(plan.serviceTarget);
  return {
    ...plan,
    plist_exists: plistExists,
    loaded,
  };
}

function inspectLaunchctl(serviceTarget) {
  try {
    execFileSync("launchctl", ["print", serviceTarget], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch (_error) {
    return false;
  }
}

function ensureLaunchdDirectories(plan) {
  fs.mkdirSync(plan.launchAgentsDir, { recursive: true });
  fs.mkdirSync(path.dirname(plan.stdoutPath), { recursive: true });
}

function normalizeEnvironmentVariables(environmentVariables) {
  return Object.fromEntries(
    Object.entries(environmentVariables ?? {})
      .filter(([key, value]) => key && value !== undefined && value !== null)
      .map(([key, value]) => [String(key), String(value)])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function renderEnvironmentVariables(environmentVariables) {
  return Object.entries(environmentVariables ?? {})
    .map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`)
    .join("\n");
}

function runLaunchctl(args, { allowFailure = false } = {}) {
  try {
    return execFileSync("launchctl", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (allowFailure) {
      return null;
    }

    const stderr = error.stderr ? String(error.stderr).trim() : error.message;
    throw new Error(`launchctl ${args.join(" ")} failed: ${stderr}`);
  }
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

module.exports = {
  DEFAULT_ENVIRONMENT_VARIABLES,
  DEFAULT_HOUR,
  DEFAULT_LABEL,
  DEFAULT_LOG_MAX_BYTES,
  DEFAULT_LOG_RETENTION,
  DEFAULT_MINUTE,
  buildLaunchdPlan,
  escapeXml,
  getLaunchdStatus,
  installLaunchdJob,
  rotateLaunchdLogs,
  renderLaunchdPlist,
  uninstallLaunchdJob,
};
