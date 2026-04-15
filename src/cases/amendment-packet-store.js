const fs = require("node:fs");
const path = require("node:path");

const { EcitrValidator, readJson } = require("../validation/validator");

class CaseAmendmentPacketStore {
  constructor({ rootDir, validator = new EcitrValidator() }) {
    if (!rootDir) {
      throw new Error("CaseAmendmentPacketStore requires a rootDir.");
    }

    this.rootDir = path.resolve(rootDir);
    this.validator = validator;
  }

  writePacket(packet, { overwrite = false } = {}) {
    this.validator.validateRecord("case_amendment_packet", packet);

    const filePath = this.getPacketPath(packet.amendment_id);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    if (fs.existsSync(filePath) && !overwrite) {
      throw new Error(`Case amendment packet already exists: ${packet.amendment_id}`);
    }

    fs.writeFileSync(filePath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");

    return {
      amendmentId: packet.amendment_id,
      filePath,
      packet: structuredClone(packet),
    };
  }

  listPacketsForCase(caseId) {
    const directory = path.join(this.rootDir, "staging", "case-amendment-packets");
    if (!fs.existsSync(directory)) {
      return [];
    }

    return fs
      .readdirSync(directory)
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .map((entry) => readJson(path.join(directory, entry)))
      .filter((packet) => packet.case_id === caseId)
      .sort((left, right) => Date.parse(left.amended_at ?? 0) - Date.parse(right.amended_at ?? 0));
  }

  getPacketPath(amendmentId) {
    return path.join(this.rootDir, "staging", "case-amendment-packets", `${amendmentId}.json`);
  }
}

module.exports = {
  CaseAmendmentPacketStore,
};
