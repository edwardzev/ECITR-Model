const { loadExample } = require("./load-example");

function buildExampleCatalog() {
  return {
    tactics: [loadExample("tactic")],
    invariants: [loadExample("invariant")],
    cases: [loadExample("case")],
    evidence: [loadExample("evidence")],
    atomic_claim_sets: [loadExample("atomic_claim_set")],
  };
}

module.exports = {
  buildExampleCatalog,
};
