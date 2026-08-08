# Waku-Derived Retrieval Hypothesis Assessment

## 1. Summary

- Name: Waku-derived retrieval normalization and gate hypotheses
- Category: bounded external adaptation
- Affected layer: Retrieval only
- Proposal: adopt an ECITR-owned Unicode tokenizer and evaluate an ECITR-owned
  retrieval gate without importing or depending on Waku

## 2. What It Is

This is not a Waku integration. An earlier owner-approved assessment used Waku
as a source of two questions:

1. Does ECITR lose useful matches because of ASCII-only query normalization?
2. Can a conservative classifier identify requests that may not need project
   memory without hiding critical context?

The implementation and benchmark in this repository are native ECITR code.

## 3. Why It Is Being Considered

Confirmed from the pre-change ECITR source:

- retrieval lanes, heuristic semantic matching, and hash embeddings each owned
  an ASCII-only tokenizer
- punctuation and separators were not handled consistently
- non-Latin letters were discarded
- Latin diacritics did not fold to their base spelling

The expected benefit is higher multilingual recall, consistent retrieval-lane
behavior, and a measurable gate experiment with no production suppression.

## 4. Evidence Basis

Observed ECITR evidence:

- `src/retrieval/lanes.js`
- `src/retrieval/semantic-backends/heuristic-backend.js`
- `src/retrieval/embedders/hash-embedder.js`
- `benchmarks/retrieval-tokenization.scenarios.json`
- `benchmarks/retrieval-gate.scenarios.json`

The prior external assessment motivated the hypotheses, but no external source
code or runtime claim is part of this repository's acceptance evidence. The
decision is based on ECITR source, tests, and benchmarks.

## 5. Layer Fit Matrix

- Evidence: must not own; unchanged
- Cases: must not own; unchanged
- Invariants: must not own; unchanged
- Tactics: must not own; unchanged
- Retrieval: strong fit for normalization and shadow classification
- Governance: strong fit for benchmark gates and enablement boundaries

## 6. Authority Boundary Check

The tokenizer and gate may classify, score, and record derived observations.
They must not define canonical meaning, rewrite records, change layer budgets,
or override mandatory workspace policy.

## 7. Operational Considerations

- Dependencies: none added
- Runtime cost: deterministic local tokenization and pattern checks
- Storage cost: one bounded gate object inside existing derived invocation files
- Maintainability risk: low while one tokenizer remains shared
- Vendor lock-in: none

Derived semantic indexes must be resynced after the tokenizer signature change.

## 8. Failure Modes

- false-negative gate decisions hiding relevant memory
- false-positive gate decisions retaining unnecessary retrieval cost
- benchmark overfitting to constructed English-language gate cues
- stale derived indexes using pre-change tokenization
- accidental reinterpretation of gate output as semantic authority

## 9. Validation Plan

Acceptance for this wave requires:

- zero critical false negatives in labeled scenarios
- zero mandatory-policy violations
- no exact-identifier or existing semantic regression
- correct Unicode behavior across all named scripts and retrieval paths
- full repository validation

Gate enforcement remains rejected until labeled live shadow observations support
a separate change decision.

## 10. Exit Path

The tokenizer is isolated in `src/retrieval/tokenizer.js`. The gate is isolated
in `src/retrieval/retrieval-gate.js` and can be removed from invocation output
without changing canonical schemas. Derived indexes can be rebuilt from the
file-backed canonical catalog.

## 11. Recommendation

Adopt partially:

- adopt the shared Unicode tokenizer
- retain the gate as a shadow-only experiment
- reject active retrieval suppression for now

## 12. Reasons To Reject

Reject any follow-up that imports Waku code, lets a gate bypass mandatory
policy, changes canonical truth, or enables suppression using only constructed
benchmark results.
