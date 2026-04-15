const test = require("node:test");
const assert = require("node:assert/strict");

const { OpenAIHybridSemanticEmbedder } = require("../src/retrieval/embedders/openai-hybrid-embedder");

test("openai hybrid embedder batches dense requests and returns sparse vectors", async () => {
  const calls = [];
  const embedder = new OpenAIHybridSemanticEmbedder({
    apiKey: "test-key",
    model: "text-embedding-3-small",
    denseVectorSize: 3,
    sparseBucketCount: 32,
    batchSize: 2,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, options, body });
      return {
        ok: true,
        json: async () => ({
          data: body.input.map((_, index) => ({
            embedding: [index + 0.1, index + 0.2, index + 0.3],
          })),
        }),
      };
    },
  });

  const documents = await embedder.embedDocuments({
    documents: [
      "scope filter ranking project retrieval",
      "payload store sidecar evidence",
      "managed qdrant lifecycle benchmark",
    ],
  });
  const query = await embedder.embedQuery({ query: "scope filtering" });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "https://api.openai.com/v1/embeddings");
  assert.equal(calls[0].body.model, "text-embedding-3-small");
  assert.equal(calls[0].body.dimensions, 3);
  assert.equal(calls[0].options.headers.authorization, "Bearer test-key");
  assert.deepEqual(calls[0].body.input, [
    "scope filter ranking project retrieval",
    "payload store sidecar evidence",
  ]);
  assert.deepEqual(calls[1].body.input, ["managed qdrant lifecycle benchmark"]);
  assert.deepEqual(documents[0].dense, [0.1, 0.2, 0.3]);
  assert.ok(documents[0].sparse.indices.length > 0);
  assert.equal(query.dense.length, 3);
  assert.ok(query.sparse.values.length > 0);
});
