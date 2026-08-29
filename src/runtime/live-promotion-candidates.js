const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { EcitrValidator, readJson } = require("../validation/validator");
const { normalizeJudgeDecision } = require("./promotion-judge");

const DEFAULT_INVARIANT_ACTIVATION_CAP = 3;
const DEFAULT_TACTIC_ACTIVATION_CAP = 5;
const LIVE_DERIVATION_METHOD = "live_case_cluster_v1";

class LivePromotionCandidateStore {
  constructor({ rootDir, kind, validator = new EcitrValidator() }) {
    if (!rootDir) {
      throw new Error("LivePromotionCandidateStore requires a rootDir.");
    }
    if (!["invariant", "tactic"].includes(kind)) {
      throw new Error(`Unsupported live promotion candidate kind: ${kind}`);
    }

    this.rootDir = path.resolve(rootDir);
    this.kind = kind;
    this.validator = validator;
    this.schemaKey = kind === "invariant" ? "live_invariant_candidate" : "live_tactic_candidate";
  }

  upsertCandidate(candidate, { dryRun = false } = {}) {
    const incoming = withDiscoverySemanticsHash(candidate);
    this.validator.validateRecord(this.schemaKey, incoming);
    const candidateSeriesId = incoming.candidate_series_id ?? incoming.candidate_id;
    const latest = this.getLatestCandidateForSeries(candidateSeriesId);
    const prepared = prepareCandidateUpsert({
      latest,
      candidate: incoming,
      candidateSeriesId,
    });
    const existing = this.getCandidate(prepared.candidate.candidate_id);
    const next = mergeCandidateForUpsert(existing, prepared.candidate);

    if (!dryRun) {
      this.writeCandidate(next, { overwrite: Boolean(existing) });
    }

    return {
      candidateId: next.candidate_id,
      status: prepared.status ?? (existing ? "updated" : "created"),
      changed: prepared.changed ?? (!existing || !candidateSemanticsEqual(existing, incoming)),
      candidate: next,
    };
  }

