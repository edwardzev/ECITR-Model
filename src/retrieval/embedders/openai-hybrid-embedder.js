const { tokenize, buildSparseVector } = require("./hash-embedder");
const { RETRIEVAL_TOKENIZER_ID } = require("../tokenizer");

const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_BATCH_SIZE = 128;
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

const MODEL_DEFAULT_DIMENSIONS = Object.freeze({
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
});

class OpenAIHybridSemanticEmbedder {
  constructor({
    apiKey,
    model = DEFAULT_MODEL,
    denseVectorSize,
    sparseBucketCount = 2048,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    batchSize = DEFAULT_BATCH_SIZE,
    organization = null,
    project = null,
  } = {}) {
    if (!apiKey || typeof apiKey !== "string") {
      throw new Error("OpenAIHybridSemanticEmbedder requires an apiKey.");
    }

    if (typeof fetchImpl !== "function") {
      throw new Error("OpenAIHybridSemanticEmbedder requires a fetch-compatible implementation.");
    }

    if (!Number.isInteger(sparseBucketCount) || sparseBucketCount <= 0) {
      throw new Error("OpenAIHybridSemanticEmbedder requires a positive sparseBucketCount.");
    }

    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      throw new Error("OpenAIHybridSemanticEmbedder requires a positive batchSize.");
    }

    const resolvedDenseVectorSize =
      denseVectorSize ??
      MODEL_DEFAULT_DIMENSIONS[model];

    if (!Number.isInteger(resolvedDenseVectorSize) || resolvedDenseVectorSize <= 0) {
      throw new Error(`OpenAIHybridSemanticEmbedder requires a positive denseVectorSize for model ${model}.`);
    }

    this.apiKey = apiKey;
    this.model = model;
    this.denseVectorSize = resolvedDenseVectorSize;
    this.sparseBucketCount = sparseBucketCount;
    this.baseUrl = stripTrailingSlash(baseUrl);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.batchSize = batchSize;
    this.organization = organization;
    this.project = project;
    this.embeddingSignature = `openai:${model}:${resolvedDenseVectorSize}:sparse-${RETRIEVAL_TOKENIZER_ID}:${sparseBucketCount}`;
  }

  async embedDocuments({ documents }) {
    if (!Array.isArray(documents)) {
      throw new Error("OpenAIHybridSemanticEmbedder.embedDocuments requires a documents array.");
    }

    const denseEmbeddings = [];
    for (let index = 0; index < documents.length; index += this.batchSize) {
      const batch = documents.slice(index, index + this.batchSize);
      const denseBatch = await this.embedDenseInputs(batch);
      denseEmbeddings.push(...denseBatch);
    }

    return documents.map((document, index) =>
      this.combineDenseAndSparse({
        text: document,
        dense: denseEmbeddings[index],
      }),
    );
  }

  async embedQuery({ query }) {
    const [dense] = await this.embedDenseInputs([query]);
    return this.combineDenseAndSparse({ text: query, dense });
  }

  combineDenseAndSparse({ text, dense }) {
    assertDenseEmbedding({
      embedding: dense,
      denseVectorSize: this.denseVectorSize,
      label: this.model,
    });

    return {
      dense,
      sparse: buildSparseVector(tokenize(text), this.sparseBucketCount),
    };
  }

  async embedDenseInputs(inputs) {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      return [];
    }

    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timeout = controller
      ? setTimeout(() => controller.abort(), this.timeoutMs)
      : null;

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify({
          model: this.model,
          input: inputs,
          encoding_format: "float",
          ...buildDimensionsPayload({
            model: this.model,
            denseVectorSize: this.denseVectorSize,
          }),
        }),
        signal: controller?.signal,
      });

      if (!response.ok) {
        const body = await safeReadText(response);
        throw new Error(`OpenAI embeddings request failed: ${response.status} ${body}`.trim());
      }

      const payload = await response.json();
      const data = Array.isArray(payload?.data) ? payload.data : null;
      if (!data || data.length !== inputs.length) {
        throw new Error("OpenAI embeddings response returned an unexpected number of vectors.");
      }

      return data.map((item) => item.embedding);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  buildHeaders() {
    const headers = {
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
    };

    if (this.organization) {
      headers["OpenAI-Organization"] = this.organization;
    }

    if (this.project) {
      headers["OpenAI-Project"] = this.project;
    }

    return headers;
  }
}

function buildDimensionsPayload({ model, denseVectorSize }) {
  const defaultDimensions = MODEL_DEFAULT_DIMENSIONS[model];
  if (!defaultDimensions || defaultDimensions === denseVectorSize) {
    return {};
  }

  return { dimensions: denseVectorSize };
}

function assertDenseEmbedding({ embedding, denseVectorSize, label }) {
  if (!Array.isArray(embedding)) {
    throw new Error(`Embedding response for ${label} did not return a dense vector array.`);
  }

  if (embedding.length !== denseVectorSize) {
    throw new Error(
      `Embedding response for ${label} returned ${embedding.length} dimensions; expected ${denseVectorSize}.`,
    );
  }
}

async function safeReadText(response) {
  if (!response || typeof response.text !== "function") {
    return "";
  }

  try {
    return await response.text();
  } catch {
    return "";
  }
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_BASE_URL,
  MODEL_DEFAULT_DIMENSIONS,
  OpenAIHybridSemanticEmbedder,
};
