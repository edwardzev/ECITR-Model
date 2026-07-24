const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const { REPO_ROOT } = require("../validation/schema-registry");
const { EcitrValidator, readJson } = require("../validation/validator");

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_PROMOTION_JUDGE_MODEL = "gpt-5.2";
const PROMOTION_JUDGE_RESPONSE_SCHEMA_PATH = path.join(REPO_ROOT, "schemas", "promotion_judge_response.schema.json");

class UnavailablePromotionJudge {
  constructor({ reason = "promotion judge is not configured" } = {}) {
    this.reason = reason;
  }

  async judgeCandidate() {
    return {
      decision: "unavailable",
      rationale: this.reason,
    };
  }
}

class PromotionJudgeAuditStore {
  constructor({ rootDir = DEFAULT_CATALOG_ROOT, validator = new EcitrValidator() } = {}) {
    this.rootDir = path.resolve(rootDir);
    this.validator = validator;
  }

  writeAudit(audit, { dryRun = false } = {}) {
    this.validator.validateRecord("promotion_judge_audit", audit);
    const filePath = this.getAuditPath(audit.audit_id);

    if (!dryRun) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
    }

    return {
      auditId: audit.audit_id,
      filePath,
      audit,
    };
  }

  listAudits() {
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

  getAuditPath(auditId) {
    return path.join(this.getDirectory(), `${auditId}.json`);
  }

  getDirectory() {
    return path.join(this.rootDir, "staging", "promotion-judge-audits");
  }
}

class LocalSemanticPromotionJudge {
  async judgeCandidate({ kind, candidate, deterministic } = {}) {
    if (deterministic?.actual_decision !== "approve") {
      return {
        decision: "retire",
        rationale: `deterministic support check did not approve: ${(deterministic?.reasons ?? []).join("; ")}`,
      };
    }

    const support = candidate?.support_signals ?? {};
    const score = Number(support.score ?? 0);
    const sharedTokens = support.shared_tokens ?? [];
    const sharedActionTokens = support.shared_action_tokens ?? [];
    const entry = candidate?.entry ?? {};
    const text = normalizeText([
      entry.title,
      entry.summary,
      entry.statement,
      entry.action,
      ...(entry.scope ?? []),
      ...(entry.steps ?? []),
    ].join(" "));

    if (isGenericCandidateText(text)) {
      return {
        decision: "retire",
        rationale: "candidate wording is too generic for autonomous activation.",
      };
    }

    const minimumScore = kind === "tactic" ? 0.52 : 0.42;
    const minimumSharedTokens = kind === "tactic" ? 5 : 4;
    if (score < minimumScore || sharedTokens.length < minimumSharedTokens) {
      return {
        decision: "retire",
        rationale: `candidate support is below local semantic threshold: score=${score}, shared_tokens=${sharedTokens.length}.`,
      };
    }

    if (kind === "tactic" && (entry.promotion_basis ?? "invariant_backed") === "case_cluster" && sharedActionTokens.length < 2) {
      return {
        decision: "retire",
        rationale: "direct case-cluster tactic lacks a repeated action pattern.",
      };
    }

    const counterexampleRefs = candidate?.counterexample_case_refs ?? [];
    if (counterexampleRefs.length > 0) {
      return {
        decision: "narrow",
        rationale: `candidate has nearby counterexamples and must explicitly exclude them: ${counterexampleRefs.join(", ")}.`,
        narrowed_entry: buildNarrowedEntry({ kind, entry, counterexampleRefs }),
      };
    }

    return {
      decision: "activate",
      rationale: "candidate is narrow, supported by deterministic checks, and has no nearby counterexamples.",
    };
  }
}

class ModelBackedPromotionJudge {
  constructor({
    apiKey = process.env.OPENAI_API_KEY,
    baseUrl = process.env.ECITR_PROMOTION_JUDGE_BASE_URL ?? process.env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL,
    model = process.env.ECITR_PROMOTION_JUDGE_MODEL ?? DEFAULT_PROMOTION_JUDGE_MODEL,
    organization = process.env.OPENAI_ORGANIZATION,
    project = process.env.OPENAI_PROJECT,
    timeoutMs = Number.parseInt(process.env.ECITR_PROMOTION_JUDGE_TIMEOUT_MS ?? "30000", 10),
    fetchImpl = globalThis.fetch,
    validator = new EcitrValidator(),
    auditStore,
    now = () => new Date().toISOString(),
  } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = String(baseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/g, "");
    this.model = model;
    this.organization = organization;
    this.project = project;
    this.timeoutMs = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000;
    this.fetchImpl = fetchImpl;
    this.validator = validator;
    this.auditStore = auditStore;
    this.now = now;
    this.responseSchema = stripJsonSchemaMeta(readJson(PROMOTION_JUDGE_RESPONSE_SCHEMA_PATH));
  }

