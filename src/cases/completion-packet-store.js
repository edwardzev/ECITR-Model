const fs = require("node:fs");
const path = require("node:path");

const { EcitrValidator, readJson } = require("../validation/validator");

class CaseCompletionPacketStore {
  constructor({ rootDir, validator = new EcitrValidator() }) {
    if (!rootDir) {
      throw new Error("CaseCompletionPacketStore requires a rootDir.");
    }

    this.rootDir = path.resolve(rootDir);
    this.validator = validator;
  }

  writePacket(packet, { overwrite = false } = {}) {
    this.validator.validateRecord("case_completion_packet", packet);

    const filePath = this.getPacketPath(packet.completion_id);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    if (fs.existsSync(filePath) && !overwrite) {
      throw new Error(`Case completion packet already exists: ${packet.completion_id}`);
    }

    fs.writeFileSync(filePath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");

    return {
      completionId: packet.completion_id,
      filePath,
      packet: structuredClone(packet),
    };
  }

  listPacketsForCase(caseId) {
    const directory = path.join(this.rootDir, "staging", "case-completion-packets");
    if (!fs.existsSync(directory)) {
      return [];
    }

    return fs
      .readdirSync(directory)
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .map((entry) => readJson(path.join(directory, entry)))
      .filter((packet) => packet.case_id === caseId)
      .sort((left, right) => Date.parse(left.prepared_at ?? 0) - Date.parse(right.prepared_at ?? 0));
  }

  getPacketPath(completionId) {
    return path.join(this.rootDir, "staging", "case-completion-packets", `${completionId}.json`);
  }
}

module.exports = {
  CaseCompletionPacketStore,
};
