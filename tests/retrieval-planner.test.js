const test = require("node:test");
const assert = require("node:assert/strict");

const {
  RetrievalPlanner,
  loadPlannerBaselineScenarios,
} = require("../src/retrieval/planner");

test("audit plans require evidence even if the caller omits it", () => {
  const planner = new RetrievalPlanner();

  const plan = planner.plan({
    request_id: "req_audit_force_evidence",
    query: "Prove the tactic choice.",
    project_scope: "project",
    intent: "audit",
    allowed_layers: ["cases", "invariants"],
  });

  assert.equal(plan.require_evidence, true);
  assert.deepEqual(plan.allowed_layers, ["cases", "invariants", "evidence"]);
});

test("research plans exclude tactics by default", () => {
  const planner = new RetrievalPlanner();

  const plan = planner.plan({
    request_id: "req_research_default",
    query: "What patterns recur across cases?",
    project_scope: "global",
    intent: "research",
  });

  assert.deepEqual(plan.allowed_layers, ["invariants", "cases", "evidence"]);
});

test("planner baseline scenarios stay stable", () => {
  const planner = new RetrievalPlanner();
  const scenarios = loadPlannerBaselineScenarios();

  for (const scenario of scenarios) {
    const plan = planner.plan(scenario.request);
    assert.deepEqual(
      {
        allowed_layers: plan.allowed_layers,
        max_results_per_layer: plan.max_results_per_layer,
        freshness_mode: plan.freshness_mode,
        require_evidence: plan.require_evidence,
      },
      scenario.expected,
      `baseline mismatch for ${scenario.scenario_id}`,
    );
  }
});
