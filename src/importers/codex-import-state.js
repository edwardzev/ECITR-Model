const fs = require("node:fs");
const path = require("node:path");

const STATE_DIRECTORY = path.join("state");
const STATE_FILE_NAME = "codex-rollouts.json";
const CURRENT_VERSION = 1;

class CodexImportState {
  constructor({ rootDir, state = null } = {}) {
    if (!rootDir) {
      throw new Error("CodexImportState requires a rootDir.");
    }

    this.rootDir = path.resolve(rootDir);
    this.filePath = path.join(this.rootDir, STATE_DIRECTORY, STATE_FILE_NAME);
    this.state = normalizeState(state);
  }

  static load({ rootDir } = {}) {
    const instance = new CodexImportState({ rootDir });
    if (!fs.existsSync(instance.filePath)) {
      return instance;
    }

    instance.state = normalizeState(JSON.parse(fs.readFileSync(instance.filePath, "utf8")));
    return instance;
  }

  getSourceFingerprint(sourcePath) {
    return this.state.sources[path.resolve(sourcePath)]?.fingerprint ?? null;
  }

  setSourceFingerprint(sourcePath, fingerprint) {
    if (!fingerprint) {
      throw new Error("CodexImportState.setSourceFingerprint requires a fingerprint.");
    }

    this.state.sources[path.resolve(sourcePath)] = {
      fingerprint,
    };
  }

  pruneSources(sourcePaths) {
    const keep = new Set(sourcePaths.map((entry) => path.resolve(entry)));
    for (const sourcePath of Object.keys(this.state.sources)) {
      if (!keep.has(sourcePath)) {
        delete this.state.sources[sourcePath];
      }
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
  }
}

function normalizeState(state) {
  const normalized = {
    version: CURRENT_VERSION,
    sources: {},
  };

  if (!state || typeof state !== "object") {
    return normalized;
  }

  if (state.sources && typeof state.sources === "object") {
    for (const [sourcePath, entry] of Object.entries(state.sources)) {
      if (!entry || typeof entry !== "object" || typeof entry.fingerprint !== "string" || entry.fingerprint.length === 0) {
        continue;
      }

      normalized.sources[path.resolve(sourcePath)] = {
        fingerprint: entry.fingerprint,
      };
    }
  }

  return normalized;
}

module.exports = {
  CodexImportState,
  CURRENT_VERSION,
  STATE_DIRECTORY,
  STATE_FILE_NAME,
};
