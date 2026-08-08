const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createDefinitionId } = require("../src/parameters/common");
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
      { sequence: 1, role: "user", text: "ECITR_LANCEDB_URI=.local/lancedb" },
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
  assert.equal(observations[0].parameter_key, "ECITR_LANCEDB_URI");
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

test("parameter refresh distills only the current evidence correction", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-params-correction-"));
  const catalog = new FileBackedCatalog({ rootDir });

  seedEnvEvidence({
    catalog,
    rootDir,
    evidenceId: "ev_params_correction_original",
    capturedAt: "2026-04-15T09:05:00.000Z",
    text: "SERVICE_TIMEOUT=30\n",
    workspaceId: "ecitr_model",
  });
  refreshParameters({ catalogRoot: rootDir });

  const original = catalog.getRecord("evidence", "ev_params_correction_original");
  catalog.writeRecord("evidence", {
    ...original,
    evidence_id: "ev_params_correction_current",
    workspace_id: "ms_business_central",
    correction_of: original.evidence_id,
  });

  const first = refreshParameters({ catalogRoot: rootDir });
  const second = refreshParameters({ catalogRoot: rootDir });
  const observations = catalog.listRecords("parameter_observation");
  const currentObservations = observations.filter((observation) =>
    observation.source_evidence_refs.includes("ev_params_correction_current"));

  assert.equal(first.scanned_evidence, 1);
  assert.equal(first.conflicts, 0);
  assert.equal(first.observations_written, 1);
  assert.equal(second.conflicts, 0);
  assert.equal(second.skipped_existing_observations, 1);
  assert.equal(currentObservations.length, 1);
  assert.equal(currentObservations[0].workspace_id, "ms_business_central");
});

test("parameter refresh treats repeated definitions with different first-seen metadata as benign", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-params-benign-def-"));
  const catalog = new FileBackedCatalog({ rootDir });

  seedEnvEvidence({
    catalog,
    rootDir,
    evidenceId: "ev_params_benign_001",
    capturedAt: "2026-04-15T09:05:00.000Z",
    text: "FOO=1\n",
  });

  const first = refreshParameters({ catalogRoot: rootDir });

  seedEnvEvidence({
    catalog,
    rootDir,
    evidenceId: "ev_params_benign_002",
    capturedAt: "2026-04-15T09:10:00.000Z",
    text: "FOO=2\n",
  });

  const second = refreshParameters({ catalogRoot: rootDir });
  const definitions = catalog.listRecords("parameter_definition");
  const observations = catalog.listRecords("parameter_observation");

  assert.equal(first.conflicts, 0);
  assert.equal(second.conflicts, 0);
  assert.equal(second.benign_conflicts, 1);
  assert.equal(second.benign_conflict_details[0].record_type, "parameter_definition");
  assert.deepEqual(second.benign_conflict_details[0].differing_fields, [
    "created_at",
    "first_observed_at",
    "first_source_evidence_ref",
  ]);
  assert.equal(definitions.length, 1);
  assert.equal(observations.length, 2);
});

test("parameter refresh reports material definition conflicts", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-params-material-def-"));
  const catalog = new FileBackedCatalog({ rootDir });

  seedEnvEvidence({
    catalog,
    rootDir,
    evidenceId: "ev_params_material_def_001",
    capturedAt: "2026-04-15T09:05:00.000Z",
    text: "FOO=1\n",
  });

  refreshParameters({ catalogRoot: rootDir });
  const definitionId = createDefinitionId({ observedKey: "FOO" });
  const definition = catalog.getRecord("parameter_definition", definitionId);
  catalog.writeRecord("parameter_definition", {
    ...definition,
    observed_key: "BAR",
    normalized_key: "bar",
  }, { overwrite: true });

  const second = refreshParameters({ catalogRoot: rootDir });

  assert.equal(second.conflicts, 1);
  assert.equal(second.benign_conflicts, 0);
  assert.equal(second.conflict_details[0].record_type, "parameter_definition");
  assert.deepEqual(second.conflict_details[0].differing_fields, ["observed_key", "normalized_key"]);
});

