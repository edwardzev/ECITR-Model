const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");

const { buildEvidenceCorrectionIndex } = require("../evidence/corrections");
const { createSha256 } = require("../evidence/file-payload-store");
const { assertLifecycleRecord } = require("../lifecycle/rules");
const { evaluateRetrievalEligibility } = require("../retrieval/eligibility");
const { RetrievalPlanner } = require("../retrieval/planner");
const { RECORD_DEFINITIONS } = require("../storage/file-backed-catalog");

const STRUCTURAL_HASH_ALGORITHM = "ecitr-structural-json-v1";
const READER_LIMITS = Object.freeze({
  selections: 5,
  response_bytes: 64 * 1024,
  source_bytes: 1024 * 1024,
  excerpt_lines: 80,
  excerpt_bytes: 8 * 1024,
  receipts: 20,
});
const LAYER_TYPES = Object.freeze({ evidence: "evidence", cases: "case", invariants: "invariant", tactics: "tactic" });
const ID_PATTERNS = Object.freeze({ evidence: /^ev_[A-Za-z0-9_-]+$/, cases: /^case_[A-Za-z0-9_-]+$/, invariants: /^inv_[A-Za-z0-9_-]+$/, tactics: /^tac_[A-Za-z0-9_-]+$/ });

function readerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function structuralHash(value) {
  function ordered(input) {
    if (Array.isArray(input)) return input.map(ordered);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.keys(input).sort().map((key) => [key, ordered(input[key])]));
    }
    return input;
  }
  return createSha256(Buffer.from(JSON.stringify(ordered(value)), "utf8"));
}

function recordVersion(layer, record) {
  const key = layer === "cases" ? "case_version" : "version";
  return Object.hasOwn(record, key) ? { version: record[key] } : {};
}

function buildRetrievalBasis(returnedRecordIds, catalogs) {
  if (!catalogs) return undefined;
  const records = {};
  for (const [layer, type] of Object.entries(LAYER_TYPES)) {
    const idKey = RECORD_DEFINITIONS[type].idKey;
    records[layer] = (returnedRecordIds[layer] ?? []).map((recordId) => {
      const matches = (catalogs[layer] ?? []).filter((record) => record[idKey] === recordId);
      if (matches.length !== 1) return { record_id: recordId, state: "unavailable" };
      return {
        record_id: recordId,
        structural_hash: structuralHash(matches[0]),
        ...recordVersion(layer, matches[0]),
      };
    });
  }
  return { algorithm: STRUCTURAL_HASH_ALGORITHM, records };
}

function assertBoundedString(value, maxBytes, code) {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw readerError(code);
  }
}

function validateSelection({ recordIds, evidenceExcerpt = null }) {
  if (!Array.isArray(recordIds) || recordIds.length < 1 || recordIds.length > READER_LIMITS.selections) {
    throw readerError("invalid_selection_count");
  }
  for (const recordId of recordIds) {
    assertBoundedString(recordId, 160, "invalid_record_id");
    if (!Object.values(ID_PATTERNS).some((pattern) => pattern.test(recordId))) throw readerError("invalid_record_id");
  }
  if (new Set(recordIds).size !== recordIds.length) throw readerError("duplicate_selection");
  if (evidenceExcerpt !== null) {
    if (!evidenceExcerpt || typeof evidenceExcerpt !== "object"
      || Object.keys(evidenceExcerpt).some((key) => !["recordId", "startLine", "endLine"].includes(key))
      || !recordIds.includes(evidenceExcerpt.recordId)
      || !ID_PATTERNS.evidence.test(evidenceExcerpt.recordId)) throw readerError("invalid_evidence_selection");
    const { startLine, endLine } = evidenceExcerpt;
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)
      || startLine < 1 || endLine < startLine) throw readerError("invalid_excerpt_span");
    if (endLine - startLine + 1 > READER_LIMITS.excerpt_lines) throw readerError("excerpt_line_budget_exceeded");
  }
}

