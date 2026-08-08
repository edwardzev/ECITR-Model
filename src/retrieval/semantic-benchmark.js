const { buildDefaultLanes } = require("./lanes");
const { RetrievalPlanner } = require("./planner");
const { RetrievalRuntime } = require("./runtime");
const { HeuristicSemanticBackend } = require("./semantic-backends/heuristic-backend");

async function compareSemanticBackends({
  scenarios,
  catalogs,
  candidateBackend = null,
  candidateLabel = "candidate",
  heuristicBackend = new HeuristicSemanticBackend({ catalogs }),
  planner = new RetrievalPlanner(),
  now = new Date("2026-05-01T00:00:00Z"),
}) {
  if (!candidateBackend) {
    throw new Error("compareSemanticBackends requires a candidateBackend.");
  }
  const comparisonBackend = candidateBackend;
  const comparisonLabel = candidateLabel;

  const report = [];

  for (const scenario of scenarios) {
    const plan = planner.plan(scenario.request);
    const heuristicSemantic = await measureAsync(() => heuristicBackend.retrieve({
      request: scenario.request,
      plan,
      catalogs,
    }));
    const candidateSemantic = await measureAsync(() => comparisonBackend.retrieve({
      request: scenario.request,
      plan,
      catalogs,
    }));

    const heuristicRuntime = new RetrievalRuntime({
      planner,
      lanesFactory: ({ catalogs: runtimeCatalogs }) =>
        buildDefaultLanes({
          catalogs: runtimeCatalogs,
          semanticBackend: heuristicBackend,
        }),
    });

    const candidateRuntime = new RetrievalRuntime({
      planner,
      lanesFactory: ({ catalogs: runtimeCatalogs }) =>
        buildDefaultLanes({
          catalogs: runtimeCatalogs,
          semanticBackend: comparisonBackend,
        }),
    });

    const heuristicExecution = await measureAsync(() => heuristicRuntime.execute({
      request: scenario.request,
      catalogs,
      now,
    }));
    const candidateExecution = await measureAsync(() => candidateRuntime.execute({
      request: scenario.request,
      catalogs,
      now,
    }));

    const scenarioReport = {
      scenario_id: scenario.scenario_id,
      heuristic: {
        semantic_candidates: groupCandidateIds(heuristicSemantic.value),
        runtime_results: heuristicExecution.value.response.results,
        timing_ms: {
          semantic: heuristicSemantic.elapsedMs,
          runtime: heuristicExecution.elapsedMs,
        },
      },
      [comparisonLabel]: {
        semantic_candidates: groupCandidateIds(candidateSemantic.value),
        runtime_results: candidateExecution.value.response.results,
        timing_ms: {
          semantic: candidateSemantic.elapsedMs,
          runtime: candidateExecution.elapsedMs,
        },
      },
      overlap: computeOverlap({
        left: heuristicExecution.value.response.results,
        right: candidateExecution.value.response.results,
      }),
    };
    scenarioReport.heuristic.quality = evaluateExpectedResults({
      results: scenarioReport.heuristic.runtime_results,
      expectedResults: scenario.expected_results,
      forbiddenResults: scenario.forbidden_results,
    });
    scenarioReport[comparisonLabel].quality = evaluateExpectedResults({
      results: scenarioReport[comparisonLabel].runtime_results,
      expectedResults: scenario.expected_results,
      forbiddenResults: scenario.forbidden_results,
    });
    report.push(scenarioReport);
  }

  return {
    generated_at: now.toISOString(),
    scenario_count: report.length,
    quality_summary: {
      heuristic: summarizeQuality(report.map((entry) => entry.heuristic.quality)),
      [comparisonLabel]: summarizeQuality(report.map((entry) => entry[comparisonLabel].quality)),
    },
    scenarios: report,
  };
}

async function measureAsync(operation) {
  const startedAt = process.hrtime.bigint();
  const value = await operation();
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  return {
    value,
    elapsedMs: Math.round(elapsedMs * 1000) / 1000,
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

function evaluateExpectedResults({
  results,
  expectedResults = null,
  forbiddenResults = null,
}) {
  if (!expectedResults && !forbiddenResults) {
    return null;
  }

  const missingExpected = {};
  const presentForbidden = {};
  let expectedCount = 0;
  let expectedHitCount = 0;
  let forbiddenCount = 0;
  let forbiddenHitCount = 0;

  for (const layer of ["tactics", "invariants", "cases", "evidence"]) {
    const actual = new Set(results?.[layer] ?? []);
    const expected = expectedResults?.[layer] ?? [];
    const forbidden = forbiddenResults?.[layer] ?? [];
    const missing = expected.filter((recordId) => !actual.has(recordId));
    const present = forbidden.filter((recordId) => actual.has(recordId));

    expectedCount += expected.length;
    expectedHitCount += expected.length - missing.length;
    forbiddenCount += forbidden.length;
    forbiddenHitCount += present.length;
    if (missing.length > 0) {
      missingExpected[layer] = missing;
    }
    if (present.length > 0) {
      presentForbidden[layer] = present;
    }
  }

  return {
    passes: Object.keys(missingExpected).length === 0
      && Object.keys(presentForbidden).length === 0,
    expected_count: expectedCount,
    expected_hit_count: expectedHitCount,
    forbidden_count: forbiddenCount,
    forbidden_hit_count: forbiddenHitCount,
    missing_expected: missingExpected,
    present_forbidden: presentForbidden,
  };
}

function summarizeQuality(qualityEntries) {
  const evaluated = qualityEntries.filter(Boolean);
  return {
    evaluated_scenarios: evaluated.length,
    passing_scenarios: evaluated.filter((entry) => entry.passes).length,
    failing_scenarios: evaluated.filter((entry) => !entry.passes).length,
    expected_count: evaluated.reduce((sum, entry) => sum + entry.expected_count, 0),
    expected_hit_count: evaluated.reduce((sum, entry) => sum + entry.expected_hit_count, 0),
    forbidden_count: evaluated.reduce((sum, entry) => sum + entry.forbidden_count, 0),
    forbidden_hit_count: evaluated.reduce((sum, entry) => sum + entry.forbidden_hit_count, 0),
  };
}

module.exports = {
  compareSemanticBackends,
  evaluateExpectedResults,
};
