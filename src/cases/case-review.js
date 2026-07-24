const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { CaseAmendmentPacketStore } = require("./amendment-packet-store");
const { CaseBoundaryRecoveryPacketStore } = require("./boundary-recovery-packet-store");
const { CaseCompletionPacketStore } = require("./completion-packet-store");
const { CasePacketStore } = require("./staging-packet-store");
const {
  assertCaseRevision,
  explainCaseCompleteness,
  hasCompleteCaseFraming,
  isResolvedBoundaryText,
} = require("../lifecycle/rules");
const { ReviewWorkflow } = require("../review/workflow");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { EcitrValidator, readJson } = require("../validation/validator");
const { REPO_ROOT } = require("../validation/schema-registry");

const DEFAULT_CATALOG_ROOT = path.join(REPO_ROOT, ".local", "catalog");

class CaseReviewSurface {
  constructor({
    catalogRoot = DEFAULT_CATALOG_ROOT,
    validator = new EcitrValidator(),
    catalog = new FileBackedCatalog({ rootDir: catalogRoot, validator }),
    packetStore = new CasePacketStore({ rootDir: catalogRoot, validator }),
    boundaryRecoveryStore = new CaseBoundaryRecoveryPacketStore({ rootDir: catalogRoot, validator }),
    amendmentStore = new CaseAmendmentPacketStore({ rootDir: catalogRoot, validator }),
    completionStore = new CaseCompletionPacketStore({ rootDir: catalogRoot, validator }),
    reviewWorkflow = new ReviewWorkflow({ validator }),
  } = {}) {
    this.catalogRoot = path.resolve(catalogRoot);
    this.validator = validator;
    this.catalog = catalog;
    this.packetStore = packetStore;
    this.boundaryRecoveryStore = boundaryRecoveryStore;
    this.amendmentStore = amendmentStore;
    this.completionStore = completionStore;
    this.reviewWorkflow = reviewWorkflow;
  }

  listPendingCases({ limit = 25, reviewState, status = "draft", workspaceId } = {}) {
    let records = this.catalog.listRecords("case").filter((record) => record.status === status);
    if (workspaceId) {
      records = records.filter((record) => record.workspace_id === workspaceId);
    }
    if (reviewState) {
      records = records.filter((record) => record.review_state === reviewState);
    }

    records.sort(compareCasesForReview);

    return {
      workspace_id: workspaceId ?? null,
      total_pending: records.length,
      returned: records.slice(0, limit).length,
      cases: records.slice(0, limit).map(toCaseQueueItem),
    };
  }

  inspectCase(caseId) {
    const caseRecord = this.catalog.getRecord("case", caseId);
    if (!caseRecord) {
      throw new Error(`Unknown case: ${caseId}`);
    }

    const packet = this.findPacketForCase(caseId);
    const evidence = (caseRecord.evidence_refs ?? [])
      .map((evidenceId) => this.catalog.getRecord("evidence", evidenceId))
      .filter(Boolean)
      .map((record) => ({
        evidence_id: record.evidence_id,
        source_type: record.source_type,
        source_locator: record.source_locator,
        captured_at: record.captured_at,
      }));

    return {
      case: caseRecord,
      packet,
      boundary_recoveries: this.boundaryRecoveryStore.listPacketsForCase(caseId),
      completions: this.completionStore.listPacketsForCase(caseId),
      amendments: this.amendmentStore.listPacketsForCase(caseId),
      evidence,
      review_readiness: evaluateCaseReadiness(caseRecord),
    };
  }

