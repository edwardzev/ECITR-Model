const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function resolvePayloadPath(record, { catalogRoot } = {}) {
  if (record.verbatim_payload_ref) {
    if (path.isAbsolute(record.verbatim_payload_ref)) {
      return record.verbatim_payload_ref;
    }

    if (catalogRoot) {
      return path.resolve(catalogRoot, record.verbatim_payload_ref);
    }
  }

  if (record.source_locator && path.isAbsolute(record.source_locator)) {
    return record.source_locator;
  }

  return null;
}

function loadEvidencePayloadWithText(record, { catalogRoot } = {}) {
  const payloadPath = resolvePayloadPath(record, { catalogRoot });
  if (!payloadPath || !fs.existsSync(payloadPath)) {
    return {
      payloadPath,
      rawText: null,
      payload: null,
    };
  }

  const rawText = fs.readFileSync(payloadPath, "utf8");
  let payload = null;
  try {
    payload = JSON.parse(rawText);
  } catch {
    payload = rawText;
  }

  return {
    payloadPath,
    rawText,
    payload,
  };
}

function hashText(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}

function normalizeParameterKey(value) {
  return String(value)
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function createDefinitionId({ workspaceId = null, observedKey }) {
  const seed = workspaceId ? `${workspaceId}:${observedKey}` : observedKey;
  return `paramdef_${hashText(seed).slice(0, 20)}`;
}

function createObservationId({
  workspaceId = null,
  parameterKey,
  observationKind,
  observedAt,
  sourceEvidenceRefs,
  sourceSpans,
  rawValueText,
}) {
  return `paramobs_${hashText(JSON.stringify({
    workspaceId,
    parameterKey,
    observationKind,
    observedAt,
    sourceEvidenceRefs,
    sourceSpans,
    rawValueText,
  })).slice(0, 20)}`;
}

function inferValueType(value) {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      return "unknown";
  }
}

function formatRawValueText(value) {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined) {
    return "";
  }

  return JSON.stringify(value);
}

function recordsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseScalarLiteral(rawValue) {
  const trimmed = String(rawValue).trim();
  if (!trimmed) {
    return "";
  }

  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  if (/^(true|false)$/i.test(trimmed)) {
    return trimmed.toLowerCase() === "true";
  }

  if (/^null$/i.test(trimmed)) {
    return null;
  }

  if (/^-?\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }

  if (/^-?\d+\.\d+$/.test(trimmed)) {
    return Number.parseFloat(trimmed);
  }

  if (
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
    || (trimmed.startsWith("{") && trimmed.endsWith("}"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }

  return trimmed;
}

function getSourceLocatorExtension(record) {
  const locator = String(record.source_locator ?? "").trim();
  if (!locator) {
    return "";
  }

  try {
    const asUrl = new URL(locator);
    return path.extname(asUrl.pathname).toLowerCase();
  } catch {
    return path.extname(locator).toLowerCase();
  }
}

function lineSpan({ path: spanPath, lineNumber, lineText, startChar = 0, endChar = null }) {
  const quote = String(lineText).trim() || String(lineText);
  const safeEndChar = endChar == null ? String(lineText).length : endChar;
  return {
    path: spanPath,
    start_line: lineNumber,
    end_line: lineNumber,
    start_char: startChar,
    end_char: safeEndChar,
    quote,
  };
}

module.exports = {
  createDefinitionId,
  createObservationId,
  formatRawValueText,
  getSourceLocatorExtension,
  hashText,
  inferValueType,
  lineSpan,
  loadEvidencePayloadWithText,
  normalizeParameterKey,
  parseScalarLiteral,
  recordsEqual,
  resolvePayloadPath,
};
