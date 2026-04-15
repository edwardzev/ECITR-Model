# System Map

## Purpose

Define the whole ECITR system in one place without collapsing layer boundaries.

## Layers

### 1. Evidence

Stores immutable source material and provenance.

May use:
- MemPalace
- blob stores
- append-only logs
- other recall engines

Does not define meaning.

### 2. Cases

Stores structured experience records derived from evidence.

Defines:
- situation shape
- constraints
- action taken
- outcome
- failure mode
- applicability

### 3. Invariants

Stores durable, tool-agnostic patterns that hold across multiple cases.

### 4. Tactics

Stores current, bounded action guidance for concrete tool/version/environment contexts.

### 5. Retrieval

Classifies queries, retrieves candidates from each layer, ranks them, applies budgets and invalidation rules, and returns a fused result.

## Authority Chain

`Evidence -> Cases -> Invariants/Tactics`

Retrieval is not in the authority chain.

## Agent Model

- Orchestrator
- Evidence Steward
- Case Steward
- Invariant Steward
- Tactic Steward
- Retrieval Architect
- Researcher
- Docs Atlas Steward
- Governance and QA Steward

## External Adaptation Rule

External tools and best practices may influence ECITR only through:

`Researcher -> Orchestrator -> relevant steward review -> ADR/contract update`

See:
- `docs/architecture/external-adaptation-policy.md`
- `docs/runbooks/technology-assessment-packet.md`

## Design Axioms

- immutable evidence
- versioned higher-order records
- explicit supersession
- explicit applicability and non-applicability
- scope-aware transfer boundaries
- pluggable retrieval infrastructure
- doc-first evolution

## Canonical Supporting Documents

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
- `docs/change-control.md`
- `docs/runbooks/orchestrator-delegation.md`
