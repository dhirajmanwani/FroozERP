# FroozERP — Product Goals

**Status:** goals refined and recorded; sequencing recommended, not yet approved.
**Written:** 2026-08-18, from the maintainer's six stated goals.
**Companion to:** `docs/offline-activation-design.md` (device authorisation),
`docs/auth-hardening-plan.md` (the gate on remote access), `docs/backlog-1.0.72.md` (defects).

This file is the *what and why*. It does not schedule work and does not replace the stage plans;
where a goal is already covered by an existing plan, it says so rather than restating it.

Every "current state" claim below was verified against the source on 2026-08-18 and carries a file
reference. Several goals turned out to be substantially built already — that is the single most
useful thing in this document, because it changes what the work actually is.

---

## 0. The principle these goals are measured against

From `docs/offline-activation-design.md` §2.1 and §10, restated because five of the six goals below
touch the cloud:

> **Cloud enhances FroozERP; cloud failure must never stop FroozERP.**

Concretely, every feature below is classified as one of:

- **Critical path** — must work with no internet at all. Billing, local stock, local reports.
- **Enhancement** — may require connectivity, but its absence must produce a *named, non-blocking*
  state, never a blank panel, a silent zero, or a refusal to open a module.

A feature that is an enhancement is not thereby unimportant. It is only forbidden from taking the
shop down with it.

---

## 1. What already exists

| Area | Verified state | Evidence |
| --- | --- | --- |
| Multibranch | Built, but **entirely cloud-dependent**. Local scope tables exist and are unused by this UI. | `App.jsx:15087` (`/api/v3/admin/scope-management`), `:15108` (`/api/v3/admin/branches`), `:15293` `LegacySecurityDevicesSection`, `:15399` `LegacyBranchCounterSettings`; migrations `006`, `013` |
| WhatsApp | Single-document send **works** against the Meta Cloud API. No bulk, no scheduling, no templates. | `server.js:5925` (`/api/whatsapp/send-document`), `:5879` (`/settings/whatsapp/test`), `App.jsx:1431` (`phone_number_id`, `access_token`, `default_country_code`) |
| Email + OTP | Email verification **already built**; OTP hashing exists (HMAC-SHA256). SMTP is configuration-gated. | `server.js:6649` send-verification, `:6701` verify, `:644` `hashOtp`, `:634` `recoveryOtpSecret`, `:852-865` SMTP readiness |
| SMS | **Does not exist.** No provider integration anywhere in the tree. | absence of any Twilio/MSG91/provider reference in `backend/` |
| FROST AI | **2,741 lines** already written; multi-provider; voice groundwork present; authorisation tested. | `frostCore.js` (430), `aiBusinessAssistantService.js` (2189), `aiBusinessAssistantSchema.js` (122); `server.js:26` `registerAiBusinessAssistantRoutes`; `App.jsx:3843` `/api/ai/frost/status`; `frostCore.js:19,26,33` providers, `:53` `gpt-realtime`, `:54` voice, `:61` VAD |
| Mobile | Greenfield. No Android/iOS project generated. | `src-tauri/gen/` contains only `schemas` |
| Branding | Asset-driven already; changing it is asset + token work. | `App.jsx:1447` `BrandLogo`, `public/branding/frooz-*.png` |

**Not verified, and worth checking before G4 is scoped:** how deeply `aiBusinessAssistantService.js`
is wired to real business queries versus scaffolding. Its size suggests substance, but "it exists"
and "it answers correctly from the database" are different claims and only the first was confirmed.

---

## 2. Three findings that shape everything below

### 2.1 Mobile has an architectural blocker, not merely work

The local backend is a **Node.js sidecar process** (`froozerp-backend-node.exe`). iOS will not run
it; Android will not run it in any way worth shipping. So mobile is not a port of the desktop app —
it is a decision about *which architecture mobile gets*, and that decision has to come first.

This matters most for the stated use case: a purchase manager entering purchases at the mandi. If he
has no signal, a thin cloud client is useless to him — which is precisely the failure mode this
whole product philosophy exists to prevent. See **[P-1]**.

### 2.2 Four goals share one prerequisite

