const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { FilePayloadStore, createSha256 } = require("../evidence/file-payload-store");
const { assertLifecycleRecord } = require("../lifecycle/rules");
const { CodexImportState } = require("./codex-import-state");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { EcitrValidator } = require("../validation/validator");

const PAYLOAD_NAMESPACE_SEGMENTS = Object.freeze(["codex", "rollouts"]);
const SOURCE_LOCATOR_PREFIX = "codex-thread://";
const DEFAULT_CHECKPOINT_POLICY = Object.freeze({
  days: 7,
  messages: 100,
});
const MAX_SAMPLE_RESULTS = 10;
const MAX_DETAIL_RESULTS = 20;

function importCodexRollouts({
  codexRoot = resolveDefaultCodexRoot(),
  catalogRoot,
  dryRun = true,
  limit = Number.POSITIVE_INFINITY,
  includeSessions = true,
  includeArchived = true,
  validator = new EcitrValidator(),
} = {}) {
  if (!codexRoot) {
    throw new Error("importCodexRollouts requires a codexRoot.");
  }

  if (!catalogRoot) {
    throw new Error("importCodexRollouts requires a catalogRoot.");
  }

  assertImportLimit(limit);

  const resolvedCodexRoot = path.resolve(codexRoot);
  const resolvedCatalogRoot = path.resolve(catalogRoot);
  assertDirectoryExists(resolvedCodexRoot, "Codex root");

  const sessionIndex = loadSessionIndex(resolvedCodexRoot);
  const rolloutFiles = listRolloutFiles({
    codexRoot: resolvedCodexRoot,
    includeSessions,
    includeArchived,
  });
  const catalog = new FileBackedCatalog({
    rootDir: resolvedCatalogRoot,
    validator,
  });
  const importState = CodexImportState.load({
    rootDir: resolvedCatalogRoot,
  });
  const payloadStore = new FilePayloadStore({ rootDir: resolvedCatalogRoot });
  const latestSnapshots = loadLatestSnapshotsByLocator({
    catalog,
    catalogRoot: resolvedCatalogRoot,
  });
  const summary = {
    dry_run: dryRun,
    codex_root: resolvedCodexRoot,
    catalog_root: resolvedCatalogRoot,
    include_sessions: includeSessions,
    include_archived: includeArchived,
    checkpoint_policy: {
      days: DEFAULT_CHECKPOINT_POLICY.days,
      messages: DEFAULT_CHECKPOINT_POLICY.messages,
      first_seen: true,
      new_final_answer: true,
      archived: true,
    },
    import_state_file: importState.filePath,
    scanned_files: rolloutFiles.length,
    candidate_rollouts: 0,
    eligible_rollouts: 0,
    planned: 0,
    imported: 0,
    skipped_existing: 0,
    skipped_unchanged: 0,
    skipped_checkpoint: 0,
    skipped_duplicate_source: 0,
    skipped_no_visible_messages: 0,
    conflicts: 0,
    errors: 0,
    sample_results: [],
    conflict_details: [],
    error_details: [],
  };
  const seenEvidenceIds = new Map();

  for (const rolloutFilePath of rolloutFiles) {
    if (summary.candidate_rollouts >= limit) {
      break;
    }

    try {
      summary.candidate_rollouts += 1;
      const sourceStat = fs.statSync(rolloutFilePath);
      const sourceFingerprint = createSourceFingerprint(sourceStat);
      if (importState.getSourceFingerprint(rolloutFilePath) === sourceFingerprint) {
        summary.skipped_unchanged += 1;
        pushCapped(summary.sample_results, {
          status: "skipped_unchanged",
          evidence_id: null,
          source_locator: path.resolve(rolloutFilePath),
          verbatim_payload_ref: null,
        }, MAX_SAMPLE_RESULTS);
        continue;
      }

      const sourceBytes = fs.readFileSync(rolloutFilePath);
      const parsed = parseCodexRollout({
        sourcePath: rolloutFilePath,
        sourceBytes,
        sourceStat,
        sessionIndex,
      });
      if (parsed.visibleMessages.length === 0) {
        summary.skipped_no_visible_messages += 1;
        if (!dryRun) {
          importState.setSourceFingerprint(rolloutFilePath, sourceFingerprint);
        }
        pushCapped(summary.sample_results, {
          status: "skipped_no_visible_messages",
          evidence_id: null,
          source_locator: parsed.sourceLocator,
          verbatim_payload_ref: null,
        }, MAX_SAMPLE_RESULTS);
        continue;
      }

      summary.eligible_rollouts += 1;
      const latestSnapshot = latestSnapshots.get(parsed.sourceLocator) ?? null;
      const checkpoint = determineCheckpoint({
        parsed,
        latestSnapshot,
      });
      if (!checkpoint.shouldSnapshot) {
        summary.skipped_checkpoint += 1;
        if (!dryRun) {
          importState.setSourceFingerprint(rolloutFilePath, sourceFingerprint);
        }
        pushCapped(summary.sample_results, {
          status: "skipped_checkpoint",
          evidence_id: null,
          source_locator: parsed.sourceLocator,
          verbatim_payload_ref: null,
          checkpoint_reason: checkpoint.reason,
        }, MAX_SAMPLE_RESULTS);
        continue;
      }

      const snapshotPlan = buildSnapshotPlan({
        parsed,
        latestSnapshot,
        checkpointReason: checkpoint.reason,
      });
      const duplicate = seenEvidenceIds.get(snapshotPlan.evidenceId);
      if (duplicate) {
        if (duplicate.sourceHash === parsed.sourceHash) {
          summary.skipped_duplicate_source += 1;
          if (!dryRun) {
            importState.setSourceFingerprint(rolloutFilePath, sourceFingerprint);
          }
          pushCapped(summary.sample_results, {
            status: "skipped_duplicate_source",
            evidence_id: snapshotPlan.evidenceId,
            source_locator: parsed.sourceLocator,
            verbatim_payload_ref: snapshotPlan.payloadRef,
          }, MAX_SAMPLE_RESULTS);
          continue;
        }

        summary.conflicts += 1;
        pushCapped(summary.conflict_details, {
          evidence_id: snapshotPlan.evidenceId,
          source_locator: parsed.sourceLocator,
          conflict_fields: ["evidence_id"],
          first_seen_source_locator: duplicate.sourceLocator,
        });
        pushCapped(summary.sample_results, {
          status: "conflict",
          evidence_id: snapshotPlan.evidenceId,
          source_locator: parsed.sourceLocator,
          verbatim_payload_ref: snapshotPlan.payloadRef,
        }, MAX_SAMPLE_RESULTS);
        continue;
      }

      seenEvidenceIds.set(snapshotPlan.evidenceId, {
        sourceHash: parsed.sourceHash,
        payloadHash: snapshotPlan.payloadHash,
        sourceLocator: parsed.sourceLocator,
      });

      const outcome = importSingleCodexRollout({
        parsed,
        snapshotPlan,
        catalog,
        payloadStore,
        dryRun,
        validator,
        latestSnapshot,
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

      if (!dryRun && outcome.status !== "conflict") {
        importState.setSourceFingerprint(rolloutFilePath, sourceFingerprint);
      }
      updateLatestSnapshotState(latestSnapshots, outcome);

      pushCapped(summary.sample_results, toSampleResult(outcome), MAX_SAMPLE_RESULTS);
    } catch (error) {
      summary.errors += 1;
      pushCapped(summary.error_details, {
        source_locator: path.resolve(rolloutFilePath),
        message: error.message,
      });
    }
  }

  if (!dryRun) {
    importState.pruneSources(rolloutFiles);
    importState.save();
  }

  return summary;
}

function importSingleCodexRollout({ parsed, snapshotPlan, catalog, payloadStore, dryRun, validator, latestSnapshot }) {
  const parentEvidenceId =
    latestSnapshot?.record?.evidence_id && latestSnapshot.record.evidence_id !== snapshotPlan.evidenceId
      ? latestSnapshot.record.evidence_id
      : null;
  const record = buildEvidenceRecord({
    snapshotPlan,
    parentEvidenceId,
  });

  validator.validateRecord("evidence", record);
  assertLifecycleRecord("evidence", record);

  const existing = catalog.getRecord("evidence", snapshotPlan.evidenceId);
  if (existing) {
    const mismatches = diffEvidenceRecords(existing, record);
    if (mismatches.length === 0 || isEquivalentLegacyCodexSnapshot(existing, record)) {
      return {
        status: "skipped_existing",
        record,
        metadata: deriveSnapshotMetadataFromPayload(snapshotPlan.payload),
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
      metadata: deriveSnapshotMetadataFromPayload(snapshotPlan.payload),
    };
  }

  payloadStore.writePayload({
    evidenceId: snapshotPlan.evidenceId,
    capturedAt: snapshotPlan.capturedAt,
    extension: ".json",
    namespaceSegments: PAYLOAD_NAMESPACE_SEGMENTS,
    bytes: snapshotPlan.payloadBytes,
  });
  const persisted = catalog.writeRecord("evidence", record);

  return {
    status: "imported",
    record,
    record_file: persisted.filePath,
    metadata: deriveSnapshotMetadataFromPayload(snapshotPlan.payload),
  };
}

function parseCodexRollout({ sourcePath, sourceBytes, sourceStat, sessionIndex }) {
  const lines = sourceBytes.toString("utf8").split("\n").filter(Boolean);
  if (lines.length === 0) {
    throw new Error(`Codex rollout file is empty: ${sourcePath}`);
  }

  const events = lines.map((line) => JSON.parse(line));
  const sessionMetaEvent = events.find((event) => event.type === "session_meta");
  if (!sessionMetaEvent?.payload?.id) {
    throw new Error(`Codex rollout is missing session_meta.id: ${sourcePath}`);
  }

  const sessionMeta = sessionMetaEvent.payload;
  const threadId = sessionMeta.id;
  const sessionIndexEntry = sessionIndex.get(threadId) ?? null;
  const sourceFilePath = path.resolve(sourcePath);
  const sourceObservedAt = resolveObservedAt({
    sourcePath,
    sourceStat,
  });
  const visibleMessages = [];
  let finalAnswerCount = 0;

  for (const event of events) {
    if (event.type !== "event_msg") {
      continue;
    }

    if (event.payload?.type === "user_message") {
      visibleMessages.push({
        sequence: visibleMessages.length + 1,
        timestamp: event.timestamp,
        role: "user",
        phase: null,
        text: event.payload.message,
      });
      continue;
    }

    if (event.payload?.type === "agent_message") {
      if (event.payload.phase === "final_answer") {
        finalAnswerCount += 1;
      }
      visibleMessages.push({
        sequence: visibleMessages.length + 1,
        timestamp: event.timestamp,
        role: "assistant",
        phase: event.payload.phase ?? null,
        text: event.payload.message,
      });
    }
  }

  const lastVisibleMessageAt = resolveCapturedAt({
    visibleMessages,
    sessionMetaTimestamp: sessionMeta.timestamp,
    sourcePath,
    sourceStat,
  });

  return {
    threadId,
    sourcePath: sourceFilePath,
    sourceLocator: `${SOURCE_LOCATOR_PREFIX}${threadId}`,
    sourceObservedAt,
    lastVisibleMessageAt,
    isArchived: isArchivedSourcePath(sourceFilePath),
    messageCount: visibleMessages.length,
    finalAnswerCount,
    threadName: sessionIndexEntry?.thread_name ?? null,
    threadUpdatedAt: sessionIndexEntry?.updated_at ?? null,
    sessionStartedAt: sessionMeta.timestamp ?? null,
    cwd: sessionMeta.cwd ?? null,
    originator: sessionMeta.originator ?? null,
    source: sessionMeta.source ?? null,
    cliVersion: sessionMeta.cli_version ?? null,
    modelProvider: sessionMeta.model_provider ?? null,
    projectScope: "project",
    actorScope: inferActorScope(visibleMessages),
    visibleMessages,
    sourceHash: createSha256(sourceBytes),
  };
}

function buildSnapshotPlan({ parsed, latestSnapshot, checkpointReason }) {
  const capturedAt = resolveSnapshotCapturedAt({
    parsed,
    latestSnapshot,
    checkpointReason,
  });
  const evidenceId = buildEvidenceId({
    threadId: parsed.threadId,
    capturedAt,
  });
  const payload = {
    capture_kind: "codex_rollout_snapshot",
    checkpoint_reason: checkpointReason,
    thread_id: parsed.threadId,
    thread_name: parsed.threadName,
    thread_updated_at: parsed.threadUpdatedAt,
    source_rollout_path: parsed.sourcePath,
    session_started_at: parsed.sessionStartedAt,
    captured_at: capturedAt,
    last_visible_message_at: parsed.lastVisibleMessageAt,
    source_observed_at: parsed.sourceObservedAt,
    archived: parsed.isArchived,
    cwd: parsed.cwd,
    originator: parsed.originator,
    source: parsed.source,
    cli_version: parsed.cliVersion,
    model_provider: parsed.modelProvider,
    message_count: parsed.messageCount,
    final_answer_count: parsed.finalAnswerCount,
    messages: parsed.visibleMessages,
  };
  const payloadBytes = `${JSON.stringify(payload, null, 2)}\n`;

  return {
    evidenceId,
    capturedAt,
    sourceHash: parsed.sourceHash,
    payload,
    payloadBytes,
    payloadRef: buildPayloadRef({
      evidenceId,
      capturedAt,
    }),
    payloadHash: createSha256(payloadBytes),
  };
}

function buildEvidenceRecord({ snapshotPlan, parentEvidenceId }) {
  const record = {
    evidence_id: snapshotPlan.evidenceId,
    substrate_ref: pathToFileURL(snapshotPlan.payload.source_rollout_path).href,
    source_type: "chat",
    source_locator: `${SOURCE_LOCATOR_PREFIX}${snapshotPlan.payload.thread_id}`,
    captured_at: snapshotPlan.capturedAt,
    project_scope: "project",
    actor_scope: inferActorScope(snapshotPlan.payload.messages),
    verbatim_payload_ref: snapshotPlan.payloadRef,
    payload_hash: snapshotPlan.payloadHash,
    source_hash: snapshotPlan.sourceHash,
    redaction_state: "none",
    immutable: true,
  };

  if (parentEvidenceId) {
    record.parent_evidence_id = parentEvidenceId;
  }

  return record;
}

function loadSessionIndex(codexRoot) {
  const filePath = path.join(codexRoot, "session_index.jsonl");
  const entries = new Map();
  if (!fs.existsSync(filePath)) {
    return entries;
  }

  for (const line of fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean)) {
    const entry = JSON.parse(line);
    if (entry?.id && typeof entry.id === "string") {
      entries.set(entry.id, entry);
    }
  }

  return entries;
}

function listRolloutFiles({ codexRoot, includeSessions, includeArchived }) {
  const files = [];

  if (includeSessions) {
    const sessionsRoot = path.join(codexRoot, "sessions");
    if (fs.existsSync(sessionsRoot)) {
      files.push(...listJsonlFilesRecursive(sessionsRoot));
    }
  }

  if (includeArchived) {
    const archivedRoot = path.join(codexRoot, "archived_sessions");
    if (fs.existsSync(archivedRoot)) {
      files.push(...listJsonlFilesRecursive(archivedRoot));
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function listJsonlFilesRecursive(rootDir) {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsonlFilesRecursive(entryPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(entryPath);
    }
  }

  return files;
}

function loadLatestSnapshotsByLocator({ catalog, catalogRoot }) {
  const latestByLocator = new Map();
  for (const record of catalog.listRecords("evidence")) {
    if (record.source_type !== "chat" || !String(record.source_locator || "").startsWith(SOURCE_LOCATOR_PREFIX)) {
      continue;
    }

    const current = latestByLocator.get(record.source_locator);
    if (!current || new Date(record.captured_at).getTime() > new Date(current.record.captured_at).getTime()) {
      latestByLocator.set(record.source_locator, {
        record,
      });
    }
  }

  for (const entry of latestByLocator.values()) {
    entry.metadata = deriveSnapshotMetadata({
      record: entry.record,
      catalogRoot,
    });
  }

  return latestByLocator;
}

function deriveSnapshotMetadata({ record, catalogRoot }) {
  const payloadPath = path.join(catalogRoot, record.verbatim_payload_ref);
  const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
  return deriveSnapshotMetadataFromPayload(payload);
}

function deriveSnapshotMetadataFromPayload(payload) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const finalAnswerCount =
    typeof payload.final_answer_count === "number"
      ? payload.final_answer_count
      : messages.filter((message) => message.role === "assistant" && message.phase === "final_answer").length;

  return {
    messageCount: typeof payload.message_count === "number" ? payload.message_count : messages.length,
    finalAnswerCount,
    isArchived:
      typeof payload.archived === "boolean"
        ? payload.archived
        : isArchivedSourcePath(String(payload.source_rollout_path || "")),
  };
}

function determineCheckpoint({ parsed, latestSnapshot }) {
  if (!latestSnapshot) {
    return { shouldSnapshot: true, reason: "first_seen" };
  }

  const previous = latestSnapshot.metadata;
  if (parsed.finalAnswerCount > previous.finalAnswerCount) {
    return { shouldSnapshot: true, reason: "new_final_answer" };
  }

  if (parsed.isArchived && !previous.isArchived) {
    return { shouldSnapshot: true, reason: "thread_archived" };
  }

  if (parsed.messageCount - previous.messageCount >= DEFAULT_CHECKPOINT_POLICY.messages) {
    return { shouldSnapshot: true, reason: "message_threshold" };
  }

  if (daysBetween(latestSnapshot.record.captured_at, parsed.lastVisibleMessageAt) >= DEFAULT_CHECKPOINT_POLICY.days) {
    return { shouldSnapshot: true, reason: "age_threshold" };
  }

  return { shouldSnapshot: false, reason: "below_checkpoint_thresholds" };
}

function resolveSnapshotCapturedAt({ parsed, latestSnapshot, checkpointReason }) {
  if (checkpointReason === "thread_archived") {
    const observedAt = maxIsoTimestamp(parsed.lastVisibleMessageAt, parsed.sourceObservedAt, latestSnapshot?.record?.captured_at ?? null);
    if (!latestSnapshot?.record?.captured_at) {
      return observedAt;
    }

    if (new Date(observedAt).getTime() > new Date(latestSnapshot.record.captured_at).getTime()) {
      return observedAt;
    }

    return new Date(new Date(latestSnapshot.record.captured_at).getTime() + 1).toISOString();
  }

  return parsed.lastVisibleMessageAt;
}

function updateLatestSnapshotState(latestSnapshots, outcome) {
  if (!outcome || outcome.status === "conflict") {
    return;
  }

  latestSnapshots.set(outcome.record.source_locator, {
    record: outcome.record,
    metadata: outcome.metadata,
  });
}

function resolveCapturedAt({ visibleMessages, sessionMetaTimestamp, sourcePath, sourceStat }) {
  const lastVisibleTimestamp = visibleMessages.at(-1)?.timestamp ?? sessionMetaTimestamp;
  if (lastVisibleTimestamp && !Number.isNaN(new Date(lastVisibleTimestamp).getTime())) {
    return new Date(lastVisibleTimestamp).toISOString();
  }

  return resolveObservedAt({
    sourcePath,
    sourceStat,
  });
}

function resolveObservedAt({ sourcePath, sourceStat }) {
  if (sourceStat?.mtime instanceof Date && !Number.isNaN(sourceStat.mtime.getTime())) {
    return sourceStat.mtime.toISOString();
  }

  return fs.statSync(sourcePath).mtime.toISOString();
}

function createSourceFingerprint(sourceStat) {
  return `${sourceStat.size}:${Math.trunc(sourceStat.mtimeMs)}`;
}

function daysBetween(leftIso, rightIso) {
  const left = new Date(leftIso).getTime();
  const right = new Date(rightIso).getTime();
  if (Number.isNaN(left) || Number.isNaN(right)) {
    return 0;
  }

  return Math.floor((right - left) / (24 * 60 * 60 * 1000));
}

function maxIsoTimestamp(...values) {
  const timestamps = values
    .map((value) => new Date(value))
    .filter((value) => !Number.isNaN(value.getTime()))
    .map((value) => value.getTime());
  if (timestamps.length === 0) {
    throw new Error("maxIsoTimestamp requires at least one valid ISO timestamp.");
  }

  return new Date(Math.max(...timestamps)).toISOString();
}

function isArchivedSourcePath(sourcePath) {
  return sourcePath.includes(`${path.sep}archived_sessions${path.sep}`) || sourcePath.endsWith(`${path.sep}archived_sessions`);
}

function buildEvidenceId({ threadId, capturedAt }) {
  if (!/^[A-Za-z0-9_-]+$/.test(threadId)) {
    throw new Error(`Codex thread id cannot be mapped safely into an evidence id: ${threadId}`);
  }

  const timestamp = new Date(capturedAt);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error(`Codex rollout capturedAt must be valid ISO-8601: ${capturedAt}`);
  }

  const compactTimestamp = timestamp.toISOString().replace(/[-:.]/g, "").replace("T", "_");
  return `ev_codex_thread_${threadId}_${compactTimestamp}`;
}

function buildPayloadRef({ evidenceId, capturedAt }) {
  const timestamp = new Date(capturedAt);
  const year = String(timestamp.getUTCFullYear());
  const month = String(timestamp.getUTCMonth() + 1).padStart(2, "0");
  return path.posix.join("payloads", "evidence", ...PAYLOAD_NAMESPACE_SEGMENTS, year, month, `${evidenceId}.json`);
}

function inferActorScope(messages) {
  const roles = new Set(messages.map((message) => message.role));

  if (roles.has("user") && roles.has("assistant")) {
    return "mixed";
  }

  if (roles.has("user")) {
    return "human";
  }

  if (roles.has("assistant")) {
    return "agent";
  }

  return "system";
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

  return keys.filter((key) => normalizeComparableValue(existingRecord[key]) !== normalizeComparableValue(nextRecord[key]));
}

function isEquivalentLegacyCodexSnapshot(existingRecord, nextRecord) {
  return (
    existingRecord.evidence_id === nextRecord.evidence_id &&
    existingRecord.source_type === "chat" &&
    nextRecord.source_type === "chat" &&
    existingRecord.substrate_ref === nextRecord.substrate_ref &&
    existingRecord.source_locator === nextRecord.source_locator &&
    existingRecord.captured_at === nextRecord.captured_at &&
    existingRecord.source_hash === nextRecord.source_hash
  );
}

function normalizeComparableValue(value) {
  return value ?? null;
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

function assertDirectoryExists(dirPath, label) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    throw new Error(`${label} does not exist: ${dirPath}`);
  }
}

function assertImportLimit(limit) {
  if (limit === Number.POSITIVE_INFINITY) {
    return;
  }

  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`Codex rollout import limit must be a non-negative integer: ${limit}`);
  }
}

function resolveDefaultCodexRoot() {
  return path.join(os.homedir(), ".codex");
}

module.exports = {
  DEFAULT_CHECKPOINT_POLICY,
  PAYLOAD_NAMESPACE_SEGMENTS,
  SOURCE_LOCATOR_PREFIX,
  importCodexRollouts,
  parseCodexRollout,
  buildEvidenceId,
  isEquivalentLegacyCodexSnapshot,
  resolveDefaultCodexRoot,
};
