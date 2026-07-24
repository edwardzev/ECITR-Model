const path = require("node:path");
const crypto = require("node:crypto");

const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const { assertLifecycleRecord } = require("../lifecycle/rules");
const { ReviewWorkflow } = require("../review/workflow");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { EcitrValidator } = require("../validation/validator");
const { TacticDiscoverySurface } = require("./discovery");
const { TacticPromotionPipeline } = require("./promotion");
const { TacticPromotionPacketStore } = require("./promotion-packet-store");
const { TacticRevalidationPacketStore } = require("./revalidation-packet-store");

class TacticReviewSurface {
  constructor({
    catalogRoot = DEFAULT_CATALOG_ROOT,
    validator = new EcitrValidator(),
    discovery = new TacticDiscoverySurface({ catalogRoot, validator }),
    pipeline = new TacticPromotionPipeline({ validator }),
    reviewWorkflow = new ReviewWorkflow({ validator }),
    packetStore = new TacticPromotionPacketStore({ rootDir: catalogRoot, validator }),
    revalidationStore = new TacticRevalidationPacketStore({ rootDir: catalogRoot, validator }),
  } = {}) {
    this.catalogRoot = path.resolve(catalogRoot);
    this.validator = validator;
    this.catalog = new FileBackedCatalog({ rootDir: this.catalogRoot, validator });
    this.discovery = discovery;
    this.pipeline = pipeline;
    this.reviewWorkflow = reviewWorkflow;
    this.packetStore = packetStore;
    this.revalidationStore = revalidationStore;
  }

  inspectTactic(tacticId) {
    const record = this.catalog.getRecord("tactic", tacticId);
    const packet = record?.id
      ? this.packetStore.listPackets().find((candidate) => candidate.proposed_tactic_id === record.id) ?? null
      : null;

    return {
      tactic: record,
      staged_promotion_packet: packet,
      revalidations: record?.id ? this.revalidationStore.listPacketsForTactic(record.id) : [],
    };
  }

