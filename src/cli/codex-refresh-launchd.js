#!/usr/bin/env node

const {
  DEFAULT_HOUR,
  DEFAULT_LABEL,
  DEFAULT_MINUTE,
  buildLaunchdPlan,
  getLaunchdStatus,
  installLaunchdJob,
  renderLaunchdPlist,
  uninstallLaunchdJob,
} = require("../runtime/codex-refresh-launchd");

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));

  if (command === "install") {
    const result = installLaunchdJob(options);
    process.stdout.write(`${JSON.stringify({ ok: true, action: "install", ...toResultPayload(result) }, null, 2)}\n`);
    return;
  }

  if (command === "uninstall") {
    const result = uninstallLaunchdJob(options);
    process.stdout.write(`${JSON.stringify({ ok: true, action: "uninstall", ...toResultPayload(result) }, null, 2)}\n`);
    return;
  }

  if (command === "status") {
    const result = getLaunchdStatus(options);
    process.stdout.write(`${JSON.stringify({ ok: true, action: "status", ...toResultPayload(result) }, null, 2)}\n`);
    return;
  }

  if (command === "print-plist") {
    const plan = buildLaunchdPlan(options);
    process.stdout.write(renderLaunchdPlist(plan));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function parseArgs(args) {
  const options = {
    label: DEFAULT_LABEL,
    hour: DEFAULT_HOUR,
    minute: DEFAULT_MINUTE,
  };
  let command = "status";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "install":
      case "uninstall":
      case "status":
      case "print-plist":
        command = arg;
        break;
      case "--label":
        options.label = args[++index];
        break;
      case "--hour":
        options.hour = Number.parseInt(args[++index], 10);
        break;
      case "--minute":
        options.minute = Number.parseInt(args[++index], 10);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.hour) || options.hour < 0 || options.hour > 23) {
    throw new Error(`Invalid --hour: ${options.hour}`);
  }

  if (!Number.isInteger(options.minute) || options.minute < 0 || options.minute > 59) {
    throw new Error(`Invalid --minute: ${options.minute}`);
  }

  return { command, options };
}

function toResultPayload(result) {
  return {
    label: result.label,
    plist_path: result.plistPath,
    repo_root: result.repoRoot,
    node_path: result.nodePath,
    script_path: result.scriptPath,
    stdout_path: result.stdoutPath,
    stderr_path: result.stderrPath,
    service_target: result.serviceTarget,
    schedule: {
      hour: result.hour,
      minute: result.minute,
    },
    installed: result.installed,
    plist_exists: result.plist_exists,
    loaded: result.loaded,
  };
}

main();
