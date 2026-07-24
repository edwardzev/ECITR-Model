const { evaluateRetrievalEligibility } = require("./eligibility");

const MAX_PUBLIC_CONFLICTS = 7;
const MAX_PUBLIC_CONFLICT_EXAMPLES = MAX_PUBLIC_CONFLICTS - 1;
const fusionDiagnosticsByResponse = new WeakMap();

function fuseCandidates({ request, plan, laneCandidates, now = new Date() }) {
  const grouped = new Map();
  const conflictExamples = [];
  const exclusionCounts = {};
  let excludedCount = 0;

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
        semanticQualified: Boolean(candidate.semanticQualified),
      });
      continue;
    }

    existing.score = Math.max(existing.score, candidate.score) + 0.05;
    existing.laneIds.push(candidate.laneId);
    existing.reasons.push(...candidate.reasons);
    existing.semanticQualified ||= Boolean(candidate.semanticQualified);
  }

  const perLayer = {
    tactics: [],
    invariants: [],
    cases: [],
    evidence: [],
  };

  for (const aggregated of grouped.values()) {
    const admission = evaluateCandidateAdmission({ request, plan, aggregated, now });
    if (admission.exclude) {
      excludedCount += 1;
      exclusionCounts[admission.code] = (exclusionCounts[admission.code] ?? 0) + 1;
      if (conflictExamples.length < MAX_PUBLIC_CONFLICT_EXAMPLES) {
        conflictExamples.push(...admission.messages);
      }
      continue;
    }

    perLayer[aggregated.layer].push(aggregated);
  }

  for (const layer of Object.keys(perLayer)) {
    perLayer[layer].sort((left, right) =>
      right.score - left.score
      || getCandidateTimestamp(right) - getCandidateTimestamp(left)
      || left.recordId.localeCompare(right.recordId));
    if (layer === "evidence") {
      perLayer[layer] = diversifyEvidenceByLineage(perLayer[layer]);
    }
    perLayer[layer] = perLayer[layer].slice(0, plan.max_results_per_layer[layer] ?? 0);
  }

  const explanations = buildExplanations({ request, plan, perLayer });
  const selectedCount = Object.values(perLayer)
    .reduce((total, candidates) => total + candidates.length, 0);
  if (selectedCount === 0) {
    explanations.push("retrieval abstained: no eligible relevant records matched the request");
  }

  const response = {
    request_id: request.request_id,
    generated_at: now.toISOString(),
    results: {
      tactics: perLayer.tactics.map((candidate) => candidate.recordId),
      invariants: perLayer.invariants.map((candidate) => candidate.recordId),
      cases: perLayer.cases.map((candidate) => candidate.recordId),
      evidence: perLayer.evidence.map((candidate) => candidate.recordId),
    },
    explanations,
    conflicts: buildPublicConflictMessages({
      examples: conflictExamples,
      excludedCount,
      exclusionCounts,
    }),
  };
  fusionDiagnosticsByResponse.set(response, {
    excluded_count: excludedCount,
    excluded_by_code: exclusionCounts,
  });
  return response;
}

function getFusionDiagnostics(response) {
  return fusionDiagnosticsByResponse.get(response) ?? null;
}

function evaluateCandidateAdmission({ request, plan, aggregated, now }) {
  const messages = [];

  const relevance = evaluateCandidateRelevance({ request, aggregated });
  if (!relevance.relevant) {
    messages.push(
      `excluded ${aggregated.layer.slice(0, -1)} ${aggregated.recordId}: ${relevance.message}`,
    );
    return {
      exclude: true,
      code: "low_relevance",
      messages,
    };
  }

  const eligibility = evaluateRetrievalEligibility({
    layer: aggregated.layer,
    record: aggregated.record,
    request,
    plan,
    now,
  });
  if (eligibility.exclude) {
    messages.push(eligibility.message);
    return {
      exclude: true,
      code: eligibility.code,
      messages,
    };
  }

  return {
    exclude: false,
    code: null,
    messages,
  };
}

function evaluateCandidateRelevance({ request, aggregated }) {
  const laneIds = new Set(aggregated.laneIds);
  const hasDirectTextSupport = laneIds.has("lexical") || laneIds.has("metadata");

  if (isExactIdentifierQuery(request.query) && !hasDirectTextSupport) {
    return {
      relevant: false,
      message: "exact identifier queries require lexical or metadata support",
    };
  }

  if (laneIds.size === 1 && laneIds.has("semantic") && !aggregated.semanticQualified) {
    return {
      relevant: false,
      message: "semantic-only candidate was not qualified by its backend",
    };
  }

  return {
    relevant: true,
    message: null,
  };
}

function diversifyEvidenceByLineage(candidates) {
  const seen = new Set();
  const diversified = [];

  for (const candidate of candidates) {
    const lineageKey = getEvidenceLineageKey(candidate.record);
    if (seen.has(lineageKey)) {
      continue;
    }
    seen.add(lineageKey);
    diversified.push(candidate);
  }

  return diversified;
}

function getEvidenceLineageKey(record) {
  if (record.source_locator) {
    return `source:${record.workspace_id ?? "<missing>"}:${record.source_locator}`;
  }
  if (record.correction_of) {
    return `correction:${record.correction_of}`;
  }
  return `evidence:${record.evidence_id}`;
}

function getCandidateTimestamp(candidate) {
  const timestamp = candidate.layer === "evidence"
    ? candidate.record.captured_at
    : candidate.record.updated_at ?? candidate.record.derived_at ?? candidate.record.created_at;
  const time = timestamp ? new Date(timestamp).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function isExactIdentifierQuery(query) {
  const value = String(query ?? "").trim();
  return value.length >= 3
    && /^[A-Za-z][A-Za-z0-9_.:-]+$/.test(value)
    && /[_:.]/.test(value);
}

function buildPublicConflictMessages({
  examples,
  excludedCount,
  exclusionCounts,
}) {
  if (excludedCount <= examples.length) {
    return examples;
  }

  const summary = Object.entries(exclusionCounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, count]) => `${code}=${count}`)
    .join(", ");
  return [
    ...examples,
    `suppressed ${excludedCount - examples.length} additional retrieval exclusion(s); totals: ${summary}`,
  ];
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
  MAX_PUBLIC_CONFLICTS,
  fuseCandidates,
  getFusionDiagnostics,
};
