#!/usr/bin/env node
/**
 * Print where a deployment stands: its branches, counters, machines and staff postings.
 *
 * Read-only. It runs SELECTs and nothing else, so it is safe to point at the live shop database.
 *
 * ## Why this exists
 *
 * Setting up counters is several steps across two places -- a command here, a screen there -- and
 * the state that decides what is possible next is spread over four tables. Reading that state out
 * of a hosting provider's table browser means scrolling a grid sideways past columns that do not
 * matter, one table at a time, and assembling the answer in your head. This assembles it instead.
 *
 * It also names the next step, because "no counters yet" and "counters exist but this machine is
 * posted to none of them" look identical in a table and mean different things.
 *
 * ## Usage
 *
 *   node scripts/show-setup.mjs
 *
 * With the same DATABASE_URL the backend uses, or DATABASE_PUBLIC_URL when connecting from outside.
 */
import { env, exit, stdout, argv } from "node:process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(new URL("../backend/package.json", import.meta.url));

const pad = (value, width) => String(value ?? "").padEnd(width);
const date = (value) => (value ? new Date(value).toISOString().slice(0, 10) : "—");

/** @param {{query: Function}} client */
export const collectSetup = async (client) => {
  // Sequential, not Promise.all: these share one client, and a single pg client cannot run two
  // queries at once -- it warns today and refuses in pg 9. There is nothing to gain from
  // parallelism against one connection anyway.
  const branches = await client.query("SELECT id, branch_name, company_id, active FROM branches ORDER BY id");
  const counters = await client.query(
      `SELECT id, company_id, branch_id, location_code, location_name, location_type, active
       FROM operational_locations ORDER BY branch_id, id`
  );
  const devices = await client.query(
      `SELECT d.device_id, d.device_name, d.status, d.approved_at, d.last_active_at,
              da.branch_id AS posted_branch_id, da.operational_location_id AS posted_counter_id,
              da.active AS posting_active
       FROM authorized_devices d
       LEFT JOIN device_assignments da ON da.device_id = d.device_id AND da.active = TRUE
       ORDER BY d.status, d.device_id`
  );
  const staff = await client.query(
      `SELECT s.user_id, u.username, s.branch_id, s.operational_location_id, s.is_default, s.active
       FROM staff_location_assignments s
       LEFT JOIN users u ON u.id = s.user_id
       WHERE s.active = TRUE
       ORDER BY s.user_id, s.operational_location_id`
  );
  return {
    branches: branches.rows,
    counters: counters.rows,
    devices: devices.rows,
    staff: staff.rows,
  };
};

/**
 * The one line worth reading if you read nothing else.
 *
 * Kept separate from the printing so it can be asserted on: "no counters" and "counters exist but
 * nothing is posted to them" are different situations that look the same in a table, and getting
 * that distinction wrong is what sends somebody to the wrong command.
 */
export const nextStep = ({ counters, devices }) => {
  const live = counters.filter((row) => row.active !== false);
  if (live.length === 0) {
    const approved = devices.filter((row) => String(row.status).toUpperCase() === "APPROVED");
    if (approved.length === 0) {
      return "No counters, and no approved machine to hold the first one. Approve a machine first, "
        + "then run scripts/bootstrap-first-counter.mjs.";
    }
    return "No counters yet. Run scripts/bootstrap-first-counter.mjs -- see docs/first-counter-setup.md.";
  }
  const posted = devices.filter((row) => row.posted_counter_id);
  if (posted.length === 0) {
    return "Counters exist, but no machine is posted to one. Post them from Branches & Counters in the app.";
  }
  return `Set up: ${live.length} counter(s), ${posted.length} machine(s) posted. `
    + "New counters and postings go through Branches & Counters in the app.";
};

const render = (setup) => {
  const counterName = new Map(setup.counters.map((row) => [Number(row.id), row.location_name]));
  const branchName = new Map(setup.branches.map((row) => [Number(row.id), row.branch_name]));
  const lines = [];

  lines.push("", "BRANCHES");
  if (!setup.branches.length) lines.push("  none");
  for (const row of setup.branches) {
    lines.push(`  ${pad(row.id, 4)}${pad(row.branch_name, 26)}company ${pad(row.company_id, 4)}`
      + `${row.active === false ? "closed" : "open"}`);
  }

  lines.push("", "COUNTERS");
  if (!setup.counters.length) lines.push("  none");
  for (const row of setup.counters) {
    lines.push(`  ${pad(row.id, 4)}${pad(row.location_name, 26)}${pad(row.location_type, 15)}`
      + `${pad(branchName.get(Number(row.branch_id)) || `branch ${row.branch_id}`, 20)}`
      + `${row.active === false ? "closed" : "open"}`);
  }

  lines.push("", `MACHINES (${setup.devices.length})`);
  lines.push(`  ${pad("status", 10)}${pad("device id", 30)}${pad("name", 24)}${pad("posted to", 24)}`
    + `${pad("approved", 12)}last seen`);
  for (const row of setup.devices) {
    const postedTo = row.posted_counter_id
      ? (counterName.get(Number(row.posted_counter_id)) || `counter ${row.posted_counter_id}`)
      : "— nowhere —";
    lines.push(`  ${pad(row.status, 10)}${pad(row.device_id, 30)}${pad(row.device_name, 24)}`
      + `${pad(postedTo, 24)}${pad(date(row.approved_at), 12)}${date(row.last_active_at)}`);
  }

  lines.push("", "PEOPLE POSTED TO COUNTERS");
  if (!setup.staff.length) lines.push("  none");
  for (const row of setup.staff) {
    lines.push(`  ${pad(row.username || `user ${row.user_id}`, 20)}`
      + `${pad(counterName.get(Number(row.operational_location_id)) || `counter ${row.operational_location_id}`, 26)}`
      + `${row.is_default ? "(their default)" : ""}`);
  }

  lines.push("", `NEXT: ${nextStep(setup)}`, "");
  return lines.join("\n");
};

const main = async () => {
  const connectionString = env.DATABASE_PUBLIC_URL || env.DATABASE_URL;
  if (!connectionString) {
    stdout.write("\nDATABASE_PUBLIC_URL or DATABASE_URL is not set.\n\n");
    exit(1);
  }
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    stdout.write(render(await collectSetup(client)));
  } finally {
    client.release();
    await pool.end();
  }
};

// Only when run as a command; importing this file must not open a database connection.
if (Boolean(argv[1]) && import.meta.url === pathToFileURL(argv[1]).href) {
  main().catch((error) => {
    stdout.write(`\nCould not read the setup: ${error.message}\n\n`);
    exit(1);
  });
}
