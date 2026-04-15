const fs = require("node:fs");
const path = require("node:path");

const { EvidenceAdapter } = require("../../evidence/adapter-interface");

const PINNED_COMMIT = "a036b4300d46fe6d399f8f89347f816462dd2c22";

class MemPalaceEvidenceAdapter extends EvidenceAdapter {
  constructor({ checkoutPath }) {
    super({
      adapterId: "mempalace-spike",
      capabilities: ["healthcheck"],
    });

    if (!checkoutPath) {
      throw new Error("MemPalaceEvidenceAdapter requires a checkoutPath.");
    }

    this.checkoutPath = path.resolve(checkoutPath);
  }

  async writeEvidence() {
    throw new Error("MemPalace write integration is not implemented in the Step 3 spike.");
  }

  async getEvidence() {
    throw new Error("MemPalace read integration is not implemented in the Step 3 spike.");
  }

  async searchEvidence() {
    throw new Error("MemPalace search integration is not implemented in the Step 3 spike.");
  }

  async healthcheck() {
    const requiredPaths = [
      path.join(this.checkoutPath, "pyproject.toml"),
      path.join(this.checkoutPath, "mempalace", "cli.py"),
      path.join(this.checkoutPath, "mempalace", "searcher.py"),
      path.join(this.checkoutPath, "mempalace", "palace.py"),
      path.join(this.checkoutPath, "mempalace", "config.py"),
    ];

    return {
      ok: requiredPaths.every((filePath) => fs.existsSync(filePath)),
      adapterId: this.adapterId,
      checkoutPath: this.checkoutPath,
      pinnedCommit: PINNED_COMMIT,
      inspectedEntrypoints: [
        "mempalace/cli.py",
        "mempalace/searcher.py",
        "mempalace/palace.py",
        "mempalace/config.py",
      ],
    };
  }
}

module.exports = {
  MemPalaceEvidenceAdapter,
  PINNED_COMMIT,
};
