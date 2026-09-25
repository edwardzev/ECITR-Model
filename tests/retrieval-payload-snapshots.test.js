const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildEvidenceRetrievalText } = require("../src/retrieval/evidence-text");
const { RetrievalRuntime } = require("../src/retrieval/runtime");
const { buildDefaultLanes } = require("../src/retrieval/lanes");
const { HeuristicSemanticBackend } = require("../src/retrieval/semantic-backends/heuristic-backend");
const { createProjectMemoryRetrievalRuntime } = require("../src/runtime/project-memory");
const { LanceDbSemanticBackend, writeLanceDbCatalogBasis, isLanceDbCatalogBasisCurrent,
  buildLanceDbCatalogBasis } = require("../src/retrieval/semantic-backends/lancedb-backend");
const { loadExample } = require("./helpers/load-example");

const NOW = new Date("2026-09-25T12:00:00Z");
const EMBEDDER = {
  denseVectorSize: 2, embeddingSignature: "fixture:2",
  async embedDocuments({ documents }) { return documents.map(() => ({ dense: [0.1, 0.2], sparse: { indices: [0], values: [1] } })); },
  async embedQuery() { return { dense: [0.1, 0.2], sparse: { indices: [0], values: [1] } }; },
};

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-payload-snapshot-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const payload = path.join(root, "payload.json");
  const record = { ...loadExample("evidence"), source_locator: "fixture://opaque", verbatim_payload_ref: payload };
  const catalogs = { evidence: [record], tactics: [], invariants: [], cases: [], atomic_claim_sets: [],
    parameter_definitions: [], parameter_observations: [] };
  Object.defineProperty(catalogs, "__catalogRoot", { value: root });
  const write = (text) => fs.writeFileSync(payload, JSON.stringify({ value: text }));
  write("alphasnapshot");
  return { root, payload, record, catalogs, write };
}

function request(query = "alphasnapshot", id = "req_snapshot") {
  return { request_id: id, query, workspace_id: "ecitr_model", project_scope: "global", intent: "action", allowed_layers: ["evidence"] };
}

test("standalone evidence text and reused heuristic backend observe later edit/removal/creation", async (t) => {
  const f = fixture(t);
  assert.match(buildEvidenceRetrievalText(f.record), /alphasnapshot/);
  f.write("betasnapshot");
  assert.doesNotMatch(buildEvidenceRetrievalText(f.record), /alphasnapshot/);
  const backend = new HeuristicSemanticBackend({ catalogs: f.catalogs });
  const plan = { allowed_layers: ["evidence"] };
  assert.equal((await backend.retrieve({ request: request("betasnapshot"), plan })).length, 1);
  fs.unlinkSync(f.payload);
  assert.equal((await backend.retrieve({ request: request("betasnapshot"), plan })).length, 0);
  f.write("gammasnapshot");
  assert.equal((await backend.retrieve({ request: request("gammasnapshot"), plan })).length, 1);
});

test("payload traversal failures remain errors rather than silent empty retrieval text", (t) => {
  const f = fixture(t);
  t.mock.method(JSON, "parse", () => ({ get value() { throw new Error("payload traversal failed"); } }));
  assert.throws(() => buildEvidenceRetrievalText(f.record), /payload traversal failed/);
});

test("one runtime execution shares a stable payload snapshot across lanes but the next execution reloads", async (t) => {
  const f = fixture(t);
  let reads = 0;
  const originalRead = fs.readFileSync;
  t.mock.method(fs, "readFileSync", function (file, ...args) {
    if (file === f.payload) reads += 1;
    return originalRead.call(this, file, ...args);
  });
  const runtime = new RetrievalRuntime({ responseEnricher: null, lanesFactory(args) {
    const lanes = buildDefaultLanes(args);
    const execute = lanes[0].execute.bind(lanes[0]);
    lanes[0].execute = (input) => { const result = execute(input); f.write("betasnapshot"); return result; };
    return lanes;
  } });
  const first = await runtime.execute({ catalogs: f.catalogs, request: request(), now: NOW });
  assert.deepEqual(first.response.results.evidence, [f.record.evidence_id]);
  assert.equal(reads, 1);
  const second = await runtime.execute({ catalogs: f.catalogs, request: request("betasnapshot"), now: NOW });
  assert.deepEqual(second.response.results.evidence, [f.record.evidence_id]);
  assert.equal(reads, 2);
});