  completeDraft({
    caseId,
    reviewer,
    rationale,
    amendedAt,
    preparedAt = amendedAt,
    preparedBy = "case-completion-bounded-v1",
    strategyId = "bounded-case-completion-template-v1",
    baseCaseVersion,
    dryRun = false,
  }) {
    const caseRecord = this.catalog.getRecord("case", caseId);
    if (!caseRecord) {
      throw new Error(`Unknown case: ${caseId}`);
    }
    if (caseRecord.status !== "draft") {
      throw new Error(`Only draft cases may be completed: ${caseId}`);
    }

    const evidenceRecords = (caseRecord.evidence_refs ?? [])
      .map((evidenceId) => this.catalog.getRecord("evidence", evidenceId))
      .filter(Boolean);
    if (evidenceRecords.length === 0) {
      throw new Error(`Draft case ${caseId} has no retrievable evidence records.`);
    }

    let recoveryPacket = null;
    let completionPacket;
    try {
      completionPacket = buildCaseCompletionPacket({
        caseRecord,
        evidenceRecords,
        catalogRoot: this.catalogRoot,
        preparedAt,
        preparedBy,
        strategyId,
      });
    } catch (error) {
      if (!String(error.message).includes("produced no bounded boundaries for completion")) {
        throw error;
      }

      recoveryPacket = buildCaseBoundaryRecoveryPacket({
        caseRecord,
        evidenceRecords,
        catalogRoot: this.catalogRoot,
        recoveredAt: preparedAt,
        recoveredBy: "case-boundary-recovery-v1",
        strategyId: "legacy-boundary-recovery-v1",
      });

      completionPacket = buildCaseCompletionPacket({
        caseRecord,
        evidenceRecords,
        catalogRoot: this.catalogRoot,
        preparedAt,
        preparedBy,
        strategyId,
        recoveryPacket,
      });
    }
    this.validator.validateRecord("case_completion_packet", completionPacket);
    validateCompletionSuggestion(completionPacket);

    const changes = {
      applicability: {
        when_to_apply: completionPacket.suggested_applicability.when_to_apply.map((line) => line.text),
        when_not_to_apply: completionPacket.suggested_applicability.when_not_to_apply.map((line) => line.text),
      },
      open_questions: [],
    };
    if (
      recoveryPacket &&
      splitStructuredLines(caseRecord.failure_mode).length === 0 &&
      recoveryPacket.suggested_failure_mode?.text
    ) {
      changes.failure_mode = recoveryPacket.suggested_failure_mode.text;
    }

    const amendmentPacket = {
      amendment_id: createAmendmentId(caseId, amendedAt),
      case_id: caseId,
      completion_id: completionPacket.completion_id,
      base_case_version: baseCaseVersion ?? caseRecord.case_version,
      reviewer,
      rationale,
      amended_at: amendedAt,
      changes,
    };
    this.validator.validateRecord("case_amendment_packet", amendmentPacket);

    const nextRecord = applyCaseAmendment(caseRecord, amendmentPacket);
    assertCaseRevision(caseRecord, nextRecord);

    if (dryRun) {
      return {
        dry_run: true,
        recoveryPacket,
        completionPacket,
        amendmentPacket,
        nextRecord,
        review_readiness: evaluateCaseReadiness(nextRecord),
      };
    }

    const recoveryWrite = recoveryPacket ? this.boundaryRecoveryStore.writePacket(recoveryPacket) : null;
    const completionWrite = this.completionStore.writePacket(completionPacket);
    const amendmentWrite = this.amendmentStore.writePacket(amendmentPacket);
    const recordWrite = this.catalog.writeRecord("case", nextRecord, { overwrite: true });

    return {
      dry_run: false,
      recoveryPacket,
      completionPacket,
      amendmentPacket,
      nextRecord,
      review_readiness: evaluateCaseReadiness(nextRecord),
      recoveryWrite,
      completionWrite,
      amendmentWrite,
      recordWrite,
    };
  }

