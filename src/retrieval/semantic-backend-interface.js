class SemanticRetrievalBackend {
  constructor({ backendId, capabilities = [] }) {
    if (!backendId) {
      throw new Error("SemanticRetrievalBackend requires a backendId.");
    }

    this.backendId = backendId;
    this.capabilities = capabilities;
  }

  async retrieve() {
    throw new Error("SemanticRetrievalBackend.retrieve must be implemented by subclasses.");
  }
}

function assertSemanticRetrievalBackend(backend) {
  if (!(backend instanceof SemanticRetrievalBackend)) {
    throw new Error("Semantic lane backend must extend SemanticRetrievalBackend.");
  }

  return backend;
}

module.exports = {
  SemanticRetrievalBackend,
  assertSemanticRetrievalBackend,
};
