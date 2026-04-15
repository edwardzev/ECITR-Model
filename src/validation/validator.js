const fs = require("node:fs");

const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const { getRegistryEntry, listRecordTypes } = require("./schema-registry");

class SchemaValidationError extends Error {
  constructor(recordType, errors) {
    super(formatAjvErrors(recordType, errors));
    this.name = "SchemaValidationError";
    this.recordType = recordType;
    this.errors = errors;
  }
}

class EcitrValidator {
  constructor() {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);

    this.validators = new Map();

    for (const recordType of listRecordTypes()) {
      const schema = readJson(getRegistryEntry(recordType).schemaPath);
      this.validators.set(recordType, ajv.compile(schema));
    }
  }

  validateRecord(recordType, value) {
    const validate = this.validators.get(recordType);
    if (!validate) {
      throw new Error(`No validator registered for record type: ${recordType}`);
    }

    const valid = validate(value);
    if (!valid) {
      throw new SchemaValidationError(recordType, validate.errors ?? []);
    }

    return value;
  }

  validateFile(recordType, filePath) {
    return this.validateRecord(recordType, readJson(filePath));
  }

  validateFixture(recordType) {
    return this.validateFile(recordType, getRegistryEntry(recordType).fixturePath);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function formatAjvErrors(recordType, errors) {
  const lines = [`${recordType} failed schema validation:`];

  for (const error of errors) {
    const location = error.instancePath || "/";
    lines.push(`- ${location}: ${error.message || "validation error"}`);
  }

  return lines.join("\n");
}

module.exports = {
  EcitrValidator,
  SchemaValidationError,
  readJson,
};