  revalidateTactic({
    tacticId,
    reviewer,
    rationale,
    reviewedAt,
    revalidateAt,
    validatedOn,
    dryRun = false,
  }) {
    const record = this.catalog.getRecord("tactic", tacticId);
    if (!record) {
      throw new Error(`Unknown tactic: ${tacticId}`);
    }
    if (record.status !== "active") {
      throw new Error(`Only active tactics may be revalidated: ${tacticId}`);
    }
    if (!reviewer) {
      throw new Error("revalidateTactic requires a reviewer.");
    }
    if (!rationale) {
      throw new Error("revalidateTactic requires a rationale.");
    }
    if (!Array.isArray(validatedOn) || validatedOn.length === 0) {
      throw new Error("revalidateTactic requires at least one validated_on entry.");
    }
    if (!record.revalidate_at) {
      throw new Error(`Tactic ${tacticId} has no revalidate_at boundary to extend.`);
    }

    const reviewedMs = requireValidTimestamp("reviewedAt", reviewedAt);
    const nextRevalidateMs = requireValidTimestamp("revalidateAt", revalidateAt);
    if (nextRevalidateMs <= reviewedMs) {
      throw new Error("revalidateAt must be later than reviewedAt.");
    }
    if (record.expiry_at && requireValidTimestamp("tactic expiry_at", record.expiry_at) <= reviewedMs) {
      throw new Error(`Expired tactic ${tacticId} must be deprecated or superseded, not revalidated.`);
    }
    if (Array.isArray(record.invalidated_by) && record.invalidated_by.length > 0) {
      throw new Error(`Invalidated tactic ${tacticId} must be deprecated or superseded, not revalidated.`);
    }

    const sourceCaseRefs = uniqueStrings(record.source_case_refs);
    if (sourceCaseRefs.length === 0) {
      throw new Error(`Tactic ${tacticId} has no source cases to revalidate.`);
    }
    for (const caseId of sourceCaseRefs) {
      const sourceCase = this.catalog.getRecord("case", caseId);
      if (!sourceCase) {
        throw new Error(`Tactic ${tacticId} has missing source case: ${caseId}`);
      }
      if (sourceCase.status !== "active") {
        throw new Error(`Tactic ${tacticId} source case is not active: ${caseId}`);
      }
      assertLifecycleRecord("case", sourceCase);
    }

    const supportingInvariantRefs = uniqueStrings(record.supporting_invariant_refs);
    for (const invariantId of supportingInvariantRefs) {
      const invariant = this.catalog.getRecord("invariant", invariantId);
      if (!invariant) {
        throw new Error(`Tactic ${tacticId} has missing supporting invariant: ${invariantId}`);
      }
      if (invariant.status !== "active") {
        throw new Error(`Tactic ${tacticId} supporting invariant is not active: ${invariantId}`);
      }
      assertLifecycleRecord("invariant", invariant);
    }

    const evidenceRefs = uniqueStrings(record.evidence_refs);
    if (evidenceRefs.length === 0) {
      throw new Error(`Tactic ${tacticId} has no evidence to revalidate.`);
    }
    for (const evidenceId of evidenceRefs) {
      if (!this.catalog.getRecord("evidence", evidenceId)) {
        throw new Error(`Tactic ${tacticId} has missing evidence: ${evidenceId}`);
      }
    }

    const normalizedValidatedOn = uniqueStrings(validatedOn);
    const nextRecord = {
      ...record,
      revalidate_at: revalidateAt,
      validated_on: uniqueStrings([...(record.validated_on ?? []), ...normalizedValidatedOn]),
      updated_at: reviewedAt,
    };
    this.validator.validateRecord("tactic", nextRecord);
    assertLifecycleRecord("tactic", nextRecord);

    const packet = {
      schema_version: "1.0.0",
      revalidation_id: createRevalidationId(tacticId, reviewedAt),
      tactic_id: tacticId,
      previous_revalidate_at: record.revalidate_at,
      next_revalidate_at: revalidateAt,
      source_case_refs: sourceCaseRefs,
      supporting_invariant_refs: supportingInvariantRefs,
      evidence_refs: evidenceRefs,
      checks: {
        source_cases_active: true,
        source_cases_lifecycle_valid: true,
        supporting_invariants_active: true,
        evidence_resolvable: true,
        invalidation_markers_clear: true,
        environment_bounds_reviewed: true,
        tool_version_bounds_reviewed: true,
      },
      validated_on: normalizedValidatedOn,
      reviewer,
      rationale,
      reviewed_at: reviewedAt,
      previous_record_snapshot_hash: createRecordSnapshotHash(record),
      resulting_record_snapshot_hash: createRecordSnapshotHash(nextRecord),
    };
    this.validator.validateRecord("tactic_revalidation_packet", packet);

    if (dryRun) {
      return {
        dry_run: true,
        packet,
        next_record: nextRecord,
      };
    }

    const packetWrite = this.revalidationStore.writePacket(packet);
    let recordWrite;
    try {
      recordWrite = this.catalog.writeRecord("tactic", nextRecord, { overwrite: true });
    } catch (error) {
      this.revalidationStore.removeUncommittedPacket(packet.revalidation_id);
      throw error;
    }

    return {
      dry_run: false,
      packet_write: packetWrite,
      record_write: recordWrite,
      next_record: nextRecord,
    };
  }

