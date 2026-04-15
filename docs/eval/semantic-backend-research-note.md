# Semantic Backend Research Note

## Purpose

Capture the current recommendation for replacing `heuristic-semantic-v1` without changing ECITR contracts.

## Sources

- Anthropic Contextual Retrieval: [anthropic.com/engineering/contextual-retrieval](https://www.anthropic.com/engineering/contextual-retrieval)
- Qdrant Hybrid Queries: [qdrant.tech/documentation/search/hybrid-queries](https://qdrant.tech/documentation/search/hybrid-queries/)
- Qdrant Filtering: [qdrant.tech/documentation/search/filtering](https://qdrant.tech/documentation/search/filtering/)
- Qdrant Payload: [qdrant.tech/documentation/concepts/payload](https://qdrant.tech/documentation/concepts/payload/)
- Weaviate Hybrid Search: [docs.weaviate.io/weaviate/search/hybrid](https://docs.weaviate.io/weaviate/search/hybrid)
- Cohere Rerank quickstart: [docs.cohere.com/docs/reranking-quickstart](https://docs.cohere.com/docs/reranking-quickstart)
- Cohere Rerank model details: [docs.cohere.com/docs/rerank](https://docs.cohere.com/docs/rerank)

## What The Sources Say

- Anthropic recommends combining embeddings with BM25, adding context to chunks, and optionally reranking to improve retrieval quality.
- Qdrant documents dense+sparse hybrid queries with reciprocal rank fusion and explicit filtering over JSON payload fields.
- Weaviate documents hybrid search that combines vector and BM25 search with configurable fusion and weighting.
- Cohere documents reranking as a semantic boost layered on top of an existing keyword or vector retrieval system, with current models such as `rerank-v4.0-pro` and `rerank-v4.0-fast`.

## ECITR Interpretation

ECITR should not replace the file-backed catalog with a vector database.

Instead:
- keep the catalog as canonical truth
- build a derived semantic index over persisted records
- preserve metadata filtering before final ranking
- add reranking only after candidate generation, not as a source of truth

## Recommendation

The next stronger semantic backend should be:

1. A derived hybrid index over persisted ECITR records
2. Dense + sparse retrieval with metadata filters before final ranking
3. Optional reranking over a bounded candidate set

## Concrete Candidate

The cleanest near-term candidate is:
- Qdrant as the hybrid dense+sparse retrieval substrate
- ECITR metadata exported into payload fields for pre-ranking filters
- optional Cohere reranking over the top candidate window

## Why This Candidate

- Qdrant explicitly supports dense+sparse hybrid queries and reciprocal rank fusion.
- Qdrant explicitly documents payload fields and filtering, which matches ECITR’s need to filter by scope and record metadata before ranking.
- Cohere reranking is explicitly positioned as a boost on top of existing retrieval systems rather than a replacement for them.

## Alternative Candidate

Weaviate is also credible when explainable hybrid scoring, named vectors, and managed search ergonomics are more important than keeping the indexing stack minimal.

## Non-Adoption Rule

This note does not activate a backend migration.

It only defines the current recommended direction for the next semantic backend experiment.

## Repo Status

ECITR now includes an implemented derived prototype backend in [qdrant-backend.js](/Users/edwardzev/ECITR-Model/src/retrieval/semantic-backends/qdrant-backend.js).

That prototype is an integration scaffold and request-shape contract, not a declaration that Qdrant is now canonical storage or the permanent semantic backend choice.
