const crypto = require("node:crypto");

const { assertLifecycleRecord } = require("../lifecycle/rules");
const { EcitrValidator } = require("../validation/validator");

class CaseCompiler {
  constructor({ validator = new EcitrValidator(), now = defaultNow } = {}) {
    this.validator = validator;
    this.now = now;
  }

  compile(packet) {
    this.validator.validateRecord("case_compilation_packet", packet);

    const draftCase = {
      case_id: packet.proposed_case_id ?? createCaseId(packet.compilation_id),
      case_version: packet.case_version ?? 1,
      status: "draft",
      evidence_refs: packet.evidence_refs,
      authoring_agent: packet.authoring_agent ?? "case-compiler",
      review_state: "draft",
      confidence: packet.confidence,
      derived_at: packet.derived_at ?? this.now(),
      derivation_rule_id: packet.derivation_rule_id,
    };

    assignIfPresent(draftCase, "problem_statement", packet.problem_statement);
    assignIfPresent(draftCase, "context", packet.context);
    assignIfPresent(draftCase, "action_taken", packet.action_taken);
    assignIfPresent(draftCase, "outcome", packet.outcome);
    assignIfPresent(draftCase, "failure_mode", packet.failure_mode);
    assignIfPresent(draftCase, "applicability", packet.applicability);
    assignIfPresent(draftCase, "open_questions", packet.open_questions);

    if (packet.derived_from_case_id) {
      draftCase.derived_from_case_id = packet.derived_from_case_id;
    }

    if (packet.supersedes_case_id) {
      draftCase.supersedes_case_id = packet.supersedes_case_id;
    }

    this.validator.validateRecord("case", draftCase);
    assertLifecycleRecord("case", draftCase);

    return draftCase;
  }

  markReviewed(draftCase) {
    this.assertDraftState(draftCase, "reviewed");

    return {
      ...draftCase,
      review_state: "reviewed",
    };
  }

  activate(reviewedCase) {
    if (reviewedCase.status !== "draft") {
      throw new Error("Only draft cases may be activated.");
    }

    if (reviewedCase.review_state !== "reviewed") {
      throw new Error("Only reviewed draft cases may be activated.");
    }

    const activeCase = {
      ...reviewedCase,
      status: "active",
      review_state: "approved",
    };

    this.validator.validateRecord("case", activeCase);
    assertLifecycleRecord("case", activeCase);

    return activeCase;
  }

  assertDraftState(caseRecord, nextReviewState) {
    if (caseRecord.status !== "draft") {
      throw new Error(`Only draft cases may be marked ${nextReviewState}.`);
    }

    if (caseRecord.review_state !== "draft") {
      throw new Error(`Only draft review-state cases may be marked ${nextReviewState}.`);
    }
  }
}

function createCaseId(compilationId) {
  const digest = crypto.createHash("sha1").update(compilationId).digest("hex").slice(0, 16);
  return `case_${digest}`;
}

function defaultNow() {
  return new Date().toISOString();
}

function assignIfPresent(target, key, value) {
  if (value === undefined) {
    return;
  }

  target[key] = value;
}

module.exports = {
  CaseCompiler,
  createCaseId,
};