  writeCandidate(candidate, { overwrite = false } = {}) {
    this.validator.validateRecord(this.schemaKey, candidate);
    const filePath = this.getCandidatePath(candidate.candidate_id);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    if (fs.existsSync(filePath) && !overwrite) {
      throw new Error(`Live ${this.kind} candidate already exists: ${candidate.candidate_id}`);
    }

    fs.writeFileSync(filePath, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");

    return {
      candidateId: candidate.candidate_id,
      filePath,
      candidate: structuredClone(candidate),
    };
  }

  updateCandidate(candidateId, updates, { dryRun = false } = {}) {
    const existing = this.getCandidate(candidateId);
    if (!existing) {
      throw new Error(`Live ${this.kind} candidate does not exist: ${candidateId}`);
    }

    const next = {
      ...existing,
      ...updates,
    };
    this.validator.validateRecord(this.schemaKey, next);

    if (!dryRun) {
      this.writeCandidate(next, { overwrite: true });
    }

    return {
      candidateId,
      candidate: next,
    };
  }

  getCandidate(candidateId) {
    const filePath = this.getCandidatePath(candidateId);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    return readJson(filePath);
  }

  listCandidates() {
    const directory = this.getDirectory();
    if (!fs.existsSync(directory)) {
      return [];
    }

    return fs
      .readdirSync(directory)
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .map((entry) => readJson(path.join(directory, entry)));
  }

  getLatestCandidateForSeries(candidateSeriesId) {
    return this.listCandidates()
      .filter((candidate) =>
        candidate.candidate_id === candidateSeriesId
        || candidate.candidate_series_id === candidateSeriesId)
      .sort((left, right) =>
        right.revision - left.revision
        || String(right.last_seen_at).localeCompare(String(left.last_seen_at))
        || right.candidate_id.localeCompare(left.candidate_id))[0] ?? null;
  }

  getCandidatePath(candidateId) {
    return path.join(this.getDirectory(), `${candidateId}.json`);
  }

  getDirectory() {
    const directory = this.kind === "invariant"
      ? "live-invariant-candidates"
      : "live-tactic-candidates";
    return path.join(this.rootDir, "staging", directory);
  }
}

function stageLivePromotionCandidates({
  catalogRoot = DEFAULT_CATALOG_ROOT,
  catalog = new FileBackedCatalog({ rootDir: catalogRoot }),
  invariantStore = new LivePromotionCandidateStore({ rootDir: catalogRoot, kind: "invariant" }),
  tacticStore = new LivePromotionCandidateStore({ rootDir: catalogRoot, kind: "tactic" }),
  generatedAt = new Date().toISOString(),
  dryRun = false,
  maxInvariantCandidates = 25,
  maxTacticCandidates = 25,
} = {}) {
  const activeCases = catalog.listRecords("case").filter((record) => record.status === "active");
  const activeInvariants = catalog.listRecords("invariant").filter((record) => record.status === "active");
  const activeTactics = catalog.listRecords("tactic").filter((record) => record.status === "active");

  const invariantCandidates = buildLiveInvariantCandidates({
    activeCases,
    activeInvariants,
    generatedAt,
    maxCandidates: maxInvariantCandidates,
  });
  const tacticCandidates = buildLiveTacticCandidates({
    activeCases,
    activeTactics,
    generatedAt,
    maxCandidates: maxTacticCandidates,
  });

  return {
    generated_at: generatedAt,
    dry_run: dryRun,
    active_case_count: activeCases.length,
    invariants: upsertCandidateSet({
      store: invariantStore,
      candidates: invariantCandidates,
      dryRun,
    }),
    tactics: upsertCandidateSet({
      store: tacticStore,
      candidates: tacticCandidates,
      dryRun,
    }),
  };
}

async function processLivePromotionCandidates({
  catalogRoot = DEFAULT_CATALOG_ROOT,
  invariantStore = new LivePromotionCandidateStore({ rootDir: catalogRoot, kind: "invariant" }),
  tacticStore = new LivePromotionCandidateStore({ rootDir: catalogRoot, kind: "tactic" }),
  invariantReviewSurface,
  tacticReviewSurface,
  promotionJudge,
  reviewer = "autonomous-governance-steward",
  reviewedAt = new Date().toISOString(),
  invariantActivationCap = DEFAULT_INVARIANT_ACTIVATION_CAP,
  tacticActivationCap = DEFAULT_TACTIC_ACTIVATION_CAP,
  dryRun = false,
} = {}) {
  const warnings = [];
  const invariants = await processCandidateKind({
    kind: "invariant",
    store: invariantStore,
    reviewSurface: invariantReviewSurface,
    promotionJudge,
    reviewer,
    reviewedAt,
    activationCap: invariantActivationCap,
    dryRun,
  });
  const tactics = await processCandidateKind({
    kind: "tactic",
    store: tacticStore,
    reviewSurface: tacticReviewSurface,
    promotionJudge,
    reviewer,
    reviewedAt,
    activationCap: tacticActivationCap,
    dryRun,
  });

  if (invariants.judge_skipped_count > 0 || tactics.judge_skipped_count > 0) {
    warnings.push({
      stage: "live_promotions",
      message: "live higher-promotion candidates were staged but not activated because the promotion judge is unavailable.",
      details: {
        invariants: invariants.judge_skipped_count,
        tactics: tactics.judge_skipped_count,
      },
    });
  }

  return {
    dry_run: dryRun,
    reviewer,
    reviewed_at: reviewedAt,
    activation_caps: {
      invariants: invariantActivationCap,
      tactics: tacticActivationCap,
    },
    invariants,
    tactics,
    warnings,
  };
}

async function processCandidateKind({
  kind,
  store,
  reviewSurface,
  promotionJudge,
  reviewer,
  reviewedAt,
  activationCap,
  dryRun,
}) {
  const candidates = selectLatestCandidatesBySeries(store.listCandidates())
    .filter((candidate) => ["staged", "narrowed", "judge_skipped", "cap_skipped"].includes(candidate.status));
  const summary = createProcessingSummary(candidates.length);

  if (!promotionJudge || typeof promotionJudge.judgeCandidate !== "function") {
    summary.judge_skipped_count = candidates.length;
    summary.judge_skipped = candidates.map((candidate) => candidate.candidate_id);
    return summary;
  }

  for (const candidate of candidates) {
    if (summary.activated_count >= activationCap) {
      summary.cap_skipped_count += 1;
      summary.cap_skipped.push(candidate.candidate_id);
      await recordCandidateDecision({
        store,
        candidate,
        decision: "cap_skipped",
        rationale: `activation cap reached for ${kind}`,
        decidedAt: reviewedAt,
        dryRun,
      });
      continue;
    }

    const prepared = prepareCandidateIdentity({ kind, reviewSurface, entry: candidate.entry });
    if (prepared.currentRecord?.status === "active") {
      summary.already_active_count += 1;
      summary.already_active.push(prepared.proposedId);
      await recordCandidateDecision({
        store,
        candidate,
        decision: "activated",
        rationale: "candidate proposed record is already active",
        decidedAt: reviewedAt,
        dryRun,
      });
      continue;
    }

    const deterministic = reviewSurface.discovery.evaluateCandidate(candidate.entry);
    if (deterministic.actual_decision !== "approve") {
      summary.retired_count += 1;
      summary.retired.push({
        candidate_id: candidate.candidate_id,
        reason: deterministic.reasons.join("; "),
      });
      await recordCandidateDecision({
        store,
        candidate,
        decision: "retired",
        rationale: `deterministic support check failed: ${deterministic.reasons.join("; ")}`,
        decidedAt: reviewedAt,
        dryRun,
      });
      continue;
    }

    let judgeResult;
    try {
      judgeResult = normalizeJudgeDecision(await promotionJudge.judgeCandidate({
        kind,
        candidate,
        entry: candidate.entry,
        deterministic,
        prepared: prepared.prepared,
        counterexample_case_refs: candidate.counterexample_case_refs,
        reviewer,
        reviewedAt,
        dryRun,
      }));
    } catch (error) {
      judgeResult = {
        decision: "unavailable",
        rationale: `promotion judge failed: ${error.message}`,
        narrowed_entry: null,
      };
    }

    if (judgeResult.decision === "unavailable") {
      summary.judge_skipped_count += 1;
      summary.judge_skipped.push(candidate.candidate_id);
      await recordCandidateDecision({
        store,
        candidate,
        decision: "judge_skipped",
        rationale: judgeResult.rationale,
        decidedAt: reviewedAt,
        dryRun,
      });
      continue;
    }

    if (judgeResult.decision === "retire") {
      summary.retired_count += 1;
      summary.retired.push({
        candidate_id: candidate.candidate_id,
        reason: judgeResult.rationale,
      });
      await recordCandidateDecision({
        store,
        candidate,
        decision: "retired",
        rationale: judgeResult.rationale,
        decidedAt: reviewedAt,
        dryRun,
      });
      continue;
    }

    let workingCandidate = candidate;
    const entry = judgeResult.decision === "narrow"
      ? { ...candidate.entry, ...(judgeResult.narrowed_entry ?? {}) }
      : candidate.entry;

    if (judgeResult.decision === "narrow") {
      summary.narrowed_count += 1;
      summary.narrowed.push(candidate.candidate_id);
      const narrowResult = await recordCandidateDecision({
        store,
        candidate: {
          ...candidate,
          entry,
          revision: candidate.revision + 1,
        },
        decision: "narrowed",
        rationale: judgeResult.rationale,
        decidedAt: reviewedAt,
        dryRun,
      });
      workingCandidate = narrowResult.candidate;
    }

    const activationQuality = evaluateActivationEntryQuality({ kind, entry });
    if (!activationQuality.activation_ready) {
      summary.retired_count += 1;
      summary.retired.push({
        candidate_id: candidate.candidate_id,
        reason: activationQuality.reasons.join("; "),
      });
      await recordCandidateDecision({
        store,
        candidate: workingCandidate,
        decision: "retired",
        rationale: `activation quality gate failed: ${activationQuality.reasons.join("; ")}`,
        decidedAt: reviewedAt,
        dryRun,
      });
      continue;
    }

    const duplicate = findActiveSemanticDuplicate({
      kind,
      reviewSurface,
      candidate: workingCandidate,
      entry,
      proposedId: prepared.proposedId,
    });
    if (duplicate) {
      summary.duplicate_count += 1;
      summary.duplicates.push({
        candidate_id: candidate.candidate_id,
        duplicate_record_id: duplicate.record_id,
        reason: duplicate.reason,
        shared_evidence_refs: duplicate.shared_evidence_refs,
        shared_source_case_refs: duplicate.shared_source_case_refs,
        semantic_score: duplicate.semantic_score,
      });
      summary.retired_count += 1;
      summary.retired.push({
        candidate_id: candidate.candidate_id,
        reason: duplicate.reason,
        duplicate_record_id: duplicate.record_id,
      });
      await recordCandidateDecision({
        store,
        candidate: workingCandidate,
        decision: "retired",
        rationale: `duplicate activation guard failed: ${duplicate.reason}`,
        decidedAt: reviewedAt,
        dryRun,
      });
      continue;
    }

    let result;
    try {
      result = reviewSurface.promoteCandidate({
        entry,
        reviewer,
        rationale: judgeResult.rationale,
        reviewedAt,
        dryRun,
      });
    } catch (error) {
      summary.retired_count += 1;
      summary.retired.push({
        candidate_id: candidate.candidate_id,
        reason: error.message,
        readiness: error.readiness ?? null,
      });
      await recordCandidateDecision({
        store,
        candidate: workingCandidate,
        decision: "retired",
        rationale: `promotion failed after judge decision: ${error.message}`,
        decidedAt: reviewedAt,
        dryRun,
      });
      continue;
    }

    const proposedId = kind === "invariant"
      ? result.next_record?.id ?? prepared.proposedId
      : result.next_record?.id ?? prepared.proposedId;
    summary.activated_count += 1;
    summary.activated.push({
      candidate_id: candidate.candidate_id,
      proposed_id: proposedId,
      dry_run: Boolean(result.dry_run),
    });
    await recordCandidateDecision({
      store,
      candidate: workingCandidate,
      decision: "activated",
      rationale: judgeResult.rationale,
      decidedAt: reviewedAt,
      dryRun,
    });
  }

  return summary;
}

function buildLiveInvariantCandidates({ activeCases, activeInvariants, generatedAt, maxCandidates }) {
  const coveredCaseIds = new Set(activeInvariants.flatMap((record) => record.source_case_refs ?? []));
  const contexts = buildCaseContexts(activeCases.filter((record) => !coveredCaseIds.has(record.case_id)));
  const pairs = buildCandidatePairs({
    contexts,
    minimumSharedTokens: 4,
    minimumScore: 0.34,
    scorePair: scoreInvariantPair,
  });

  return pairs.slice(0, maxCandidates).map((pair) =>
    buildInvariantCandidate({
      pair,
      allContexts: contexts,
      generatedAt,
    }),
  );
}

function buildLiveTacticCandidates({ activeCases, activeTactics, generatedAt, maxCandidates }) {
  const coveredCaseIds = new Set(activeTactics.flatMap((record) => record.source_case_refs ?? []));
  const contexts = buildCaseContexts(activeCases.filter((record) => !coveredCaseIds.has(record.case_id)));
  const pairs = buildCandidatePairs({
    contexts,
    minimumSharedTokens: 5,
    minimumScore: 0.42,
    scorePair: scoreTacticPair,
  }).filter((pair) => pair.shared_action_tokens.length >= 2);

  return pairs.slice(0, maxCandidates).map((pair) =>
    buildTacticCandidate({
      pair,
      allContexts: contexts,
      generatedAt,
    }),
  );
}

function buildCandidatePairs({ contexts, minimumSharedTokens, minimumScore, scorePair }) {
  const pairs = [];
  for (let leftIndex = 0; leftIndex < contexts.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < contexts.length; rightIndex += 1) {
      const left = contexts[leftIndex];
      const right = contexts[rightIndex];
      if (!left.workspace_id || left.workspace_id !== right.workspace_id) {
        continue;
      }

      const scored = scorePair(left, right);
      if (scored.shared_tokens.length < minimumSharedTokens || scored.score < minimumScore) {
        continue;
      }

      pairs.push({
        contexts: [left, right],
        ...scored,
      });
    }
  }

