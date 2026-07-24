const crypto = require("node:crypto");

const { assertLifecycleRecord } = require("../lifecycle/rules");
const { EcitrValidator } = require("../validation/validator");
const { evaluateTacticFreshness } = require("./freshness");

class TacticPromotionPipeline {
  constructor({ validator = new EcitrValidator(), now = defaultNow } = {}) {
    this.validator = validator;
    this.now = now;
  }

  compileDraft(packet) {
    this.validator.validateRecord("tactic_promotion_packet", packet);

    const createdAt = packet.created_at ?? this.now();
    const draft = {
      id: packet.proposed_tactic_id ?? createTacticId(packet.promotion_id),
      promotion_basis: packet.promotion_basis ?? "invariant_backed",
      series_key: packet.series_key,
      layer: "tactic",
      status: "draft",
      version: packet.version ?? 1,
      title: packet.title,
      summary: packet.summary,
      action: packet.action,
      source_case_refs: packet.source_case_refs,
      supporting_invariant_refs: packet.supporting_invariant_refs,
      evidence_refs: packet.evidence_refs,
      parameter_observation_refs: packet.parameter_observation_refs,
      tool_binding: packet.tool_binding,
      tool_version_bounds: packet.tool_version_bounds,
      environment_bounds: packet.environment_bounds,
      prerequisites: packet.prerequisites,
      steps: packet.steps,
      fallbacks: packet.fallbacks,
      rollback: packet.rollback,
      confidence: packet.confidence,
      created_at: createdAt,
      updated_at: createdAt,
    };

    if (packet.workspace_id) {
      draft.workspace_id = packet.workspace_id;
    }

    if (packet.expiry_at) {
      draft.expiry_at = packet.expiry_at;
    }

    if (packet.revalidate_at) {
      draft.revalidate_at = packet.revalidate_at;
    }

    if (packet.validated_on) {
      draft.validated_on = packet.validated_on;
    }

    if (packet.supersedes) {
      draft.supersedes = packet.supersedes;
    }

    this.validator.validateRecord("tactic", draft);
    assertLifecycleRecord("tactic", draft);

    return draft;
  }

  activateDraft(draft, options = {}) {
    if (draft.status !== "draft") {
      throw new Error("Only draft tactics may be activated.");
    }

    const activatedAt = this.now();
    const active = {
      ...draft,
      status: "active",
      updated_at: activatedAt,
    };

    this.validator.validateRecord("tactic", active);
    assertLifecycleRecord("tactic", active);

    const freshness = evaluateTacticFreshness(active, {
      ...options,
      now: options.now ?? new Date(activatedAt),
    });
    if (!freshness.usable) {
      throw new Error(`Cannot activate non-fresh tactic: ${freshness.reasons.join("; ")}`);
    }

    return active;
  }
}

function createTacticId(promotionId) {
  return `tac_${crypto.createHash("sha1").update(promotionId).digest("hex").slice(0, 16)}`;
}

function defaultNow() {
  return new Date().toISOString();
}

module.exports = {
  TacticPromotionPipeline,
};
