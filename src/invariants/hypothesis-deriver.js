const crypto = require("node:crypto");
const path = require("node:path");

const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const { InvariantDiscoverySurface } = require("./discovery");
const { InvariantHypothesisManifestStore } = require("./hypothesis-manifest-store");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { EcitrValidator } = require("../validation/validator");

class InvariantHypothesisDeriver {
  constructor({
    catalogRoot = DEFAULT_CATALOG_ROOT,
    validator = new EcitrValidator(),
    catalog = new FileBackedCatalog({ rootDir: catalogRoot, validator }),
    discovery = new InvariantDiscoverySurface({ catalogRoot, validator }),
    store = new InvariantHypothesisManifestStore({ rootDir: catalogRoot, validator }),
  } = {}) {
    this.catalogRoot = path.resolve(catalogRoot);
    this.validator = validator;
    this.catalog = catalog;
    this.discovery = discovery;
    this.store = store;
  }

  deriveManifest({
    includeCoveredCases = false,
    maxCandidates = 25,
    maxCandidatesPerCase = 4,
    maxRareTokenDocumentFrequency = 6,
    minSharedClauses = 1,
    minSharedRareTokens = 4,
    minRareTokenScore = 3,
    generatedAt = new Date().toISOString(),
  } = {}) {
    const activeCases = this.catalog.listRecords("case").filter((record) => record.status === "active");
    const sourceCases = includeCoveredCases
      ? activeCases
      : activeCases.filter((record) => !this.isCoveredByActiveInvariant(record.case_id));
    const activeInvariants = this.catalog.listRecords("invariant").filter((record) => record.status === "active");
    const caseContexts = buildCaseContexts(sourceCases);
    const tokenDocumentFrequency = buildTokenDocumentFrequency(caseContexts);
    const seedPairs = buildSeedPairs({
      caseContexts,
      tokenDocumentFrequency,
      maxRareTokenDocumentFrequency,
      minSharedClauses,
      minSharedRareTokens,
      minRareTokenScore,
    });
    const selectedPairs = selectSeedPairs({
      seedPairs,
      maxCandidates,
      maxCandidatesPerCase,
    });
    const selectedCandidates = mergeSelectedPairs({
      selectedPairs,
      tokenDocumentFrequency,
    });

    const entries = selectedCandidates.map((seedPair) =>
      buildDerivedEntry({
        seedPair,
        tokenDocumentFrequency,
        generatedAt,
        discovery: this.discovery,
      }),
    );

    const derivationId = createDerivationId({
      generatedAt,
      includeCoveredCases,
      selectedPairs: selectedCandidates,
    });
    const manifest = {
      derivation_id: derivationId,
      benchmark_id: `invariant_hypothesis_derivation_${sanitizeTimestamp(generatedAt)}`,
      description: `Deterministic invariant hypothesis derivation over ${
        includeCoveredCases ? "active cases" : "uncovered active cases"
      }.`,
      generated_at: generatedAt,
      catalog_root: this.catalogRoot,
      source_pool: includeCoveredCases ? "active_cases" : "uncovered_active_cases",
      derivation_method: "deterministic_pairwise_rare_token_overlap_v1",
      thresholds: {
        include_covered_cases: includeCoveredCases,
        max_candidates: maxCandidates,
        max_candidates_per_case: maxCandidatesPerCase,
        max_rare_token_document_frequency: maxRareTokenDocumentFrequency,
        min_shared_clauses: minSharedClauses,
        min_shared_rare_tokens: minSharedRareTokens,
        min_rare_token_score: minRareTokenScore,
      },
      total_active_cases: activeCases.length,
      total_source_cases: sourceCases.length,
      total_existing_active_invariants: activeInvariants.length,
      total_seed_pairs: seedPairs.length,
      total_selected_candidates: entries.length,
      approved_candidate_labels: entries
        .filter((entry) => entry.expected_decision === "approve")
        .map((entry) => entry.label),
      blocked_candidate_labels: entries
        .filter((entry) => entry.expected_decision === "block")
        .map((entry) => entry.label),
      entries,
    };

    this.validator.validateRecord("invariant_hypothesis_manifest", manifest);
    return manifest;
  }

