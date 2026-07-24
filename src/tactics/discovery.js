const crypto = require("node:crypto");
const path = require("node:path");

const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const { ReviewWorkflow } = require("../review/workflow");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { EcitrValidator } = require("../validation/validator");
const { TacticPromotionPipeline } = require("./promotion");
const { mergeWorkspaceIds } = require("../workspace/identity");

class TacticDiscoverySurface {
  constructor(options = {}) {
    const catalogRoot = options.catalogRoot ?? DEFAULT_CATALOG_ROOT;
    const validator = options.validator ?? new EcitrValidator();
    const now = options.now ?? defaultNow;
    const pipeline = options.pipeline ?? new TacticPromotionPipeline({ validator, now });
    const reviewWorkflow = options.reviewWorkflow ?? new ReviewWorkflow({
      validator,
      tacticPipeline: pipeline,
    });

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

  inspectSupportingInvariants(invariantIds) {
    const uniqueInvariantIds = [...new Set(invariantIds ?? [])];
    return uniqueInvariantIds.map((invariantId) => {
      const record = this.catalog.getRecord("invariant", invariantId);
      return {
        invariant_id: invariantId,
        exists: Boolean(record),
        status: record?.status ?? null,
        record,
      };
    });
  }

  preparePromotionPacket(entry) {
    const caseInspection = this.inspectSourceCases(entry.source_case_refs);
    const promotionBasis = entry.promotion_basis ?? "invariant_backed";
    const invariantInspection = this.inspectSupportingInvariants(entry.supporting_invariant_refs);

    const missingCases = caseInspection.filter((item) => !item.exists).map((item) => item.case_id);
    if (missingCases.length > 0) {
      throw new Error(`missing source cases: ${missingCases.join(", ")}`);
    }

    const inactiveCases = caseInspection.filter((item) => item.status !== "active").map((item) => `${item.case_id}:${item.status}`);
    if (inactiveCases.length > 0) {
      throw new Error(`tactic discovery requires active source cases: ${inactiveCases.join(", ")}`);
    }

    if (promotionBasis !== "case_cluster" || invariantInspection.length > 0) {
      const missingInvariants = invariantInspection.filter((item) => !item.exists).map((item) => item.invariant_id);
      if (missingInvariants.length > 0) {
        throw new Error(`missing supporting invariants: ${missingInvariants.join(", ")}`);
      }

      const inactiveInvariants = invariantInspection.filter((item) => item.status !== "active").map((item) => `${item.invariant_id}:${item.status}`);
      if (inactiveInvariants.length > 0) {
        throw new Error(`tactic discovery requires active supporting invariants: ${inactiveInvariants.join(", ")}`);
      }
    }

    const sourceCases = caseInspection.map((item) => item.record);
    const supportingInvariants = invariantInspection.map((item) => item.record);
    const workspaceId = mergeWorkspaceIds(
      ...sourceCases.map((record) => record.workspace_id),
      ...supportingInvariants.map((record) => record.workspace_id),
    );
    if (!workspaceId || workspaceId === "mixed") {
      throw new Error("tactic discovery requires all supporting records to share one workspace_id");
    }
    const title = String(entry.title ?? "").trim();
    const seriesKey = String(entry.series_key ?? slugify(title)).trim();
    const promotionId = entry.promotion_id ?? createPromotionId(seriesKey, caseInspection.map((item) => item.case_id), invariantInspection.map((item) => item.invariant_id));

    const packet = {
      promotion_id: promotionId,
      promotion_basis: promotionBasis,
      workspace_id: entry.workspace_id ?? workspaceId,
      proposed_tactic_id: entry.proposed_tactic_id ?? createTacticId(promotionId),
      version: entry.version ?? 1,
      series_key: seriesKey,
      title,
      summary: String(entry.summary ?? "").trim(),
      action: String(entry.action ?? "").trim(),
      source_case_refs: caseInspection.map((item) => item.case_id),
      supporting_invariant_refs: invariantInspection.map((item) => item.invariant_id),
      evidence_refs: entry.evidence_refs ?? collectEvidenceRefs(sourceCases),
      parameter_observation_refs: [...(entry.parameter_observation_refs ?? [])],
      tool_binding: [...(entry.tool_binding ?? [])],
      tool_version_bounds: String(entry.tool_version_bounds ?? "").trim(),
      environment_bounds: [...(entry.environment_bounds ?? [])],
      prerequisites: [...(entry.prerequisites ?? [])],
      steps: [...(entry.steps ?? [])],
      fallbacks: [...(entry.fallbacks ?? [])],
      rollback: [...(entry.rollback ?? [])],
      confidence: entry.confidence ?? 0.75,
      created_at: entry.created_at ?? "2099-01-01T00:00:00.000Z",
    };

    if (entry.expiry_at) {
      packet.expiry_at = entry.expiry_at;
    }
    if (entry.revalidate_at) {
      packet.revalidate_at = entry.revalidate_at;
    }
    if (entry.validated_on) {
      packet.validated_on = [...entry.validated_on];
    }
    if (entry.supersedes) {
      packet.supersedes = entry.supersedes;
    }

    this.validator.validateRecord("tactic_promotion_packet", packet);

    return {
      packet,
      sourceCases,
      supportingInvariants,
    };
  }

  evaluateCandidate(entry) {
    try {
      const { packet, sourceCases, supportingInvariants } = this.preparePromotionPacket(entry);
      const readiness = evaluateTacticCandidateReadiness(packet, sourceCases, supportingInvariants);

      if (!readiness.approval_ready) {
        return {
          actual_decision: "block",
          reasons: readiness.reasons,
          packet_preview: buildPacketPreview(packet, supportingInvariants),
          support_summary: readiness.support_summary,
        };
      }

      const draft = this.pipeline.compileDraft(packet);
      const approval = this.reviewWorkflow.applyDecision({
        recordType: "tactic",
        record: draft,
        decisionPacket: {
          decision_id: entry.decision_id ?? createDecisionId(packet.proposed_tactic_id),
          record_type: "tactic",
          record_id: draft.id,
          decision: "approve",
          reviewer: entry.reviewer ?? "tactic-discovery-benchmark",
          rationale: entry.rationale ?? "Dry-run tactic discovery evaluation only.",
          reviewed_at: entry.reviewed_at ?? "2099-01-01T00:00:00.000Z",
        },
      });

      return {
        actual_decision: "approve",
        reasons: [],
        packet_preview: buildPacketPreview(packet, supportingInvariants),
        support_summary: readiness.support_summary,
        draft_preview: {
          tactic_id: draft.id,
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

function defaultNow() {
  return new Date().toISOString();
}

function evaluateTacticCandidateReadiness(packet, sourceCases, supportingInvariants) {
  const candidateTokens = tokenizeTacticText([
    packet.title,
    packet.summary,
    packet.action,
    packet.tool_version_bounds,
    ...(packet.tool_binding ?? []),
    ...(packet.environment_bounds ?? []),
    ...(packet.prerequisites ?? []),
    ...(packet.steps ?? []),
    ...(packet.fallbacks ?? []),
    ...(packet.rollback ?? []),
    ...(packet.validated_on ?? []),
  ].join(" "));

  const caseSupport = sourceCases.map((sourceCase) => {
    const overlapTokens = intersectSets(candidateTokens, tokenizeCaseText(sourceCase));
    return {
      kind: "case",
      id: sourceCase.case_id,
      overlap_count: overlapTokens.length,
      overlap_tokens: overlapTokens.slice(0, 12),
    };
  });

  const invariantSupport = supportingInvariants.map((invariant) => {
    const overlapTokens = intersectSets(candidateTokens, tokenizeInvariantText(invariant));
    return {
      kind: "invariant",
      id: invariant.id,
      overlap_count: overlapTokens.length,
      overlap_tokens: overlapTokens.slice(0, 12),
    };
  });

  const reasons = [];
  if (sourceCases.length < 1) {
    reasons.push("tactic discovery requires at least one active supporting case");
  }
  if ((packet.promotion_basis ?? "invariant_backed") !== "case_cluster" && supportingInvariants.length < 1) {
    reasons.push("tactic discovery requires at least one active supporting invariant");
  }
  if ((packet.promotion_basis ?? "invariant_backed") === "case_cluster" && sourceCases.length < 2) {
    reasons.push("direct case-cluster tactic discovery requires at least two active supporting cases");
  }

  const minimumCaseOverlap = (packet.promotion_basis ?? "invariant_backed") === "case_cluster" ? 5 : 4;
  const weakCases = caseSupport.filter((item) => item.overlap_count < minimumCaseOverlap);
  if (weakCases.length > 0) {
    reasons.push(`candidate tactic is not strongly supported by every source case: ${weakCases.map((item) => item.id).join(", ")}`);
  }

  const weakInvariants = invariantSupport.filter((item) => item.overlap_count < 3);
  if (weakInvariants.length > 0) {
    reasons.push(`candidate tactic is not strongly aligned with every supporting invariant: ${weakInvariants.map((item) => item.id).join(", ")}`);
  }

  if ((packet.promotion_basis ?? "invariant_backed") === "case_cluster") {
    const sharedActionTokens = intersectAll(sourceCases.map(tokenizeCaseActionText));
    if (sharedActionTokens.length < 2) {
      reasons.push("direct case-cluster tactic requires a repeated action pattern across supporting cases");
    }
  }

  if (!hasSubstantiveStep(packet.steps ?? [])) {
    reasons.push("candidate tactic does not contain substantive operational steps");
  }

  if ((packet.tool_binding ?? []).length < 1) {
    reasons.push("candidate tactic must remain explicitly tool-bound");
  }

  return {
    approval_ready: reasons.length === 0,
    reasons,
    support_summary: [...caseSupport, ...invariantSupport],
  };
}

function hasSubstantiveStep(steps) {
  return steps.some((step) => {
    const normalized = String(step).toLowerCase();
    return normalized.length >= 20
      && !INCIDENTAL_STEP_PATTERNS.some((pattern) => pattern.test(normalized))
      && SUBSTANTIVE_STEP_PATTERNS.some((pattern) => pattern.test(normalized));
  });
}

function buildPacketPreview(packet, supportingInvariants) {
  return {
    promotion_id: packet.promotion_id,
    proposed_tactic_id: packet.proposed_tactic_id,
    title: packet.title,
    source_case_refs: packet.source_case_refs,
    supporting_invariant_refs: supportingInvariants.map((invariant) => invariant.id),
    evidence_ref_count: packet.evidence_refs.length,
    parameter_observation_refs: packet.parameter_observation_refs ?? [],
    tool_binding: packet.tool_binding,
  };
}

function collectEvidenceRefs(sourceCases) {
  return [...new Set(sourceCases.flatMap((sourceCase) => sourceCase.evidence_refs ?? []))];
}

function tokenizeTacticText(value) {
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

function tokenizeCaseActionText(sourceCase) {
  return tokenize([
    sourceCase.action_taken,
    sourceCase.outcome,
    ...(sourceCase.context?.toolchain ?? []),
  ].filter(Boolean).join(" ")).filter((token) => token && !STOP_WORDS.has(token));
}

function tokenizeInvariantText(invariant) {
  return tokenize([
    invariant.title,
    invariant.summary,
    invariant.statement,
    invariant.why_it_is_stable,
    ...(invariant.scope ?? []),
    ...(invariant.non_scope ?? []),
    ...(invariant.applicability_conditions ?? []),
    ...(invariant.non_applicability_conditions ?? []),
    ...(invariant.known_breakers ?? []),
  ].filter(Boolean).join(" ")).filter((token) => token && !STOP_WORDS.has(token));
}

function tokenize(value) {
  return String(value)
    .toLowerCase()
    .split(/[^a-z0-9_:-]+/i)
    .map((token) => token.replace(/^[-_]+|[-_]+$/g, ""))
    .filter(Boolean);
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

function createPromotionId(seriesKey, caseIds, invariantIds) {
  return `tpp_${crypto.createHash("sha1").update(`${seriesKey}:${caseIds.join(",")}:${invariantIds.join(",")}`).digest("hex").slice(0, 12)}`;
}

function createTacticId(promotionId) {
  return `tac_${crypto.createHash("sha1").update(promotionId).digest("hex").slice(0, 16)}`;
}

function createDecisionId(tacticId) {
  return `review_tactic_${tacticId}_approve_001`;
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "because", "but", "by", "for", "from", "if", "in",
  "into", "is", "it", "its", "may", "must", "no", "not", "of", "on", "or", "our", "same", "so",
  "than", "that", "the", "their", "them", "then", "there", "these", "they", "this", "through",
  "to", "under", "when", "with", "without", "work", "works", "using", "use",
]);

const INCIDENTAL_STEP_PATTERNS = [
  /^open(ed)?\b/,
  /^read\b/,
  /^review(ed)?\b/,
  /^inspect(ed)?\b/,
  /^check(ed)?\b/,
  /^verify\b/,
  /^look\b/,
  /^discuss(ed)?\b/,
  /^brainstorm(ed)?\b/,
  /^plan(ned)?\b/,
  /^decide(d)?\b/,
  /^summari[sz]e(d)?\b/,
  /^note(d)?\b/,
];

const SUBSTANTIVE_STEP_PATTERNS = [
  /\badd(ed)?\b/,
  /\bbuild\b/,
  /\bcompile(d)?\b/,
  /\bcreate(d)?\b/,
  /\bdeprecat(e|ed)\b/,
  /\bdisable(d)?\b/,
  /\benforce(d)?\b/,
  /\bensure(d)?\b/,
  /\bexport(ed)?\b/,
  /\bextend(ed)?\b/,
  /\bimplement(ed)?\b/,
  /\bintroduc(e|ed)\b/,
  /\bmap(ped)?\b/,
  /\bpersist(ed)?\b/,
  /\bproject(ed)?\b/,
  /\brender(ed)?\b/,
  /\brerun\b/,
  /\brollback\b/,
  /\brun\b/,
  /\bseed(ed)?\b/,
  /\bsync(ed)?\b/,
  /\bupdat(e|ed)\b/,
  /\bupsert(ed)?\b/,
  /\bvalidat(e|ed)\b/,
  /\bwire(d)?\b/,
  /\bwrite\b/,
];

module.exports = {
  TacticDiscoverySurface,
};
