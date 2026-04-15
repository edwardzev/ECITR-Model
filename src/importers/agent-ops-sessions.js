const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { FilePayloadStore, createSha256 } = require("../evidence/file-payload-store");
const { assertLifecycleRecord } = require("../lifecycle/rules");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { EcitrValidator } = require("../validation/validator");
const { buildEvidenceId: buildRunEvidenceId } = require("./agent-ops-runs");

const SESSIONS_RELATIVE_ROOT = path.join("memory", "sessions");
const PAYLOAD_NAMESPACE_SEGMENTS = Object.freeze(["agent-ops", "sessions"]);
const TERMINAL_SESSION_STATUSES = new Set(["closed", "abandoned"]);
const MAX_SAMPLE_RESULTS = 10;
const MAX_DETAIL_RESULTS = 20;

function importAgentOpsSessions({
  agentOpsRoot,
  catalogRoot,
  projectId = null,
  dryRun = true,
  limit = Number.POSITIVE_INFINITY,
  validator = new EcitrValidator(),
} = {}) {
  if (!agentOpsRoot) {
    throw new Error("importAgentOpsSessions requires an agentOpsRoot.");
  }

  if (!catalogRoot) {
    throw new Error("importAgentOpsSessions requires a catalogRoot.");
  }

  assertImportLimit(limit);

  const resolvedAgentOpsRoot = path.resolve(agentOpsRoot);
  const resolvedCatalogRoot = path.resolve(catalogRoot);
  const sessionsRoot = path.join(resolvedAgentOpsRoot, SESSIONS_RELATIVE_ROOT);

  if (!fs.existsSync(sessionsRoot) || !fs.statSync(sessionsRoot).isDirectory()) {
    throw new Error(`agent-ops sessions root does not exist: ${sessionsRoot}`);
  }

  const catalog = new FileBackedCatalog({
    rootDir: resolvedCatalogRoot,
    validator,
  });
  const payloadStore = new FilePayloadStore({ rootDir: resolvedCatalogRoot });
  const sessionFilePaths = listSessionFiles(sessionsRoot);
  const seenEvidenceIds = new Map();
  const summary = {
    dry_run: dryRun,
    agent_ops_root: resolvedAgentOpsRoot,
    catalog_root: resolvedCatalogRoot,
    sessions_root: sessionsRoot,
    project_filter: projectId,
    scanned_files: sessionFilePaths.length,
    candidate_sessions: 0,
    eligible_sessions: 0,
    planned: 0,
    imported: 0,
    skipped_existing: 0,
    skipped_non_terminal: 0,
    conflicts: 0,
    errors: 0,
    project_counts: {},
    sample_results: [],
    conflict_details: [],
    error_details: [],
  };

  for (const sessionFilePath of sessionFilePaths) {
    if (summary.candidate_sessions >= limit) {
      break;
    }

    try {
      const sourceBytes = fs.readFileSync(sessionFilePath);
      const sessionRecord = JSON.parse(sourceBytes.toString("utf8"));
      assertAgentOpsSessionRecord(sessionRecord, sessionFilePath);

      if (projectId && sessionRecord.project_id !== projectId) {
        continue;
      }

      const evidenceId = buildSessionEvidenceId(sessionRecord.id);
      const firstSeenPath = seenEvidenceIds.get(evidenceId);
      if (firstSeenPath) {
        summary.candidate_sessions += 1;
        summary.conflicts += 1;
        pushCapped(summary.conflict_details, {
          evidence_id: evidenceId,
          source_locator: path.resolve(sessionFilePath),
          conflict_fields: ["evidence_id"],
          first_seen_source_locator: firstSeenPath,
        });
        pushCapped(summary.sample_results, {
          status: "conflict",
          evidence_id: evidenceId,
          source_locator: path.resolve(sessionFilePath),
          verbatim_payload_ref: null,
        }, MAX_SAMPLE_RESULTS);
        continue;
      }

      seenEvidenceIds.set(evidenceId, path.resolve(sessionFilePath));
      summary.candidate_sessions += 1;
      summary.project_counts[sessionRecord.project_id] =
        (summary.project_counts[sessionRecord.project_id] ?? 0) + 1;

      if (!TERMINAL_SESSION_STATUSES.has(sessionRecord.status)) {
        summary.skipped_non_terminal += 1;
        pushCapped(summary.sample_results, {
          status: "skipped_non_terminal",
          evidence_id: evidenceId,
          source_locator: path.resolve(sessionFilePath),
          verbatim_payload_ref: null,
        }, MAX_SAMPLE_RESULTS);
        continue;
      }

      summary.eligible_sessions += 1;
      const outcome = importSingleSession({
        evidenceId,
        sessionFilePath,
        sessionRecord,
        sourceBytes,
        catalog,
        payloadStore,
        dryRun,
        validator,
      });

      if (outcome.status === "planned") {
        summary.planned += 1;
      } else if (outcome.status === "imported") {
        summary.imported += 1;
      } else if (outcome.status === "skipped_existing") {
        summary.skipped_existing += 1;
      } else if (outcome.status === "conflict") {
        summary.conflicts += 1;
        pushCapped(summary.conflict_details, {
          evidence_id: outcome.record.evidence_id,
          source_locator: outcome.record.source_locator,
          conflict_fields: outcome.mismatches,
        });
      }

      pushCapped(summary.sample_results, toSampleResult(outcome), MAX_SAMPLE_RESULTS);
    } catch (error) {
      summary.errors += 1;
      pushCapped(summary.error_details, {
        source_locator: path.resolve(sessionFilePath),
        message: error.message,
      });
    }
  }

  return summary;
}

