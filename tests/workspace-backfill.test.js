const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const { buildEvidenceCorrectionIndex } = require("../src/evidence/corrections");
const { createDefinitionId, createObservationId } = require("../src/parameters/common");
const { backfillWorkspaceIdentity } = require("../src/workspace/backfill");
const { loadExample } = require("./helpers/load-example");

test("workspace backfill stamps workspace ids and rewrites parameter ids plus packet refs", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-workspace-backfill-"));
  const catalog = new FileBackedCatalog({ rootDir });

  const evidence = loadExample("evidence");
  const parameterDefinition = {
    ...loadExample("parameter_definition"),
    definition_id: "paramdef_legacy_qdrant",
  };
  const parameterObservation = {
    ...loadExample("parameter_observation"),
    observation_id: "paramobs_legacy_qdrant",
    definition_id: "paramdef_legacy_qdrant",
  };
  const caseRecord = {
    ...loadExample("case"),
    workspace_id: undefined,
    parameter_observation_refs: ["paramobs_legacy_qdrant"],
  };
  const tacticRecord = {
    ...loadExample("tactic"),
    workspace_id: undefined,
    parameter_observation_refs: ["paramobs_legacy_qdrant"],
  };

  delete evidence.workspace_id;
  delete parameterDefinition.workspace_id;
  delete parameterObservation.workspace_id;
  delete caseRecord.workspace_id;
  delete tacticRecord.workspace_id;

  catalog.writeRecord("evidence", evidence);
  catalog.writeRecord("parameter_definition", parameterDefinition);
  catalog.writeRecord("parameter_observation", parameterObservation);
  catalog.writeRecord("case", caseRecord);
  catalog.writeRecord("invariant", loadExample("invariant"));
  catalog.writeRecord("tactic", tacticRecord);

  const packetDir = path.join(rootDir, "staging", "case-compilation-packets");
  fs.mkdirSync(packetDir, { recursive: true });
  const legacyPacket = {
    ...loadExample("case_compilation_packet"),
    parameter_observation_refs: ["paramobs_legacy_qdrant"],
  };
  delete legacyPacket.workspace_id;
  fs.writeFileSync(path.join(packetDir, "legacy.json"), `${JSON.stringify(legacyPacket, null, 2)}\n`);

  const summary = backfillWorkspaceIdentity({
    catalogRoot: rootDir,
    workspaceId: "workspace_alpha",
  });

  assert.equal(summary.workspace_id, "workspace_alpha");
  assert.equal(summary.evidence_corrections, 1);
  assert.equal(summary.parameter_definition_renames, 1);
  assert.equal(summary.parameter_observation_renames, 1);

  const nextCatalog = catalog.loadRuntimeCatalogs();
  assert.equal(nextCatalog.evidence.length, 2);
  assert.equal(nextCatalog.evidence.find((record) => record.evidence_id === evidence.evidence_id).workspace_id, undefined);
  const evidenceCorrection = nextCatalog.evidence.find((record) =>
    record.correction_of === evidence.evidence_id);
  assert.equal(evidenceCorrection.workspace_id, "workspace_alpha");
  assert.equal(nextCatalog.cases[0].workspace_id, "workspace_alpha");
  assert.equal(nextCatalog.tactics[0].workspace_id, "workspace_alpha");
  const expectedDefinitionId = createDefinitionId({
    workspaceId: "workspace_alpha",
    observedKey: parameterDefinition.observed_key,
  });
  const expectedObservationId = createObservationId({
    workspaceId: "workspace_alpha",
    parameterKey: parameterObservation.parameter_key,
    observationKind: parameterObservation.observation_kind,
    observedAt: parameterObservation.observed_at,
    sourceEvidenceRefs: [evidenceCorrection.evidence_id],
    sourceSpans: parameterObservation.source_spans,
    rawValueText: parameterObservation.raw_value_text,
  });
  const nextDefinition = nextCatalog.parameter_definitions.find((record) =>
    record.definition_id === expectedDefinitionId);
  const nextObservation = nextCatalog.parameter_observations.find((record) =>
    record.observation_id === expectedObservationId);
  assert.equal(nextDefinition.workspace_id, "workspace_alpha");
  assert.equal(nextObservation.workspace_id, "workspace_alpha");
  assert.deepEqual(nextObservation.source_evidence_refs, [evidenceCorrection.evidence_id]);
  assert.deepEqual(nextCatalog.cases[0].parameter_observation_refs, [expectedObservationId]);
  assert.deepEqual(nextCatalog.tactics[0].parameter_observation_refs, [expectedObservationId]);

  const packet = JSON.parse(fs.readFileSync(path.join(packetDir, "legacy.json"), "utf8"));
  assert.equal(packet.workspace_id, "workspace_alpha");
  assert.deepEqual(packet.parameter_observation_refs, [expectedObservationId]);

  const repeated = backfillWorkspaceIdentity({
    catalogRoot: rootDir,
    workspaceId: "workspace_alpha",
  });
  assert.equal(repeated.evidence_corrections, 0);
  assert.equal(repeated.parameter_definition_renames, 0);
  assert.equal(repeated.parameter_observation_renames, 0);

  const differentWorkspace = backfillWorkspaceIdentity({
    catalogRoot: rootDir,
    workspaceId: "workspace_beta",
  });
  assert.equal(differentWorkspace.evidence_corrections, 0);
  const finalEvidence = catalog.listRecords("evidence");
  assert.equal(finalEvidence.length, 2);
  assert.doesNotThrow(() => buildEvidenceCorrectionIndex(finalEvidence));
});
