# Phase 4E Database Migration Runbook

## Non-destructive rule

Do not point the hosted application at an unprepared database and do not allow application startup to mutate schema automatically.

Hosted production must use:

```dotenv
RUN_STARTUP_SCHEMA_BOOTSTRAP=false
RUN_STARTUP_REFERENCE_SEED=false
```

With those defaults, the backend performs a read-only required-table check and stops with a clear error if the database has not been restored or migrated.

## Recommended path: verified full restore

1. Stop billing writes during the final backup window.
2. Record PostgreSQL row counts and local SQLite queue status.
3. Create a full local PostgreSQL backup, and prove it restores with `verify-restore-roundtrip.ps1`. A backup nobody has restored is a guess.
4. Restore the backup into a separate hosted PostgreSQL database.
5. Do not overwrite or delete the local PostgreSQL database.
6. Compare core row counts and financial totals before starting the hosted API.
7. Start one hosted backend instance with schema bootstrap and reference seeding disabled.
8. Run the read-only cloud verification command.

Example backup:

```powershell
.\scripts\cloud\backup-postgres.ps1 -OutputDir C:\FroozERPBackups\cloud-migration
```

Example provider restore using its secret-managed URL:

```powershell
pg_restore --dbname $env:DATABASE_URL --single-transaction --exit-on-error --no-owner --no-privileges C:\FroozERPBackups\cloud-migration\froozerp_YYYYMMDD_HHMMSS.dump
```

`--single-transaction --exit-on-error` is not optional. Without it, restoring into a database the
backend has already started against restores the parent tables and leaves the child tables empty:
every invoice present, not one line item, no stock. pg_restore reports this by exiting non-zero and
nothing else, so a restore that "printed no obvious error" is not evidence.

The hosted target must be an empty database. If the backend has bootstrapped its schema there
already, the tables exist with live foreign keys and that is exactly the case above.

Only run restore against the explicitly selected hosted target. Never restore over the live local shop database.

## Incremental migration plans

The files under `backend/migrations/cloud` are reviewed plans, not an automatic migration chain or a complete empty-database bootstrap. Apply a plan only when:

- the hosted database has a verified backup;
- the exact target schema is known;
- the SQL has been reviewed for that target;
- a restore/rollback rehearsal has passed;
- row counts and totals are captured before and after.

Do not wire these files into process startup. Do not use destructive reset, drop-database, truncate, or delete-data commands.

## Verification tables

At minimum compare:

- users
- branches and counters
- authorized devices
- product categories and products
- inventory batches/lots
- sales, sale items, and sale payments
- purchases and purchase items
- suppliers and customers
- expenses
- sync processed operations and change log

Compare the two databases rather than reading one side's numbers:

```powershell
.\scripts\cloud\verify-row-counts.ps1 -Database froozerp -CompareDatabase froozerp_hosted_copy
```

This counts every table in the schema, not the list above, and exits non-zero on any difference.
The list is kept here because it names what a person should look at first, not because it is what
gets checked.

## Rollback

- Keep local PostgreSQL and SQLite unchanged.
- Keep pending sync operations unchanged.
- Switch the controlled test device back to its previous local/LAN mode.
- Stop the hosted backend without deleting the hosted database.
- Preserve hosted logs and backups for diagnosis.
- Restore only from a verified backup into a separate recovery target.
