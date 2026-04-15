const { HashSemanticEmbedder } = require("./hash-embedder");
const {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  OpenAIHybridSemanticEmbedder,
} = require("./openai-hybrid-embedder");

function buildSemanticEmbedder({
  embedderType = process.env.ECITR_EMBEDDER ?? "openai",
  denseVectorSize,
  sparseBucketCount = 2048,
  embeddingModel = process.env.ECITR_EMBEDDING_MODEL ?? DEFAULT_MODEL,
  openAIApiKey = process.env.OPENAI_API_KEY,
  openAIBaseUrl = process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL,
  openAIOrganization = process.env.OPENAI_ORGANIZATION ?? null,
  openAIProject = process.env.OPENAI_PROJECT ?? null,
  timeoutMs,
  batchSize,
  fetchImpl,
} = {}) {
  if (embedderType === "hash") {
    return new HashSemanticEmbedder({
      denseVectorSize: denseVectorSize ?? 16,
      sparseBucketCount,
    });
  }

  if (embedderType === "openai") {
    return new OpenAIHybridSemanticEmbedder({
      apiKey: openAIApiKey,
      model: embeddingModel,
      denseVectorSize,
      sparseBucketCount,
      baseUrl: openAIBaseUrl,
      fetchImpl,
      timeoutMs,
      batchSize,
      organization: openAIOrganization,
      project: openAIProject,
    });
  }

  throw new Error(`Unsupported semantic embedder type: ${embedderType}`);
}

module.exports = {
  buildSemanticEmbedder,
};
