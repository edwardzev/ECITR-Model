const test = require("node:test");
const assert = require("node:assert/strict");

const { runEvidenceSmokeChecks } = require("../src/retrieval/evidence-smoke-check");

test("evidence smoke checks pass when expected ids are present in qdrant and runtime results", async () => {
  const scenarios = [
    {
      scenario_id: "smoke_001",
      expected_evidence_id: "ev_expected_001",
      request: {
        request_id: "req_smoke_001",
        query: "payload store",
        project_scope: "project",
        intent: "analysis",
        allowed_layers: ["evidence"],
        max_results_per_layer: { evidence: 10 },
      },
    },
  ];

  const report = await runEvidenceSmokeChecks({
    catalogs: {},
    scenarios,
    planner: {
      plan(request) {
        return {
          request_id: request.request_id,
          allowed_layers: request.allowed_layers,
          max_results_per_layer: request.max_results_per_layer,
        };
      },
    },
    qdrantBackend: {
      async retrieve() {
        return [
          { recordId: "ev_expected_001" },
          { recordId: "ev_other_001" },
        ];
      },
    },
    runtime: {
      async execute() {
        return {
          response: {
            results: {
              evidence: ["ev_expected_001", "ev_other_001"],
            },
          },
        };
      },
    },
  });

  assert.equal(report.failed, 0);
  assert.equal(report.passed, 1);
  assert.equal(report.scenarios[0].pass, true);
});

test("evidence smoke checks fail when expected ids are missing from qdrant or runtime results", async () => {
  const scenarios = [
    {
      scenario_id: "smoke_002",
      expected_evidence_id: "ev_expected_002",
      request: {
        request_id: "req_smoke_002",
        query: "managed memories",
        project_scope: "project",
        intent: "analysis",
        allowed_layers: ["evidence"],
        max_results_per_layer: { evidence: 10 },
      },
    },
  ];

  const report = await runEvidenceSmokeChecks({
    catalogs: {},
    scenarios,
    planner: {
      plan(request) {
        return {
          request_id: request.request_id,
          allowed_layers: request.allowed_layers,
          max_results_per_layer: request.max_results_per_layer,
        };
      },
    },
    qdrantBackend: {
      async retrieve() {
        return [{ recordId: "ev_other_002" }];
      },
    },
    runtime: {
      async execute() {
        return {
          response: {
            results: {
              evidence: ["ev_expected_002"],
            },
          },
        };
      },
    },
  });

  assert.equal(report.failed, 1);
  assert.equal(report.passed, 0);
  assert.equal(report.scenarios[0].pass, false);
});
