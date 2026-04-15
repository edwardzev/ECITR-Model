const { evaluateRetrievalEligibility } = require("./eligibility");

function fuseCandidates({ request, plan, laneCandidates, now = new Date() }) {
  const grouped = new Map();
  const conflicts = [];

  for (const candidate of laneCandidates.flat()) {
    const groupingKey = `${candidate.layer}:${candidate.recordId}`;
    const existing = grouped.get(groupingKey);
    if (!existing) {
      grouped.set(groupingKey, {
        layer: candidate.layer,
        recordId: candidate.recordId,
        record: candidate.record,
        score: candidate.score,
        laneIds: [candidate.laneId],
        reasons: [...candidate.reasons],
      });
      continue;
    }

    existing.score = Math.max(existing.score, candidate.score) + 0.05;
    existing.laneIds.push(candidate.laneId);
    existing.reasons.push(...candidate.reasons);
  }

  const perLayer = {
    tactics: [],
    invariants: [],
    cases: [],
    evidence: [],
  };

  for (const aggregated of grouped.values()) {
    const conflictMessages = collectCandidateMessages({ request, plan, aggregated, now });
    if (conflictMessages.exclude) {
      conflicts.push(...conflictMessages.messages);
      continue;
    }

    if (conflictMessages.messages.length > 0) {
      conflicts.push(...conflictMessages.messages);
    }

    perLayer[aggregated.layer].push(aggregated);
  }

  for (const layer of Object.keys(perLayer)) {
    perLayer[layer].sort((left, right) => right.score - left.score);
    perLayer[layer] = perLayer[layer].slice(0, plan.max_results_per_layer[layer] ?? 0);
  }

  const explanations = buildExplanations({ request, plan, perLayer });

  return {
    request_id: request.request_id,
    generated_at: now.toISOString(),
    results: {
      tactics: perLayer.tactics.map((candidate) => candidate.recordId),
      invariants: perLayer.invariants.map((candidate) => candidate.recordId),
      cases: perLayer.cases.map((candidate) => candidate.recordId),
      evidence: perLayer.evidence.map((candidate) => candidate.recordId),
    },
    explanations,
    conflicts,
  };
}

function collectCandidateMessages({ request, plan, aggregated, now }) {
  const messages = [];

  const eligibility = evaluateRetrievalEligibility({
    layer: aggregated.layer,
    record: aggregated.record,
    request,
    plan,
    now,
  });
  if (eligibility.exclude) {
    messages.push(eligibility.message);
    return { exclude: true, messages };
  }

  if (aggregated.laneIds.length > 1) {
    messages.push(`fused ${aggregated.recordId} across lanes: ${aggregated.laneIds.join(", ")}`);
  }

  if (plan.require_evidence && aggregated.layer === "evidence") {
    messages.push(`evidence ${aggregated.recordId} retained due to proof-oriented request`);
  }

  return { exclude: false, messages };
}

function buildExplanations({ request, plan, perLayer }) {
  const explanations = [
    `retrieval intent ${request.intent} executed with layers: ${plan.allowed_layers.join(", ")}`,
  ];

  for (const layer of plan.allowed_layers) {
    const count = perLayer[layer]?.length ?? 0;
    explanations.push(`layer ${layer} returned ${count} result(s) within budget ${plan.max_results_per_layer[layer] ?? 0}`);
  }

  return explanations;
}

module.exports = {
  fuseCandidates,
};
