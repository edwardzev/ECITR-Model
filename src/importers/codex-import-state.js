const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const STATE_DIRECTORY = path.join("state");
const STATE_FILE_NAME = "codex-rollouts.json";
const CURRENT_VERSION = 2;

class CodexImportState {
  constructor({ rootDir, state = null } = {}) {
    if (!rootDir) {
      throw new Error("CodexImportState requires a rootDir.");
    }

    this.rootDir = path.resolve(rootDir);
    this.filePath = path.join(this.rootDir, STATE_DIRECTORY, STATE_FILE_NAME);
    this.state = normalizeState(state);
    this.loadedBytes = null;
  }

  static load({ rootDir } = {}) {
    const instance = new CodexImportState({ rootDir });
    if (!fs.existsSync(instance.filePath)) {
      return instance;
    }

    let state;
    try {
      instance.loadedBytes = fs.readFileSync(instance.filePath);
      state = JSON.parse(instance.loadedBytes.toString("utf8"));
    } catch {
      throw new Error("Codex import state could not be read as JSON.");
    }
    instance.state = normalizeState(state);
    return instance;
  }

  getSourceFingerprint(sourcePath) {
    return this.state.sources[path.resolve(sourcePath)]?.fingerprint ?? null;
  }

  getSourceEntry(sourcePath) {
    return this.state.sources[path.resolve(sourcePath)] ?? null;
  }

  setSourceFingerprint(sourcePath, fingerprint, metadata = {}) {
    if (!fingerprint) {
      throw new Error("CodexImportState.setSourceFingerprint requires a fingerprint.");
    }

    this.state.sources[path.resolve(sourcePath)] = {
      ...metadata,
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
    const lockPath = `${this.filePath}.lock`;
    const tempPath = `${this.filePath}.tmp-${randomUUID()}`;
    let lockDescriptor;
    let tempDescriptor;
    try {
      lockDescriptor = fs.openSync(lockPath, "wx", 0o600);
      const currentBytes = fs.existsSync(this.filePath) ? fs.readFileSync(this.filePath) : null;
      if ((currentBytes === null) !== (this.loadedBytes === null)
        || (currentBytes && !currentBytes.equals(this.loadedBytes))) {
        throw new Error("Codex import state changed after it was loaded; refusing to overwrite it.");
      }
      const bytes = Buffer.from(`${JSON.stringify(this.state, null, 2)}\n`, "utf8");
      tempDescriptor = fs.openSync(tempPath, "wx", 0o600);
      fs.writeFileSync(tempDescriptor, bytes);
      fs.fsyncSync(tempDescriptor);
      fs.closeSync(tempDescriptor);
      tempDescriptor = undefined;
      fs.renameSync(tempPath, this.filePath);
      this.loadedBytes = bytes;
    } finally {
      if (tempDescriptor !== undefined) fs.closeSync(tempDescriptor);
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      if (lockDescriptor !== undefined) {
        fs.closeSync(lockDescriptor);
        fs.unlinkSync(lockPath);
      }
    }
  }
}

function normalizeState(state) {
  const normalized = {
    version: CURRENT_VERSION,
    sources: {},
  };

  if (state == null) {
    return normalized;
  }
  if (typeof state !== "object" || Array.isArray(state) || ![1, CURRENT_VERSION].includes(state.version)
    || !state.sources || typeof state.sources !== "object" || Array.isArray(state.sources)) {
    throw new Error("Codex import state has an unsupported version or invalid source ledger.");
  }
  Object.assign(normalized, state, { version: CURRENT_VERSION, sources: {} });
  if (state.sources) {
    for (const [sourcePath, entry] of Object.entries(state.sources)) {
      if (!path.isAbsolute(sourcePath) || path.resolve(sourcePath) !== sourcePath || !entry || typeof entry !== "object"
        || Array.isArray(entry) || typeof entry.fingerprint !== "string" || entry.fingerprint.length === 0) {
        throw new Error("Codex import state contains an invalid source entry.");
      }

      normalized.sources[path.resolve(sourcePath)] = {
        ...entry,
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
