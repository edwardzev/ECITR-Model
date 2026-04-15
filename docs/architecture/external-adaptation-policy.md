# External Adaptation Policy

## Purpose

Define how ECITR learns from the rapidly changing external ecosystem without becoming hype-driven or contract-unstable.

## Core Rule

External research may influence ECITR, but it never changes canonical truth by itself.

The promotion path is:

`Researcher -> Orchestrator -> relevant steward review -> Governance and QA review -> ADR or contract update`

## Why This Exists

The AI tooling ecosystem changes faster than durable architecture should.

Without a formal adaptation path:
- useful tools are ignored
- hype leaks directly into contracts
- retrieval engines start defining semantics
- tactical decisions get mistaken for invariants

## Scope

This policy applies to proposals that affect:
- evidence substrates
- case extraction or compilation methods
- invariant distillation methods
- tactic freshness or revalidation methods
- retrieval engines, rerankers, planners, fusion logic, or indexing
- agent operating model and delegation patterns
- benchmark design and evaluation tooling

## Non-Goals

- freezing technology choices permanently
- making the Researcher an architecture authority
- approving changes without validation
- rewriting historical evidence to fit new tools

## Acceptable Outcomes

Research may lead to:
- no change
- a bounded experiment
- a partial integration
- a full adoption
- a replacement plan
- a rejection note with rationale

## Required Packet

Any external-adaptation proposal must produce a technology assessment packet covering:
- what the tool or practice is
- which ECITR layer or layers it affects
- maturity and operating dependencies
- expected benefit
- benchmark or evidence basis
- failure modes
- reversibility and exit path
- reasons not to adopt

See `docs/runbooks/technology-assessment-packet.md`.

## Adoption Gates

### Gate 1: Layer Fit

The proposal must state exactly which layer it affects and which layers it must not become authoritative for.

### Gate 2: Authority Preservation

The proposal must preserve:
- Evidence as factual authority
- Cases as curated experience authority
- Invariants as durable pattern authority
- Tactics as bounded current guidance
- Retrieval as non-authoritative

### Gate 3: Validation

The proposal must specify how it will be evaluated.

Minimum expectation:
- retrieval-affecting proposals require benchmark impact evidence
- semantic-affecting proposals require fixture-based regression review
- substrate-affecting proposals require migration and rollback planning

### Gate 4: Reversibility

The proposal must define what would allow the system to back out safely.

## Rejection Triggers

Reject or hold proposals that:
- blur layer boundaries
- make retrieval the semantic owner
- require rewriting evidence
- hide tool assumptions inside invariants
- provide only marketing claims and no usable evidence
- improve one benchmark while degrading auditability or boundary safety without an explicit tradeoff decision

## Operational Rule

The Researcher may propose.

The Orchestrator may triage.

Only the relevant stewards and governance path may promote the change into canonical architecture.
