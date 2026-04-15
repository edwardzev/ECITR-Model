const test = require("node:test");
const assert = require("node:assert/strict");

const { OrchestratorRuntime } = require("../src/orchestrator/delegation-runtime");
const { loadExample } = require("./helpers/load-example");

test("retrieval-class task routes to Retrieval Architect with review gates", () => {
  const runtime = new OrchestratorRuntime();
  const packet = loadExample("orchestrator_task_packet");

  const plan = runtime.route(packet);

  assert.equal(plan.primary_role, "Retrieval Architect");
  assert.equal(plan.requires_orchestrator_review, true);
  assert.equal(plan.requires_governance_review, true);
  assert.equal(plan.requires_research, true);
});

test("single-layer local case task routes to Case Steward", () => {
  const runtime = new OrchestratorRuntime();
  const plan = runtime.route({
    task_id: "task_case_local_001",
    title: "Revise case compiler tests",
    objective: "Adjust a cases-only test surface.",
    affected_layers: ["cases"],
    change_class: "local",
  });

  assert.equal(plan.primary_role, "Case Steward");
  assert.equal(plan.requires_orchestrator_review, false);
});

test("contract-class task stays under orchestrator-led routing", () => {
  const runtime = new OrchestratorRuntime();
  const plan = runtime.route({
    task_id: "task_contract_001",
    title: "Change case authority boundary",
    objective: "Adjust the cross-layer case contract.",
    affected_layers: ["cases", "invariants"],
    change_class: "contract",
  });

  assert.equal(plan.primary_role, "Orchestrator");
  assert.equal(plan.requires_governance_review, true);
});