  return pairs.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.contexts.map((context) => context.case_id).join("|").localeCompare(
      right.contexts.map((context) => context.case_id).join("|"),
    );
  });
}

function buildInvariantCandidate({ pair, allContexts, generatedAt }) {
  const sourceCaseRefs = pair.contexts.map((context) => context.case_id).sort();
  const evidenceRefs = collectEvidenceRefs(pair.contexts.map((context) => context.record));
  const sharedTokens = pair.shared_tokens.slice(0, 8);
  const labelBase = slugify(sharedTokens.slice(0, 5).join("-")) || "live-invariant";
  const candidateId = createCandidateId("lic", sourceCaseRefs, sharedTokens);
  const seriesKey = `live.${pair.contexts[0].workspace_id}.${labelBase}`;
  const counterexampleRefs = findCounterexamples({ pair, allContexts });
  const title = `Live candidate: ${formatTitle(sharedTokens)}`;

  const entry = {
    label: `${labelBase}_${candidateId.slice(-8)}`,
    expected_decision: "approve",
    promotion_basis: "multi_case",
    series_key: seriesKey,
    title,
    summary: `Active cases repeat a higher-order pattern around ${sharedTokens.join(", ")}.`,
    statement: `When active cases share ${sharedTokens.join(", ")}, treat that repeated boundary as a narrow reusable rule only inside the cited workspace and evidence context.`,
    source_case_refs: sourceCaseRefs,
    evidence_refs: evidenceRefs,
    why_it_is_stable: `The supporting active cases share the same decision signals: ${sharedTokens.join(", ")}.`,
    scope: sharedTokens.slice(0, 5),
    non_scope: [
      "Cases from a different workspace.",
      "Cases that do not share the cited decision signals.",
      ...counterexampleRefs.map((caseId) => `Counterexample case ${caseId}`),
    ],
    applicability_conditions: [
      `Apply only when the current case shares these signals: ${sharedTokens.slice(0, 5).join(", ")}.`,
    ],
    non_applicability_conditions: [
      "Do not apply when the active case has different action, failure, or workspace boundaries.",
    ],
    known_breakers: counterexampleRefs.length > 0
      ? counterexampleRefs.map((caseId) => `Nearby counterexample must remain excluded: ${caseId}`)
      : ["A nearby active case has similar vocabulary but a different action or failure boundary."],
    tool_agnosticity_level: "medium",
    confidence: confidenceFromScore(pair.score),
    created_at: generatedAt,
  };

  return createCandidateRecord({
    artifactType: "live_invariant_candidate",
    candidateId,
    layer: "invariant",
    workspaceId: pair.contexts[0].workspace_id,
    sourceCaseRefs,
    evidenceRefs,
    entry,
    supportSignals: pair,
    counterexampleRefs,
    generatedAt,
  });
}

