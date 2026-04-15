# Change Control

## Purpose

Define how ECITR changes enter, get reviewed, become canonical, and get superseded.

## Change Packet

Every meaningful change should be represented as a packet with:
- title
- owner
- affected layer or layers
- motivation
- proposed change
- non-goals
- risks
- validation plan
- rollback plan if applicable
- documentation impact

## Flow

`request -> scope classify -> review -> decision -> implement -> validate -> promote -> archive`

## Change Classes

### Local

Affects one layer only.

Required reviewers:
- relevant layer owner
- Orchestrator

### Cross-Layer

Affects more than one layer but does not alter fundamental contracts.

Required reviewers:
- all affected layer owners
- Orchestrator

### Contract

Changes a layer contract, schema authority, or semantic boundary.

Required reviewers:
- relevant layer owner
- Orchestrator
- Governance and QA Steward

### Retrieval

Changes ranking, fusion, invalidation, or retrieval interfaces.

Required reviewers:
- Retrieval Architect
- Orchestrator
- Governance and QA Steward

### Migration

Changes substrate, indexing, record formats, or compatibility expectations.

Required reviewers:
- affected owners
- Orchestrator
- Governance and QA Steward

Required artifacts:
- rollback criteria
- fixtures
- regression checks

### External Adaptation

Introduces or replaces a tool, framework, vendor, substrate, or major practice based on external research.

Required reviewers:
- Orchestrator
- relevant steward or stewards
- Governance and QA Steward

Required artifacts:
- technology assessment packet
- adoption recommendation
- benchmark or validation plan
- rollback or exit path

## Rules

- Evidence is never rewritten.
- Accepted architectural changes must produce doc updates.
- Rejected major proposals should still leave a short ADR or decision note when they matter.
- Schema changes must be versioned.
- Retrieval changes must be benchmarked, not only reasoned about.
- External research may inform decisions, but it never overrides contracts by itself.
- Evidence adapter changes must preserve the write-through-validation gate.
- Lifecycle and supersession changes must ship with regression tests against fixture examples.

## Anti-Patterns

- silent contract drift
- retrieval changes without evaluation
- specialist self-approval on cross-layer changes
- schema edits without ADR or doc updates
