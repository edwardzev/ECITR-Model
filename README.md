# ECITR Model

ECITR stands for Evidence-Cases-Invariants-Tactics-Retrieval.

This repository is a greenfield memory architecture project. It is not a continuation of `agent-ops`.

ECITR exists to separate:
- what was observed
- what happened in a concrete situation
- what remains true across situations
- what should be done now under current conditions
- how those records are found at runtime

## Core Rule

Authority flows one way:

`Evidence -> Cases -> Invariants/Tactics`

Retrieval is separate. It finds, ranks, and fuses records, but it does not own semantic truth.

## Design Constraints

- `agent-ops` remains frozen as historical prior art.
- MemPalace or a similar engine may be used as an evidence substrate, but not as the canonical owner of higher-order memory.
- Evidence is immutable.
- Cases are versioned.
- Invariants are tool-agnostic.
- Tactics are tool-, version-, and environment-bound.
- Retrieval must be pluggable and replaceable without rewriting canonical records.
- The human interacts with the Orchestrator, not directly with specialist agents.

## Read Order

1. [00-start-here](./docs/00-start-here.md)
2. [system-map](./docs/architecture/system-map.md)
3. [external-adaptation-policy](./docs/architecture/external-adaptation-policy.md)
4. [retrieval-control-plane](./docs/architecture/retrieval-control-plane.md)
5. [record-lifecycle](./docs/architecture/record-lifecycle.md)
6. [evidence-adapter-interface](./docs/architecture/evidence-adapter-interface.md)
7. [storage-catalog](./docs/architecture/storage-catalog.md)
8. [case-compiler-pipeline](./docs/architecture/case-compiler-pipeline.md)
9. [atomic-claims-extraction](./docs/architecture/atomic-claims-extraction.md)
10. [parameter-memory](./docs/architecture/parameter-memory.md)
11. [workspace-attribution](./docs/architecture/workspace-attribution.md)
12. [review-workflow](./docs/architecture/review-workflow.md)
13. [semantic-backend-interface](./docs/architecture/semantic-backend-interface.md)
14. [retrieval-planner](./docs/architecture/retrieval-planner.md)
15. [retrieval-runtime](./docs/architecture/retrieval-runtime.md)
16. [support-graph](./docs/architecture/support-graph.md)
17. [invariant-promotion-pipeline](./docs/architecture/invariant-promotion-pipeline.md)
18. [tactic-promotion-freshness](./docs/architecture/tactic-promotion-freshness.md)
19. [orchestrator-runtime](./docs/architecture/orchestrator-runtime.md)
20. Layer contracts:
   - [evidence](./docs/architecture/layers/evidence.md)
   - [cases](./docs/architecture/layers/cases.md)
   - [invariants](./docs/architecture/layers/invariants.md)
   - [invariant discovery](./docs/runbooks/invariant-discovery.md)
   - [tactics](./docs/architecture/layers/tactics.md)
   - [retrieval](./docs/architecture/layers/retrieval.md)
21. [change-control](./docs/change-control.md)
22. Agent specifications in `docs/agents/`
23. Runbooks in `docs/runbooks/`
24. [glossary](./docs/glossary.md)

## Current State

This repo currently contains:
- the canonical architecture documents
- JSON schemas, validation code, and lifecycle rules
- initial agent specifications
- runbooks for research intake and ADR creation
- example records in `fixtures/examples/`
- the first implementation surfaces for evidence validation, storage-backed persistence, native chat conversation snapshots as `EvidenceRecord`s, Codex-native rollout import into canonical chat evidence with cheap unchanged-file skipping and checkpointed snapshot creation, autonomous run-evidence distillation into staged case packets and draft cases with explicit open questions, a manual case review surface for queue/list/show/complete/amend/decision flows, a batch case-promotion runner that skips previously blocked draft ids by default, a deterministic boundary-recovery lane for primitive drafts that can recover cited unresolved boundaries before completion, bounded case completion packets with support-linked applicability suggestions, a dry-run case-review benchmark harness for tuning promotion rules without mutating canonical state, a replay benchmark harness that reconstructs original draft state from compilation packets to evaluate the full current case pipeline end-to-end, atomic-claims extraction, persisted review audit trails, a Unicode-aligned retrieval runtime with a benchmarked shadow-only retrieval gate, semantic backend decoupling, an embedded LanceDB semantic backend with derived-index signature and basis checks, repeatable refresh pipelines for historical `agent-ops` backfill and ongoing Codex conversation capture into `.local/catalog`, a benchmark-driven invariant discovery surface plus canonical invariant promotion path through staged packets and review, a benchmark-driven tactic discovery surface plus canonical tactic promotion path through staged packets and review, a governed promotion runner that reuses the benchmarked case, invariant, and tactic review surfaces, and a launchd-owned daily ECITR autonomous refresh scheduler that chains evidence capture, parameter and case refresh, governed promotion, support-graph refresh, and an independent derived LanceDB sync

## Non-Goals

- Retrofitting `agent-ops` in place
- Treating chat history as final truth
- Letting retrieval engines define canonical semantics
- Storing timeless lessons that hide tool or environment assumptions