function buildTacticCandidate({ pair, allContexts, generatedAt }) {
  const sourceCaseRefs = pair.contexts.map((context) => context.case_id).sort();
  const sourceCases = pair.contexts.map((context) => context.record);
  const evidenceRefs = collectEvidenceRefs(sourceCases);
  const sharedTokens = pair.shared_tokens.slice(0, 8);
  const actionTokens = pair.shared_action_tokens.slice(0, 6);
  const labelBase = slugify([...actionTokens, ...sharedTokens].slice(0, 5).join("-")) || "live-tactic";
  const candidateId = createCandidateId("ltc", sourceCaseRefs, [...actionTokens, ...sharedTokens]);
  const counterexampleRefs = findCounterexamples({ pair, allContexts });
  const toolBinding = inferToolBinding(pair.contexts, sharedTokens);
  const steps = sourceCases
    .map((record) => String(record.action_taken ?? "").trim())
    .filter(Boolean)
    .slice(0, 4);

  const entry = {
    label: `${labelBase}_${candidateId.slice(-8)}`,
    expected_decision: "approve",
    promotion_basis: "case_cluster",
    series_key: `live.${pair.contexts[0].workspace_id}.${labelBase}`,
    title: `Live direct tactic: ${formatTitle(actionTokens.length ? actionTokens : sharedTokens)}`,
    summary: `Use the repeated active-case procedure around ${sharedTokens.slice(0, 5).join(", ")}.`,
    action: `Apply the repeated procedure from the cited active cases: ${steps[0] ?? `implement the ${sharedTokens.join(" ")} workflow`}.`,
    source_case_refs: sourceCaseRefs,
    supporting_invariant_refs: [],
    evidence_refs: evidenceRefs,
    parameter_observation_refs: [],
    tool_binding: toolBinding,
    tool_version_bounds: ">=0.1.0 <1.0.0",
    environment_bounds: [`workspace:${pair.contexts[0].workspace_id}`],
    prerequisites: [
      "The current task matches the cited case cluster.",
      "The tool and workspace boundaries match this tactic.",
    ],
    steps: steps.length > 0 ? steps : [`Implement the ${sharedTokens.join(" ")} workflow using the cited case pattern.`],
    fallbacks: [
      "If the current case diverges from the source cluster, use case-level retrieval instead of this tactic.",
    ],
    rollback: [
      "Stop applying this tactic and fall back to the active source cases.",
    ],
    revalidate_at: addDaysIso(generatedAt, 60),
    validated_on: ["live active case cluster"],
    confidence: confidenceFromScore(pair.score),
    created_at: generatedAt,
  };

  return {
    ...createCandidateRecord({
      artifactType: "live_tactic_candidate",
      candidateId,
      layer: "tactic",
      workspaceId: pair.contexts[0].workspace_id,
      sourceCaseRefs,
      evidenceRefs,
      entry,
      supportSignals: pair,
      counterexampleRefs,
      generatedAt,
    }),
    promotion_basis: "case_cluster",
    supporting_invariant_refs: [],
  };
}

