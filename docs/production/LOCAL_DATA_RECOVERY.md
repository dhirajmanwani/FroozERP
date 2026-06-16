# Local Data Recovery

## Local Data Location

Observed local database path:

```text
C:\Users\DellPc\AppData\Roaming\com.srtcompany.froozerp\froozerp-local.sqlite3
```

The exact Windows account name varies by device.

## What Must Be Preserved

FroozERP updates, repairs and reinstall operations must preserve:

- local SQLite database
- schema version records
- sync outbox
- unsynced local POS invoices
- local POS invoice items
- local stock movements
- local payment postings
- sync conflicts
- device identity
- activation or approval state
- app settings

## Verified Preservation

The Phase 3 repair reinstall test preserved the SQLite database:

- before reinstall: file existed, `131072` bytes
- after reinstall: file existed, `131072` bytes
- timestamp unchanged

## Recommended Manual Backup

Before a risky update or device maintenance:

1. Close FroozERP.
2. Copy the full app-data directory:

```text
C:\Users\<WindowsUser>\AppData\Roaming\com.srtcompany.froozerp
```

3. Store the backup in an owner-controlled recovery location.
4. Reopen FroozERP and confirm sync status before resuming sales.

## Recovery Rules

- Never reset the local database to fix a routine startup issue.
- Never delete pending outbox operations without owner approval.
- If the app cannot migrate the database, stop startup and show a clear error.
- If conflicts exist, preserve them for owner review.
- If reinstall is required, run repair/reinstall without deleting app data.

## Future Owner Export

A later phase should add an owner/admin export function for:

- local SQLite backup
- pending operation export
- conflict export
- device identity report
