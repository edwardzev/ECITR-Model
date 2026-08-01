const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const { createDefinitionId, createObservationId } = require("../src/parameters/common");
const {
  applyWorkspaceIdentityMigration,
  migrateWorkspaceIdentityBySource,
  planWorkspaceIdentityBySource,
} = require("../src/workspace/selective-migration");
const { loadExample } = require("./helpers/load-example");

test("selective workspace migration updates only MSBC-linked records", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-selective-migration-"));
  const catalog = new FileBackedCatalog({ rootDir });
  const payloadDir = path.join(rootDir, "payloads", "evidence", "tests");
  fs.mkdirSync(payloadDir, { recursive: true });

  fs.writeFileSync(path.join(payloadDir, "ev_msbc_run.json"), `${JSON.stringify({
    id: "run_msbc",
    project_id: "ms_business_central",
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(payloadDir, "ev_other_run.json"), `${JSON.stringify({
    id: "run_other",
    project_id: "other_project",
  }, null, 2)}\n`);

  catalog.writeRecord("evidence", {
    evidence_id: "ev_msbc",
    workspace_id: "ecitr_model",
    substrate_ref: "file:///tmp/ev_msbc_run.json",
    source_type: "file",
    source_locator: "/tmp/ev_msbc_run.json",
    captured_at: "2026-04-11T10:00:00.000Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: "payloads/evidence/tests/ev_msbc_run.json",
    payload_hash: "sha256:test",
    source_hash: "sha256:test",
    redaction_state: "none",
    immutable: true,
  });
  catalog.writeRecord("evidence", {
    evidence_id: "ev_other",
    workspace_id: "ecitr_model",
    substrate_ref: "file:///tmp/ev_other_run.json",
    source_type: "file",
    source_locator: "/tmp/ev_other_run.json",
    captured_at: "2026-04-11T10:01:00.000Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: "payloads/evidence/tests/ev_other_run.json",
    payload_hash: "sha256:test",
    source_hash: "sha256:test",
    redaction_state: "none",
    immutable: true,
  });
  catalog.writeRecord("case", {
    case_id: "case_msbc",
    case_version: 1,
    status: "draft",
    problem_statement: "MSBC case",
    action_taken: "Updated report layout activation.",
    outcome: "Outcome",
    failure_mode: "Manual layout selection still required.",
    evidence_refs: ["ev_msbc"],
    review_state: "draft",
    confidence: 0.7,
    derived_at: "2026-04-11T10:02:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
    open_questions: ["Confirm applicability."],
    applicability: {
      when_to_apply: ["Use for MSBC."],
      when_not_to_apply: ["Do not use elsewhere."],
    },
    workspace_id: "ecitr_model",
  });
  catalog.writeRecord("case", {
    case_id: "case_other",
    case_version: 1,
    status: "draft",
    problem_statement: "Other case",
    action_taken: "Updated another repo.",
    outcome: "Outcome",
    failure_mode: "Other blocker.",
    evidence_refs: ["ev_other"],
    review_state: "draft",
    confidence: 0.7,
    derived_at: "2026-04-11T10:03:00.000Z",
    derivation_rule_id: "case-autodistill-run-v1",
    open_questions: ["Confirm applicability."],
    applicability: {
      when_to_apply: ["Use for other workspace."],
      when_not_to_apply: ["Do not use for MSBC."],
    },
    workspace_id: "ecitr_model",
  });

  const summary = migrateWorkspaceIdentityBySource({
    catalogRoot: rootDir,
    targetWorkspaceId: "ms_business_central",
    agentOpsProjectIds: ["ms_business_central"],
    codexWorkspaceRoots: [],
    dryRun: false,
  });

  assert.equal(summary.updated_record_counts.evidence, 1);
  assert.equal(summary.updated_record_counts.cases, 1);
  assert.equal(catalog.getRecord("evidence", "ev_msbc").workspace_id, "ecitr_model");
  const correction = catalog.getRecord(
    "evidence",
    "ev_msbc_workspace_ms_business_central",
  );
  assert.equal(correction.workspace_id, "ms_business_central");
  assert.equal(correction.correction_of, "ev_msbc");
  assert.equal(catalog.getRecord("case", "case_msbc").workspace_id, "ms_business_central");
  assert.equal(catalog.getRecord("evidence", "ev_other").workspace_id, "ecitr_model");
  assert.equal(catalog.getRecord("case", "case_other").workspace_id, "ecitr_model");

  const second = migrateWorkspaceIdentityBySource({
    catalogRoot: rootDir,
    targetWorkspaceId: "ms_business_central",
    agentOpsProjectIds: ["ms_business_central"],
    codexWorkspaceRoots: [],
    dryRun: false,
  });
  assert.equal(second.updated_record_counts.evidence, 0);
  assert.equal(second.updated_record_counts.cases, 0);
});

test("workspace migration journals and remaps the complete canonical lineage", () => {
  const fixture = createMigrationFixture();
  const catalog = fixture.catalog;

  const summary = migrateWorkspaceIdentityBySource({
    catalogRoot: fixture.rootDir,
    targetWorkspaceId: "ms_business_central",
    agentOpsProjectIds: ["ms_business_central"],
    codexWorkspaceRoots: [],
    dryRun: false,
    includeStaging: false,
    plannedAt: "2099-01-02T00:00:00.000Z",
  });

  assert.equal(summary.status, "applied");
  assert.deepEqual(summary.updated_record_counts, {
    evidence: 1,
    cases: 1,
    invariants: 1,
    tactics: 1,
    parameter_definitions: 1,
    parameter_observations: 1,
  });
  assert.equal(catalog.getRecord("evidence", "ev_lineage").workspace_id, "ecitr_model");
  const correctedEvidenceId = "ev_lineage_workspace_ms_business_central";
  assert.equal(catalog.getRecord("evidence", correctedEvidenceId).correction_of, "ev_lineage");

  const definitionId = createDefinitionId({
    workspaceId: "ms_business_central",
    observedKey: "SERVICE_TIMEOUT",
  });
  const observationId = createObservationId({
    workspaceId: "ms_business_central",
    parameterKey: "SERVICE_TIMEOUT",
    observationKind: "set",
    observedAt: "2099-01-01T00:00:00.000Z",
    sourceEvidenceRefs: [correctedEvidenceId],
    sourceSpans: fixture.observation.source_spans,
    rawValueText: "30",
  });
  assert.equal(catalog.getRecord("parameter_definition", definitionId).workspace_id, "ms_business_central");
  assert.deepEqual(
    catalog.getRecord("parameter_observation", observationId).source_evidence_refs,
    [correctedEvidenceId],
  );
  assert.deepEqual(catalog.getRecord("case", "case_lineage").parameter_observation_refs, [observationId]);
  assert.equal(catalog.getRecord("case", "case_lineage").workspace_id, "ms_business_central");
  assert.equal(catalog.getRecord("invariant", "inv_lineage").workspace_id, "ms_business_central");
  const tactic = catalog.getRecord("tactic", "tac_lineage");
  assert.equal(tactic.workspace_id, "ms_business_central");
  assert.deepEqual(tactic.parameter_observation_refs, [observationId]);
  assert.deepEqual(tactic.environment_bounds, ["workspace:ms_business_central"]);

  const manifest = JSON.parse(fs.readFileSync(summary.manifest_path, "utf8"));
  assert.equal(manifest.status, "applied");
  assert.equal(manifest.summary.operation_count, 6);
  assert.ok(manifest.operations.every((operation) => operation.before_hash && operation.after_hash));

  const second = migrateWorkspaceIdentityBySource({
    catalogRoot: fixture.rootDir,
    targetWorkspaceId: "ms_business_central",
    agentOpsProjectIds: ["ms_business_central"],
    codexWorkspaceRoots: [],
    dryRun: false,
    includeStaging: false,
    plannedAt: "2099-01-03T00:00:00.000Z",
  });
  assert.deepEqual(second.updated_record_counts, {
    evidence: 0,
    cases: 0,
    invariants: 0,
    tactics: 0,
    parameter_definitions: 0,
    parameter_observations: 0,
  });
});

test("workspace migration dry-run writes nothing and blocks mixed case lineage", () => {
  const fixture = createMigrationFixture({ includeOtherEvidence: true });
  const originalCase = fixture.catalog.getRecord("case", "case_lineage");

  const summary = migrateWorkspaceIdentityBySource({
    catalogRoot: fixture.rootDir,
    targetWorkspaceId: "ms_business_central",
    agentOpsProjectIds: ["ms_business_central"],
    codexWorkspaceRoots: [],
    dryRun: true,
    includeStaging: false,
    plannedAt: "2099-01-02T00:00:00.000Z",
  });

  assert.equal(summary.status, "planned");
  assert.equal(summary.updated_record_counts.evidence, 1);
  assert.equal(summary.updated_record_counts.cases, 0);
  assert.ok(summary.blockers.some((blocker) =>
    blocker.record_type === "case" && blocker.code === "mixed_or_unresolved_lineage"));
  assert.equal(fixture.catalog.getRecord("evidence", "ev_lineage_workspace_ms_business_central"), null);
  assert.deepEqual(fixture.catalog.getRecord("case", "case_lineage"), originalCase);
  assert.equal(fs.existsSync(summary.manifest_path), false);
});

test("workspace migration remaps governed staging packet attribution and parameter refs", () => {
  const fixture = createMigrationFixture();
  const packetDir = path.join(fixture.rootDir, "staging", "tactic-promotion-packets");
  fs.mkdirSync(packetDir, { recursive: true });
  const packetPath = path.join(packetDir, "tpp_lineage.json");
  writeJson(packetPath, {
    ...loadExample("tactic_promotion_packet"),
    promotion_id: "tpp_lineage",
    workspace_id: "ecitr_model",
    source_case_refs: ["case_lineage"],
    supporting_invariant_refs: ["inv_lineage"],
    evidence_refs: ["ev_lineage"],
    parameter_observation_refs: ["paramobs_lineage"],
    environment_bounds: ["workspace:ecitr_model"],
  });
  const seedDir = path.join(fixture.rootDir, "staging", "case-seeds");
  const invariantCandidateDir = path.join(
    fixture.rootDir,
    "staging",
    "live-invariant-candidates",
  );
  const tacticCandidateDir = path.join(fixture.rootDir, "staging", "live-tactic-candidates");
  fs.mkdirSync(seedDir, { recursive: true });
  fs.mkdirSync(invariantCandidateDir, { recursive: true });
  fs.mkdirSync(tacticCandidateDir, { recursive: true });
  const seedPath = path.join(seedDir, "case_seed_lineage.json");
  const invariantCandidatePath = path.join(invariantCandidateDir, "lic_lineage.json");
  const tacticCandidatePath = path.join(tacticCandidateDir, "ltc_lineage.json");
  writeJson(seedPath, {
    ...loadExample("case_seed"),
    workspace_id: "ecitr_model",
    project_id: "ms_business_central",
    evidence_links: {
      run_evidence_ref: "ev_lineage",
      session_evidence_ref: null,
      chat_evidence_refs: [],
    },
  });
  writeJson(invariantCandidatePath, {
    ...loadExample("live_invariant_candidate"),
    candidate_id: "lic_lineage",
    status: "activated",
    workspace_id: "ecitr_model",
    source_case_refs: ["case_lineage", "case_lineage"],
    evidence_refs: ["ev_lineage"],
    discovery_semantics_hash: `sha256:${"a".repeat(64)}`,
    decision_history: [{
      decided_at: "2099-01-01T00:00:00.000Z",
      decision: "activated",
      rationale: "reviewed before attribution correction",
    }],
  });
  writeJson(tacticCandidatePath, {
    ...loadExample("live_tactic_candidate"),
    candidate_id: "ltc_lineage",
    status: "activated",
    workspace_id: "ecitr_model",
    source_case_refs: ["case_lineage"],
    supporting_invariant_refs: ["inv_lineage"],
    evidence_refs: ["ev_lineage"],
    discovery_semantics_hash: `sha256:${"b".repeat(64)}`,
    entry: {
      ...loadExample("live_tactic_candidate").entry,
      environment_bounds: ["workspace:ecitr_model"],
      parameter_observation_refs: ["paramobs_lineage"],
    },
    decision_history: [{
      decided_at: "2099-01-01T00:00:00.000Z",
      decision: "activated",
      rationale: "reviewed before attribution correction",
    }],
  });
  const originalInvariantCandidateBytes = fs.readFileSync(invariantCandidatePath, "utf8");

  const summary = migrateWorkspaceIdentityBySource({
    catalogRoot: fixture.rootDir,
    targetWorkspaceId: "ms_business_central",
    agentOpsProjectIds: ["ms_business_central"],
    dryRun: false,
    includeStaging: true,
    plannedAt: "2099-01-02T00:00:00.000Z",
  });
  const packet = JSON.parse(fs.readFileSync(packetPath, "utf8"));

  assert.equal(summary.staging_packets_updated, 4);
  assert.equal(packet.workspace_id, "ms_business_central");
  assert.deepEqual(packet.environment_bounds, ["workspace:ms_business_central"]);
  assert.notDeepEqual(packet.parameter_observation_refs, ["paramobs_lineage"]);
  assert.equal(JSON.parse(fs.readFileSync(seedPath, "utf8")).workspace_id, "ms_business_central");
  const originalInvariantCandidate = JSON.parse(fs.readFileSync(invariantCandidatePath, "utf8"));
  assert.equal(fs.readFileSync(invariantCandidatePath, "utf8"), originalInvariantCandidateBytes);
  assert.equal(originalInvariantCandidate.workspace_id, "ecitr_model");
  assert.equal(originalInvariantCandidate.status, "activated");
  assert.deepEqual(originalInvariantCandidate.decision_history.map((entry) => entry.decision), ["activated"]);
  const invariantCandidates = fs.readdirSync(invariantCandidateDir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => JSON.parse(fs.readFileSync(path.join(invariantCandidateDir, entry), "utf8")));
  const invariantRevision = invariantCandidates.find((candidate) =>
    candidate.candidate_id !== originalInvariantCandidate.candidate_id);
  assert.equal(invariantRevision.workspace_id, "ms_business_central");
  assert.equal(invariantRevision.status, "staged");
  assert.equal(invariantRevision.discovery_semantics_hash, undefined);
  assert.equal(invariantRevision.candidate_series_id, originalInvariantCandidate.candidate_id);
  assert.equal(invariantRevision.supersedes_candidate_id, originalInvariantCandidate.candidate_id);
  assert.deepEqual(invariantRevision.decision_history, []);

  const originalTacticCandidate = JSON.parse(fs.readFileSync(tacticCandidatePath, "utf8"));
  assert.equal(originalTacticCandidate.workspace_id, "ecitr_model");
  assert.equal(originalTacticCandidate.status, "activated");
  const tacticCandidates = fs.readdirSync(tacticCandidateDir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => JSON.parse(fs.readFileSync(path.join(tacticCandidateDir, entry), "utf8")));
  const tacticRevision = tacticCandidates.find((candidate) =>
    candidate.candidate_id !== originalTacticCandidate.candidate_id);
  assert.equal(tacticRevision.workspace_id, "ms_business_central");
  assert.equal(tacticRevision.status, "staged");
  assert.equal(tacticRevision.discovery_semantics_hash, undefined);
  assert.equal(tacticRevision.candidate_series_id, originalTacticCandidate.candidate_id);
  assert.equal(tacticRevision.supersedes_candidate_id, originalTacticCandidate.candidate_id);
  assert.deepEqual(tacticRevision.decision_history, []);
  assert.deepEqual(tacticRevision.entry.environment_bounds, ["workspace:ms_business_central"]);
  assert.notDeepEqual(tacticRevision.entry.parameter_observation_refs, ["paramobs_lineage"]);

  const candidateFileCount = fs.readdirSync(invariantCandidateDir).length
    + fs.readdirSync(tacticCandidateDir).length;
  const repeated = migrateWorkspaceIdentityBySource({
    catalogRoot: fixture.rootDir,
    targetWorkspaceId: "ms_business_central",
    agentOpsProjectIds: ["ms_business_central"],
    dryRun: false,
    includeStaging: true,
    plannedAt: "2099-01-03T00:00:00.000Z",
  });
  assert.equal(repeated.staging_packets_updated, 0);
  assert.equal(
    fs.readdirSync(invariantCandidateDir).length + fs.readdirSync(tacticCandidateDir).length,
    candidateFileCount,
  );
});

test("workspace migration preflight rejects a conflicting live-candidate successor before writes", () => {
  const fixture = createMigrationFixture();
  const candidateDir = path.join(fixture.rootDir, "staging", "live-invariant-candidates");
  fs.mkdirSync(candidateDir, { recursive: true });
  const candidatePath = path.join(candidateDir, "lic_conflict.json");
  writeJson(candidatePath, {
    ...loadExample("live_invariant_candidate"),
    candidate_id: "lic_conflict",
    status: "activated",
    workspace_id: "ecitr_model",
    source_case_refs: ["case_lineage", "case_lineage"],
    evidence_refs: ["ev_lineage"],
  });
  const originalBytes = fs.readFileSync(candidatePath, "utf8");
  const plan = planWorkspaceIdentityBySource({
    catalogRoot: fixture.rootDir,
    targetWorkspaceId: "ms_business_central",
    agentOpsProjectIds: ["ms_business_central"],
    includeStaging: true,
    plannedAt: "2099-01-02T00:00:00.000Z",
  });
  const candidateOperation = plan.manifest.operations.find((operation) =>
    operation.record_type === "live_invariant_candidate");
  writeJson(candidateOperation.file_path, {
    ...candidateOperation.after_record,
    last_seen_at: "2099-01-02T01:00:00.000Z",
  });

  assert.throws(() => applyWorkspaceIdentityMigration({
    catalogRoot: fixture.rootDir,
    manifest: plan.manifest,
    appliedAt: "2099-01-02T02:00:00.000Z",
  }), /target conflict for staging artifact/);
  assert.equal(fs.readFileSync(candidatePath, "utf8"), originalBytes);
  assert.equal(
    fixture.catalog.getRecord("evidence", "ev_lineage_workspace_ms_business_central"),
    null,
  );
});

test("workspace migration journals failure instead of overwriting a drifted plan basis", () => {
  const fixture = createMigrationFixture();
  const plan = planWorkspaceIdentityBySource({
    catalogRoot: fixture.rootDir,
    targetWorkspaceId: "ms_business_central",
    agentOpsProjectIds: ["ms_business_central"],
    includeStaging: false,
    plannedAt: "2099-01-02T00:00:00.000Z",
  });
  const driftedCase = {
    ...fixture.catalog.getRecord("case", "case_lineage"),
    confidence: 0.61,
  };
  fixture.catalog.writeRecord("case", driftedCase, { overwrite: true });

  assert.throws(() => applyWorkspaceIdentityMigration({
    catalogRoot: fixture.rootDir,
    manifest: plan.manifest,
    appliedAt: "2099-01-02T00:01:00.000Z",
  }), /basis drift/);
  const manifestPath = path.join(
    fixture.rootDir,
    "state",
    "workspace-attribution-migrations",
    `${plan.manifest.migration_id}.json`,
  );
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.status, "failed");
  assert.match(manifest.failure, /basis drift/);
  assert.equal(
    fixture.catalog.getRecord("evidence", "ev_lineage_workspace_ms_business_central"),
    null,
  );
  assert.equal(fixture.catalog.getRecord("case", "case_lineage").workspace_id, "ecitr_model");
});

test("workspace migration derives target parameter definition provenance from target observations", () => {
  const fixture = createMigrationFixture({ includeOtherEvidence: true });
  fixture.catalog.writeRecord("parameter_definition", {
    ...fixture.catalog.getRecord("parameter_definition", "paramdef_lineage"),
    first_source_evidence_ref: "ev_other_lineage",
  }, { overwrite: true });

  const plan = planWorkspaceIdentityBySource({
    catalogRoot: fixture.rootDir,
    targetWorkspaceId: "ms_business_central",
    agentOpsProjectIds: ["ms_business_central"],
    includeStaging: false,
    plannedAt: "2099-01-02T00:00:00.000Z",
  });
  const definitionOperation = plan.manifest.operations.find((operation) =>
    operation.record_type === "parameter_definition");

  assert.equal(
    definitionOperation.after_record.first_source_evidence_ref,
    "ev_lineage_workspace_ms_business_central",
  );
  assert.equal(definitionOperation.after_record.first_observed_at, fixture.observation.observed_at);
});

test("workspace migration does not link cases to conflicting target parameter observations", () => {
  const fixture = createMigrationFixture();
  const targetWorkspaceId = "ms_business_central";
  const targetEvidence = makeEvidence({
    evidenceId: "ev_existing_target",
    payloadRef: "payloads/evidence/tests/ev_lineage.json",
  });
  fixture.catalog.writeRecord("evidence", {
    ...targetEvidence,
    workspace_id: targetWorkspaceId,
  });
  const definitionId = createDefinitionId({
    workspaceId: targetWorkspaceId,
    observedKey: "SERVICE_TIMEOUT",
  });
  fixture.catalog.writeRecord("parameter_definition", {
    ...fixture.definition,
    definition_id: definitionId,
    workspace_id: targetWorkspaceId,
    first_source_evidence_ref: "ev_existing_target",
  });
  const correctedEvidenceId = "ev_lineage_workspace_ms_business_central";
  const observationId = createObservationId({
    workspaceId: targetWorkspaceId,
    parameterKey: fixture.observation.parameter_key,
    observationKind: fixture.observation.observation_kind,
    observedAt: fixture.observation.observed_at,
    sourceEvidenceRefs: [correctedEvidenceId],
    sourceSpans: fixture.observation.source_spans,
    rawValueText: fixture.observation.raw_value_text,
  });
  fixture.catalog.writeRecord("parameter_observation", {
    ...fixture.observation,
    observation_id: observationId,
    definition_id: definitionId,
    workspace_id: targetWorkspaceId,
    source_evidence_refs: [correctedEvidenceId],
    confidence: 0.1,
  });

  const summary = migrateWorkspaceIdentityBySource({
    catalogRoot: fixture.rootDir,
    targetWorkspaceId,
    agentOpsProjectIds: [targetWorkspaceId],
    dryRun: true,
    includeStaging: false,
    plannedAt: "2099-01-02T00:00:00.000Z",
  });

  assert.equal(summary.updated_record_counts.parameter_observations, 0);
  assert.equal(summary.updated_record_counts.cases, 0);
  assert.ok(summary.blockers.some((blocker) =>
    blocker.record_type === "parameter_observation" && blocker.code === "target_id_conflict"));
  assert.ok(summary.blockers.some((blocker) =>
    blocker.record_type === "case" && blocker.code === "mixed_or_unresolved_parameter_lineage"));
});

function createMigrationFixture({ includeOtherEvidence = false } = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-attribution-lineage-"));
  const catalog = new FileBackedCatalog({ rootDir });
  const payloadDir = path.join(rootDir, "payloads", "evidence", "tests");
  fs.mkdirSync(payloadDir, { recursive: true });
  writeJson(path.join(payloadDir, "ev_lineage.json"), {
    project_id: "ms_business_central",
  });
  writeJson(path.join(payloadDir, "ev_other_lineage.json"), {
    project_id: "other_project",
  });

  catalog.writeRecord("evidence", makeEvidence({
    evidenceId: "ev_lineage",
    payloadRef: "payloads/evidence/tests/ev_lineage.json",
  }));
  if (includeOtherEvidence) {
    catalog.writeRecord("evidence", makeEvidence({
      evidenceId: "ev_other_lineage",
      payloadRef: "payloads/evidence/tests/ev_other_lineage.json",
    }));
  }

  const definition = {
    ...loadExample("parameter_definition"),
    definition_id: "paramdef_lineage",
    observed_key: "SERVICE_TIMEOUT",
    normalized_key: "service_timeout",
    value_type: "number",
    first_source_evidence_ref: "ev_lineage",
  };
  const observation = {
    ...loadExample("parameter_observation"),
    observation_id: "paramobs_lineage",
    definition_id: definition.definition_id,
    parameter_key: "SERVICE_TIMEOUT",
    raw_value_text: "30",
    value_type: "number",
    value_json: 30,
    observed_at: "2099-01-01T00:00:00.000Z",
    source_evidence_refs: ["ev_lineage"],
  };
  catalog.writeRecord("parameter_definition", definition);
  catalog.writeRecord("parameter_observation", observation);

  const caseRecord = {
    ...loadExample("case"),
    case_id: "case_lineage",
    workspace_id: "ecitr_model",
    evidence_refs: includeOtherEvidence
      ? ["ev_lineage", "ev_other_lineage"]
      : ["ev_lineage"],
    parameter_observation_refs: [observation.observation_id],
  };
  catalog.writeRecord("case", caseRecord);
  catalog.writeRecord("invariant", {
    ...loadExample("invariant"),
    id: "inv_lineage",
    workspace_id: "ecitr_model",
    source_case_refs: [caseRecord.case_id],
    evidence_refs: caseRecord.evidence_refs,
  });
  catalog.writeRecord("tactic", {
    ...loadExample("tactic"),
    id: "tac_lineage",
    workspace_id: "ecitr_model",
    source_case_refs: [caseRecord.case_id],
    supporting_invariant_refs: ["inv_lineage"],
    evidence_refs: caseRecord.evidence_refs,
    parameter_observation_refs: [observation.observation_id],
    environment_bounds: ["workspace:ecitr_model"],
  });

  return { catalog, definition, observation, rootDir };
}

function makeEvidence({ evidenceId, payloadRef }) {
  return {
    evidence_id: evidenceId,
    workspace_id: "ecitr_model",
    substrate_ref: `file:///tmp/${evidenceId}.json`,
    source_type: "file",
    source_locator: `/tmp/${evidenceId}.json`,
    captured_at: "2099-01-01T00:00:00.000Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: payloadRef,
    payload_hash: "sha256:test",
    source_hash: "sha256:test",
    redaction_state: "none",
    immutable: true,
  };
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