  amendDraft({ caseId, changes, reviewer, rationale, amendedAt, baseCaseVersion, dryRun = false }) {
    const caseRecord = this.catalog.getRecord("case", caseId);
    if (!caseRecord) {
      throw new Error(`Unknown case: ${caseId}`);
    }
    if (caseRecord.status !== "draft") {
      throw new Error(`Only draft cases may be amended: ${caseId}`);
    }

    const amendmentPacket = {
      amendment_id: createAmendmentId(caseId, amendedAt),
      case_id: caseId,
      base_case_version: baseCaseVersion ?? caseRecord.case_version,
      reviewer,
      rationale,
      amended_at: amendedAt,
      changes,
    };
    this.validator.validateRecord("case_amendment_packet", amendmentPacket);

    const nextRecord = applyCaseAmendment(caseRecord, amendmentPacket);
    assertCaseRevision(caseRecord, nextRecord);

    if (dryRun) {
      return {
        dry_run: true,
        amendmentPacket,
        nextRecord,
        review_readiness: evaluateCaseReadiness(nextRecord),
      };
    }

    const packetWrite = this.amendmentStore.writePacket(amendmentPacket);
    const recordWrite = this.catalog.writeRecord("case", nextRecord, { overwrite: true });

    return {
      dry_run: false,
      amendmentPacket,
      nextRecord,
      review_readiness: evaluateCaseReadiness(nextRecord),
      packetWrite,
      recordWrite,
    };
  }

  applyDecision({ caseId, decision, reviewer, rationale, reviewedAt, dryRun = false }) {
    const caseRecord = this.catalog.getRecord("case", caseId);
    if (!caseRecord) {
      throw new Error(`Unknown case: ${caseId}`);
    }

    const decisionPacket = {
      decision_id: createDecisionId(caseId, decision, reviewedAt),
      record_type: "case",
      record_id: caseId,
      decision,
      reviewer,
      rationale,
      reviewed_at: reviewedAt,
    };

    const readiness = evaluateCaseReadiness(caseRecord);
    if (decision === "approve" && !readiness.approval_ready) {
      const error = new Error(`Case ${caseId} is not approval-ready: ${readiness.reasons.join("; ")}`);
      error.readiness = readiness;
      throw error;
    }

    const { nextRecord, auditEntry } = this.reviewWorkflow.applyDecision({
      recordType: "case",
      record: caseRecord,
      decisionPacket,
    });

    if (dryRun) {
      return {
        dry_run: true,
        nextRecord,
        auditEntry,
      };
    }

    const recordWrite = this.catalog.writeRecord("case", nextRecord, { overwrite: true });
    const auditWrite = this.catalog.writeRecord("review_audit_entry", auditEntry);

    return {
      dry_run: false,
      nextRecord,
      auditEntry,
      recordWrite,
      auditWrite,
    };
  }

  findPacketForCase(caseId) {
    const stagingDir = path.join(this.catalogRoot, "staging", "case-compilation-packets");
    if (!fs.existsSync(stagingDir)) {
      return null;
    }

    for (const entry of fs.readdirSync(stagingDir).filter((value) => value.endsWith(".json")).sort()) {
      const packet = readJson(path.join(stagingDir, entry));
      if (packet.proposed_case_id === caseId) {
        return packet;
      }
    }

    return null;
  }
}

function compareCasesForReview(left, right) {
  const leftQuestions = (left.open_questions ?? []).length;
  const rightQuestions = (right.open_questions ?? []).length;
  if (leftQuestions !== rightQuestions) {
    return leftQuestions - rightQuestions;
  }

  const leftTime = Date.parse(left.derived_at ?? 0);
  const rightTime = Date.parse(right.derived_at ?? 0);
  return leftTime - rightTime;
}

function toCaseQueueItem(record) {
  const readiness = evaluateCaseReadiness(record);
  return {
    case_id: record.case_id,
    review_state: record.review_state,
    derived_at: record.derived_at,
    confidence: record.confidence,
    evidence_refs: record.evidence_refs,
    open_question_count: (record.open_questions ?? []).length,
    approval_ready: readiness.approval_ready,
    problem_statement: record.problem_statement ?? null,
  };
}

function evaluateCaseReadiness(record) {
  const reasons = explainCaseCompleteness(record);
  return {
    approval_ready: hasCompleteCaseFraming(record) && reasons.length === 0,
    reasons,
  };
}

function createDecisionId(caseId, decision, reviewedAt) {
  const suffix = String(reviewedAt).replaceAll(/[^0-9TZ]/g, "").replaceAll(":", "").replaceAll("-", "");
  return `review_${caseId}_${decision}_${suffix}`;
}

