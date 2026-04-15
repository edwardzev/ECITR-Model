# Retrieval Planner Research Note

## Purpose

Capture the external signal used during ECITR Step 5 without turning that signal into canonical authority.

This is a supporting note, not a contract.

## Verified Sources

- [Letta Archival Memory](https://docs.letta.com/guides/core-concepts/memory/archival-memory/)
- [Mem0 Advanced Retrieval](https://docs.mem0.ai/platform/features/advanced-retrieval)
- [Zep Key Concepts](https://help.getzep.com/concepts)
- [LlamaIndex Reciprocal Rerank Fusion Retriever](https://developers.llamaindex.ai/python/framework/integrations/retrievers/reciprocal_rerank_fusion/)
- [LongMemEval](https://arxiv.org/abs/2410.10813)

## External Signal

The consistent signal across these sources is:
- use layered candidate generation instead of one universal retriever
- keep freshness and validity metadata explicit
- fuse shortlisted candidates instead of trusting a single ranker
- benchmark memory behavior separately from generic retrieval behavior

## Implications For ECITR

The initial retrieval planner should stay:
- explicit
- intent-driven
- layer-aware
- benchmark-guarded

The next retrieval stages should assume:
- multiple retrieval lanes are normal
- fusion happens after filtering and shortlisting
- provenance and freshness stay attached to candidates
- audit and verification requests should surface evidence earlier than action requests

## Explicit Non-Implications

This research note does not authorize:
- flattening all layers into one search surface
- treating ranking engines as semantic owners
- replacing authority boundaries with benchmark wins
- letting performance benchmarks erase auditability requirements