  writeManifest({
    manifest,
    overwrite = false,
    outputPath,
  } = {}) {
    if (!manifest) {
      throw new Error("writeManifest requires a manifest.");
    }

    return this.store.writeManifest(manifest, {
      overwrite,
      outputPath,
    });
  }

  isCoveredByActiveInvariant(caseId) {
    return this.catalog
      .listRecords("invariant")
      .some((record) => record.status === "active" && (record.source_case_refs ?? []).includes(caseId));
  }
}

function buildCaseContexts(sourceCases) {
  return sourceCases.map((record) => ({
    record,
    clauses: extractCaseClauses(record),
    tokens: tokenizeCaseText(record),
    tokenSet: new Set(tokenizeCaseText(record)),
  }));
}

function buildTokenDocumentFrequency(caseContexts) {
  const documentFrequency = new Map();
  for (const caseContext of caseContexts) {
    for (const token of caseContext.tokenSet) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  return documentFrequency;
}

function buildSeedPairs({
  caseContexts,
  tokenDocumentFrequency,
  maxRareTokenDocumentFrequency,
  minSharedClauses,
  minSharedRareTokens,
  minRareTokenScore,
}) {
  const seedPairs = [];

  for (let leftIndex = 0; leftIndex < caseContexts.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < caseContexts.length; rightIndex += 1) {
      const left = caseContexts[leftIndex];
      const right = caseContexts[rightIndex];
      const sharedClauses = intersectClauses(left.clauses, right.clauses).filter((clause) =>
        isPromotableClause(clause.normalized),
      );
      if (sharedClauses.length < minSharedClauses) {
        continue;
      }
      const sharedRareTokens = intersectSets(
        [...left.tokenSet].filter((token) => (tokenDocumentFrequency.get(token) ?? Number.MAX_SAFE_INTEGER) <= maxRareTokenDocumentFrequency),
        [...right.tokenSet].filter((token) => (tokenDocumentFrequency.get(token) ?? Number.MAX_SAFE_INTEGER) <= maxRareTokenDocumentFrequency),
      );
      if (sharedRareTokens.length < minSharedRareTokens) {
        continue;
      }

      const rareTokenScore = sharedRareTokens.reduce(
        (sum, token) => sum + 1 / (tokenDocumentFrequency.get(token) ?? 1),
        0,
      );
      if (rareTokenScore < minRareTokenScore) {
        continue;
      }

      seedPairs.push({
        caseRefs: [left.record.case_id, right.record.case_id],
        caseRecords: [left.record, right.record],
        sharedClauses,
        sharedRareTokens: rankTokens(sharedRareTokens, tokenDocumentFrequency),
        rareTokenScore,
        clauseScore: sharedClauses.reduce((sum, clause) => sum + scoreClause(clause.normalized), 0),
      });
    }
  }

  seedPairs.sort((left, right) => {
    if (right.sharedClauses.length !== left.sharedClauses.length) {
      return right.sharedClauses.length - left.sharedClauses.length;
    }
    if (right.clauseScore !== left.clauseScore) {
      return right.clauseScore - left.clauseScore;
    }
    if (right.rareTokenScore !== left.rareTokenScore) {
      return right.rareTokenScore - left.rareTokenScore;
    }
    if (right.sharedRareTokens.length !== left.sharedRareTokens.length) {
      return right.sharedRareTokens.length - left.sharedRareTokens.length;
    }
    return left.caseRefs.join("|").localeCompare(right.caseRefs.join("|"));
  });

  return seedPairs;
}

function selectSeedPairs({ seedPairs, maxCandidates, maxCandidatesPerCase }) {
  const selected = [];
  const caseUsageCounts = new Map();

  for (const seedPair of seedPairs) {
    const exceedsUsage = seedPair.caseRefs.some(
      (caseId) => (caseUsageCounts.get(caseId) ?? 0) >= maxCandidatesPerCase,
    );
    if (exceedsUsage) {
      continue;
    }

    selected.push(seedPair);
    for (const caseId of seedPair.caseRefs) {
      caseUsageCounts.set(caseId, (caseUsageCounts.get(caseId) ?? 0) + 1);
    }
    if (selected.length >= maxCandidates) {
      break;
    }
  }

  return selected;
}

