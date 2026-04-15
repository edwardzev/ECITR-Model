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

## Runtime Stages

1. accept a planner output
2. execute eligible lanes
3. collect candidate sets
4. detect freshness and boundary conflicts
5. fuse surviving candidates
6. emit a retrieval response with explanations and conflicts

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
- evidence lane

The semantic lane runs through a replaceable semantic backend interface so retrieval quality can improve without changing ECITR schemas or authority boundaries.

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
- duplicate support that only appears independent

See:
- `docs/architecture/parameter-memory.md`
- `docs/architecture/support-graph.md`