function createAmendmentId(caseId, amendedAt) {
  const suffix = String(amendedAt).replaceAll(/[^0-9TZ]/g, "").replaceAll(":", "").replaceAll("-", "");
  const digest = crypto.createHash("sha1").update(`${caseId}:${amendedAt}`).digest("hex").slice(0, 10);
  return `cam_${caseId}_${suffix}_${digest}`;
}

function applyCaseAmendment(caseRecord, amendmentPacket) {
  if (amendmentPacket.case_id !== caseRecord.case_id) {
    throw new Error(`Amendment targets ${amendmentPacket.case_id} but record is ${caseRecord.case_id}`);
  }

  if (amendmentPacket.base_case_version !== caseRecord.case_version) {
    throw new Error(
      `Amendment expects base case_version ${amendmentPacket.base_case_version} but current record is ${caseRecord.case_version}`,
    );
  }

  const nextRecord = {
    ...caseRecord,
    ...structuredClone(amendmentPacket.changes),
    case_version: caseRecord.case_version + 1,
    review_state: "draft",
    derived_at: amendmentPacket.amended_at,
  };

  return nextRecord;
}

function buildCaseCompletionPacket({
  caseRecord,
  evidenceRecords,
  catalogRoot,
  preparedAt,
  preparedBy,
  strategyId,
  recoveryPacket = null,
}) {
  const facts = [];
  const boundaries = [];
  const seenTexts = new Set();

  pushSupportItem(facts, seenTexts, {
    caseId: caseRecord.case_id,
    lane: "fact",
    index: facts.length,
    text: caseRecord.problem_statement,
    evidenceRef: caseRecord.evidence_refs?.[0],
    sourceKind: "case",
    sourceField: "problem_statement",
  });

  for (const [failureIndex, failureLine] of splitStructuredLines(caseRecord.failure_mode).entries()) {
    pushSupportItem(boundaries, seenTexts, {
      caseId: caseRecord.case_id,
      lane: "boundary",
      index: boundaries.length,
      text: failureLine,
      evidenceRef: caseRecord.evidence_refs?.[0],
      sourceKind: "case",
      sourceField: `failure_mode[${failureIndex}]`,
    });
  }

  for (const [constraintIndex, constraint] of (caseRecord.context?.constraints ?? []).entries()) {
    pushSupportItem(boundaries, seenTexts, {
      caseId: caseRecord.case_id,
      lane: "boundary",
      index: boundaries.length,
      text: constraint,
      evidenceRef: caseRecord.evidence_refs?.[0],
      sourceKind: "case",
      sourceField: `context.constraints[${constraintIndex}]`,
    });
  }

  for (const evidenceRecord of evidenceRecords) {
    const payload = loadEvidencePayload(evidenceRecord, { catalogRoot });
    if (!payload || typeof payload !== "object") {
      continue;
    }

    pushSupportItem(facts, seenTexts, {
      caseId: caseRecord.case_id,
      lane: "fact",
      index: facts.length,
      text: payload.objective,
      evidenceRef: evidenceRecord.evidence_id,
      sourceKind: "evidence_payload",
      sourceField: "objective",
    });

    for (const [stepIndex, step] of normalizeStringArray(payload.steps_completed).entries()) {
      pushSupportItem(facts, seenTexts, {
        caseId: caseRecord.case_id,
        lane: "fact",
        index: facts.length,
        text: step,
        evidenceRef: evidenceRecord.evidence_id,
        sourceKind: "evidence_payload",
        sourceField: `steps_completed[${stepIndex}]`,
      });
    }

    for (const [findingIndex, finding] of normalizeStringArray(payload.findings).entries()) {
      pushSupportItem(facts, seenTexts, {
        caseId: caseRecord.case_id,
        lane: "fact",
        index: facts.length,
        text: finding,
        evidenceRef: evidenceRecord.evidence_id,
        sourceKind: "evidence_payload",
        sourceField: `findings[${findingIndex}]`,
      });
    }

    for (const [blockerIndex, blocker] of normalizeStringArray(payload.blockers).entries()) {
      pushSupportItem(boundaries, seenTexts, {
        caseId: caseRecord.case_id,
        lane: "boundary",
        index: boundaries.length,
        text: blocker,
        evidenceRef: evidenceRecord.evidence_id,
        sourceKind: "evidence_payload",
        sourceField: `blockers[${blockerIndex}]`,
      });
    }
  }

  if (recoveryPacket) {
    for (const recoveredBoundary of recoveryPacket.candidate_boundaries ?? []) {
      pushExistingSupportItem(boundaries, seenTexts, recoveredBoundary, "boundary");
    }
  }

  if (facts.length === 0) {
    throw new Error(`Case ${caseRecord.case_id} produced no bounded facts for completion.`);
  }
  const boundedBoundaries = boundaries.filter((entry) => !isProcessOnlyBoundaryText(entry.text));
  if (boundedBoundaries.length === 0) {
    throw new Error(`Case ${caseRecord.case_id} produced no bounded boundaries for completion.`);
  }

  const suggestedApplicability = buildSuggestedApplicability({ caseRecord, facts, boundaries: boundedBoundaries });

  return {
    completion_id: createCompletionId(caseRecord.case_id, preparedAt),
    case_id: caseRecord.case_id,
    base_case_version: caseRecord.case_version,
    evidence_refs: caseRecord.evidence_refs,
    prepared_at: preparedAt,
    prepared_by: preparedBy,
    strategy_id: strategyId,
    open_questions: structuredClone(caseRecord.open_questions ?? []),
    facts,
    boundaries: boundedBoundaries,
    suggested_applicability: suggestedApplicability,
  };
}

