const { ReviewWorkflow } = require("../review/workflow");
const { RetrievalRuntime } = require("../retrieval/runtime");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { OrchestratorRuntime } = require("./delegation-runtime");

class OrchestratorExecutionLoop {
  constructor({
    catalog,
    router = new OrchestratorRuntime(),
    retrievalRuntime = new RetrievalRuntime(),
    reviewWorkflow = new ReviewWorkflow(),
  } = {}) {
    if (!(catalog instanceof FileBackedCatalog)) {
      throw new Error("OrchestratorExecutionLoop requires a FileBackedCatalog instance.");
    }

    this.catalog = catalog;
    this.router = router;
    this.retrievalRuntime = retrievalRuntime;
    this.reviewWorkflow = reviewWorkflow;
  }

  async run({ taskPacket, retrievalRequest, now = new Date() }) {
    const routingPlan = this.router.route(taskPacket);
    const catalogs = this.catalog.loadRuntimeCatalogs();
    const retrieval = retrievalRequest
      ? await this.retrievalRuntime.execute({ request: retrievalRequest, catalogs, now })
      : null;

    return {
      task_id: taskPacket.task_id,
      routing_plan: routingPlan,
      retrieval,
      next_actions: buildNextActions({ routingPlan, retrieval }),
      catalog_counts: {
        evidence: catalogs.evidence.length,
        cases: catalogs.cases.length,
        invariants: catalogs.invariants.length,
        tactics: catalogs.tactics.length,
        atomic_claim_sets: catalogs.atomic_claim_sets.length,
      },
    };
  }

  applyReview({ recordType, record, decisionPacket, persist = false }) {
    const reviewResult = this.reviewWorkflow.applyDecision({ recordType, record, decisionPacket });

    if (persist) {
      const recordWrite = this.catalog.writeRecord(recordType, reviewResult.nextRecord, { overwrite: true });
      const auditWrite = this.catalog.writeRecord("review_audit_entry", reviewResult.auditEntry);

      return {
        ...reviewResult,
        recordWrite,
        auditWrite,
      };
    }

    return reviewResult;
  }
}

function buildNextActions({ routingPlan, retrieval }) {
  const actions = [];

  actions.push(`primary owner: ${routingPlan.primary_role}`);

  if (routingPlan.requires_research) {
    actions.push("research packet required before final promotion");
  }

  if (routingPlan.requires_governance_review) {
    actions.push("governance review required before acceptance");
  }

  if (retrieval?.response?.results?.tactics?.length) {
    actions.push(`top tactic candidate: ${retrieval.response.results.tactics[0]}`);
  }

  return actions;
}

module.exports = {
  OrchestratorExecutionLoop,
};