test("parameter refresh treats definition value-type drift as benign descriptor metadata", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-params-benign-def-type-"));
  const catalog = new FileBackedCatalog({ rootDir });

  seedEnvEvidence({
    catalog,
    rootDir,
    evidenceId: "ev_params_benign_def_type_001",
    capturedAt: "2026-04-15T09:05:00.000Z",
    text: "FOO=1\n",
  });

  refreshParameters({ catalogRoot: rootDir });
  const definitionId = createDefinitionId({ observedKey: "FOO" });
  const definition = catalog.getRecord("parameter_definition", definitionId);
  catalog.writeRecord("parameter_definition", {
    ...definition,
    value_type: "string",
  }, { overwrite: true });

  const second = refreshParameters({ catalogRoot: rootDir });

  assert.equal(second.conflicts, 0);
  assert.equal(second.benign_conflicts, 1);
  assert.equal(second.benign_conflict_details[0].record_type, "parameter_definition");
  assert.deepEqual(second.benign_conflict_details[0].differing_fields, ["value_type"]);
});

test("parameter refresh repairs legacy definition workspace mismatches when stable id proves the target workspace", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-params-repair-def-workspace-"));
  const catalog = new FileBackedCatalog({ rootDir });

  seedEnvEvidence({
    catalog,
    rootDir,
    evidenceId: "ev_params_repair_def_workspace_001",
    capturedAt: "2026-04-15T09:05:00.000Z",
    text: "FOO=1\n",
    workspaceId: "ecitr_model",
  });

  refreshParameters({ catalogRoot: rootDir });
  const definitionId = createDefinitionId({ workspaceId: "ecitr_model", observedKey: "FOO" });
  const definition = catalog.getRecord("parameter_definition", definitionId);
  catalog.writeRecord("parameter_definition", {
    ...definition,
    workspace_id: "ms_business_central",
  }, { overwrite: true });

  const dryRun = refreshParameters({ catalogRoot: rootDir, dryRun: true });
  const liveRun = refreshParameters({ catalogRoot: rootDir });
  const repairedDefinition = catalog.getRecord("parameter_definition", definitionId);

  assert.equal(dryRun.conflicts, 0);
  assert.equal(dryRun.repairs_planned, 1);
  assert.equal(liveRun.conflicts, 0);
  assert.equal(liveRun.repairs_written, 1);
  assert.equal(repairedDefinition.workspace_id, "ecitr_model");
});

test("parameter refresh reports material observation conflicts", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-params-material-obs-"));
  const catalog = new FileBackedCatalog({ rootDir });

  seedEnvEvidence({
    catalog,
    rootDir,
    evidenceId: "ev_params_material_obs_001",
    capturedAt: "2026-04-15T09:05:00.000Z",
    text: "FOO=1\n",
  });

  refreshParameters({ catalogRoot: rootDir });
  const observation = catalog.listRecords("parameter_observation")[0];
  catalog.writeRecord("parameter_observation", {
    ...observation,
    value_json: 2,
  }, { overwrite: true });

  const second = refreshParameters({ catalogRoot: rootDir });

  assert.equal(second.conflicts, 1);
  assert.equal(second.benign_conflicts, 0);
  assert.equal(second.conflict_details[0].record_type, "parameter_observation");
  assert.deepEqual(second.conflict_details[0].differing_fields, ["value_json"]);
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

function seedEnvEvidence({ catalog, rootDir, evidenceId, capturedAt, text, workspaceId = null }) {
  const payloadRef = path.join("payloads", "evidence", "tests", "env", "2026", "04", `${evidenceId}.env`);
  const payloadPath = path.join(rootDir, payloadRef);

  fs.mkdirSync(path.dirname(payloadPath), { recursive: true });
  fs.writeFileSync(payloadPath, text, "utf8");

  catalog.writeRecord("evidence", {
    evidence_id: evidenceId,
    substrate_ref: `file:///tmp/${evidenceId}.env`,
    source_type: "file",
    source_locator: `/tmp/${evidenceId}.env`,
    captured_at: capturedAt,
    project_scope: "project",
    actor_scope: "system",
    verbatim_payload_ref: payloadRef,
    payload_hash: "sha256:test",
    source_hash: "sha256:test-source",
    redaction_state: "none",
    immutable: true,
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
  });
}

test("diff distiller emits set and unset observations with supersession", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-params-diff-"));
  const catalog = new FileBackedCatalog({ rootDir });
  const payloadRef = path.join("payloads", "evidence", "tests", "diff", "2026", "04", "ev_diff_params_001.patch");
  const payloadPath = path.join(rootDir, payloadRef);

  fs.mkdirSync(path.dirname(payloadPath), { recursive: true });
  fs.writeFileSync(
    payloadPath,
    "--- a/.env\n+++ b/.env\n-ECITR_LANCEDB_URI=.local/lancedb-v1\n+ECITR_LANCEDB_URI=.local/lancedb\n",
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
