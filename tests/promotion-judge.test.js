const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ModelBackedPromotionJudge,
  PromotionJudgeAuditStore,
  buildPromotionJudge,
} = require("../src/runtime/promotion-judge");

test("local promotion judge activates supported candidates without counterexamples", async () => {
  const judge = buildPromotionJudge({ mode: "local" });
  const result = await judge.judgeCandidate({
    kind: "invariant",
    candidate: makeCandidate(),
    deterministic: { actual_decision: "approve", reasons: [] },
  });

  assert.equal(result.decision, "activate");
});

test("local promotion judge narrows supported candidates with counterexamples", async () => {
  const judge = buildPromotionJudge({ mode: "local" });
  const result = await judge.judgeCandidate({
    kind: "invariant",
    candidate: makeCandidate({ counterexample_case_refs: ["case_counterexample_001"] }),
    deterministic: { actual_decision: "approve", reasons: [] },
  });

  assert.equal(result.decision, "narrow");
  assert.match(result.narrowed_entry.known_breakers.join("\n"), /case_counterexample_001/);
});

test("local promotion judge retires generic candidates", async () => {
  const judge = buildPromotionJudge({ mode: "local" });
  const result = await judge.judgeCandidate({
    kind: "invariant",
    candidate: makeCandidate({
      entry: {
        title: "Follow the existing procedure",
        summary: "Use best practices and handle the task.",
        statement: "Follow the existing procedure.",
      },
    }),
    deterministic: { actual_decision: "approve", reasons: [] },
  });

  assert.equal(result.decision, "retire");
});

test("local promotion judge retires direct tactics without repeated action support", async () => {
  const judge = buildPromotionJudge({ mode: "local" });
  const result = await judge.judgeCandidate({
    kind: "tactic",
    candidate: makeCandidate({
      entry: {
        promotion_basis: "case_cluster",
        title: "Daemon HTTP tactic",
        summary: "Switch daemon MCP config to local HTTP URL after healthcheck.",
        action: "Switch daemon MCP config to local HTTP URL after healthcheck.",
      },
      support_signals: {
        score: 0.8,
        shared_tokens: ["daemon", "http", "mcp", "config", "healthcheck"],
        shared_action_tokens: ["daemon"],
      },
    }),
    deterministic: { actual_decision: "approve", reasons: [] },
  });

  assert.equal(result.decision, "retire");
});

test("model-backed promotion judge activates valid structured model decisions and writes audit", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-model-judge-"));
  const calls = [];
  const judge = new ModelBackedPromotionJudge({
    apiKey: "test-key",
    model: "gpt-test",
    auditStore: new PromotionJudgeAuditStore({ rootDir }),
    now: () => "2099-01-01T00:00:00.000Z",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return createJsonResponse({
        id: "resp_test_activate",
        output_text: JSON.stringify({
          decision: "activate",
          rationale: "The candidate is narrow and supported across the supplied source cases.",
          narrowed_entry: null,
        }),
      });
    },
  });

  const result = await judge.judgeCandidate({
    kind: "invariant",
    candidate: makeCandidate(),
    deterministic: { actual_decision: "approve", reasons: [], support_summary: [] },
    prepared: {
      sourceCases: [makeSourceCase()],
    },
  });

  const requestBody = JSON.parse(calls[0].options.body);
  const audits = new PromotionJudgeAuditStore({ rootDir }).listAudits();
  assert.equal(result.decision, "activate");
  assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
  assert.equal(requestBody.text.format.type, "json_schema");
  assert.match(requestBody.input[0].content[0].text, /case_daemon_mcp_http_a/);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].status, "completed");
  assert.equal(audits[0].decision, "activate");
  assert.equal(audits[0].model, "gpt-test");
});

test("model-backed promotion judge accepts output-array response text and returns narrowing", async () => {
  const judge = new ModelBackedPromotionJudge({
    apiKey: "test-key",
    fetchImpl: async () => createJsonResponse({
      id: "resp_test_narrow",
      output: [
        {
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                decision: "narrow",
                rationale: "The reusable pattern is real but needs rewritten semantic fields and explicit non-scope.",
                narrowed_entry: {
                  title: "Bind daemon MCP migration to transport changes",
                  summary: "Apply this only when MCP daemon work changes transport from stdio launch to local HTTP.",
                  statement: "Use daemon migration guidance only when the source cases share the same transport-change boundary.",
                  non_scope: ["Docs-only daemon configuration cases."],
                },
              }),
            },
          ],
        },
      ],
    }),
  });

  const result = await judge.judgeCandidate({
    kind: "invariant",
    candidate: makeCandidate(),
    deterministic: { actual_decision: "approve", reasons: [], support_summary: [] },
  });

  assert.equal(result.decision, "narrow");
  assert.equal(result.narrowed_entry.title, "Bind daemon MCP migration to transport changes");
  assert.deepEqual(result.narrowed_entry.non_scope, ["Docs-only daemon configuration cases."]);
});