function mergeSelectedPairs({ selectedPairs, tokenDocumentFrequency }) {
  const groups = new Map();

  selectedPairs.forEach((seedPair, index) => {
    const signature = buildClauseSignature(seedPair.sharedClauses);
    if (!groups.has(signature)) {
      groups.set(signature, {
        rankIndex: index,
        caseRecords: [],
      });
    }
    const group = groups.get(signature);
    group.rankIndex = Math.min(group.rankIndex, index);
    for (const record of seedPair.caseRecords) {
      if (!group.caseRecords.some((candidate) => candidate.case_id === record.case_id)) {
        group.caseRecords.push(record);
      }
    }
  });

  return [...groups.values()]
    .map((group) => {
      const caseContexts = buildCaseContexts(group.caseRecords);
      const sharedClauses = intersectAcrossContexts(caseContexts, "clauses", intersectClauses).filter((clause) =>
        isPromotableClause(clause.normalized),
      );
      const sharedRareTokens = rankTokens(
        intersectAcrossContexts(caseContexts, "tokenSet", intersectSets),
        tokenDocumentFrequency,
      );
      const rareTokenScore = sharedRareTokens.reduce(
        (sum, token) => sum + 1 / (tokenDocumentFrequency.get(token) ?? 1),
        0,
      );

      return {
        caseRefs: group.caseRecords.map((record) => record.case_id).sort(),
        caseRecords: group.caseRecords.sort((left, right) => left.case_id.localeCompare(right.case_id)),
        sharedClauses,
        sharedRareTokens,
        rareTokenScore,
        clauseScore: sharedClauses.reduce((sum, clause) => sum + scoreClauseMatch(clause), 0),
        rankIndex: group.rankIndex,
      };
    })
    .filter((group) => group.sharedClauses.length > 0)
    .sort((left, right) => left.rankIndex - right.rankIndex);
}

function buildDerivedEntry({
  seedPair,
  tokenDocumentFrequency,
  generatedAt,
  discovery,
}) {
  const displayClauses = seedPair.sharedClauses.slice(0, 3).map((clause) => clause.display);
  const displayTokens = seedPair.sharedRareTokens.slice(0, 6);
  const titleSource = displayClauses[0] ?? formatTokenList(displayTokens);
  const caseTitleDigest = seedPair.caseRefs
    .map((caseId) => caseId.replace(/^case_/, "").slice(0, 8))
    .join("_");
  const label = `derived_${slugify(titleSource) || "candidate"}_${caseTitleDigest}`;
  const candidateId = createCandidateId(seedPair.caseRefs, displayClauses, displayTokens);
  const seriesKey = `derived.${slugify(titleSource) || "candidate"}-${caseTitleDigest}`;
  const renderedClauseList = formatClauseList(displayClauses);
  const scope = deriveScope(displayClauses, displayTokens);

  const entry = {
    label,
    promotion_basis: "multi_case",
    series_key: seriesKey,
    title: `Derived candidate: ${truncateForTitle(titleSource)}`,
    summary: `Deterministically derived from active cases that repeat the same normalized clauses: ${renderedClauseList}.`,
    statement: `The cited active cases repeat the same decisive boundaries: ${renderedClauseList}. Human review must confirm whether those repeated boundaries should be restated as one canonical invariant without adding facts absent from the source cases.`,
    source_case_refs: seedPair.caseRefs,
    evidence_refs: collectEvidenceRefs(seedPair.caseRecords),
    why_it_is_stable: `Both source cases repeat the same normalized clauses across their problem, failure, or applicability framing: ${renderedClauseList}.`,
    scope,
    non_scope: [
      "Cases that do not repeat the same normalized clauses across their decisive boundaries.",
    ],
    applicability_conditions: [
      "Benchmark this candidate only against the cited active cases.",
      "Promote only if a human can restate the repeated clauses as one durable rule.",
    ],
    non_applicability_conditions: [
      "Do not promote when the repeated clauses are boilerplate workflow scaffolding rather than one durable rule.",
    ],
    known_breakers: [
      "The repeated clauses are semantically incidental rather than one stable rule.",
      "A broader active-case set splits the candidate into multiple narrower invariants.",
    ],
    tool_agnosticity_level: "medium",
    confidence: calculateConfidence(seedPair),
  };
  const evaluation = discovery.evaluateCandidate({
    ...entry,
    created_at: generatedAt,
  });

  return {
    ...entry,
    expected_decision: evaluation.actual_decision,
    derivation_metadata: {
      candidate_id: candidateId,
      source_case_titles: seedPair.caseRecords.map((record) => record.problem_statement),
      source_evidence_refs: collectEvidenceRefs(seedPair.caseRecords),
      shared_clauses: displayClauses,
      shared_clause_count: seedPair.sharedClauses.length,
      shared_rare_tokens: displayTokens,
      shared_rare_token_count: seedPair.sharedRareTokens.length,
      rare_token_score: Number(seedPair.rareTokenScore.toFixed(3)),
      actual_decision: evaluation.actual_decision,
      reasons: evaluation.reasons,
      support_summary: evaluation.support_summary,
    },
  };
}

