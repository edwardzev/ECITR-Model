const fs = require("node:fs");
const path = require("node:path");

const { buildParameterSummaryForRecord } = require("../parameters/retrieval");

const MAX_SEGMENTS = 128;
const MAX_TEXT_LENGTH = 16000;
const payloadCache = new Map();

function buildEvidenceRetrievalText(record, { catalogRoot, atomicClaims = [], parameterIndexes = null } = {}) {
  const segments = [
    `Evidence id: ${record.evidence_id}.`,
    `Source locator: ${record.source_locator}.`,
    `Source type: ${record.source_type}.`,
    `Project scope: ${record.project_scope}.`,
    `Actor scope: ${record.actor_scope}.`,
  ];

  if (record.substrate_ref) {
    segments.push(`Substrate ref: ${record.substrate_ref}.`);
  }

  if (record.verbatim_payload_ref) {
    segments.push(`Payload ref: ${record.verbatim_payload_ref}.`);
  }

  if (record.parent_evidence_id) {
    segments.push(`Parent evidence id: ${record.parent_evidence_id}.`);
  }

  const payload = loadEvidencePayload(record, { catalogRoot });
  if (payload) {
    segments.push(...flattenPayloadValue(payload));
  }

  if (Array.isArray(atomicClaims) && atomicClaims.length > 0) {
    segments.push(`Claims: ${atomicClaims.join(" ")}.`);
  }

  const parameterSummary = buildParameterSummaryForRecord("evidence", record, parameterIndexes);
  if (parameterSummary) {
    segments.push(parameterSummary);
  }

  return compactSegments(segments);
}

function loadEvidencePayload(record, { catalogRoot } = {}) {
  const payloadPath = resolvePayloadPath(record, { catalogRoot });
  if (!payloadPath) {
    return null;
  }

  if (payloadCache.has(payloadPath)) {
    return payloadCache.get(payloadPath);
  }

  let payload = null;
  try {
    const raw = fs.readFileSync(payloadPath, "utf8");
    payload = JSON.parse(raw);
  } catch {
    payload = null;
  }

  payloadCache.set(payloadPath, payload);
  return payload;
}

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

function flattenPayloadValue(value, pathSegments = [], segments = []) {
  if (segments.length >= MAX_SEGMENTS) {
    return segments;
  }

  if (value == null) {
    return segments;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (pathSegments.length > 0) {
      segments.push(`${formatPath(pathSegments)}: ${String(value)}.`);
    }
    return segments;
  }

  if (Array.isArray(value)) {
    if (value.every(isScalar)) {
      if (pathSegments.length > 0) {
        segments.push(`${formatPath(pathSegments)}: ${value.map((entry) => String(entry)).join(" ")}.`);
      }
      return segments;
    }

    value.forEach((entry, index) => {
      if (segments.length < MAX_SEGMENTS) {
        flattenPayloadValue(entry, [...pathSegments, String(index)], segments);
      }
    });
    return segments;
  }

  if (typeof value === "object") {
    for (const [key, nestedValue] of Object.entries(value)) {
      if (segments.length >= MAX_SEGMENTS) {
        break;
      }
      flattenPayloadValue(nestedValue, [...pathSegments, key], segments);
    }
  }

  return segments;
}

function formatPath(pathSegments) {
  return pathSegments.join(".");
}

function compactSegments(segments) {
  const compacted = [];
  let totalLength = 0;

  for (const segment of segments) {
    const normalized = String(segment).trim();
    if (!normalized) {
      continue;
    }

    if (totalLength + normalized.length > MAX_TEXT_LENGTH) {
      break;
    }

    compacted.push(normalized);
    totalLength += normalized.length + 1;
  }

  return compacted.join(" ");
}

function isScalar(value) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

module.exports = {
  buildEvidenceRetrievalText,
};
