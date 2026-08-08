const { RetrievalGate } = require("./retrieval-gate");
const { tokenizeRetrievalText } = require("./tokenizer");

function compareRetrievalTokenizers({ scenarios, resultLimit = 1 } = {}) {
  if (!Array.isArray(scenarios)) {
    throw new Error("compareRetrievalTokenizers requires a scenarios array.");
  }

  const variants = {
    legacy_ascii_v1: legacyAsciiTokenizer,
    unicode_v2: tokenizeRetrievalText,
  };
  const reports = Object.fromEntries(
    Object.entries(variants).map(([variant, tokenizer]) => [
      variant,
      scenarios.map((scenario) => evaluateTokenizerScenario({
        scenario,
        tokenizer,
        resultLimit,
      })),
    ]),
  );

  return {
    scenario_count: scenarios.length,
    variants: Object.fromEntries(
      Object.entries(reports).map(([variant, scenarioReports]) => [
        variant,
        summarizeTokenizerScenarios(scenarioReports),
      ]),
    ),
    scenarios: scenarios.map((scenario, index) => ({
      scenario_id: scenario.scenario_id,
      category: scenario.category,
      legacy_ascii_v1: reports.legacy_ascii_v1[index],
      unicode_v2: reports.unicode_v2[index],
    })),
  };
}

function runRetrievalGateBenchmark({ scenarios, gate = new RetrievalGate() } = {}) {
  if (!Array.isArray(scenarios)) {
    throw new Error("runRetrievalGateBenchmark requires a scenarios array.");
  }

  const reports = scenarios.map((scenario) => {
    const actual = gate.evaluate({
      query: scenario.query,
      intent: scenario.intent,
      trigger: scenario.trigger,
      projectConfig: scenario.project_config ?? {},
    });
    const expected = scenario.expected;
    const decisionMatches = actual.decision === expected.decision;
    const proposedDecisionMatches = actual.proposed_decision === expected.proposed_decision;
    const usefulnessEvaluated = typeof expected.query_useful === "boolean";
    const queryUsefulnessMatches = !usefulnessEvaluated
      || actual.query_assessment.useful === expected.query_useful;
    const mandatoryViolation = Boolean(expected.mandatory)
      && (
        actual.decision !== "retrieve"
        || actual.mandatory_policy.applied !== true
        || (expected.mandatory_override === true && actual.mandatory_override !== true)
      );

    return {
      scenario_id: scenario.scenario_id,
      category: scenario.category,
      expected,
      actual,
      decision_matches: decisionMatches,
      proposed_decision_matches: proposedDecisionMatches,
      query_usefulness_matches: queryUsefulnessMatches,
      mandatory_policy_violation: mandatoryViolation,
    };
  });

  const expectedRetrieve = reports.filter((report) => report.expected.decision === "retrieve");
  const expectedSkip = reports.filter((report) => report.expected.decision === "skip");
  const falseNegatives = expectedRetrieve.filter((report) => report.actual.decision === "skip");
  const falsePositives = expectedSkip.filter((report) => report.actual.decision === "retrieve");
  const proposedExpectedRetrieve = reports.filter((report) => report.expected.proposed_decision === "retrieve");
  const proposedExpectedSkip = reports.filter((report) => report.expected.proposed_decision === "skip");
  const proposedFalseNegatives = proposedExpectedRetrieve
    .filter((report) => report.actual.proposed_decision === "skip");
  const proposedFalsePositives = proposedExpectedSkip
    .filter((report) => report.actual.proposed_decision === "retrieve");
  const criticalFalseNegatives = reports.filter((report) =>
    report.expected.critical
    && report.expected.decision === "retrieve"
    && report.actual.decision === "skip");
  const mandatoryViolations = reports.filter((report) => report.mandatory_policy_violation);
  const usefulnessReports = reports.filter((report) => typeof report.expected.query_useful === "boolean");
  const correctDecisions = reports.filter((report) => report.decision_matches).length;
  const correctProposedDecisions = reports.filter((report) => report.proposed_decision_matches).length;
  const correctUsefulness = usefulnessReports.filter((report) => report.query_usefulness_matches).length;
  const mandatoryOverrides = reports.filter((report) => report.actual.mandatory_override);

  return {
    gate_id: gate.gateId,
    mode: "shadow",
    scenario_count: reports.length,
    metrics: {
      accuracy: ratio(correctDecisions, reports.length),
      recall: ratio(expectedRetrieve.length - falseNegatives.length, expectedRetrieve.length),
      specificity: ratio(expectedSkip.length - falsePositives.length, expectedSkip.length),
      false_negative_count: falseNegatives.length,
      false_positive_count: falsePositives.length,
      proposed_accuracy: ratio(correctProposedDecisions, reports.length),
      proposed_recall: ratio(
        proposedExpectedRetrieve.length - proposedFalseNegatives.length,
        proposedExpectedRetrieve.length,
      ),
      proposed_specificity: ratio(
        proposedExpectedSkip.length - proposedFalsePositives.length,
        proposedExpectedSkip.length,
      ),
      proposed_false_negative_count: proposedFalseNegatives.length,
      proposed_false_positive_count: proposedFalsePositives.length,
      critical_false_negative_count: criticalFalseNegatives.length,
      mandatory_policy_violation_count: mandatoryViolations.length,
      mandatory_override_count: mandatoryOverrides.length,
      query_usefulness_accuracy: ratio(correctUsefulness, usefulnessReports.length),
    },
    false_negatives: falseNegatives.map(summarizeGateMismatch),
    false_positives: falsePositives.map(summarizeGateMismatch),
    proposed_false_negatives: proposedFalseNegatives.map(summarizeGateMismatch),
    proposed_false_positives: proposedFalsePositives.map(summarizeGateMismatch),
    mandatory_policy_violations: mandatoryViolations.map(summarizeGateMismatch),
    acceptance: {
      passes: criticalFalseNegatives.length === 0 && mandatoryViolations.length === 0,
      zero_critical_false_negatives: criticalFalseNegatives.length === 0,
      zero_mandatory_policy_violations: mandatoryViolations.length === 0,
      recommendation: "keep_shadow_until_live_labeled_observations_validate_false_negative_risk",
    },
    scenarios: reports,
  };
}

