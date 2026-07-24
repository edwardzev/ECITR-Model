const crypto = require("node:crypto");
const path = require("node:path");

const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const { InvariantPromotionPipeline } = require("./promotion");
const { ReviewWorkflow } = require("../review/workflow");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { EcitrValidator } = require("../validation/validator");
const { mergeWorkspaceIds } = require("../workspace/identity");

class InvariantDiscoverySurface {
  constructor({
    catalogRoot = DEFAULT_CATALOG_ROOT,
    validator = new EcitrValidator(),
    reviewWorkflow = new ReviewWorkflow({ validator }),
    pipeline = new InvariantPromotionPipeline({ validator }),
  } = {}) {
    this.catalogRoot = path.resolve(catalogRoot);
    this.validator = validator;
    this.catalog = new FileBackedCatalog({ rootDir: this.catalogRoot, validator });
    this.reviewWorkflow = reviewWorkflow;
    this.pipeline = pipeline;
  }

  inspectSourceCases(caseIds) {
    const uniqueCaseIds = [...new Set(caseIds ?? [])];

    return uniqueCaseIds.map((caseId) => {
      const record = this.catalog.getRecord("case", caseId);
      return {
        case_id: caseId,
        exists: Boolean(record),
        status: record?.status ?? null,
        record,
      };
    });
  }

  preparePromotionPacket(entry) {
    const caseInspection = this.inspectSourceCases(entry.source_case_refs);
    const missingCases = caseInspection.filter((item) => !item.exists).map((item) => item.case_id);
    if (missingCases.length > 0) {
      throw new Error(`missing source cases: ${missingCases.join(", ")}`);
    }

    const inactiveCases = caseInspection.filter((item) => item.status !== "active").map((item) => `${item.case_id}:${item.status}`);
    if (inactiveCases.length > 0) {
      throw new Error(`invariant discovery requires active source cases: ${inactiveCases.join(", ")}`);
    }

    const sourceCases = caseInspection.map((item) => item.record);
    const workspaceId = mergeWorkspaceIds(...sourceCases.map((record) => record.workspace_id));
    if (!workspaceId || workspaceId === "mixed") {
      throw new Error("invariant discovery requires all source cases to share one workspace_id");
    }
    const promotionBasis = entry.promotion_basis ?? "multi_case";
    const title = String(entry.title ?? "").trim();
    const summary = String(entry.summary ?? "").trim();
    const statement = String(entry.statement ?? "").trim();
    const seriesKey = String(entry.series_key ?? slugify(title)).trim();
    const promotionId = entry.promotion_id ?? createPromotionId(seriesKey, caseInspection.map((item) => item.case_id));

    const packet = {
      promotion_id: promotionId,
      workspace_id: entry.workspace_id ?? workspaceId,
      promotion_basis: promotionBasis,
      proposed_invariant_id: entry.proposed_invariant_id ?? createInvariantId(promotionId),
      version: entry.version ?? 1,
      series_key: seriesKey,
      title,
      summary,
      statement,
      source_case_refs: caseInspection.map((item) => item.case_id),
      evidence_refs: entry.evidence_refs ?? collectEvidenceRefs(sourceCases),
      why_it_is_stable: String(entry.why_it_is_stable ?? "").trim(),
      scope: [...(entry.scope ?? [])],
      non_scope: [...(entry.non_scope ?? [])],
      applicability_conditions: [...(entry.applicability_conditions ?? [])],
      non_applicability_conditions: [...(entry.non_applicability_conditions ?? [])],
      known_breakers: [...(entry.known_breakers ?? [])],
      tool_agnosticity_level: entry.tool_agnosticity_level ?? "high",
      confidence: entry.confidence ?? 0.75,
      created_at: entry.created_at ?? "2099-01-01T00:00:00.000Z",
    };

    if (entry.review_due_at) {
      packet.review_due_at = entry.review_due_at;
    }

    if (entry.supersedes) {
      packet.supersedes = entry.supersedes;
    }

    this.validator.validateRecord("invariant_promotion_packet", packet);

    return {
      packet,
      sourceCases,
    };
  }

  evaluateCandidate(entry) {
    try {
      const { packet, sourceCases } = this.preparePromotionPacket(entry);
      const readiness = evaluateInvariantCandidateReadiness(packet, sourceCases);

      if (!readiness.approval_ready) {
        return {
          actual_decision: "block",
          reasons: readiness.reasons,
          packet_preview: buildPacketPreview(packet),
          support_summary: readiness.support_summary,
        };
      }

      const draft = this.pipeline.compileDraft(packet);
      const approval = this.reviewWorkflow.applyDecision({
        recordType: "invariant",
        record: draft,
        decisionPacket: {
          decision_id: entry.decision_id ?? createDecisionId(packet.proposed_invariant_id),
          record_type: "invariant",
          record_id: draft.id,
          decision: "approve",
          reviewer: entry.reviewer ?? "invariant-discovery-benchmark",
          rationale: entry.rationale ?? "Dry-run invariant discovery evaluation only.",
          reviewed_at: entry.reviewed_at ?? "2099-01-01T00:00:00.000Z",
        },
      });

      return {
        actual_decision: "approve",
        reasons: [],
        packet_preview: buildPacketPreview(packet),
        support_summary: readiness.support_summary,
        draft_preview: {
          invariant_id: draft.id,
          version: draft.version,
          activated_status: approval.nextRecord.status,
        },
      };
    } catch (error) {
      return {
        actual_decision: "block",
        reasons: [error.message],
        packet_preview: null,
        support_summary: [],
      };
    }
  }
}

