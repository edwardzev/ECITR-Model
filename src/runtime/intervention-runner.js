const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { RetrievalRuntime } = require("../retrieval/runtime");
const { evaluateRetrievalEligibility } = require("../retrieval/eligibility");
const { expandRelated } = require("../support-graph/query");
const { DEFAULT_GRAPH_ROOT, loadFreshSnapshot } = require("../support-graph/refresh");
const { REPO_ROOT } = require("../validation/schema-registry");

const DEFAULT_ARTIFACT_ROOT = path.join(REPO_ROOT, ".local", "runtime-interventions");
const FAILURE_KINDS = new Set([
  "command_error",
  "test_failure",
  "module_not_found",
  "env_mismatch",
  "permission_issue",
  "unexpected_output",
]);
const INTERVENTION_PROFILES = Object.freeze({
  preflight: Object.freeze({
    intent: "action",
    budgets: Object.freeze({
      tactics: 2,
      invariants: 2,
      cases: 1,
      evidence: 1,
    }),
    priority: Object.freeze(["tactics", "invariants", "cases", "evidence"]),
  }),
  failure_retry: Object.freeze({
    intent: "verification",
    budgets: Object.freeze({
      tactics: 2,
      invariants: 2,
      cases: 2,
      evidence: 2,
    }),
    priority: Object.freeze(["tactics", "cases", "invariants", "evidence"]),
  }),
});
const EMPTY_GROUPED_RESULTS = Object.freeze({
  tactics: [],
  invariants: [],
  cases: [],
  evidence: [],
});
const FAILURE_TEXT_LIMIT = 240;
const GRAPH_EXPANSION_SEED_LIMIT = 2;
const GRAPH_EXPANSION_RESULT_LIMIT = 6;
const GRAPH_EXPANSION_LAYER_LIMIT = 3;

class RuntimeInterventionRunner {
  constructor({
    retrievalRuntime,
    graphRoot = DEFAULT_GRAPH_ROOT,
    artifactRoot = DEFAULT_ARTIFACT_ROOT,
  } = {}) {
    this.graphRoot = path.resolve(graphRoot);
    this.artifactRoot = path.resolve(artifactRoot);
    this.retrievalRuntime = retrievalRuntime ?? new RetrievalRuntime({
      graphRoot: this.graphRoot,
    });
  }

  async run({ intervention, catalogs, now = new Date() }) {
    const validatedIntervention = validateIntervention(intervention);
    const profile = INTERVENTION_PROFILES[validatedIntervention.mode];
    const retrievalRequest = buildInterventionRetrievalRequest({
      intervention: validatedIntervention,
      now,
    });

    const retrievalStartedAt = Date.now();
    const retrieval = await this.retrievalRuntime.execute({
      request: retrievalRequest,
      catalogs,
      now,
    });
    const retrievalLatencyMs = Date.now() - retrievalStartedAt;

    const selectedResults = selectInterventionResults({
      response: retrieval.response,
      profile,
    });
    const weakHit = isWeakHit(selectedResults);

    const graphStartedAt = Date.now();
    const graphOutcome = weakHit
      ? expandGraphCandidates({
        graphRoot: this.graphRoot,
        profile,
        selectedResults,
        catalogs,
        request: retrievalRequest,
        plan: retrieval.plan,
        now,
        projectScope: validatedIntervention.project_scope,
      })
      : {
        relatedCandidates: createEmptyGroupedResults(),
        graphExpansionRan: false,
      };
    const graphExpansionLatencyMs = weakHit ? Date.now() - graphStartedAt : 0;

    const summary = buildSummary({
      intervention: validatedIntervention,
      profile,
      selectedResults,
      weakHit,
      graphExpansionRan: graphOutcome.graphExpansionRan,
    });
    const metrics = buildMetrics({
      retrieval,
      selectedResults,
      weakHit,
      graphExpansionRan: graphOutcome.graphExpansionRan,
      retrievalLatencyMs,
      graphExpansionLatencyMs,
    });
    const artifact = buildArtifact({
      intervention: validatedIntervention,
      retrievalRequest,
      retrieval,
      selectedResults,
      relatedCandidates: graphOutcome.relatedCandidates,
      weakHit,
      graphExpansionRan: graphOutcome.graphExpansionRan,
      summary,
      metrics,
      now,
    });
    const artifactPath = writeArtifact({
      artifactRoot: this.artifactRoot,
      artifact,
      now,
    });

    return {
      retrieval,
      intervention: {
        mode: validatedIntervention.mode,
        selected_results: selectedResults,
        weak_hit: weakHit,
        related_candidates: graphOutcome.relatedCandidates,
        artifact_path: artifactPath,
        summary,
      },
    };
  }
}

