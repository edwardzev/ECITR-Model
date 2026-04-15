const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const {
  buildCompilationPacketFromEvidence,
  refreshCases,
} = require("../src/cases/case-refresh");

test("refreshCases writes staged packets and draft cases from structured run evidence", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-cases-"));
  const catalog = new FileBackedCatalog({ rootDir });
  const payloadDir = path.join(rootDir, "payloads", "evidence", "tests", "runs", "2026", "04");
  fs.mkdirSync(payloadDir, { recursive: true });

  const payload = {
    objective: "Build the first autonomous cases pipeline from canonical evidence.",
    steps_completed: [
      "Added a packet store for staged case compilation input.",
      "Implemented a nightly case refresh command.",
    ],
    findings: [
      "Structured run evidence can produce honest draft cases without inventing applicability.",
    ],
    blockers: [],
    lesson_candidates: ["Draft cases should preserve open questions instead of fabricating missing fields."],
  };

  const payloadRef = path.join("payloads", "evidence", "tests", "runs", "2026", "04", "ev_run_001.json");
  fs.writeFileSync(path.join(rootDir, payloadRef), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  catalog.writeRecord("evidence", {
    evidence_id: "ev_run_001",
    substrate_ref: "file:///tmp/run-001.json",
    source_type: "file",
    source_locator: "/tmp/run-001.json",
    captured_at: "2026-04-11T12:00:00.000Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: payloadRef,
    payload_hash: "sha256:test",
    source_hash: "sha256:test-source",
    redaction_state: "none",
    immutable: true,
  });
  catalog.writeRecord("parameter_definition", {
    definition_id: "paramdef_refresh_case_qdrant_url",
    observed_key: "ECITR_QDRANT_URL",
    normalized_key: "ecitr_qdrant_url",
    value_type: "string",
    created_at: "2026-04-11T12:00:00.000Z",
    first_observed_at: "2026-04-11T12:00:00.000Z",
    first_source_evidence_ref: "ev_run_001",
  });
  catalog.writeRecord("parameter_observation", {
    observation_id: "paramobs_refresh_case_qdrant_url",
    definition_id: "paramdef_refresh_case_qdrant_url",
    parameter_key: "ECITR_QDRANT_URL",
    raw_value_text: "http://127.0.0.1:6333",
    value_type: "string",
    value_json: "http://127.0.0.1:6333",
    observation_kind: "set",
    observed_at: "2026-04-11T12:00:00.000Z",
    project_scope: "project",
    source_evidence_refs: ["ev_run_001"],
    source_spans: [
      {
        path: "config.qdrant.url",
        start_line: 1,
        end_line: 1,
        start_char: 0,
        end_char: 21,
        quote: "ECITR_QDRANT_URL=http://127.0.0.1:6333",
      },
    ],
    strategy_id: "parameter-distiller-file-v1",
    extracted_at: "2026-04-11T12:00:00.000Z",
    extracted_by: "parameter-distiller",
    confidence: 0.9,
  });

  const summary = refreshCases({ catalogRoot: rootDir });
  const stagedDir = path.join(rootDir, "staging", "case-compilation-packets");
  const casesDir = path.join(rootDir, "cases");
  const caseRecords = fs.readdirSync(casesDir);
  const stagedPackets = fs.readdirSync(stagedDir);
  const draftCase = JSON.parse(fs.readFileSync(path.join(casesDir, caseRecords[0]), "utf8"));

  assert.equal(summary.supported_evidence, 1);
  assert.equal(summary.packets_written, 1);
  assert.equal(summary.draft_cases_written, 1);
  assert.equal(stagedPackets.length, 1);
  assert.equal(caseRecords.length, 1);
  assert.equal(draftCase.status, "draft");
  assert.equal(draftCase.review_state, "draft");
  assert.deepEqual(draftCase.parameter_observation_refs, ["paramobs_refresh_case_qdrant_url"]);
  assert.match(draftCase.problem_statement, /autonomous cases pipeline/);
  assert.ok(draftCase.open_questions.some((value) => value.includes("applicability.when_to_apply")));
});

test("refreshCases skips unsupported evidence and remains idempotent on rerun", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-cases-"));
  const catalog = new FileBackedCatalog({ rootDir });
  const payloadDir = path.join(rootDir, "payloads", "evidence", "tests", "chat", "2026", "04");
  fs.mkdirSync(payloadDir, { recursive: true });
  const payloadRef = path.join("payloads", "evidence", "tests", "chat", "2026", "04", "ev_chat_001.json");
  fs.writeFileSync(path.join(rootDir, payloadRef), `${JSON.stringify({ messages: [{ role: "user", text: "hello" }] }, null, 2)}\n`, "utf8");

  catalog.writeRecord("evidence", {
    evidence_id: "ev_chat_001",
    substrate_ref: "codex-thread://thread-001",
    source_type: "chat",
    source_locator: "codex-thread://thread-001",
    captured_at: "2026-04-11T12:05:00.000Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: payloadRef,
    payload_hash: "sha256:test",
    source_hash: "sha256:test-source",
    redaction_state: "none",
    immutable: true,
  });

  const first = refreshCases({ catalogRoot: rootDir });
  const second = refreshCases({ catalogRoot: rootDir });

  assert.equal(first.skipped_unsupported, 1);
  assert.equal(second.skipped_unsupported, 1);
  assert.equal(second.draft_cases_written, 0);
  assert.equal(second.packets_written, 0);
});

test("buildCompilationPacketFromEvidence preserves missing framing as open questions", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-cases-"));
  const payloadDir = path.join(rootDir, "payloads", "evidence", "tests", "runs", "2026", "04");
  fs.mkdirSync(payloadDir, { recursive: true });
  const payloadRef = path.join("payloads", "evidence", "tests", "runs", "2026", "04", "ev_run_002.json");
  fs.writeFileSync(
    path.join(rootDir, payloadRef),
    `${JSON.stringify({
      objective: "Preserve missing case framing instead of inventing it.",
      steps_completed: ["Compiled a packet from explicit source fields."],
      findings: ["The source did not include blockers."],
      blockers: [],
      lesson_candidates: [],
    }, null, 2)}\n`,
    "utf8",
  );

  const packet = buildCompilationPacketFromEvidence(
    {
      evidence_id: "ev_run_002",
      project_scope: "project",
      verbatim_payload_ref: payloadRef,
      captured_at: "2026-04-11T12:10:00.000Z",
    },
    {
      catalogRoot: rootDir,
      derivationRuleId: "case-autodistill-run-v1",
      authoringAgent: "case-distiller",
    },
  );

  assert.equal(packet.failure_mode, undefined);
  assert.ok(packet.open_questions.some((value) => value.includes("failure_mode")));
  assert.equal(packet.context.project_scope, "project");
  assert.deepEqual(packet.context.toolchain, []);
});
