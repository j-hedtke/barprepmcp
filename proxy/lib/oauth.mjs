// OAuth 2.1 authorization server + resource protection for the remote MCP drill
// server (per the MCP authorization spec). Zero-dependency and STATELESS: every
// artifact — client_id, authorization code, access/refresh token — is a
// self-validating HMAC-SHA256 compact blob `base64url(JSON payload).base64url(sig)`
// keyed by the AUTH_SECRET env var (same primitive as lib/auth.mjs). No DB.
//
// Endpoints (wired in index.mjs):
//   GET  /.well-known/oauth-protected-resource   RFC 9728 resource metadata
//   GET  /.well-known/oauth-authorization-server RFC 8414 AS metadata
//   POST /oauth/register                          RFC 7591 dynamic client registration
//   GET  /oauth/authorize                         sign-in + consent page (HTML)
//   POST /oauth/authorize                         credential check → 302 with code
//   POST /oauth/token                             code/refresh_token → tokens
//
// Users come from two places, checked in order:
//   1. the DRILL_USERS env var: "email:accessCode,email2:code2" (admin-provisioned,
//      plain codes compared timing-safe), and
//   2. the self-signup registry (lib/registry.mjs, Blob-backed) created via the
//      "Create account" tab on the sign-in page — codes stored as sha256 hashes.
//      Signup is gated by operator-issued invite codes (INVITE_CODES env,
//      comma-separated; unset → registration closed). UI copy calls the access
//      code a "password"; the wire/storage names (access_code, codeHash) are
//      unchanged.
// Emails are case-insensitive. The token `sub` is the lowercased email, which
// becomes the per-user Blob namespace users/<sub>/.
//
// PKCE (S256) is mandatory; token_endpoint_auth_method is "none" (public clients);
// CSRF is covered by the OAuth state param + PKCE — no cookies or sessions.

