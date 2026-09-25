const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const FIXED_NOW = "2026-09-25T12:00:00.000Z";
const FIXTURE_VERSION = "ecitr-retrieval-performance-v1";
const SCENARIOS = Object.freeze([
  { id: "analysis", query: "scope filter ranking project retrieval", intent: "analysis" },
  { id: "temporal", query: "current scope filter ranking project retrieval", intent: "action" },
  { id: "unicode", query: "שלום Müller синхронизация", intent: "analysis" },
  { id: "parameter", query: "ECITR_LANCEDB_URI", intent: "audit" },
  { id: "empty", query: "zephyrquartznotpresent", intent: "analysis" },
]);

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function createPerformanceFixture({ rootDir, evidenceCount = 1000 } = {}) {
  if (!Number.isSafeInteger(evidenceCount) || evidenceCount < 1 || evidenceCount > 20000) {
    throw new Error("evidenceCount must be between 1 and 20000.");
  }
  const root = path.resolve(rootDir);
  if (fs.existsSync(root)) throw new Error("Performance fixture root must not already exist.");
  const examples = path.resolve(__dirname, "../../fixtures/examples");
  const example = (name) => JSON.parse(fs.readFileSync(path.join(examples, name), "utf8"));
  const evidence = example("evidence.record.example.json");
  const canonicalEvidence = structuredClone(evidence);
  canonicalEvidence.source_locator = "fixture://performance/parameter-origin";
  canonicalEvidence.verbatim_payload_ref = "payloads/evidence/parameter-origin.json";
  writeJson(path.join(root, "payloads/evidence/parameter-origin.json"), { value: "scope filter ranking retrieval" });
  writeJson(path.join(root, "evidence", `${evidence.evidence_id}.json`), canonicalEvidence);
  for (let index = 0; index < evidenceCount; index += 1) {
    const id = `ev_perf_${String(index).padStart(6, "0")}`;
    const payloadRef = `payloads/evidence/${id}.json`;
    const payload = {};
    for (let field = 0; field < 48; field += 1) {
      payload[`field_${field}`] = `scope filter ranking project retrieval not arbitrary evidence token${field} שלום Müller синхронизация `
        + `parameter observation ${index % 17} `.repeat(6);
    }
    writeJson(path.join(root, payloadRef), payload);
    const record = { ...evidence, evidence_id: id, source_locator: `fixture://performance/${index}`,
      substrate_ref: `fixture://substrate/${index}`, verbatim_payload_ref: payloadRef,
      project_scope: index % 29 === 0 ? "blocked" : "project_family",
      workspace_id: index % 31 === 0 ? "other_workspace" : "ecitr_model" };
    writeJson(path.join(root, "evidence", `${id}.json`), record);
    if (index % 20 === 0) {
      writeJson(path.join(root, "evidence", `${id}_corrected.json`), {
        ...record, evidence_id: `${id}_corrected`, correction_of: id,
        captured_at: "2026-09-24T10:00:00.000Z",
      });
    }
  }
  for (const [directory, name, idKey] of [
    ["cases", "case.record.example.json", "case_id"],
    ["invariants", "invariant.record.example.json", "id"],
    ["tactics", "tactic.record.example.json", "id"],
    ["atomic-claim-sets", "atomic-claim-set.example.json", "claim_set_id"],
    ["parameter-definitions", "parameter-definition.record.example.json", "definition_id"],
    ["parameter-observations", "parameter-observation.record.example.json", "observation_id"],
  ]) {
    const record = example(name);
    if (directory === "tactics") {
      record.expiry_at = "2027-01-01T00:00:00Z";
      record.revalidate_at = "2027-01-01T00:00:00Z";
      writeJson(path.join(root, directory, "tac_perf_expired.json"), {
        ...record, id: "tac_perf_expired", expiry_at: "2025-01-01T00:00:00Z", revalidate_at: "2025-01-01T00:00:00Z",
      });
    }
    writeJson(path.join(root, directory, `${record[idKey]}.json`), record);
  }
  const files = listFileHashes(root);
  const manifest = { fixture_version: FIXTURE_VERSION, evidence_count_requested: evidenceCount,
    now: FIXED_NOW, scenarios: SCENARIOS, files, files_sha256: hash(JSON.stringify(files)) };
  writeJson(path.join(root, "fixture-manifest.json"), manifest);
  return manifest;
}

