const fs = require("node:fs");
const path = require("node:path");

const { EcitrValidator, readJson } = require("../validation/validator");

class InvariantHypothesisManifestStore {
  constructor({ rootDir, validator = new EcitrValidator() }) {
    if (!rootDir) {
      throw new Error("InvariantHypothesisManifestStore requires a rootDir.");
    }

    this.rootDir = path.resolve(rootDir);
    this.validator = validator;
  }

  writeManifest(manifest, { overwrite = false, outputPath } = {}) {
    this.validator.validateRecord("invariant_hypothesis_manifest", manifest);

    const filePath = outputPath
      ? path.resolve(outputPath)
      : this.getManifestPath(manifest.derivation_id);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    if (fs.existsSync(filePath) && !overwrite) {
      throw new Error(`Invariant hypothesis manifest already exists: ${filePath}`);
    }

    fs.writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    return {
      derivationId: manifest.derivation_id,
      filePath,
      manifest: structuredClone(manifest),
    };
  }

  getManifest(derivationId) {
    const filePath = this.getManifestPath(derivationId);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    return readJson(filePath);
  }

  listManifests() {
    const directory = this.getDirectory();
    if (!fs.existsSync(directory)) {
      return [];
    }

    return fs
      .readdirSync(directory)
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .map((entry) => readJson(path.join(directory, entry)));
  }

  getManifestPath(derivationId) {
    return path.join(this.getDirectory(), `${derivationId}.json`);
  }

  getDirectory() {
    return path.join(this.rootDir, "staging", "invariant-hypothesis-manifests");
  }
}

module.exports = {
  InvariantHypothesisManifestStore,
};
