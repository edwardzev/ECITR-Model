# Start Here

## Purpose

Orient a new human or agent to the ECITR architecture quickly and safely.

## Scope

This document explains:
- what ECITR is
- how to navigate the docs
- which documents are canonical
- which agents own which concerns

## What ECITR Is

ECITR is a layered architecture for durable, future-reinterpretable memory.

The layers are:
- Evidence
- Cases
- Invariants
- Tactics
- Retrieval

These layers must remain separate.

## Canonical Truth

Canonical truth lives in:
- `docs/architecture/system-map.md`
- `docs/architecture/external-adaptation-policy.md`
- `docs/architecture/retrieval-control-plane.md`
- `docs/architecture/record-lifecycle.md`
- `docs/architecture/evidence-adapter-interface.md`
- `docs/architecture/storage-catalog.md`
- `docs/architecture/case-compiler-pipeline.md`
- `docs/architecture/atomic-claims-extraction.md`
- `docs/architecture/review-workflow.md`
- `docs/architecture/semantic-backend-interface.md`
- `docs/architecture/retrieval-planner.md`
- `docs/architecture/retrieval-runtime.md`
- `docs/architecture/invariant-promotion-pipeline.md`
- `docs/architecture/tactic-promotion-freshness.md`
- `docs/architecture/orchestrator-runtime.md`
- `docs/architecture/layers/*.md`
- `docs/agents/*.md`
- `docs/change-control.md`
- `docs/glossary.md`
- `docs/adr/*`

Everything else supports those documents.

## Read Path

1. Read `README.md`.
2. Read `docs/architecture/system-map.md`.
3. Read `docs/architecture/external-adaptation-policy.md`.
4. Read `docs/architecture/retrieval-control-plane.md`.
5. Read `docs/architecture/record-lifecycle.md`.
6. Read `docs/architecture/evidence-adapter-interface.md`.
7. Read `docs/architecture/storage-catalog.md`.
8. Read `docs/architecture/case-compiler-pipeline.md`.
9. Read `docs/architecture/atomic-claims-extraction.md`.
10. Read `docs/architecture/review-workflow.md`.
11. Read `docs/architecture/semantic-backend-interface.md`.
12. Read `docs/architecture/retrieval-planner.md`.
13. Read `docs/architecture/retrieval-runtime.md`.
14. Read `docs/architecture/invariant-promotion-pipeline.md`.
15. Read `docs/architecture/tactic-promotion-freshness.md`.
16. Read `docs/architecture/orchestrator-runtime.md`.
17. Read each layer contract.
18. Read `docs/change-control.md`.
19. Read the relevant agent specification for your assigned scope.
20. Read the glossary before proposing naming changes.

## Ownership Model

- The Orchestrator is the only human-facing agent.
- Specialist agents own bounded scopes.
- No specialist may silently promote its local output into canonical truth.
- Retrieval never owns semantics.
- Evidence is never rewritten.

## If You Are Starting Work

Before proposing or implementing a change:
- identify the affected layer or layers
- check whether the change is local or cross-layer
- inspect the relevant schema
- inspect the relevant agent spec
- inspect the ADRs if the topic has prior decisions

If the change touches contracts, retrieval policy, or layer boundaries, route it through change control.

If the change is motivated by an external tool, benchmark, or community pattern, inspect:
- `docs/architecture/external-adaptation-policy.md`
- `docs/runbooks/research-intake.md`
- `docs/runbooks/technology-assessment-packet.md`

If the change touches evidence writes, lifecycle transitions, or supersession behavior, inspect:
- `docs/architecture/record-lifecycle.md`
- `docs/architecture/evidence-adapter-interface.md`
- `docs/architecture/storage-catalog.md`

If the change touches case derivation or review flow, inspect:
- `docs/architecture/case-compiler-pipeline.md`
- `docs/architecture/atomic-claims-extraction.md`
- `docs/architecture/review-workflow.md`

If the change touches retrieval planning or baseline evaluation, inspect:
- `docs/architecture/semantic-backend-interface.md`
- `docs/architecture/retrieval-planner.md`
- `benchmarks/retrieval-planner.baseline.json`

If the change touches retrieval execution or fusion behavior, inspect:
- `docs/architecture/retrieval-runtime.md`

If the change touches invariant or tactic derivation, inspect:
- `docs/architecture/invariant-promotion-pipeline.md`
- `docs/architecture/tactic-promotion-freshness.md`
- `docs/runbooks/invariant-hypothesis-deriver.md`
- `docs/runbooks/invariant-discovery.md`

If the change touches role routing or delegation mechanics, inspect:
- `docs/architecture/orchestrator-runtime.md`
