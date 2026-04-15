# Benchmarks

This directory will hold retrieval and regression benchmark assets for ECITR.

## Current Baselines

- `retrieval-planner.baseline.json`
- `retrieval-runtime.baseline.json`
- `workflow.baseline.json`
- `semantic-backend-comparison.scenarios.json`

The current baseline is regression-oriented rather than performance-oriented.

It checks:
- intent classification behavior
- per-layer budgets
- evidence inclusion policy
- override handling
- execution-lane and fusion expectations
- orchestration and retrieval loop expectations
- backend-comparison runs over identical semantic scenarios
