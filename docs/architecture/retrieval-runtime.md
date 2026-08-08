# Retrieval Runtime

## Purpose

Define how ECITR executes retrieval plans after planning has already selected the allowed layers and budgets.

## Core Rule

Execution is still layer-aware.

The runtime may use multiple lanes, but fusion happens only after:
- planner constraints are applied
- layer boundaries are respected
- stale or invalid candidates are checked

Support records may enrich lane inputs, but they do not become independent retrieval result layers.

When a retrieval request carries `workspace_id`, every returned canonical record must match that workspace before ranking can influence the result set. Missing workspace identity is treated as non-matching for that request.

## Runtime Stages

1. accept a planner output
2. execute eligible lanes
3. collect candidate sets
4. reject candidates without sufficient relevance support
5. detect freshness and boundary conflicts
6. diversify evidence by source lineage
7. fuse surviving candidates
8. emit a retrieval response with explanations and bounded conflicts

## Runtime Intervention Layer

ECITR now supports a thin runtime intervention layer for hot-path agent use.

The intervention layer:
- composes a normal retrieval request for `preflight` or `failure_retry`
- reuses the existing retrieval planner and runtime
- trims the runtime output into a smaller grouped selection for immediate use
- may use the support graph only as secondary, explanation-safe expansion
- writes derived intervention artifacts under `.local/runtime-interventions/`
- must reuse the same eligibility gates as direct retrieval before admitting graph-expanded candidates

The intervention layer does not:
- add new canonical record types
- change retrieval request or response schemas
- expose support records as new public result groups
- change ranking authority or bypass freshness, scope, or approval gates

## Lane Model

Initial lanes are simple and explicit:
- lexical lane
- metadata lane
- semantic lane
- temporal lane

The lexical, metadata, and temporal lanes use the shared `unicode-v2` retrieval
tokenizer. The current heuristic semantic backend uses the same tokenizer, as do
the sparse and hash-derived parts of semantic embeddings. External dense models
continue to receive their normal raw text input.

The tokenizer contract is:

- preserve Unicode letters, numbers, combining marks, and underscore-delimited
  identifiers such as `ECITR_LANCEDB_URI`
- split punctuation, slash, colon, and hyphen consistently
- fold Latin diacritics so `Müller` and `Muller` normalize together
- retain Hebrew, Arabic, Cyrillic, CJK, and other non-Latin scripts
- remove only the small shared relevance stop-word set
- retain negation such as `no` and `not`

Tokenizer changes are derived-index compatibility changes. Hash and OpenAI
hybrid embedding signatures include the tokenizer version. A local LanceDB
basis built with the prior signature is rejected as non-current and project
memory falls back to the file-backed heuristic backend until the derived index
is resynced.

There is no query-independent evidence fallback. Proof-oriented requests may
increase the evidence budget, but they must not manufacture arbitrary evidence
when no evidence record is relevant.

The semantic lane runs through a replaceable semantic backend interface so retrieval quality can improve without changing ECITR schemas or authority boundaries.

Semantic-only candidates must be qualified by the backend before fusion admits
them. The heuristic backend qualifies exact normalized-token matches. LanceDB
candidates remain unqualified unless an evaluated backend-specific distance
boundary is configured. Lexical or metadata corroboration may still admit a
candidate from LanceDB.

Parameter support records may enrich lexical, metadata, and semantic text for evidence, cases, and tactics. This enrichment does not change the retrieval request or response contracts.

Derived support-graph artifacts may enrich retrieval explanations after fusion, but they remain subordinate to canonical records and do not become public retrieval result types.

Normal retrieval graph use in the current wave is explanation-only:
- it appends explanation lines after fusion
- it does not add, remove, reorder, or rerank selected results
- it must fail closed when the support-graph snapshot is missing or stale relative to the current runtime catalogs

Later lanes may include graph or policy-aware retrieval, but those are extensions rather than prerequisites.

## Fusion Rule

Fusion may combine multiple lane scores for the same record, but it must still return results grouped by canonical layer.

The runtime must not collapse all layers into one generic ranked list.

## Conflict Rule

The runtime must surface conflicts such as:
- stale tactics
- invalidated tactics
- cross-project leakage when scope metadata exists
- cross-workspace leakage when workspace metadata exists
- duplicate support that only appears independent

Public conflict text is intentionally bounded. Full exclusion counts remain in
internal runtime diagnostics so intervention metrics do not depend on truncated
human-readable strings.

When no eligible relevant record survives, retrieval returns empty canonical
result groups and an explicit abstention explanation.

Evidence diversity uses workspace plus source locator as a source-lineage key.
One source artifact may occupy at most one evidence slot, with higher score and
newer capture time winning.

See:
- `docs/architecture/parameter-memory.md`
- `docs/architecture/support-graph.md`
- `docs/adr/0011-unicode-retrieval-normalization-and-shadow-gating.md`