function listFileHashes(root, relative = "") {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const ref = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) return listFileHashes(root, ref);
      if (!entry.isFile() || ref === "fixture-manifest.json") return [];
      return [{ ref, sha256: hash(fs.readFileSync(path.join(root, ref))) }];
    });
}

async function runPerformanceBenchmark({ rootDir, runtimeRoot = path.resolve(__dirname, "../.."), iterations = 3 } = {}) {
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 20) throw new Error("Invalid iterations.");
  const root = path.resolve(rootDir);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "fixture-manifest.json"), "utf8"));
  const inputHash = hash(JSON.stringify(listFileHashes(root)));
  if (manifest.fixture_version !== FIXTURE_VERSION || inputHash !== manifest.files_sha256) throw new Error("Performance fixture changed.");
  const { FileBackedCatalog } = require(path.join(runtimeRoot, "src/storage/file-backed-catalog"));
  const { RetrievalRuntime } = require(path.join(runtimeRoot, "src/retrieval/runtime"));
  const { structuralHash } = require(path.join(runtimeRoot, "src/runtime/project-memory-reader"));
  const { buildDefaultLanes } = require(path.join(runtimeRoot, "src/retrieval/lanes"));
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (const scenario of manifest.scenarios) {
      const loadStarted = performance.now();
      const catalogs = new FileBackedCatalog({ rootDir: root }).loadRuntimeCatalogs();
      const catalogLoadMs = performance.now() - loadStarted;
      const fingerprintStarted = performance.now();
      const corpusSha256 = structuralHash(catalogs);
      const fingerprintMs = performance.now() - fingerprintStarted;
      const laneTimings = {};
      const runtime = new RetrievalRuntime({
        graphRoot: path.join(root, "absent-support-graph"),
        lanesFactory(args) {
          return buildDefaultLanes(args).map((lane) => {
            const execute = lane.execute.bind(lane);
            lane.execute = async (input) => {
              const before = performance.now();
              try { return await execute(input); }
              finally { laneTimings[lane.laneId] = performance.now() - before; }
            };
            return lane;
          });
        },
      });
      const started = performance.now();
      const result = await runtime.execute({ catalogs, now: new Date(manifest.now), request: {
        request_id: `req_perf_${scenario.id}`, query: scenario.query, intent: scenario.intent,
        workspace_id: "ecitr_model", project_scope: "project_family",
      } });
      samples.push({ iteration, scenario_id: scenario.id, process_first_query: samples.length === 0,
        catalog_load_ms: catalogLoadMs, corpus_fingerprint_ms: fingerprintMs, retrieval_ms: performance.now() - started,
        lane_elapsed_ms: laneTimings, corpus_sha256: corpusSha256, result_sha256: hash(JSON.stringify(result)), result });
    }
  }
  if (inputHash !== hash(JSON.stringify(listFileHashes(root)))) throw new Error("Performance fixture changed during run.");
  return { fixture_version: FIXTURE_VERSION, fixture_sha256: inputHash, runtime_root: path.resolve(runtimeRoot),
    now: manifest.now, iterations, samples,
    limitations: ["Synthetic controlled input; not observed ordinary-task performance.",
      "Elapsed lane measurements overlap and must not be summed.",
      "Process first query does not imply cold operating-system filesystem caches.",
      "Heuristic semantic backend and absent support graph; no live derived index is used."] };
}

module.exports = { createPerformanceFixture, runPerformanceBenchmark };