  async judgeCandidate({
    kind,
    candidate,
    entry,
    deterministic,
    prepared,
    counterexample_case_refs: counterexampleRefs = [],
    dryRun = false,
  } = {}) {
    if (deterministic?.actual_decision !== "approve") {
      return {
        decision: "retire",
        rationale: `deterministic support check did not approve: ${(deterministic?.reasons ?? []).join("; ")}`,
      };
    }

    const createdAt = this.now();
    const inputPacket = buildModelJudgeInput({
      kind,
      candidate,
      entry,
      deterministic,
      prepared,
      counterexampleRefs,
    });
    const requestBody = this.buildRequestBody(inputPacket);
    const auditBase = {
      kind,
      candidate,
      deterministic,
      request: {
        provider: "openai_responses",
        endpoint: `${this.baseUrl}/responses`,
        model: this.model,
        response_format: "promotion_judge_response",
        input_packet: inputPacket,
      },
      createdAt,
      dryRun,
    };

    if (!this.apiKey) {
      return this.returnUnavailable({
        ...auditBase,
        status: "unavailable",
        error: "OPENAI_API_KEY is not configured for model-backed promotion judge.",
      });
    }

    if (typeof this.fetchImpl !== "function") {
      return this.returnUnavailable({
        ...auditBase,
        status: "unavailable",
        error: "No fetch implementation is available for model-backed promotion judge.",
      });
    }

    let responseJson;
    try {
      responseJson = await this.callResponsesApi(requestBody);
    } catch (error) {
      return this.returnUnavailable({
        ...auditBase,
        status: "error",
        error: error.message,
      });
    }

    let modelResponse;
    try {
      modelResponse = parseModelJudgeResponse(responseJson);
      this.validator.validateRecord("promotion_judge_response", modelResponse);
      assertModelResponseSemantics(modelResponse);
    } catch (error) {
      return this.returnUnavailable({
        ...auditBase,
        status: "invalid_response",
        response: normalizeAuditResponse(responseJson),
        error: error.message,
      });
    }

    this.writeAudit({
      ...auditBase,
      status: "completed",
      decision: modelResponse.decision,
      response: modelResponse,
      error: null,
    });

    return modelResponse;
  }

  buildRequestBody(inputPacket) {
    return {
      model: this.model,
      instructions: MODEL_JUDGE_INSTRUCTIONS,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify(inputPacket, null, 2),
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "promotion_judge_response",
          description: "ECITR higher-promotion judge decision.",
          strict: false,
          schema: this.responseSchema,
        },
      },
      store: false,
    };
  }

  async callResponsesApi(requestBody) {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (this.organization) {
      headers["OpenAI-Organization"] = this.organization;
    }
    if (this.project) {
      headers["OpenAI-Project"] = this.project;
    }

    const response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    }, this.timeoutMs);

    if (!response?.ok) {
      const body = typeof response?.text === "function" ? await response.text() : "";
      throw new Error(`OpenAI Responses API returned ${response?.status ?? "unknown"}: ${truncateString(body, 800)}`);
    }

    return response.json();
  }

  returnUnavailable({ status, error, response = null, ...auditBase }) {
    this.writeAudit({
      ...auditBase,
      status,
      decision: "unavailable",
      response,
      error,
    });

    return {
      decision: "unavailable",
      rationale: error,
    };
  }

  writeAudit({ kind, candidate, deterministic, request, response = null, status, decision, error, createdAt, dryRun }) {
    if (!this.auditStore) {
      return null;
    }

    const requestHash = createHash(request);
    const responseHash = createHash(response ?? {});
    const audit = {
      artifact_type: "promotion_judge_audit",
      audit_id: createAuditId({
        candidateId: candidate?.candidate_id,
        createdAt,
        requestHash,
        responseHash,
      }),
      candidate_id: candidate?.candidate_id,
      layer: kind,
      judge_mode: "model",
      provider: "openai_responses",
      model: this.model,
      status,
      decision,
      request_hash: requestHash,
      response_hash: responseHash,
      candidate_hash: createHash(candidate ?? {}),
      deterministic_hash: createHash(deterministic ?? {}),
      request,
      response,
      error,
      created_at: createdAt,
    };

    return this.auditStore.writeAudit(audit, { dryRun });
  }
}

