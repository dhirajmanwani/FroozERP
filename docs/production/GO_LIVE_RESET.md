# Go-Live Reset: Clear The Test Data, Keep The Masters

Do this once, on the day before the shop goes live. It empties the test sales, purchases, stock,
payments, returns, waste, orders, expenses, transfers and packing transactions from the cloud,
and keeps products, categories, prices, suppliers, customers (with opening balances), staff,
branches, counters, devices, licences, settings, discounts, combos and PEP Pack masters.

The full keep/clear list, table by table, is `scripts/cloud/goLiveResetPlan.mjs`. The dry run
prints it against the real database before anything changes.

Do the steps **in this order**. Steps 1 to 3 are done while everything still works.

## 1. Save every device's licence (laptop still running)

Wiping a computer's local data (step 7) also removes its activation, so each device will ask for
its licence again. Its device id does not change, so **the same licence file works** — get them
now, while the laptop is signed in.

1. Open **Branches & Counters → Step 5 · Activation licences**.
2. For each computer and phone: **Get File Again** → **Save Activation File** (or **Copy File
   Text** and send it to yourself on WhatsApp). Label each one with the device name.
3. Write down each device's **Device ID** (Step 4 · Computers & phones).
4. If a device has **no licence in the list** (it was approved before licences existed), issue
   one now with **Issue Activation Licence** and save it. If issuing says the signing key is not
   available, **stop here** and tell the maintainer: that device could not be activated again.

## 2. Make sure nothing is waiting to sync

On every counter, the sync status must show **0 pending** (and no failed operations). A product,
price or customer edited on a counter and not yet synced is lost in step 7.

## 3. Take a cloud backup

From the laptop, in the FroozERP folder, in PowerShell:

```powershell
Remove-Item Env:DATABASE_PUBLIC_URL -ErrorAction SilentlyContinue
$env:DATABASE_URL = "<the cloud database connection string>"
node scripts/cloud/backup-cloud.mjs --out "D:\FroozERP-Backups"
```

The last line must say `RESULT: complete and readable`. If it says anything else, stop. (See
`CLOUD_BACKUP.md`.) The reset reads **only** `DATABASE_URL`, and refuses to run if
`DATABASE_PUBLIC_URL` is also set to something different — that is why the first line clears it.

## 4. Switch off every counter, phone and the laptop app

Close FroozERP on **every** Windows computer (including this laptop) and every phone. On Windows,
this must print nothing:

```powershell
Get-Process *froozerp* -ErrorAction SilentlyContinue
```

**Why:** a counter that is running keeps its test bills and test stock in its own database and
syncs them. If one syncs during or after the reset, it pushes test bills back into the clean
cloud, and it keeps selling from test lots the cloud no longer has. Nothing may run between
step 5 and step 7.

## 5. Dry run

```powershell
node scripts/cloud/go-live-reset.mjs
```

Check, at the top, that **DATABASE** and **HOST** are the shop's cloud database. Then read:

- **KEEP** — must include `products`, `customers`, `suppliers`, `users`, `branches`, `counters`.
- **CLEAR** — the test transactions and their row counts.
- **OWNER-DECIDES** — logs and FROST memory. All kept unless you name them (below).
- **sync_change_log** — the transaction rows it will delete; product/price rows stay.

The last line must be `go-live reset dry run: nothing changed`. If it says **--apply WOULD BE
REFUSED**, stop and send the output to the maintainer — a table nobody has classified exists.

Optional: to also empty some OWNER-DECIDES tables, add `--also-clear` with their names, for
example `--also-clear auth_audit_log,product_audit_trail:lot-events`.
(`product_audit_trail:lot-events` removes only the test lot events from the stock audit list and
keeps product edit history.)

## 6. Apply

Use the database name the dry run printed after **DATABASE**:

```powershell
node scripts/cloud/go-live-reset.mjs --apply --confirm <database-name>
```

It is one transaction: all of it happens, or none of it. The last line must be
`go-live reset committed`. Bill numbers carry on from where the test bills stopped (they do not
restart at 1), so no new bill can reuse a test bill's number.

## 7. On each Windows computer: set aside the local database

On **each** computer, with FroozERP closed (step 4), in PowerShell:

```powershell
$dir = Join-Path $env:APPDATA "com.srtcompany.froozerp"
foreach ($name in "froozerp-local.sqlite3", "froozerp-local.sqlite3-wal", "froozerp-local.sqlite3-shm") {
  $file = Join-Path $dir $name
  if (Test-Path $file) { Rename-Item $file "$name.before-go-live" }
}
```

That folder is `C:\Users\<Windows user>\AppData\Roaming\com.srtcompany.froozerp`. If more than one
Windows user has used FroozERP on that computer, do this signed in as each of them.

**Rename only these three files. Do not delete the folder.** The folder also holds the app's
other settings and logs. The device id is safe either way — it is kept outside this folder in
`C:\ProgramData\FroozERP\device-anchor.json`, which the app reads back when its database is new.
Do not touch that file.

**Why the wipe is needed:** the cloud reset does not tell devices that the test data is gone (the
cleared rows were never published as deletions). A device that keeps its old database keeps
showing test stock and test bills, and pushes any test operation still in its outbox into the
clean cloud.

## 8. On each phone (Android)

**Settings → Apps → FroozERP → Storage → Clear storage.** The phone keeps the same device id (it is
derived from the phone itself), and asks for its licence again like a computer.

## 9. Start, activate, sign in

On each device, one at a time:

1. Start FroozERP. It shows **Device Activation Required**.
2. Check the **Device ID** matches the one you wrote down in step 1. (If it does not, approve it
   in Step 4 as a new device and issue it a licence.)
3. Paste that device's licence text (or choose its saved file) → **Activate** → sign in.
4. Let it finish its first sync. Products, prices and customers come back from the cloud; stock
   and bills are empty.

## 10. Enter the real opening position

- **Opening stock:** enter today's stock through **Purchase Entry** (supplier, quantity, cost),
  one entry per lot.
- **Opening balances:** open each customer and supplier in **Accounts**, check **Opening Balance**,
  and correct it to today's real figure. Balances are worked out from the opening balance plus
  transactions, so after the reset every balance equals its opening balance.
- **Packing (PEP Pack):** packing stock is zero. Record what is on the shelf as a packing stock
  adjustment; a packing purchase would also book an expense.
- Check **selling rates** in Product Master. They were kept as the last rate set during testing.

The renamed `*.before-go-live` files can be deleted once the shop has run normally for a week.