function buildCaseBoundaryRecoveryPacket({
  caseRecord,
  evidenceRecords,
  catalogRoot,
  recoveredAt,
  recoveredBy,
  strategyId,
}) {
  const candidates = [];
  const seenTexts = new Set();

  for (const evidenceRecord of evidenceRecords) {
    const payload = loadEvidencePayload(evidenceRecord, { catalogRoot });
    if (!payload || typeof payload !== "object") {
      continue;
    }

    for (const [blockerIndex, blocker] of normalizeStringArray(payload.blockers).entries()) {
      pushSupportItem(candidates, seenTexts, {
        caseId: caseRecord.case_id,
        lane: "boundary",
        index: candidates.length,
        text: blocker,
        evidenceRef: evidenceRecord.evidence_id,
        sourceKind: "evidence_payload",
        sourceField: `blockers[${blockerIndex}]`,
      });
    }

    for (const [findingIndex, finding] of normalizeStringArray(payload.findings).entries()) {
      if (!looksLikeRecoverableBoundaryText(finding)) {
        continue;
      }
      pushSupportItem(candidates, seenTexts, {
        caseId: caseRecord.case_id,
        lane: "boundary",
        index: candidates.length,
        text: finding,
        evidenceRef: evidenceRecord.evidence_id,
        sourceKind: "evidence_payload",
        sourceField: `findings[${findingIndex}]`,
      });
    }

  }

  const boundedCandidates = candidates.filter(
    (entry) => !isResolvedBoundaryText(entry.text) && !isProcessOnlyBoundaryText(entry.text),
  );
  if (boundedCandidates.length === 0) {
    throw new Error(`Case ${caseRecord.case_id} produced no bounded boundaries for completion.`);
  }

  return {
    recovery_id: createRecoveryId(caseRecord.case_id, recoveredAt),
    case_id: caseRecord.case_id,
    base_case_version: caseRecord.case_version,
    evidence_refs: caseRecord.evidence_refs,
    recovered_at: recoveredAt,
    recovered_by: recoveredBy,
    strategy_id: strategyId,
    candidate_boundaries: boundedCandidates,
    suggested_failure_mode: {
      text: boundedCandidates[0].text,
      support_refs: [boundedCandidates[0].support_id],
    },
  };
}

