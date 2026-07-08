// End-to-end local test of self-serve account creation (proxy/lib/registry.mjs +
// the "Create account" tab in lib/oauth.mjs). Run from proxy/:  node test/signup-e2e.mjs
// Spawns the proxy on :8791 WITH INVITE_CODES set and drives: sign-in page with
// both tabs (register pane has the invite field) → invite-gate failures (missing/
// wrong invite, generic error) → register validation failures → successful signup
// with a case/whitespace-mangled invite (302 + code) → token exchange → Bearer
// /mcp call with fresh per-user state → duplicate-email + env-email rejections →
// wrong/right password sign-in for the new account → env-provisioned user
// unaffected → per-IP register rate limit (5/hour) → registry records the
// lowercased invite cohort. Then RESPAWNS the proxy with INVITE_CODES unset:
// register pane shows the closed notice, register POSTs are 403, sign-in still
// works. Needs a real BLOB_READ_WRITE_TOKEN — from the environment, or read at
// runtime from proxy/.env.local (never committed). Writes (and then deletes)
// users/_system/registry.json; the registered test user never reviews a card,
// so no per-user blobs are created.
//
// NOTE: the register-attempt budget is exact — the rate limit allows 5 register
// POSTs per IP/hour and every register POST counts. The default-IP budget keeps
// the original order: 2 validation failures + 1 success + 2 duplicate rejections
// = 5, then the 6th must come back 429. The invite-gate failure checks send a
// synthetic x-forwarded-for so they burn a DIFFERENT IP's budget (index.mjs
// keys the limiter on that header, like Vercel does).
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let BLOB = process.env.BLOB_READ_WRITE_TOKEN;
if (!BLOB) {
  const envPath = path.join(WT, ".env.local");
  if (fs.existsSync(envPath)) {
    const envLocal = fs.readFileSync(envPath, "utf8");
    BLOB = envLocal.match(/BLOB_READ_WRITE_TOKEN="([^"]+)"/)?.[1] ?? envLocal.match(/BLOB_READ_WRITE_TOKEN=(\S+)/)?.[1];
  }
}
if (!BLOB) throw new Error("set BLOB_READ_WRITE_TOKEN (env or proxy/.env.local)");
process.env.BLOB_READ_WRITE_TOKEN = BLOB; // for the store.mjs import used in cleanup

const PORT = Number(process.env.TEST_PORT) || 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const ENV_EMAIL = "env-user@test.com";
const ENV_CODE = "envcode99";
// Unique per run so a leftover registry from an aborted run can't collide.
const NEW_EMAIL = `signup-${randomBytes(4).toString("hex")}@test.com`;
const NEW_CODE = "drill-me-2026";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
// Two operator invites (second exercises comma parsing / trimming); canonical
// form is lowercased. The success path submits it mangled: " WELCOME-Cohort-A ".
const INVITE = "welcome-cohort-a";
const INVITE_CODES = "WELCOME-Cohort-A, beta2026";

const baseEnv = {
  ...process.env,
  BLOB_READ_WRITE_TOKEN: BLOB,
  MCP_SECRET: "test",
  AUTH_SECRET: "testsecret",
  DRILL_USERS: `${ENV_EMAIL}:${ENV_CODE}`,
  APP_TOKEN: "localtest",
  PORT: String(PORT),
};
delete baseEnv.INVITE_CODES; // the closed-mode respawn must not inherit one from the caller

function spawnServer(extraEnv) {
  const s = spawn("node", ["index.mjs"], { cwd: WT, env: { ...baseEnv, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
  s.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  return s;
}
let server = spawnServer({ INVITE_CODES });
await new Promise((r) => setTimeout(r, 800));

let pass = 0, fail = 0;
const check = (desc, cond) => {
  if (cond) { pass++; console.log(`  PASS: ${desc}`); }
  else { fail++; console.log(`  FAIL: ${desc}`); }
};
const step = (s) => console.log(`\n=== ${s} ===`);
const show = (o) => console.log("  " + (typeof o === "string" ? o : JSON.stringify(o)).slice(0, 400));

const form = (obj) => new URLSearchParams(obj).toString();

let rpcId = 0;
async function rpc(url, method, params, token) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, ...(params ? { params } : {}) }),
  });
  return { status: r.status, headers: r.headers, json: await r.json().catch(() => null) };
}
async function call(url, tool, args = {}, token) {
  const { json } = await rpc(url, "tools/call", { name: tool, arguments: args }, token);
  const r = json?.result;
  if (!r) return { isError: true, text: JSON.stringify(json) };
  if (r.isError) return { isError: true, text: r.content[0].text };
  return JSON.parse(r.content[0].text);
}

