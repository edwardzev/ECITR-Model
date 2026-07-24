const fs = require("node:fs");
const path = require("node:path");

const { EcitrValidator, readJson } = require("../validation/validator");

class TacticRevalidationPacketStore {
  constructor({ rootDir, validator = new EcitrValidator() }) {
    if (!rootDir) {
      throw new Error("TacticRevalidationPacketStore requires a rootDir.");
    }

    this.rootDir = path.resolve(rootDir);
    this.validator = validator;
  }

  writePacket(packet) {
    this.validator.validateRecord("tactic_revalidation_packet", packet);

    const filePath = this.getPacketPath(packet.revalidation_id);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath)) {
      throw new Error(`Tactic revalidation packet already exists: ${packet.revalidation_id}`);
    }

    fs.writeFileSync(filePath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
    return {
      revalidationId: packet.revalidation_id,
      filePath,
      packet: structuredClone(packet),
    };
  }

  removeUncommittedPacket(revalidationId) {
    const filePath = this.getPacketPath(revalidationId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  listPacketsForTactic(tacticId) {
    const directory = this.getDirectory();
    if (!fs.existsSync(directory)) {
      return [];
    }

    return fs
      .readdirSync(directory)
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .map((entry) => readJson(path.join(directory, entry)))
      .filter((packet) => packet.tactic_id === tacticId)
      .sort((left, right) => Date.parse(left.reviewed_at) - Date.parse(right.reviewed_at));
  }

  getPacketPath(revalidationId) {
    return path.join(this.getDirectory(), `${revalidationId}.json`);
  }

  getDirectory() {
    return path.join(this.rootDir, "review", "tactic-revalidations");
  }
}

module.exports = {
  TacticRevalidationPacketStore,
};
