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
