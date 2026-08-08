const test = require("node:test");
const assert = require("node:assert/strict");

const { HashSemanticEmbedder } = require("../src/retrieval/embedders/hash-embedder");
const { OpenAIHybridSemanticEmbedder } = require("../src/retrieval/embedders/openai-hybrid-embedder");
const { buildDefaultLanes } = require("../src/retrieval/lanes");
const {
  RETRIEVAL_TOKENIZER_ID,
  normalizeRetrievalText,
  tokenizeRetrievalText,
} = require("../src/retrieval/tokenizer");

test("shared retrieval tokenizer is Unicode-aware and preserves exact underscore identifiers", () => {
  assert.deepEqual(tokenizeRetrievalText("memory-validation/strict:no-write?"), [
    "memory",
    "validation",
    "strict",
    "no",
    "write",
  ]);
  assert.deepEqual(tokenizeRetrievalText("ECITR_QDRANT_URL"), ["ecitr_qdrant_url"]);
  assert.deepEqual(tokenizeRetrievalText("Müller Muller"), ["muller", "muller"]);
  assert.deepEqual(tokenizeRetrievalText("בדיקת זיכרון ذاكرة المشروع память проекта 项目记忆"), [
    "בדיקת",
    "זיכרון",
    "ذاكرة",
    "المشروع",
    "память",
    "проекта",
    "项目记忆",
  ]);
});

test("Latin diacritics fold without deleting non-Latin combining marks", () => {
  assert.equal(normalizeRetrievalText("Café Müller"), "cafe muller");
  assert.deepEqual(tokenizeRetrievalText("שָׁלוֹם"), ["שָׁלוֹם"]);
});

test("conservative stop words are removed without erasing negation", () => {
  assert.deepEqual(tokenizeRetrievalText("how should the service not be unavailable"), [
    "service",
    "not",
    "be",
    "unavailable",
  ]);
});

test("lexical, metadata, semantic, and temporal lanes share Unicode token behavior", async () => {
  const catalogs = {
    tactics: [{
      id: "tac_unicode_alignment_001",
      status: "active",
      title: "Müller ذاكرة память 项目记忆",
      summary: "בדיקת זיכרון",
      action: "Preserve multilingual retrieval truth.",
      steps: [],
      tool_binding: ["ECITR_QDRANT_URL"],
      environment_bounds: [],
      updated_at: "2026-08-08T00:00:00Z",
    }],
    invariants: [],
    cases: [],
    evidence: [],
    atomic_claim_sets: [],
    parameter_definitions: [],
    parameter_observations: [],
  };
  const lanes = buildDefaultLanes({ catalogs });
  const plan = {
    allowed_layers: ["tactics"],
    max_results_per_layer: { tactics: 1 },
    freshness_mode: "strict",
  };
  const now = new Date("2026-08-08T00:00:00Z");
  const queries = {
    lexical: "Muller",
    metadata: "ECITR_QDRANT_URL",
    semantic: "ذاكرة",
    temporal: "latest память",
  };

  for (const lane of lanes) {
    const candidates = await lane.execute({
      request: {
        query: queries[lane.laneId],
        intent: "analysis",
      },
      plan,
      now,
    });
    assert.equal(candidates[0]?.recordId, "tac_unicode_alignment_001", lane.laneId);
  }
});

test("hash and hybrid sparse embeddings declare the Unicode tokenizer version", async () => {
  const hashEmbedder = new HashSemanticEmbedder({ denseVectorSize: 8, sparseBucketCount: 64 });
  const accented = await hashEmbedder.embedQuery({ query: "Müller בדיקת" });
  const folded = await hashEmbedder.embedQuery({ query: "Muller בדיקת" });
  assert.deepEqual(accented, folded);
  assert.equal(hashEmbedder.embeddingSignature, `hash:${RETRIEVAL_TOKENIZER_ID}:8:64`);

  const hybridEmbedder = new OpenAIHybridSemanticEmbedder({
    apiKey: "test-key",
    denseVectorSize: 2,
    sparseBucketCount: 64,
    fetchImpl: async (_url, options) => ({
      ok: true,
      json: async () => ({
        data: JSON.parse(options.body).input.map(() => ({ embedding: [0.1, 0.2] })),
      }),
    }),
  });
  assert.match(hybridEmbedder.embeddingSignature, new RegExp(`sparse-${RETRIEVAL_TOKENIZER_ID}`));
});
