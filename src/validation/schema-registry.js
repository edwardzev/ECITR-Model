const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

const SCHEMA_REGISTRY = Object.freeze({
  evidence: {
    schemaPath: path.join(REPO_ROOT, "schemas", "evidence.schema.json"),
    fixturePath: path.join(REPO_ROOT, "fixtures", "examples", "evidence.record.example.json"),
  },
  case: {
    schemaPath: path.join(REPO_ROOT, "schemas", "case.schema.json"),
    fixturePath: path.join(REPO_ROOT, "fixtures", "examples", "case.record.example.json"),
  },
  case_compilation_packet: {
    schemaPath: path.join(REPO_ROOT, "schemas", "case_compilation_packet.schema.json"),
    fixturePath: path.join(
      REPO_ROOT,
      "fixtures",
      "compiler-inputs",
      "case-compilation.packet.example.json",
    ),
  },
  case_boundary_recovery_packet: {
    schemaPath: path.join(REPO_ROOT, "schemas", "case_boundary_recovery_packet.schema.json"),
    fixturePath: path.join(
      REPO_ROOT,
      "fixtures",
      "compiler-inputs",
      "case-boundary-recovery.packet.example.json",
    ),
  },
  case_amendment_packet: {
    schemaPath: path.join(REPO_ROOT, "schemas", "case_amendment_packet.schema.json"),
    fixturePath: path.join(
      REPO_ROOT,
      "fixtures",
      "compiler-inputs",
      "case-amendment.packet.example.json",
    ),
  },
  case_completion_packet: {
    schemaPath: path.join(REPO_ROOT, "schemas", "case_completion_packet.schema.json"),
    fixturePath: path.join(
      REPO_ROOT,
      "fixtures",
      "compiler-inputs",
      "case-completion.packet.example.json",
    ),
  },
  discovery_reconciliation_packet: {
    schemaPath: path.join(REPO_ROOT, "schemas", "discovery_reconciliation_packet.schema.json"),
    fixturePath: path.join(
      REPO_ROOT,
      "fixtures",
      "compiler-inputs",
      "discovery-reconciliation.packet.example.json",
    ),
  },
  atomic_claim_extraction_packet: {
    schemaPath: path.join(REPO_ROOT, "schemas", "atomic_claim_extraction_packet.schema.json"),
    fixturePath: path.join(
      REPO_ROOT,
      "fixtures",
      "compiler-inputs",
      "atomic-claim-extraction.packet.example.json",
    ),
  },
  atomic_claim_set: {
    schemaPath: path.join(REPO_ROOT, "schemas", "atomic_claim_set.schema.json"),
    fixturePath: path.join(
      REPO_ROOT,
      "fixtures",
      "examples",
      "atomic-claim-set.example.json",
    ),
  },
  parameter_definition: {
    schemaPath: path.join(REPO_ROOT, "schemas", "parameter_definition.schema.json"),
    fixturePath: path.join(
      REPO_ROOT,
      "fixtures",
      "examples",
      "parameter-definition.record.example.json",
    ),
  },
  parameter_observation: {
    schemaPath: path.join(REPO_ROOT, "schemas", "parameter_observation.schema.json"),
    fixturePath: path.join(
      REPO_ROOT,
      "fixtures",
      "examples",
      "parameter-observation.record.example.json",
    ),
  },
  invariant_promotion_packet: {
    schemaPath: path.join(REPO_ROOT, "schemas", "invariant_promotion_packet.schema.json"),
    fixturePath: path.join(
      REPO_ROOT,
      "fixtures",
      "compiler-inputs",
      "invariant-promotion.packet.example.json",
    ),
  },
  invariant_hypothesis_manifest: {
    schemaPath: path.join(REPO_ROOT, "schemas", "invariant_hypothesis_manifest.schema.json"),
    fixturePath: path.join(
      REPO_ROOT,
      "fixtures",
      "compiler-inputs",
      "invariant-hypothesis-manifest.example.json",
    ),
  },
  invariant: {
    schemaPath: path.join(REPO_ROOT, "schemas", "invariant.schema.json"),
    fixturePath: path.join(REPO_ROOT, "fixtures", "examples", "invariant.record.example.json"),
  },
  orchestrator_task_packet: {
    schemaPath: path.join(REPO_ROOT, "schemas", "orchestrator_task_packet.schema.json"),
    fixturePath: path.join(
      REPO_ROOT,
      "fixtures",
      "compiler-inputs",
      "orchestrator-task.packet.example.json",
    ),
  },
  tactic: {
    schemaPath: path.join(REPO_ROOT, "schemas", "tactic.schema.json"),
    fixturePath: path.join(REPO_ROOT, "fixtures", "examples", "tactic.record.example.json"),
  },
  tactic_promotion_packet: {
    schemaPath: path.join(REPO_ROOT, "schemas", "tactic_promotion_packet.schema.json"),
    fixturePath: path.join(
      REPO_ROOT,
      "fixtures",
      "compiler-inputs",
      "tactic-promotion.packet.example.json",
    ),
  },
  retrieval_request: {
    schemaPath: path.join(REPO_ROOT, "schemas", "retrieval_request.schema.json"),
    fixturePath: path.join(
      REPO_ROOT,
      "fixtures",
      "examples",
      "retrieval.request.example.json",
    ),
  },
  retrieval_response: {
    schemaPath: path.join(REPO_ROOT, "schemas", "retrieval_response.schema.json"),
    fixturePath: path.join(
      REPO_ROOT,
      "fixtures",
      "examples",
      "retrieval.response.example.json",
    ),
  },
  review_decision_packet: {
    schemaPath: path.join(REPO_ROOT, "schemas", "review_decision_packet.schema.json"),
    fixturePath: path.join(
      REPO_ROOT,
      "fixtures",
      "compiler-inputs",
      "review-decision.packet.example.json",
    ),
  },
  review_audit_entry: {
    schemaPath: path.join(REPO_ROOT, "schemas", "review_audit_entry.schema.json"),
    fixturePath: path.join(
      REPO_ROOT,
      "fixtures",
      "examples",
      "review-audit-entry.example.json",
    ),
  },
});

function getRegistryEntry(recordType) {
  const entry = SCHEMA_REGISTRY[recordType];
  if (!entry) {
    throw new Error(`Unknown record type: ${recordType}`);
  }

  return entry;
}

function listRecordTypes() {
  return Object.keys(SCHEMA_REGISTRY);
}

module.exports = {
  REPO_ROOT,
  SCHEMA_REGISTRY,
  getRegistryEntry,
  listRecordTypes,
};
