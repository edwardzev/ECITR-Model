const { buildDefaultLanes } = require("./lanes");
const { RetrievalPlanner } = require("./planner");
const { RetrievalRuntime } = require("./runtime");
const { HeuristicSemanticBackend } = require("./semantic-backends/heuristic-backend");

async function compareSemanticBackends({
  scenarios,
  catalogs,
  qdrantBackend,
  heuristicBackend = new HeuristicSemanticBackend({ catalogs }),
  planner = new RetrievalPlanner(),
  now = new Date("2026-05-01T00:00:00Z"),
}) {
  const report = [];

  for (const scenario of scenarios) {
    const plan = planner.plan(scenario.request);
    const heuristicSemanticCandidates = await heuristicBackend.retrieve({
      request: scenario.request,
      plan,
      catalogs,
    });
    const qdrantSemanticCandidates = await qdrantBackend.retrieve({
      request: scenario.request,
      plan,
      catalogs,
    });

    const heuristicRuntime = new RetrievalRuntime({
      planner,
      lanesFactory: ({ catalogs: runtimeCatalogs }) =>
        buildDefaultLanes({
          catalogs: runtimeCatalogs,
          semanticBackend: heuristicBackend,
        }),
    });

    const qdrantRuntime = new RetrievalRuntime({
      planner,
      lanesFactory: ({ catalogs: runtimeCatalogs }) =>
        buildDefaultLanes({
          catalogs: runtimeCatalogs,
          semanticBackend: qdrantBackend,
        }),
    });

    const heuristicExecution = await heuristicRuntime.execute({
      request: scenario.request,
      catalogs,
      now,
    });
    const qdrantExecution = await qdrantRuntime.execute({
      request: scenario.request,
      catalogs,
      now,
    });

    report.push({
      scenario_id: scenario.scenario_id,
      heuristic: {
        semantic_candidates: groupCandidateIds(heuristicSemanticCandidates),
        runtime_results: heuristicExecution.response.results,
      },
      qdrant: {
        semantic_candidates: groupCandidateIds(qdrantSemanticCandidates),
        runtime_results: qdrantExecution.response.results,
      },
      overlap: computeOverlap({
        left: heuristicExecution.response.results,
        right: qdrantExecution.response.results,
      }),
    });
  }

  return {
    generated_at: now.toISOString(),
    scenario_count: report.length,
    scenarios: report,
  };
}

function groupCandidateIds(candidates) {
  const grouped = {
    tactics: [],
    invariants: [],
    cases: [],
    evidence: [],
  };

  for (const candidate of candidates) {
    grouped[candidate.layer].push(candidate.recordId);
  }

  return grouped;
}

function computeOverlap({ left, right }) {
  const overlap = {};

  for (const layer of Object.keys(left)) {
    const leftIds = new Set(left[layer] ?? []);
    const rightIds = new Set(right[layer] ?? []);
    const shared = [...leftIds].filter((recordId) => rightIds.has(recordId));
    overlap[layer] = {
      shared,
      shared_count: shared.length,
    };
  }

  return overlap;
}

module.exports = {
  compareSemanticBackends,
};
