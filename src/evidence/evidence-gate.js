const { assertLifecycleRecord } = require("../lifecycle/rules");
const { EcitrValidator } = require("../validation/validator");
const { assertEvidenceAdapter } = require("./adapter-interface");

class EvidenceGate {
  constructor({ adapter, validator = new EcitrValidator() }) {
    this.adapter = assertEvidenceAdapter(adapter);
    this.validator = validator;
  }

  async writeRecord(record) {
    this.validator.validateRecord("evidence", record);
    assertLifecycleRecord("evidence", record);

    return this.adapter.writeEvidence({ record });
  }

  async getRecord(evidenceId) {
    return this.adapter.getEvidence({ evidenceId });
  }

  async searchRecords({ query, projectScope, limit = 5 }) {
    return this.adapter.searchEvidence({ query, projectScope, limit });
  }

  async healthcheck() {
    return this.adapter.healthcheck();
  }
}

module.exports = {
  EvidenceGate,
};
