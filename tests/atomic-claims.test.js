const test = require("node:test");
const assert = require("node:assert/strict");

const { AtomicClaimExtractor } = require("../src/cases/atomic-claims");
const { loadExample } = require("./helpers/load-example");

test("atomic claim extraction builds a claim set with source spans", () => {
  const extractor = new AtomicClaimExtractor();
  const packet = loadExample("atomic_claim_extraction_packet");

  const claimSet = extractor.compile(packet);

  assert.equal(claimSet.claim_set_id, "claimset_scope_retrieval_evidence_001");
  assert.equal(claimSet.evidence_id, "ev_mem_20260410_001");
  assert.equal(claimSet.claims[0].kind, "constraint");
  assert.equal(claimSet.claims[0].source_spans[0].start_line, 1);
});