// ---------------------------------------------------------------------------
step("0. dynamic client registration + PKCE setup");
let clientId;
{
  const r = await fetch(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT_URI], client_name: "Claude" }),
  });
  const body = await r.json();
  clientId = body.client_id;
  check("client registered", r.status === 201 && typeof clientId === "string");
}
const codeVerifier = randomBytes(32).toString("base64url");
const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
const STATE = "st-" + randomBytes(8).toString("hex");
const authQuery = {
  response_type: "code",
  client_id: clientId,
  redirect_uri: REDIRECT_URI,
  state: STATE,
  code_challenge: codeChallenge,
  code_challenge_method: "S256",
  scope: "drill",
  resource: `${BASE}/mcp`,
};
// POSTs the authorize form with action signin|register plus extra fields.
// `ip` (optional) sets x-forwarded-for so a check can burn a different IP's
// register-rate-limit budget than the default-socket one.
async function authorizePost(action, fields, ip) {
  const r = await fetch(`${BASE}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...(ip ? { "x-forwarded-for": ip } : {}) },
    body: form({ ...authQuery, action, ...fields }),
    redirect: "manual",
  });
  return { status: r.status, location: r.headers.get("location"), page: r.status === 302 ? "" : await r.text() };
}
async function exchange(authCode) {
  const r = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "authorization_code", code: authCode, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: codeVerifier }),
  });
  return { status: r.status, body: await r.json() };
}

// ---------------------------------------------------------------------------
step("1. GET /oauth/authorize — page has Sign in AND Create account");
{
  const r = await fetch(`${BASE}/oauth/authorize?${form(authQuery)}`);
  const page = await r.text();
  check("200 HTML page", r.status === 200 && (r.headers.get("content-type") || "").includes("text/html"));
  check("has both tabs", page.includes(">Sign in</label>") && page.includes(">Create account</label>"));
  check("signin form carries hidden action=signin", page.includes('name="action" value="signin"'));
  check("register form carries hidden action=register + confirm field", page.includes('name="action" value="register"') && page.includes('name="access_code_confirm"'));
  const inviteInput = /<input[^>]*name="invite_code"[^>]*>/.exec(page)?.[0] ?? "";
  check("register form has required invite field, autocomplete off", inviteInput.includes("required") && inviteInput.includes('autocomplete="off"'));
  check("OAuth params echoed in BOTH forms", page.split(`value="${STATE}"`).length - 1 === 2 && page.split(`value="${codeChallenge}"`).length - 1 === 2);
  check("signin tab selected by default", /id="tab-signin" class="tab-radio" checked/.test(page));
  const reg = await fetch(`${BASE}/oauth/authorize?${form({ ...authQuery, mode: "register" })}`);
  check("?mode=register pre-selects the register tab", /id="tab-register" class="tab-radio" checked/.test(await reg.text()));
}

// ---------------------------------------------------------------------------
step("1b. invite gate — missing/wrong invite rejected (separate IP's budget)");
{
  const GATE_IP = "198.51.100.7"; // synthetic client — keeps the default IP's exact 5-attempt budget intact
  const missing = await authorizePost("register", { email: NEW_EMAIL, access_code: NEW_CODE, access_code_confirm: NEW_CODE }, GATE_IP);
  check("missing invite → 400 re-render, register tab, NO redirect", missing.status === 400 && !missing.location && missing.page.includes("That invite code isn&#39;t valid.") && /id="tab-register" class="tab-radio" checked/.test(missing.page));
  const wrong = await authorizePost("register", { invite_code: "not-a-real-invite", email: NEW_EMAIL, access_code: NEW_CODE, access_code_confirm: NEW_CODE }, GATE_IP);
  check("wrong invite → 400 with the SAME generic error as missing", wrong.status === 400 && !wrong.location && wrong.page.includes("That invite code isn&#39;t valid."));
  check("gate error never mentions closed/operator (doesn't reveal code existence)", !wrong.page.includes("invite-only and closed") && !missing.page.includes("invite-only and closed"));
}

// ---------------------------------------------------------------------------
step("2. register validation failures (attempts 1-2 of 5)");
{
  const mismatch = await authorizePost("register", { invite_code: INVITE, email: NEW_EMAIL, access_code: NEW_CODE, access_code_confirm: NEW_CODE + "x" });
  check("mismatched confirm → 400 re-render, register tab, NO redirect", mismatch.status === 400 && !mismatch.location && mismatch.page.includes("do not match") && /id="tab-register" class="tab-radio" checked/.test(mismatch.page));
  const short = await authorizePost("register", { invite_code: INVITE, email: NEW_EMAIL, access_code: "short", access_code_confirm: "short" });
  check("password under 8 chars → 400 re-render", short.status === 400 && short.page.includes("Password must be"));
  const badEmail = await authorizePost("signin", { email: "not-an-email", access_code: NEW_CODE }); // signin doesn't count toward the register budget
  check("(signin with unknown email still 401, not a crash)", badEmail.status === 401);
}

// ---------------------------------------------------------------------------
step("3. successful signup, invite case/space-mangled → 302 with code (attempt 3 of 5)");
let accessToken;
{
  const ok = await authorizePost("register", { invite_code: " WELCOME-Cohort-A ", email: ` ${NEW_EMAIL.toUpperCase()} `, access_code: NEW_CODE, access_code_confirm: NEW_CODE });
  show({ status: ok.status, location: (ok.location || "").slice(0, 110) + "…" });
  check("register → 302 to redirect_uri", ok.status === 302 && ok.location && ok.location.startsWith(REDIRECT_URI));
  const u = new URL(ok.location);
  const authCode = u.searchParams.get("code");
  check("redirect carries code + original state", Boolean(authCode) && u.searchParams.get("state") === STATE);
  const payload = JSON.parse(Buffer.from(authCode.split(".")[0], "base64url").toString());
  check("code sub = lowercased trimmed email", payload.sub === NEW_EMAIL);

  const tok = await exchange(authCode);
  accessToken = tok.body.access_token;
  check("token exchange → 200 Bearer pair", tok.status === 200 && Boolean(accessToken) && tok.body.token_type === "Bearer");
  const ap = JSON.parse(Buffer.from(accessToken.split(".")[0], "base64url").toString());
  check("access token sub = new user", ap.typ === "access" && ap.sub === NEW_EMAIL);
}

// ---------------------------------------------------------------------------
step("4. /mcp with the new user's token — fresh per-user state");
{
  const list = await rpc(`${BASE}/mcp`, "tools/list", null, accessToken);
  const names = (list.json?.result?.tools ?? []).map((t) => t.name);
  check("tools/list works with signup token", list.status === 200 && names.includes("get_due_summary") && names.includes("get_stats"));
  const stats = await call(`${BASE}/mcp`, "get_stats", {}, accessToken);
  show({ card_reviews: stats.totals?.card_reviews, mbe_answered: stats.totals?.mbe_answered });
  check("fresh state: zero reviews for the brand-new user", stats.totals?.card_reviews === 0 && stats.totals?.mbe_answered === 0);
}

// ---------------------------------------------------------------------------
step("5. duplicate registrations rejected (attempts 4-5 of 5)");
{
  const dup = await authorizePost("register", { invite_code: INVITE, email: NEW_EMAIL, access_code: "another-code-123", access_code_confirm: "another-code-123" });
  check("same email again → 400 'already exists', NO redirect", dup.status === 400 && !dup.location && dup.page.includes("already exists"));
  const envDup = await authorizePost("register", { invite_code: INVITE, email: ENV_EMAIL, access_code: "another-code-123", access_code_confirm: "another-code-123" });
  check("env-provisioned email → 400 'already exists'", envDup.status === 400 && envDup.page.includes("already exists"));
}

// ---------------------------------------------------------------------------
step("6. sign-in for the registered account");
{
  const wrong = await authorizePost("signin", { email: NEW_EMAIL, access_code: "totally-wrong-code" });
  check("wrong password after signup → 401 error re-render", wrong.status === 401 && !wrong.location && wrong.page.includes("Wrong email or password"));
  const right = await authorizePost("signin", { email: NEW_EMAIL, access_code: ` ${NEW_CODE.toUpperCase()} ` }); // trim + case-fold like env codes
  check("correct password (case/space-insensitive) → 302 with code", right.status === 302 && new URL(right.location).searchParams.get("code"));
}

// ---------------------------------------------------------------------------
step("7. env-provisioned user still signs in");
{
  const r = await authorizePost("signin", { email: ENV_EMAIL, access_code: ENV_CODE });
  check("DRILL_USERS account → 302 with code", r.status === 302 && Boolean(new URL(r.location).searchParams.get("code")));
  const sub = JSON.parse(Buffer.from(new URL(r.location).searchParams.get("code").split(".")[0], "base64url").toString()).sub;
  check("env user sub unchanged", sub === ENV_EMAIL);
}

// ---------------------------------------------------------------------------
step("8. register rate limit — 6th attempt from this IP → 429");
{
  const r = await authorizePost("register", { invite_code: INVITE, email: `other-${randomBytes(3).toString("hex")}@test.com`, access_code: "yet-another-code", access_code_confirm: "yet-another-code" });
  check("over-limit register → 429 'Too many sign-up attempts'", r.status === 429 && !r.location && r.page.includes("Too many sign-up attempts"));
  const signinStill = await authorizePost("signin", { email: ENV_EMAIL, access_code: ENV_CODE });
  check("sign-in is NOT rate limited", signinStill.status === 302);
}

// ---------------------------------------------------------------------------
step("9. registry entry records the lowercased invite cohort");
{
  // Read the registry blob directly (same store module the server uses). Blob
  // listing is eventually consistent, so retry until the write is visible.
  const { getFile } = await import("../lib/store.mjs");
  let entry = null;
  for (let i = 0; i < 12 && !entry; i++) {
    try {
      const file = await getFile("_system", "registry.json");
      entry = file ? JSON.parse(file.body.toString("utf8"))?.users?.[NEW_EMAIL] ?? null : null;
    } catch {
      entry = null;
    }
    if (!entry) await new Promise((r) => setTimeout(r, 5000));
  }
  show(entry);
  check("registry entry exists with codeHash", Boolean(entry?.codeHash));
  check(`invite recorded lowercased ("${INVITE}") despite mangled submission`, entry?.invite === INVITE);
}

// ---------------------------------------------------------------------------
step("10. INVITE_CODES unset → registration closed, sign-in unaffected");
{
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  server = spawnServer({}); // same env, NO INVITE_CODES
  await new Promise((r) => setTimeout(r, 800));

  const page = await (await fetch(`${BASE}/oauth/authorize?${form({ ...authQuery, mode: "register" })}`)).text();
  check("register pane shows the closed notice", page.includes("Sign-ups are currently invite-only and closed") && page.includes("ask the operator for access"));
  check("no register form is rendered (no invite/confirm fields, no action=register)", !page.includes('name="invite_code"') && !page.includes('name="access_code_confirm"') && !page.includes('name="action" value="register"'));
  check("sign-in form still rendered", page.includes('name="action" value="signin"') && page.includes('name="access_code"'));

  const reg = await authorizePost("register", { invite_code: INVITE, email: `closed-${randomBytes(3).toString("hex")}@test.com`, access_code: "some-code-12345", access_code_confirm: "some-code-12345" });
  check("register POST → 403 rejected with the closed message, NO redirect", reg.status === 403 && !reg.location && reg.page.includes("Sign-ups are currently invite-only and closed"));

  const signin = await authorizePost("signin", { email: ENV_EMAIL, access_code: ENV_CODE });
  check("env user sign-in still works while closed → 302 with code", signin.status === 302 && Boolean(new URL(signin.location).searchParams.get("code")));
  const registered = await authorizePost("signin", { email: NEW_EMAIL, access_code: NEW_CODE });
  check("previously registered user signs in while closed → 302", registered.status === 302);
}

// ---------------------------------------------------------------------------
step("cleanup: delete users/_system/registry.json");
{
  // Direct store access (same module the server uses); blob listing is
  // eventually consistent, so retry until the fresh write becomes visible.
  const { deleteFile, getFile } = await import("../lib/store.mjs");
  let deleted = false;
  for (let i = 0; i < 12 && !deleted; i++) {
    try {
      deleted = await deleteFile("_system", "registry.json");
    } catch {
      deleted = false;
    }
    if (!deleted) await new Promise((r) => setTimeout(r, 5000));
  }
  check("registry blob deleted", deleted);
  check("no per-user blobs were created for the test user (get_stats is read-only)", (await getFile(NEW_EMAIL, "srs.json")) === null);
}

console.log(`\n================ RESULT: ${pass} passed, ${fail} failed ================`);
server.kill();
process.exit(fail ? 1 : 0);