function buildSuggestedApplicability({ caseRecord, facts, boundaries }) {
  const primaryFact = facts[0];
  const substantiveBoundaries = boundaries.filter(
    (entry) => !isResolvedBoundaryText(entry.text) && !isProcessOnlyBoundaryText(entry.text),
  );
  const primaryBoundaries = (substantiveBoundaries.length > 0 ? substantiveBoundaries : boundaries).slice(0, 2);
  const actionLine = selectPrimaryActionLine(caseRecord.action_taken);
  const outcomeLine = firstStructuredLine(caseRecord.outcome);
  const boundarySummary = primaryBoundaries.map((entry) => entry.text).join(" ; ");

  const whenToApply = [
    {
      text: `When the operator needs to execute the same kind of intervention captured here: ${actionLine || primaryFact.text}`,
      support_refs: [primaryFact.support_id],
    },
    {
      text: `When the expected operating conditions still match this record, especially these decisive boundaries: ${boundarySummary}`,
      support_refs: primaryBoundaries.map((entry) => entry.support_id),
    },
  ];

  const whenNotToApply = [
    {
      text: `Do not apply this case once the decisive blocker or constraint has already been removed: ${primaryBoundaries[0]?.text ?? boundarySummary}`,
      support_refs: primaryBoundaries.map((entry) => entry.support_id),
    },
    {
      text: `Do not apply this case when the current workflow aims at a materially different outcome than the one achieved here: ${outcomeLine || primaryFact.text}`,
      support_refs: primaryBoundaries.map((entry) => entry.support_id),
    },
  ];

  return {
    when_to_apply: whenToApply,
    when_not_to_apply: whenNotToApply,
  };
}

function validateCompletionSuggestion(packet) {
  const supportIds = new Set([
    ...packet.facts.map((item) => item.support_id),
    ...packet.boundaries.map((item) => item.support_id),
  ]);
  const boundaryIds = new Set(packet.boundaries.map((item) => item.support_id));

  for (const line of packet.suggested_applicability.when_to_apply) {
    validateSuggestedLine(line, supportIds);
  }

  for (const line of packet.suggested_applicability.when_not_to_apply) {
    validateSuggestedLine(line, supportIds);
    if (!line.support_refs.some((supportId) => boundaryIds.has(supportId))) {
      throw new Error("when_not_to_apply lines must cite at least one extracted boundary.");
    }
  }
}

function validateSuggestedLine(line, supportIds) {
  if (!Array.isArray(line.support_refs) || line.support_refs.length === 0) {
    throw new Error("Suggested applicability lines must carry support refs.");
  }

  for (const supportId of line.support_refs) {
    if (!supportIds.has(supportId)) {
      throw new Error(`Suggested applicability line cites unknown support ref: ${supportId}`);
    }
  }
}

function pushExistingSupportItem(target, seenTexts, item, lane) {
  if (!item || typeof item.text !== "string") {
    return;
  }
  const normalizedText = item.text.trim();
  if (!normalizedText) {
    return;
  }
  const dedupeKey = `${lane}:${normalizedText.toLowerCase()}`;
  if (seenTexts.has(dedupeKey)) {
    return;
  }
  seenTexts.add(dedupeKey);
  target.push(structuredClone(item));
}

function firstStructuredLine(value) {
  return splitStructuredLines(value)[0] ?? null;
}

function selectPrimaryActionLine(value) {
  const lines = splitStructuredLines(value);
  const substantive = lines.find((line) => isStrongInterventionActionLine(line));
  if (substantive) {
    return substantive;
  }
  const nonWeak = lines.find(
    (line) => !isIncidentalActionLine(line) && !isWeakAnalyticalActionLine(line),
  );
  if (nonWeak) {
    return nonWeak;
  }
  return lines.find((line) => !isIncidentalActionLine(line)) ?? null;
}