test("model-backed promotion judge treats invalid model JSON as unavailable and audits it", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-model-judge-"));
  const judge = new ModelBackedPromotionJudge({
    apiKey: "test-key",
    auditStore: new PromotionJudgeAuditStore({ rootDir }),
    now: () => "2099-01-01T00:00:00.000Z",
    fetchImpl: async () => createJsonResponse({
      id: "resp_test_invalid",
      output_text: "{not-json",
    }),
  });

  const result = await judge.judgeCandidate({
    kind: "invariant",
    candidate: makeCandidate(),
    deterministic: { actual_decision: "approve", reasons: [], support_summary: [] },
  });

  const audits = new PromotionJudgeAuditStore({ rootDir }).listAudits();
  assert.equal(result.decision, "unavailable");
  assert.match(result.rationale, /JSON/);
  assert.equal(audits[0].status, "invalid_response");
  assert.equal(audits[0].decision, "unavailable");
});

test("model-backed promotion judge treats transport errors as unavailable and audits them", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-model-judge-"));
  const judge = new ModelBackedPromotionJudge({
    apiKey: "test-key",
    auditStore: new PromotionJudgeAuditStore({ rootDir }),
    now: () => "2099-01-01T00:00:00.000Z",
    fetchImpl: async () => {
      throw new Error("network unavailable");
    },
  });

  const result = await judge.judgeCandidate({
    kind: "invariant",
    candidate: makeCandidate(),
    deterministic: { actual_decision: "approve", reasons: [], support_summary: [] },
  });

  const audits = new PromotionJudgeAuditStore({ rootDir }).listAudits();
  assert.equal(result.decision, "unavailable");
  assert.match(result.rationale, /network unavailable/);
  assert.equal(audits[0].status, "error");
});

test("model-backed promotion judge fails closed when API key is missing", async () => {
  let called = false;
  const judge = new ModelBackedPromotionJudge({
    apiKey: "",
    fetchImpl: async () => {
      called = true;
      return createJsonResponse({});
    },
  });

  const result = await judge.judgeCandidate({
    kind: "invariant",
    candidate: makeCandidate(),
    deterministic: { actual_decision: "approve", reasons: [], support_summary: [] },
  });

  assert.equal(result.decision, "unavailable");
  assert.equal(called, false);
});

test("model-backed promotion judge does not call the model after deterministic failure", async () => {
  let called = false;
  const judge = new ModelBackedPromotionJudge({
    apiKey: "test-key",
    fetchImpl: async () => {
      called = true;
      return createJsonResponse({});
    },
  });

  const result = await judge.judgeCandidate({
    kind: "invariant",
    candidate: makeCandidate(),
    deterministic: {
      actual_decision: "block",
      reasons: ["source case is inactive"],
    },
  });

  assert.equal(result.decision, "retire");
  assert.equal(called, false);
});

function makeCandidate(overrides = {}) {
  return {
    candidate_id: "lic_test_model_judge",
    workspace_id: "agent_ops",
    source_case_refs: ["case_daemon_mcp_http_a", "case_daemon_mcp_http_b"],
    evidence_refs: ["ev_case_daemon_mcp_http_a", "ev_case_daemon_mcp_http_b"],
    entry: {
      title: "Workspace scoped daemon migration",
      summary: "Daemon migration requires healthcheck, local HTTP MCP config, and workspace scoped rollback.",
      statement: "Apply daemon migration only when healthcheck and local HTTP MCP config boundaries match.",
    },
    support_signals: {
      score: 0.8,
      shared_tokens: ["daemon", "migration", "healthcheck", "http", "workspace"],
      shared_action_tokens: ["daemon", "healthcheck", "config"],
    },
    counterexample_case_refs: [],
    ...overrides,
  };
}

function makeSourceCase() {
  return {
    case_id: "case_daemon_mcp_http_a",
    workspace_id: "agent_ops",
    problem_statement: "Codex reload created duplicate MCP node processes during daemon migration.",
    action_taken: "Implement daemon healthcheck and switch MCP config to local HTTP URL with stdio rollback.",
    outcome: "Reloads reused one daemon endpoint.",
    failure_mode: "Per-reload stdio launch duplicated MCP processes.",
    applicability: {
      when_to_apply: ["MCP server migration from stdio to daemon HTTP transport."],
      when_not_to_apply: ["The MCP server has no daemon mode."],
    },
    context: {
      toolchain: ["agent-ops-daemon", "codex-mcp"],
    },
  };
}

function createJsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}
