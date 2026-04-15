const { getRegistryEntry } = require("../../src/validation/schema-registry");
const { readJson } = require("../../src/validation/validator");

function loadExample(recordType) {
  return readJson(getRegistryEntry(recordType).fixturePath);
}

module.exports = {
  loadExample,
};
