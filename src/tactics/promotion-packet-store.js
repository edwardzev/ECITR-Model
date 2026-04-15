const fs = require("node:fs");
const path = require("node:path");

const { EcitrValidator, readJson } = require("../validation/validator");

class TacticPromotionPacketStore {
  constructor({ rootDir, validator = new EcitrValidator() }) {
    if (!rootDir) {
      throw new Error("TacticPromotionPacketStore requires a rootDir.");
    }

    this.rootDir = path.resolve(rootDir);
    this.validator = validator;
  }

  writePacket(packet, { overwrite = false } = {}) {
    this.validator.validateRecord("tactic_promotion_packet", packet);

    const filePath = this.getPacketPath(packet.promotion_id);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    if (fs.existsSync(filePath) && !overwrite) {
      throw new Error(`Tactic promotion packet already exists: ${packet.promotion_id}`);
    }

    fs.writeFileSync(filePath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");

    return {
      promotionId: packet.promotion_id,
      filePath,
      packet: structuredClone(packet),
    };
  }

  getPacket(promotionId) {
    const filePath = this.getPacketPath(promotionId);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    return readJson(filePath);
  }

  listPackets() {
    const directory = path.join(this.rootDir, "staging", "tactic-promotion-packets");
    if (!fs.existsSync(directory)) {
      return [];
    }

    return fs
      .readdirSync(directory)
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .map((entry) => readJson(path.join(directory, entry)));
  }

  getPacketPath(promotionId) {
    return path.join(this.rootDir, "staging", "tactic-promotion-packets", `${promotionId}.json`);
  }
}

module.exports = {
  TacticPromotionPacketStore,
};
