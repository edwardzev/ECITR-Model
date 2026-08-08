const { ReviewWorkflow } = require("../review/workflow");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { OrchestratorRuntime } = require("./delegation-runtime");
const { RuntimeInterventionRunner } = require("../runtime/intervention-runner");
const {
  ProjectMemorySurface,
  createProjectMemoryRetrievalRuntime,
} = require("../runtime/project-memory");

class OrchestratorExecutionLoop {
  constructor({
    catalog,
    router = new OrchestratorRuntime(),
    retrievalRuntime = createProjectMemoryRetrievalRuntime(),
    interventionRunner = new RuntimeInterventionRunner({ retrievalRuntime }),
    projectMemorySurface = new ProjectMemorySurface({ catalog, retrievalRuntime }),
    reviewWorkflow = new ReviewWorkflow(),
  } = {}) {
    if (!(catalog instanceof FileBackedCatalog)) {
      throw new Error("OrchestratorExecutionLoop requires a FileBackedCatalog instance.");
    }

    this.catalog = catalog;
    this.router = router;
    this.retrievalRuntime = retrievalRuntime;
    this.interventionRunner = interventionRunner;
    this.projectMemorySurface = projectMemorySurface;
    this.reviewWorkflow = reviewWorkflow;
  }

  async run({ taskPacket, retrievalRequest, intervention, now = new Date() }) {
    const routingPlan = this.router.route(taskPacket);
    const catalogs = this.catalog.loadRuntimeCatalogs();
    const memorySurface = this.projectMemorySurface.describe();
    let retrieval = null;
    let interventionResult = null;
    let memoryInvocation = null;
    let retrievalGate = null;

    if (retrievalRequest) {
      retrieval = await this.retrievalRuntime.execute({ request: retrievalRequest, catalogs, now });
      retrievalGate = this.projectMemorySurface.evaluateRetrievalGate({
        query: retrievalRequest.query,
        intent: retrievalRequest.intent,
        trigger: "discretionary",
      });
      memoryInvocation = this.projectMemorySurface.logConsultation({
        taskPacket,
        consultTrigger: "explicit_request",
        request: retrievalRequest,
        retrieval,
        gateEvaluation: retrievalGate,
        now,
      });
    } else if (intervention) {
      const interventionExecution = await this.interventionRunner.run({
        intervention,
        catalogs,
        now,
      });
      retrieval = interventionExecution.retrieval;
      interventionResult = interventionExecution.intervention;
      retrievalGate = this.projectMemorySurface.evaluateRetrievalGate({
        query: intervention.query,
        intent: retrieval.plan.intent,
        trigger: intervention.mode,
      });
      memoryInvocation = this.projectMemorySurface.logConsultation({
        taskPacket,
        consultTrigger: intervention.mode,
        request: null,
        retrieval,
        gateEvaluation: retrievalGate,
        now,
      });
    } else {
      memoryInvocation = this.projectMemorySurface.logTaskOpportunity({
        taskPacket,
        now,
      });
    }

    return {
      task_id: taskPacket.task_id,
      routing_plan: routingPlan,
      retrieval,
      intervention: interventionResult,
      retrieval_gate: retrievalGate,
      memory_surface: memorySurface,
      memory_invocation: memoryInvocation,
      next_actions: buildNextActions({
        routingPlan,
        retrieval,
        memorySurface,
        memoryInvocation,
      }),
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

  async searchProjectMemory(args) {
    return this.projectMemorySurface.searchProjectMemory(args);
  }

  async search_project_memory(args) {
    return this.searchProjectMemory(args);
  }

  recordMemoryUsage(args) {
    return this.projectMemorySurface.recordMemoryUsage(args);
  }

  record_memory_usage(args) {
    return this.recordMemoryUsage(args);
  }
}

function buildNextActions({ routingPlan, retrieval, memorySurface, memoryInvocation }) {
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

  if (memorySurface?.available) {
    actions.push(`project memory available via ${memorySurface.tool_name}`);
  }

  if (memoryInvocation?.memory_consulted) {
    actions.push(`memory consulted via ${memoryInvocation.consult_trigger}`);
  }

  return actions;
}

module.exports = {
  OrchestratorExecutionLoop,
};