function createCandidateRecord({
  artifactType,
  candidateId,
  layer,
  workspaceId,
  sourceCaseRefs,
  evidenceRefs,
  entry,
  supportSignals,
  counterexampleRefs,
  generatedAt,
}) {
  return {
    artifact_type: artifactType,
    candidate_id: candidateId,
    layer,
    status: "staged",
    workspace_id: workspaceId,
    derivation_method: LIVE_DERIVATION_METHOD,
    source_case_refs: sourceCaseRefs,
    evidence_refs: evidenceRefs,
    entry,
    support_signals: {
      score: Number(supportSignals.score.toFixed(3)),
      shared_tokens: supportSignals.shared_tokens.slice(0, 12),
      shared_action_tokens: supportSignals.shared_action_tokens.slice(0, 12),
      shared_failure_tokens: supportSignals.shared_failure_tokens.slice(0, 12),
      shared_tool_tokens: supportSignals.shared_tool_tokens.slice(0, 12),
    },
    counterexample_case_refs: counterexampleRefs,
    created_at: generatedAt,
    last_seen_at: generatedAt,
    revision: 1,
    decision_history: [],
  };
}

function upsertCandidateSet({ store, candidates, dryRun }) {
  const writes = candidates.map((candidate) => store.upsertCandidate(candidate, { dryRun }));
  return {
    generated_count: candidates.length,
    written_count: dryRun ? 0 : writes.filter((write) =>
      ["created", "revision_created"].includes(write.status)).length,
    revision_created_count: dryRun ? 0 : writes.filter((write) =>
      write.status === "revision_created").length,
    updated_count: dryRun ? 0 : writes.filter((write) => write.status === "updated" && write.changed).length,
    unchanged_count: dryRun ? 0 : writes.filter((write) => write.status === "updated" && !write.changed).length,
    candidate_ids: writes.map((write) => write.candidateId),
    candidates: writes.map((write) => write.candidate),
  };
}

function createProcessingSummary(totalCandidates) {
  return {
    total_candidates: totalCandidates,
    activated_count: 0,
    narrowed_count: 0,
    retired_count: 0,
    judge_skipped_count: 0,
    cap_skipped_count: 0,
    already_active_count: 0,
    duplicate_count: 0,
    activated: [],
    narrowed: [],
    retired: [],
    judge_skipped: [],
    cap_skipped: [],
    already_active: [],
    duplicates: [],
  };
}

function findActiveSemanticDuplicate({ kind, reviewSurface, candidate, entry, proposedId }) {
  const catalog = reviewSurface?.catalog;
  if (!catalog || typeof catalog.listRecords !== "function") {
    return null;
  }

  const workspaceId = entry.workspace_id ?? candidate.workspace_id;
  const activeRecords = catalog
    .listRecords(kind)
    .filter((record) => record.status === "active")
    .filter((record) => record.id !== proposedId)
    .filter((record) => !workspaceId || !record.workspace_id || record.workspace_id === workspaceId);
  let best = null;

  for (const record of activeRecords) {
    const comparison = compareCandidateToActiveRecord({ kind, candidate, entry, record });
    if (!comparison.duplicate) {
      continue;
    }

    if (!best || comparison.semantic_score > best.semantic_score) {
      best = comparison;
    }
  }

  return best;
}

function compareCandidateToActiveRecord({ kind, candidate, entry, record }) {
  const sharedEvidenceRefs = intersectSets(
    collectRefSet(entry.evidence_refs, candidate.evidence_refs),
    collectRefSet(record.evidence_refs),
  );
  const sharedSourceCaseRefs = intersectSets(
    collectRefSet(entry.source_case_refs, candidate.source_case_refs),
    collectRefSet(record.source_case_refs),
  );
  const titleSimilarity = tokenOverlapCoefficient(
    duplicateTextTokens(kind, entry, { titleOnly: true }),
    duplicateTextTokens(kind, record, { titleOnly: true }),
  );
  const actionSimilarity = tokenOverlapCoefficient(
    duplicateTextTokens(kind, entry, { actionOnly: true }),
    duplicateTextTokens(kind, record, { actionOnly: true }),
  );
  const semanticSimilarity = tokenOverlapCoefficient(
    duplicateTextTokens(kind, entry),
    duplicateTextTokens(kind, record),
  );
  const semanticScore = Number(Math.max(
    semanticSimilarity,
    titleSimilarity * 0.72 + actionSimilarity * 0.28,
  ).toFixed(3));
  const hasSharedEvidence = sharedEvidenceRefs.length > 0;
  const hasSharedSourceCase = sharedSourceCaseRefs.length > 0;
  const duplicate =
    (hasSharedEvidence && (titleSimilarity >= 0.62 || actionSimilarity >= 0.62 || semanticSimilarity >= 0.55)) ||
    (hasSharedSourceCase && (titleSimilarity >= 0.66 || actionSimilarity >= 0.66 || semanticSimilarity >= 0.58)) ||
    (!hasSharedEvidence && !hasSharedSourceCase && titleSimilarity >= 0.84 && semanticSimilarity >= 0.66);

  return {
    duplicate,
    record_id: record.id,
    semantic_score: semanticScore,
    shared_evidence_refs: sharedEvidenceRefs,
    shared_source_case_refs: sharedSourceCaseRefs,
    reason: duplicate
      ? [
          `duplicates active ${kind} ${record.id}`,
          `semantic_score=${semanticScore.toFixed(3)}`,
          `shared_evidence_refs=${sharedEvidenceRefs.length}`,
          `shared_source_case_refs=${sharedSourceCaseRefs.length}`,
        ].join("; ")
      : null,
  };
}

