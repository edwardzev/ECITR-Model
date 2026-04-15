class EvidenceAdapter {
  constructor({ adapterId, capabilities }) {
    if (!adapterId) {
      throw new Error("EvidenceAdapter requires an adapterId.");
    }

    this.adapterId = adapterId;
    this.capabilities = Object.freeze([...(capabilities ?? [])]);
  }

  async writeEvidence() {
    throw new Error("writeEvidence must be implemented by the adapter.");
  }

  async getEvidence() {
    throw new Error("getEvidence must be implemented by the adapter.");
  }

  async searchEvidence() {
    throw new Error("searchEvidence must be implemented by the adapter.");
  }

  async healthcheck() {
    throw new Error("healthcheck must be implemented by the adapter.");
  }
}

function assertEvidenceAdapter(adapter) {
  if (!adapter) {
    throw new Error("An evidence adapter instance is required.");
  }

  for (const methodName of ["writeEvidence", "getEvidence", "searchEvidence", "healthcheck"]) {
    if (typeof adapter[methodName] !== "function") {
      throw new Error(`Evidence adapter is missing method: ${methodName}`);
    }
  }

  return adapter;
}

module.exports = {
  EvidenceAdapter,
  assertEvidenceAdapter,
};
