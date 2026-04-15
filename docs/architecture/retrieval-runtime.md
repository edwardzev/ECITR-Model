# Retrieval Runtime

## Purpose

Define how ECITR executes retrieval plans after planning has already selected the allowed layers and budgets.

## Core Rule

Execution is still layer-aware.

The runtime may use multiple lanes, but fusion happens only after:
- planner constraints are applied
- layer boundaries are respected
- stale or invalid candidates are checked

## Runtime Stages

1. accept a planner output
2. execute eligible lanes
3. collect candidate sets
4. detect freshness and boundary conflicts
5. fuse surviving candidates
6. emit a retrieval response with explanations and conflicts

## Lane Model

Initial lanes are simple and explicit:
- lexical lane
- metadata lane
- semantic lane
- temporal lane
- evidence lane

The semantic lane runs through a replaceable semantic backend interface so retrieval quality can improve without changing ECITR schemas or authority boundaries.

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
