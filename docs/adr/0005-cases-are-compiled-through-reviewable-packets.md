# ADR 0005: Cases Are Compiled Through Reviewable Packets

## Status

Accepted

## Context

If cases are written directly from agent output, the system loses a clean boundary between:
- evidence
- extraction or framing
- accepted case truth

That makes it hard to audit provenance and hard to preserve review discipline.

## Decision

ECITR case records are compiled from explicit staging packets.

The compiler may produce draft cases only.

Active cases require a distinct review and activation step.

## Consequences

- provenance stays explicit
- compiler inputs remain separate from canonical case records
- review becomes testable rather than conversational
- external extraction tools can be swapped without changing case authority