function validateIntervention(intervention) {
  if (!intervention || typeof intervention !== "object") {
    throw new Error("Runtime intervention input is required.");
  }

  const mode = String(intervention.mode ?? "");
  if (!Object.prototype.hasOwnProperty.call(INTERVENTION_PROFILES, mode)) {
    throw new Error(`Unsupported runtime intervention mode: ${mode || "<empty>"}`);
  }

  const query = String(intervention.query ?? "").trim();
  if (!query) {
    throw new Error("Runtime intervention query is required.");
  }

  const projectScope = String(intervention.project_scope ?? "");
  if (!["project", "project_family", "global"].includes(projectScope)) {
    throw new Error(`Unsupported runtime intervention project_scope: ${projectScope || "<empty>"}`);
  }

  const normalized = {
    mode,
    query,
    project_scope: projectScope,
  };

  if (mode === "failure_retry") {
    const failureKind = String(intervention.failure_kind ?? "");
    if (!FAILURE_KINDS.has(failureKind)) {
      throw new Error(`Unsupported runtime intervention failure_kind: ${failureKind || "<empty>"}`);
    }

    normalized.failure_kind = failureKind;
    if (intervention.failure_text != null && intervention.failure_text !== "") {
      normalized.failure_text = truncateNormalizedText(intervention.failure_text);
    }
  }

  return normalized;
}

function buildInterventionRetrievalRequest({ intervention, now = new Date() }) {
  const profile = INTERVENTION_PROFILES[intervention.mode];
  const requestHash = hashText(JSON.stringify(intervention)).slice(0, 10);
  const requestTimestamp = sanitizeTimestamp(now.toISOString()).slice(0, 14);

  return {
    request_id: `req_intervention_${intervention.mode}_${requestTimestamp}_${requestHash}`,
    query: composeInterventionQuery(intervention),
    project_scope: intervention.project_scope,
    intent: profile.intent,
    allowed_layers: ["tactics", "invariants", "cases", "evidence"],
    max_results_per_layer: structuredClone(profile.budgets),
  };
}

function composeInterventionQuery(intervention) {
  const parts = [intervention.query];

  if (intervention.mode === "failure_retry") {
    parts.push(String(intervention.failure_kind).replace(/_/g, " "));
    if (intervention.failure_text) {
      parts.push(intervention.failure_text);
    }
  }

  return parts
    .map((part) => String(part).trim())
    .filter(Boolean)
    .join(" ");
}

function truncateNormalizedText(value) {
  return normalizeInterventionText(value).slice(0, FAILURE_TEXT_LIMIT).trim();
}

