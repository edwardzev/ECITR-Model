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
  assert.deepEqual(tokenizeRetrievalText("ECITR_LANCEDB_URI"), ["ecitr_lancedb_uri"]);
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
      tool_binding: ["ECITR_LANCEDB_URI"],
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
    metadata: "ECITR_LANCEDB_URI",
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

// Literal pre-optimization algorithm: retain an independent oracle for the fast path.
function priorNormalization(value) {
  const decomposed = String(value ?? "").normalize("NFKD").toLowerCase();
  let normalized = "";
  let previousBaseWasLatin = false;
  for (const character of decomposed) {
    if (/\p{M}/u.test(character)) {
      if (!previousBaseWasLatin) normalized += character;
      continue;
    }
    normalized += character;
    previousBaseWasLatin = /\p{Script=Latin}/u.test(character);
  }
  return normalized.normalize("NFC");
}

test("ASCII fast path matches the previous algorithm for every code point including surrogate values", () => {
  for (let code = 0; code <= 0x10ffff; code += 1) {
    const value = String.fromCodePoint(code);
    const expected = priorNormalization(value);
    const actual = normalizeRetrievalText(value);
    if (actual !== expected) assert.equal(actual, expected, `code point ${code}`);
  }
  assert.equal(RETRIEVAL_TOKENIZER_ID, "unicode-v2");
});

test("ASCII fast path preserves combining state, malformed UTF-16 and token options on deterministic mixed strings", () => {
  const words = new Set(["a", "an", "and", "for", "from", "how", "of", "or", "should", "the", "to"]);
  const values = [null, undefined, 0, true, "no not ECITR_LANCEDB_URI", "e\u0301\u0323 !\u0301\u0323",
    "\u0000\u0301\n\u0301\u007f\u0301", "Àİſ\u0301 Æ\u0301", "שָׁלוֹם ذاكرة Йिe\u0301",
    "💠\u0301 𐐀e\u0301", "\ud800a\udfff\u0301", "a\u0301\u0301_\u0301-\u0301"];
  for (let code = 0; code < 128; code += 1) values.push(`e\u0301${String.fromCharCode(code)}\u0301\u0323ש\u0301`);
  let seed = 0x51e1c7;
  const alphabet = ["a", "Z", "_", "-", " ", "\u0301", "\u0323", "\u034f", "\u0000", "\u007f", "\ud800", "\udfff", "İ", "é", "ſ", "א", "ي", "Й", "💠", "𐐀", "ﬁ", "项"];
  for (let index = 0; index < 2048; index += 1) {
    let value = "";
    for (let position = 0; position < 32; position += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      value += alphabet[seed % alphabet.length];
    }
    values.push(value);
  }
  for (const value of values) {
    const expected = priorNormalization(value);
    assert.equal(normalizeRetrievalText(value), expected);
    const tokens = expected.match(/[\p{L}\p{N}\p{M}_]+/gu) ?? [];
    assert.deepEqual(tokenizeRetrievalText(value, { removeStopWords: false }), tokens);
    assert.deepEqual(tokenizeRetrievalText(value), tokens.filter((token) => !words.has(token)));
  }
});