function buildPromotionJudge({
  mode = process.env.ECITR_PROMOTION_JUDGE ?? "unavailable",
  catalogRoot = DEFAULT_CATALOG_ROOT,
  validator,
  auditStore,
  ...options
} = {}) {
  switch (mode) {
    case "unavailable":
    case "stage_only":
    case "":
      return new UnavailablePromotionJudge();
    case "local":
    case "local_semantic":
      return new LocalSemanticPromotionJudge();
    case "model":
    case "openai":
    case "openai_responses":
      return new ModelBackedPromotionJudge({
        ...options,
        validator,
        auditStore: auditStore ?? new PromotionJudgeAuditStore({ rootDir: catalogRoot, validator }),
      });
    default:
      throw new Error(`Unsupported promotion judge mode: ${mode}`);
  }
}

function normalizeJudgeDecision(result) {
  const decision = result?.decision ?? "unavailable";
  if (!["activate", "narrow", "retire", "unavailable"].includes(decision)) {
    throw new Error(`Unsupported promotion judge decision: ${decision}`);
  }
  const rationale = String(result?.rationale ?? "").trim() || "promotion judge returned no rationale";

  return {
    decision,
    rationale,
    narrowed_entry: result?.narrowed_entry ?? null,
  };
}

function buildModelJudgeInput({ kind, candidate, entry, deterministic, prepared, counterexampleRefs }) {
  return {
    task: "Judge whether an ECITR live higher-promotion candidate should become active knowledge.",
    hard_rules: [
      "Do not approve generic process advice.",
      "Do not approve if source cases appear mixed or reusable meaning is unclear.",
      "Use narrow when the candidate is real but needs explicit scope/counterexample boundaries.",
      "Use narrow to rewrite noisy generated title, summary, statement, action, or why_it_is_stable fields before activation.",
      "Use retire if the candidate would still need noisy generated title, summary, statement, or action fields after narrowing.",
      "Use retire when the candidate is too broad, mixed, unsupported, operationally vague, or user-specific only.",
      "Do not invent evidence or cite source cases not provided.",
    ],
    kind,
    candidate: {
      candidate_id: candidate?.candidate_id ?? null,
      workspace_id: candidate?.workspace_id ?? null,
      source_case_refs: candidate?.source_case_refs ?? [],
      evidence_refs: candidate?.evidence_refs ?? [],
      promotion_basis: candidate?.promotion_basis ?? entry?.promotion_basis ?? null,
      entry: entry ?? candidate?.entry ?? {},
      support_signals: candidate?.support_signals ?? {},
      counterexample_case_refs: counterexampleRefs ?? candidate?.counterexample_case_refs ?? [],
    },
    deterministic_support_check: {
      actual_decision: deterministic?.actual_decision ?? null,
      reasons: deterministic?.reasons ?? [],
      support_summary: limitArray(deterministic?.support_summary ?? [], 12),
      packet_preview: deterministic?.packet_preview ?? null,
    },
    source_cases: limitArray(prepared?.sourceCases ?? [], 6).map(summarizeCaseForJudge),
    supporting_invariants: limitArray(prepared?.supportingInvariants ?? [], 6).map(summarizeInvariantForJudge),
  };
}

function buildNarrowedEntry({ kind, entry, counterexampleRefs }) {
  const counterexampleLines = counterexampleRefs.map((caseId) => `Counterexample case ${caseId} must remain excluded.`);
  if (kind === "tactic") {
    return {
      ...entry,
      prerequisites: [
        ...(entry.prerequisites ?? []),
        "The current task must match the cited source case action pattern, not only similar vocabulary.",
      ],
      fallbacks: [
        ...(entry.fallbacks ?? []),
        ...counterexampleLines.map((line) => `${line} Use active case retrieval instead.`),
      ],
    };
  }

  return {
    ...entry,
    non_scope: [
      ...(entry.non_scope ?? []),
      ...counterexampleLines,
    ],
    non_applicability_conditions: [
      ...(entry.non_applicability_conditions ?? []),
      "Do not apply when the current case shares vocabulary but differs in action, failure mode, or workspace boundary.",
    ],
    known_breakers: [
      ...(entry.known_breakers ?? []),
      ...counterexampleLines,
    ],
  };
}

