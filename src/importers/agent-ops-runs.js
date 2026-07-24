const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { FilePayloadStore, createSha256 } = require("../evidence/file-payload-store");
const {
  buildEvidenceCorrectionIndex,
  compareExpectedEvidenceToCurrent,
} = require("../evidence/corrections");
const { assertLifecycleRecord } = require("../lifecycle/rules");
const { CaseSeedStore } = require("../cases/case-seed-store");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { EcitrValidator } = require("../validation/validator");
const { resolveWorkspaceIdForAgentOps } = require("../workspace/source-mapping");

const RUNS_RELATIVE_ROOT = path.join("memory", "runs");
const PAYLOAD_NAMESPACE_SEGMENTS = Object.freeze(["agent-ops", "runs"]);
const MAX_SAMPLE_RESULTS = 10;
const MAX_DETAIL_RESULTS = 20;

function importAgentOpsRuns({
  agentOpsRoot,
  catalogRoot,
  projectId = null,
  workspaceId = null,
  dryRun = true,
  limit = Number.POSITIVE_INFINITY,
  validator = new EcitrValidator(),
} = {}) {
  if (!agentOpsRoot) {
    throw new Error("importAgentOpsRuns requires an agentOpsRoot.");
  }

  if (!catalogRoot) {
    throw new Error("importAgentOpsRuns requires a catalogRoot.");
  }

  assertImportLimit(limit);

  const resolvedAgentOpsRoot = path.resolve(agentOpsRoot);
  const resolvedCatalogRoot = path.resolve(catalogRoot);
  const runsRoot = path.join(resolvedAgentOpsRoot, RUNS_RELATIVE_ROOT);

  if (!fs.existsSync(runsRoot) || !fs.statSync(runsRoot).isDirectory()) {
    throw new Error(`agent-ops runs root does not exist: ${runsRoot}`);
  }

  const catalog = new FileBackedCatalog({
    rootDir: resolvedCatalogRoot,
    validator,
  });
  const payloadStore = new FilePayloadStore({ rootDir: resolvedCatalogRoot });
  const evidenceCorrectionIndex = buildEvidenceCorrectionIndex(catalog.listRecords("evidence"));
  const caseSeedStore = new CaseSeedStore({
    rootDir: resolvedCatalogRoot,
    validator,
  });
  const runFilePaths = listJsonFiles(runsRoot);
  const seenEvidenceIds = new Map();
  const summary = {
    dry_run: dryRun,
    agent_ops_root: resolvedAgentOpsRoot,
    catalog_root: resolvedCatalogRoot,
    runs_root: runsRoot,
    project_filter: projectId,
    scanned_files: runFilePaths.length,
    candidate_runs: 0,
    planned: 0,
    imported: 0,
    skipped_existing: 0,
    conflicts: 0,
    errors: 0,
    case_seeds_created: 0,
    case_seeds_updated: 0,
    case_seeds_seen_existing: 0,
    case_seeds_compiled_conflicts: 0,
    case_seeds_skipped_none: 0,
    case_seeds_skipped_not_applicable: 0,
    case_seed_errors: 0,
    project_counts: {},
    sample_results: [],
    conflict_details: [],
    error_details: [],
  };

  for (const runFilePath of runFilePaths) {
    if (summary.candidate_runs >= limit) {
      break;
    }

    try {
      const sourceBytes = fs.readFileSync(runFilePath);
      const runRecord = JSON.parse(sourceBytes.toString("utf8"));
      assertAgentOpsRunRecord(runRecord, runFilePath);

      if (projectId && runRecord.project_id !== projectId) {
        continue;
      }

      const evidenceId = buildEvidenceId(runRecord.id);
      const firstSeenPath = seenEvidenceIds.get(evidenceId);
      if (firstSeenPath) {
        summary.candidate_runs += 1;
        summary.conflicts += 1;
        pushCapped(summary.conflict_details, {
          evidence_id: evidenceId,
          source_locator: path.resolve(runFilePath),
          conflict_fields: ["evidence_id"],
          first_seen_source_locator: firstSeenPath,
        });
        pushCapped(summary.sample_results, {
          status: "conflict",
          evidence_id: evidenceId,
          source_locator: path.resolve(runFilePath),
          verbatim_payload_ref: null,
        }, MAX_SAMPLE_RESULTS);
        continue;
      }

      seenEvidenceIds.set(evidenceId, path.resolve(runFilePath));
      summary.candidate_runs += 1;
      summary.project_counts[runRecord.project_id] =
        (summary.project_counts[runRecord.project_id] ?? 0) + 1;
      const resolvedWorkspaceId = resolveWorkspaceIdForAgentOps({
        projectId: runRecord.project_id,
        workspaceId,
        catalogRoot: resolvedCatalogRoot,
      });

      const outcome = importSingleRun({
        evidenceId,
        runFilePath,
        runRecord,
        sourceBytes,
        catalog,
        payloadStore,
        dryRun,
        validator,
        workspaceId: resolvedWorkspaceId,
        evidenceCorrectionIndex,
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

      if (!dryRun) {
        applyCaseSeedImport({
          summary,
          caseSeedStore,
          runRecord,
          runFilePath,
          sourceBytes,
          // Case-seed refs retain the deterministic source evidence id. The
          // correction overlay resolves that id to the latest immutable
          // correction without forcing every historical ref to be rewritten.
          runEvidenceRef: evidenceId,
          agentOpsRoot: resolvedAgentOpsRoot,
          workspaceId: resolvedWorkspaceId,
        });
      }

      pushCapped(summary.sample_results, toSampleResult(outcome), MAX_SAMPLE_RESULTS);
    } catch (error) {
      summary.errors += 1;
      pushCapped(summary.error_details, {
        source_locator: path.resolve(runFilePath),
        message: error.message,
      });
    }
  }

  return summary;
}

function applyCaseSeedImport({
  summary,
  caseSeedStore,
  runRecord,
  runFilePath,
  sourceBytes,
  runEvidenceRef,
  agentOpsRoot,
  workspaceId,
}) {
  const decision = runRecord.ecitr_closeout?.decision ?? null;
  if (decision === "none") {
    summary.case_seeds_skipped_none += 1;
    return;
  }

  if (decision === "not_applicable") {
    summary.case_seeds_skipped_not_applicable += 1;
    return;
  }

  if (decision !== "candidate") {
    return;
  }

  try {
    const outcome = caseSeedStore.upsertFromRun({
      runRef: toPosixRelativePath(agentOpsRoot, runFilePath),
      runRecord,
      runEvidenceRef,
      workspaceId,
      sourceRunArtifactHash: createSha256(sourceBytes),
      now: runRecord.created_at,
    });

    if (outcome.status === "created") {
      summary.case_seeds_created += 1;
    } else if (outcome.status === "updated") {
      summary.case_seeds_updated += 1;
    } else if (outcome.status === "seen_existing") {
      summary.case_seeds_seen_existing += 1;
    } else if (outcome.status === "compiled_conflict") {
      summary.case_seeds_compiled_conflicts += 1;
    }
  } catch (error) {
    summary.case_seed_errors += 1;
    pushCapped(summary.error_details, {
      source_locator: path.resolve(runFilePath),
      message: error.message,
    });
  }
}

function importSingleRun({
  evidenceId,
  runFilePath,
  runRecord,
  sourceBytes,
  catalog,
  payloadStore,
  dryRun,
  validator,
  workspaceId,
  evidenceCorrectionIndex,
}) {
  const payloadPlan = payloadStore.planPayload({
    evidenceId,
    capturedAt: runRecord.created_at,
    extension: path.extname(runFilePath) || ".json",
    namespaceSegments: PAYLOAD_NAMESPACE_SEGMENTS,
    bytes: sourceBytes,
  });
  const record = buildEvidenceRecordFromRun({
    runRecord,
    sourcePath: runFilePath,
    payloadRef: payloadPlan.relativeRef,
    payloadHash: payloadPlan.payloadHash,
    sourceHash: createSha256(sourceBytes),
    workspaceId,
  });

  validator.validateRecord("evidence", record);
  assertLifecycleRecord("evidence", record);

  const comparison = compareExpectedEvidenceToCurrent({
    index: evidenceCorrectionIndex,
    expectedRecord: record,
    diffEvidenceRecords,
  });
  if (comparison) {
    if (comparison.mismatches.length === 0) {
      return {
        status: "skipped_existing",
        record: comparison.currentRecord,
      };
    }

    return {
      status: "conflict",
      record,
      mismatches: comparison.mismatches,
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
    capturedAt: runRecord.created_at,
    extension: path.extname(runFilePath) || ".json",
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

function buildEvidenceRecordFromRun({
  runRecord,
  sourcePath,
  payloadRef,
  payloadHash,
  sourceHash,
  workspaceId = null,
}) {
  return {
    evidence_id: buildEvidenceId(runRecord.id),
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
    substrate_ref: pathToFileURL(path.resolve(sourcePath)).href,
    source_type: "file",
    source_locator: path.resolve(sourcePath),
    captured_at: runRecord.created_at,
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: payloadRef,
    payload_hash: payloadHash,
    source_hash: sourceHash,
    redaction_state: "none",
    immutable: true,
  };
}

function buildEvidenceId(runId) {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) {
    throw new Error(`Run id cannot be mapped safely into an evidence id: ${runId}`);
  }

  return `ev_aops_run_${runId}`;
}

function assertAgentOpsRunRecord(runRecord, runFilePath) {
  if (!runRecord || typeof runRecord !== "object" || Array.isArray(runRecord)) {
    throw new Error(`Run file must contain a JSON object: ${runFilePath}`);
  }

  for (const key of ["id", "project_id", "created_at"]) {
    if (!runRecord[key] || typeof runRecord[key] !== "string") {
      throw new Error(`Run file is missing required string field ${key}: ${runFilePath}`);
    }
  }

  if (Number.isNaN(new Date(runRecord.created_at).getTime())) {
    throw new Error(`Run file has invalid created_at: ${runFilePath}`);
  }
}

function diffEvidenceRecords(existingRecord, nextRecord) {
  const keys = [
    "evidence_id",
    "workspace_id",
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

  return keys.filter((key) => normalizeComparableValue(existingRecord[key]) !== normalizeComparableValue(nextRecord[key]));
}

function normalizeComparableValue(value) {
  return value ?? null;
}

function listJsonFiles(rootDir) {
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
      files.push(...listJsonFiles(entryPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(entryPath);
    }
  }

  return files;
}

function toPosixRelativePath(rootDir, filePath) {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
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
    throw new Error("importAgentOpsRuns limit must be a positive integer or Infinity.");
  }
}

module.exports = {
  RUNS_RELATIVE_ROOT,
  PAYLOAD_NAMESPACE_SEGMENTS,
  importAgentOpsRuns,
  buildEvidenceRecordFromRun,
  buildEvidenceId,
};
