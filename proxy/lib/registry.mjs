// Self-serve user registry over the Blob store (lib/store.mjs). All
// self-registered accounts live in ONE JSON file:
//
//   users/_system/registry.json
//   {
//     users: { "<lowercased email>": { codeHash: "<sha256 hex of accessCode>", createdAt: "<ISO>", invite: "<lowercased invite code used>" } },
//     updatedAt: "<ISO>"
//   }
//
// `invite` records which operator-issued invite code (INVITE_CODES env, see
// lib/oauth.mjs) the signup used, so cohorts are attributable per code.
//
// "_system" is a reserved userId: it fits store.mjs's USER_ID_RE charset
// guard (underscore is allowed) but can never collide with a real sub —
// OAuth subs are lowercased emails (always contain "@") and Apple subs are
// dotted numeric ids. Keys are built raw (never percent-encoded) exactly like
// user namespaces, so list/get/delete lookups always match.
//
// Access codes are stored only as sha256 hex of the NORMALIZED code
// (trimmed + lowercased — the same folding lib/oauth.mjs applies at sign-in,
// so mobile auto-capitalization can't lock a user out). Never plaintext.
//
// Concurrency note: createUser does a read-modify-write of the single
// registry blob. Two simultaneous signups on different serverless instances
// could lose one write; at this product's signup rate that's acceptable, and
// the loser simply signs up again.

import { createHash } from "node:crypto";
import { getFile, putFile } from "./store.mjs";

export const SYSTEM_USER_ID = "_system";
export const REGISTRY_NAME = "registry.json";

// Blob reads are slow (list + authenticated fetch, plus up to 60s edge cache),
// so keep the parsed registry in module scope for a short TTL. The cache is
// per-instance best-effort: a signup on another instance shows up here after
// at most TTL + edge-cache staleness. createUser updates the cache with the
// exact document it wrote, which is what makes same-instance
// signup → immediate sign-in / duplicate-check deterministic.
const CACHE_TTL_MS = 30_000;
let cache = null; // { registry, fetchedAt }

export function sha256Hex(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

// Same folding as the sign-in form: trim (mobile paste adds whitespace) and
// lowercase (keyboards auto-capitalize). Applied before hashing AND before
// comparing, so both sides always agree.
export function normalizeCode(code) {
  return String(code || "").trim().toLowerCase();
}

// Env-provisioned users, DRILL_USERS="email:accessCode,email2:code2"
// (moved here from lib/oauth.mjs so both the credential check and the
// duplicate-email check share one parser without a circular import).
export function envUsers() {
  const map = new Map();
  for (const pair of (process.env.DRILL_USERS || "").split(",")) {
    const idx = pair.indexOf(":");
    if (idx <= 0) continue;
    const email = pair.slice(0, idx).trim().toLowerCase();
    const code = pair.slice(idx + 1).trim();
    if (email && code) map.set(email, code);
  }
  return map;
}

function emptyRegistry() {
  return { users: {}, updatedAt: null };
}

async function loadRegistry() {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.registry;
  let registry = emptyRegistry();
  const file = await getFile(SYSTEM_USER_ID, REGISTRY_NAME);
  if (file) {
    try {
      const parsed = JSON.parse(file.body.toString("utf8"));
      if (parsed && typeof parsed === "object" && parsed.users && typeof parsed.users === "object") registry = parsed;
    } catch {
      // Corrupt registry blob: treat as empty rather than brick sign-ins.
    }
  }
  cache = { registry, fetchedAt: Date.now() };
  return registry;
}

async function saveRegistry(registry) {
  registry.updatedAt = new Date().toISOString();
  await putFile(SYSTEM_USER_ID, REGISTRY_NAME, Buffer.from(JSON.stringify(registry)), "application/json");
  cache = { registry, fetchedAt: Date.now() };
}

// Returns { codeHash, createdAt, invite } for a self-registered account, or null.
export async function getUser(email) {
  const norm = normalizeEmail(email);
  if (!norm) return null;
  const registry = await loadRegistry();
  const entry = registry.users[norm];
  return entry && typeof entry === "object" ? entry : null;
}

// Creates a self-registered account. Rejects (error.code = "email_taken")
// when the email already exists in the registry OR is env-provisioned via
// DRILL_USERS. `invite` is the operator invite code the signup used — stored
// lowercased on the entry for per-code cohort attribution. The caller
// validates email format / code strength / invite validity; this only
// enforces uniqueness and does the hashing.
export async function createUser(email, accessCode, invite) {
  const norm = normalizeEmail(email);
  const taken = new Error(`account already exists: ${norm}`);
  taken.code = "email_taken";
  if (envUsers().has(norm)) throw taken;
  const registry = await loadRegistry();
  if (Object.prototype.hasOwnProperty.call(registry.users, norm)) throw taken;
  registry.users[norm] = {
    codeHash: sha256Hex(normalizeCode(accessCode)),
    createdAt: new Date().toISOString(),
    ...(invite ? { invite: String(invite).trim().toLowerCase() } : {}),
  };
  await saveRegistry(registry);
  return norm;
}
