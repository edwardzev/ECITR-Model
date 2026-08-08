const crypto = require("node:crypto");
const {
  RETRIEVAL_TOKENIZER_ID,
  tokenizeRetrievalText,
} = require("../tokenizer");

class HashSemanticEmbedder {
  constructor({ denseVectorSize = 16, sparseBucketCount = 2048 } = {}) {
    if (!Number.isInteger(denseVectorSize) || denseVectorSize <= 0) {
      throw new Error("HashSemanticEmbedder requires a positive denseVectorSize.");
    }

    if (!Number.isInteger(sparseBucketCount) || sparseBucketCount <= 0) {
      throw new Error("HashSemanticEmbedder requires a positive sparseBucketCount.");
    }

    this.denseVectorSize = denseVectorSize;
    this.sparseBucketCount = sparseBucketCount;
    this.embeddingSignature = `hash:${RETRIEVAL_TOKENIZER_ID}:${denseVectorSize}:${sparseBucketCount}`;
  }

  async embedDocuments({ documents }) {
    return documents.map((document) => this.embedText(document));
  }

  async embedQuery({ query }) {
    return this.embedText(query);
  }

  embedText(value) {
    const tokens = tokenize(value);
    return {
      dense: buildDenseVector(tokens, this.denseVectorSize),
      sparse: buildSparseVector(tokens, this.sparseBucketCount),
    };
  }
}

function tokenize(value) {
  return tokenizeRetrievalText(value);
}

function buildDenseVector(tokens, denseVectorSize) {
  const vector = Array.from({ length: denseVectorSize }, () => 0);

  for (const token of tokens) {
    const digest = crypto.createHash("sha256").update(token).digest();
    for (let index = 0; index < denseVectorSize; index += 1) {
      const byte = digest[index % digest.length];
      const magnitude = (byte / 255) - 0.5;
      const sign = byte % 2 === 0 ? 1 : -1;
      vector[index] += magnitude * sign;
    }
  }

  return normalizeVector(vector);
}

function buildSparseVector(tokens, sparseBucketCount) {
  const frequencies = new Map();

  for (const token of tokens) {
    const digest = crypto.createHash("sha256").update(token).digest("hex");
    const bucket = parseInt(digest.slice(0, 8), 16) % sparseBucketCount;
    frequencies.set(bucket, (frequencies.get(bucket) ?? 0) + 1);
  }

  const sortedBuckets = [...frequencies.entries()].sort((left, right) => left[0] - right[0]);
  const maxFrequency = sortedBuckets.reduce((max, [, count]) => Math.max(max, count), 1);

  return {
    indices: sortedBuckets.map(([bucket]) => bucket),
    values: sortedBuckets.map(([, count]) => count / maxFrequency),
  };
}

function normalizeVector(vector) {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + (value ** 2), 0));
  if (magnitude === 0) {
    return vector;
  }

  return vector.map((value) => value / magnitude);
}

module.exports = {
  HashSemanticEmbedder,
  tokenize,
  buildDenseVector,
  buildSparseVector,
  normalizeVector,
};