function evaluateTokenizerScenario({ scenario, tokenizer, resultLimit }) {
  const queryTokens = tokenizer(scenario.query);
  const ranked = (scenario.candidates ?? [])
    .map((candidate) => ({
      candidate_id: candidate.candidate_id,
      score: scoreTokenOverlap(queryTokens, tokenizer(candidate.text)),
      context_chars: String(candidate.text ?? "").length,
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) =>
      right.score - left.score
      || left.candidate_id.localeCompare(right.candidate_id));
  const selected = ranked.slice(0, scenario.result_limit ?? resultLimit);
  const selectedIds = selected.map((candidate) => candidate.candidate_id);
  const expectedIds = scenario.expected_ids ?? [];
  const forbiddenIds = scenario.forbidden_ids ?? [];
  const missingExpected = expectedIds.filter((candidateId) => !selectedIds.includes(candidateId));
  const presentForbidden = forbiddenIds.filter((candidateId) => selectedIds.includes(candidateId));
  const firstRelevantRank = ranked.findIndex((candidate) => expectedIds.includes(candidate.candidate_id));

  return {
    query_token_count: queryTokens.length,
    selected_ids: selectedIds,
    returned_count: selected.length,
    expected_hit_count: expectedIds.length - missingExpected.length,
    expected_count: expectedIds.length,
    missing_expected: missingExpected,
    present_forbidden: presentForbidden,
    reciprocal_rank: firstRelevantRank >= 0 ? 1 / (firstRelevantRank + 1) : 0,
    context_chars: selected.reduce((sum, candidate) => sum + candidate.context_chars, 0),
    passes: missingExpected.length === 0 && presentForbidden.length === 0,
  };
}

function summarizeTokenizerScenarios(reports) {
  const positive = reports.filter((report) => report.expected_count > 0);
  const negative = reports.filter((report) => report.expected_count === 0);
  const expectedCount = reports.reduce((sum, report) => sum + report.expected_count, 0);
  const expectedHitCount = reports.reduce((sum, report) => sum + report.expected_hit_count, 0);
  const returnedCount = reports.reduce((sum, report) => sum + report.returned_count, 0);

  return {
    evaluated_scenarios: reports.length,
    passing_scenarios: reports.filter((report) => report.passes).length,
    failing_scenarios: reports.filter((report) => !report.passes).length,
    expected_count: expectedCount,
    expected_hit_count: expectedHitCount,
    hit_rate: ratio(expectedHitCount, expectedCount),
    precision: ratio(expectedHitCount, returnedCount),
    mean_reciprocal_rank: ratio(
      positive.reduce((sum, report) => sum + report.reciprocal_rank, 0),
      positive.length,
    ),
    negative_scenarios: negative.length,
    negative_retrieval_count: negative.filter((report) => report.returned_count > 0).length,
    returned_candidate_count: returnedCount,
    context_chars: reports.reduce((sum, report) => sum + report.context_chars, 0),
  };
}

function scoreTokenOverlap(queryTokens, candidateTokens) {
  if (queryTokens.length === 0 || candidateTokens.length === 0) {
    return 0;
  }

  const candidateSet = new Set(candidateTokens);
  const uniqueQueryTokens = [...new Set(queryTokens)];
  const matches = uniqueQueryTokens.filter((token) => candidateSet.has(token)).length;
  return matches / uniqueQueryTokens.length;
}

function legacyAsciiTokenizer(value) {
  return String(value ?? "")
    .toLowerCase()
    .split(/[^a-z0-9_:-]+/i)
    .filter(Boolean);
}

function summarizeGateMismatch(report) {
  return {
    scenario_id: report.scenario_id,
    category: report.category,
    expected_decision: report.expected.decision,
    actual_decision: report.actual.decision,
    expected_proposed_decision: report.expected.proposed_decision,
    actual_proposed_decision: report.actual.proposed_decision,
  };
}

function ratio(numerator, denominator) {
  if (denominator === 0) {
    return null;
  }
  return Math.round((numerator / denominator) * 10000) / 10000;
}

module.exports = {
  compareRetrievalTokenizers,
  legacyAsciiTokenizer,
  runRetrievalGateBenchmark,
};
