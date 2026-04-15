# Evidence Layer

## Purpose

Preserve what was observed with maximum fidelity and provenance.

## Owns

- verbatim source capture
- verbatim conversation transcript snapshots
- Codex rollout imports of printed conversation events
- source locators
- hashes
- retention state
- correction links
- substrate references
- source-span-backed claim support artifacts

## Does Not Own

- interpretation
- case synthesis
- invariants
- tactics
- retrieval ranking
- orchestration

## Authority

Evidence is authoritative for facts and source material.

## Core Rules

- append-only or near-append-only
- chat conversations are captured as immutable checkpoint snapshots, not mutable rolling records
- Codex runtime capture is sourced from Codex-owned rollout event streams, not `agent-ops`
- unchanged Codex rollout sources should be skipped before full parse when the local source fingerprint is unchanged
- changed Codex threads should checkpoint only on explicit capture rules, not on every refresh
- corrections append new evidence
- no semantic normalization into canonical meaning
- stable IDs and hashes
- explicit source scope
- writes pass through an ECITR validation gate before any substrate adapter is called
- ECITR-owned evidence support records may be persisted through the storage catalog

## Recommended Substrate

MemPalace or similar systems are allowed here as subordinate evidence engines.

They must not become the owner of:
- case truth
- invariant truth
- tactic truth
- retrieval policy

See:
- `docs/architecture/evidence-adapter-interface.md`
- `docs/adr/0004-evidence-writes-pass-through-gate.md`

## Failure Modes

- evidence mutation
- source loss
- implicit normalization
- retrieval substrate becoming semantic authority
