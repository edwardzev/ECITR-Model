const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { getRegistryEntry } = require("../validation/schema-registry");
const { readJson } = require("../validation/validator");
const { FileBackedCatalog } = require("./file-backed-catalog");

const EXAMPLE_RECORD_TYPES = Object.freeze([
  "evidence",
  "case",
  "invariant",
  "tactic",
  "atomic_claim_set",
  "review_audit_entry",
]);

function seedExampleCatalog({ rootDir, overwrite = true } = {}) {
  const targetRoot =
    rootDir ? path.resolve(rootDir) : fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-example-catalog-"));
  const catalog = new FileBackedCatalog({ rootDir: targetRoot });

  for (const recordType of EXAMPLE_RECORD_TYPES) {
    const fixturePath = getRegistryEntry(recordType).fixturePath;
    const record = readJson(fixturePath);
    catalog.writeRecord(recordType, record, { overwrite });
  }

  return {
    rootDir: targetRoot,
    catalog,
  };
}

module.exports = {
  seedExampleCatalog,
  EXAMPLE_RECORD_TYPES,
};
