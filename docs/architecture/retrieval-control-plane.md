# Retrieval Control Plane

## Purpose

Define retrieval as an explicit control plane rather than a vague search step.

Retrieval is responsible for deciding:
- what kind of request is being handled
- which layers are eligible
- how many candidates each layer may contribute
- how conflicts and staleness are treated
- how results are explained back to the caller

## Control Flow

`request -> classify -> plan -> candidate generation -> rank -> fuse -> conflict check -> explain -> return`

## Step Contracts

### 1. Classify

Determine:
- intent
- scope
- urgency
- whether current-action guidance is needed
- whether proof or audit evidence is required

### 2. Plan

Choose:
- allowed layers
- per-layer result budgets
- freshness strictness
- whether evidence retrieval is needed immediately or only on escalation

### 3. Candidate Generation

Use layer-appropriate engines:
- tactics and invariants may use structured indexes
- cases may use similarity or hybrid retrieval
- evidence may use MemPalace or another recall substrate

Candidate generation may differ by layer, but canonical records remain engine-neutral.

### 4. Rank

Combine:
- layer priority
- scope match
- applicability
- evidence support
- outcome quality
- freshness
- duplication penalty
- conflict penalty

### 5. Fuse

Return a layered result, not a flattened bag of matches.

Default presentation order:
1. tactics
2. invariants
3. cases
4. evidence

### 6. Conflict Check

Explicitly detect:
- stale tactics that contradict newer evidence
- invariants unsupported by current cases
- cross-project leakage
- duplicated matches masquerading as independent support

### 7. Explain

Every retrieval response should state:
- why the top records were surfaced
- which layers were consulted
- which conflicts or exclusions were applied

## Default Budgets

These are planning defaults, not hard constants:
- tactics: 3 to 5
- invariants: 5 to 8
- cases: 5 to 10
- evidence: 3 to 5

Evidence is not the default flood surface.

## Non-Goals

- making retrieval responsible for semantics
- forcing one backend choice for all layers
- assuming one benchmark can stand in for the full memory system

## Review Rule

Any retrieval control-plane change is a retrieval-class change under `docs/change-control.md`.
