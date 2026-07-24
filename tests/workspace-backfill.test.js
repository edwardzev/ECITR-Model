const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
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
  assert.equal(summary.parameter_definition_renames, 1);
  assert.equal(summary.parameter_observation_renames, 1);

  const nextCatalog = catalog.loadRuntimeCatalogs();
  assert.equal(nextCatalog.evidence[0].workspace_id, "workspace_alpha");
  assert.equal(nextCatalog.cases[0].workspace_id, "workspace_alpha");
  assert.equal(nextCatalog.tactics[0].workspace_id, "workspace_alpha");
  assert.equal(nextCatalog.parameter_definitions[0].workspace_id, "workspace_alpha");
  assert.equal(nextCatalog.parameter_observations[0].workspace_id, "workspace_alpha");
  assert.equal(nextCatalog.parameter_definitions[0].definition_id, "paramdef_5a502d3a55e2f60ba5f5");
  assert.equal(nextCatalog.parameter_observations[0].observation_id, "paramobs_265197eb534bb1c861da");
  assert.deepEqual(nextCatalog.cases[0].parameter_observation_refs, ["paramobs_265197eb534bb1c861da"]);
  assert.deepEqual(nextCatalog.tactics[0].parameter_observation_refs, ["paramobs_265197eb534bb1c861da"]);

  const packet = JSON.parse(fs.readFileSync(path.join(packetDir, "legacy.json"), "utf8"));
  assert.equal(packet.workspace_id, "workspace_alpha");
  assert.deepEqual(packet.parameter_observation_refs, ["paramobs_265197eb534bb1c861da"]);
});
