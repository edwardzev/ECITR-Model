# Case Compiler Research Note

## Purpose

Capture the external signal used during ECITR Step 4 without turning that signal into canonical authority.

This is a supporting note, not a contract.

## Verified Sources

- [W3C PROV-DM](https://www.w3.org/TR/prov-dm/)
- [OpenAI Structured Outputs](https://openai.com/index/introducing-structured-outputs-in-the-api/)
- [OpenAI Agent Builder Safety](https://developers.openai.com/api/docs/guides/agent-builder-safety)
- [Mem0 Docs](https://docs.mem0.ai/introduction)
- [Letta Archival Memory](https://docs.letta.com/guides/core-concepts/memory/archival-memory)
- [LlamaIndex Framework Docs](https://developers.llamaindex.ai/python/framework/)
- [MemMachine](https://arxiv.org/abs/2604.04853)
- [Review of Case-Based Reasoning for LLM Agents](https://arxiv.org/abs/2504.06943)

## External Signal

The consistent signal across these sources is:
- preserve raw evidence
- structure derived memory explicitly
- keep provenance attached
- use schema-constrained compilation instead of freeform summary writes
- treat review and safety as explicit control surfaces

## Implications For ECITR

The current Case Compiler pipeline should:
- stay packet-based
- require evidence refs
- emit draft cases first
- preserve the ability to add source spans later
- keep retrieval concerns outside the compiler

## Explicit Non-Implications

This research note does not authorize:
- direct case writes from agents
- changing the ECITR authority chain
- making retrieval or embeddings the semantic owner
- replacing evidence with summary-only artifacts