function duplicateTextTokens(kind, record, { titleOnly = false, actionOnly = false } = {}) {
  const text = duplicateTextFields(kind, record, { titleOnly, actionOnly }).join(" ");
  return [...new Set(tokenize(text))];
}

function duplicateTextFields(kind, record, { titleOnly = false, actionOnly = false } = {}) {
  if (titleOnly) {
    return [record.title, record.summary].filter(Boolean);
  }

  if (actionOnly) {
    return kind === "invariant"
      ? [record.statement, record.why_it_is_stable].filter(Boolean)
      : [record.action, ...(record.steps ?? [])].filter(Boolean);
  }

  if (kind === "invariant") {
    return [
      record.title,
      record.summary,
      record.statement,
      record.why_it_is_stable,
      ...(record.scope ?? []),
      ...(record.non_scope ?? []),
      ...(record.known_breakers ?? []),
    ].filter(Boolean);
  }

  return [
    record.title,
    record.summary,
    record.action,
    ...(record.steps ?? []),
    ...(record.prerequisites ?? []),
    ...(record.fallbacks ?? []),
    ...(record.rollback ?? []),
  ].filter(Boolean);
}

function collectRefSet(...values) {
  return [...new Set(values.flatMap((value) => Array.isArray(value) ? value : []))].sort();
}

function tokenOverlapCoefficient(left, right) {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  return intersectSets(left, right).length / Math.min(left.length, right.length);
}

function evaluateActivationEntryQuality({ kind, entry }) {
  const fields = kind === "invariant"
    ? [
        ["title", entry.title],
        ["summary", entry.summary],
        ["statement", entry.statement],
        ["why_it_is_stable", entry.why_it_is_stable],
      ]
    : [
        ["title", entry.title],
        ["summary", entry.summary],
        ["action", entry.action],
      ];
  const reasons = [];

  for (const [fieldName, value] of fields) {
    const text = String(value ?? "").trim();
    if (!text) {
      continue;
    }

    const issue = explainNoisyActivationText(text);
    if (issue) {
      reasons.push(`${fieldName} ${issue}`);
    }
  }

  return {
    activation_ready: reasons.length === 0,
    reasons,
  };
}

function explainNoisyActivationText(text) {
  const normalized = text.toLowerCase();
  if (/^live (candidate|direct tactic):/.test(normalized)) {
    return "still has generated live-candidate title text";
  }

  const generatedPhrases = [
    "active cases repeat a higher-order pattern around",
    "when active cases share",
    "the supporting active cases share the same decision signals",
    "use the repeated active-case procedure around",
    "apply the repeated procedure from the cited active cases",
    "treat that repeated boundary as a narrow reusable rule",
    "shares these signals",
    "shared decision signals",
  ];
  if (generatedPhrases.some((phrase) => normalized.includes(phrase))) {
    return "still has generated shared-token prose";
  }

  const machineTokens = extractMachineTokens(text);
  const words = text.split(/\s+/).filter(Boolean);
  if (machineTokens.length >= 2 || (words.length > 0 && machineTokens.length / words.length > 0.16)) {
    return `still contains machine-token bag text: ${machineTokens.slice(0, 5).join(", ")}`;
  }

  return null;
}

function extractMachineTokens(text) {
  return [...new Set(String(text)
    .split(/[^A-Za-z0-9_:-]+/)
    .map((token) => token.replace(/^[-_:]+|[-_:]+$/g, ""))
    .filter((token) => {
      const lower = token.toLowerCase();
      return lower.includes("_")
        || lower.endsWith("-workflow")
        || lower.split("-").length >= 3
        || lower.split(":").length >= 2;
    }))];
}

async function recordCandidateDecision({ store, candidate, decision, rationale, decidedAt, dryRun }) {
  const next = {
    ...candidate,
    status: decision,
    last_seen_at: decidedAt,
    decision_history: [
      ...(candidate.decision_history ?? []),
      {
        decided_at: decidedAt,
        decision,
        rationale,
      },
    ],
  };
  return store.updateCandidate(candidate.candidate_id, next, { dryRun });
}

function prepareCandidateIdentity({ kind, reviewSurface, entry }) {
  const prepared = reviewSurface.discovery.preparePromotionPacket(entry);
  const proposedId = kind === "invariant"
    ? prepared.packet.proposed_invariant_id
    : prepared.packet.proposed_tactic_id;
  const currentRecord = reviewSurface.catalog.getRecord(kind, proposedId);
  return {
    proposedId,
    currentRecord,
    prepared,
  };
}

