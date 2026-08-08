const { RetrievalLane } = require("./lane-interface");
const { assertSemanticRetrievalBackend } = require("./semantic-backend-interface");
const { HeuristicSemanticBackend } = require("./semantic-backends/heuristic-backend");
const { buildEvidenceRetrievalText } = require("./evidence-text");
const { tokenizeRetrievalText } = require("./tokenizer");
const { buildParameterIndexes, buildParameterSummaryForRecord } = require("../parameters/retrieval");

class LexicalLane extends RetrievalLane {
  constructor({ catalogs }) {
    super({
      laneId: "lexical",
      supportedLayers: ["tactics", "invariants", "cases", "evidence"],
    });
    this.catalogs = catalogs;
    this.parameterIndexes = buildParameterIndexes(catalogs);
  }

  async execute({ request, plan }) {
    const queryTokens = tokenizeRetrievalText(request.query);
    const candidates = [];

    for (const layer of plan.allowed_layers) {
      for (const record of this.catalogs[layer] ?? []) {
        if (!isRetrievableRecord(layer, record)) {
          continue;
        }
        const haystack = getSearchText(layer, record, {
          catalogRoot: this.catalogs?.__catalogRoot,
          parameterIndexes: this.parameterIndexes,
        });
        const score = scoreTokenOverlap(queryTokens, tokenizeRetrievalText(haystack));
        if (score <= 0) {
          continue;
        }

        candidates.push(makeCandidate({ layer, laneId: this.laneId, score, record, reason: "lexical overlap" }));
      }
    }

    return candidates;
  }
}

class MetadataLane extends RetrievalLane {
  constructor({ catalogs }) {
    super({
      laneId: "metadata",
      supportedLayers: ["tactics", "invariants", "cases", "evidence"],
    });
    this.catalogs = catalogs;
    this.parameterIndexes = buildParameterIndexes(catalogs);
  }

  async execute({ request, plan }) {
    const queryTokens = tokenizeRetrievalText(request.query);
    const candidates = [];

    for (const layer of plan.allowed_layers) {
      for (const record of this.catalogs[layer] ?? []) {
        if (!isRetrievableRecord(layer, record)) {
          continue;
        }
        const metadata = getMetadataText(layer, record, this.parameterIndexes);
        const score = scoreTokenOverlap(queryTokens, tokenizeRetrievalText(metadata));
        if (score <= 0) {
          continue;
        }

        candidates.push(makeCandidate({ layer, laneId: this.laneId, score, record, reason: "metadata overlap" }));
      }
    }

    return candidates;
  }
}

class SemanticLane extends RetrievalLane {
  constructor({ catalogs, backend = new HeuristicSemanticBackend({ catalogs }) }) {
    super({
      laneId: "semantic",
      supportedLayers: ["tactics", "invariants", "cases", "evidence"],
    });
    this.catalogs = catalogs;
    this.backend = assertSemanticRetrievalBackend(backend);
  }

  async execute({ request, plan, now }) {
    return this.backend.retrieve({ request, plan, now });
  }
}

class TemporalLane extends RetrievalLane {
  constructor({ catalogs }) {
    super({
      laneId: "temporal",
      supportedLayers: ["tactics", "invariants", "cases", "evidence"],
    });
    this.catalogs = catalogs;
  }

  async execute({ request, plan, now }) {
    const candidates = [];
    const queryTokens = tokenizeRetrievalText(request.query);
    const recencySensitive =
      plan.freshness_mode === "strict" ||
      /\brecent\b|\blatest\b|\bcurrent\b|\bnew\b|\btoday\b/.test(String(request.query).toLowerCase()) ||
      request.intent === "action";

    if (!recencySensitive) {
      return [];
    }

    for (const layer of plan.allowed_layers) {
      for (const record of this.catalogs[layer] ?? []) {
        if (!isRetrievableRecord(layer, record)) {
          continue;
        }
        const searchText = getSearchText(layer, record, {
          catalogRoot: this.catalogs?.__catalogRoot,
        });
        const overlapScore = scoreTokenOverlap(queryTokens, tokenizeRetrievalText(searchText));
        if (overlapScore <= 0) {
          continue;
        }
        const timestamp = getPrimaryTimestamp(layer, record);
        if (!timestamp) {
          continue;
        }

        const score = scoreTemporalRecency({ layer, timestamp, now, request })
          * (0.5 + (0.5 * overlapScore));
        if (score <= 0) {
          continue;
        }

        candidates.push(
          makeCandidate({
            layer,
            laneId: this.laneId,
            score,
            record,
            reason: "temporal recency",
          }),
        );
      }
    }

    return candidates;
  }
}