test("concurrent executions receive distinct snapshots even when they share the same catalog object", async (t) => {
  const f = fixture(t);
  const maps = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let firstReady;
  const firstPrepared = new Promise((resolve) => { firstReady = resolve; });
  const observations = {};
  const runtime = new RetrievalRuntime({ responseEnricher: null, lanesFactory({ payloadSnapshots }) {
    maps.push(payloadSnapshots);
    return [{ async execute({ request: req, payloadSnapshots: received }) {
      assert.equal(received, payloadSnapshots);
      observations[`${req.request_id}_first`] = buildEvidenceRetrievalText(f.record, { payloadSnapshots });
      if (req.request_id === "req_first") { firstReady(); await firstGate; }
      observations[`${req.request_id}_last`] = buildEvidenceRetrievalText(f.record, { payloadSnapshots });
      return [];
    } }];
  } });
  const first = runtime.execute({ catalogs: f.catalogs, request: request("alphasnapshot", "req_first"), now: NOW });
  await firstPrepared;
  f.write("betasnapshot");
  await runtime.execute({ catalogs: f.catalogs, request: request("betasnapshot", "req_second"), now: NOW });
  releaseFirst();
  await first;
  assert.notEqual(maps[0], maps[1]);
  assert.match(observations.req_first_last, /alphasnapshot/);
  assert.doesNotMatch(observations.req_first_last, /betasnapshot/);
  assert.match(observations.req_second_last, /betasnapshot/);
});

test("actual project-memory indexed factory shares snapshots and later payload edits invalidate its basis", async (t) => {
  const f = fixture(t);
  const uri = path.join(f.root, "index");
  const tableName = "fixture_records";
  fs.mkdirSync(path.join(uri, `${tableName}.lance`), { recursive: true });
  // Keep correction parents for basis validation; only the leaf may enter lanes.
  const leaf = { ...f.record, evidence_id: "ev_snapshot_corrected", correction_of: f.record.evidence_id };
  f.catalogs.evidence.push(leaf);
  writeLanceDbCatalogBasis({ uri, tableName, catalogs: f.catalogs, embeddingSignature: EMBEDDER.embeddingSignature });
  let indexedCalls = 0;
  let reads = 0;
  const originalRead = fs.readFileSync;
  t.mock.method(fs, "readFileSync", function (file, ...args) {
    if (file === f.payload) reads += 1;
    return originalRead.call(this, file, ...args);
  });
  const runtime = createProjectMemoryRetrievalRuntime({ lancedbUri: uri, lancedbTableName: tableName,
    buildEmbedder: () => EMBEDDER, responseEnricher: null,
    buildLanceDbBackend(options) {
      indexedCalls += 1;
      return new LanceDbSemanticBackend({ ...options, connectImpl: async () => ({ async openTable() {
        const query = { where() { return this; }, limit() { return this; }, select() { return this; },
          distanceType() { return this; }, async toArray() { return []; } };
        return { vectorSearch() { return query; } };
      } }) });
    },
  });
  const first = await runtime.execute({ catalogs: f.catalogs, request: request(), now: NOW });
  assert.equal(indexedCalls, 1);
  assert.equal(reads, 1, "factory basis, lane text and backend basis use one payload snapshot");
  assert.deepEqual(first.response.results.evidence, [leaf.evidence_id]);
  f.write("betasnapshot");
  const second = await runtime.execute({ catalogs: f.catalogs, request: request("betasnapshot"), now: NOW });
  assert.equal(indexedCalls, 1, "stale index falls back rather than being silently reused");
  assert.equal(reads, 2);
  assert.deepEqual(second.response.results.evidence, [leaf.evidence_id]);
});

test("async index sync publishes a basis for its written-row snapshot and a later check detects intervening edits", async (t) => {
  const f = fixture(t);
  const uri = path.join(f.root, "index");
  const tableName = "fixture_records";
  const expected = buildLanceDbCatalogBasis({ tableName, catalogs: f.catalogs, embeddingSignature: EMBEDDER.embeddingSignature });
  let writtenRows;
  const backend = new LanceDbSemanticBackend({ uri, tableName, catalogs: f.catalogs, embedder: EMBEDDER,
    createFtsIndex: false, connectImpl: async () => ({ async createTable(_table, rows) {
      writtenRows = rows;
      f.write("betasnapshot");
      await Promise.resolve();
      return {};
    } }) });
  const synced = await backend.syncCatalog();
  assert.match(writtenRows[0].text, /alphasnapshot/);
  assert.doesNotMatch(writtenRows[0].text, /betasnapshot/);
  assert.equal(synced.catalog_hash, expected.catalog_hash);
  assert.equal(isLanceDbCatalogBasisCurrent({ uri, tableName, catalogs: f.catalogs,
    embeddingSignature: EMBEDDER.embeddingSignature }), false);
  const rowsNext = await backend.buildRows();
  assert.match(rowsNext[0].text, /betasnapshot/, "the backend retains no previous sync snapshot");
});