  applyDecision({ tacticId, decision, reviewer, rationale, reviewedAt, dryRun = false }) {
    if (decision !== "deprecate") {
      throw new Error("Existing tactic decisions only support deprecate; use promotion for replacement tactics.");
    }
    const record = this.catalog.getRecord("tactic", tacticId);
    if (!record) {
      throw new Error(`Unknown tactic: ${tacticId}`);
    }

    const result = this.reviewWorkflow.applyDecision({
      recordType: "tactic",
      record,
      decisionPacket: {
        decision_id: createDecisionIdForExistingRecord(tacticId, decision, reviewedAt),
        record_type: "tactic",
        record_id: tacticId,
        decision,
        reviewer,
        rationale,
        reviewed_at: reviewedAt,
      },
    });
    const nextRecord = {
      ...result.nextRecord,
      updated_at: reviewedAt,
    };
    const auditEntry = {
      ...result.auditEntry,
      record_snapshot_hash: createRecordSnapshotHash(nextRecord),
    };
    this.validator.validateRecord("tactic", nextRecord);
    this.validator.validateRecord("review_audit_entry", auditEntry);

    if (dryRun) {
      return {
        dry_run: true,
        next_record: nextRecord,
        audit_entry: auditEntry,
      };
    }

    const recordWrite = this.catalog.writeRecord("tactic", nextRecord, { overwrite: true });
    const auditWrite = this.catalog.writeRecord("review_audit_entry", auditEntry);
    return {
      dry_run: false,
      record_write: recordWrite,
      audit_write: auditWrite,
      next_record: nextRecord,
    };
  }

  promoteCandidate({
    entry,
    reviewer,
    rationale,
    reviewedAt,
    dryRun = false,
  }) {
    if (!entry) {
      throw new Error("promoteCandidate requires an entry.");
    }
    if (!reviewer) {
      throw new Error("promoteCandidate requires a reviewer.");
    }
    if (!rationale) {
      throw new Error("promoteCandidate requires a rationale.");
    }

    const preparedEntry = {
      ...entry,
      created_at: entry.created_at ?? reviewedAt,
      reviewer,
      rationale,
      reviewed_at: reviewedAt,
    };

    const evaluation = this.discovery.evaluateCandidate(preparedEntry);

    if (evaluation.actual_decision !== "approve") {
      const error = new Error("candidate is not promotion-ready");
      error.readiness = evaluation;
      throw error;
    }

    const { packet } = this.discovery.preparePromotionPacket(preparedEntry);
    const draft = this.pipeline.compileDraft(packet);
    const approval = this.reviewWorkflow.applyDecision({
      recordType: "tactic",
      record: draft,
      decisionPacket: {
        decision_id: entry.decision_id ?? createDecisionId(packet.proposed_tactic_id),
        record_type: "tactic",
        record_id: draft.id,
        decision: "approve",
        reviewer,
        rationale,
        reviewed_at: reviewedAt,
      },
    });

    const nextRecord = {
      ...approval.nextRecord,
      updated_at: reviewedAt,
    };
    const auditEntry = {
      ...approval.auditEntry,
      record_snapshot_hash: createRecordSnapshotHash(nextRecord),
    };

    if (dryRun) {
      return {
        dry_run: true,
        packet,
        draft,
        next_record: nextRecord,
        audit_entry: auditEntry,
      };
    }

    const packetWrite = this.packetStore.writePacket(packet);
    this.catalog.writeRecord("tactic", draft, { overwrite: false });
    const recordWrite = this.catalog.writeRecord("tactic", nextRecord, { overwrite: true });
    const auditWrite = this.catalog.writeRecord("review_audit_entry", auditEntry);

    return {
      dry_run: false,
      packet_write: packetWrite,
      record_write: recordWrite,
      audit_write: auditWrite,
      next_record: nextRecord,
    };
  }
}

function createDecisionId(tacticId) {
  return `review_tactic_${tacticId}_approve_001`;
}

function createRevalidationId(tacticId, reviewedAt) {
  return `reval_${tacticId}_${timestampSuffix(reviewedAt)}`;
}

function createDecisionIdForExistingRecord(tacticId, decision, reviewedAt) {
  return `review_${tacticId}_${decision}_${timestampSuffix(reviewedAt)}`;
}

function timestampSuffix(value) {
  return String(value).replaceAll(/[^0-9A-Za-z]/g, "");
}

function requireValidTimestamp(label, value) {
  const parsed = Date.parse(value ?? "");
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a valid ISO timestamp.`);
  }
  return parsed;
}

function uniqueStrings(values) {
  return [...new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean))];
}

function createRecordSnapshotHash(record) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(record)).digest("hex")}`;
}

module.exports = {
  TacticReviewSurface,
};
