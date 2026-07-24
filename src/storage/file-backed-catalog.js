const fs = require("node:fs");
const path = require("node:path");

const { assertLifecycleRecord } = require("../lifecycle/rules");
const { EcitrValidator, readJson } = require("../validation/validator");

const RECORD_DEFINITIONS = Object.freeze({
  evidence: Object.freeze({
    directory: "evidence",
    schemaKey: "evidence",
    idKey: "evidence_id",
    runtimeKey: "evidence",
    lifecycle: true,
  }),
  case: Object.freeze({
    directory: "cases",
    schemaKey: "case",
    idKey: "case_id",
    runtimeKey: "cases",
    lifecycle: true,
  }),
  invariant: Object.freeze({
    directory: "invariants",
    schemaKey: "invariant",
    idKey: "id",
    runtimeKey: "invariants",
    lifecycle: true,
  }),
  tactic: Object.freeze({
    directory: "tactics",
    schemaKey: "tactic",
    idKey: "id",
    runtimeKey: "tactics",
    lifecycle: true,
  }),
  atomic_claim_set: Object.freeze({
    directory: "atomic-claim-sets",
    schemaKey: "atomic_claim_set",
    idKey: "claim_set_id",
    runtimeKey: "atomic_claim_sets",
    lifecycle: false,
  }),
  parameter_definition: Object.freeze({
    directory: "parameter-definitions",
    schemaKey: "parameter_definition",
    idKey: "definition_id",
    runtimeKey: "parameter_definitions",
    lifecycle: false,
  }),
  parameter_observation: Object.freeze({
    directory: "parameter-observations",
    schemaKey: "parameter_observation",
    idKey: "observation_id",
    runtimeKey: "parameter_observations",
    lifecycle: false,
  }),
  review_audit_entry: Object.freeze({
    directory: "review-audit-entries",
    schemaKey: "review_audit_entry",
    idKey: "audit_id",
    runtimeKey: "review_audit_entries",
    lifecycle: false,
  }),
});

class FileBackedCatalog {
  constructor({ rootDir, validator = new EcitrValidator() }) {
    if (!rootDir) {
      throw new Error("FileBackedCatalog requires a rootDir.");
    }

    this.rootDir = path.resolve(rootDir);
    this.validator = validator;
  }

  writeRecord(recordType, record, { overwrite = false } = {}) {
    const definition = getRecordDefinition(recordType);
    this.validator.validateRecord(definition.schemaKey, record);

    if (definition.lifecycle) {
      assertLifecycleRecord(definition.schemaKey, record);
    }

    const recordId = getRecordId(definition, record);
    const filePath = this.getRecordPath(recordType, recordId);

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath) && (recordType === "evidence" || !overwrite)) {
      const suffix = recordType === "evidence"
        ? "; evidence is immutable and corrections require a new evidence_id"
        : "";
      throw new Error(`Record already exists: ${recordType}:${recordId}${suffix}`);
    }

    fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    return {
      recordType,
      recordId,
      filePath,
      record: structuredClone(record),
    };
  }

  getRecord(recordType, recordId) {
    const filePath = this.getRecordPath(recordType, recordId);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    return readJson(filePath);
  }

  listRecords(recordType) {
    const definition = getRecordDefinition(recordType);
    const directory = path.join(this.rootDir, definition.directory);
    if (!fs.existsSync(directory)) {
      return [];
    }

    return fs
      .readdirSync(directory)
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .map((entry) => readJson(path.join(directory, entry)));
  }

  loadRuntimeCatalogs() {
    const catalogs = {};

    for (const [recordType, definition] of Object.entries(RECORD_DEFINITIONS)) {
      catalogs[definition.runtimeKey] = this.listRecords(recordType);
    }

    Object.defineProperty(catalogs, "__catalogRoot", {
      value: this.rootDir,
      enumerable: false,
      configurable: false,
      writable: false,
    });

    return catalogs;
  }

  countRecords(recordType) {
    return this.listRecords(recordType).length;
  }

  getRecordPath(recordType, recordId) {
    const definition = getRecordDefinition(recordType);
    return path.join(this.rootDir, definition.directory, `${recordId}.json`);
  }
}

function getRecordDefinition(recordType) {
  const definition = RECORD_DEFINITIONS[recordType];
  if (!definition) {
    throw new Error(`Unsupported record type for file-backed catalog: ${recordType}`);
  }

  return definition;
}

function getRecordId(definition, record) {
  const value = record[definition.idKey];
  if (!value) {
    throw new Error(`Record is missing required identifier field: ${definition.idKey}`);
  }

  return value;
}

module.exports = {
  FileBackedCatalog,
  RECORD_DEFINITIONS,
};
