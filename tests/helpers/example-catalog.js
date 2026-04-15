const { loadExample } = require("./load-example");

function buildExampleCatalog() {
  return {
    tactics: [loadExample("tactic")],
    invariants: [loadExample("invariant")],
    cases: [loadExample("case")],
    evidence: [loadExample("evidence")],
    atomic_claim_sets: [loadExample("atomic_claim_set")],
    parameter_definitions: [loadExample("parameter_definition")],
    parameter_observations: [loadExample("parameter_observation")],
    review_audit_entries: [],
  };
}

module.exports = {
  buildExampleCatalog,
};