function collectEvidenceRefs(caseRecords) {
  return [...new Set(caseRecords.flatMap((record) => record.evidence_refs ?? []))];
}

function calculateConfidence(seedPair) {
  const boundedScore = Math.min(seedPair.rareTokenScore, 8);
  const boundedTokens = Math.min(seedPair.sharedRareTokens.length, 12);
  return Number(Math.min(0.92, 0.35 + boundedScore * 0.04 + boundedTokens * 0.02).toFixed(2));
}

function createDerivationId({ generatedAt, includeCoveredCases, selectedPairs }) {
  const digest = crypto
    .createHash("sha1")
    .update(`${generatedAt}:${includeCoveredCases}:${selectedPairs.map((pair) => pair.caseRefs.join("|")).join(";")}`)
    .digest("hex")
    .slice(0, 10);
  return `ihm_${sanitizeTimestamp(generatedAt)}_${digest}`;
}

function createCandidateId(caseRefs, displayClauses, displayTokens) {
  const digest = crypto
    .createHash("sha1")
    .update(`${caseRefs.join("|")}:${displayClauses.join("|")}:${displayTokens.join("|")}`)
    .digest("hex")
    .slice(0, 16);
  return `ihc_${digest}`;
}

function sanitizeTimestamp(value) {
  return String(value).replaceAll(/[:.]/g, "").replaceAll("-", "");
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function rankTokens(tokens, tokenDocumentFrequency) {
  return [...new Set(tokens)].sort((left, right) => {
    const leftFrequency = tokenDocumentFrequency.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightFrequency = tokenDocumentFrequency.get(right) ?? Number.MAX_SAFE_INTEGER;
    if (leftFrequency !== rightFrequency) {
      return leftFrequency - rightFrequency;
    }
    if (right.length !== left.length) {
      return right.length - left.length;
    }
    return left.localeCompare(right);
  });
}

function formatTokenList(tokens) {
  return tokens.join(" / ");
}

function formatClauseList(clauses) {
  return clauses.map((clause) => `"${clause}"`).join("; ");
}

function intersectSets(left, right) {
  const rightSet = new Set(right);
  return [...new Set(left.filter((token) => rightSet.has(token)))];
}

function intersectAcrossContexts(caseContexts, key, intersectFn) {
  if (caseContexts.length === 0) {
    return [];
  }
  let current = asIntersectionArray(caseContexts[0][key]);
  for (const caseContext of caseContexts.slice(1)) {
    current = intersectFn(current, asIntersectionArray(caseContext[key]));
    if (current.length === 0) {
      break;
    }
  }
  return current;
}

function asIntersectionArray(value) {
  return Array.isArray(value) ? value : [...value];
}

function tokenizeCaseText(sourceCase) {
  return tokenize([
    sourceCase.problem_statement,
    sourceCase.action_taken,
    sourceCase.failure_mode,
    ...(sourceCase.context?.constraints ?? []),
    ...(sourceCase.context?.toolchain ?? []),
    ...(sourceCase.applicability?.when_to_apply ?? []),
    ...(sourceCase.applicability?.when_not_to_apply ?? []),
  ].filter(Boolean).join(" ")).filter(isCandidateToken);
}

function extractCaseClauses(sourceCase) {
  return dedupeBy(
    [
      ...splitClauses(sourceCase.problem_statement, "problem_statement"),
      ...splitClauses(sourceCase.failure_mode, "failure_mode"),
      ...splitClauses(sourceCase.action_taken, "action_taken"),
      ...(sourceCase.applicability?.when_to_apply ?? []).flatMap((value) => splitClauses(value, "when_to_apply")),
      ...(sourceCase.applicability?.when_not_to_apply ?? []).flatMap((value) => splitClauses(value, "when_not_to_apply")),
    ],
    (clause) => clause.normalized,
  );
}

function splitClauses(value, source) {
  return String(value ?? "")
    .split(/\n+|;|[!?](?:\s+|$)|\.(?=\s+[A-Z"`]|$)/g)
    .map((clause) => clause.replace(/^\s*\d+\.\s*/, "").trim())
    .map((clause) => ({
      source,
      display: normalizeClauseForDisplay(clause),
      normalized: normalizeClause(clause),
    }))
    .filter((clause) => isCandidateClause(clause.normalized));
}

function normalizeClauseForDisplay(value) {
  return String(value)
    .replace(/\s+/g, " ")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
}

function normalizeClause(value) {
  return String(value)
    .toLowerCase()
    .replace(/`+/g, "")
    .replace(/\/users\/[^\s]+/gi, "<path>")
    .replace(/\b\d{4}-\d{2}-\d{2}(?:t\d{2}:\d{2}:\d{2}(?:\.\d+)?z?)?\b/gi, "<time>")
    .replace(/\b[a-z]+_[a-z0-9_-]{6,}\b/gi, "<id>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/^when the operator needs to execute the same kind of intervention captured here:\s*/g, "")
    .replace(/^when the expected operating conditions still match this record, especially these decisive boundaries:\s*/g, "")
    .replace(/^do not apply this case once the decisive blocker or constraint has already been removed:\s*/g, "")
    .replace(/^do not apply this case when the current workflow aims at a materially different outcome than the one achieved here:\s*/g, "")
    .replace(/\s+/g, " ")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
}

function isCandidateClause(clause) {
  if (!clause || clause.length < 24) {
    return false;
  }
  const wordCount = clause.split(/\s+/).length;
  if (wordCount < 4) {
    return false;
  }
  if ((clause.match(/<id>/g) ?? []).length > 1 || (clause.match(/<time>/g) ?? []).length > 1) {
    return false;
  }
  return true;
}

function isPromotableClause(clause) {
  if (!clause) {
    return false;
  }
  if (
    clause.startsWith("run the ")
    || clause.startsWith("opened ")
    || clause.startsWith("executed ")
    || clause.startsWith("installed ")
    || clause.startsWith("checked ")
    || clause.startsWith("reviewed ")
    || clause.startsWith("read ")
    || clause.startsWith("wrote ")
    || clause.startsWith("created ")
    || clause.startsWith("updated ")
    || clause.startsWith("generated ")
    || clause.startsWith("report ")
    || clause.startsWith("use the generated report ")
    || clause.startsWith("do not apply this case when ")
    || clause.startsWith("do not apply this case once ")
  ) {
    return false;
  }

  return (
    clause.startsWith("do not ")
    || clause.startsWith("preserve ")
    || clause.startsWith("project ")
    || clause.startsWith("apply ")
    || clause.startsWith("keep ")
    || clause.startsWith("leave ")
    || clause.startsWith("lock ")
    || clause.startsWith("restrict ")
    || clause.startsWith("scope ")
    || clause.includes(" must ")
    || clause.includes(" never ")
    || clause.includes(" only ")
    || clause.includes(" without ")
  );
}

function intersectClauses(leftClauses, rightClauses) {
  const rightByNormalized = new Map(rightClauses.map((clause) => [clause.normalized, clause]));
  return dedupeBy(
    leftClauses
      .filter((clause) => rightByNormalized.has(clause.normalized))
      .map((clause) => ({
        normalized: clause.normalized,
        display: clause.display,
        source: clause.source,
      })),
    (clause) => clause.normalized,
  ).sort((left, right) => scoreClauseMatch(right) - scoreClauseMatch(left));
}

function deriveScope(displayClauses, displayTokens) {
  const clauseTokens = tokenize(displayClauses.join(" "))
    .filter(isCandidateToken)
    .filter((token) => !STOP_WORDS.has(token));
  return [...new Set([...clauseTokens, ...displayTokens])].slice(0, 4);
}

function truncateForTitle(value) {
  if (value.length <= 72) {
    return value;
  }
  return `${value.slice(0, 69).trim()}...`;
}

function buildClauseSignature(sharedClauses) {
  const anchorClauses = sharedClauses
    .slice(0, 2)
    .map((clause) => clause.normalized)
    .filter(Boolean);
  return anchorClauses.join("||") || crypto.randomUUID();
}

function scoreClause(clause) {
  return tokenize(clause)
    .filter(isCandidateToken)
    .filter((token) => !STOP_WORDS.has(token))
    .reduce((sum, token) => sum + Math.min(token.length / 8, 1.5), 0);
}

function scoreClauseMatch(clause) {
  const normalized = clause.normalized;
  const wordCount = normalized.split(/\s+/).length;
  const commaCount = (clause.display.match(/,/g) ?? []).length;
  let score = scoreClause(normalized) + clauseSourceWeight(clause.source);

  if (normalized.startsWith("do not ")) {
    score += 6;
  }
  if (normalized.includes(" must ")) {
    score += 3;
  }
  if (normalized.startsWith("project ") || normalized.startsWith("preserve ")) {
    score += 2;
  }
  if (normalized.startsWith("executed ") || /node\s+scripts\/|--format\s+json|memory\.md|latest\.md/.test(normalized)) {
    score -= 8;
  }
  if (normalized.startsWith("report ") || normalized.startsWith("use the generated report")) {
    score -= 4;
  }
  if (commaCount >= 3) {
    score -= 3;
  }
  if (wordCount > 14) {
    score -= Math.min(4, (wordCount - 14) * 0.35);
  }

  return score;
}

function clauseSourceWeight(source) {
  switch (source) {
    case "when_not_to_apply":
      return 5;
    case "failure_mode":
      return 4;
    case "when_to_apply":
      return 3;
    case "problem_statement":
      return 2;
    case "action_taken":
      return 1;
    default:
      return 0;
  }
}

function dedupeBy(values, keyFn) {
  const seen = new Set();
  const deduped = [];
  for (const value of values) {
    const key = keyFn(value);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(value);
  }
  return deduped;
}

function tokenize(value) {
  return String(value)
    .toLowerCase()
    .split(/[^a-z0-9_:-]+/i)
    .map((token) => token.replace(/^[-_]+|[-_]+$/g, ""))
    .filter(Boolean);
}

function isCandidateToken(token) {
  if (!token || STOP_WORDS.has(token) || token.length < 4) {
    return false;
  }
  if (/[0-9_]/.test(token)) {
    return false;
  }
  const hyphenCount = (token.match(/-/g) ?? []).length;
  if (hyphenCount > 1) {
    return false;
  }
  return /[a-z]/.test(token);
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
  "case",
  "cases",
  "current",
  "desktop",
  "do",
  "for",
  "from",
  "further",
  "guessed",
  "high",
  "here",
  "if",
  "implement",
  "implemented",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "lean",
  "local",
  "medium",
  "missing",
  "not",
  "now",
  "of",
  "one",
  "operator",
  "on",
  "or",
  "path",
  "processing",
  "project",
  "projects",
  "rather",
  "repo",
  "review",
  "reasoning",
  "run",
  "runtime",
  "same",
  "severity",
  "shared",
  "should",
  "so",
  "still",
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
  "user",
  "using",
  "when",
  "while",
  "with",
  "without",
  "work",
  "would",
  "overnight",
  "maintainer",
  "draft",
  "drafts",
  "pending",
  "policy",
  "open",
  "stale",
  "urgent",
  "daytime",
  "automation",
  "automations",
  "report",
  "reports",
  "latest",
  "summary",
  "only",
  "than",
  "set",
  "active",
  "completed",
  "successfully",
  "generated",
  "created",
  "updated",
  "deleted",
  "superseded",
  "highest",
  "medium",
  "normalizing",
  "normalization",
  "tightening",
  "regression",
  "test",
  "runtime-surface",
  "automatically",
  "morning",
  "inbox",
  "backlog",
  "suppression",
  "reviewed",
  "reads",
  "reading",
]);

module.exports = {
  InvariantHypothesisDeriver,
};