function isIncidentalActionLine(line) {
  const normalized = String(line).trim().toLowerCase();
  return [
    "opened agent-ops memory",
    "opened agent memory session",
    "opened a memory session",
    "opened a fresh",
    "opened memory session",
    "opened the required memory session",
    "opened a new memory session",
    "opened project memory",
    "inspected the local",
    "inspected local",
    "registered the workspace",
    "registered /users/",
    "checked reasoning baseline",
    "checked the configured reasoning baseline",
    "loaded reasoning-advisor",
    "loaded reasoning advisor",
    "read the mandatory repo documents",
    "read repository deployment notes",
    "read the canonical workflow",
    "re-read the repository doctrine",
    "reviewed the current",
    "queried official microsoft learn docs",
    "re-read the mandatory repo doctrine",
    "re-read the mandatory repo doctrine documents",
    "enumerated available azure subscriptions",
    "confirmed azure login under",
    "started the wa mailer next.js dev server",
    "located the airtable token",
    "wrote the required airtable variables",
    "wrote airtable variables",
    "verified existing",
    "verified direct ssh access",
    "confirmed the desktop terminal",
    "inspected git status",
    "inspected git graph",
    "created a gmail draft",
    "added a github issue comment",
    "recorded in github issue",
    "recorded the operator hosting direction",
    "recorded that the provider confirmation request",
    "created a second external evidence directory",
    "created an external evidence directory",
    "created a gmail draft",
    "recorded provider capability confirmation",
    "grouped available runs and sessions",
    "confirmed the ecitr permanent evidence catalog",
    "reviewed the frontend skill guidance",
    "reviewed the local next.js",
    "inspected representative run",
    "inspected the orders page and global styles",
    "attempted to access chatgpt.com",
    "created a clean temporary worktree",
    "built the app successfully with the real .env.local",
    "created policy-level documents",
  ].some((pattern) => normalized.startsWith(pattern));
}

function isWeakAnalyticalActionLine(line) {
  const normalized = String(line).trim().toLowerCase();
  return [
    "read ",
    "re-read ",
    "reviewed ",
    "compared ",
    "inspected ",
    "detected that port",
    "created a canonical",
    "added phase 2 governance artifacts",
    "updated the target architecture",
    "updated target architecture",
  ].some((pattern) => normalized.startsWith(pattern));
}

function looksLikeRecoverableBoundaryText(line) {
  const normalized = normalizeBoundaryCandidate(line);
  if (!normalized) {
    return false;
  }
  if (isResolvedBoundaryText(normalized) || isProcessOnlyBoundaryText(normalized)) {
    return false;
  }
  return [
    "missing ",
    "cannot ",
    "can't ",
    "unable ",
    "blocked ",
    "depend",
    "depends ",
    "until ",
    "without ",
    "unknown ",
    "awaiting ",
    "not yet ",
    "has not ",
    "have not ",
    "pending ",
    "fails ",
  ].some((pattern) => normalized.includes(pattern));
}

function normalizeBoundaryCandidate(line) {
  return typeof line === "string" ? line.trim().toLowerCase() : "";
}

function isStrongInterventionActionLine(line) {
  const normalized = String(line).trim().toLowerCase();
  if (isIncidentalActionLine(normalized) || isWeakAnalyticalActionLine(normalized)) {
    return false;
  }

  const blockedTargets = [
    "runbook",
    "runbooks",
    "checklist",
    "checklists",
    "governance",
    "target architecture",
    "state governance",
    "github issue",
    "issues",
    "docs/",
    "doctrine",
    "notes",
    "note ",
    "recommendation",
    "recommendations",
    "tracker",
    "morning review",
    "live corpus",
    "session/run/draft health",
    "test suite",
    "smoke check",
    "smoke validation",
  ];
  if (blockedTargets.some((pattern) => normalized.includes(pattern))) {
    return false;
  }

  return [
    "added ",
    "expanded ",
    "patched ",
    "replaced ",
    "removed ",
    "set ",
    "enabled ",
    "deployed ",
    "implemented ",
    "extended ",
    "created ",
    "generated ",
    "changed ",
    "refactored ",
    "exported ",
    "introduced ",
    "imported ",
    "uploaded ",
    "replayed ",
    "reproduced ",
    "executed ",
    "queried ",
    "collected ",
    "captured ",
    "fetched ",
    "preserved ",
    "provisioned ",
    "initialized ",
    "installed ",
    "configured ",
    "scaffolded ",
    "built ",
    "ran ",
    "backed up ",
    "bumped ",
    "created resource group",
    "created application insights",
    "created a private git",
    "created a local ignored .env",
    "created a repo-level agents.md",
    "updated the runtime contract",
    "wrote a project policy record",
    "updated the global codex agents file",
    "created an external evidence directory",
    "created a second external evidence directory",
  ].some((pattern) => normalized.startsWith(pattern));
}

