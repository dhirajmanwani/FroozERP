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
3. Create and verify a full local PostgreSQL backup.
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
pg_restore --dbname $env:DATABASE_URL --no-owner --no-privileges C:\FroozERPBackups\cloud-migration\froozerp_YYYYMMDD_HHMMSS.dump
```

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

Use:

```powershell
.\scripts\cloud\verify-row-counts.ps1
```

## Rollback

- Keep local PostgreSQL and SQLite unchanged.
- Keep pending sync operations unchanged.
- Switch the controlled test device back to its previous local/LAN mode.
- Stop the hosted backend without deleting the hosted database.
- Preserve hosted logs and backups for diagnosis.
- Restore only from a verified backup into a separate recovery target.
