# Semantic Backend Research Note

## Purpose

Capture the current recommendation for replacing `heuristic-semantic-v1` without changing ECITR contracts.

## Sources

- Anthropic Contextual Retrieval: [anthropic.com/engineering/contextual-retrieval](https://www.anthropic.com/engineering/contextual-retrieval)
- Qdrant Hybrid Queries: [qdrant.tech/documentation/search/hybrid-queries](https://qdrant.tech/documentation/search/hybrid-queries/)
- Qdrant Filtering: [qdrant.tech/documentation/search/filtering](https://qdrant.tech/documentation/search/filtering/)
- Qdrant Payload: [qdrant.tech/documentation/concepts/payload](https://qdrant.tech/documentation/concepts/payload/)
- LanceDB Vector Search: [docs.lancedb.com/core/vector-search](https://docs.lancedb.com/core/vector-search/)
- LanceDB Full-Text Search: [docs.lancedb.com/core/full-text-search](https://docs.lancedb.com/core/full-text-search/)
- Weaviate Hybrid Search: [docs.weaviate.io/weaviate/search/hybrid](https://docs.weaviate.io/weaviate/search/hybrid)
- Cohere Rerank quickstart: [docs.cohere.com/docs/reranking-quickstart](https://docs.cohere.com/docs/reranking-quickstart)
- Cohere Rerank model details: [docs.cohere.com/docs/rerank](https://docs.cohere.com/docs/rerank)

## What The Sources Say

- Anthropic recommends combining embeddings with BM25, adding context to chunks, and optionally reranking to improve retrieval quality.
- Qdrant documents dense+sparse hybrid queries with reciprocal rank fusion and explicit filtering over JSON payload fields.
- LanceDB documents embedded vector search and full-text indexes over local tables.
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
4. Embedded local operation unless measured workload justifies a daemon

## Concrete Candidate

The cleanest near-term operational candidate is:
- LanceDB as an embedded local derived semantic index
- ECITR metadata exported into primitive columns for pre-ranking filters
- contextual text retained for full-text indexing and later hybrid retrieval
- optional reranking over the top candidate window

## Why This Candidate

- LanceDB avoids a long-running service while ECITR is still proving retrieval value and index refresh economics.
- LanceDB supports local vector search and full-text indexes, which matches the current need for a derived local index.
- ECITR can still preserve catalog truth and project/workspace metadata filters before ranking.
- Cohere reranking is explicitly positioned as a boost on top of existing retrieval systems rather than a replacement for them.

## Alternative Candidate

Qdrant remains credible when ECITR needs a daemonized hybrid dense+sparse service, concurrent multi-agent access, or payload-filter performance beyond the embedded local path.

Weaviate is also credible when explainable hybrid scoring, named vectors, and managed search ergonomics are more important than keeping the indexing stack minimal.

## Non-Adoption Rule

This note does not activate a backend migration.

It only defines the current recommended direction for the next semantic backend experiment.

## Repo Status

ECITR now includes an implemented embedded derived backend in [lancedb-backend.js](../../src/retrieval/semantic-backends/lancedb-backend.js).

Autonomous refresh now runs LanceDB sync as an independent derived stage after
the support graph, even when promotion benchmarks block promotion. Governed
promotion skips its embedded LanceDB sync on that path, preventing one promotion
gate from leaving the retrieval index stale.

`search_project_memory` uses a matching local table for semantic candidate
generation. Vector-only candidates fail closed unless an evaluated
backend-specific boundary is configured (`ECITR_LANCEDB_MAX_DISTANCE` for the
local runtime) or another lane corroborates the record.

The semantic benchmark now accepts `expected_results` and `forbidden_results`
per scenario and reports pass/fail quality in addition to backend overlap. The
CLI exits non-zero when the candidate backend fails evaluated golden scenarios.
Qdrant sync remains opt-in.

ECITR also retains the Qdrant prototype in [qdrant-backend.js](../../src/retrieval/semantic-backends/qdrant-backend.js) as a comparison path.

Neither backend is canonical storage. Both are derived from the file-backed catalog.
