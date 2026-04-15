const { EcitrValidator } = require("../validation/validator");
const { getPrimaryRoleForLayer } = require("./role-registry");

class OrchestratorRuntime {
  constructor({ validator = new EcitrValidator() } = {}) {
    this.validator = validator;
  }

  route(taskPacket) {
    this.validator.validateRecord("orchestrator_task_packet", taskPacket);

    const uniqueLayers = [...new Set(taskPacket.affected_layers)];
    const singleLayer = uniqueLayers.length === 1 ? uniqueLayers[0] : null;

    let primaryRole = singleLayer ? getPrimaryRoleForLayer(singleLayer) : "Orchestrator";
    const supportingRoles = uniqueLayers
      .map((layer) => getPrimaryRoleForLayer(layer))
      .filter((roleName) => roleName !== primaryRole);

    const reasons = [];
    let requiresOrchestratorReview = false;
    let requiresGovernanceReview = false;
    let requiresResearch = taskPacket.requires_research === true;

    if (taskPacket.change_class === "retrieval") {
      primaryRole = "Retrieval Architect";
      requiresOrchestratorReview = true;
      requiresGovernanceReview = true;
      reasons.push("retrieval-class work requires Retrieval Architect ownership and explicit review");
    }

    if (taskPacket.change_class === "contract") {
      primaryRole = "Orchestrator";
      requiresOrchestratorReview = true;
      requiresGovernanceReview = true;
      reasons.push("contract-class work stays under orchestrator-led review");
    }

    if (taskPacket.change_class === "external-adaptation") {
      primaryRole = "Orchestrator";
      requiresOrchestratorReview = true;
      requiresGovernanceReview = true;
      requiresResearch = true;
      reasons.push("external-adaptation requires Researcher and governance review");
    }

    if (taskPacket.change_class === "migration" || taskPacket.change_class === "cross-layer") {
      requiresOrchestratorReview = true;
      reasons.push(`${taskPacket.change_class} work requires explicit orchestrator review`);
    }

    if (taskPacket.requires_human_review === true) {
      requiresOrchestratorReview = true;
      reasons.push("task packet explicitly requests human-facing review");
    }

    if (requiresResearch) {
      supportingRoles.push("Researcher");
    }

    if (requiresGovernanceReview) {
      supportingRoles.push("Governance and QA Steward");
    }

    return {
      task_id: taskPacket.task_id,
      title: taskPacket.title,
      primary_role: primaryRole,
      supporting_roles: [...new Set(supportingRoles)],
      requires_orchestrator_review: requiresOrchestratorReview,
      requires_governance_review: requiresGovernanceReview,
      requires_research: requiresResearch,
      reasons,
    };
  }
}

module.exports = {
  OrchestratorRuntime,
};