function normalizeInterventionText(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._:/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function selectInterventionResults({ response, profile }) {
  const selected = createEmptyGroupedResults();

  for (const layer of Object.keys(selected)) {
    selected[layer] = [...(response?.results?.[layer] ?? [])].slice(0, profile.budgets[layer]);
  }

  return selected;
}

function isWeakHit(selectedResults) {
  const tacticCount = selectedResults.tactics.length;
  const caseCount = selectedResults.cases.length;
  const totalCount = countGroupedResults(selectedResults);

  return tacticCount === 0 && caseCount === 0 && totalCount <= 2;
}

function expandGraphCandidates({ graphRoot, profile, selectedResults, catalogs, request, plan, now, projectScope }) {
  const snapshot = loadFreshSnapshot({ graphRoot, catalogs });
  if (!snapshot) {
    return {
      relatedCandidates: createEmptyGroupedResults(),
      graphExpansionRan: false,
    };
  }

  const selectedIds = new Set(flattenGroupedResults(selectedResults));
  const relatedCandidates = createEmptyGroupedResults();
  const seeds = collectSeedIds({ selectedResults, priority: profile.priority });
  if (seeds.length === 0) {
    return {
      relatedCandidates,
      graphExpansionRan: false,
    };
  }

  for (const seedId of seeds) {
    const relatedEntries = expandRelated({
      snapshot,
      nodeId: seedId,
      projectScope,
      maxDepth: 2,
      limit: GRAPH_EXPANSION_RESULT_LIMIT,
      canonicalOnly: true,
    });

    for (const entry of relatedEntries) {
      const layer = toLayerKey(entry.node.node_type);
      if (!layer) {
        continue;
      }
      if (selectedIds.has(entry.node.record_id)) {
        continue;
      }
      if (relatedCandidates[layer].includes(entry.node.record_id)) {
        continue;
      }
      if (relatedCandidates[layer].length >= GRAPH_EXPANSION_LAYER_LIMIT) {
        continue;
      }
      const record = findRecordById({ layer, recordId: entry.node.record_id, catalogs });
      if (!record) {
        continue;
      }
      const eligibility = evaluateRetrievalEligibility({
        layer,
        record,
        request,
        plan,
        now,
      });
      if (eligibility.exclude) {
        continue;
      }

      relatedCandidates[layer].push(entry.node.record_id);
    }
  }

  return {
    relatedCandidates,
    graphExpansionRan: true,
  };
}

function buildSummary({ intervention, profile, selectedResults, weakHit, graphExpansionRan }) {
  const summary = [
    `${intervention.mode} intervention used retrieval intent ${profile.intent}`,
    `selected tactics ${selectedResults.tactics.length}, invariants ${selectedResults.invariants.length}, cases ${selectedResults.cases.length}, evidence ${selectedResults.evidence.length}`,
  ];

  if (intervention.failure_kind) {
    summary.push(`failure context: ${intervention.failure_kind.replace(/_/g, " ")}`);
  }

  if (weakHit) {
    summary.push(graphExpansionRan
      ? "weak direct hit triggered support-graph expansion"
      : "weak direct hit with no support-graph expansion");
    return summary;
  }

  summary.push("direct hit strong enough; support-graph expansion skipped");
  return summary;
}

function buildMetrics({
  retrieval,
  selectedResults,
  weakHit,
  graphExpansionRan,
  retrievalLatencyMs,
  graphExpansionLatencyMs,
}) {
  const conflicts = retrieval?.response?.conflicts ?? [];

  return {
    hit: countGroupedResults(selectedResults) > 0,
    direct_result_count: countGroupedResults(selectedResults),
    weak_hit: weakHit,
    graph_expansion_ran: graphExpansionRan,
    retrieval_latency_ms: retrievalLatencyMs,
    graph_expansion_latency_ms: graphExpansionLatencyMs,
    latency_ms: retrievalLatencyMs + graphExpansionLatencyMs,
    wrong_scope_leak_count: conflicts.filter((message) => /scope .* conflicts with request/.test(message)).length,
    stale_guidance_exclusion_count: conflicts.filter((message) => /^excluded tactic .*:/.test(message)).length,
  };
}

function buildArtifact({
  intervention,
  retrievalRequest,
  retrieval,
  selectedResults,
  relatedCandidates,
  weakHit,
  graphExpansionRan,
  summary,
  metrics,
  now,
}) {
  const artifactTimestamp = now.toISOString();
  return {
    artifact_id: `ri_${intervention.mode}_${sanitizeTimestamp(artifactTimestamp)}_${hashText(JSON.stringify({
      intervention,
      retrievalRequest,
      artifactTimestamp,
    })).slice(0, 12)}`,
    generated_at: artifactTimestamp,
    intervention: {
      ...intervention,
    },
    retrieval_request: retrievalRequest,
    retrieval_results: structuredClone(retrieval.response.results),
    retrieval_conflicts: [...(retrieval.response.conflicts ?? [])],
    selected_results: selectedResults,
    related_candidates: relatedCandidates,
    weak_hit: weakHit,
    graph_expansion_ran: graphExpansionRan,
    summary,
    metrics,
  };
}

function writeArtifact({ artifactRoot, artifact, now = new Date() }) {
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const targetDirectory = path.join(path.resolve(artifactRoot), year, month);

  fs.mkdirSync(targetDirectory, { recursive: true });
  const filePath = path.join(targetDirectory, `${artifact.artifact_id}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  return filePath;
}

function collectSeedIds({ selectedResults, priority }) {
  const seeds = [];

  for (const layer of priority) {
    for (const recordId of selectedResults[layer] ?? []) {
      seeds.push(recordId);
      if (seeds.length >= GRAPH_EXPANSION_SEED_LIMIT) {
        return seeds;
      }
    }
  }

  return seeds;
}

function countGroupedResults(groupedResults) {
  return flattenGroupedResults(groupedResults).length;
}

function flattenGroupedResults(groupedResults) {
  return [
    ...(groupedResults.tactics ?? []),
    ...(groupedResults.invariants ?? []),
    ...(groupedResults.cases ?? []),
    ...(groupedResults.evidence ?? []),
  ];
}

function createEmptyGroupedResults() {
  return {
    tactics: [],
    invariants: [],
    cases: [],
    evidence: [],
  };
}

function toLayerKey(nodeType) {
  switch (nodeType) {
    case "tactic":
      return "tactics";
    case "invariant":
      return "invariants";
    case "case":
      return "cases";
    case "evidence":
      return "evidence";
    default:
      return null;
  }
}

function findRecordById({ layer, recordId, catalogs }) {
  switch (layer) {
    case "tactics":
      return (catalogs.tactics ?? []).find((record) => record.id === recordId) ?? null;
    case "invariants":
      return (catalogs.invariants ?? []).find((record) => record.id === recordId) ?? null;
    case "cases":
      return (catalogs.cases ?? []).find((record) => record.case_id === recordId) ?? null;
    case "evidence":
      return (catalogs.evidence ?? []).find((record) => record.evidence_id === recordId) ?? null;
    default:
      return null;
  }
}

function sanitizeTimestamp(value) {
  return String(value).replace(/[^0-9A-Za-z]+/g, "");
}

function hashText(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}

module.exports = {
  DEFAULT_ARTIFACT_ROOT,
  FAILURE_KINDS,
  INTERVENTION_PROFILES,
  RuntimeInterventionRunner,
  buildInterventionRetrievalRequest,
  composeInterventionQuery,
  normalizeInterventionText,
  truncateNormalizedText,
  isWeakHit,
};
