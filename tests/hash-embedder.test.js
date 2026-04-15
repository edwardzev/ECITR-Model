const test = require("node:test");
const assert = require("node:assert/strict");

const { HashSemanticEmbedder } = require("../src/retrieval/embedders/hash-embedder");

test("hash semantic embedder returns stable dense and sparse embeddings", async () => {
  const embedder = new HashSemanticEmbedder({ denseVectorSize: 8, sparseBucketCount: 64 });
  const first = await embedder.embedQuery({ query: "scope filtering before ranking" });
  const second = await embedder.embedQuery({ query: "scope filtering before ranking" });

  assert.deepEqual(first, second);
  assert.equal(first.dense.length, 8);
  assert.ok(first.sparse.indices.length > 0);
});