function evaluateInvariantCandidateReadiness(packet, sourceCases) {
  const candidateTokens = tokenizeInvariantText([
    packet.title,
    packet.summary,
    packet.statement,
    packet.why_it_is_stable,
    ...(packet.scope ?? []),
    ...(packet.non_scope ?? []),
    ...(packet.applicability_conditions ?? []),
    ...(packet.non_applicability_conditions ?? []),
    ...(packet.known_breakers ?? []),
  ].join(" "));

  const supportSummary = sourceCases.map((sourceCase) => {
    const overlapTokens = intersectSets(candidateTokens, tokenizeCaseText(sourceCase));
    return {
      case_id: sourceCase.case_id,
      overlap_count: overlapTokens.length,
      overlap_tokens: overlapTokens.slice(0, 12),
    };
  });

  const reasons = [];
  if (packet.promotion_basis === "multi_case" && sourceCases.length < 2) {
    reasons.push("multi_case discovery requires at least two active supporting cases");
  }

  const weakCases = supportSummary.filter((item) => item.overlap_count < 4);
  if (weakCases.length > 0) {
    reasons.push(`candidate statement is not strongly supported by every source case: ${weakCases.map((item) => item.case_id).join(", ")}`);
  }

  if (sourceCases.length >= 2) {
    const commonSupport = intersectAll(supportSummary.map((item) => item.overlap_tokens));
    if (commonSupport.length < 2) {
      reasons.push("supporting cases do not share enough stable common support for one invariant");
    }

    const caseSharedTokens = intersectAll(sourceCases.map((sourceCase) => tokenizeCaseText(sourceCase)));
    if (caseSharedTokens.length < 2) {
      reasons.push("supporting cases do not share enough direct common language to justify one invariant");
    }
  }

  return {
    approval_ready: reasons.length === 0,
    reasons,
    support_summary: supportSummary,
  };
}

function buildPacketPreview(packet) {
  return {
    promotion_id: packet.promotion_id,
    proposed_invariant_id: packet.proposed_invariant_id,
    title: packet.title,
    source_case_refs: packet.source_case_refs,
    evidence_ref_count: packet.evidence_refs.length,
    tool_agnosticity_level: packet.tool_agnosticity_level,
  };
}

function collectEvidenceRefs(sourceCases) {
  return [...new Set(sourceCases.flatMap((sourceCase) => sourceCase.evidence_refs ?? []))];
}

function tokenizeInvariantText(value) {
  return tokenize(value).filter((token) => token && !STOP_WORDS.has(token));
}

function tokenizeCaseText(sourceCase) {
  return tokenize([
    sourceCase.problem_statement,
    sourceCase.action_taken,
    sourceCase.outcome,
    sourceCase.failure_mode,
    ...(sourceCase.context?.constraints ?? []),
    ...(sourceCase.context?.toolchain ?? []),
    ...(sourceCase.applicability?.when_to_apply ?? []),
    ...(sourceCase.applicability?.when_not_to_apply ?? []),
  ].filter(Boolean).join(" ")).filter((token) => token && !STOP_WORDS.has(token));
}

function tokenize(value) {
  return String(value)
    .toLowerCase()
    .split(/[^a-z0-9_:-]+/i)
    .map(normalizeToken)
    .filter(Boolean);
}

function normalizeToken(token) {
  return token.replace(/^[-_]+|[-_]+$/g, "");
}

function intersectSets(left, right) {
  const rightSet = new Set(right);
  return [...new Set(left.filter((token) => rightSet.has(token)))];
}

function intersectAll(tokenLists) {
  if (tokenLists.length === 0) {
    return [];
  }

  let current = [...new Set(tokenLists[0])];
  for (let index = 1; index < tokenLists.length; index += 1) {
    current = intersectSets(current, tokenLists[index]);
    if (current.length === 0) {
      break;
    }
  }
  return current;
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function createPromotionId(seriesKey, sourceCaseRefs) {
  const digest = crypto
    .createHash("sha1")
    .update(`${seriesKey}:${sourceCaseRefs.join("|")}`)
    .digest("hex")
    .slice(0, 12);
  return `ipp_${digest}`;
}

function createInvariantId(promotionId) {
  return `inv_${crypto.createHash("sha1").update(promotionId).digest("hex").slice(0, 16)}`;
}

function createDecisionId(invariantId) {
  const digest = crypto.createHash("sha1").update(`approve:${invariantId}`).digest("hex").slice(0, 12);
  return `review_${digest}`;
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "already",
  "background",
  "be",
  "because",
  "before",
  "both",
  "but",
  "by",
  "can",
  "desktop",
  "do",
  "for",
  "from",
  "here",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "not",
  "of",
  "one",
  "operator",
  "on",
  "or",
  "processing",
  "rather",
  "same",
  "shared",
  "should",
  "so",
  "support",
  "that",
  "the",
  "their",
  "then",
  "there",
  "these",
  "this",
  "those",
  "to",
  "under",
  "use",
  "when",
  "while",
  "with",
  "without",
  "work",
]);

module.exports = {
  InvariantDiscoverySurface,
  evaluateInvariantCandidateReadiness,
};
