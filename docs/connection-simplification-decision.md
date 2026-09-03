# One connection, no choices

**Ruled by the maintainer, 2026-09-02**, in his own words:

> *"usme itne saare mode options he, jisse mera koi lena dena hi nhi he... mujhe khud switch krne ki
> zrurt hi nhi pdhni chahiye, na hi koi option select krne ki. net nhi he to local me chale, net aa
> jaye to apne aap cloud se sync hojaye. as simple as that."*

He is right, and this is not a preference. It is a defect report.

---

## What was there

Four things decided one behaviour:

| Setting | Values |
| --- | --- |
| **App Mode** | Local Single Device · Branch LAN Server · Branch LAN Client · Cloud Production · Custom |
| **Connectivity Mode** | Auto · Local Only |
| **Cloud API URL** | free text |
| **Policy file on disk** | `allowInternetAccess`, failing closed when absent |

All four had to agree before a shop could sync, and no screen said which one was in charge. A
shopkeeper was being asked to choose between "Branch LAN Server" and "Cloud Production" — words
that describe how the software is wired, not anything he has an opinion about.

**It cost an afternoon on 2026-09-02.** A rehearsal profile came up unable to save a setting. The
reason was spread across a mode nobody had chosen, a URL nobody had filled, and a policy file that
did not exist. Three separate wrong diagnoses were given before the real one, because each layer
hid the next.

---

## What it is now

**Use the cloud when it answers. Use this computer when it does not. Catch up by itself.**

No modes. No connectivity picker. No URL field — the cloud address is part of the build, exactly as
`DEFAULT_CLOUD_API_URL` in `backend/desktopGateway.js` always was.

The only thing left on screen is a sentence saying what is happening, and it is written in terms of
the shop's stakes rather than the software's state:

| Instead of | It says |
| --- | --- |
| Cloud Production · Connectivity Auto · policy allowInternetAccess=true | *(nothing — everything is fine)* |
| Local Only mode selected — cloud sync paused | **Working offline.** Billing works normally. 3 bills saved on this computer, and they will send by themselves when the internet is back. |
| Sync queue: 3 pending | **Catching up.** 3 bills still to send. Nothing to do — it is sending them now. |

`frontend/src/local/connectionStatus.js` decides this, and its tests assert the wording as well as
the logic — because the failure here was never that the software did the wrong thing.

**A connected, up-to-date app shows nothing at all.** A permanent green tick is read for a week and
ignored forever after, and then it is worthless on the day it turns red.

---

## What survives, and what was weakened

**The LOCAL_ONLY kill switch stays in the engine, unchanged.** When it is on, `CLAUDE.md`'s
guarantees still hold exactly as tested: blocked, nothing reaching the cloud, no cloud-router calls,
no external connections. What changed is that it is no longer a setting a shopkeeper can reach.
Asked directly whether any machine of his needs to be kept off the cloud on purpose, he said no.

**Called out loudly, as `CLAUDE.md` requires:** the policy file used to **fail closed** — a device
that had never been told it may use the internet did not. That default is why a fresh profile sits
there silently unable to sync, which is what happened during the rehearsal.

For a product whose entire design is *cloud with local fallback*, a device that cannot reach the
cloud is not safe, it is broken. So the kill switch becomes an **explicit action** rather than a
**default state**. This is a deliberate weakening of a fail-closed default, and it is recorded here
so nobody has to reconstruct why.

**The LAN modes are removed.** Asked how his machines connect to each other, the maintainer had
never considered it, which is itself the answer: nothing in his shop depends on one computer serving
others over Wi-Fi. They can be restored from history if that ever changes.

---

## What actually shipped

Recorded after the fact, because the plan above turned out to be missing the largest piece.

### The cloud address was never given to anything

While removing the pickers, the reason the shop app could never sync turned out not to be a
setting at all. `src-tauri/src/lib.rs` launched `desktopGateway.js` **with no cloud address**, so
the gateway had no cloud target and refused every cloud route as `CLOUD_NOT_CONFIGURED`. The
frontend's own `CLOUD_API_URL` came from a text box nobody had filled in. Both halves were empty,
and an app with no cloud address behaves exactly like an app with no internet — which is why the
diagnosis took three wrong turns before reaching it.

The address is now a **build-time fact on both sides**, with the same two rules in each:

1. an explicit `FROOZERP_CLOUD_API_URL` / `CLOUD_API_URL` (Rust) or saved / `VITE_` value
   (frontend) always wins, so a rehearsal can point somewhere safe;
2. otherwise a **release** build gets the production address and a **development** build gets
   nothing — `npm run app:disposable` opens a copy of live business data, and a rehearsal that
   quietly synced that copy into production would be worse than anything it was rehearsing for.

`frontend/src/local/cloudAddress.test.mjs` fails if the two sides ever name different clouds. That
drift would not error; it would split one shop's bills across two databases.

**Stated plainly:** an installed FroozERP now contacts that address by itself whenever it can reach
it. That is the product working as designed, and it is what was asked for.

### Cloud health was never checked on the shop's own machine

`buildConnectionStatusModel` computed `cloudReachable` with `usesCloudBackend()` in the conjunction.
An installed desktop runs as `LOCAL_SINGLE_DEVICE`, which that predicate excludes — true of where
its *business data* comes from, false of whether it *has a cloud*. So the probe never ran and the
panel reported "Cloud Not Configured" on a machine whose cloud was fine. The test is now whether
there is a cloud, whether it answers, and whether anybody deliberately held this machine off it.

The Local Only half of that guard is untouched, and `startupConnectivityPolicy.test.mjs` pins it.

### What was removed from `App.jsx`

The App Mode dropdown and its nine options; the AUTO / LOCAL ONLY pair; the Branch Server, Cloud API
and Custom API URL boxes; the six mode explanation notes; the "Save Mode" button and `saveApiConfig`;
the eight-field `configDraft`. The banner that said "Local Only mode selected — cloud sync paused"
now says what the app is actually doing, from `local/connectionStatus.js`, and carries one button —
"Reconnect this computer" — shown only when somebody has deliberately held the machine off.

The addresses themselves are still shown, as disabled rows in Advanced Diagnostics. Removing the
*questions* was the point; removing the *answers* would have replaced one silent failure with
another.

`frontend/src/local/connectionSettings.test.mjs` fails if any of it comes back. Every one of those
controls was added by somebody solving a real problem, and each is a natural thing to add again the
next time a machine will not sync.

### Still not verified

Whether bills actually flow to the cloud end to end on the real machine. That needs the shop's
laptop and a reachable Railway, neither of which is available here, and the boundary in `CLAUDE.md`
forbids contacting production from this work. Everything above is verified by the gates only.
