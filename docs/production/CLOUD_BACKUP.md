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

## What this does not do yet

**It does not restore.** Putting data back into a live shop is a different and far more dangerous
command, and it is the next piece of work. Until it exists, these files are a copy you can read,
verify and hand to somebody — say that, and do not say more.
