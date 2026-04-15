const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DEFAULT_QDRANT_VERSION,
  resolveLocalQdrantPaths,
  resolveReleaseAssetName,
  buildReleaseDownloadUrl,
  writeConfigFile,
} = require("../src/qdrant/local-runtime");

test("local qdrant paths resolve under the repo local directory", () => {
  const repoRoot = path.join(os.tmpdir(), "ecitr-qdrant-paths");
  const paths = resolveLocalQdrantPaths({ repoRoot });

  assert.equal(paths.rootDir, path.join(repoRoot, ".local", "qdrant"));
  assert.equal(paths.binaryPath, path.join(repoRoot, ".local", "qdrant", "bin", "qdrant"));
  assert.equal(paths.pidPath, path.join(repoRoot, ".local", "qdrant", "run", "qdrant.pid"));
  assert.equal(paths.configPath, path.join(repoRoot, ".local", "qdrant", "config", "config.yaml"));
});

test("release asset mapping supports the current darwin arm64 target", () => {
  assert.equal(
    resolveReleaseAssetName({ platform: "darwin", arch: "arm64" }),
    "qdrant-aarch64-apple-darwin.tar.gz",
  );
  assert.equal(
    buildReleaseDownloadUrl({
      version: DEFAULT_QDRANT_VERSION,
      assetName: "qdrant-aarch64-apple-darwin.tar.gz",
    }),
    `https://github.com/qdrant/qdrant/releases/download/${DEFAULT_QDRANT_VERSION}/qdrant-aarch64-apple-darwin.tar.gz`,
  );
});

test("unsupported runtime targets are rejected explicitly", () => {
  assert.throws(
    () => resolveReleaseAssetName({ platform: "freebsd", arch: "arm64" }),
    /Unsupported platform/,
  );
});

test("local qdrant config writes explicit storage, snapshot, temp, and service bindings", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-qdrant-config-"));
  const paths = resolveLocalQdrantPaths({ repoRoot });
  fs.mkdirSync(paths.configDir, { recursive: true });

  writeConfigFile({
    paths,
    host: "127.0.0.1",
    httpPort: 7001,
    grpcPort: 7002,
  });

  const config = fs.readFileSync(paths.configPath, "utf8");
  assert.match(config, /storage_path:/);
  assert.match(config, /snapshots_path:/);
  assert.match(config, /temp_path:/);
  assert.match(config, /host: 127\.0\.0\.1/);
  assert.match(config, /http_port: 7001/);
  assert.match(config, /grpc_port: 7002/);
  assert.match(config, /telemetry_disabled: true/);
});
