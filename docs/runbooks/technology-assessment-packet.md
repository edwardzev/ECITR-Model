# Technology Assessment Packet

## Purpose

Provide a standard decision packet for external tools, frameworks, retrieval engines, substrates, and practices that may affect ECITR.

## Packet Template

### 1. Summary

- name
- category
- affected layer or layers
- one-sentence proposal

### 2. What It Is

State what the tool or practice actually does.

Do not copy marketing language without interpretation.

### 3. Why It Is Being Considered

- current ECITR pain point
- expected improvement
- expected blast radius

### 4. Evidence Basis

List:
- source URLs or papers
- benchmark evidence
- observed limitations
- missing evidence

Separate:
- observed facts
- inferences

### 5. Layer Fit Matrix

For each layer, score as:
- `strong fit`
- `possible fit`
- `poor fit`
- `must not own`

Minimum layers to assess:
- Evidence
- Cases
- Invariants
- Tactics
- Retrieval
- Governance

### 6. Authority Boundary Check

State explicitly:
- what this proposal may own
- what it must not own
- how canonical truth remains preserved

### 7. Operational Considerations

- dependencies
- runtime cost
- storage cost
- complexity cost
- maintainability risk
- vendor lock-in risk

### 8. Failure Modes

Describe concrete risks, for example:
- evidence loss
- semantic drift
- stale tactic reuse
- benchmark overfitting
- migration dead ends

### 9. Validation Plan

Include:
- what will be measured
- fixtures or benchmarks to use
- acceptance criteria
- rejection criteria

### 10. Exit Path

Define:
- how adoption can be rolled back
- what data remains portable
- which abstractions isolate the system from the tool

### 11. Recommendation

Choose one:
- reject
- defer
- experiment
- adopt partially
- adopt fully

### 12. Reasons To Reject

This section is mandatory.

The packet is incomplete if it argues only for adoption.