function summarizeCaseForJudge(record) {
  return {
    case_id: record?.case_id ?? null,
    workspace_id: record?.workspace_id ?? null,
    problem_statement: truncateString(record?.problem_statement, 1200),
    action_taken: truncateString(record?.action_taken, 1200),
    outcome: truncateString(record?.outcome, 800),
    failure_mode: truncateString(record?.failure_mode, 800),
    applicability: {
      when_to_apply: limitArray(record?.applicability?.when_to_apply ?? [], 6).map((line) => truncateString(line, 400)),
      when_not_to_apply: limitArray(record?.applicability?.when_not_to_apply ?? [], 6).map((line) => truncateString(line, 400)),
    },
    toolchain: limitArray(record?.context?.toolchain ?? [], 8),
  };
}

function summarizeInvariantForJudge(record) {
  return {
    id: record?.id ?? null,
    workspace_id: record?.workspace_id ?? null,
    title: truncateString(record?.title, 300),
    summary: truncateString(record?.summary, 800),
    statement: truncateString(record?.statement, 1000),
    scope: limitArray(record?.scope ?? [], 6).map((line) => truncateString(line, 300)),
    non_scope: limitArray(record?.non_scope ?? [], 6).map((line) => truncateString(line, 300)),
    known_breakers: limitArray(record?.known_breakers ?? [], 6).map((line) => truncateString(line, 300)),
  };
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  let timeoutId = null;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`promotion judge model request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fetchImpl(url, options),
      timeout,
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseModelJudgeResponse(responseJson) {
  const outputText = extractOutputText(responseJson);
  if (!outputText) {
    throw new Error("model response did not include output text");
  }

  return JSON.parse(outputText);
}

function extractOutputText(responseJson) {
  if (typeof responseJson?.output_text === "string") {
    return responseJson.output_text;
  }

  for (const output of responseJson?.output ?? []) {
    for (const content of output.content ?? []) {
      if (typeof content.text === "string") {
        return content.text;
      }
    }
  }

  return null;
}

function assertModelResponseSemantics(response) {
  if (response.decision === "narrow" && !response.narrowed_entry) {
    throw new Error("narrow decision requires narrowed_entry");
  }
  if (response.decision !== "narrow" && response.narrowed_entry !== null) {
    throw new Error("activate/retire decisions must set narrowed_entry to null");
  }
}

function normalizeAuditResponse(response) {
  if (!response || typeof response !== "object") {
    return null;
  }

  return {
    id: response.id ?? null,
    status: response.status ?? null,
    output_text: truncateString(extractOutputText(response), 4000),
    error: response.error ?? null,
  };
}

function stripJsonSchemaMeta(schema) {
  const clone = structuredClone(schema);
  delete clone.$schema;
  return clone;
}

function createAuditId({ candidateId, createdAt, requestHash, responseHash }) {
  const digest = crypto
    .createHash("sha1")
    .update(`${candidateId}:${createdAt}:${requestHash}:${responseHash}:${crypto.randomUUID()}`)
    .digest("hex")
    .slice(0, 16);
  return `pja_${digest}`;
}

function createHash(value) {
  return `sha256:${crypto.createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function limitArray(value, limit) {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

function truncateString(value, maxLength) {
  const text = String(value ?? "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function isGenericCandidateText(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return true;
  }

  const genericPatterns = [
    "follow the existing procedure",
    "document the current behavior",
    "review the cases",
    "discuss the plan",
    "use best practices",
    "handle the task",
  ];

  return genericPatterns.some((pattern) => normalized.includes(pattern));
}

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = {
  LocalSemanticPromotionJudge,
  ModelBackedPromotionJudge,
  PromotionJudgeAuditStore,
  UnavailablePromotionJudge,
  buildPromotionJudge,
  normalizeJudgeDecision,
};

const MODEL_JUDGE_INSTRUCTIONS = [
  "You are the ECITR higher-promotion semantic judge.",
  "You decide whether a staged invariant or tactic candidate should be activated, narrowed, or retired.",
  "Deterministic support checks are mandatory and have already run. Never override a deterministic failure.",
  "Return only JSON matching the provided schema.",
  "Use activate only for narrow, reusable, non-generic candidates that are supported by all supplied source cases.",
  "Use narrow when the reusable pattern is real but must get stricter scope, non-scope, known breakers, prerequisites, fallbacks, or rewritten semantic fields.",
  "For narrow decisions, rewrite generated or token-baggy title, summary, statement, action, and why_it_is_stable fields into plain operational language.",
  "Do not leave active-facing fields that look like tag bags, labels, shared-signal lists, or machine tokens with underscores.",
  "Use retire when the candidate is broad, mixed, unsupported, merely process advice, user-specific, or not operationally reusable.",
  "Do not invent source cases, evidence, tools, or outcomes.",
].join("\n");
