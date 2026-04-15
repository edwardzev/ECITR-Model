# Retrieval Planner

## Purpose

Define the first executable planning surface for ECITR retrieval.

The retrieval planner decides:
- which layers are eligible
- how many candidates each layer may return
- how strict freshness should be
- whether evidence must be included up front

## Core Rule

Planning is explicit and intent-driven.

It is not hidden inside a search backend.

## Default Profiles

### Action

- prioritize tactics
- include invariants and cases
- keep evidence budget low unless explicitly required

### Analysis

- balance tactics, invariants, and cases
- include evidence for nuance and re-distillation support

### Audit

- require evidence
- raise evidence budget
- keep tactics secondary to proof surfaces

### Verification

- require evidence
- include tactics only when operational guidance is still relevant

### Research

- prefer invariants, cases, and evidence
- do not let current tactics dominate exploratory work

## Override Rule

Caller-specified layer limits may narrow or lower the default plan.

They may not expand the request into forbidden scopes or bypass evidence requirements for audit-style requests.

## Baseline Rule

Planner behavior must be guarded by scenario baselines in:
- `benchmarks/retrieval-planner.baseline.json`
- retrieval planner tests

This is the first regression surface for retrieval before ranking and fusion engines are added.