function importSingleSession({
  evidenceId,
  sessionFilePath,
  sessionRecord,
  sourceBytes,
  catalog,
  payloadStore,
  dryRun,
  validator,
}) {
  const payloadPlan = payloadStore.planPayload({
    evidenceId,
    capturedAt: getCapturedAt(sessionRecord),
    extension: path.extname(sessionFilePath) || ".json",
    namespaceSegments: PAYLOAD_NAMESPACE_SEGMENTS,
    bytes: sourceBytes,
  });
  const parentEvidenceId = resolveParentEvidenceId(sessionRecord, catalog);
  const record = buildEvidenceRecordFromSession({
    sessionRecord,
    sourcePath: sessionFilePath,
    payloadRef: payloadPlan.relativeRef,
    payloadHash: payloadPlan.payloadHash,
    sourceHash: createSha256(sourceBytes),
    parentEvidenceId,
  });

  validator.validateRecord("evidence", record);
  assertLifecycleRecord("evidence", record);

  const existing = catalog.getRecord("evidence", evidenceId);
  if (existing) {
    const mismatches = diffEvidenceRecords(existing, record);
    if (mismatches.length === 0) {
      return {
        status: "skipped_existing",
        record,
      };
    }

    return {
      status: "conflict",
      record,
      mismatches,
    };
  }

  if (dryRun) {
    return {
      status: "planned",
      record,
    };
  }

  payloadStore.writePayload({
    evidenceId,
    capturedAt: getCapturedAt(sessionRecord),
    extension: path.extname(sessionFilePath) || ".json",
    namespaceSegments: PAYLOAD_NAMESPACE_SEGMENTS,
    bytes: sourceBytes,
  });
  const persisted = catalog.writeRecord("evidence", record);

  return {
    status: "imported",
    record,
    record_file: persisted.filePath,
  };
}

function buildEvidenceRecordFromSession({
  sessionRecord,
  sourcePath,
  payloadRef,
  payloadHash,
  sourceHash,
  parentEvidenceId,
}) {
  const record = {
    evidence_id: buildSessionEvidenceId(sessionRecord.id),
    substrate_ref: pathToFileURL(path.resolve(sourcePath)).href,
    source_type: "file",
    source_locator: path.resolve(sourcePath),
    captured_at: getCapturedAt(sessionRecord),
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: payloadRef,
    payload_hash: payloadHash,
    source_hash: sourceHash,
    redaction_state: "none",
    immutable: true,
  };

  if (parentEvidenceId) {
    record.parent_evidence_id = parentEvidenceId;
  }

  return record;
}

