const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const DEFAULT_QDRANT_VERSION = "v1.17.1";
const STARTUP_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 250;

function getRepoRoot() {
  return path.resolve(__dirname, "..", "..");
}

function resolveLocalQdrantPaths({ repoRoot = getRepoRoot() } = {}) {
  const rootDir = path.join(repoRoot, ".local", "qdrant");
  const binDir = path.join(rootDir, "bin");
  const configDir = path.join(rootDir, "config");
  const logsDir = path.join(rootDir, "logs");
  const runDir = path.join(rootDir, "run");
  const storageDir = path.join(rootDir, "storage");
  const snapshotsDir = path.join(rootDir, "snapshots");
  const tempDir = path.join(rootDir, "temp");
  const binaryPath = path.join(binDir, "qdrant");

  return {
    repoRoot,
    rootDir,
    binDir,
    configDir,
    logsDir,
    runDir,
    storageDir,
    snapshotsDir,
    tempDir,
    binaryPath,
    archivePath: path.join(binDir, resolveReleaseAssetName()),
    configPath: path.join(configDir, "config.yaml"),
    pidPath: path.join(runDir, "qdrant.pid"),
    metaPath: path.join(runDir, "qdrant.json"),
    logPath: path.join(logsDir, "qdrant.log"),
  };
}

function resolveReleaseAssetName({ platform = process.platform, arch = process.arch } = {}) {
  if (platform === "darwin" && arch === "arm64") {
    return "qdrant-aarch64-apple-darwin.tar.gz";
  }

  if (platform === "darwin" && (arch === "x64" || arch === "x86_64")) {
    return "qdrant-x86_64-apple-darwin.tar.gz";
  }

  if (platform === "linux" && arch === "arm64") {
    return "qdrant-aarch64-unknown-linux-musl.tar.gz";
  }

  if (platform === "linux" && (arch === "x64" || arch === "x86_64")) {
    return "qdrant-x86_64-unknown-linux-gnu.tar.gz";
  }

  throw new Error(`Unsupported platform for managed Qdrant runtime: ${platform}/${arch}`);
}

function buildReleaseDownloadUrl({ version = DEFAULT_QDRANT_VERSION, assetName = resolveReleaseAssetName() } = {}) {
  return `https://github.com/qdrant/qdrant/releases/download/${version}/${assetName}`;
}

async function installLocalQdrantBinary({
  version = DEFAULT_QDRANT_VERSION,
  paths = resolveLocalQdrantPaths(),
  fetchImpl = globalThis.fetch,
} = {}) {
  if (fs.existsSync(paths.binaryPath)) {
    return {
      changed: false,
      binaryPath: paths.binaryPath,
      archivePath: paths.archivePath,
      version,
    };
  }

  if (typeof fetchImpl !== "function") {
    throw new Error("installLocalQdrantBinary requires a fetch-compatible implementation.");
  }

  ensureRuntimeDirectories(paths);

  const assetName = resolveReleaseAssetName();
  const url = buildReleaseDownloadUrl({ version, assetName });
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Failed to download Qdrant release ${version}: ${response.status} ${response.statusText}`);
  }

  const archiveBuffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(paths.archivePath, archiveBuffer);

  const untar = spawnSync("tar", ["-xzf", paths.archivePath, "-C", paths.binDir]);
  if (untar.status !== 0) {
    throw new Error(`Failed to extract Qdrant archive: ${untar.stderr?.toString("utf8") || "unknown tar error"}`.trim());
  }

  fs.chmodSync(paths.binaryPath, 0o755);

  return {
    changed: true,
    binaryPath: paths.binaryPath,
    archivePath: paths.archivePath,
    version,
    url,
  };
}

async function startLocalQdrant({
  version = DEFAULT_QDRANT_VERSION,
  paths = resolveLocalQdrantPaths(),
  host = "127.0.0.1",
  httpPort = 6333,
  grpcPort = 6334,
  fetchImpl = globalThis.fetch,
  startupTimeoutMs = STARTUP_TIMEOUT_MS,
} = {}) {
  ensureRuntimeDirectories(paths);
  await installLocalQdrantBinary({ version, paths, fetchImpl });

  const currentStatus = await getLocalQdrantStatus({
    paths,
    host,
    httpPort,
    fetchImpl,
  });

  if (currentStatus.pid && currentStatus.process_alive) {
    if (currentStatus.healthy) {
      return {
        changed: false,
        alreadyRunning: true,
        ...currentStatus,
      };
    }

    throw new Error(`Managed Qdrant process ${currentStatus.pid} exists but is not healthy.`);
  }

  if (currentStatus.port_occupied) {
    throw new Error(`Port ${httpPort} is already occupied by an unmanaged process. Stop it before starting managed Qdrant.`);
  }

  writeConfigFile({
    paths,
    host,
    httpPort,
    grpcPort,
  });

  const logFd = fs.openSync(paths.logPath, "a");
  const child = spawn(paths.binaryPath, ["--config-path", paths.configPath], {
    cwd: paths.rootDir,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);

  writeMetadata(paths, {
    pid: child.pid,
    version,
    host,
    http_port: httpPort,
    grpc_port: grpcPort,
    started_at: new Date().toISOString(),
    binary_path: paths.binaryPath,
    log_path: paths.logPath,
    config_path: paths.configPath,
  });

  const healthy = await waitForHealth({
    host,
    httpPort,
    fetchImpl,
    timeoutMs: startupTimeoutMs,
  });

  if (!healthy) {
    clearMetadata(paths);
    throw new Error(`Managed Qdrant process ${child.pid} did not become healthy within ${startupTimeoutMs}ms.`);
  }

  return {
    changed: true,
    pid: child.pid,
    binary_path: paths.binaryPath,
    config_path: paths.configPath,
    log_path: paths.logPath,
    storage_path: paths.storageDir,
    snapshots_path: paths.snapshotsDir,
    temp_path: paths.tempDir,
    endpoint: `http://${host}:${httpPort}`,
  };
}