function buildCaseContexts(cases) {
  return cases.map((record) => {
    const actionTokens = tokenizeCaseAction(record);
    const failureTokens = tokenize(record.failure_mode);
    const toolTokens = tokenize([
      ...(record.context?.toolchain ?? []),
      ...(record.parameter_observation_refs ?? []),
    ].join(" "));
    const tokens = tokenize([
      record.problem_statement,
      record.action_taken,
      record.outcome,
      record.failure_mode,
      ...(record.context?.constraints ?? []),
      ...(record.context?.toolchain ?? []),
      ...(record.applicability?.when_to_apply ?? []),
      ...(record.applicability?.when_not_to_apply ?? []),
    ].filter(Boolean).join(" "));

    return {
      record,
      case_id: record.case_id,
      workspace_id: record.workspace_id,
      tokens: new Set(tokens),
      action_tokens: new Set(actionTokens),
      failure_tokens: new Set(failureTokens),
      tool_tokens: new Set(toolTokens),
    };
  });
}

function scoreInvariantPair(left, right) {
  const sharedTokens = intersectSets([...left.tokens], [...right.tokens]);
  const sharedActionTokens = intersectSets([...left.action_tokens], [...right.action_tokens]);
  const sharedFailureTokens = intersectSets([...left.failure_tokens], [...right.failure_tokens]);
  const sharedToolTokens = intersectSets([...left.tool_tokens], [...right.tool_tokens]);
  const denominator = Math.max(1, Math.min(left.tokens.size, right.tokens.size));
  const score = sharedTokens.length / denominator
    + sharedActionTokens.length * 0.06
    + sharedFailureTokens.length * 0.08
    + sharedToolTokens.length * 0.12;

  return {
    score,
    shared_tokens: rankSignalTokens(sharedTokens),
    shared_action_tokens: rankSignalTokens(sharedActionTokens),
    shared_failure_tokens: rankSignalTokens(sharedFailureTokens),
    shared_tool_tokens: rankSignalTokens(sharedToolTokens),
  };
}

function scoreTacticPair(left, right) {
  const scored = scoreInvariantPair(left, right);
  return {
    ...scored,
    score: scored.score + scored.shared_action_tokens.length * 0.1 + scored.shared_tool_tokens.length * 0.08,
  };
}

function findCounterexamples({ pair, allContexts }) {
  const sourceIds = new Set(pair.contexts.map((context) => context.case_id));
  const sharedTokens = pair.shared_tokens;
  return allContexts
    .filter((context) => !sourceIds.has(context.case_id))
    .filter((context) => context.workspace_id === pair.contexts[0].workspace_id)
    .filter((context) => intersectSets(sharedTokens, [...context.tokens]).length >= 3)
    .filter((context) => intersectSets(pair.shared_action_tokens, [...context.action_tokens]).length < 2)
    .map((context) => context.case_id)
    .slice(0, 5);
}

function tokenizeCaseAction(record) {
  return tokenize([
    record.action_taken,
    record.outcome,
    ...(record.context?.toolchain ?? []),
  ].filter(Boolean).join(" "));
}

function tokenize(value) {
  return String(value ?? "")
    .toLowerCase()
    .split(/[^a-z0-9_:-]+/i)
    .map(normalizeToken)
    .filter((token) => token && !STOP_WORDS.has(token) && token.length >= 3);
}

function normalizeToken(token) {
  const cleaned = String(token).replace(/^[-_]+|[-_]+$/g, "");
  if (!cleaned) {
    return "";
  }
  const mapped = TOKEN_ALIASES[cleaned] ?? cleaned;
  return mapped
    .replace(/ies$/, "y")
    .replace(/ing$/, "")
    .replace(/ed$/, "")
    .replace(/s$/, "");
}

function intersectSets(left, right) {
  const rightSet = new Set(right);
  return [...new Set(left.filter((token) => rightSet.has(token)))];
}

function rankSignalTokens(tokens) {
  return [...new Set(tokens)]
    .filter((token) => !STOP_WORDS.has(token))
    .sort((left, right) => {
      if (right.length !== left.length) {
        return right.length - left.length;
      }
      return left.localeCompare(right);
    });
}

function collectEvidenceRefs(records) {
  return [...new Set(records.flatMap((record) => record.evidence_refs ?? []))].sort();
}

function createCandidateId(prefix, sourceCaseRefs, tokens) {
  const digest = crypto
    .createHash("sha1")
    .update(`${prefix}:${sourceCaseRefs.join("|")}:${tokens.join("|")}`)
    .digest("hex")
    .slice(0, 16);
  return `${prefix}_${digest}`;
}

function confidenceFromScore(score) {
  return Number(Math.min(0.9, 0.55 + score * 0.25).toFixed(2));
}

