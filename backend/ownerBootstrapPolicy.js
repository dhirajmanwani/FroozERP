/**
 * A-6 Gate 3.3 — whether the first-owner bootstrap may be performed over HTTP.
 *
 * `POST /bootstrap/first-owner-device` is the first-install escape hatch. On a fresh database no
 * device is approved, so nobody can sign in and no token can exist, so the route authenticates
 * itself: it verifies the Owner's username and password and, on success, approves the calling
 * device. That is the sharpest thing on the public allow-list. Reachable from the internet it is a
 * password-guessing oracle against the single most valuable account in the system, and a correct
 * guess ends with the attacker's own device approved.
 *
 * A-5 gave it the same lockout as `/login`, which makes guessing slow. Slow is not closed.
 *
 * The rule below is therefore structural rather than configurable:
 *
 *   - On a hosted deployment the HTTP route is **never** available. No environment variable opens
 *     it. The A-5 work in this codebase already states the principle — a hole that closes only when
 *     a variable happens to be set is not closed — and the same reasoning applies to one that opens
 *     that way. A fresh hosted deployment uses the ops command instead, on the server, where
 *     shell access is already the trust boundary.
 *   - Anywhere else it is **closed by default** and opens only on an explicit, deliberately awkward
 *     opt-in. A desktop install is not internet-facing, so this is a convenience rather than an
 *     exposure, but it should still be a decision somebody made rather than the default.
 *
 * Nothing in the shipped app calls this route: the desktop first-owner path is the local
 * `.lic` activation flow (offline-activation-plan Stage 5), and no frontend, gateway or Rust
 * caller references it. Closing it by default therefore breaks no shipped path.
 */

/** The opt-in variable. Deliberately not a boolean: nobody sets this to 1 by accident. */
const HTTP_BOOTSTRAP_ENV = "FROOZERP_ALLOW_HTTP_OWNER_BOOTSTRAP";

/** The one value that opens it, chosen so that setting it is an admission rather than a toggle. */
const HTTP_BOOTSTRAP_OPT_IN = "i-accept-owner-password-guessing";

const OPS_COMMAND = "node scripts/bootstrap-first-owner.mjs";

const REFUSAL_CODES = Object.freeze({
  HOSTED: "OWNER_BOOTSTRAP_HTTP_DISABLED_HOSTED",
  NOT_ENABLED: "OWNER_BOOTSTRAP_HTTP_DISABLED",
});

/**
 * Decide whether this process may serve the bootstrap over HTTP.
 *
 * Pure: everything it reads is passed in, so the decision is testable without an environment.
 * Returns `{ allowed, code, message }`; `code` and `message` are null when allowed.
 */
const resolveOwnerBootstrapTransport = ({ env = {}, deploymentType = "local" } = {}) => {
  if (String(deploymentType).toLowerCase() === "cloud") {
    return {
      allowed: false,
      code: REFUSAL_CODES.HOSTED,
      message:
        "First owner bootstrap is not available over the network on a hosted deployment. Run" +
        ` \`${OPS_COMMAND}\` on the server instead.`,
    };
  }

  if (String(env[HTTP_BOOTSTRAP_ENV] || "").trim() !== HTTP_BOOTSTRAP_OPT_IN) {
    return {
      allowed: false,
      code: REFUSAL_CODES.NOT_ENABLED,
      message:
        "First owner bootstrap over HTTP is switched off. Run" +
        ` \`${OPS_COMMAND}\` on this machine, or set ${HTTP_BOOTSTRAP_ENV}` +
        ` to \`${HTTP_BOOTSTRAP_OPT_IN}\` if you intend to enable the route.`,
    };
  }

  return { allowed: true, code: null, message: null };
};

module.exports = {
  HTTP_BOOTSTRAP_ENV,
  HTTP_BOOTSTRAP_OPT_IN,
  OPS_COMMAND,
  REFUSAL_CODES,
  resolveOwnerBootstrapTransport,
};
