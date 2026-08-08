const test = require("node:test");
const assert = require("node:assert/strict");

const {
  compareRetrievalTokenizers,
  runRetrievalGateBenchmark,
} = require("../src/retrieval/retrieval-improvement-benchmark");
const { RetrievalGate } = require("../src/retrieval/retrieval-gate");
const { REPO_ROOT } = require("../src/validation/schema-registry");
const { readJson } = require("../src/validation/validator");

test("retrieval gate fails open on uncertainty but skips explicit general or current-context requests", () => {
  const gate = new RetrievalGate();
  const uncertain = gate.evaluate({ query: "Plan the next step.", intent: "action" });
  const general = gate.evaluate({ query: "What is computer memory?", intent: "analysis" });
  const current = gate.evaluate({ query: "Rewrite the sentence you just wrote.", intent: "action" });

  assert.equal(uncertain.proposed_decision, "retrieve");
  assert.equal(uncertain.confidence, 0.55);
  assert.equal(general.proposed_decision, "skip");
  assert.equal(current.proposed_decision, "skip");
  assert.equal(general.enforcement, "disabled");
  assert.equal(general.actual_behavior, "retrieve_always");
});

test("mandatory preflight and failure-retry policies override proposed skips", () => {
  const gate = new RetrievalGate();
  const preflight = gate.evaluate({
    query: "What is Business Central?",
    trigger: "preflight",
    projectConfig: {
      preflight_retrieval_mandatory: true,
      failure_retry_retrieval_mandatory: false,
    },
  });
  const failureRetry = gate.evaluate({
    query: "Rewrite the sentence you just wrote.",
    trigger: "failure_retry",
    projectConfig: {
      preflight_retrieval_mandatory: false,
      failure_retry_retrieval_mandatory: true,
    },
  });

  for (const result of [preflight, failureRetry]) {
    assert.equal(result.proposed_decision, "skip");
    assert.equal(result.decision, "retrieve");
    assert.equal(result.mandatory_override, true);
    assert.equal(result.mandatory_policy.applied, true);
  }
});

test("retrieval improvement benchmarks meet the approved safety gates", () => {
  const tokenization = compareRetrievalTokenizers({
    scenarios: readJson(`${REPO_ROOT}/benchmarks/retrieval-tokenization.scenarios.json`),
  });
  const gate = runRetrievalGateBenchmark({
    scenarios: readJson(`${REPO_ROOT}/benchmarks/retrieval-gate.scenarios.json`),
  });

  assert.equal(tokenization.variants.legacy_ascii_v1.hit_rate, 0.3333);
  assert.equal(tokenization.variants.unicode_v2.hit_rate, 1);
  assert.equal(tokenization.variants.unicode_v2.failing_scenarios, 0);
  assert.equal(gate.metrics.false_negative_count, 0);
  assert.equal(gate.metrics.critical_false_negative_count, 0);
  assert.equal(gate.metrics.mandatory_policy_violation_count, 0);
  assert.equal(gate.metrics.false_positive_count, 2);
  assert.equal(gate.metrics.query_usefulness_accuracy, 1);
  assert.equal(gate.acceptance.passes, true);
  assert.match(gate.acceptance.recommendation, /^keep_shadow/);
});
