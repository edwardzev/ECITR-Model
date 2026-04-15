const test = require("node:test");
const assert = require("node:assert/strict");

const { listRecordTypes } = require("../src/validation/schema-registry");
const { EcitrValidator, SchemaValidationError } = require("../src/validation/validator");
const { loadExample } = require("./helpers/load-example");

test("all example fixtures pass schema validation", () => {
  const validator = new EcitrValidator();

  for (const recordType of listRecordTypes()) {
    assert.doesNotThrow(() => validator.validateFixture(recordType));
  }
});

test("invalid evidence fixture is rejected", () => {
  const validator = new EcitrValidator();
  const evidence = loadExample("evidence");
  delete evidence.payload_hash;

  assert.throws(
    () => validator.validateRecord("evidence", evidence),
    SchemaValidationError,
  );
});

test("invalid tactic fixture is rejected when revalidation fields are missing", () => {
  const validator = new EcitrValidator();
  const tactic = loadExample("tactic");
  delete tactic.revalidate_at;
  delete tactic.expiry_at;

  assert.throws(
    () => validator.validateRecord("tactic", tactic),
    SchemaValidationError,
  );
});
