# Parameter Memory

## Purpose

Define how ECITR persists and uses parameter facts without creating a new top-level authority layer.

## Status

Parameter memory is implemented as evidence-adjacent support records.

It does not create a new canonical retrieval result layer.

Parameter records may inform:
- evidence retrieval text
- case retrieval text
- tactic retrieval text
- higher-order linkage from evidence into cases and tactics

Parameter records do not change the authority chain:

`Evidence -> Cases -> Invariants/Tactics`

## Record Types

### `parameter_definition`

`parameter_definition` preserves the exact observed key that ECITR saw in source material.

It stores:
- `observed_key`
- `normalized_key`
- default `value_type`
- optional `units`
- first-seen metadata

Rules:
- identity is based on the exact observed key
- `normalized_key` is a search aid only
- visually similar keys must not auto-merge

### `parameter_observation`

`parameter_observation` stores one immutable, source-backed parameter fact.

It stores:
- the exact `parameter_key`
- literal value fields
- `observation_kind`
- source evidence refs
- source spans
- project scope
- extraction strategy metadata
- optional validity or supersession metadata

Rules:
- observations are append-only
- observations must tie back to explicit source spans
- later observations may supersede earlier ones
- parameter state remains a derived read-time concern rather than a canonical record type

## Supported Distillers

Parameter extraction currently supports:
- `chat`
- `file`
- `diff`
- `log`

Unsupported or ambiguous evidence source types must no-op cleanly.

## Conservative Extraction Rules

The distillers are intentionally narrow.

They extract only explicit literal bindings such as:
- `KEY=VALUE`
- `--flag=value`
- structured JSON, YAML, or TOML assignments
- explicit version literals

They do not:
- infer business meaning from prose
- merge aliases
- infer renames across diffs
- guess parameter state from ambiguous text
- create observations without a source span

If a candidate fact cannot be tied to an explicit literal value and source location, it is skipped.

## Higher-Order Linkage

Cases and tactics may carry `parameter_observation_refs`.

Rules:
- cases may only reference observations tied to their linked evidence
- tactic promotion packets may carry explicit parameter observation refs
- tactic review does not infer parameter refs on its own
- invariants remain tool-agnostic and do not gain direct parameter refs in v1

## Retrieval Contract

The retrieval request and response schemas do not change for parameter memory v1.

Parameter-aware queries still return canonical ECITR layers:
- `evidence`
- `cases`
- `tactics`
- `invariants` when the normal retrieval text already supports the query

They do not return raw parameter records as a top-level result group.

Runtime retrieval may use parameter support records internally to enrich existing lexical, metadata, and semantic text, but the public retrieval surface stays unchanged.

## Refresh Flow

The autonomous refresh sequence now runs parameter extraction after evidence
import and before case refresh, graph refresh, and semantic sync.

The current order is:
1. import and validate evidence
2. refresh parameter support records
3. refresh case drafts
4. run governed promotions
5. refresh the derived support graph
6. sync the derived LanceDB index independently of promotion success

This keeps case compilation and retrieval text aligned with the latest persisted parameter observations.

Parameter refresh distills only the current member of each evidence correction
chain. Superseded evidence remains immutable and queryable through lineage
tools, but it is not reprocessed as current parameter input.

Historical parameter observations remain immutable support records, but runtime
retrieval hides an observation when all of its source evidence refs are
superseded. Explicit case or tactic refs do not override that current-evidence
visibility rule.

## Conflict Policy

Parameter refresh classifies existing-record mismatches before reporting health:

- exact matches are skipped as already persisted
- definition records that differ only in first-seen metadata or non-authoritative descriptor metadata are benign duplicates
- definition `value_type` drift is warning-level because observation records preserve concrete observed value types
- observation records that differ only in extraction metadata are benign duplicates
- records that differ in material identity, value, source, workspace, or lineage fields are material conflicts
- legacy definition workspace mismatches are repaired during live refresh only when the stable `definition_id` proves the corrected workspace
- extraction errors are hard failures

Autonomous refresh may continue green with benign parameter duplicates recorded as warnings. It must fail on extraction errors or material parameter conflicts.
