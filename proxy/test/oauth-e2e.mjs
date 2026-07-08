// End-to-end local test of OAuth 2.1 authorization for the MCP drill server
// (proxy/lib/oauth.mjs + index.mjs wiring). Run from proxy/:  node test/oauth-e2e.mjs
// Spawns the proxy on :8789 and drives the full dance: discovery → dynamic client
// registration → sign-in page → authorization code (PKCE S256) → token → Bearer-authed
// /mcp calls with per-user state isolation → refresh rotation → legacy path secret.
// Needs a real BLOB_READ_WRITE_TOKEN — from the environment, or read at runtime from
// proxy/.env.local (never committed). Writes (and then deletes)
// users/josh@test.com/{srs.json, drill-log.json}.
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

const PORT = Number(process.env.TEST_PORT) || 8789;
const BASE = `http://127.0.0.1:${PORT}`;
const USER_EMAIL = "josh@test.com";
const ACCESS_CODE = "code123";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

const server = spawn("node", ["index.mjs"], {
  cwd: WT,
  env: {
    ...process.env,
    BLOB_READ_WRITE_TOKEN: BLOB,
    MCP_SECRET: "test",
    AUTH_SECRET: "testsecret",
    DRILL_USERS: `${USER_EMAIL}:${ACCESS_CODE}`,
    APP_TOKEN: "localtest",
    PORT: String(PORT),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
await new Promise((r) => setTimeout(r, 800));

let pass = 0, fail = 0;
const check = (desc, cond) => {
  if (cond) { pass++; console.log(`  PASS: ${desc}`); }
  else { fail++; console.log(`  FAIL: ${desc}`); }
};
const step = (s) => console.log(`\n=== ${s} ===`);
const show = (o) => console.log("  " + (typeof o === "string" ? o : JSON.stringify(o)).slice(0, 400));

const form = (obj) => new URLSearchParams(obj).toString();

// MCP JSON-RPC helper against a given URL with optional Bearer token.
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
step("1. discovery documents");
{
  const pr = await (await fetch(`${BASE}/.well-known/oauth-protected-resource`)).json();
  show(pr);
  check("protected-resource: resource = <origin>/mcp", pr.resource === `${BASE}/mcp`);
  check("protected-resource: authorization_servers = [origin]", JSON.stringify(pr.authorization_servers) === JSON.stringify([BASE]));
  check("protected-resource: bearer_methods_supported header", JSON.stringify(pr.bearer_methods_supported) === '["header"]');

  const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  show(as);
  check("AS metadata: issuer + endpoints", as.issuer === BASE && as.authorization_endpoint === `${BASE}/oauth/authorize` && as.token_endpoint === `${BASE}/oauth/token` && as.registration_endpoint === `${BASE}/oauth/register`);
  check("AS metadata: code + PKCE S256 + grants + auth none", JSON.stringify(as.response_types_supported) === '["code"]' && JSON.stringify(as.code_challenge_methods_supported) === '["S256"]' && JSON.stringify(as.grant_types_supported) === '["authorization_code","refresh_token"]' && JSON.stringify(as.token_endpoint_auth_methods_supported) === '["none"]');
  const suffixed = await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`);
  check("path-suffixed discovery variant answers too", suffixed.status === 200 && (await suffixed.json()).resource === `${BASE}/mcp`);
}

// ---------------------------------------------------------------------------
step("2. dynamic client registration (RFC 7591)");
let clientId;
{
  const r = await fetch(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT_URI], client_name: "Claude", token_endpoint_auth_method: "none" }),
  });
  const body = await r.json();
  show(body);
  clientId = body.client_id;
  check("201 with client_id (payload.sig format)", r.status === 201 && typeof clientId === "string" && clientId.split(".").length === 2);
  check("echoes redirect_uris + auth none + grants", JSON.stringify(body.redirect_uris) === JSON.stringify([REDIRECT_URI]) && body.token_endpoint_auth_method === "none" && body.grant_types.includes("refresh_token") && body.client_name === "Claude");
  check("client_id_issued_at present", Number.isInteger(body.client_id_issued_at));
  const payload = JSON.parse(Buffer.from(clientId.split(".")[0], "base64url").toString());
  check("client_id is self-describing {redirect_uris, iat}", JSON.stringify(payload.redirect_uris) === JSON.stringify([REDIRECT_URI]) && Number.isInteger(payload.iat));

  const bad = await fetch(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["http://evil.example.com/cb"] }),
  });
  check("non-https non-localhost redirect_uri rejected 400", bad.status === 400 && (await bad.json()).error === "invalid_redirect_uri");
  const local = await fetch(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["http://localhost:6274/callback"] }),
  });
  check("http://localhost redirect_uri allowed (dev tools)", local.status === 201);
}

// ---------------------------------------------------------------------------
step("3. GET /oauth/authorize — sign-in page");
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
{
  const r = await fetch(`${BASE}/oauth/authorize?${form(authQuery)}`);
  const page = await r.text();
  check("200 HTML sign-in page", r.status === 200 && (r.headers.get("content-type") || "").includes("text/html"));
  check("form POSTs to /oauth/authorize with email + access_code fields", page.includes('action="/oauth/authorize"') && page.includes('name="email"') && page.includes('name="access_code"'));
  check("hidden fields echo OAuth params (state, code_challenge, client_id)", page.includes(`value="${STATE}"`) && page.includes(`value="${codeChallenge}"`) && page.includes('name="client_id"'));
  check("page brands the drill account sign-in", page.includes("AI Bar Prep"));

  const badClient = await fetch(`${BASE}/oauth/authorize?${form({ ...authQuery, client_id: "forged.clientid" })}`, { redirect: "manual" });
  check("forged client_id → error page, NO redirect", badClient.status === 400 && !badClient.headers.get("location") && (await badClient.text()).includes("Invalid authorization request"));
  const badUri = await fetch(`${BASE}/oauth/authorize?${form({ ...authQuery, redirect_uri: "https://evil.example.com/cb" })}`, { redirect: "manual" });
  check("unregistered redirect_uri → error page, NO redirect", badUri.status === 400 && !badUri.headers.get("location"));
}

// ---------------------------------------------------------------------------
step("4. POST /oauth/authorize — credentials");
let authCode;
{
  const wrong = await fetch(`${BASE}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ ...authQuery, email: USER_EMAIL, access_code: "WRONG" }),
    redirect: "manual",
  });
  const wrongPage = await wrong.text();
  check("wrong password → error re-render, NO redirect", wrong.status === 401 && !wrong.headers.get("location") && wrongPage.includes("Wrong email or password"));

  const ok = await fetch(`${BASE}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ ...authQuery, email: "  Josh@Test.com ", access_code: ACCESS_CODE }), // case/space-insensitive email
    redirect: "manual",
  });
  const loc = ok.headers.get("location");
  show({ status: ok.status, location: (loc || "").slice(0, 120) + "…" });
  check("valid credentials → 302 to redirect_uri", ok.status === 302 && loc && loc.startsWith(REDIRECT_URI));
  const u = new URL(loc);
  authCode = u.searchParams.get("code");
  check("redirect carries code + original state", Boolean(authCode) && u.searchParams.get("state") === STATE);
  const codePayload = JSON.parse(Buffer.from(authCode.split(".")[0], "base64url").toString());
  check("code binds sub (lowercased email) + PKCE + redirect_uri, exp ≈ 5 min", codePayload.sub === USER_EMAIL && codePayload.code_challenge === codeChallenge && codePayload.redirect_uri === REDIRECT_URI && codePayload.exp - Math.floor(Date.now() / 1000) <= 300);
}

// ---------------------------------------------------------------------------
step("5. POST /oauth/token — authorization_code grant");
let accessToken, refreshToken;
{
  const badPkce = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "authorization_code", code: authCode, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: "not-the-right-verifier-aaaaaaaaaaaaaaaaaaaaa" }),
  });
  const badPkceBody = await badPkce.json();
  check("wrong PKCE verifier → 400 invalid_grant", badPkce.status === 400 && badPkceBody.error === "invalid_grant");

  const badUri = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "authorization_code", code: authCode, redirect_uri: "https://claude.ai/other", client_id: clientId, code_verifier: codeVerifier }),
  });
  check("mismatched redirect_uri → 400 invalid_grant", badUri.status === 400 && (await badUri.json()).error === "invalid_grant");

  const r = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "authorization_code", code: authCode, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: codeVerifier }),
  });
  const tok = await r.json();
  show({ ...tok, access_token: tok.access_token?.slice(0, 24) + "…", refresh_token: tok.refresh_token?.slice(0, 24) + "…" });
  accessToken = tok.access_token;
  refreshToken = tok.refresh_token;
  check("200 Bearer access + refresh tokens", r.status === 200 && Boolean(accessToken) && Boolean(refreshToken) && tok.token_type === "Bearer");
  check("expires_in = 2592000 (30 days), scope drill", tok.expires_in === 2592000 && tok.scope === "drill");
  const ap = JSON.parse(Buffer.from(accessToken.split(".")[0], "base64url").toString());
  const rp = JSON.parse(Buffer.from(refreshToken.split(".")[0], "base64url").toString());
  check("access typ access / 30d; refresh typ refresh / 90d; sub = email", ap.typ === "access" && ap.sub === USER_EMAIL && ap.exp - ap.iat === 2592000 && rp.typ === "refresh" && rp.exp - rp.iat === 7776000);
  const badGrant = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "password", username: "x" }),
  });
  check("unknown grant_type → 400 unsupported_grant_type", badGrant.status === 400 && (await badGrant.json()).error === "unsupported_grant_type");
}

// ---------------------------------------------------------------------------
step("6. POST /mcp — Bearer protection");
{
  const noTok = await rpc(`${BASE}/mcp`, "tools/list");
  const www = noTok.headers.get("www-authenticate") || "";
  show({ status: noTok.status, www });
  check("no token → 401 + WWW-Authenticate resource_metadata", noTok.status === 401 && www.startsWith("Bearer") && www.includes(`resource_metadata="${BASE}/.well-known/oauth-protected-resource"`));
  const badTok = await rpc(`${BASE}/mcp`, "tools/list", null, "forged.token");
  check("garbage token → 401 with error=invalid_token", badTok.status === 401 && (badTok.headers.get("www-authenticate") || "").includes('error="invalid_token"'));

  const list = await rpc(`${BASE}/mcp`, "tools/list", null, accessToken);
  const names = (list.json?.result?.tools ?? []).map((t) => t.name);
  console.log("  tools:", names.join(", "));
  check("valid token → tools/list returns the 11 drill tools", list.status === 200 && names.length === 11 && names.includes("get_due_summary"));
  const cardCount = JSON.parse(fs.readFileSync(`${WT}/data/cards.json`, "utf8")).cards.length;
  const questionCount = JSON.parse(fs.readFileSync(`${WT}/data/questions.json`, "utf8")).questions.length;
  const s = await call(`${BASE}/mcp`, "get_due_summary", {}, accessToken);
  show(s);
  check(`get_due_summary returns the bundled deck (${cardCount} cards / ${questionCount} questions)`, s.total_cards === cardCount && s.total_mbe_questions === questionCount);
}

// ---------------------------------------------------------------------------
step("7. per-user state isolation (josh@test.com vs legacy default)");
{
  // Baseline the legacy default user FIRST (also primes its in-process cache,
  // making the post-review comparison immune to Blob edge-cache staleness).
  const defBase = await call(`${BASE}/mcp/test`, "get_stats");
  const joshBase = await call(`${BASE}/mcp`, "get_stats", {}, accessToken);
  const c = await call(`${BASE}/mcp`, "next_card", {}, accessToken);
  check("next_card served for josh", typeof c.card_id === "string");
  const r = await call(`${BASE}/mcp`, "submit_review", { card_id: c.card_id, mode: "cloze-mcq", user_answer: "deliberately wrong answer xyz" }, accessToken);
  check("submit_review recorded for josh", r.correct === false && r.card_stats.seen >= 1);
  const joshAfter = await call(`${BASE}/mcp`, "get_stats", {}, accessToken);
  show({ josh_before: joshBase.totals.card_reviews, josh_after: joshAfter.totals.card_reviews });
  check("josh's card_reviews +1", joshAfter.totals.card_reviews === joshBase.totals.card_reviews + 1);
  const defAfter = await call(`${BASE}/mcp/test`, "get_stats");
  check("users/default state UNCHANGED by josh's review", defAfter.totals.card_reviews === defBase.totals.card_reviews && defAfter.totals.mbe_answered === defBase.totals.mbe_answered);
}

// ---------------------------------------------------------------------------
step("8. refresh_token grant — rotation");
{
  const r = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" }, // JSON body accepted too
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  const tok = await r.json();
  check("refresh grant → 200 with new pair", r.status === 200 && Boolean(tok.access_token) && Boolean(tok.refresh_token) && tok.expires_in === 2592000);
  check("tokens ROTATED (differ from originals)", tok.access_token !== accessToken && tok.refresh_token !== refreshToken);
  const ping = await rpc(`${BASE}/mcp`, "ping", null, tok.access_token);
  check("rotated access token works on /mcp", ping.status === 200 && JSON.stringify(ping.json.result) === "{}");
  const asRefresh = await rpc(`${BASE}/mcp`, "ping", null, tok.refresh_token);
  check("refresh token REJECTED as Bearer on /mcp (typ enforced)", asRefresh.status === 401);
  const badRt = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "refresh_token", refresh_token: "forged.refresh" }),
  });
  check("forged refresh token → 400 invalid_grant", badRt.status === 400 && (await badRt.json()).error === "invalid_grant");
}

// ---------------------------------------------------------------------------
step("9. legacy /mcp/<secret> path still works");
{
  const list = await rpc(`${BASE}/mcp/test`, "tools/list");
  check("tools/list via path secret (sub=default)", list.status === 200 && list.json.result.tools.length === 11);
  check("wrong secret → 404", (await fetch(`${BASE}/mcp/wrong`, { method: "POST", body: "{}" })).status === 404);
  check("GET /mcp/test → 405", (await fetch(`${BASE}/mcp/test`)).status === 405);
}

// ---------------------------------------------------------------------------
step("10. legacy routes intact");
{
  check("GET / → 200 banner", (await fetch(`${BASE}/`)).status === 200);
  check("/tts without token → 401", (await fetch(`${BASE}/tts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"text":"hi"}' })).status === 401);
  check("/content without token → 401", (await fetch(`${BASE}/content`)).status === 401);
}

// ---------------------------------------------------------------------------
step("cleanup: delete josh@test.com test blobs");
{
  // The OAuth access token is the same HMAC compact format lib/auth.mjs verifies,
  // so it authorizes /content for users/josh@test.com — used here for cleanup.
  // Blob listing is eventually consistent, so retry until the freshly written
  // blobs become visible for deletion (up to ~60s).
  const auth = { Authorization: `Bearer ${accessToken}` };
  const del = async (name) => {
    for (let i = 0; i < 12; i++) {
      const r = await fetch(`${BASE}/content/${name}`, { method: "DELETE", headers: auth });
      if (r.status === 200) return true;
      await new Promise((r2) => setTimeout(r2, 5000));
    }
    return false;
  };
  check("deleted users/josh@test.com/srs.json", await del("srs.json"));
  check("deleted users/josh@test.com/drill-log.json", await del("drill-log.json"));
}

console.log(`\n================ RESULT: ${pass} passed, ${fail} failed ================`);
server.kill();
process.exit(fail ? 1 : 0);