function buildDefaultLanes({ catalogs, semanticBackend } = {}) {
  return [
    new LexicalLane({ catalogs }),
    new MetadataLane({ catalogs }),
    new SemanticLane({ catalogs, backend: semanticBackend ?? new HeuristicSemanticBackend({ catalogs }) }),
    new TemporalLane({ catalogs }),
  ];
}

function makeCandidate({ layer, laneId, score, record, reason }) {
  return {
    recordId: getRecordId(layer, record),
    layer,
    laneId,
    score,
    record,
    reasons: [reason],
  };
}

function getRecordId(layer, record) {
  switch (layer) {
    case "tactics":
    case "invariants":
      return record.id;
    case "cases":
      return record.case_id;
    case "evidence":
      return record.evidence_id;
    default:
      throw new Error(`Unsupported layer: ${layer}`);
  }
}

function getSearchText(layer, record, { catalogRoot, parameterIndexes } = {}) {
  switch (layer) {
    case "tactics":
      return [
        record.title,
        record.summary,
        record.action,
        ...(record.steps ?? []),
        buildParameterSummaryForRecord(layer, record, parameterIndexes),
      ].join(" ");
    case "invariants":
      return [record.title, record.summary, record.statement, ...(record.scope ?? [])].join(" ");
    case "cases":
      return [
        record.problem_statement,
        record.action_taken,
        record.outcome,
        record.failure_mode,
        buildParameterSummaryForRecord(layer, record, parameterIndexes),
      ].filter(Boolean).join(" ");
    case "evidence":
      return buildEvidenceRetrievalText(record, {
        catalogRoot,
        parameterIndexes,
      });
    default:
      return "";
  }
}

function getMetadataText(layer, record, parameterIndexes) {
  switch (layer) {
    case "tactics":
      return [
        record.series_key,
        ...(record.tool_binding ?? []),
        ...(record.environment_bounds ?? []),
        buildParameterSummaryForRecord(layer, record, parameterIndexes),
      ].join(" ");
    case "invariants":
      return [record.series_key, ...(record.scope ?? []), ...(record.non_scope ?? [])].join(" ");
    case "cases":
      return [
        record.context?.project_scope,
        ...(record.context?.toolchain ?? []),
        ...(record.context?.constraints ?? []),
        buildParameterSummaryForRecord(layer, record, parameterIndexes),
      ].join(" ");
    case "evidence":
      return [
        record.project_scope,
        record.actor_scope,
        record.source_type,
        buildParameterSummaryForRecord(layer, record, parameterIndexes),
      ].join(" ");
    default:
      return "";
  }
}

function getPrimaryTimestamp(layer, record) {
  switch (layer) {
    case "tactics":
    case "invariants":
      return record.updated_at ?? record.created_at;
    case "cases":
      return record.derived_at;
    case "evidence":
      return record.captured_at;
    default:
      return null;
  }
}

function scoreTokenOverlap(queryTokens, haystackTokens) {
  if (queryTokens.length === 0 || haystackTokens.length === 0) {
    return 0;
  }

  const haystack = new Set(haystackTokens);
  let matches = 0;
  for (const token of queryTokens) {
    if (haystack.has(token)) {
      matches += 1;
    }
  }

  return matches / queryTokens.length;
}

function scoreTemporalRecency({ layer, timestamp, now, request }) {
  const ageMs = Math.max(0, new Date(now).getTime() - new Date(timestamp).getTime());
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  const halfLifeByLayer = {
    tactics: 45,
    invariants: 180,
    cases: 120,
    evidence: 365,
  };

  const intentWeight = request.intent === "action" ? 0.45 : 0.3;
  const halfLife = halfLifeByLayer[layer] ?? 120;
  return intentWeight / (1 + ageDays / halfLife);
}

function isRetrievableRecord(layer, record) {
  return layer === "evidence" || record.status === "active";
}

module.exports = {
  buildDefaultLanes,
  SemanticLane,
};