function formatTitle(tokens) {
  const value = tokens.slice(0, 5).join(" ");
  return value
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .slice(0, 90);
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function inferToolBinding(contexts, sharedTokens) {
  const toolTokens = [...new Set(contexts.flatMap((context) => [...context.tool_tokens]))];
  if (toolTokens.length > 0) {
    return toolTokens.slice(0, 4);
  }

  return sharedTokens.slice(0, 3).map((token) => `${token}-workflow`);
}

function addDaysIso(value, days) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function mergeCandidateForUpsert(existing, candidate) {
  if (!existing) {
    return candidate;
  }

  if (!candidateDiscoverySemanticsEqual(existing, candidate)) {
    throw new Error(
      `Live candidate revision id conflict for ${candidate.candidate_id}: discovery semantics differ.`,
    );
  }

  return {
    ...existing,
    last_seen_at: candidate.last_seen_at,
    support_signals: candidate.support_signals,
    discovery_semantics_hash: candidate.discovery_semantics_hash,
  };
}

function prepareCandidateUpsert({ latest, candidate, candidateSeriesId }) {
  if (!latest) {
    return { candidate };
  }

  const sameDiscoverySemantics = candidateDiscoverySemanticsEqual(latest, candidate);
  if (!sameDiscoverySemantics) {
    return {
      status: "revision_created",
      candidate: {
        ...candidate,
        candidate_id: buildCandidateRevisionId(
          candidateSeriesId,
          candidate,
          latest.revision + 1,
        ),
        candidate_series_id: candidateSeriesId,
        supersedes_candidate_id: latest.candidate_id,
        status: "staged",
        revision: latest.revision + 1,
        decision_history: [],
      },
    };
  }

  return {
    changed: false,
    candidate: {
      ...candidate,
      candidate_id: latest.candidate_id,
    },
  };
}

function withDiscoverySemanticsHash(candidate) {
  return {
    ...candidate,
    discovery_semantics_hash: hashCandidateDiscoverySemantics(candidate),
  };
}

function candidateDiscoverySemanticsEqual(left, right) {
  const leftHash = left.discovery_semantics_hash
    ?? hashCandidateDiscoverySemantics(left);
  const rightHash = right.discovery_semantics_hash
    ?? hashCandidateDiscoverySemantics(right);
  if (leftHash === rightHash) {
    return true;
  }

  // Existing candidates may carry the pre-normalization hash, which included
  // generated lifecycle dates. Reuse the persisted dates for one compatibility
  // comparison so the hash can be upgraded without creating a revision.
  return Boolean(left.discovery_semantics_hash)
    && leftHash === hashLegacyCandidateDiscoverySemantics(right, {
      lifecycleEntry: left.entry,
    });
}

function hashCandidateDiscoverySemantics(candidate) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(candidateSemanticProjection(candidate)))
    .digest("hex")}`;
}

function buildCandidateRevisionId(candidateSeriesId, candidate, revision) {
  const digest = crypto
    .createHash("sha1")
    .update(candidate.discovery_semantics_hash ?? hashCandidateDiscoverySemantics(candidate))
    .digest("hex")
    .slice(0, 12);
  return `${candidateSeriesId}_rev_${revision}_${digest}`;
}

function selectLatestCandidatesBySeries(candidates) {
  const latestBySeries = new Map();
  for (const candidate of candidates) {
    const seriesId = candidate.candidate_series_id ?? candidate.candidate_id;
    const current = latestBySeries.get(seriesId);
    if (!current
      || candidate.revision > current.revision
      || (candidate.revision === current.revision
        && String(candidate.last_seen_at).localeCompare(String(current.last_seen_at)) > 0)
      || (candidate.revision === current.revision
        && candidate.last_seen_at === current.last_seen_at
        && candidate.candidate_id.localeCompare(current.candidate_id) > 0)) {
      latestBySeries.set(seriesId, candidate);
    }
  }
  return [...latestBySeries.values()];
}

function candidateSemanticsEqual(left, right) {
  return JSON.stringify(candidateSemanticProjection(left))
    === JSON.stringify(candidateSemanticProjection(right));
}

function candidateSemanticProjection(candidate) {
  const entry = { ...candidate.entry };
  delete entry.created_at;
  delete entry.revalidate_at;

  return candidateProjectionWithEntry(candidate, entry);
}

function hashLegacyCandidateDiscoverySemantics(candidate, { lifecycleEntry } = {}) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(candidateLegacySemanticProjection(candidate, { lifecycleEntry })))
    .digest("hex")}`;
}

function candidateLegacySemanticProjection(candidate, { lifecycleEntry = candidate.entry } = {}) {
  const entry = { ...candidate.entry };
  for (const field of ["created_at", "revalidate_at"]) {
    if (Object.prototype.hasOwnProperty.call(lifecycleEntry ?? {}, field)) {
      entry[field] = lifecycleEntry[field];
    } else {
      delete entry[field];
    }
  }

  return candidateProjectionWithEntry(candidate, entry);
}

function candidateProjectionWithEntry(candidate, entry) {
  return {
    workspace_id: candidate.workspace_id,
    entry,
    source_case_refs: candidate.source_case_refs,
    supporting_invariant_refs: candidate.supporting_invariant_refs,
    evidence_refs: candidate.evidence_refs,
    counterexample_case_refs: candidate.counterexample_case_refs,
  };
}

const TOKEN_ALIASES = Object.freeze({
  artifacts: "artifact",
  canonicalized: "canonical",
  canonically: "canonical",
  schemas: "schema",
  staged: "stage",
  staging: "stage",
  validates: "validate",
  validated: "validate",
  validating: "validate",
  validation: "validate",
  reviews: "review",
  reviewed: "review",
  reviewing: "review",
  packets: "packet",
  candidates: "candidate",
  tactics: "tactic",
  invariants: "invariant",
});

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "because", "but", "by", "case", "cases", "current",
  "do", "does", "for", "from", "has", "have", "if", "in", "into", "is", "it", "its", "not", "of",
  "on", "or", "same", "so", "that", "the", "their", "then", "there", "these", "this", "those", "to",
  "under", "use", "uses", "using", "was", "when", "while", "with", "without", "work", "workflow",
  "active", "candidate", "candidates", "source", "supporting", "supports",
]);

module.exports = {
  DEFAULT_INVARIANT_ACTIVATION_CAP,
  DEFAULT_TACTIC_ACTIVATION_CAP,
  LivePromotionCandidateStore,
  buildLiveInvariantCandidates,
  buildLiveTacticCandidates,
  processLivePromotionCandidates,
  stageLivePromotionCandidates,
};
