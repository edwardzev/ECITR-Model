const { confidenceRank } = require("../support-graph/types");
const { expandRelated, listNeighbors } = require("../support-graph/query");
const { DEFAULT_GRAPH_ROOT, loadFreshSnapshot } = require("../support-graph/refresh");

const MAX_GRAPH_EXPLANATIONS = 6;
const ALLOWED_CONFIDENCE_LABELS = new Set(["DECLARED", "EXTRACTED"]);
const EXPLANATION_TARGET_TYPES = Object.freeze({
  tactics: new Set(["case", "invariant", "evidence", "parameter_observation", "parameter_definition"]),
  invariants: new Set(["case", "evidence", "parameter_observation", "parameter_definition"]),
  cases: new Set(["evidence", "parameter_observation", "parameter_definition"]),
  evidence: new Set(["parameter_observation", "parameter_definition", "atomic_claim_set", "source_artifact"]),
});

function enrichResponseWithSupportGraph({
  response,
  request,
  plan,
  catalogs,
  graphRoot = DEFAULT_GRAPH_ROOT,
} = {}) {
  const enrichment = generateSupportGraphEnrichment({
    response,
    request,
    plan,
    catalogs,
    graphRoot,
  });

  if (enrichment.explanations.length === 0) {
    return response;
  }

  return {
    ...response,
    explanations: [
      ...(response.explanations ?? []),
      ...enrichment.explanations,
    ],
  };
}

function generateSupportGraphEnrichment({
  response,
  request,
  plan,
  catalogs,
  graphRoot = DEFAULT_GRAPH_ROOT,
} = {}) {
  const snapshot = loadFreshSnapshot({ graphRoot, catalogs });
  const diagnostics = {
    graph_snapshot_used: Boolean(snapshot),
    explanation_count_added: 0,
    stale_or_missing_skip_count: snapshot ? 0 : 1,
    wrong_scope_suppression_count: 0,
  };

  if (!snapshot) {
    return {
      explanations: [],
      diagnostics,
    };
  }

  const explanations = [];

  for (const layer of plan.allowed_layers ?? ["tactics", "invariants", "cases", "evidence"]) {
    for (const recordId of response?.results?.[layer] ?? []) {
      if (explanations.length >= MAX_GRAPH_EXPLANATIONS) {
        break;
      }

      const result = selectExplanationPath({
        snapshot,
        layer,
        recordId,
        projectScope: request.project_scope,
      });
      diagnostics.wrong_scope_suppression_count += result.wrongScopeSuppressionCount;
      if (!result.explanation) {
        continue;
      }

      explanations.push(result.explanation);
    }

    if (explanations.length >= MAX_GRAPH_EXPLANATIONS) {
      break;
    }
  }

  diagnostics.explanation_count_added = explanations.length;

  return {
    explanations,
    diagnostics,
  };
}

function selectExplanationPath({ snapshot, layer, recordId, projectScope }) {
  const oneHop = listNeighbors({
    snapshot,
    nodeId: recordId,
    projectScope,
    limit: 100,
  });
  const candidates = [];
  let wrongScopeSuppressionCount = 0;

  for (const entry of oneHop) {
    if (!ALLOWED_CONFIDENCE_LABELS.has(entry.edge.confidence_label)) {
      continue;
    }
    if (!isAllowedTarget({ layer, nodeType: entry.node.node_type })) {
      if (isSameTypeScopeSuppressed({ layer, nodeType: entry.node.node_type, projectScope, nodeScope: entry.node.project_scope })) {
        wrongScopeSuppressionCount += 1;
      }
      continue;
    }

    candidates.push({
      node: entry.node,
      distance: 1,
      steps: [
        {
          kind: entry.edge.kind,
          confidence_label: entry.edge.confidence_label,
        },
      ],
    });
  }

  if (candidates.length === 0) {
    const expanded = expandRelated({
      snapshot,
      nodeId: recordId,
      projectScope,
      maxDepth: 2,
      limit: 100,
      canonicalOnly: false,
    });

    for (const entry of expanded) {
      if (entry.distance > 2) {
        continue;
      }
      if (!isAllowedTarget({ layer, nodeType: entry.node.node_type })) {
        continue;
      }
      if (!entry.example_path?.steps?.every((step) => ALLOWED_CONFIDENCE_LABELS.has(step.confidence_label))) {
        continue;
      }

      candidates.push({
        node: entry.node,
        distance: entry.distance,
        steps: entry.example_path.steps.map((step) => ({
          kind: step.kind,
          confidence_label: step.confidence_label,
        })),
      });
    }
  }

  if (candidates.length === 0) {
    return {
      explanation: null,
      wrongScopeSuppressionCount,
    };
  }

  candidates.sort((left, right) =>
    left.distance - right.distance
    || strongestPathRank(right.steps) - strongestPathRank(left.steps)
    || left.node.node_id.localeCompare(right.node.node_id));

  return {
    explanation: formatExplanation({ layer, recordId, candidate: candidates[0] }),
    wrongScopeSuppressionCount,
  };
}

function formatExplanation({ layer, recordId, candidate }) {
  const sourceLabel = toSingularLayerLabel(layer);
  const targetLabel = candidate.node.node_type.replace(/_/g, " ");
  const via = candidate.steps
    .map((step) => `${step.confidence_label.toLowerCase()} ${step.kind}`)
    .join(" -> ");

  return `graph support: ${sourceLabel} ${recordId} linked to ${targetLabel} ${candidate.node.record_id} via ${via}`;
}

function strongestPathRank(steps) {
  return Math.max(...steps.map((step) => confidenceRank(step.confidence_label)));
}

function isAllowedTarget({ layer, nodeType }) {
  return EXPLANATION_TARGET_TYPES[layer]?.has(nodeType) ?? false;
}

function isSameTypeScopeSuppressed({ layer, nodeType, projectScope, nodeScope }) {
  const expectedType = toSingularLayerLabel(layer);
  return (
    nodeType === expectedType
    && nodeScope
    && nodeScope !== "global"
    && projectScope !== "global"
    && nodeScope !== projectScope
  );
}

function toSingularLayerLabel(layer) {
  switch (layer) {
    case "tactics":
      return "tactic";
    case "invariants":
      return "invariant";
    case "cases":
      return "case";
    case "evidence":
      return "evidence";
    default:
      return layer;
  }
}

module.exports = {
  enrichResponseWithSupportGraph,
  generateSupportGraphEnrichment,
};
