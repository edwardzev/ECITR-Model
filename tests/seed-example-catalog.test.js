const test = require("node:test");
const assert = require("node:assert/strict");

const { seedExampleCatalog } = require("../src/storage/seed-example-catalog");

test("seedExampleCatalog writes a usable file-backed example catalog", () => {
  const { catalog } = seedExampleCatalog();
  const catalogs = catalog.loadRuntimeCatalogs();

  assert.equal(catalogs.evidence.length, 1);
  assert.equal(catalogs.review_audit_entries.length, 1);
  assert.equal(catalogs.atomic_claim_sets.length, 1);
});
