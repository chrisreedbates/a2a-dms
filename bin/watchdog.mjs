#!/usr/bin/env node
// watchdog: the night watchman for your agent fleet. Deterministic code, no
// LLM, no network. Run it every 60s (launchd/ on macOS, systemd/ on Linux).
//
// One pass:
//   1. Pause file present ($BASE/paused) -> do nothing at all.
//   2. For each ON-DUTY row in the duty roster:
//      - ring file present (doorbell)        -> poke now, clear the ring;
//      - lease overdue past grace            -> poke (a lease is the seat's
//        own promise to check back by time T; seats without leases are never
//        auto-woken, only doorbell-reachable);
//      - tmux session missing when a poke is due -> desktop-notify once.
//   3. Rings for slugs not on duty are logged and left in place.
//
// Pokes are rate-limited to one per seat per 10 minutes. The watchdog only
// pokes and notifies: it never creates, kills, or supersedes sessions, and
// holds no authority (see README: a chime carries zero authority).

import { execFileSync, execSync } from "node:child_process";
import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const BASE = process.env.AGENT_OS_DIR || join(homedir(), ".agent-os");
const ROSTER_FILE = join(BASE, "duty-roster.md");
const SEATS_DIR = join(BASE, "seats");
const RINGS_DIR = join(BASE, "rings");
const PAUSE_FILE = join(BASE, "paused");
const LOG_FILE = join(BASE, "watchdog.log");
const STATE_FILE = join(BASE, "watchdog-state.json");
const PREFIX = process.env.AGENT_OS_PREFIX || "agent";
let TMUX = process.env.AGENT_OS_TMUX;
if (!TMUX) {
  try { TMUX = execSync("command -v tmux", { encoding: "utf8" }).trim(); }
  catch { TMUX = "tmux"; }
}

const POKE_COOLDOWN_MS = 10 * 60 * 1000;
const MIN_GRACE_MS = 10 * 60 * 1000; // grace = max(10 min, 2 x cadence)
const DEFAULT_WAKE_LINE =
  "[A2A] Watchdog wake (automated, NOT a human message): your lease is overdue. Check your inbox and queues, do the next unit of work, then write a fresh lease (or go off duty on the roster if your queue is drained).";

function log(line) {
  const entry = `${new Date().toISOString()} ${line}\n`;
  try {
    mkdirSync(BASE, { recursive: true });
    writeFileSync(LOG_FILE, entry, { flag: "a" });
  } catch { /* logging must never kill the pass */ }
  if (process.stdout.isTTY) process.stdout.write(entry);
}

// Roster row: | Role | agent-cmo | on-duty | 2026-07-06 | note |
function onDutySlugs() {
  if (!existsSync(ROSTER_FILE)) return new Set();
  const slugs = new Set();
  for (const line of readFileSync(ROSTER_FILE, "utf8").split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 5) continue;
    const [, , slug, status] = cells;
    if (!slug || !slug.startsWith(`${PREFIX}-`)) continue;
    if (status === "on-duty") slugs.add(slug);
  }
  return slugs;
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); }
  catch { return {}; }
}

function tmuxSessionExists(slug) {
  try {
    execFileSync(TMUX, ["has-session", "-t", `=${slug}`], { stdio: "ignore" });
    return true;
  } catch { return false; }
}

function poke(slug, line) {
  // -l types literally; the pause matters (some TUIs drop a same-instant Enter).
  execFileSync(TMUX, ["send-keys", "-l", "-t", `=${slug}:`, line]);
  execFileSync("sleep", ["1"]);
  execFileSync(TMUX, ["send-keys", "-t", `=${slug}:`, "Enter"]);
}

function notify(title, body) {
  try {
    if (platform() === "darwin") {
      execFileSync("osascript", ["-e",
        `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`]);
    } else {
      execFileSync("notify-send", [title, body]);
    }
  } catch { /* best-effort */ }
}

