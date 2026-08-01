# Workspace Attribution Migration

## Use When

Use this runbook when records in the shared catalog carry a fallback workspace
that conflicts with their source project or canonical linked lineage.

## Dry Run

Plan every configured active workspace:

```bash
npm run migrate:workspace-attribution
```

Plan one workspace first when validating a known sample:

```bash
npm run migrate:workspace-attribution -- --workspace-id ms_business_central
```

The default is always dry-run. Review:

- `updated_record_counts`;
- `staging_packets_updated`;
- every `blocker`;
- whether selected project ids and roots are exact;
- whether mixed lineage was blocked rather than normalized.

Blocked records are not migrated. In particular, mixed-workspace live
promotion candidates remain historical staging artifacts and must not be
treated as canonical truth.

## Apply

Apply only after the dry-run basis is accepted:

```bash
npm run migrate:workspace-attribution -- --workspace-id ms_business_central --apply
```

The registry-wide apply path plans from one catalog snapshot, rejects duplicate
target ownership, and preflights all operations before the first write. It then
writes validated per-workspace manifests. Repeating the same migration is
idempotent. A changed target record causes basis-drift or target-conflict
failure instead of overwrite.

Evidence is corrected append-only. Reviewed live candidates are also preserved:
the migration appends a new staged revision for corrected workspace semantics
instead of transferring the prior decision.

## Validation

After apply:

1. Run the same dry-run again and require zero planned operations for the
   migrated workspace.
2. Run `npm run check`.
3. Rebuild the support graph.
4. Sync the active semantic index.
5. Run workspace-scoped retrieval probes and confirm no cross-workspace hits.

## Rollback

Do not delete evidence corrections. If attribution must be reversed:

- inspect the applied manifest;
- restore mutable derived records from each `before_record` only through a new
  reviewed correction operation;
- append another evidence correction that states the corrected workspace;
- rebuild derived graph and semantic indexes.

There is intentionally no destructive automated rollback.

## Legacy Backfill

`backfill:workspace-id` is for old single-workspace catalogs with missing
workspace fields. It is also dry-run-first at the CLI and appends evidence
corrections from the current evidence leaf only. It is not the tool for
source-selective shared-catalog migration.