function selectInvocationRecords(artifact, recordIds, plan) {
  const groups = artifact.returned_record_ids;
  if (!groups || typeof groups !== "object" || Array.isArray(groups)
    || Object.keys(groups).some((layer) => !Object.hasOwn(LAYER_TYPES, layer))) throw readerError("invalid_returned_record_ids");
  const byId = new Map();
  for (const [layer, ids] of Object.entries(groups)) {
    if (!Array.isArray(ids)) throw readerError("invalid_returned_record_ids");
    for (const id of ids) {
      if (typeof id !== "string" || !ID_PATTERNS[layer].test(id) || byId.has(id)) throw readerError("invalid_returned_record_ids");
      byId.set(id, layer);
    }
  }
  return recordIds.map((recordId) => {
    const layer = byId.get(recordId);
    if (!layer) throw readerError("record_not_returned");
    if (!plan.allowed_layers.includes(layer)) throw readerError("request_layer_mismatch");
    return { recordId, layer };
  });
}

function assertInside(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw readerError("unsafe_source_path");
  }
}

// Decode, hash and locate spans from this one bounded byte snapshot, never a second read.
function readSourceSnapshot(rootDir, relativeRef) {
  assertBoundedString(relativeRef, 1024, "input_metadata_budget_exceeded");
  if (path.isAbsolute(relativeRef) || relativeRef.includes("\\") || relativeRef.split("/").some((part) => !part || part === "." || part === "..")) {
    throw readerError("unsafe_source_path");
  }
  let descriptor;
  try {
    const root = fs.realpathSync(rootDir);
    const sourcePath = path.join(root, relativeRef);
    const realPath = fs.realpathSync(sourcePath);
    assertInside(root, realPath);
    const pathStat = fs.statSync(realPath);
    if (!pathStat.isFile()) throw readerError("source_not_regular_file");
    descriptor = fs.openSync(realPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(descriptor);
    if (fs.realpathSync(realPath) !== realPath || pathStat.ino !== stat.ino || pathStat.dev !== stat.dev) {
      throw readerError("source_changed_during_read");
    }
    if (!stat.isFile()) throw readerError("source_not_regular_file");
    if (stat.size > READER_LIMITS.source_bytes) throw readerError("input_budget_exceeded");
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fs.fstatSync(descriptor);
    if (length > READER_LIMITS.source_bytes) throw readerError("input_budget_exceeded");
    if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
      throw readerError("source_changed_during_read");
    }
    const bytes = buffer.subarray(0, length);
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw readerError("invalid_utf8"); }
    const lineEnds = [];
    for (let offset = 0; offset < bytes.length; offset += 1) if (bytes[offset] === 10) lineEnds.push(offset + 1);
    if (bytes.length && lineEnds.at(-1) !== bytes.length) lineEnds.push(bytes.length);
    return {
      bytes,
      text,
      lineEnds,
      source: {
        catalog_ref: relativeRef,
        sha256: createSha256(bytes),
        byte_start: 0,
        byte_end: bytes.length,
        start_line: lineEnds.length ? 1 : null,
        end_line: lineEnds.length || null,
        total_lines: lineEnds.length,
      },
    };
  } catch (error) {
    if (error.code === "ENOENT") throw readerError("source_missing");
    if (error.code && !/^[A-Z]/.test(error.code)) throw error;
    throw readerError("source_read_failed");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function parseRecord(snapshot) {
  try { return JSON.parse(snapshot.text); }
  catch { throw readerError("invalid_record_json"); }
}

function loadCorrectionIndex(catalog, snapshots) {
  const directory = path.join(catalog.rootDir, "evidence");
  if (!fs.existsSync(directory)) return buildEvidenceCorrectionIndex([]);
  assertInside(fs.realpathSync(catalog.rootDir), fs.realpathSync(directory));
  const records = [];
  const ids = new Set();
  for (const name of fs.readdirSync(directory).sort()) {
    if (!name.endsWith(".json")) continue;
    const ref = `evidence/${name}`;
    const snapshot = snapshots.get(ref) ?? readSourceSnapshot(catalog.rootDir, ref);
    const record = parseRecord(snapshot);
    catalog.validator.validateRecord("evidence", record);
    assertLifecycleRecord("evidence", record);
    if (`${record.evidence_id}.json` !== name || ids.has(record.evidence_id)) throw readerError("invalid_correction_graph");
    ids.add(record.evidence_id);
    records.push(record);
  }
  return buildEvidenceCorrectionIndex(records);
}

function getBasisState(artifact, layer, recordId, record) {
  if (!Object.hasOwn(artifact, "retrieval_basis")) return "legacy_unpinned";
  const basis = artifact.retrieval_basis;
  if (basis?.algorithm !== STRUCTURAL_HASH_ALGORITHM || !Array.isArray(basis.records?.[layer])) return "invalid";
  const entries = basis.records[layer].filter((entry) => entry.record_id === recordId);
  if (entries.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(entries[0].structural_hash ?? "")) return "invalid";
  return entries[0].structural_hash === structuralHash(record)
    && JSON.stringify(recordVersion(layer, record)) === JSON.stringify(Object.hasOwn(entries[0], "version") ? { version: entries[0].version } : {})
    ? "matched" : "stale";
}

function prepareRecord({ catalog, artifact, selection, evidenceExcerpt, snapshot, correctionIndex, graphError, now }) {
  const { layer, recordId } = selection;
  const result = { record_id: recordId, layer, result: "denied", reason: null, basis_state: "not_checked", content_kind: "none" };
  try {
    if (snapshot instanceof Error) throw snapshot;
    const record = parseRecord(snapshot);
    result.source = snapshot.source;
    result.structural_hash = structuralHash(record);
    result.hash_algorithm = STRUCTURAL_HASH_ALGORITHM;
    const definition = RECORD_DEFINITIONS[LAYER_TYPES[layer]];
    if (record?.[definition.idKey] !== recordId) {
      return { ...result, result: "stale", reason: "record_identity_changed", basis_state: "stale" };
    }
    try {
      catalog.validator.validateRecord(definition.schemaKey, record);
      assertLifecycleRecord(definition.schemaKey, record);
    } catch { throw readerError("invalid_record"); }
    Object.assign(result, recordVersion(layer, record));
    result.basis_state = getBasisState(artifact, layer, recordId, record);
    result.retrieval_time_match = result.basis_state === "matched" ? "verified"
      : result.basis_state === "stale" ? "mismatch" : "unknown";
    if (result.basis_state === "invalid") throw readerError("invalid_retrieval_basis");
    const scope = layer === "cases" ? record.context?.project_scope : record.project_scope;
    if (scope === "blocked") throw readerError("blocked_scope");
    const eligibility = evaluateRetrievalEligibility({ layer, record, request: artifact.request, now });
    if (!eligibility.eligible) throw readerError(eligibility.code);
    if (graphError) throw readerError(graphError);
    if (layer === "evidence" && correctionIndex.childByParent.has(recordId)) {
      return { ...result, result: "stale", reason: "evidence_corrected" };
    }
    if (result.basis_state === "stale") return { ...result, result: "stale", reason: "record_changed" };
    let excerpt;
    if (evidenceExcerpt?.recordId === recordId) {
      if (!record.verbatim_payload_ref.startsWith("payloads/evidence/")) throw readerError("unsafe_payload_ref");
      const payload = readSourceSnapshot(catalog.rootDir, record.verbatim_payload_ref);
      if (record.payload_hash !== payload.source.sha256) throw readerError("payload_hash_mismatch");
      const { startLine, endLine } = evidenceExcerpt;
      if (endLine > payload.lineEnds.length) throw readerError("excerpt_out_of_range");
      const start = startLine === 1 ? 0 : payload.lineEnds[startLine - 2];
      const end = payload.lineEnds[endLine - 1];
      if (end - start > READER_LIMITS.excerpt_bytes) throw readerError("excerpt_byte_budget_exceeded");
      const bytes = payload.bytes.subarray(start, end);
      result.payload_source = payload.source;
      result.excerpt_source = {
        ...payload.source,
        sha256: createSha256(bytes),
        byte_start: start,
        byte_end: end,
        start_line: startLine,
        end_line: endLine,
      };
      result.payload_hash_verified = true;
      excerpt = bytes.toString("utf8");
    }
    return {
      ...result,
      result: "available",
      reason: null,
      content_kind: layer === "evidence" ? (excerpt === undefined ? "evidence_metadata" : "evidence_excerpt") : "record",
      ...(layer === "evidence" ? { source_hash_verified: false } : {}),
      record,
      ...(excerpt === undefined ? {} : { excerpt }),
    };
  } catch (error) {
    return { ...result, result: error.code === "source_missing" ? "empty" : "denied", reason: error.code ?? "record_read_failed" };
  }
}

function withoutContent(result) {
  const { record, excerpt, ...metadata } = result;
  return metadata;
}

function prepareSelectedRecords({ catalog, artifact, recordIds, evidenceExcerpt = null, now = new Date() }) {
  validateSelection({ recordIds, evidenceExcerpt });
  const plan = new RetrievalPlanner({ validator: catalog.validator }).plan(artifact.request);
  const selections = selectInvocationRecords(artifact, recordIds, plan);
  const snapshots = new Map();
  for (const { layer, recordId } of selections) {
    const ref = `${RECORD_DEFINITIONS[LAYER_TYPES[layer]].directory}/${recordId}.json`;
    try { snapshots.set(ref, readSourceSnapshot(catalog.rootDir, ref)); }
    catch (error) { snapshots.set(ref, error); }
  }
  let correctionIndex;
  let graphError;
  try { correctionIndex = loadCorrectionIndex(catalog, snapshots); }
  catch (error) { graphError = error.code === "input_budget_exceeded" ? error.code : "invalid_correction_graph"; }
  const prepared = selections.map((selection) => prepareRecord({
    catalog, artifact, selection, evidenceExcerpt, now, correctionIndex, graphError,
    snapshot: snapshots.get(`${RECORD_DEFINITIONS[LAYER_TYPES[selection.layer]].directory}/${selection.recordId}.json`),
  }));
  const preparedAt = now.toISOString();
  const response = {
    ok: true,
    invocation_id: artifact.invocation_id,
    workspace_id: artifact.workspace_id,
    receipt: { receipt_id: `read_${"0".repeat(64)}`, prepared_at: preparedAt, reused: false, claim: "content_prepared_not_delivery_or_attention" },
    application_review: {
      status: "caller_review_required",
      guidance: "Compare current task facts with the record's inclusion and exclusion conditions. A matching exclusion rules out that specific application. Distinguish supported application from a broad analogy in the existing decision/output reference. A prepared record or reference does not verify application or benefit; report no influence when appropriate.",
    },
    results: prepared.map((result) => result.result === "available"
      ? { ...withoutContent(result), result: "denied", reason: "budget_exceeded", content_kind: "none" }
      : result),
    limits: READER_LIMITS,
  };
  const responseBytes = () => Buffer.byteLength(JSON.stringify(response), "utf8");
  if (responseBytes() > READER_LIMITS.response_bytes) throw readerError("input_metadata_budget_exceeded");
  // Reserve every result's metadata before considering bodies in literal caller order.
  for (let index = 0; index < prepared.length; index += 1) {
    const fallback = response.results[index];
    response.results[index] = prepared[index];
    if (responseBytes() > READER_LIMITS.response_bytes) response.results[index] = fallback;
  }
  const receiptData = {
    record_ids: [...recordIds],
    evidence_excerpt: evidenceExcerpt ? structuredClone(evidenceExcerpt) : null,
    results: response.results.map(withoutContent),
  };
  const receiptId = `read_${crypto.createHash("sha256").update(JSON.stringify({
    algorithm: STRUCTURAL_HASH_ALGORITHM, data: structuralHash(receiptData),
  })).digest("hex")}`;
  response.receipt.receipt_id = receiptId;
  return { response, receipt: { receipt_id: receiptId, prepared_at: preparedAt, ...receiptData } };
}

module.exports = {
  READER_LIMITS,
  STRUCTURAL_HASH_ALGORITHM,
  assertBoundedString,
  buildRetrievalBasis,
  prepareSelectedRecords,
  readerError,
  structuralHash,
  validateSelection,
};