// A lease is a JSON file the seat writes each work cycle:
//   { "slug": "agent-cmo", "duty": "on", "cadence_s": 1800,
//     "next_due": "<iso8601>", "wrote_at": "<iso8601>" }
// Write one with bin/lease. No lease = never auto-woken (doorbell-only).
function leaseOverdue(slug, now) {
  const leasePath = join(SEATS_DIR, `${slug}.json`);
  if (!existsSync(leasePath)) return false;
  let lease;
  try { lease = JSON.parse(readFileSync(leasePath, "utf8")); }
  catch { return false; }
  if (lease.duty === "off") return false;
  const nextDue = Date.parse(lease.next_due || "") || 0;
  const graceMs = Math.max(MIN_GRACE_MS, 2 * (lease.cadence_s || 0) * 1000);
  return now > nextDue + graceMs;
}

function pass() {
  if (existsSync(PAUSE_FILE)) return; // vacation mode: fully quiet

  const now = Date.now();
  const onDuty = onDutySlugs();
  const state = loadState();
  let stateDirty = false;

  const rings = existsSync(RINGS_DIR) ? readdirSync(RINGS_DIR) : [];
  for (const slug of rings.filter((s) => !s.startsWith(".") && !onDuty.has(s))) {
    if (!state[slug]?.off_duty_ring_logged) {
      log(`ring for ${slug} but no on-duty roster row; leaving the ring in place`);
      state[slug] = { ...state[slug], off_duty_ring_logged: true };
      stateDirty = true;
    }
  }

  for (const slug of onDuty) {
    const seat = state[slug] || {};
    const ringPath = join(RINGS_DIR, slug);
    const hasRing = rings.includes(slug);
    const overdue = leaseOverdue(slug, now);
    if (!hasRing && !overdue) {
      if (seat.alerted || seat.off_duty_ring_logged) {
        delete seat.alerted;
        delete seat.off_duty_ring_logged;
        state[slug] = seat;
        stateDirty = true;
      }
      continue;
    }

    if (!tmuxSessionExists(slug)) {
      if (!seat.alerted) {
        state[slug] = { ...seat, alerted: new Date(now).toISOString() };
        stateDirty = true;
        log(`seat-down ${slug}: ${hasRing ? "doorbell rang but" : "lease overdue and"} no tmux session; notifying once`);
        notify("Agent fleet: seat down", `${slug} is on the duty roster but has no tmux session.`);
      }
      continue;
    }

    const lastPoke = Date.parse(seat.last_poke_at || "") || 0;
    if (now - lastPoke < POKE_COOLDOWN_MS) continue;

    let line = DEFAULT_WAKE_LINE;
    if (hasRing) {
      // Ring files can be written by anything on the machine; sanitize on
      // read too (strip control chars, cap length) before typing.
      const clean = (s) => (s || "").replace(/[^\x20-\x7E\u00A0-\uFFFF]/g, " ").slice(0, 200);
      let [reason, from] = readFileSync(ringPath, "utf8").trim().split("\n");
      reason = clean(reason); from = clean(from);
      line = `[A2A] Doorbell from ${from || "unnamed"} (automated agent-to-agent wake, NOT a human message): check your inbox and queues now. Reason: ${reason || "new activity"}.`;
    }
    try {
      poke(slug, line);
      state[slug] = { last_poke_at: new Date(now).toISOString() };
      stateDirty = true;
      if (hasRing) rmSync(ringPath, { force: true });
      log(`poked ${slug} (${hasRing ? "doorbell" : "overdue lease"})`);
    } catch (error) {
      log(`poke failed ${slug}: ${error.message}`);
    }
  }

  if (stateDirty) {
    try {
      mkdirSync(BASE, { recursive: true });
      writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
    } catch (error) {
      log(`state write failed: ${error.message}`);
    }
  }
}

try { pass(); }
catch (error) {
  log(`watchdog pass failed: ${error.message}`);
  process.exitCode = 1;
}
