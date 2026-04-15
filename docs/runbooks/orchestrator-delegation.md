# Orchestrator Delegation

## Purpose

Define how the Orchestrator delegates work to specialist agents without losing architectural coherence.

## Core Rule

The human developer talks to the Orchestrator.

The Orchestrator may delegate work, but it may not delegate away accountability for the final architecture-facing answer.

## Delegation Modes

### Vertical Delegation

Used when one bounded layer owns the work:
- Evidence Steward
- Case Steward
- Invariant Steward
- Tactic Steward
- Retrieval Architect

### Horizontal Delegation

Used when a concern cuts across layers:
- Researcher
- Docs Atlas Steward
- Governance and QA Steward

## Delegation Inputs

Every delegated packet should include:
- the objective
- the affected layer or layers
- explicit non-goals
- required outputs
- review expectations

## Delegation Outputs

A delegated result must report:
- what was confirmed
- what was inferred
- what remains uncertain
- what canonical docs or schemas are implicated

## Escalation Rules

The Orchestrator must step back in when:
- two specialists disagree
- a proposal crosses layer boundaries
- a change touches contracts or retrieval control
- external research suggests a structural change
- uncertainty remains on authority ownership

## Prohibited Patterns

- specialists talking past the Orchestrator as if they were human-facing
- the Researcher promoting direct architectural changes
- retrieval decisions being accepted without Retrieval Architect review
- a specialist treating local convenience as a contract change
