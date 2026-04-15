const crypto = require("node:crypto");

const { CaseCompiler } = require("../cases/case-compiler");
const { InvariantPromotionPipeline } = require("../invariants/promotion");
const { assertTransition } = require("../lifecycle/rules");
const { TacticPromotionPipeline } = require("../tactics/promotion");
const { EcitrValidator } = require("../validation/validator");

class ReviewWorkflow {
  constructor({
    validator = new EcitrValidator(),
    caseCompiler = new CaseCompiler({ validator }),
    invariantPipeline = new InvariantPromotionPipeline({ validator }),
    tacticPipeline = new TacticPromotionPipeline({ validator }),
  } = {}) {
    this.validator = validator;
    this.caseCompiler = caseCompiler;
    this.invariantPipeline = invariantPipeline;
    this.tacticPipeline = tacticPipeline;
  }

  applyDecision({ recordType, record, decisionPacket }) {
    this.validator.validateRecord("review_decision_packet", decisionPacket);
    assertRecordType(recordType, decisionPacket.record_type);
    assertRecordId(recordType, record, decisionPacket.record_id);

    const previousStatus = record.status;
    const previousReviewState = record.review_state;
    const nextRecord = applyDecisionByType({
      recordType,
      record,
      decision: decisionPacket.decision,
      workflows: this,
    });

    const auditEntry = {
      audit_id: createAuditId(decisionPacket.decision_id, decisionPacket.record_id),
      decision_id: decisionPacket.decision_id,
      record_type: recordType,
      record_id: decisionPacket.record_id,
      decision: decisionPacket.decision,
      previous_status: previousStatus,
      resulting_status: nextRecord.status,
      reviewer: decisionPacket.reviewer,
      rationale: decisionPacket.rationale,
      reviewed_at: decisionPacket.reviewed_at,
      record_snapshot_hash: createRecordSnapshotHash(nextRecord),
    };

    if (previousReviewState) {
      auditEntry.previous_review_state = previousReviewState;
    }

    if (nextRecord.review_state) {
      auditEntry.resulting_review_state = nextRecord.review_state;
    }

    this.validator.validateRecord("review_audit_entry", auditEntry);

    return {
      nextRecord,
      auditEntry,
    };
  }
}

function applyDecisionByType({ recordType, record, decision, workflows }) {
  switch (recordType) {
    case "case":
      return applyCaseDecision({ record, decision, workflows });
    case "invariant":
      return applyInvariantDecision({ record, decision, workflows });
    case "tactic":
      return applyTacticDecision({ record, decision, workflows });
    default:
      throw new Error(`Unsupported review record type: ${recordType}`);
  }
}

function applyCaseDecision({ record, decision, workflows }) {
  switch (decision) {
    case "approve": {
      const reviewed = record.review_state === "reviewed" ? record : workflows.caseCompiler.markReviewed(record);
      return workflows.caseCompiler.activate(reviewed);
    }
    case "request_changes":
      return record.review_state === "reviewed" ? record : workflows.caseCompiler.markReviewed(record);
    case "reject":
      return transitionCase(record, "deprecated", "reviewed");
    case "deprecate":
      return transitionCase(record, "deprecated", record.review_state);
    default:
      throw new Error(`Unsupported case review decision: ${decision}`);
  }
}

function applyInvariantDecision({ record, decision, workflows }) {
  switch (decision) {
    case "approve":
      return workflows.invariantPipeline.activateDraft(record);
    case "request_changes":
      return structuredClone(record);
    case "reject":
      return transitionRecord("invariant", record, "rejected");
    case "deprecate":
      return transitionRecord("invariant", record, "deprecated");
    default:
      throw new Error(`Unsupported invariant review decision: ${decision}`);
  }
}

function applyTacticDecision({ record, decision, workflows }) {
  switch (decision) {
    case "approve":
      return workflows.tacticPipeline.activateDraft(record);
    case "request_changes":
      return structuredClone(record);
    case "reject":
      return transitionRecord("tactic", record, "rejected");
    case "deprecate":
      return transitionRecord("tactic", record, "deprecated");
    default:
      throw new Error(`Unsupported tactic review decision: ${decision}`);
  }
}

function transitionCase(record, nextStatus, reviewState) {
  assertTransition("case", record.status, nextStatus);
  return {
    ...record,
    status: nextStatus,
    review_state: reviewState ?? record.review_state,
  };
}

function transitionRecord(recordType, record, nextStatus) {
  assertTransition(recordType, record.status, nextStatus);
  return {
    ...record,
    status: nextStatus,
  };
}

function assertRecordType(recordType, packetRecordType) {
  if (recordType !== packetRecordType) {
    throw new Error(`Review packet type mismatch: ${packetRecordType} cannot be applied to ${recordType}`);
  }
}

function assertRecordId(recordType, record, expectedId) {
  const actualId = getRecordId(recordType, record);
  if (actualId !== expectedId) {
    throw new Error(`Review packet targets ${expectedId} but record is ${actualId}`);
  }
}

function getRecordId(recordType, record) {
  switch (recordType) {
    case "case":
      return record.case_id;
    case "invariant":
    case "tactic":
      return record.id;
    default:
      throw new Error(`Unsupported review record type: ${recordType}`);
  }
}

function createAuditId(decisionId, recordId) {
  return `audit_${crypto.createHash("sha1").update(`${decisionId}:${recordId}`).digest("hex").slice(0, 16)}`;
}

function createRecordSnapshotHash(record) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(record)).digest("hex")}`;
}

module.exports = {
  ReviewWorkflow,
};
