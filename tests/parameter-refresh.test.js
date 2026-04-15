const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { refreshParameters } = require("../src/parameters/refresh");
const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");

test("chat distiller captures explicit literal bindings and skips prose-only guesses", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-params-chat-"));
  const catalog = new FileBackedCatalog({ rootDir });
  const payloadRef = path.join("payloads", "evidence", "tests", "chat", "2026", "04", "ev_chat_params_001.json");
  const payloadPath = path.join(rootDir, payloadRef);

  fs.mkdirSync(path.dirname(payloadPath), { recursive: true });
  fs.writeFileSync(payloadPath, `${JSON.stringify({
    capture_kind: "conversation_snapshot",
    messages: [
      { sequence: 1, role: "user", text: "ECITR_QDRANT_URL=http://127.0.0.1:6333" },
      { sequence: 2, role: "assistant", text: "We should probably revisit the timeout later." },
    ],
  }, null, 2)}\n`);

  catalog.writeRecord("evidence", {
    evidence_id: "ev_chat_params_001",
    substrate_ref: "codex-thread://thread-params-001",
    source_type: "chat",
    source_locator: "codex-thread://thread-params-001",
    captured_at: "2026-04-15T09:00:00.000Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: payloadRef,
    payload_hash: "sha256:test",
    source_hash: "sha256:test-source",
    redaction_state: "none",
    immutable: true,
  });

  const summary = refreshParameters({ catalogRoot: rootDir });
  const observations = catalog.listRecords("parameter_observation");

  assert.equal(summary.supported_evidence, 1);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].parameter_key, "ECITR_QDRANT_URL");
});

test("parameter refresh keeps exact-key definitions distinct and stays idempotent", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-params-env-"));
  const catalog = new FileBackedCatalog({ rootDir });
  const payloadRef = path.join("payloads", "evidence", "tests", "env", "2026", "04", "ev_env_params_001.env");
  const payloadPath = path.join(rootDir, payloadRef);

  fs.mkdirSync(path.dirname(payloadPath), { recursive: true });
  fs.writeFileSync(payloadPath, "FOO_BAR=1\nFOO-BAR=2\n", "utf8");

  catalog.writeRecord("evidence", {
    evidence_id: "ev_env_params_001",
    substrate_ref: "file:///tmp/.env",
    source_type: "file",
    source_locator: "/tmp/.env",
    captured_at: "2026-04-15T09:05:00.000Z",
    project_scope: "project",
    actor_scope: "system",
    verbatim_payload_ref: payloadRef,
    payload_hash: "sha256:test",
    source_hash: "sha256:test-source",
    redaction_state: "none",
    immutable: true,
  });

  const first = refreshParameters({ catalogRoot: rootDir });
  const second = refreshParameters({ catalogRoot: rootDir });
  const definitions = catalog.listRecords("parameter_definition");

  assert.equal(first.definitions_written, 2);
  assert.equal(first.observations_written, 2);
  assert.equal(second.skipped_existing_definitions, 2);
  assert.equal(second.skipped_existing_observations, 2);
  assert.equal(definitions.length, 2);
  assert.notEqual(definitions[0].definition_id, definitions[1].definition_id);
  assert.equal(definitions[0].normalized_key, definitions[1].normalized_key);
});

