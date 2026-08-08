const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const { CaseSeedStore } = require("../src/cases/case-seed-store");
const { createSha256 } = require("../src/evidence/file-payload-store");
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
    workspace_id: "ecitr_model",
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
    definition_id: "paramdef_97a187caebdaa015ed6b",
    workspace_id: "ecitr_model",
    observed_key: "ECITR_LANCEDB_URI",
    normalized_key: "ecitr_lancedb_uri",
    value_type: "string",
    created_at: "2026-04-11T12:00:00.000Z",
    first_observed_at: "2026-04-11T12:00:00.000Z",
    first_source_evidence_ref: "ev_run_001",
  });
  catalog.writeRecord("parameter_observation", {
    observation_id: "paramobs_69ffb089fa1fc0bbf752",
    definition_id: "paramdef_97a187caebdaa015ed6b",
    workspace_id: "ecitr_model",
    parameter_key: "ECITR_LANCEDB_URI",
    raw_value_text: ".local/lancedb",
    value_type: "string",
    value_json: ".local/lancedb",
    observation_kind: "set",
    observed_at: "2026-04-11T12:00:00.000Z",
    project_scope: "project",
    source_evidence_refs: ["ev_run_001"],
    source_spans: [
      {
        path: "config.lancedb.uri",
        start_line: 1,
        end_line: 1,
        start_char: 0,
        end_char: 32,
        quote: "ECITR_LANCEDB_URI=.local/lancedb",
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
  assert.equal(draftCase.workspace_id, "ecitr_model");
  assert.deepEqual(draftCase.parameter_observation_refs, ["paramobs_69ffb089fa1fc0bbf752"]);
  assert.match(draftCase.problem_statement, /autonomous cases pipeline/);
  assert.ok(draftCase.open_questions.some((value) => value.includes("applicability.when_to_apply")));
});

test("refreshCases can skip legacy autonomous evidence distillation", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-cases-seed-only-"));
  const catalog = new FileBackedCatalog({ rootDir });
  const payloadRef = path.join("payloads", "evidence", "tests", "runs", "2026", "04", "ev_run_seed_only.json");
  fs.mkdirSync(path.dirname(path.join(rootDir, payloadRef)), { recursive: true });
  fs.writeFileSync(path.join(rootDir, payloadRef), `${JSON.stringify({
    objective: "Legacy autodistill should not run in seed-only mode.",
    steps_completed: ["Imported historical run evidence."],
    findings: ["Only closeout-authored case seeds should compile."],
    blockers: [],
  }, null, 2)}\n`, "utf8");

  catalog.writeRecord("evidence", {
    evidence_id: "ev_run_seed_only",
    workspace_id: "ecitr_model",
    substrate_ref: "file:///tmp/run-seed-only.json",
    source_type: "file",
    source_locator: "/tmp/run-seed-only.json",
    captured_at: "2026-04-11T12:00:00.000Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: payloadRef,
    payload_hash: "sha256:test",
    source_hash: "sha256:test-source",
    redaction_state: "none",
    immutable: true,
  });

  const summary = refreshCases({
    catalogRoot: rootDir,
    includeLegacyAutodistill: false,
  });

  assert.equal(summary.include_legacy_autodistill, false);
  assert.equal(summary.scanned_evidence, 0);
  assert.equal(summary.supported_evidence, 0);
  assert.equal(summary.seed_case_seeds_scanned, 0);
  assert.equal(summary.draft_cases_written, 0);
  assert.equal(fs.existsSync(path.join(rootDir, "cases")), false);
});

test("refreshCases compiles draft cases from agent-authored case seeds", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-seeded-cases-"));
  const seedStore = new CaseSeedStore({ rootDir });
  const runRecord = {
    id: "run_seeded_case",
    project_id: "agent_ops",
    session_ref: "memory/sessions/2026/04/session_seeded_case.json",
    thread_ref: "codex-thread://thread-seeded-case",
    ecitr_closeout: candidateCloseout(),
    created_at: "2026-04-11T12:00:00.000Z",
  };

  const created = seedStore.upsertFromRun({
    runRef: "memory/runs/2026/04/run_seeded_case.json",
    runRecord,
    runEvidenceRef: "ev_aops_run_run_seeded_case",
    workspaceId: "agent_ops_workspace",
    sourceRunArtifactHash: createSha256(JSON.stringify(runRecord)),
    now: "2026-04-11T12:00:01.000Z",
  });
  seedStore.attachSessionEvidence({
    sessionRef: "memory/sessions/2026/04/session_seeded_case.json",
    sessionEvidenceRef: "ev_aops_session_session_seeded_case",
    now: "2026-04-11T12:00:02.000Z",
  });
  seedStore.attachChatEvidence({
    threadRef: "codex-thread://thread-seeded-case",
    chatEvidenceRef: "ev_codex_thread_thread_seeded_case_20260411_120005000Z",
    now: "2026-04-11T12:00:03.000Z",
  });

  const first = refreshCases({
    catalogRoot: rootDir,
    workspaceId: "agent_ops_workspace",
  });
  const second = refreshCases({
    catalogRoot: rootDir,
    workspaceId: "agent_ops_workspace",
  });
  const catalog = new FileBackedCatalog({ rootDir });
  const draftCases = catalog.listRecords("case");
  const draftCase = draftCases[0];
  const compiledSeed = seedStore.getSeed(created.seed.case_seed_id);

  assert.equal(first.seed_case_seeds_scanned, 1);
  assert.equal(first.seed_case_seeds_supported, 1);
  assert.equal(first.draft_cases_written, 1);
  assert.equal(second.draft_cases_written, 0);
  assert.equal(draftCases.length, 1);
  assert.equal(draftCase.problem_statement, "Closeout-authored seeds should become draft case semantics.");
  assert.equal(draftCase.action_taken, "Captured the case seed during agent-ops closeout.");
  assert.equal(draftCase.outcome, "ECITR compiled a draft from the seed packet, not chat summarization.");
  assert.equal(draftCase.failure_mode, "Transcript summarization can change or invent reusable meaning.");
  assert.deepEqual(draftCase.context.constraints, ["Run, session, and chat evidence are provenance only."]);
  assert.deepEqual(draftCase.applicability.when_to_apply, [
    "A future agent is deciding whether closeout-authored seed semantics apply.",
    "The run evidence includes ecitr_closeout.decision = candidate.",
    "Use the seed packet to compile a review-gated draft case.",
  ]);
  assert.deepEqual(draftCase.applicability.when_not_to_apply, [
    "The run closeout decision is none or not_applicable.",
  ]);
  assert.deepEqual(draftCase.evidence_refs, [
    "ev_aops_run_run_seeded_case",
    "ev_aops_session_session_seeded_case",
    "ev_codex_thread_thread_seeded_case_20260411_120005000Z",
  ]);
  assert.equal(compiledSeed.status, "compiled");
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
    workspace_id: "ecitr_model",
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

test("refreshCases can scope distillation to one workspace id", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-cases-"));
  const catalog = new FileBackedCatalog({ rootDir });
  const payloadDir = path.join(rootDir, "payloads", "evidence", "tests", "runs", "2026", "04");
  fs.mkdirSync(payloadDir, { recursive: true });

  const msbcPayloadRef = path.join("payloads", "evidence", "tests", "runs", "2026", "04", "ev_msbc.json");
  fs.writeFileSync(path.join(rootDir, msbcPayloadRef), `${JSON.stringify({
    objective: "MSBC objective",
    steps_completed: ["Added report 1303 layout."],
    findings: ["Manual layout selection is still required."],
    blockers: [],
  }, null, 2)}\n`);
  const otherPayloadRef = path.join("payloads", "evidence", "tests", "runs", "2026", "04", "ev_other.json");
  fs.writeFileSync(path.join(rootDir, otherPayloadRef), `${JSON.stringify({
    objective: "Other objective",
    steps_completed: ["Other step."],
    findings: ["Other finding."],
    blockers: [],
  }, null, 2)}\n`);

  catalog.writeRecord("evidence", {
    evidence_id: "ev_msbc",
    workspace_id: "ms_business_central",
    substrate_ref: "file:///tmp/ev_msbc.json",
    source_type: "file",
    source_locator: "/tmp/ev_msbc.json",
    captured_at: "2026-04-11T12:00:00.000Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: msbcPayloadRef,
    payload_hash: "sha256:test",
    source_hash: "sha256:test",
    redaction_state: "none",
    immutable: true,
  });
  catalog.writeRecord("evidence", {
    evidence_id: "ev_other",
    workspace_id: "other_workspace",
    substrate_ref: "file:///tmp/ev_other.json",
    source_type: "file",
    source_locator: "/tmp/ev_other.json",
    captured_at: "2026-04-11T12:01:00.000Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: otherPayloadRef,
    payload_hash: "sha256:test",
    source_hash: "sha256:test",
    redaction_state: "none",
    immutable: true,
  });

  const summary = refreshCases({
    catalogRoot: rootDir,
    workspaceId: "ms_business_central",
  });

  assert.equal(summary.workspace_id, "ms_business_central");
  assert.equal(summary.scanned_evidence, 1);
  assert.equal(summary.draft_cases_written, 1);
  assert.equal(fs.readdirSync(path.join(rootDir, "cases")).length, 1);
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
      workspace_id: "ecitr_model",
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
  assert.equal(packet.workspace_id, "ecitr_model");
  assert.ok(packet.open_questions.some((value) => value.includes("failure_mode")));
  assert.equal(packet.context.project_scope, "project");
  assert.deepEqual(packet.context.toolchain, []);
});

function candidateCloseout() {
  return {
    decision: "candidate",
    seed: {
      future_decision: "A future agent is deciding whether closeout-authored seed semantics apply.",
      activate_when: "The run evidence includes ecitr_closeout.decision = candidate.",
      do_not_apply_when: "The run closeout decision is none or not_applicable.",
      plan_effect: "Use the seed packet to compile a review-gated draft case.",
      problem: "Closeout-authored seeds should become draft case semantics.",
      constraints: "Run, session, and chat evidence are provenance only.",
      action_taken: "Captured the case seed during agent-ops closeout.",
      outcome: "ECITR compiled a draft from the seed packet, not chat summarization.",
      failure_mode: "Transcript summarization can change or invent reusable meaning.",
      confidence: 0.83,
    },
  };
}
