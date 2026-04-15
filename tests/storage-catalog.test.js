const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const { loadExample } = require("./helpers/load-example");

test("file-backed catalog persists and reloads runtime catalogs", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-catalog-"));
  const catalog = new FileBackedCatalog({ rootDir });

  catalog.writeRecord("evidence", loadExample("evidence"));
  catalog.writeRecord("case", loadExample("case"));
  catalog.writeRecord("invariant", loadExample("invariant"));
  catalog.writeRecord("tactic", loadExample("tactic"));
  catalog.writeRecord("atomic_claim_set", loadExample("atomic_claim_set"));
  catalog.writeRecord("parameter_definition", loadExample("parameter_definition"));
  catalog.writeRecord("parameter_observation", loadExample("parameter_observation"));
  catalog.writeRecord("review_audit_entry", loadExample("review_audit_entry"));

  const runtimeCatalogs = catalog.loadRuntimeCatalogs();

  assert.equal(runtimeCatalogs.evidence[0].evidence_id, "ev_mem_20260410_001");
  assert.equal(runtimeCatalogs.cases[0].case_id, "case_retrieval_scope_drift_001");
  assert.equal(runtimeCatalogs.atomic_claim_sets[0].claim_set_id, "claimset_scope_retrieval_evidence_001");
  assert.equal(runtimeCatalogs.parameter_definitions[0].definition_id, "paramdef_ecitr_qdrant_url");
  assert.equal(runtimeCatalogs.parameter_observations[0].observation_id, "paramobs_ecitr_qdrant_url_ev_mem_20260410_001");
  assert.equal(runtimeCatalogs.review_audit_entries[0].audit_id, "audit_review_case_scope_retrieval_001");
});

test("file-backed catalog blocks overwrite unless explicitly allowed", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-catalog-"));
  const catalog = new FileBackedCatalog({ rootDir });
  const record = loadExample("case");

  catalog.writeRecord("case", record);

  assert.throws(() => catalog.writeRecord("case", record));
  assert.doesNotThrow(() => catalog.writeRecord("case", record, { overwrite: true }));
});
