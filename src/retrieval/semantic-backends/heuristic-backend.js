const { SemanticRetrievalBackend } = require("../semantic-backend-interface");
const { buildEvidenceRetrievalText } = require("../evidence-text");

class HeuristicSemanticBackend extends SemanticRetrievalBackend {
  constructor({ catalogs }) {
    super({
      backendId: "heuristic-semantic-v1",
      capabilities: ["token-normalization", "atomic-claim-support", "soft-overlap"],
    });

    this.catalogs = catalogs;
    this.atomicClaimsByEvidence = buildAtomicClaimIndex(catalogs.atomic_claim_sets ?? []);
  }

  async retrieve({ request, plan }) {
    const queryTokens = semanticTokens(request.query);
    const candidates = [];

    for (const layer of plan.allowed_layers) {
      for (const record of this.catalogs[layer] ?? []) {
        if (!isRetrievableRecord(layer, record)) {
          continue;
        }
        const haystack = getSemanticText(layer, record, this.atomicClaimsByEvidence, {
          catalogRoot: this.catalogs?.__catalogRoot,
        });
        const score = scoreSoftOverlap(queryTokens, semanticTokens(haystack));
        if (score <= 0) {
          continue;
        }

        candidates.push(makeCandidate({
          layer,
          laneId: "semantic",
          score: score * 0.9,
          record,
          reason: "semantic overlap",
        }));
      }
    }

    return candidates;
  }
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

function getSemanticText(layer, record, atomicClaimsByEvidence, { catalogRoot } = {}) {
  switch (layer) {
    case "tactics":
      return [
        record.title,
        record.summary,
        record.action,
        ...(record.prerequisites ?? []),
        ...(record.steps ?? []),
        ...(record.fallbacks ?? []),
      ].join(" ");
    case "invariants":
      return [
        record.title,
        record.summary,
        record.statement,
        ...(record.applicability_conditions ?? []),
        ...(record.non_applicability_conditions ?? []),
      ].join(" ");
    case "cases":
      return [
        record.problem_statement,
        record.action_taken,
        record.outcome,
        record.failure_mode,
        ...(record.applicability?.when_to_apply ?? []),
        ...(record.applicability?.when_not_to_apply ?? []),
      ].filter(Boolean).join(" ");
    case "evidence":
      return buildEvidenceRetrievalText(record, {
        catalogRoot,
        atomicClaims: atomicClaimsByEvidence.get(record.evidence_id) ?? [],
      });
    default:
      return "";
  }
}

function semanticTokens(value) {
  return tokenize(value)
    .map(normalizeSemanticToken)
    .filter((token) => token && !STOP_WORDS.has(token));
}

function tokenize(value) {
  return String(value)
    .toLowerCase()
    .split(/[^a-z0-9_:-]+/i)
    .filter(Boolean);
}

function scoreSoftOverlap(queryTokens, haystackTokens) {
  if (queryTokens.length === 0 || haystackTokens.length === 0) {
    return 0;
  }

  let matches = 0;
  for (const token of queryTokens) {
    if (haystackTokens.some((candidate) => candidate === token || candidate.startsWith(token) || token.startsWith(candidate))) {
      matches += 1;
    }
  }

  return matches / queryTokens.length;
}

function buildAtomicClaimIndex(claimSets) {
  const index = new Map();

  for (const claimSet of claimSets) {
    index.set(
      claimSet.evidence_id,
      (claimSet.claims ?? []).map((claim) => claim.text),
    );
  }

  return index;
}

function normalizeSemanticToken(token) {
  const synonym = SEMANTIC_SYNONYMS[token];
  if (synonym) {
    return synonym;
  }

  if (token.endsWith("ing") && token.length > 5) {
    return token.slice(0, -3);
  }

  if (token.endsWith("ed") && token.length > 4) {
    return token.slice(0, -2);
  }

  if (token.endsWith("s") && token.length > 4) {
    return token.slice(0, -1);
  }

  return token;
}

const STOP_WORDS = new Set(["the", "a", "an", "and", "or", "to", "for", "from", "of", "how", "should"]);

const SEMANTIC_SYNONYMS = Object.freeze({
  unrelated: "scope",
  unauthorized: "scope",
  project: "scope",
  projects: "scope",
  prevent: "guard",
  prevents: "guard",
  protecting: "guard",
  influence: "affect",
  influencing: "affect",
  ranking: "rank",
  retrieval: "retrieve",
  retrieving: "retrieve",
  fusion: "fuse",
});

function isRetrievableRecord(layer, record) {
  return layer === "evidence" || record.status === "active";
}

module.exports = {
  HeuristicSemanticBackend,
};
