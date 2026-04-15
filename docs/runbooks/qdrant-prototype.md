# Qdrant Prototype Runbook

## Purpose

Explain how to sync the file-backed ECITR catalog into a live Qdrant collection and compare `heuristic-semantic-v1` against `qdrant-hybrid-prototype-v1`.

## Commands

Install the managed local Qdrant binary if it is not present:

```bash
npm run qdrant:install
```

Start the managed local Qdrant runtime:

```bash
npm run qdrant:start
```

Inspect managed runtime status:

```bash
npm run qdrant:status
```

Stop the managed local Qdrant runtime:

```bash
npm run qdrant:stop
```

Refresh the imported `agent-ops` runs and sessions corpus into `.local/catalog`, recreate the local derived collection, and run the live-corpus smoke checks:

```bash
npm run refresh:agent-ops
```

Refresh the Codex-native conversation corpus from local Codex rollout storage into `.local/catalog`, sync the current derived collection, and run structural capture checks:

```bash
npm run refresh:codex
```

Distill supported canonical evidence into staged case packets and draft cases:

```bash
npm run refresh:cases
```

Run the ECITR-owned autonomous overnight pipeline:

```bash
npm run refresh:autonomous
```

Run the governed promotion segment directly without re-running evidence ingest:

```bash
npm run refresh:promotions
```

Install the ECITR-owned daily `launchd` scheduler for that autonomous path:

```bash
npm run refresh:codex:launchd -- install
```

Sync a seeded example catalog into Qdrant:

```bash
npm run qdrant:sync -- --qdrant-url http://127.0.0.1:6333 --collection ecitr-semantic --seed-examples
```

Run a comparison benchmark on the same seeded example catalog:

```bash
npm run benchmark:semantic -- --qdrant-url http://127.0.0.1:6333 --collection ecitr-semantic --seed-examples
```

## Environment Variables

The commands also accept:

- `ECITR_AGENT_OPS_ROOT`
- `ECITR_CODEX_ROOT`
- `ECITR_QDRANT_URL`
- `ECITR_QDRANT_COLLECTION`
- `ECITR_CATALOG_ROOT`

## Refresh Defaults

`npm run refresh:agent-ops` uses these defaults unless overridden by flags or environment variables:

- `agent-ops` root: sibling checkout at `../agent-ops` when present
- catalog root: `.local/catalog`
- collection: `ecitr-local-catalog-v1`
- Qdrant URL: `http://127.0.0.1:6333`
- collection recreation: enabled, so the derived index matches the canonical local catalog exactly

Useful flags:

- `--dry-run` to plan imports without changing the catalog or Qdrant
- `--skip-smoke-check` to refresh and sync without running the live-corpus retrieval checks
- `--skip-recreate-collection` to keep the existing collection and upsert into it instead of recreating it

`npm run refresh:codex` uses these defaults unless overridden by flags or environment variables:

- Codex root: `~/.codex`
- catalog root: `.local/catalog`
- collection: `ecitr-local-catalog-v1`
- Qdrant URL: `http://127.0.0.1:6333`
- collection recreation: disabled, so the active derived collection is updated in place during ongoing runtime capture
- rollout import uses a cheap unchanged-file fingerprint check before parse
- changed threads checkpoint into evidence only on first-seen, new `final_answer`, archive, `7` day age threshold, or `100` new printed messages

Useful flags:

- `--dry-run` to plan imports without changing the catalog or Qdrant
- `--skip-sessions` to ignore active rollout files under `~/.codex/sessions`
- `--skip-archived` to ignore archived rollout files under `~/.codex/archived_sessions`
- `--skip-structural-check` to sync without validating capture completeness accounting

Recommended operating cadence:

- run `npm run refresh:autonomous` once per day overnight
- use `npm run refresh:promotions` when you want the morning promotion/re-sync step without replaying evidence ingest
- run it manually when recent Codex conversations need to be available in retrieval earlier than the scheduled cadence
- prefer the ECITR-owned `launchd` job over Codex app automation for schedule ownership

## Current Embedder

The prototype uses a deterministic local hash embedder.

This keeps the prototype runnable without an external embedding provider.
It is suitable for integration testing and request-shape benchmarking, not for claiming state-of-the-art semantic quality.

## Boundary Rules

- The file-backed catalog remains canonical.
- Qdrant holds a derived index only.
- Sync exports persisted records; it does not change canonical records.
- Exported Qdrant point IDs are deterministic UUIDs derived from the ECITR layer and canonical record ID.
- Collection creation is idempotent; rerunning sync against an existing collection should succeed.
- Benchmark comparisons are for retrieval behavior, not for authority or storage decisions.

## Managed Runtime Layout

- Binary: `.local/qdrant/bin/qdrant`
- Config: `.local/qdrant/config/config.yaml`
- Logs: `.local/qdrant/logs/qdrant.log`
- PID file: `.local/qdrant/run/qdrant.pid`
- Managed storage: `.local/qdrant/storage`
- Managed snapshots: `.local/qdrant/snapshots`
- Managed temp files: `.local/qdrant/temp`

Legacy note:
- older ad hoc runs may have written data under `.local/qdrant/bin/storage`
- the managed runtime does not use that path
