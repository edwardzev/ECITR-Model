const { tokenizeRetrievalText } = require("./tokenizer");

const RETRIEVAL_GATE_ID = "ecitr-conservative-shadow-v1";
const GATE_MODE = "shadow";

const MEMORY_DEPENDENT_PATTERNS = Object.freeze([
  { code: "memory_reference", pattern: /\b(project memory|memory contains|memory-dependent|remember|history)\b/i },
  { code: "prior_work_reference", pattern: /\b(previous|prior|earlier|last time|we decided|did we decide|what did we decide)\b/i },
  { code: "continuation_reference", pattern: /\b(continue|continuing|resume|resuming)\b/i },
  { code: "existence_lookup", pattern: /\b(do we have|have we ever|is there any)\b/i },
]);

const CURRENT_CONTEXT_PATTERNS = Object.freeze([
  { code: "current_message", pattern: /\b(this (message|paragraph|sentence|reply)|current (message|thread|conversation))\b/i },
  { code: "immediate_context", pattern: /\b(above|you just (said|wrote)|just wrote|just said)\b/i },
]);

const GENERAL_KNOWLEDGE_PATTERN = /^\s*(what is|what are|define|who is|when was|where is|explain the (?:concept|meaning) of)\b/i;
const EXACT_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]+$/;
const QUERY_FILLER_WORDS = new Set([
  "about",
  "above",
  "are",
  "can",
  "did",
  "do",
  "does",
  "help",
  "have",
  "improve",
  "is",
  "it",
  "me",
  "please",
  "plan",
  "step",
  "tell",
  "that",
  "this",
  "was",
  "we",
  "what",
  "when",
  "where",
  "who",
  "you",
]);

class RetrievalGate {
  constructor({ gateId = RETRIEVAL_GATE_ID } = {}) {
    this.gateId = gateId;
  }

  evaluate({
    query,
    intent = "analysis",
    trigger = "discretionary",
    projectConfig = null,
  } = {}) {
    const normalizedQuery = String(query ?? "").trim();
    if (!normalizedQuery) {
      throw new Error("RetrievalGate.evaluate requires a non-empty query.");
    }

    const classification = classifyRetrievalNeed({
      query: normalizedQuery,
      intent,
    });
    const mandatoryPolicy = evaluateMandatoryPolicy({
      trigger,
      projectConfig,
    });
    const mandatoryOverride = mandatoryPolicy.mandatory
      && classification.decision === "skip";
    const decision = mandatoryPolicy.mandatory
      ? "retrieve"
      : classification.decision;
    const evidence = [...classification.evidence];
    if (mandatoryPolicy.evidence) {
      evidence.push(mandatoryPolicy.evidence);
    }

    return {
      gate_id: this.gateId,
      mode: GATE_MODE,
      decision,
      proposed_decision: classification.decision,
      reason: mandatoryOverride
        ? `${mandatoryPolicy.reason}; classifier proposed skip: ${classification.reason}`
        : classification.reason,
      confidence: classification.confidence,
      evidence,
      mandatory_override: mandatoryOverride,
      mandatory_policy: {
        trigger,
        preflight_retrieval_mandatory: Boolean(projectConfig?.preflight_retrieval_mandatory),
        failure_retry_retrieval_mandatory: Boolean(projectConfig?.failure_retry_retrieval_mandatory),
        applied: mandatoryPolicy.mandatory,
      },
      query_assessment: assessQueryUsefulness(normalizedQuery),
      enforcement: "disabled",
      actual_behavior: "retrieve_always",
    };
  }
}

function classifyRetrievalNeed({ query, intent }) {
  if (["audit", "verification"].includes(intent)) {
    return {
      decision: "retrieve",
      reason: `${intent} intent requires historical or evidentiary context checks`,
      confidence: 0.98,
      evidence: [`intent:${intent}`],
    };
  }

  const memoryMatch = findPatternMatch(query, MEMORY_DEPENDENT_PATTERNS);
  if (memoryMatch) {
    return {
      decision: "retrieve",
      reason: "request explicitly depends on prior project context",
      confidence: 0.94,
      evidence: [`cue:${memoryMatch.code}`],
    };
  }

  if (isExactIdentifier(query)) {
    return {
      decision: "retrieve",
      reason: "exact project identifier may require canonical record lookup",
      confidence: 0.93,
      evidence: ["query:exact_identifier"],
    };
  }

  const currentContextMatch = findPatternMatch(query, CURRENT_CONTEXT_PATTERNS);
  if (currentContextMatch) {
    return {
      decision: "skip",
      reason: "request is explicitly scoped to the current conversation context",
      confidence: 0.9,
      evidence: [`cue:${currentContextMatch.code}`],
    };
  }

  if (GENERAL_KNOWLEDGE_PATTERN.test(query)) {
    return {
      decision: "skip",
      reason: "request is phrased as general knowledge without a project-history cue",
      confidence: 0.86,
      evidence: ["query:general_knowledge_form"],
    };
  }

  return {
    decision: "retrieve",
    reason: "uncertain request fails open to retrieval in the conservative classifier",
    confidence: 0.55,
    evidence: ["classifier:fail_open"],
  };
}

function evaluateMandatoryPolicy({ trigger, projectConfig }) {
  if (trigger === "preflight" && projectConfig?.preflight_retrieval_mandatory) {
    return {
      mandatory: true,
      reason: "mandatory preflight retrieval policy requires retrieval",
      evidence: "policy:preflight_mandatory",
    };
  }

  if (trigger === "failure_retry" && projectConfig?.failure_retry_retrieval_mandatory) {
    return {
      mandatory: true,
      reason: "mandatory failure-retry retrieval policy requires retrieval",
      evidence: "policy:failure_retry_mandatory",
    };
  }

  return {
    mandatory: false,
    reason: null,
    evidence: null,
  };
}

function assessQueryUsefulness(query) {
  const tokens = tokenizeRetrievalText(query);
  const signalTokens = [...new Set(tokens.filter((token) => !QUERY_FILLER_WORDS.has(token)))];
  const currentContextOnly = Boolean(findPatternMatch(query, CURRENT_CONTEXT_PATTERNS))
    && !findPatternMatch(query, MEMORY_DEPENDENT_PATTERNS);
  let score;

  if (isExactIdentifier(query)) {
    score = 1;
  } else {
    score = Math.min(0.8, signalTokens.length * 0.2);
    if (query.length >= 24) {
      score += 0.1;
    }
    if (currentContextOnly) {
      score = Math.min(score, 0.3);
    }
  }

  const roundedScore = Math.round(Math.min(1, score) * 100) / 100;
  return {
    useful: roundedScore > 0.5,
    score: roundedScore,
    reason: roundedScore > 0.5
      ? "query contains enough domain-bearing signal for a bounded retrieval attempt"
      : "query is underspecified or scoped to immediate conversation context",
    token_count: tokens.length,
    signal_token_count: signalTokens.length,
  };
}

function findPatternMatch(query, patterns) {
  return patterns.find(({ pattern }) => pattern.test(query)) ?? null;
}

function isExactIdentifier(query) {
  const value = String(query ?? "").trim();
  return value.length >= 3
    && EXACT_IDENTIFIER_PATTERN.test(value)
    && /[_:.]/.test(value);
}

module.exports = {
  GATE_MODE,
  RETRIEVAL_GATE_ID,
  RetrievalGate,
  assessQueryUsefulness,
  classifyRetrievalNeed,
  evaluateMandatoryPolicy,
};