function isProcessOnlyBoundaryText(value) {
  const normalized = String(value).trim().toLowerCase();
  return [
    "not against a deployed production url",
    "have not been deployed in this thread",
    "has not been deployed in this thread",
    "not been deployed in this thread",
  ].some((pattern) => normalized.includes(pattern));
}

function pushSupportItem(target, seenTexts, { caseId, lane, index, text, evidenceRef, sourceKind, sourceField }) {
  if (typeof text !== "string" || text.trim().length === 0 || !evidenceRef) {
    return;
  }

  const normalizedText = text.trim();
  const dedupeKey = `${lane}:${normalizedText.toLowerCase()}`;
  if (seenTexts.has(dedupeKey)) {
    return;
  }
  seenTexts.add(dedupeKey);

  target.push({
    support_id: createSupportId(caseId, lane, index),
    text: normalizedText,
    evidence_ref: evidenceRef,
    source_kind: sourceKind,
    source_field: sourceField,
  });
}

function splitStructuredLines(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }

  return value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/^\d+\.\s*/, "").trim())
    .filter(Boolean);
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry) => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
}

function loadEvidencePayload(evidenceRecord, { catalogRoot }) {
  const payloadPath = resolvePayloadPath(evidenceRecord, { catalogRoot });
  if (!payloadPath) {
    throw new Error("Evidence payload path could not be resolved.");
  }

  return JSON.parse(fs.readFileSync(payloadPath, "utf8"));
}

function resolvePayloadPath(evidenceRecord, { catalogRoot }) {
  if (!evidenceRecord.verbatim_payload_ref) {
    return null;
  }

  if (path.isAbsolute(evidenceRecord.verbatim_payload_ref)) {
    return evidenceRecord.verbatim_payload_ref;
  }

  return path.resolve(catalogRoot, evidenceRecord.verbatim_payload_ref);
}

function createCompletionId(caseId, preparedAt) {
  const suffix = String(preparedAt).replaceAll(/[^0-9TZ]/g, "").replaceAll(":", "").replaceAll("-", "");
  const digest = crypto.createHash("sha1").update(`${caseId}:${preparedAt}:completion`).digest("hex").slice(0, 10);
  return `ccx_${caseId}_${suffix}_${digest}`;
}

function createRecoveryId(caseId, recoveredAt) {
  const suffix = String(recoveredAt).replaceAll(/[^0-9TZ]/g, "").replaceAll(":", "").replaceAll("-", "");
  const digest = crypto.createHash("sha1").update(`${caseId}:${recoveredAt}:recovery`).digest("hex").slice(0, 10);
  return `crx_${caseId}_${suffix}_${digest}`;
}

function createSupportId(caseId, lane, index) {
  const digest = crypto.createHash("sha1").update(`${caseId}:${lane}:${index}`).digest("hex").slice(0, 12);
  return `sup_${digest}`;
}

module.exports = {
  CaseReviewSurface,
  applyCaseAmendment,
  buildCaseBoundaryRecoveryPacket,
  buildCaseCompletionPacket,
  compareCasesForReview,
  createCompletionId,
  createRecoveryId,
  createAmendmentId,
  createDecisionId,
  evaluateCaseReadiness,
  validateCompletionSuggestion,
  toCaseQueueItem,
};
