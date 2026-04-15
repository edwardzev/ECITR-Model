const fs = require("node:fs");
const path = require("node:path");

const { REPO_ROOT } = require("../validation/schema-registry");
const { EcitrValidator } = require("../validation/validator");

const DEFAULT_PROFILES = Object.freeze({
  action: {
    allowed_layers: ["tactics", "invariants", "cases", "evidence"],
    max_results_per_layer: { tactics: 3, invariants: 5, cases: 5, evidence: 2 },
    freshness_mode: "strict",
    require_evidence: false,
  },
  analysis: {
    allowed_layers: ["tactics", "invariants", "cases", "evidence"],
    max_results_per_layer: { tactics: 3, invariants: 5, cases: 6, evidence: 3 },
    freshness_mode: "balanced",
    require_evidence: false,
  },
  audit: {
    allowed_layers: ["tactics", "invariants", "cases", "evidence"],
    max_results_per_layer: { tactics: 2, invariants: 4, cases: 6, evidence: 5 },
    freshness_mode: "strict",
    require_evidence: true,
  },
  verification: {
    allowed_layers: ["tactics", "invariants", "cases", "evidence"],
    max_results_per_layer: { tactics: 2, invariants: 4, cases: 5, evidence: 5 },
    freshness_mode: "strict",
    require_evidence: true,
  },
  research: {
    allowed_layers: ["invariants", "cases", "evidence"],
    max_results_per_layer: { invariants: 6, cases: 6, evidence: 4 },
    freshness_mode: "balanced",
    require_evidence: false,
  },
  other: {
    allowed_layers: ["tactics", "invariants", "cases", "evidence"],
    max_results_per_layer: { tactics: 3, invariants: 5, cases: 5, evidence: 3 },
    freshness_mode: "balanced",
    require_evidence: false,
  },
});

class RetrievalPlanner {
  constructor({ validator = new EcitrValidator() } = {}) {
    this.validator = validator;
  }

  plan(request) {
    this.validator.validateRecord("retrieval_request", request);

    const profile = clone(DEFAULT_PROFILES[request.intent] ?? DEFAULT_PROFILES.other);
    const allowedLayers = request.allowed_layers ? [...request.allowed_layers] : [...profile.allowed_layers];
    const requestedBudgets = request.max_results_per_layer ?? {};
    const maxResultsPerLayer = {};

    for (const layer of allowedLayers) {
      const requested = requestedBudgets[layer];
      const fallback = profile.max_results_per_layer[layer] ?? 0;
      maxResultsPerLayer[layer] = requested ?? fallback;
    }

    if (profile.require_evidence && !allowedLayers.includes("evidence")) {
      allowedLayers.push("evidence");
      maxResultsPerLayer.evidence = requestedBudgets.evidence ?? profile.max_results_per_layer.evidence;
    }

    return {
      request_id: request.request_id,
      intent: request.intent,
      project_scope: request.project_scope,
      allowed_layers: allowedLayers,
      max_results_per_layer: maxResultsPerLayer,
      freshness_mode: profile.freshness_mode,
      require_evidence: profile.require_evidence,
    };
  }
}

function loadPlannerBaselineScenarios() {
  const baselinePath = path.join(REPO_ROOT, "benchmarks", "retrieval-planner.baseline.json");
  return JSON.parse(fs.readFileSync(baselinePath, "utf8"));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  DEFAULT_PROFILES,
  RetrievalPlanner,
  loadPlannerBaselineScenarios,
};
