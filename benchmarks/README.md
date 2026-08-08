# Benchmarks

This directory will hold retrieval and regression benchmark assets for ECITR.

## Current Baselines

- `retrieval-planner.baseline.json`
- `retrieval-runtime.baseline.json`
- `workflow.baseline.json`
- `semantic-backend-comparison.scenarios.json`
- `retrieval-tokenization.scenarios.json`
- `retrieval-gate.scenarios.json`

The current baseline is regression-oriented rather than performance-oriented.

It checks:
- intent classification behavior
- per-layer budgets
- evidence inclusion policy
- override handling
- execution-lane and fusion expectations
- orchestration and retrieval loop expectations
- backend-comparison runs over identical semantic scenarios
- before/after tokenizer behavior for punctuation, separators, Latin
  diacritics, exact identifiers, negation, and non-Latin scripts
- shadow-gate false negatives and false positives as separate metrics
- mandatory-policy violations and query-usefulness classifications

Run the bounded retrieval-improvement benchmark with:

`npm run benchmark:retrieval-improvements`

The gate benchmark is a constructed safety and usefulness experiment. Passing
it does not authorize retrieval suppression.