test("file distiller extracts nested JSON leaves with exact source paths and spans", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-params-json-"));
  const catalog = new FileBackedCatalog({ rootDir });
  const payloadRef = path.join("payloads", "evidence", "tests", "json", "2026", "04", "ev_json_params_001.json");
  const payloadPath = path.join(rootDir, payloadRef);

  fs.mkdirSync(path.dirname(payloadPath), { recursive: true });
  fs.writeFileSync(payloadPath, `${JSON.stringify({
    settings: {
      timeout: 30,
      endpoint: "http://127.0.0.1:6333",
    },
  }, null, 2)}\n`);

  catalog.writeRecord("evidence", {
    evidence_id: "ev_json_params_001",
    substrate_ref: "file:///tmp/config.json",
    source_type: "file",
    source_locator: "/tmp/config.json",
    captured_at: "2026-04-15T09:10:00.000Z",
    project_scope: "project",
    actor_scope: "system",
    verbatim_payload_ref: payloadRef,
    payload_hash: "sha256:test",
    source_hash: "sha256:test-source",
    redaction_state: "none",
    immutable: true,
  });

  refreshParameters({ catalogRoot: rootDir });
  const observations = catalog
    .listRecords("parameter_observation")
    .sort((left, right) => left.parameter_key.localeCompare(right.parameter_key));
  const timeoutObservation = observations.find((entry) => entry.parameter_key === "settings.timeout");

  assert.equal(observations.length, 2);
  assert.equal(timeoutObservation.value_json, 30);
  assert.equal(timeoutObservation.source_spans[0].path, "payload.settings.timeout");
  assert.match(timeoutObservation.source_spans[0].quote, /"timeout": 30/);
});

test("diff distiller emits set and unset observations with supersession", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-params-diff-"));
  const catalog = new FileBackedCatalog({ rootDir });
  const payloadRef = path.join("payloads", "evidence", "tests", "diff", "2026", "04", "ev_diff_params_001.patch");
  const payloadPath = path.join(rootDir, payloadRef);

  fs.mkdirSync(path.dirname(payloadPath), { recursive: true });
  fs.writeFileSync(
    payloadPath,
    "--- a/.env\n+++ b/.env\n-ECITR_QDRANT_URL=http://old.local\n+ECITR_QDRANT_URL=http://127.0.0.1:6333\n",
    "utf8",
  );

  catalog.writeRecord("evidence", {
    evidence_id: "ev_diff_params_001",
    substrate_ref: "file:///tmp/config.patch",
    source_type: "diff",
    source_locator: "/tmp/config.patch",
    captured_at: "2026-04-15T09:15:00.000Z",
    project_scope: "project",
    actor_scope: "system",
    verbatim_payload_ref: payloadRef,
    payload_hash: "sha256:test",
    source_hash: "sha256:test-source",
    redaction_state: "none",
    immutable: true,
  });

  refreshParameters({ catalogRoot: rootDir });
  const observations = catalog
    .listRecords("parameter_observation")
    .sort((left, right) => left.source_spans[0].start_line - right.source_spans[0].start_line);

  assert.equal(observations.length, 2);
  assert.equal(observations[0].observation_kind, "unset");
  assert.equal(observations[1].observation_kind, "set");
  assert.equal(observations[1].supersedes, observations[0].observation_id);
});

test("log distiller extracts structured values and ignores prose-only lines", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-params-log-"));
  const catalog = new FileBackedCatalog({ rootDir });
  const payloadRef = path.join("payloads", "evidence", "tests", "log", "2026", "04", "ev_log_params_001.log");
  const payloadPath = path.join(rootDir, payloadRef);

  fs.mkdirSync(path.dirname(payloadPath), { recursive: true });
  fs.writeFileSync(
    payloadPath,
    '{"collection":"ecitr-semantic","message":"sync starting"}\njust some prose without explicit parameters\n',
    "utf8",
  );

  catalog.writeRecord("evidence", {
    evidence_id: "ev_log_params_001",
    substrate_ref: "file:///tmp/agent.log",
    source_type: "log",
    source_locator: "/tmp/agent.log",
    captured_at: "2026-04-15T09:20:00.000Z",
    project_scope: "project",
    actor_scope: "system",
    verbatim_payload_ref: payloadRef,
    payload_hash: "sha256:test",
    source_hash: "sha256:test-source",
    redaction_state: "none",
    immutable: true,
  });

  refreshParameters({ catalogRoot: rootDir });
  const observations = catalog.listRecords("parameter_observation");

  assert.equal(observations.length, 1);
  assert.equal(observations[0].parameter_key, "collection");
  assert.equal(observations[0].value_json, "ecitr-semantic");
});
