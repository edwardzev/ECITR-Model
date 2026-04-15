const { EvidenceAdapter } = require("./adapter-interface");

class InMemoryEvidenceAdapter extends EvidenceAdapter {
  constructor() {
    super({
      adapterId: "in-memory-evidence",
      capabilities: ["writeEvidence", "getEvidence", "searchEvidence", "healthcheck"],
    });

    this.records = new Map();
  }

  async writeEvidence({ record }) {
    if (this.records.has(record.evidence_id)) {
      throw new Error(`Evidence already exists: ${record.evidence_id}`);
    }

    this.records.set(record.evidence_id, structuredClone(record));

    return {
      adapterId: this.adapterId,
      adapterRef: `memory://${record.evidence_id}`,
      record: structuredClone(record),
    };
  }

  async getEvidence({ evidenceId }) {
    const record = this.records.get(evidenceId);
    return record ? structuredClone(record) : null;
  }

  async searchEvidence({ query, projectScope, limit = 5 }) {
    const normalizedQuery = String(query).toLowerCase();
    const matches = [];

    for (const record of this.records.values()) {
      if (projectScope && record.project_scope !== projectScope) {
        continue;
      }

      const haystacks = [record.source_locator, record.verbatim_payload_ref].join(" ").toLowerCase();
      if (haystacks.includes(normalizedQuery)) {
        matches.push(structuredClone(record));
      }
    }

    return matches.slice(0, limit);
  }

  async healthcheck() {
    return {
      ok: true,
      adapterId: this.adapterId,
      storedRecords: this.records.size,
    };
  }
}

module.exports = {
  InMemoryEvidenceAdapter,
};
