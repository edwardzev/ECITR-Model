const fs = require("node:fs");
const path = require("node:path");

const { EcitrValidator, readJson } = require("../validation/validator");

class DiscoveryReconciliationPacketStore {
  constructor({ rootDir, validator = new EcitrValidator() }) {
    if (!rootDir) {
      throw new Error("DiscoveryReconciliationPacketStore requires a rootDir.");
    }

    this.rootDir = path.resolve(rootDir);
    this.validator = validator;
  }

  writePacket(packet, { overwrite = true } = {}) {
    this.validator.validateRecord("discovery_reconciliation_packet", packet);
    const filePath = this.getPacketPath(packet.target_layer, packet.source_record_type, packet.source_record_id);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath) && !overwrite) {
      throw new Error(`Discovery reconciliation packet already exists: ${packet.reconciliation_id}`);
    }
    fs.writeFileSync(filePath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
    return {
      reconciliationId: packet.reconciliation_id,
      filePath,
      packet: structuredClone(packet),
    };
  }

  getPacket(targetLayer, sourceRecordType, sourceRecordId) {
    const filePath = this.getPacketPath(targetLayer, sourceRecordType, sourceRecordId);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return readJson(filePath);
  }

  listPackets() {
    const directory = path.join(this.rootDir, "staging", "discovery-reconciliation-packets");
    if (!fs.existsSync(directory)) {
      return [];
    }

    return fs
      .readdirSync(directory)
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .map((entry) => readJson(path.join(directory, entry)));
  }

  getPacketPath(targetLayer, sourceRecordType, sourceRecordId) {
    return path.join(
      this.rootDir,
      "staging",
      "discovery-reconciliation-packets",
      `${targetLayer}__${sourceRecordType}__${sourceRecordId}.json`,
    );
  }
}

module.exports = {
  DiscoveryReconciliationPacketStore,
};
