# Glossary

## Evidence

Immutable verbatim source material. Evidence stores what was observed, not what it means.

## Case

A structured experience record derived from evidence. A case explains a concrete situation, the constraints, the action taken, the outcome, the failure mode, and when the pattern does or does not apply.

## Invariant

A durable, tool-agnostic claim that should survive framework or implementation churn.

## Tactic

A current, bounded recommendation for what to do now under specific tool, version, and environment conditions.

## Retrieval

The subsystem that classifies queries, finds candidate records, ranks them, and fuses them into a useful runtime surface.

## Authority

The right to define canonical meaning. Retrieval does not have authority. Evidence has factual authority. Higher layers have bounded interpretive authority.

## Scope

The allowed transfer boundary for a record. ECITR uses:
- `project`
- `project_family`
- `global`
- `blocked`

## Supersession

Explicit version replacement. Old records are not silently edited into new meaning.

## Re-distillation

Reinterpreting existing evidence or cases using newer methods or tools without destroying provenance.

## Transferability

How safely a record can move across project boundaries.
