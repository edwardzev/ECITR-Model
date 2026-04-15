const fs = require("node:fs");
const path = require("node:path");

const { EcitrValidator, readJson } = require("../validation/validator");

class CaseBoundaryRecoveryPacketStore {
  constructor({ rootDir, validator = new EcitrValidator() }) {
    if (!rootDir) {
      throw new Error("CaseBoundaryRecoveryPacketStore requires a rootDir.");
    }

    this.rootDir = path.resolve(rootDir);
    this.validator = validator;
  }

  writePacket(packet, { overwrite = false } = {}) {
    this.validator.validateRecord("case_boundary_recovery_packet", packet);

    const filePath = this.getPacketPath(packet.recovery_id);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    if (fs.existsSync(filePath) && !overwrite) {
      throw new Error(`Case boundary recovery packet already exists: ${packet.recovery_id}`);
    }

    fs.writeFileSync(filePath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");

    return {
      recoveryId: packet.recovery_id,
      filePath,
      packet: structuredClone(packet),
    };
  }

  listPacketsForCase(caseId) {
    const directory = path.join(this.rootDir, "staging", "case-boundary-recovery-packets");
    if (!fs.existsSync(directory)) {
      return [];
    }

    return fs
      .readdirSync(directory)
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .map((entry) => readJson(path.join(directory, entry)))
      .filter((packet) => packet.case_id === caseId)
      .sort((left, right) => Date.parse(left.recovered_at ?? 0) - Date.parse(right.recovered_at ?? 0));
  }

  getPacketPath(recoveryId) {
    return path.join(this.rootDir, "staging", "case-boundary-recovery-packets", `${recoveryId}.json`);
  }
}

module.exports = {
  CaseBoundaryRecoveryPacketStore,
};
