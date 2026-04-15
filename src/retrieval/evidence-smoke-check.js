const { buildSemanticEmbedder } = require("./embedders/factory");
const { buildDefaultLanes } = require("./lanes");
const { RetrievalPlanner } = require("./planner");
const { RetrievalRuntime } = require("./runtime");
const { QdrantSemanticBackend } = require("./semantic-backends/qdrant-backend");

const DEFAULT_TOP_K = 10;
const DEFAULT_NOW = new Date("2026-05-01T00:00:00Z");
const DEFAULT_IMPORTED_AGENT_OPS_EVIDENCE_SMOKE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenario_id: "smoke_managed_qdrant_lifecycle_001",
    expected_evidence_id: "ev_aops_run_run_20260410173434_mcp",
    request: Object.freeze({
      request_id: "req_smoke_qdrant_lifecycle_001",
      query: "managed local Qdrant lifecycle benchmark behavior",
      project_scope: "project",
      intent: "analysis",
      allowed_layers: ["evidence"],
      max_results_per_layer: { evidence: DEFAULT_TOP_K },
    }),
  }),
  Object.freeze({
    scenario_id: "smoke_payload_store_001",
    expected_evidence_id: "ev_aops_run_run_20260411084203_mcp",
    request: Object.freeze({
      request_id: "req_smoke_payload_store_001",
      query: "sidecar payload store behind verbatim_payload_ref",
      project_scope: "project",
      intent: "analysis",
      allowed_layers: ["evidence"],
      max_results_per_layer: { evidence: DEFAULT_TOP_K },
    }),
  }),
  Object.freeze({
    scenario_id: "smoke_chatgpt_memories_001",
    expected_evidence_id: "ev_aops_run_run_20260411090933_mcp",
    request: Object.freeze({
      request_id: "req_smoke_chatgpt_memories_001",
      query: "ChatGPT managed memories into ECITR evidence",
      project_scope: "project",
      intent: "analysis",
      allowed_layers: ["evidence"],
      max_results_per_layer: { evidence: DEFAULT_TOP_K },
    }),
  }),
]);

async function runEvidenceSmokeChecks({
  catalogs,
  endpoint,
  collectionName,
  scenarios = DEFAULT_IMPORTED_AGENT_OPS_EVIDENCE_SMOKE_SCENARIOS,
  planner = new RetrievalPlanner(),
  qdrantBackend = null,
  runtime = null,
  embedder = null,
  now = DEFAULT_NOW,
  topK = DEFAULT_TOP_K,
} = {}) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw new Error("runEvidenceSmokeChecks requires at least one scenario.");
  }

  const backend = qdrantBackend ?? new QdrantSemanticBackend({
    endpoint,
    collectionName,
    catalogs,
    embedder: embedder ?? buildSemanticEmbedder(),
  });
  const retrievalRuntime = runtime ?? new RetrievalRuntime({
    planner,
    lanesFactory: ({ catalogs: runtimeCatalogs }) =>
      buildDefaultLanes({ catalogs: runtimeCatalogs, semanticBackend: backend }),
  });

  const reports = [];

  for (const scenario of scenarios) {
    const plan = planner.plan(scenario.request);
    const qdrantCandidates = await backend.retrieve({
      request: scenario.request,
      plan,
      catalogs,
    });
    const runtimeExecution = await retrievalRuntime.execute({
      request: scenario.request,
      catalogs,
      now,
    });

    const qdrantTopIds = qdrantCandidates.slice(0, topK).map((candidate) => candidate.recordId);
    const runtimeTopIds = runtimeExecution.response.results.evidence.slice(0, topK);
    const pass =
      qdrantTopIds.includes(scenario.expected_evidence_id) &&
      runtimeTopIds.includes(scenario.expected_evidence_id);

    reports.push({
      scenario_id: scenario.scenario_id,
      expected_evidence_id: scenario.expected_evidence_id,
      qdrant_top_ids: qdrantTopIds,
      runtime_top_ids: runtimeTopIds,
      pass,
    });
  }

  const passed = reports.filter((report) => report.pass).length;
  return {
    scenario_count: reports.length,
    passed,
    failed: reports.length - passed,
    scenarios: reports,
  };
}

module.exports = {
  DEFAULT_TOP_K,
  DEFAULT_IMPORTED_AGENT_OPS_EVIDENCE_SMOKE_SCENARIOS,
  runEvidenceSmokeChecks,
};
