const fs = require("node:fs");
const path = require("node:path");

const { EcitrValidator, readJson } = require("../validation/validator");

class CasePacketStore {
  constructor({ rootDir, validator = new EcitrValidator() }) {
    if (!rootDir) {
      throw new Error("CasePacketStore requires a rootDir.");
    }

    this.rootDir = path.resolve(rootDir);
    this.validator = validator;
  }

  writePacket(packet, { overwrite = false } = {}) {
    this.validator.validateRecord("case_compilation_packet", packet);

    const filePath = this.getPacketPath(packet.compilation_id);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    if (fs.existsSync(filePath) && !overwrite) {
      throw new Error(`Case compilation packet already exists: ${packet.compilation_id}`);
    }

    fs.writeFileSync(filePath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");

    return {
      compilationId: packet.compilation_id,
      filePath,
      packet: structuredClone(packet),
    };
  }

  getPacket(compilationId) {
    const filePath = this.getPacketPath(compilationId);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    return readJson(filePath);
  }

  getPacketPath(compilationId) {
    return path.join(this.rootDir, "staging", "case-compilation-packets", `${compilationId}.json`);
  }
}

module.exports = {
  CasePacketStore,
};
