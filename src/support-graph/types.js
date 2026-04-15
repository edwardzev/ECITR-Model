const crypto = require("node:crypto");

const SNAPSHOT_SCHEMA_VERSION = "support-graph-snapshot.v1";
const DIFF_SCHEMA_VERSION = "support-graph-diff.v1";

const NODE_TYPES = Object.freeze([
  "evidence",
  "case",
  "invariant",
  "tactic",
  "atomic_claim_set",
  "parameter_definition",
  "parameter_observation",
  "source_artifact",
]);

const CANONICAL_NODE_TYPES = new Set([
  "evidence",
  "case",
  "invariant",
  "tactic",
]);

const CONFIDENCE_LABELS = Object.freeze([
  "DECLARED",
  "EXTRACTED",
  "INFERRED",
  "AMBIGUOUS",
]);

function toNodeId(nodeType, recordId) {
  return `${nodeType}:${recordId}`;
}

function createSourceArtifactRecordId(locator) {
  return `srcart_${hashText(locator).slice(0, 16)}`;
}

function createEdgeId({ kind, from, to }) {
  return `edge_${hashText(`${kind}:${from}:${to}`).slice(0, 20)}`;
}

function createFingerprint(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function createBuildId({ builtAt, fingerprint }) {
  return `sg_${sanitizeTimestamp(builtAt)}_${String(fingerprint).replace(/^sha256:/, "").slice(0, 12)}`;
}

function createDiffId({ previousBuildId, nextBuildId }) {
  return `sgdiff_${hashText(`${previousBuildId}:${nextBuildId}`).slice(0, 20)}`;
}

function sanitizeTimestamp(value) {
  return String(value).replace(/[^0-9A-Za-z]+/g, "");
}

function hashText(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}

function isCanonicalNodeType(nodeType) {
  return CANONICAL_NODE_TYPES.has(nodeType);
}

function confidenceRank(label) {
  switch (label) {
    case "DECLARED":
      return 4;
    case "EXTRACTED":
      return 3;
    case "INFERRED":
      return 2;
    case "AMBIGUOUS":
      return 1;
    default:
      return 0;
  }
}

function mergeProjectScopes(...scopes) {
  const normalized = scopes
    .filter((value) => value != null && value !== "")
    .map((value) => String(value));

  if (normalized.length === 0) {
    return "global";
  }

  if (normalized.includes("blocked")) {
    return "blocked";
  }

  const withoutGlobal = [...new Set(normalized.filter((value) => value !== "global"))];
  if (withoutGlobal.length === 0) {
    return "global";
  }

  return withoutGlobal.length === 1 ? withoutGlobal[0] : "blocked";
}

function sortSupportRefs(supportRefs = []) {
  return [...supportRefs]
    .map((entry) => ({
      record_type: entry.record_type,
      record_id: entry.record_id,
    }))
    .sort((left, right) =>
      left.record_type.localeCompare(right.record_type)
      || left.record_id.localeCompare(right.record_id));
}

function dedupeSupportRefs(supportRefs = []) {
  return [...new Map(sortSupportRefs(supportRefs).map((entry) => [
    `${entry.record_type}:${entry.record_id}`,
    entry,
  ])).values()];
}

function dedupeSourceSpans(sourceSpans = []) {
  return [...new Map((sourceSpans ?? []).map((span) => [
    JSON.stringify(span),
    span,
  ])).values()];
}

module.exports = {
  CANONICAL_NODE_TYPES,
  CONFIDENCE_LABELS,
  DIFF_SCHEMA_VERSION,
  NODE_TYPES,
  SNAPSHOT_SCHEMA_VERSION,
  confidenceRank,
  createBuildId,
  createDiffId,
  createEdgeId,
  createFingerprint,
  createSourceArtifactRecordId,
  dedupeSourceSpans,
  dedupeSupportRefs,
  isCanonicalNodeType,
  mergeProjectScopes,
  sanitizeTimestamp,
  sortSupportRefs,
  toNodeId,
};