Multibranch, WhatsApp-to-customers, OTP, FROST and mobile all require the cloud. The cloud cannot
safely be exposed to the public internet in its current state: `/login` issues no session token, the
frontend sends `x-user-id` and the backend believes it, most routes have no auth middleware, and
passwords are unsalted SHA-256 with a plaintext-equality fallback (`CLAUDE.md`, "Known security
debt").

**Auth hardening is therefore not a seventh goal competing with these six. It is the tollgate in
front of four of them.** `docs/auth-hardening-plan.md` already scopes it.

### 2.3 FROST's hard problem is truthfulness, not capability

The model is the easy part and is largely present. The difficult requirement is that an ERP
assistant must never state a number it invented. A confident wrong figure about receivables or stock
is worse than no assistant, because it will be believed and acted on.

This is the same rule `CLAUDE.md` already states for the UI — "errors must never render as zero" —
applied to generated text. It becomes design rule **G4-R1** below.

---

## 3. The goals

### G1 — Multibranch as a first-class module

**Statement.** Branch, counter and device management becomes its own module rather than a Settings
subsection, works offline for everything that can be known locally, and is simplified to a single
clear hierarchy: **Branch → Counters → Devices**.

**Current state.** Functionally present but cloud-only, which is why it renders "Unable to load
branch and device assignments" with no connectivity. The components carry `Legacy` in their names.

**In scope.** Move out of Settings into a module. Offline read of the device's own scope from
`local_device_assignment` and the entitlement's `company_id`/`branch_id`. Cloud-authoritative
actions (creating a branch, cross-branch views) remain online-only but fail as *named* states.
Simplify the hierarchy.

**Out of scope.** Cross-branch consolidated reporting (that is a cloud reporting feature, not a
management screen).

**Classification.** Viewing own scope: critical path. Managing other branches: enhancement.

**Depends on.** Auth hardening; cloud restored. Partly on offline-activation Stage 8, which reworks
`canonical_snapshot_scope()` into the four-rung non-fatal resolution that this module wants to read.

**[P-2]** Does "refine into a simple version" mean reducing the *data model* (fewer concepts than
branch/counter/operational-location/device), or only the *screens*? These have very different costs;
the data model already ships in migrations and the cloud schema.

---

### G2 — WhatsApp broadcast and owner reporting

**Statement.** Send bills to many customers, and deliver scheduled reports to the owner, over
WhatsApp.

**Current state.** Single-document send works. Everything about *many* is missing: queue, retry,
scheduling, opt-out, delivery status, templates.

**In scope.** A send queue with retry and delivery status; message templates; scheduled owner
reports; per-customer opt-out; rate limiting.

**The real constraint — read before estimating.** The engineering here is smaller than the
compliance setup. Meta's WhatsApp Cloud API requires **pre-approved message templates** for any
business-initiated message, enforces a **24-hour customer service window** outside which only
templates may be sent, and **charges per conversation**. A bulk sender that ignores these gets the
number rate-limited or banned. Template approval is a lead-time item and should start early.

**Classification.** Enhancement. Bills must always be printable and saveable locally regardless of
WhatsApp.

**Depends on.** Cloud restored (scheduling needs a server that is awake); approved templates.

**[P-3]** Customer consent: is opt-in recorded per customer, and where? Sending transactional bills
to a customer who never asked is both a policy risk and a business one.

---

### G3 — OTP for employee registration and password recovery

**Statement.** Registering an employee requires an OTP; a staff member who forgets their password
can recover it via OTP to phone **and** email.

**Current state.** Email verification endpoints and OTP hashing already exist. SMS does not exist at
all — this is the only goal on the list with a genuinely absent foundation.

**In scope.** SMS provider integration; OTP issuance/verification with expiry, attempt limits and
lockout; wiring into employee registration and password reset.

**Where it belongs.** **Inside the auth-hardening track, not beside it.** Password reset *is*
authentication. Building an OTP reset path on top of the current model — where `x-user-id` is
trusted and `locked_until` exists but is never enforced — would put a new front door on a house with
no locks.

**Classification.** Enhancement (registration and recovery are not billing), but with a hard
requirement: an OTP failure must never lock an already-authenticated cashier out of billing.

**Depends on.** Auth hardening; an SMS provider account.

**[P-4]** SMS provider: MSG91 (India-focused, cheaper, DLT-registered sender IDs required in India)
versus Twilio (global, simpler API, costlier). India DLT registration is a lead-time item like the
WhatsApp templates.

---

### G4 — FROST as the owner's operating surface

**Statement.** FROST becomes the primary way the owner interrogates the business, by text and by
voice: "how is Jaipur doing", "what's today's update", "which fruits sell best", "who owes me money",
"what do you recommend".

**Current state.** Substantially built — multi-provider, routed, authorisation-tested, with realtime
voice groundwork already in place. This goal is mostly *wiring, data access and scope*, not
construction.

**G4-R1 — the non-negotiable design rule.** *Every figure FROST states comes from a deterministic
query. The model phrases; the database answers.* No financial or stock number may originate in
generated text. Where FROST cannot obtain a figure, it says so — it does not estimate. This is
`CLAUDE.md`'s "errors must never render as zero" applied to language.

**In scope.** Owner-only conversational and voice access to: branch performance, daily summary, top
sellers, receivables and payment reminders, and recommendations derived from real aggregates.

**Out of scope for now.** FROST performing *write* actions (creating bills, editing stock). An
assistant that can act is a different risk class and should be a separate, later decision.

**Classification.** Enhancement — with the caveat that if FROST becomes the primary interface, its
absence offline must degrade to the ordinary modules, never to a dead end.

**Depends on.** Cloud restored; an LLM provider key; a spend cap.

**[P-5]** Cost control: per-query cost is real and unbounded by default. A monthly cap, and a
decision about what happens when it is hit (degrade to deterministic reports, or stop), is required
before this is switched on for daily use.

**[P-6]** Which provider is authoritative for voice — `frostCore.js:316` currently notes realtime
voice is prepared for OpenAI-compatible providers only.

---

### G5 — Android and iOS

**Statement.** FroozERP is usable on tablet and phone; specifically, the purchase manager can enter
mandi purchases without carrying a laptop.

**Current state.** Nothing generated. Tauri 2 supports mobile targets, so the shell is available —
but see §2.1: the Node sidecar cannot come along.

**[P-1] — the decision that must precede any mobile work.**

- **(a) Cloud client.** Thin app, talks to the cloud API, requires connectivity. Ships fastest.
  Fails exactly where the stated use case lives: a mandi with no signal.
- **(b) Offline-capable.** Local storage and business logic on the device, syncing through the
  existing outbox. Serves the real use case. Requires replacing the Node sidecar for mobile — the
  largest single piece of work on this entire list.

**Recommendation.** Start with **(a), scoped narrowly to purchase entry and viewing**, and treat it
as a way to learn the real workflow cheaply — what the purchase manager actually needs on a phone,
how much of it truly happens without signal — before committing to (b). Deliberately *not* a
recommendation to stop at (a): the honest reading of the use case is that (b) is where it ends up.

**Classification.** Depends entirely on P-1.

**Depends on.** Auth hardening (a mobile client is a remote client by definition); cloud restored.

---

### G6 — Brand theming

**Statement.** Application theme, logo and the FROST icon reflect the brand.

**Current state.** Already asset-driven; `BrandLogo` resolves from `public/branding/`.

**In scope.** Replace branding assets, define brand colours as CSS tokens rather than scattered
literals, update the FROST icon, update the app/installer icon.

**Classification.** Neither — no runtime dependency at all.

**Depends on.** Nothing. **This is the only goal on the list with no prerequisites**, which makes it
a genuine quick win available at any time.

---

## 4. Suggested sequence

```
Auth hardening ──▶ Cloud restored ──▶ G1 ──▶ G3 ──▶ G2 ──▶ G4 ──▶ G5
      (gate)          (gate)
G6 ── available at any point, depends on nothing
```

Rationale: the first two are not goals anyone wants; they are the tollgate standing in front of four
that are. G1 first among the real goals because it is the most defensive (it repairs a screen that
currently fails blank) and because Stage 8 of the activation plan already moves toward it. G3 next
because it lands inside the auth work rather than after it. G2 before G4 because its lead-time items
(template approval) should start early. G5 last because it is the largest and because P-1 should be
answered with real usage evidence rather than in the abstract.

---

## 5. Open decisions

| # | Decision | Owner | Blocking |
| --- | --- | --- | --- |
| **P-1** | Mobile architecture: cloud client (a) or offline-capable (b) | Maintainer | All of G5 |
| **P-2** | Does "simplify multibranch" mean the data model or only the screens | Maintainer | G1 scope |
| **P-3** | Where customer WhatsApp consent/opt-in is recorded | Maintainer | G2 |
| **P-4** | SMS provider: MSG91 vs Twilio (note India DLT lead time) | Maintainer | G3 |
| **P-5** | FROST monthly spend cap, and behaviour when it is reached | Maintainer | G4 switch-on |
| **P-6** | Authoritative voice provider for FROST realtime | Maintainer | G4 voice |

None of these are blocked on engineering investigation; each is a business or product judgement.

---

## 6. Boundaries observed

No production or Railway contact was made in producing this document. Nothing under `release/`,
updater metadata, or `F:\FroozERP_recovery_backups\` was read or altered. No business data was
touched. This document is the deliverable; no code was changed.
