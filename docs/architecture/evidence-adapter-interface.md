# Evidence Adapter Interface

## Purpose

Define the only allowed way for ECITR to talk to evidence substrates such as MemPalace.

## Core Rule

Evidence substrates are subordinate execution engines.

They do not receive unvalidated writes directly from agents or higher-order layers.

The call path is:

`ECITR validation gate -> lifecycle checks -> evidence adapter -> substrate`

## Required Adapter Capabilities

An evidence adapter must expose:
- `writeEvidence`
- `getEvidence`
- `searchEvidence`
- `healthcheck`

## Authority Boundary

An evidence adapter may own:
- substrate-specific storage references
- substrate-specific search mechanics
- substrate health and capability reporting

An evidence adapter may not own:
- evidence schema validation
- lifecycle policy
- case synthesis
- invariant or tactic authority
- retrieval planning for the whole system

## Write Rule

Every evidence write must be:
- schema-valid
- lifecycle-valid
- traceable to a canonical `EvidenceRecord`
- backed by a stable verbatim payload copy referenced by `verbatim_payload_ref`

If validation fails, the adapter must not be called.

## MemPalace Spike Rule

The current MemPalace integration is a spike boundary, not a production substrate integration.

That means:
- the checkout is pinned
- the executable boundary is explicit
- ECITR still owns the canonical record and validation path
- production handoff to MemPalace remains a later step
