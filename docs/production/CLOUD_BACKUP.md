# Backing Up The Shop's Cloud Data

One command, run on a machine in the shop, writing to that machine.

```powershell
$env:DATABASE_PUBLIC_URL = "<the public connection string from Railway>"
node scripts/cloud/backup-cloud.mjs --out "D:\FroozERP-Backups"
```

That is the whole thing. It reads every table, writes one compressed file named for the date and
time, and then reads that file back and checks it against its own record of what it wrote. If the
last line says `RESULT: complete and readable`, the file is a backup. If anything else is printed,
it is not, and the command exits non-zero so a scheduled task can tell.

## Why it runs from the shop and not from the cloud

The hosted backend has a scheduled backup of its own. It writes inside the container, which the
platform replaces on every deploy and from which nobody can download anything — and it had been
failing every night with `EACCES: permission denied, mkdir '/backups'` for as long as it had been
deployed, saying so only in a log nobody reads. Both halves are fixed (`backend/backupLocation.js`),
but the second half cannot be fixed by fixing a path:

**A copy that lives on the same service as the original is not a backup.** It is a second way to
lose the same thing at the same moment. The value of this command is the location — a drive you
can unplug, in a building you can walk into.

## Keeping old ones

Nothing is deleted unless you ask:

```powershell
node scripts/cloud/backup-cloud.mjs --out "D:\FroozERP-Backups" --keep 14
```

Only files this command wrote are ever removed, newest 14 kept. Without `--keep`, every backup is
kept forever, because a backup command that deletes backups when nobody said not to is a backup
command that loses backups.

## Checking a file later

```powershell
node scripts/cloud/backup-cloud.mjs --verify "D:\FroozERP-Backups\froozerp-cloud-20260918-224500.jsonl.gz"
```

Reads the file only — no database, no network. It prints when the backup was taken, from which
host, how many tables and rows, and whether the file is whole.

"Whole" is a real check, not a formality. The closing summary is written last, so a run that
stopped halfway produces a file with no summary — and a truncated `.gz` still opens cleanly up to
the cut, so "it opened" proves nothing on its own. A file with no summary is refused by name.

## Running it every day

Windows Task Scheduler, daily, action:

```
Program:   node
Arguments: scripts/cloud/backup-cloud.mjs --out "D:\FroozERP-Backups" --keep 14
Start in:  F:\FroozERP
```

The connection string has to reach the task. Set `DATABASE_PUBLIC_URL` as a **system** environment
variable (not a user one, if the task runs whether or not you are signed in). It carries the
database password: it belongs in Windows' environment settings and nowhere else — not in a
`.bat` file kept next to the backups, and never pasted into a chat.

Check on it monthly the only way that means anything: run `--verify` on the newest file, and open
the folder to confirm the dates are recent. A backup job that stopped three months ago looks
exactly like one that is working, until the day it matters.

## What is in the file

One gzipped JSON-lines file:

- a header — format, when, which host, which machine took it, and the list of tables;
- for each table, its column names and types, then one line per row;
- a closing summary with the row count per table.

Dates, times and numbers are kept exactly as the database has them — a `DATE` stays `2026-09-18`
rather than becoming a timestamp that can shift a day across time zones, and a `NUMERIC` stays its
exact digits rather than becoming a float. This matters more here than anywhere else in the system:
everything else can be corrected later from the data, and this *is* the data.

# Putting A Backup Back

```powershell
$env:DATABASE_PUBLIC_URL = "<the public connection string from Railway>"
node scripts/cloud/restore-cloud.mjs --file "D:\FroozERP-Backups\froozerp-cloud-....jsonl.gz"
```

That writes nothing. It reads the file, reads the target, and prints a table-by-table comparison of
how many rows are there now against how many are in the backup — then stops and shows you the
command that would actually do it.

Only when that looks right:

```powershell
node scripts/cloud/restore-cloud.mjs --file "..." --confirm-host <host> --apply
```

`--confirm-host` has to match the host the connection string points at, typed back by hand. This is
not ceremony. The expensive mistake here is not restoring — it is restoring into the right-looking
wrong database, which destroys two shops instead of one, and a host typed by hand is the one check
a tired person cannot pass by accident.

**Take a backup of the target first.** A restore replaces every row of every table in the file. It
cannot be undone, and the only thing that can undo it is a copy of what was there a minute ago.

## What it refuses

- **A file it cannot vouch for.** Same check as `--verify`. A backup with no closing summary stopped
  halfway, and half a shop restored over a whole one is worse than no restore at all.
- **A schema that does not fit.** The backup carries data, not table definitions. A missing table or
  column is named and the command stops, rather than restoring what happens to fit and leaving the
  rest silently absent. Run `node scripts/run-cloud-migrations.js --apply` first.
- **Half a job.** The whole restore is one transaction. If anything fails, nothing changed.
- **Emptying a table the backup does not carry.** If a table outside the backup points at one
  inside it, the restore stops and names it with its row count. This normally means the backup
  predates a migration that added the table. Either restore into a database that matches the
  backup, or say yes by name:

  ```powershell
  node scripts/cloud/restore-cloud.mjs --file "..." --confirm-host <host> --and-empty loyalty_points --apply
  ```

  A table named that way is emptied and *not* refilled, because the backup has nothing to put in
  it. The command says so before it runs and again after.

## What it does that is easy to forget

- **Inserts children after parents.** `sale_items` before `sales` fails on the foreign key, and the
  file lists tables alphabetically, which is not an insert order. The order is computed from the
  real foreign keys every time.
- **Resets the id counters.** After restoring rows with their original ids, every `SERIAL` is behind
  and the next bill collides on the primary key. This is the step whose absence shows up at the
  counter rather than in the restore.
- **Leaves tables the backup does not contain exactly as they are**, and says which ones had rows.
  Emptying a table nobody asked about is not this command's decision to make. This was once only
  half true: the truncate used `CASCADE`, which emptied any table pointing into the backup on the
  same run that printed this promise about it. The truncate now names its tables and the rest is
  refused, per `--and-empty` above.

## Proven, not assumed

On 2026-09-18 the round trip was run against a real PostgreSQL: a shop with foreign keys, `SERIAL`
ids, `NUMERIC` rates, `JSONB`, `NULL`s, an embedded newline, a `DATE`, and a table named `order`.
Backed up, truncated with `RESTART IDENTITY`, restored — every row came back identical, and the
next `INSERT` got id 4 instead of colliding on 1. Restoring a second time over a database that had
since gained rows produced the same identical result.

On the same day, against the same kind of scratch database, the `CASCADE` bug above was reproduced
and then confirmed fixed: a `loyalty_points` table added after the backup was taken went from 2
rows to 0 without a word, and now stops the command by name until `--and-empty` says otherwise.
