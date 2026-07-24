const crypto = require("node:crypto");

const { assertLifecycleRecord } = require("../lifecycle/rules");
const { EcitrValidator } = require("../validation/validator");

class InvariantPromotionPipeline {
  constructor({ validator = new EcitrValidator(), now = defaultNow } = {}) {
    this.validator = validator;
    this.now = now;
  }

  compileDraft(packet) {
    this.validator.validateRecord("invariant_promotion_packet", packet);
    assertPromotionBasis(packet);

    const draft = {
      id: packet.proposed_invariant_id ?? createInvariantId(packet.promotion_id),
      series_key: packet.series_key,
      layer: "invariant",
      status: "draft",
      version: packet.version ?? 1,
      title: packet.title,
      summary: packet.summary,
      statement: packet.statement,
      source_case_refs: packet.source_case_refs,
      evidence_refs: packet.evidence_refs,
      why_it_is_stable: packet.why_it_is_stable,
      scope: packet.scope,
      non_scope: packet.non_scope,
      applicability_conditions: packet.applicability_conditions,
      non_applicability_conditions: packet.non_applicability_conditions,
      known_breakers: packet.known_breakers,
      tool_agnosticity_level: packet.tool_agnosticity_level,
      confidence: packet.confidence,
      created_at: packet.created_at ?? this.now(),
      updated_at: packet.created_at ?? this.now(),
    };

    if (packet.workspace_id) {
      draft.workspace_id = packet.workspace_id;
    }

    if (packet.review_due_at) {
      draft.review_due_at = packet.review_due_at;
    }

    if (packet.supersedes) {
      draft.supersedes = packet.supersedes;
    }

    this.validator.validateRecord("invariant", draft);
    assertLifecycleRecord("invariant", draft);

    return draft;
  }

  activateDraft(draft) {
    if (draft.status !== "draft") {
      throw new Error("Only draft invariants may be activated.");
    }

    const active = {
      ...draft,
      status: "active",
      updated_at: this.now(),
    };

    this.validator.validateRecord("invariant", active);
    assertLifecycleRecord("invariant", active);

    return active;
  }
}

function assertPromotionBasis(packet) {
  if (packet.promotion_basis === "multi_case" && packet.source_case_refs.length < 2) {
    throw new Error("Multi-case invariant promotion requires at least two supporting cases.");
  }
}

function createInvariantId(promotionId) {
  return `inv_${crypto.createHash("sha1").update(promotionId).digest("hex").slice(0, 16)}`;
}

function defaultNow() {
  return new Date().toISOString();
}

module.exports = {
  InvariantPromotionPipeline,
};
