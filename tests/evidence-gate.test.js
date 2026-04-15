const test = require("node:test");
const assert = require("node:assert/strict");

const { EvidenceGate } = require("../src/evidence/evidence-gate");
const { InMemoryEvidenceAdapter } = require("../src/evidence/in-memory-adapter");
const { loadExample } = require("./helpers/load-example");

test("evidence gate validates before calling the adapter", async () => {
  const adapter = new InMemoryEvidenceAdapter();
  const gate = new EvidenceGate({ adapter });
  const evidence = loadExample("evidence");

  const result = await gate.writeRecord(evidence);
  const stored = await gate.getRecord(evidence.evidence_id);

  assert.equal(result.adapterId, "in-memory-evidence");
  assert.equal(stored.evidence_id, evidence.evidence_id);
});

test("invalid evidence record is rejected before adapter write", async () => {
  const adapter = new InMemoryEvidenceAdapter();
  const gate = new EvidenceGate({ adapter });
  const evidence = loadExample("evidence");
  delete evidence.payload_hash;

  await assert.rejects(() => gate.writeRecord(evidence));
  const health = await gate.healthcheck();
  assert.equal(health.storedRecords, 0);
});