import { createHmac, createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { getUser, createUser, envUsers, sha256Hex, normalizeCode } from "./registry.mjs";

const ACCESS_TOKEN_TTL_S = 30 * 24 * 3600; // 30 days
const REFRESH_TOKEN_TTL_S = 90 * 24 * 3600; // 90 days
const AUTH_CODE_TTL_S = 300; // 5 minutes
const SCOPE = "drill";

// ---------------------------------------------------------------------------
// Compact HMAC blobs (same format as lib/auth.mjs access tokens)
// ---------------------------------------------------------------------------

function secret() {
  const s = process.env.AUTH_SECRET;
  if (!s) {
    const e = new Error("AUTH_SECRET not set");
    e.code = "server_misconfigured";
    throw e;
  }
  return s;
}

function b64urlJSON(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signSegment(payloadB64) {
  return createHmac("sha256", secret()).update(payloadB64).digest("base64url");
}

function pack(payload) {
  const p = b64urlJSON(payload);
  return `${p}.${signSegment(p)}`;
}

// Verifies the HMAC and decodes the payload. Returns the payload or null.
function unpack(blob) {
  if (typeof blob !== "string") return null;
  const parts = blob.split(".");
  if (parts.length !== 2) return null;
  let expected;
  try {
    expected = createHmac("sha256", secret()).update(parts[0]).digest();
  } catch {
    return null; // AUTH_SECRET unset — treat as invalid rather than crash verifiers
  }
  const got = Buffer.from(parts[1], "base64url");
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  try {
    return JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function nowS() {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// Result helpers ({status, contentType, body, headers?} like lib/core.mjs)
// ---------------------------------------------------------------------------

function json(status, obj, headers) {
  return { status, contentType: "application/json", body: JSON.stringify(obj), ...(headers ? { headers } : {}) };
}
function html(status, body) {
  return { status, contentType: "text/html; charset=utf-8", body };
}
function oauthError(status, error, description) {
  return json(status, { error, ...(description ? { error_description: description } : {}) });
}

// ---------------------------------------------------------------------------
// Discovery documents
// ---------------------------------------------------------------------------

export function protectedResourceMetadata(origin) {
  return json(200, {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: [SCOPE],
  });
}

export function authorizationServerMetadata(origin) {
  return json(200, {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
  });
}

// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591) — zero storage. The client_id is
// base64url(JSON {redirect_uris, iat}).sig, so /authorize and /token can verify
// the registered redirect_uris without a database.
// ---------------------------------------------------------------------------

function validRedirectUri(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true; // covers claude.ai / claude.com callbacks
  if (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return true; // dev tools
  return false;
}

export function handleRegister(rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody.toString("utf8") || "{}");
  } catch {
    return oauthError(400, "invalid_client_metadata", "expected JSON body");
  }
  const uris = body?.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === "string" && validRedirectUri(u))) {
    return oauthError(400, "invalid_redirect_uri", "redirect_uris must be https URLs (or http://localhost for dev)");
  }
  const iat = nowS();
  const clientId = pack({ redirect_uris: uris, iat });
  return json(201, {
    client_id: clientId,
    client_id_issued_at: iat,
    redirect_uris: uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: SCOPE,
    ...(typeof body.client_name === "string" ? { client_name: body.client_name } : {}),
  });
}

// Verifies a self-validating client_id and that redirect_uri is registered to it.
function verifyClient(clientId, redirectUri) {
  const payload = unpack(clientId);
  if (!payload || !Array.isArray(payload.redirect_uris)) return null;
  if (!payload.redirect_uris.includes(redirectUri)) return null;
  return payload;
}

// Short binding of a code to its client without embedding the whole client_id.
function clientHash(clientId) {
  return createHash("sha256").update(String(clientId)).digest("base64url").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Credential check — env DRILL_USERS first, then the self-signup registry
// ---------------------------------------------------------------------------

// Returns the canonical sub (lowercased email) on success, null on failure.
async function checkCredentials(email, accessCode) {
  const norm = String(email || "").trim().toLowerCase();
  // Trim + case-fold the submitted code: mobile paste adds whitespace, keyboards
  // capitalize, and codes are hex so case carries no entropy. The registry hashes
  // the same normalization at signup (registry.normalizeCode), so both agree.
  const given = normalizeCode(accessCode);

  // 1. Env-provisioned users: plain code, compared timing-safe.
  const envExpected = envUsers().get(norm);
  if (envExpected !== undefined) {
    return safeEqual(given, envExpected.toLowerCase()) ? norm : null;
  }

  // 2. Self-signup registry: sha256(given) vs stored codeHash, timing-safe.
  //    (Both sides are 64-hex sha256 digests, so lengths always match.)
  let user = null;
  try {
    user = await getUser(norm);
  } catch {
    user = null; // Blob outage → fail closed
  }
  // Always run a comparison so a known-vs-unknown email is not timing-distinguishable.
  const expectedHash = user && typeof user.codeHash === "string" ? user.codeHash : sha256Hex(`missing-${randomUUID()}`);
  const ok = safeEqual(sha256Hex(given), expectedHash);
  return ok && user ? norm : null;
}

// ---------------------------------------------------------------------------
// Signup rate limit — per-instance, best-effort. Serverless instances each
// keep their own Map (no shared state), so this is a speed bump against
// registry-stuffing from one connection, NOT a security boundary; a burst
// across many instances or rotating IPs will exceed it.
// ---------------------------------------------------------------------------

const REGISTER_MAX_ATTEMPTS = 5; // per IP...
const REGISTER_WINDOW_MS = 3600_000; // ...per hour
const registerAttempts = new Map(); // ip -> [attempt timestamps ms]

// Records one register attempt for this IP; true when over the limit.
function registerRateLimited(clientIp) {
  // x-forwarded-for may carry a chain "client, proxy1, proxy2" — key on the client.
  const ip = String(clientIp || "").split(",")[0].trim() || "unknown";
  const now = Date.now();
  const recent = (registerAttempts.get(ip) || []).filter((t) => now - t < REGISTER_WINDOW_MS);
  if (recent.length >= REGISTER_MAX_ATTEMPTS) {
    registerAttempts.set(ip, recent);
    return true;
  }
  recent.push(now);
  registerAttempts.set(ip, recent);
  if (registerAttempts.size > 1000) {
    // Opportunistic pruning so the map can't grow unbounded in a long-lived instance.
    for (const [k, v] of registerAttempts) {
      const alive = v.filter((t) => now - t < REGISTER_WINDOW_MS);
      if (alive.length) registerAttempts.set(k, alive);
      else registerAttempts.delete(k);
    }
  }
  return false;
}

// Email shape for self-signup. Stricter than RFC 5322 on purpose: every char
// must also pass store.mjs's USER_ID_RE (the email becomes the users/<email>/
// blob namespace), so allow only [A-Za-z0-9._+-] around a single "@".
const EMAIL_RE = /^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}$/;
const CODE_MIN_LENGTH = 8;
const CODE_MAX_LENGTH = 128;

// ---------------------------------------------------------------------------
// Invite gate — self-signup requires an operator-issued invite code from the
// INVITE_CODES env var (comma-separated; codes are trimmed and compared
// case-insensitively). Empty/unset → registration is CLOSED: the Create
// account tab shows a notice and register POSTs are rejected. Sign-in is
// never gated. Rotate codes by editing the env var and redeploying.
// ---------------------------------------------------------------------------

const SIGNUPS_CLOSED_MSG = "Sign-ups are currently invite-only and closed — ask the operator for access";
const INVITE_INVALID_MSG = "That invite code isn't valid.";

// Canonical (trimmed, lowercased) invite codes from the env. Parsed per call
// like envUsers() so tests/redeploys never fight a stale module cache.
function inviteCodes() {
  return (process.env.INVITE_CODES || "")
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
}

// Returns the canonical (lowercased) invite code the candidate matches, or
// null. Compares timing-safe against EVERY configured code (no early exit)
// so response time doesn't reveal which code — if any — was close.
function matchInvite(candidate) {
  const given = String(candidate || "").trim().toLowerCase();
  let matched = null;
  for (const code of inviteCodes()) {
    if (safeEqual(given, code)) matched = code;
  }
  return matched;
}

// ---------------------------------------------------------------------------
// Sign-in page (GET /oauth/authorize) + credential POST
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const OAUTH_PARAM_NAMES = ["response_type", "client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope", "resource"];

// Sign-in / create-account page. Two panes toggled by hidden CSS radios (no
// JavaScript, fully stateless); each pane is a full form that POSTs back to
// /oauth/authorize with a hidden `action` field (signin | register) plus the
// echoed OAuth params. When no INVITE_CODES are configured the register pane
// is replaced by a closed notice (sign-in unaffected).
// opts: { error, mode: "signin"|"register", status }.
function signInPage(params, opts = {}) {
  const { error = "", mode = "signin", status = error ? 401 : 200 } = opts;
  const register = mode === "register";
  const signupsOpen = inviteCodes().length > 0;
  const hidden = OAUTH_PARAM_NAMES.filter((k) => params[k] != null && params[k] !== "")
    .map((k) => `<input type="hidden" name="${esc(k)}" value="${esc(params[k])}">`)
    .join("\n      ");
  const email = esc(params.email ?? "");
  return html(status, `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>AI Bar Prep — sign in</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; margin: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f4f4f5; color: #18181b;
    min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
  }
  .card { background: #fff; border: 1px solid #e4e4e7; border-radius: 12px; padding: 32px; width: 100%; max-width: 380px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  h1 { font-size: 1.15rem; margin-bottom: 4px; }
  p.sub { color: #71717a; font-size: .875rem; margin-bottom: 4px; }
  .tab-radio { position: absolute; opacity: 0; pointer-events: none; }
  .tabs { display: flex; margin: 16px 0 2px; border-bottom: 1px solid #e4e4e7; }
  .tabs label { flex: 1; text-align: center; padding: 9px 4px; font-size: .85rem; font-weight: 600; color: #71717a; border-bottom: 2px solid transparent; margin-bottom: -1px; cursor: pointer; }
  #tab-signin:checked ~ .tabs label[for=tab-signin],
  #tab-register:checked ~ .tabs label[for=tab-register] { color: #4f46e5; border-bottom-color: #4f46e5; }
  .pane { display: none; }
  #tab-signin:checked ~ .pane-signin,
  #tab-register:checked ~ .pane-register { display: block; }
  label.field { display: block; font-size: .8rem; font-weight: 600; margin: 14px 0 6px; }
  input[type=email], input[type=password], input[type=text] {
    width: 100%; padding: 10px 12px; font-size: 1rem; border: 1px solid #d4d4d8; border-radius: 8px;
    background: inherit; color: inherit;
  }
  .closed { color: #71717a; font-size: .875rem; margin-top: 18px; }
  input:focus { outline: 2px solid #6366f1; outline-offset: 1px; border-color: transparent; }
  button { width: 100%; margin-top: 20px; padding: 11px; font-size: 1rem; font-weight: 600; color: #fff; background: #4f46e5; border: 0; border-radius: 8px; cursor: pointer; }
  button:hover { background: #4338ca; }
  .err { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; border-radius: 8px; padding: 10px 12px; font-size: .85rem; margin-top: 12px; }
  .hint { color: #71717a; font-size: .75rem; margin-top: 6px; }
  .note { color: #71717a; font-size: .75rem; margin-top: 16px; text-align: center; }
  @media (prefers-color-scheme: dark) {
    body { background: #18181b; color: #fafafa; }
    .card { background: #27272a; border-color: #3f3f46; }
    p.sub, .note, .hint { color: #a1a1aa; }
    .tabs { border-bottom-color: #3f3f46; }
    input[type=email], input[type=password], input[type=text] { border-color: #52525b; }
    .err { background: #450a0a; color: #fecaca; border-color: #7f1d1d; }
  }
</style>
</head>
<body>
  <main class="card">
    <h1>AI Bar Prep</h1>
    <p class="sub">Sign in — or create an account — to connect Claude to your drill state.</p>
    <input type="radio" name="mode-tab" id="tab-signin" class="tab-radio"${register ? "" : " checked"}>
    <input type="radio" name="mode-tab" id="tab-register" class="tab-radio"${register ? " checked" : ""}>
    <div class="tabs">
      <label for="tab-signin">Sign in</label>
      <label for="tab-register">Create account</label>
    </div>
    ${error ? `<div class="err">${esc(error)}</div>` : ""}
    <form class="pane pane-signin" method="POST" action="/oauth/authorize">
      <input type="hidden" name="action" value="signin">
      <label class="field" for="email">Email</label>
      <input id="email" type="email" name="email" autocomplete="email" required${register ? "" : " autofocus"} value="${email}">
      <label class="field" for="access_code">Password</label>
      <input id="access_code" type="password" name="access_code" autocomplete="current-password" required>
      ${hidden}
      <button type="submit">Sign in &amp; authorize</button>
    </form>
    ${signupsOpen ? `<form class="pane pane-register" method="POST" action="/oauth/authorize">
      <input type="hidden" name="action" value="register">
      <label class="field" for="reg_invite">Invite code</label>
      <input id="reg_invite" type="text" name="invite_code" autocomplete="off" autocapitalize="off" spellcheck="false" required>
      <p class="hint">Sign-ups are invite-only — the operator gave you this code.</p>
      <label class="field" for="reg_email">Email</label>
      <input id="reg_email" type="email" name="email" autocomplete="email" required${register ? " autofocus" : ""} value="${email}">
      <label class="field" for="reg_code">Password</label>
      <input id="reg_code" type="password" name="access_code" autocomplete="new-password" required minlength="${CODE_MIN_LENGTH}">
      <p class="hint">At least ${CODE_MIN_LENGTH} characters. You'll use it to sign in here — it is not case-sensitive.</p>
      <label class="field" for="reg_code2">Confirm password</label>
      <input id="reg_code2" type="password" name="access_code_confirm" autocomplete="new-password" required minlength="${CODE_MIN_LENGTH}">
      ${hidden}
      <button type="submit">Create account &amp; authorize</button>
    </form>` : `<div class="pane pane-register">
      <p class="closed">${esc(SIGNUPS_CLOSED_MSG)}.</p>
    </div>`}
    <p class="note">This grants Claude access to your spaced-repetition drill state.</p>
  </main>
</body>
</html>`);
}

function errorPage(title, detail) {
  return html(400, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>AI Bar Prep — error</title>
<style>:root{color-scheme:light dark}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f4f4f5;color:#18181b;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}@media (prefers-color-scheme: dark){body{background:#18181b;color:#fafafa}}main{max-width:420px}h1{font-size:1.1rem;margin-bottom:8px}p{color:#71717a;font-size:.9rem}</style>
</head><body><main><h1>${esc(title)}</h1><p>${esc(detail)}</p></main></body></html>`);
}

// Validates the OAuth query params shared by GET and POST /oauth/authorize.
// Returns { error: resultObj } on hard failure (never redirects — per spec an
// invalid client_id/redirect_uri must not bounce the user to the attacker URI).
function validateAuthorizeParams(params) {
  const clientId = params.client_id;
  const redirectUri = params.redirect_uri;
  if (!clientId || !redirectUri || !verifyClient(clientId, redirectUri) || !validRedirectUri(redirectUri)) {
    return { error: errorPage("Invalid authorization request", "Unknown client_id or unregistered redirect_uri. Re-add the connector and try again.") };
  }
  if (params.response_type !== "code") {
    return { error: errorPage("Unsupported response_type", 'Only response_type="code" is supported.') };
  }
  if (!params.code_challenge || (params.code_challenge_method || "S256") !== "S256") {
    return { error: errorPage("PKCE required", "A code_challenge with method S256 is required.") };
  }
  return { ok: true };
}

// GET /oauth/authorize — render the sign-in form (or an error page; never redirect on failure).
export function handleAuthorizeGet(params) {
  try {
    secret();
  } catch (e) {
    return json(500, { error: "server_misconfigured", message: e.message });
  }
  const v = validateAuthorizeParams(params);
  if (v.error) return v.error;
  // ?mode=register pre-selects the Create account tab (shareable onboarding link).
  return signInPage(params, { mode: params.mode === "register" ? "register" : "signin" });
}

// POST /oauth/authorize — form body carries email + access_code + the OAuth
// params, plus a hidden `action` field: "signin" (default) checks credentials,
// "register" creates a self-signup account and then proceeds identically.
// clientIp (x-forwarded-for) keys the best-effort signup rate limit.
export async function handleAuthorizePost(rawBody, clientIp) {
  try {
    secret();
  } catch (e) {
    return json(500, { error: "server_misconfigured", message: e.message });
  }
  const form = new URLSearchParams(rawBody.toString("utf8"));
  const params = Object.fromEntries(form);
  const v = validateAuthorizeParams(params);
  if (v.error) return v.error;

  let sub;
  if (params.action === "register") {
    const fail = (error, status = 400) => signInPage(params, { error, mode: "register", status });
    if (registerRateLimited(clientIp)) {
      return fail("Too many sign-up attempts from your network. Wait an hour and try again.", 429);
    }
    // Invite gate: no configured codes → registration is closed outright;
    // otherwise the submitted invite must match one (generic error either way
    // it fails — never reveal whether/which codes exist).
    if (inviteCodes().length === 0) return fail(`${SIGNUPS_CLOSED_MSG}.`, 403);
    const invite = matchInvite(params.invite_code);
    if (!invite) return fail(INVITE_INVALID_MSG);
    const email = String(params.email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return fail("Enter a valid email address (letters, digits, . _ + - only).");
    const code = String(params.access_code || "").trim();
    const confirm = String(params.access_code_confirm || "").trim();
    if (code.length < CODE_MIN_LENGTH || code.length > CODE_MAX_LENGTH) {
      return fail(`Password must be ${CODE_MIN_LENGTH}-${CODE_MAX_LENGTH} characters.`);
    }
    if (!safeEqual(code, confirm)) return fail("Passwords do not match.");
    try {
      sub = await createUser(email, code, invite); // stores sha256(normalized code) + the invite cohort
    } catch (e) {
      if (e?.code === "email_taken") {
        return fail("An account with that email already exists. Use the Sign in tab instead.");
      }
      throw e;
    }
  } else {
    sub = await checkCredentials(params.email, params.access_code);
    if (!sub) return signInPage(params, { error: "Wrong email or password. Use the Create account tab if you don't have an account yet." });
  }

  const code = pack({
    typ: "code",
    sub,
    redirect_uri: params.redirect_uri,
    code_challenge: params.code_challenge,
    cid: clientHash(params.client_id),
    scope: params.scope || SCOPE,
    ...(params.resource ? { resource: params.resource } : {}),
    jti: randomUUID(),
    exp: nowS() + AUTH_CODE_TTL_S,
  });
  const target = new URL(params.redirect_uri);
  target.searchParams.set("code", code);
  if (params.state != null && params.state !== "") target.searchParams.set("state", params.state);
  return { status: 302, contentType: "text/plain", body: "Redirecting…", headers: { Location: target.toString() } };
}

// ---------------------------------------------------------------------------
// Token endpoint — POST /oauth/token (form-encoded or JSON)
// ---------------------------------------------------------------------------

function mintTokenPair(sub, scope) {
  const now = nowS();
  // jti makes every mint unique so refresh rotation always yields new bytes.
  return {
    access_token: pack({ sub, iat: now, exp: now + ACCESS_TOKEN_TTL_S, typ: "access", jti: randomUUID() }),
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_S,
    refresh_token: pack({ sub, iat: now, exp: now + REFRESH_TOKEN_TTL_S, typ: "refresh", jti: randomUUID() }),
    scope: scope || SCOPE,
  };
}

export function handleToken(rawBody, contentTypeHeader) {
  try {
    secret();
  } catch (e) {
    return json(500, { error: "server_misconfigured", message: e.message });
  }
  const text = rawBody.toString("utf8");
  let params;
  if ((contentTypeHeader || "").includes("json")) {
    try {
      params = JSON.parse(text || "{}");
    } catch {
      return oauthError(400, "invalid_request", "malformed JSON body");
    }
  } else {
    params = Object.fromEntries(new URLSearchParams(text));
  }

  const now = nowS();
  if (params.grant_type === "authorization_code") {
    const code = unpack(params.code);
    if (!code || code.typ !== "code" || !code.exp || code.exp < now) {
      return oauthError(400, "invalid_grant", "authorization code is invalid or expired");
    }
    if (!params.redirect_uri || code.redirect_uri !== params.redirect_uri) {
      return oauthError(400, "invalid_grant", "redirect_uri does not match the authorization request");
    }
    if (!params.client_id || !verifyClient(params.client_id, params.redirect_uri) || clientHash(params.client_id) !== code.cid) {
      return oauthError(400, "invalid_client", "client_id is invalid or does not match the authorization request");
    }
    const verifier = String(params.code_verifier || "");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (!verifier || !safeEqual(challenge, code.code_challenge)) {
      return oauthError(400, "invalid_grant", "PKCE code_verifier does not match code_challenge");
    }
    return json(200, mintTokenPair(code.sub, code.scope), { "Cache-Control": "no-store" });
  }

  if (params.grant_type === "refresh_token") {
    const rt = unpack(params.refresh_token);
    if (!rt || rt.typ !== "refresh" || !rt.sub || !rt.exp || rt.exp < now) {
      return oauthError(400, "invalid_grant", "refresh token is invalid or expired");
    }
    // Rotate: new access + new refresh.
    return json(200, mintTokenPair(rt.sub, params.scope), { "Cache-Control": "no-store" });
  }

  return oauthError(400, "unsupported_grant_type", 'grant_type must be "authorization_code" or "refresh_token"');
}

// ---------------------------------------------------------------------------
// Resource protection for POST /mcp — Bearer access tokens only.
// ---------------------------------------------------------------------------

// Returns {sub} for a valid, unexpired typ:"access" token; null otherwise.
export function verifyBearerToken(authHeader) {
  const match = /^Bearer\s+(.+)$/i.exec(authHeader || "");
  if (!match) return null;
  const payload = unpack(match[1]);
  if (!payload || payload.typ !== "access" || !payload.sub || !payload.exp || payload.exp < nowS()) return null;
  return { sub: payload.sub };
}

// 401 challenge per the MCP authorization spec (RFC 9728 resource_metadata).
export function unauthorized(origin, hadToken) {
  const attrs = [
    ...(hadToken ? ['error="invalid_token"'] : []),
    `resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
  ].join(", ");
  return json(
    401,
    { error: hadToken ? "invalid_token" : "unauthorized", error_description: "a valid Bearer access token is required" },
    { "WWW-Authenticate": `Bearer ${attrs}` }
  );
}