async function stopLocalQdrant({
  paths = resolveLocalQdrantPaths(),
  host = "127.0.0.1",
  httpPort = 6333,
  fetchImpl = globalThis.fetch,
  shutdownTimeoutMs = SHUTDOWN_TIMEOUT_MS,
} = {}) {
  const status = await getLocalQdrantStatus({
    paths,
    host,
    httpPort,
    fetchImpl,
  });

  if (!status.pid) {
    return {
      changed: false,
      stopped: false,
      reason: status.port_occupied
        ? "port occupied by unmanaged process"
        : "no managed qdrant pid file",
      ...status,
    };
  }

  if (!status.process_alive) {
    clearMetadata(paths);
    return {
      changed: true,
      stopped: true,
      reason: "stale pid file removed",
      ...status,
    };
  }

  process.kill(status.pid, "SIGTERM");
  const exited = await waitForProcessExit(status.pid, shutdownTimeoutMs);
  if (!exited) {
    process.kill(status.pid, "SIGKILL");
    await waitForProcessExit(status.pid, shutdownTimeoutMs);
  }

  clearMetadata(paths);

  const healthy = await isHealthy({
    host,
    httpPort,
    fetchImpl,
  });

  return {
    changed: true,
    stopped: !healthy,
    pid: status.pid,
    endpoint: `http://${host}:${httpPort}`,
  };
}

async function getLocalQdrantStatus({
  paths = resolveLocalQdrantPaths(),
  host = "127.0.0.1",
  httpPort = 6333,
  fetchImpl = globalThis.fetch,
} = {}) {
  const pid = readPid(paths.pidPath);
  const processAlive = pid ? isProcessAlive(pid) : false;
  const healthy = await isHealthy({
    host,
    httpPort,
    fetchImpl,
  });
  const listenerPid = findListenerPid(httpPort);
  const meta = readJsonIfPresent(paths.metaPath);

  if (pid && !processAlive) {
    clearMetadata(paths);
  }

  return {
    pid,
    process_alive: processAlive,
    healthy,
    endpoint: `http://${host}:${httpPort}`,
    port_occupied: listenerPid !== null,
    listener_pid: listenerPid,
    managed: Boolean(pid),
    binary_present: fs.existsSync(paths.binaryPath),
    binary_path: paths.binaryPath,
    config_path: paths.configPath,
    log_path: paths.logPath,
    storage_path: paths.storageDir,
    snapshots_path: paths.snapshotsDir,
    temp_path: paths.tempDir,
    metadata: meta,
  };
}

function writeConfigFile({ paths, host, httpPort, grpcPort }) {
  const config = [
    "log_level: INFO",
    "storage:",
    `  storage_path: ${toYamlString(paths.storageDir)}`,
    `  snapshots_path: ${toYamlString(paths.snapshotsDir)}`,
    `  temp_path: ${toYamlString(paths.tempDir)}`,
    "service:",
    `  host: ${host}`,
    `  http_port: ${httpPort}`,
    `  grpc_port: ${grpcPort}`,
    "telemetry_disabled: true",
    "",
  ].join("\n");

  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.writeFileSync(paths.configPath, config, "utf8");
  return paths.configPath;
}

function ensureRuntimeDirectories(paths) {
  for (const dir of [
    paths.rootDir,
    paths.binDir,
    paths.configDir,
    paths.logsDir,
    paths.runDir,
    paths.storageDir,
    paths.snapshotsDir,
    paths.tempDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeMetadata(paths, metadata) {
  fs.writeFileSync(paths.pidPath, `${metadata.pid}\n`, "utf8");
  fs.writeFileSync(paths.metaPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

function clearMetadata(paths) {
  fs.rmSync(paths.pidPath, { force: true });
  fs.rmSync(paths.metaPath, { force: true });
}

function readPid(pidPath) {
  if (!fs.existsSync(pidPath)) {
    return null;
  }

  const value = fs.readFileSync(pidPath, "utf8").trim();
  const pid = Number.parseInt(value, 10);
  return Number.isInteger(pid) ? pid : null;
}

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isHealthy({ host, httpPort, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== "function") {
    return false;
  }

  try {
    const response = await fetchImpl(`http://${host}:${httpPort}/`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHealth({ host, httpPort, fetchImpl, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy({ host, httpPort, fetchImpl })) {
      return true;
    }
    await delay(POLL_INTERVAL_MS);
  }
  return false;
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await delay(POLL_INTERVAL_MS);
  }
  return false;
}

function findListenerPid(port) {
  const command = spawnSync("lsof", ["-tiTCP:" + String(port), "-sTCP:LISTEN", "-n", "-P"], {
    encoding: "utf8",
  });

  if (command.status !== 0) {
    return null;
  }

  const firstLine = command.stdout
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) {
    return null;
  }

  const pid = Number.parseInt(firstLine, 10);
  return Number.isInteger(pid) ? pid : null;
}

function toYamlString(value) {
  return JSON.stringify(String(value));
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

module.exports = {
  DEFAULT_QDRANT_VERSION,
  resolveLocalQdrantPaths,
  resolveReleaseAssetName,
  buildReleaseDownloadUrl,
  installLocalQdrantBinary,
  startLocalQdrant,
  stopLocalQdrant,
  getLocalQdrantStatus,
  writeConfigFile,
};