function buildSessionEvidenceId(sessionId) {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new Error(`Session id cannot be mapped safely into an evidence id: ${sessionId}`);
  }

  return `ev_aops_session_${sessionId}`;
}

function resolveParentEvidenceId(sessionRecord, catalog) {
  if (!sessionRecord.run_ref) {
    return null;
  }

  const runId = path.basename(sessionRecord.run_ref, ".json");
  const parentEvidenceId = buildRunEvidenceId(runId);
  const parentRecord = catalog.getRecord("evidence", parentEvidenceId);
  if (!parentRecord) {
    throw new Error(
      `Linked run evidence is missing for session ${sessionRecord.id}: ${parentEvidenceId}`,
    );
  }

  return parentEvidenceId;
}

function getCapturedAt(sessionRecord) {
  return sessionRecord.closed_at || sessionRecord.started_at;
}

function assertAgentOpsSessionRecord(sessionRecord, sessionFilePath) {
  if (!sessionRecord || typeof sessionRecord !== "object" || Array.isArray(sessionRecord)) {
    throw new Error(`Session file must contain a JSON object: ${sessionFilePath}`);
  }

  for (const key of ["id", "project_id", "status", "started_at"]) {
    if (!sessionRecord[key] || typeof sessionRecord[key] !== "string") {
      throw new Error(`Session file is missing required string field ${key}: ${sessionFilePath}`);
    }
  }

  if (Number.isNaN(new Date(sessionRecord.started_at).getTime())) {
    throw new Error(`Session file has invalid started_at: ${sessionFilePath}`);
  }

  if (TERMINAL_SESSION_STATUSES.has(sessionRecord.status)) {
    if (!sessionRecord.closed_at || Number.isNaN(new Date(sessionRecord.closed_at).getTime())) {
      throw new Error(`Terminal session is missing valid closed_at: ${sessionFilePath}`);
    }
  }
}

function diffEvidenceRecords(existingRecord, nextRecord) {
  const keys = [
    "evidence_id",
    "substrate_ref",
    "source_type",
    "source_locator",
    "captured_at",
    "project_scope",
    "actor_scope",
    "verbatim_payload_ref",
    "payload_hash",
    "source_hash",
    "parent_evidence_id",
    "correction_of",
    "redaction_state",
    "immutable",
  ];

  return keys.filter(
    (key) => normalizeComparableValue(existingRecord[key]) !== normalizeComparableValue(nextRecord[key]),
  );
}

function normalizeComparableValue(value) {
  return value ?? null;
}

function listSessionFiles(rootDir) {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith("_") || entry.name.startsWith(".")) {
      continue;
    }

    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSessionFiles(entryPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".json") && entry.name.startsWith("session_")) {
      files.push(entryPath);
    }
  }

  return files;
}

function toSampleResult(outcome) {
  return {
    status: outcome.status,
    evidence_id: outcome.record.evidence_id,
    source_locator: outcome.record.source_locator,
    verbatim_payload_ref: outcome.record.verbatim_payload_ref,
  };
}

function pushCapped(target, value, limit = MAX_DETAIL_RESULTS) {
  if (target.length < limit) {
    target.push(value);
  }
}

function assertImportLimit(limit) {
  if (limit === Number.POSITIVE_INFINITY) {
    return;
  }

  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("importAgentOpsSessions limit must be a positive integer or Infinity.");
  }
}

module.exports = {
  SESSIONS_RELATIVE_ROOT,
  PAYLOAD_NAMESPACE_SEGMENTS,
  TERMINAL_SESSION_STATUSES,
  importAgentOpsSessions,
  buildSessionEvidenceId,
};
