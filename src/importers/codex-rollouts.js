const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { FilePayloadStore, createSha256 } = require("../evidence/file-payload-store");
const {
  buildEvidenceCorrectionIndex,
  compareExpectedEvidenceToCurrent,
} = require("../evidence/corrections");
const { assertLifecycleRecord } = require("../lifecycle/rules");
const { CaseSeedStore } = require("../cases/case-seed-store");
const { CodexImportState } = require("./codex-import-state");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { EcitrValidator } = require("../validation/validator");
const { isPathWithinRoots, resolveWorkspaceIdForCodex } = require("../workspace/source-mapping");
const { PARSER_VERSION, parseRolloutEvents, extractVisibleMessages } = require("./codex-visible-messages");

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
  workspaceRoot = null,
  workspaceId = null,
  sourceSelection = null,
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
  const workspaceRoots = normalizeWorkspaceRoots(workspaceRoot);
  assertDirectoryExists(resolvedCodexRoot, "Codex root");

  const sessionIndex = loadSessionIndex(resolvedCodexRoot);
  const rolloutFiles = listRolloutFiles({
    codexRoot: resolvedCodexRoot,
    includeSessions,
    includeArchived,
  });
  // Pin and validate the whole selected batch before any catalog or ledger write.
  // The import below uses these same bytes even if a live rollout later grows.
  const selectedSources = sourceSelection === null ? null : prepareSelectedSources({
    sourceSelection,
    rolloutFiles,
  });
  const candidateFiles = selectedSources ? [...selectedSources.keys()] : rolloutFiles;
  if (selectedSources && limit < selectedSources.size) {
    throw new Error("Codex source selection cannot be truncated by an import limit.");
  }
  const scopeKey = createSha256(JSON.stringify({ workspaceRoots, workspaceId }));
  const catalog = new FileBackedCatalog({
    rootDir: resolvedCatalogRoot,
    validator,
  });
  const caseSeedStore = new CaseSeedStore({
    rootDir: resolvedCatalogRoot,
    validator,
  });
  const importState = CodexImportState.load({
    rootDir: resolvedCatalogRoot,
  });
  const payloadStore = new FilePayloadStore({ rootDir: resolvedCatalogRoot });
  const evidenceCorrectionIndex = buildEvidenceCorrectionIndex(catalog.listRecords("evidence"));
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
    workspace_root_filter: workspaceRoots.length > 0 ? workspaceRoots : null,
    checkpoint_policy: {
      days: DEFAULT_CHECKPOINT_POLICY.days,
      messages: DEFAULT_CHECKPOINT_POLICY.messages,
      first_seen: true,
      new_final_answer: true,
      archived: true,
    },
    import_state_file: importState.filePath,
    parser_version: PARSER_VERSION,
    source_selection: selectedSources ? [...selectedSources.values()].map((entry) => ({
      path: entry.sourcePath,
      sha256: entry.sourceHash,
      thread_id: entry.threadId,
    })) : null,
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
    skipped_workspace_filter: 0,
    rejected_unsupported: 0,
    rejected_partial: 0,
    rejected_malformed: 0,
    repair_required: 0,
    not_attempted: 0,
    conflicts: 0,
    errors: 0,
    case_seed_chat_links_attached: 0,
    case_seed_chat_links_seen_existing: 0,
    case_seed_linking: selectedSources ? "suppressed_evidence_only_selection" : "enabled",
    sample_results: [],
    conflict_details: [],
    error_details: [],
    coverage: createCoverageSummary(),
  };
  if (selectedSources) {
    summary.source_results = [];
    summary.preflight = preflightSelectedSources({
      selectedSources, sessionIndex, workspaceRoots, workspaceId,
      catalog, catalogRoot: resolvedCatalogRoot, payloadStore,
      validator, evidenceCorrectionIndex, latestSnapshots,
    });
    if (summary.preflight.status === "blocked") {
      for (const result of summary.preflight.sources) {
        const outcome = result.status === "passed" ? "not_attempted" : result.status;
        summary.candidate_rollouts += 1;
        summary[outcome] += 1;
        recordCoverage(summary, {
          sourcePath: result.path, sourceLocator: `${SOURCE_LOCATOR_PREFIX}${result.thread_id}`,
          status: result.coverage_status, outcome, sourceHash: result.sha256, format: result.format,
        });
      }
      finalizeCoverage(summary);
      return summary;
    }
  }
  const seenEvidenceIds = new Map();

  for (const rolloutFilePath of candidateFiles) {
    if (summary.candidate_rollouts >= limit) {
      break;
    }

    let candidateWriteState = { payload: "not_attempted", evidence: "not_attempted", seed_links: "not_attempted" };
    const selected = selectedSources?.get(rolloutFilePath);
    try {
      summary.candidate_rollouts += 1;
      let sourceStat = selected?.sourceStat ?? fs.statSync(rolloutFilePath);
      let sourceFingerprint = createSourceFingerprint(sourceStat);
      const cached = importState.getSourceEntry(rolloutFilePath);
      if (cached?.fingerprint === sourceFingerprint && cached.parser_version === PARSER_VERSION
        && cached.scope_key === scopeKey && (!selected || cached.source_hash === selected.sourceHash)) {
        summary.skipped_unchanged += 1;
        const cachedCoverage = cached.coverage_status ?? "unknown";
        recordCoverage(summary, {
          sourcePath: rolloutFilePath,
          sourceLocator: cached.source_locator,
          status: cachedCoverage,
          format: cached.format,
          cached: true,
          outcome: cached.outcome ?? "unknown",
          sourceHash: cached.source_hash,
          diagnosticCount: cached.diagnostic_count,
          diagnostics: cached.diagnostics,
          projectionCounts: cached.projection_counts,
        });
        if (cached.message_count > 0 && cachedCoverage === "supported") {
          summary.eligible_rollouts += 1;
        }
        pushCapped(summary.sample_results, {
          status: "skipped_unchanged",
          evidence_id: null,
          source_locator: path.resolve(rolloutFilePath),
          verbatim_payload_ref: null,
          coverage_status: cachedCoverage,
          cached_outcome: cached.outcome ?? "unknown",
        }, MAX_SAMPLE_RESULTS);
        continue;
      }

      const capturedSource = selected ?? readSourceSnapshot(rolloutFilePath);
      const sourceBytes = capturedSource.sourceBytes;
      sourceStat = capturedSource.sourceStat;
      sourceFingerprint = createSourceFingerprint(sourceStat);
      const parsed = selected?.parsed ?? parseCodexRollout({
        sourcePath: rolloutFilePath,
        sourceHash: selected?.sourceHash,
        sourceLocator: selected ? `${SOURCE_LOCATOR_PREFIX}${selected.threadId}` : null,
        sourceBytes,
        sourceStat,
        sessionIndex,
      });
      if (workspaceRoots.length > 0 && !isPathWithinRoots(parsed.cwd, workspaceRoots)) {
        summary.skipped_workspace_filter += 1;
        recordCoverage(summary, { ...parsed, status: "workspace_filtered", outcome: "skipped_workspace_filter" });
        pushCapped(summary.sample_results, {
          status: "skipped_workspace_filter",
          evidence_id: null,
          source_locator: parsed.sourceLocator,
          verbatim_payload_ref: null,
        }, MAX_SAMPLE_RESULTS);
        continue;
      }
      const cacheMetadata = {
        parser_version: PARSER_VERSION,
        scope_key: scopeKey,
        source_hash: parsed.sourceHash,
        source_locator: parsed.sourceLocator,
        thread_id: parsed.threadId,
        cwd: parsed.cwd,
        format: parsed.format,
        message_count: parsed.messageCount,
        coverage_status: parsed.coverageStatus,
        diagnostic_count: parsed.diagnosticCount,
        diagnostics: parsed.diagnostics,
        projection_counts: parsed.projectionCounts,
      };
      const latestSnapshot = latestSnapshots.get(parsed.sourceLocator) ?? null;
      if (["supported", "no_visible_messages"].includes(parsed.coverageStatus)
        && requiresSnapshotRepair({ parsed, latestSnapshot })) {
        summary.repair_required += 1;
        recordCoverage(summary, { ...parsed, status: "repair_required", outcome: "repair_required" });
        pushCapped(summary.conflict_details, {
          source_locator: parsed.sourceLocator,
          evidence_id: latestSnapshot.record.evidence_id,
          code: "parser_upgrade_requires_immutable_snapshot_repair",
        });
        continue;
      }
      if (parsed.coverageStatus === "unsupported" || parsed.coverageStatus === "partial") {
        const outcome = `rejected_${parsed.coverageStatus}`;
        summary[outcome] += 1;
        recordCoverage(summary, { ...parsed, status: parsed.coverageStatus, outcome });
        if (!dryRun) {
          importState.setSourceFingerprint(rolloutFilePath, sourceFingerprint, { ...cacheMetadata, outcome });
        }
        pushCapped(summary.error_details, {
          source_locator: parsed.sourceLocator,
          source_path: parsed.sourcePath,
          code: outcome,
          diagnostics: parsed.diagnostics,
        });
        continue;
      }
      if (parsed.visibleMessages.length === 0) {
        summary.skipped_no_visible_messages += 1;
        recordCoverage(summary, { ...parsed, status: "no_visible_messages", outcome: "skipped_no_visible_messages" });
        if (!dryRun) {
          importState.setSourceFingerprint(rolloutFilePath, sourceFingerprint, {
            ...cacheMetadata, outcome: "skipped_no_visible_messages",
          });
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
      const checkpoint = determineCheckpoint({
        parsed,
        latestSnapshot,
      });
      if (!checkpoint.shouldSnapshot) {
        summary.skipped_checkpoint += 1;
        recordCoverage(summary, { ...parsed, status: "supported", outcome: "skipped_checkpoint" });
        if (!dryRun) {
          importState.setSourceFingerprint(rolloutFilePath, sourceFingerprint, { ...cacheMetadata, outcome: "skipped_checkpoint" });
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
          recordCoverage(summary, { ...parsed, status: "supported", outcome: "skipped_duplicate_source" });
          if (!dryRun) {
            importState.setSourceFingerprint(rolloutFilePath, sourceFingerprint, { ...cacheMetadata, outcome: "skipped_duplicate_source" });
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
        recordCoverage(summary, { ...parsed, status: "conflict", outcome: "conflict" });
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
      const resolvedWorkspaceId = resolveWorkspaceIdForCodex({
        cwd: parsed.cwd,
        workspaceId,
        catalogRoot: resolvedCatalogRoot,
      });

      const outcome = importSingleCodexRollout({
        parsed,
        snapshotPlan,
        catalog,
        payloadStore,
        dryRun,
        validator,
        latestSnapshot,
        workspaceId: resolvedWorkspaceId,
        evidenceCorrectionIndex,
      });
      candidateWriteState = { ...candidateWriteState, ...outcome.writeState };

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
        if (selectedSources) {
          candidateWriteState.seed_links = "suppressed_evidence_only_selection";
        } else {
          candidateWriteState.seed_links = "uncertain";
          const linkOutcome = caseSeedStore.attachChatEvidence({
            threadRef: outcome.record.source_locator,
            chatEvidenceRef: snapshotPlan.evidenceId,
            now: outcome.record.captured_at,
          });
          summary.case_seed_chat_links_attached += linkOutcome.attached;
          summary.case_seed_chat_links_seen_existing += linkOutcome.seen_existing;
          candidateWriteState.seed_links = "completed";
        }
        importState.setSourceFingerprint(rolloutFilePath, sourceFingerprint, { ...cacheMetadata, outcome: outcome.status });
      }
      recordCoverage(summary, {
        ...parsed,
        status: outcome.status === "conflict" ? "conflict" : "supported",
        outcome: outcome.status,
        evidenceId: outcome.record.evidence_id,
        writeState: candidateWriteState,
      });
      updateLatestSnapshotState(latestSnapshots, outcome);

      pushCapped(summary.sample_results, toSampleResult(outcome), MAX_SAMPLE_RESULTS);
    } catch (error) {
      const malformed = error.code === "malformed_rollout";
      summary[malformed ? "rejected_malformed" : "errors"] += 1;
      recordCoverage(summary, {
        sourcePath: rolloutFilePath,
        status: malformed ? "malformed" : "error",
        outcome: malformed ? "rejected_malformed" : "error",
        writeState: { ...candidateWriteState, ...error.writeState },
      });
      pushCapped(summary.error_details, {
        source_locator: path.resolve(rolloutFilePath),
        code: error.code ?? "rollout_import_error",
        ...(Number.isInteger(error.line) ? { line: error.line } : {}),
      });
    }
  }

  if (!dryRun) {
    if (!selectedSources && includeSessions && includeArchived) {
      importState.pruneSources(rolloutFiles);
    }
    try {
      importState.save();
      summary.state_persistence = { status: "written" };
    } catch {
      summary.errors += 1;
      summary.state_persistence = { status: "failed", code: "import_state_write_failed" };
    }
  } else {
    summary.state_persistence = { status: "skipped_dry_run" };
  }

  finalizeCoverage(summary);
  return summary;
}

function importSingleCodexRollout({
  parsed,
  snapshotPlan,
  catalog,
  payloadStore,
  dryRun,
  validator,
  latestSnapshot,
  workspaceId,
  evidenceCorrectionIndex,
}) {
  const parentEvidenceId =
    latestSnapshot?.record?.evidence_id && latestSnapshot.record.evidence_id !== snapshotPlan.evidenceId
      ? latestSnapshot.record.evidence_id
      : null;
  const record = buildEvidenceRecord({
    snapshotPlan,
    parentEvidenceId,
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
    if (
      comparison.mismatches.length === 0
      || (parsed.format === "legacy" && isEquivalentLegacyCodexSnapshot(
        comparison.currentRecord,
        comparison.comparableExpected,
        {
          existingMessages: deriveSnapshotMetadata({ record: comparison.currentRecord, catalogRoot: catalog.rootDir }).messages,
          nextMessages: parsed.visibleMessages,
        },
      ))
    ) {
      return {
        status: "skipped_existing",
        record: comparison.currentRecord,
        metadata: deriveSnapshotMetadataFromPayload(snapshotPlan.payload),
      };
    }

    return {
      status: "conflict",
      record,
      mismatches: comparison.mismatches,
    };
  }

  const existingPayloadPath = path.join(payloadStore.rootDir, snapshotPlan.payloadRef);
  if (fs.existsSync(existingPayloadPath)
    && createSha256(fs.readFileSync(existingPayloadPath)) !== snapshotPlan.payloadHash) {
    return { status: "conflict", record, mismatches: ["payload_hash"] };
  }

  if (dryRun) {
    return {
      status: "planned",
      record,
      metadata: deriveSnapshotMetadataFromPayload(snapshotPlan.payload),
    };
  }

  const writeState = { payload: "uncertain", evidence: "not_attempted" };
  let persisted;
  try {
    payloadStore.writePayload({
      evidenceId: snapshotPlan.evidenceId,
      capturedAt: snapshotPlan.capturedAt,
      extension: ".json",
      namespaceSegments: PAYLOAD_NAMESPACE_SEGMENTS,
      bytes: snapshotPlan.payloadBytes,
    });
    writeState.payload = "written";
    writeState.evidence = "uncertain";
    persisted = catalog.writeRecord("evidence", record);
    writeState.evidence = "written";
  } catch (error) {
    error.writeState = writeState;
    throw error;
  }

  return {
    status: "imported",
    record,
    record_file: persisted.filePath,
    metadata: deriveSnapshotMetadataFromPayload(snapshotPlan.payload),
    writeState,
  };
}

function parseCodexRollout({ sourcePath, sourceBytes, sourceStat, sessionIndex = new Map() }) {
  const events = parseRolloutEvents(sourceBytes);
  const sessionMeta = readSessionIdentity(events);
  const threadId = sessionMeta.id;
  const sessionIndexEntry = sessionIndex.get(threadId) ?? null;
  const sourceFilePath = path.resolve(sourcePath);
  const sourceObservedAt = resolveObservedAt({
    sourcePath,
    sourceStat,
  });
  const extracted = extractVisibleMessages(events, threadId);
  const { visibleMessages, finalAnswerCount } = extracted;
  const otherIdentity = events.find(({ event }) => event.type === "session_meta" && event.payload?.id !== threadId);
  if (otherIdentity || sessionMeta.forked_from_id || sessionMeta.parent_thread_id) {
    extracted.coverageStatus = visibleMessages.length > 0 ? "partial" : "unsupported";
    extracted.diagnosticCount += 1;
    extracted.diagnostics.push({ line: otherIdentity?.line ?? 1, code: "inherited_thread_scope_unsupported" });
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
    format: extracted.format,
    coverageStatus: extracted.coverageStatus,
    diagnostics: extracted.diagnostics,
    diagnosticCount: extracted.diagnosticCount,
    projectionCounts: extracted.projectionCounts,
    messageMetadata: extracted.messageMetadata,
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
    ...(parsed.format !== "legacy" ? {
      capture_parser: {
        version: PARSER_VERSION,
        format: parsed.format,
        coverage_status: parsed.coverageStatus,
        projection_counts: parsed.projectionCounts,
      },
      message_metadata: parsed.messageMetadata,
    } : {}),
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

function buildEvidenceRecord({ snapshotPlan, parentEvidenceId, workspaceId = null }) {
  const record = {
    evidence_id: snapshotPlan.evidenceId,
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
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

  for (const [index, line] of fs.readFileSync(filePath, "utf8").split("\n").entries()) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error(`Codex session index has invalid JSON at line ${index + 1}.`);
    }
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

function prepareSelectedSources({ sourceSelection, rolloutFiles }) {
  if (!Array.isArray(sourceSelection) || sourceSelection.length === 0 || sourceSelection.length > 1000) {
    throw new Error("Codex source selection requires between 1 and 1000 entries.");
  }
  const allowed = new Set(rolloutFiles.map((entry) => path.resolve(entry)));
  const selected = new Map();
  for (const [index, entry] of sourceSelection.entries()) {
    if (!entry || typeof entry.path !== "string" || !path.isAbsolute(entry.path)
      || path.resolve(entry.path) !== entry.path || !/^sha256:[a-f0-9]{64}$/.test(entry.sha256 ?? "")
      || !/^[A-Za-z0-9_-]+$/.test(entry.threadId ?? "")) {
      throw new Error(`Codex source selection has an invalid path, hash or thread id at entry ${index + 1}.`);
    }
    if (selected.has(entry.path)) throw new Error(`Codex source selection repeats a path at entry ${index + 1}.`);
    if (!allowed.has(entry.path) || fs.realpathSync(entry.path) !== entry.path) {
      throw new Error(`Codex source selection is missing or outside the enabled source roots at entry ${index + 1}.`);
    }
    const snapshot = readSourceSnapshot(entry.path);
    if (snapshot.sourceHash !== entry.sha256) {
      throw new Error(`Codex source selection hash mismatch at entry ${index + 1}.`);
    }
    const identity = readSessionIdentity(parseRolloutEvents(snapshot.sourceBytes));
    if (identity.id !== entry.threadId) {
      throw new Error(`Codex source selection thread identity mismatch at entry ${index + 1}.`);
    }
    selected.set(entry.path, { ...snapshot, sourcePath: entry.path, threadId: identity.id });
  }
  return selected;
}

function readSourceSnapshot(sourcePath) {
  const descriptor = fs.openSync(sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const sourceStat = fs.fstatSync(descriptor);
    if (!sourceStat.isFile()) throw new Error("Codex rollout source must be a regular file.");
    const sourceBytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (sourceStat.size !== sourceBytes.length || sourceStat.size !== after.size
      || sourceStat.mtimeMs !== after.mtimeMs || sourceStat.ctimeMs !== after.ctimeMs) {
      const error = new Error("Codex rollout changed during source capture.");
      error.code = "source_changed_during_read";
      throw error;
    }
    return { sourceBytes, sourceStat, sourceHash: createSha256(sourceBytes) };
  } finally {
    fs.closeSync(descriptor);
  }
}

function readSessionIdentity(events) {
  const session = events.find(({ event }) => event.type === "session_meta");
  if (!session || typeof session.event.payload?.id !== "string"
    || !/^[A-Za-z0-9_-]+$/.test(session.event.payload.id)) {
    const error = new Error("Codex rollout is missing a supported session identity.");
    error.code = "malformed_rollout";
    error.line = session?.line ?? 1;
    throw error;
  }
  return session.event.payload;
}

function preflightSelectedSources({
  selectedSources, sessionIndex, workspaceRoots, workspaceId, catalog, catalogRoot,
  payloadStore, validator, evidenceCorrectionIndex, latestSnapshots,
}) {
  const latest = new Map(latestSnapshots);
  const identities = new Map();
  const sources = [];
  for (const source of selectedSources.values()) {
    const result = { path: source.sourcePath, thread_id: source.threadId, sha256: source.sourceHash };
    try {
      const parsed = parseCodexRollout({ ...source, sessionIndex });
      source.parsed = parsed;
      result.coverage_status = parsed.coverageStatus;
      result.format = parsed.format;
      const latestSnapshot = latest.get(parsed.sourceLocator) ?? null;
      if (["supported", "no_visible_messages"].includes(parsed.coverageStatus)
        && requiresSnapshotRepair({ parsed, latestSnapshot })) {
        result.status = "repair_required";
        result.coverage_status = "repair_required";
      } else if (parsed.coverageStatus !== "supported") {
        result.status = parsed.coverageStatus === "no_visible_messages"
          ? "skipped_no_visible_messages" : `rejected_${parsed.coverageStatus}`;
        result.diagnostics = parsed.diagnostics;
      } else if (workspaceRoots.length > 0 && !isPathWithinRoots(parsed.cwd, workspaceRoots)) {
        result.status = "skipped_workspace_filter";
        result.coverage_status = "workspace_filtered";
      } else {
        const checkpoint = determineCheckpoint({ parsed, latestSnapshot });
        if (checkpoint.shouldSnapshot) {
          const snapshotPlan = buildSnapshotPlan({ parsed, latestSnapshot, checkpointReason: checkpoint.reason });
          const previous = identities.get(snapshotPlan.evidenceId);
          if (previous && previous !== snapshotPlan.sourceHash) {
            result.status = "conflicts";
            result.coverage_status = "conflict";
          } else {
            identities.set(snapshotPlan.evidenceId, snapshotPlan.sourceHash);
            const outcome = importSingleCodexRollout({
              parsed, snapshotPlan, catalog, payloadStore, dryRun: true, validator,
              latestSnapshot, evidenceCorrectionIndex,
              workspaceId: resolveWorkspaceIdForCodex({ cwd: parsed.cwd, workspaceId, catalogRoot }),
            });
            if (outcome.status === "conflict") {
              result.status = "conflicts";
              result.coverage_status = "conflict";
              result.conflict_fields = outcome.mismatches;
            } else {
              updateLatestSnapshotState(latest, outcome);
            }
          }
        }
        result.status ??= "passed";
      }
    } catch (error) {
      result.status = error.code === "malformed_rollout" ? "rejected_malformed" : "errors";
      result.coverage_status = error.code === "malformed_rollout" ? "malformed" : "error";
      result.code = error.code ?? "preflight_error";
      if (Number.isInteger(error.line)) result.line = error.line;
    }
    sources.push(result);
  }
  return { status: sources.every((source) => source.status === "passed") ? "passed" : "blocked", sources };
}

function createCoverageSummary() {
  return { status: "empty", candidate_rollouts: 0, accounted_rollouts: 0, gap_count: 0, cached_sources: 0,
    source_statuses: {}, formats: {}, gap_details: [] };
}

function recordCoverage(summary, entry) {
  if (!summary._coverageEntries) {
    Object.defineProperty(summary, "_coverageEntries", { value: new Map(), enumerable: false });
  }
  const sourcePath = entry.sourcePath;
  summary._coverageEntries.set(sourcePath, {
    path: sourcePath,
    source_locator: entry.sourceLocator ?? null,
    source_hash: entry.sourceHash ?? null,
    status: entry.outcome,
    coverage_status: entry.status,
    format: entry.format ?? "unknown",
    cached: entry.cached ?? false,
    ...(entry.evidenceId ? { evidence_id: entry.evidenceId } : {}),
    ...(entry.writeState ? { write_state: entry.writeState } : {}),
    ...(entry.diagnosticCount ? { diagnostic_count: entry.diagnosticCount, diagnostics: entry.diagnostics } : {}),
    ...(entry.projectionCounts ? { projection_counts: entry.projectionCounts } : {}),
  });
}

function finalizeCoverage(summary) {
  const entries = [...(summary._coverageEntries?.values() ?? [])];
  const coverage = createCoverageSummary();
  coverage.candidate_rollouts = summary.candidate_rollouts;
  coverage.accounted_rollouts = entries.length;
  for (const entry of entries) {
    coverage.source_statuses[entry.coverage_status] = (coverage.source_statuses[entry.coverage_status] ?? 0) + 1;
    coverage.formats[entry.format] = (coverage.formats[entry.format] ?? 0) + 1;
    if (entry.cached) coverage.cached_sources += 1;
    if (!["supported", "workspace_filtered"].includes(entry.coverage_status) || entry.status === "not_attempted") {
      coverage.gap_count += 1;
      pushCapped(coverage.gap_details, entry);
    }
  }
  coverage.status = summary.candidate_rollouts === 0 ? "empty"
    : coverage.gap_count > 0 || entries.length !== summary.candidate_rollouts ? "partial" : "complete";
  summary.coverage = coverage;
  if (summary.source_results) summary.source_results = entries;
}

function normalizeWorkspaceRoots(value) {
  if (value == null || value === "") {
    return [];
  }

  const roots = Array.isArray(value) ? value : [value];
  return [...new Set(
    roots
      .filter((entry) => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => path.resolve(entry)),
  )];
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
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
  } catch {
    throw new Error("Codex existing snapshot payload could not be read as JSON.");
  }
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
    messages,
  };
}

function requiresSnapshotRepair({ parsed, latestSnapshot }) {
  if (!latestSnapshot) return false;
  const oldMessages = latestSnapshot.metadata.messages;
  const sameSource = parsed.sourceHash === latestSnapshot.record.source_hash;
  const sameOrEarlierCheckpoint = new Date(parsed.lastVisibleMessageAt).getTime()
    <= new Date(latestSnapshot.record.captured_at).getTime();
  if (!sameSource && !sameOrEarlierCheckpoint) return false;
  return !haveSameVisibleMessages(oldMessages, parsed.visibleMessages);
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

function isEquivalentLegacyCodexSnapshot(existingRecord, nextRecord, { existingMessages, nextMessages } = {}) {
  return (
    existingRecord.evidence_id === nextRecord.evidence_id &&
    normalizeComparableValue(existingRecord.workspace_id) === normalizeComparableValue(nextRecord.workspace_id) &&
    existingRecord.source_type === "chat" &&
    nextRecord.source_type === "chat" &&
    existingRecord.substrate_ref === nextRecord.substrate_ref &&
    existingRecord.source_locator === nextRecord.source_locator &&
    existingRecord.captured_at === nextRecord.captured_at &&
    existingRecord.source_hash === nextRecord.source_hash &&
    haveSameVisibleMessages(existingMessages, nextMessages)
  );
}

function haveSameVisibleMessages(existingMessages, nextMessages) {
  return Array.isArray(existingMessages) && Array.isArray(nextMessages)
    && JSON.stringify(existingMessages) === JSON.stringify(nextMessages);
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
  normalizeWorkspaceRoots,
  resolveDefaultCodexRoot,
};
