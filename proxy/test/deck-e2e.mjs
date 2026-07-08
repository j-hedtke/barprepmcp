// End-to-end local test of per-user custom decks (upload_rules / build_deck /
// set_deck in proxy/lib/mcp.mjs, Stripe billing in proxy/lib/billing.mjs,
// card generation in proxy/lib/cardgen.mjs). Builds are Stripe-paid ONLY —
// there is no bring-your-own-Anthropic-key path.
//
// Run from proxy/:  node test/deck-e2e.mjs
//
// Spawns the proxy on :8792 (legacy /mcp/test path secret → user "default"),
// a LOCAL STUB Anthropic server on :8793 (2 valid + 1 invalid card per chunk;
// ANTHROPIC_API_BASE points at it), and a LOCAL STUB Stripe on :8794
// (create → url, retrieve → paid; STRIPE_API_BASE points at it).
// Needs a real BLOB_READ_WRITE_TOKEN — from the environment, or read at
// runtime from proxy/.env.local (never committed).
//
// Phase 1 (no ANTHROPIC_API_KEY, no STRIPE_SECRET_KEY): upload (text +
// structured); build_deck fails with the "not available" error and never
// calls Anthropic or Stripe — even when an anthropic_api_key argument is
// smuggled in.
// Phase 2 (STRIPE_SECRET_KEY set, ANTHROPIC_API_KEY unset): build_deck fails
// server_misconfigured BEFORE creating any Checkout session (never charge
// for a build the server can't run).
// Phase 3 (server key + Stripe): pay-then-continue chunked build with resume,
// offset computation, invalid-card drop, a smuggled anthropic_api_key being
// ignored (server key still used), drilling a custom card through next_card /
// get_hint / submit_review, stats/weak areas, credit consumption.
//
// Uses (and then deletes) users/default/* test blobs — don't run against a
// store holding drill state you care about. NOTE the same ≤60s Blob edge-cache
// staleness caveat as test/mcp-e2e.mjs: a re-run within a minute of a crashed
// run may see stale state; assertions are written to tolerate stale srs.json.

import { spawn } from "node:child_process";
import http from "node:http";
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

const PORT = Number(process.env.TEST_PORT) || 8792;
const ANTHROPIC_PORT = PORT + 1;
const STRIPE_PORT = PORT + 2;
const BASE = `http://127.0.0.1:${PORT}`;
const MCP = `${BASE}/mcp/test`;
const APP = { Authorization: "Bearer localtest" };
const SUBJECT = "calbar-community-property";
const SERVER_KEY = "sk-ant-server-env-key";
const SMUGGLED_KEY = "sk-ant-user-smuggled-key";

let pass = 0,
  fail = 0;
const check = (desc, cond) => {
  if (cond) { pass++; console.log(`  PASS: ${desc}`); }
  else { fail++; console.log(`  FAIL: ${desc}`); }
};
const step = (s) => console.log(`\n=== ${s} ===`);
const show = (o) => console.log("  " + JSON.stringify(o).slice(0, 500));

// ---------------------------------------------------------------------------
// Stub Anthropic server: parses the chunk's rules out of the prompt's <rules>
// block and returns cards for the chunk's FIRST THREE rules — two valid
// (answer = words 3..7 of the statement, verbatim) and one invalid (answer not
// a substring of the statement) — so each build_deck call exercises offset
// computation AND the invalid-card drop.
// ---------------------------------------------------------------------------

const anthropicCalls = [];
const HINT_CLOZE = "the gap: who does it and how"; // no 4+-letter word overlaps test answers
const HINT_RECITE = "State the actor, then the duty, then the consequence, in order.";
const answerFor = (statement) => statement.split(/\s+/).slice(3, 7).join(" ");

const anthropicStub = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/messages") {
    res.writeHead(404);
    return res.end();
  }
  let body = "";
  for await (const c of req) body += c;
  const parsed = JSON.parse(body);
  anthropicCalls.push({ body: parsed, apiKey: req.headers["x-api-key"], beta: req.headers["anthropic-beta"] });
  const rules = JSON.parse(parsed.messages[0].content.match(/<rules>\n([\s\S]*?)\n<\/rules>/)[1]);
  const cards = rules.slice(0, 3).map((r, i) =>
    i === 2
      ? { ruleId: r.id, answer: "ZZZ NOT PRESENT ANYWHERE IN THE STATEMENT", distractors: ["a1 b1", "a2 b2", "a3 b3"], hintRecite: HINT_RECITE, hintCloze: HINT_CLOZE }
      : {
          ruleId: r.id,
          answer: answerFor(r.statement),
          distractors: ["utterly bogus alternative one", "utterly bogus alternative two", "utterly bogus alternative three"],
          hintRecite: HINT_RECITE,
          hintCloze: HINT_CLOZE,
          acceptable: [],
        }
  );
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      id: "msg_stub",
      type: "message",
      role: "assistant",
      model: parsed.model,
      stop_reason: "end_turn",
      content: [{ type: "text", text: "```json\n" + JSON.stringify({ cards }) + "\n```" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  );
});

// ---------------------------------------------------------------------------
// Stub Stripe server: POST /v1/checkout/sessions → session with url;
// GET /v1/checkout/sessions/:id → payment_status "paid" for known sessions,
// 404 for unknown ids (so a stale pendingSession from an old run is discarded).
// ---------------------------------------------------------------------------

const stripeSessions = new Map(); // id -> parsed create form
const stripeCalls = { create: [], retrieve: [] };
const stripeStub = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/v1/checkout/sessions") {
    let body = "";
    for await (const c of req) body += c;
    const form = Object.fromEntries(new URLSearchParams(body));
    const id = `cs_test_${stripeSessions.size + 1}`;
    stripeSessions.set(id, form);
    stripeCalls.create.push({ id, form, auth: req.headers.authorization });
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ id, url: `https://stripe.test/pay/${id}`, payment_status: "unpaid" }));
  }
  const m = req.url.match(/^\/v1\/checkout\/sessions\/([^/?]+)$/);
  if (req.method === "GET" && m) {
    const id = decodeURIComponent(m[1]);
    stripeCalls.retrieve.push(id);
    if (!stripeSessions.has(id)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "no such session" } }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ id, url: `https://stripe.test/pay/${id}`, payment_status: "paid" }));
  }
  res.writeHead(404);
  res.end();
});

await new Promise((r) => anthropicStub.listen(ANTHROPIC_PORT, r));
await new Promise((r) => stripeStub.listen(STRIPE_PORT, r));

// ---------------------------------------------------------------------------
// Proxy lifecycle + RPC helpers
// ---------------------------------------------------------------------------

let server = null;
async function startProxy(extraEnv = {}) {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.STRIPE_SECRET_KEY;
  delete env.DECK_BUILD_PRICE_CENTS;
  delete env.CARDGEN_MODEL;
  Object.assign(env, {
    BLOB_READ_WRITE_TOKEN: BLOB,
    MCP_SECRET: "test",
    APP_TOKEN: "localtest",
    PORT: String(PORT),
    ANTHROPIC_API_BASE: `http://127.0.0.1:${ANTHROPIC_PORT}`,
    STRIPE_API_BASE: `http://127.0.0.1:${STRIPE_PORT}`,
  }, extraEnv);
  server = spawn("node", ["index.mjs"], { cwd: WT, env, stdio: ["ignore", "pipe", "pipe"] });
  server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  await new Promise((r) => setTimeout(r, 800));
}
function stopProxy() {
  if (server) server.kill();
  server = null;
}

let rpcId = 0;
async function call(tool, args = {}) {
  const r = await fetch(MCP, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const res = (await r.json()).result;
  if (res?.isError) return { isError: true, text: res.content[0].text };
  return JSON.parse(res.content[0].text);
}

const TEST_BLOBS = ["custom-rules.json", "custom-cards.json", "prefs.json", "billing.json", "build-state.json", "srs.json", "drill-log.json"];
async function deleteTestBlobs() {
  for (const name of TEST_BLOBS) {
    await fetch(`${BASE}/content/${name}`, { method: "DELETE", headers: APP }).catch(() => {});
  }
}

// Test rules: answer = words 3..7 ("provides that every responsible") is an
// exact substring of every statement; none of its 4+-letter words appear in
// the stub's hintCloze.
const mkStatement = (i) =>
  `Rule number ${i} provides that every responsible party bears the burden of production and persuasion under condition ${i}.`;
const structuredRules = [
  ...Array.from({ length: 11 }, (_, k) => ({
    name: `Test rule ${k + 1}`,
    statement: mkStatement(k + 1),
    subject: SUBJECT,
    subtopic: "test-subtopic",
    priority: "H",
  })),
  { name: "Too short", statement: "Way too short to count." }, // < 8 words → skipped
];
// After upload, rule ids are custom-rule-001..011; valid cards are built for
// the first two rules of each chunk: 001, 002 (chunk 1) and 009, 010 (chunk 2).
const ruleStatementById = new Map(Array.from({ length: 11 }, (_, k) => [`custom-rule-${String(k + 1).padStart(3, "0")}`, mkStatement(k + 1)]));

// ===========================================================================
// PHASE 1 — no server key, no Stripe: uploads work; builds are unavailable.
// ===========================================================================

await startProxy();
step("phase 1: pre-clean test blobs");
await deleteTestBlobs();

step("upload_rules — text fallback (paragraph/numbered items)");
{
  const text =
    "1. The covenant of quiet enjoyment bars a landlord from materially disturbing the tenant possession.\n" +
    "2. A holdover tenant may be bound to a new periodic tenancy at the landlord option.\n\n" +
    "Community property acquired during marriage is owned one half by each spouse absent an agreement.";
  const r = await call("upload_rules", { text, mode: "replace" });
  show(r);
  check("3 rules parsed from text (numbered items + paragraph)", r.rules_total === 3 && r.added === 3);
  const rules = await call("upload_rules", { text: "short one.\n\nAnother statement that is definitely longer than eight words in total length.", mode: "add" });
  check("add merges and skips <8-word statements", rules.rules_total === 4 && rules.skipped_too_short === 1);
}

step("upload_rules — structured, mode replace, 500-cap field defaults");
{
  const r = await call("upload_rules", { rules: structuredRules, mode: "replace" });
  show(r);
  check("11 valid rules stored, 1 too-short skipped", r.rules_total === 11 && r.added === 11 && r.skipped_too_short === 1);
  check("reminder to call build_deck", /build_deck/.test(r.note));
  const bad = await call("upload_rules", {});
  check("no rules/text -> helpful error", bad.isError === true && /rules|text/.test(bad.text));
}

step("build_deck — Stripe unconfigured -> 'not available' error, no side effects");
{
  const r = await call("build_deck", {});
  show(r);
  check("preview easter egg (non-error, interest noted)", r.isError !== true && r.available === false && r.interest_noted === true && /switched on/.test(r.message) && /first in line/.test(r.message));
  check("no user-key escape hatch offered", !/anthropic_api_key/.test(r.message));
  const smuggled = await call("build_deck", { anthropic_api_key: SMUGGLED_KEY });
  check("smuggled anthropic_api_key argument changes nothing (same preview response)", smuggled.available === false && smuggled.interest_noted === true);
  check("Anthropic stub never called", anthropicCalls.length === 0);
  check("Stripe stub never called", stripeCalls.create.length === 0 && stripeCalls.retrieve.length === 0);
}

// ===========================================================================
// PHASE 2 — Stripe configured but ANTHROPIC_API_KEY unset: fail loudly
// BEFORE creating any Checkout session (never charge when we can't build).
// ===========================================================================

step("phase 2: restart proxy with Stripe configured but NO server Anthropic key");
stopProxy();
await startProxy({ STRIPE_SECRET_KEY: "sk_test_stub_secret" });

{
  const up = await call("upload_rules", { rules: structuredRules.slice(0, 3), mode: "replace" });
  check("3 rules stored for the misconfigured-server attempt", up.rules_total === 3);
  const r = await call("build_deck", {});
  show(r);
  check("server_misconfigured error", r.isError === true && /server_misconfigured/.test(r.text) && /ANTHROPIC_API_KEY/.test(r.text));
  check("says no payment was requested", /[Nn]o payment was requested/.test(r.text));
  check("NO checkout session was created", stripeCalls.create.length === 0);
  check("no Stripe call of any kind", stripeCalls.retrieve.length === 0);
  check("Anthropic stub still never called", anthropicCalls.length === 0);
}

// ===========================================================================
// PHASE 3 — server key + Stripe: the pay-then-continue chunked build, then
// drilling the custom cards.
// ===========================================================================

step("phase 3: restart proxy with server key + Stripe configured");
stopProxy();
await startProxy({
  ANTHROPIC_API_KEY: SERVER_KEY,
  STRIPE_SECRET_KEY: "sk_test_stub_secret",
  DECK_BUILD_PRICE_CENTS: "1234",
});

{
  const r = await call("upload_rules", { rules: structuredRules, mode: "replace" });
  show(r);
  check("11 fresh rules stored (build state + custom cards reset)", r.rules_total === 11);
}

step("build_deck without a credit -> Stripe Checkout session");
{
  const r = await call("build_deck", {});
  show(r);
  check("payment required with checkout url", r.payment_required === true && /^https:\/\/stripe\.test\/pay\/cs_test_/.test(r.checkout_url));
  check("price from DECK_BUILD_PRICE_CENTS", r.price_usd === 12.34);
  check("'pay here, then continue' message", /pay here/i.test(r.message) && /continue/i.test(r.message));
  const created = stripeCalls.create.at(-1);
  check("session: mode=payment, client_reference_id=default", created.form.mode === "payment" && created.form.client_reference_id === "default");
  check("inline price_data: usd, 1234 cents, 'Custom deck build'", created.form["line_items[0][price_data][currency]"] === "usd" && created.form["line_items[0][price_data][unit_amount]"] === "1234" && created.form["line_items[0][price_data][product_data][name]"] === "Custom deck build");
  check("success/cancel land on <origin>/billing/success", created.form.success_url === `${BASE}/billing/success` && created.form.cancel_url === `${BASE}/billing/success`);
  check("authorized with STRIPE_SECRET_KEY", created.auth === "Bearer sk_test_stub_secret");
  check("no generation before payment", anthropicCalls.length === 0);
}

step("GET /billing/success serves the landing page");
{
  const r = await fetch(`${BASE}/billing/success`);
  const html = await r.text();
  check("200 html telling the user to continue in Claude", r.status === 200 && /Payment received/.test(html) && /continue building my deck/.test(html));
}

step("build_deck after payment -> credit granted + consumed, chunk 1 of 2 (8 rules, 2 valid + 1 invalid card)");
{
  const r = await call("build_deck", {});
  show(r);
  check("stripe session retrieved and found paid", stripeCalls.retrieve.at(-1) === stripeCalls.create.at(-1).id);
  check("not done, nextIndex 8, remaining 3", r.done === false && r.nextIndex === 8 && r.totalRules === 11 && r.remaining === 3);
  check("2 cards added, 1 invalid dropped", r.cards_added === 2 && r.cards_dropped_invalid === 1 && r.cardsBuilt === 2);
  check("tells the client to call build_deck again", /call build_deck again/i.test(r.note));
  check("generation used the SERVER env key", anthropicCalls.length === 1 && anthropicCalls.at(-1).apiKey === SERVER_KEY);
  check("default model claude-fable-5 with server-side fallback opt-in", anthropicCalls.at(-1).body.model === "claude-fable-5" && anthropicCalls.at(-1).beta === "server-side-fallback-2026-06-01" && anthropicCalls.at(-1).body.fallbacks?.[0]?.model === "claude-opus-4-8");
}

step("build_deck — resume: chunk 2 of 2 -> done: true; smuggled key argument is ignored");
{
  const r = await call("build_deck", { anthropic_api_key: SMUGGLED_KEY });
  show(r);
  check("done, all 11 rules consumed, 4 cards built", r.done === true && r.nextIndex === 11 && r.cardsBuilt === 4 && r.remaining === 0);
  check("smuggled key NOT forwarded — server key still used", anthropicCalls.at(-1).apiKey === SERVER_KEY);
  const again = await call("build_deck", {});
  check("further calls report already complete", again.done === true && /complete/i.test(again.note));
  check("exactly 2 Anthropic calls total (one per chunk)", anthropicCalls.length === 2);
}

step("set_deck custom + get_due_summary honors it");
{
  const r = await call("set_deck", { deck: "custom" });
  show(r);
  check("custom deck active with 4 cards", r.deck === "custom" && r.total_cards === 4);
  const s = await call("get_due_summary");
  check("due summary scoped to custom deck", s.deck === "custom" && s.total_cards === 4);
  check("custom subject bucket present", s.by_subject[SUBJECT] != null);
  const bad = await call("set_deck", { deck: "bogus" });
  check("bad deck value rejected", bad.isError === true);
}

step("next_card serves a custom card — server-computed cloze offsets check out");
let cardId, cardAnswer;
{
  const c = await call("next_card", { mode: "cloze" });
  show(c);
  const ruleId = c.card_id.replace(/^cfc-/, "");
  const statement = ruleStatementById.get(ruleId);
  cardId = c.card_id;
  cardAnswer = answerFor(statement);
  const expectedPrompt = statement.replace(cardAnswer, "_____");
  check("custom card served", c.is_custom_card === true && c.card_id.startsWith("cfc-custom-rule-"));
  check("subject/subtopic are the custom strings", c.subject === SUBJECT && c.subtopic === "test-subtopic");
  check("prompt blanks exactly the answer span (indexOf offsets)", c.prompt === expectedPrompt && !c.prompt.includes(cardAnswer));
}

step("get_hint works on a custom card (and caps the review at quality 4)");
{
  const h = await call("get_hint", { card_id: cardId, mode: "cloze" });
  show(h);
  check("stored hintCloze returned verbatim", h.hint === HINT_CLOZE);
  const r = await call("submit_review", { card_id: cardId, mode: "cloze", user_answer: cardAnswer });
  show(r);
  check("graded correct with hint cap (quality 4)", r.correct === true && r.quality === 4 && r.hint_used === true);
  check("server-pass path records in one call (no needs_verdict on an exact answer)", !("needs_verdict" in r));
  check("SM-2 scheduled: interval ~1 day, canonical statement revealed", r.next_due_days > 0.9 && r.next_due_days <= 1.01 && r.canonical_statement === ruleStatementById.get(cardId.replace(/^cfc-/, "")));
}

step("typed cloze escalation on a custom card — needs_verdict, then verdict records");
{
  const esc = await call("submit_review", { card_id: cardId, mode: "cloze", user_answer: "entirely different legal standard" });
  show(esc);
  check(
    "unmatched answer -> needs_verdict with answer + acceptable, nothing recorded",
    esc.needs_verdict === true && esc.answer === cardAnswer && Array.isArray(esc.acceptable) && !("card_stats" in esc) && /verdict/.test(esc.instructions)
  );
  const v = await call("submit_review", { card_id: cardId, mode: "cloze", verdict: "fail" });
  show(v);
  check("verdict 'fail' records wrong at quality 2 (lapse)", v.correct === false && v.quality === 2 && v.card_stats.lapses >= 1 && v.card_stats.reps === 0);
  const bad = await call("submit_review", { card_id: cardId, mode: "cloze", verdict: "kinda" });
  check("invalid verdict rejected", bad.isError === true && /"pass" or "fail"/.test(bad.text));
}

step("set_deck both — merged pool still reaches custom cards; grading + scheduling");
{
  const r = await call("set_deck", { deck: "both" });
  const s = await call("get_due_summary");
  check("both = bundled + custom pool", r.deck === "both" && s.total_cards === r.total_cards && s.total_cards > 4);
  const c = await call("next_card", { subject: SUBJECT, mode: "cloze" });
  show(c);
  check("subject filter reaches the custom deck inside 'both'", c.is_custom_card === true && c.subject === SUBJECT);
  const ans = answerFor(ruleStatementById.get(c.card_id.replace(/^cfc-/, "")));
  const rev = await call("submit_review", { card_id: c.card_id, mode: c.mode === "cloze-mcq" ? "cloze-mcq" : "cloze", user_answer: ans });
  show(rev);
  check("custom card graded + scheduled through the same SM-2 path", rev.correct === true && rev.quality >= 4 && rev.card_stats.reps >= 1 && typeof rev.next_due === "string");
}

step("get_stats / get_weak_areas honor the deck preference");
{
  await call("set_deck", { deck: "custom" });
  const s = await call("get_stats");
  show(s.totals);
  check("stats scoped to the 4-card custom deck", s.deck === "custom" && s.totals.cards_in_deck === 4 && s.totals.card_reviews >= 2);
  check("per-subject bucket for the custom subject", s.per_subject[SUBJECT] != null && s.per_subject[SUBJECT].card_reviews >= 2);
  const w = await call("get_weak_areas", { limit: 10 });
  show(w);
  check("weak areas include the custom subject (uniform fallback ratio)", w.weak_areas.some((a) => a.subject === SUBJECT && a.card_reviews >= 1));
}

step("credit was consumed — a NEW build requires a NEW payment");
{
  await call("upload_rules", { rules: structuredRules.slice(0, 2), mode: "replace" });
  const r = await call("build_deck", {});
  show(r);
  check("payment required again with a fresh session", r.payment_required === true && stripeCalls.create.length === 2 && r.checkout_url.endsWith(stripeCalls.create.at(-1).id));
}

step("no user-supplied key ever reached the Anthropic API");
{
  check("every Anthropic call used the server env key", anthropicCalls.length === 2 && anthropicCalls.every((c) => c.apiKey === SERVER_KEY));
  check("the smuggled key never appeared in any call", anthropicCalls.every((c) => c.apiKey !== SMUGGLED_KEY && !JSON.stringify(c.body).includes(SMUGGLED_KEY)));
}

step("cleanup: delete test blobs");
{
  await call("set_deck", { deck: "default" }).catch(() => {});
  let deleted = 0;
  for (const name of TEST_BLOBS) {
    const r = await fetch(`${BASE}/content/${name}`, { method: "DELETE", headers: APP });
    if (r.status === 200 || r.status === 404) deleted++;
  }
  check(`test blobs removed (${deleted}/${TEST_BLOBS.length})`, deleted === TEST_BLOBS.length);
}

console.log(`\n================ RESULT: ${pass} passed, ${fail} failed ================`);
stopProxy();
anthropicStub.close();
stripeStub.close();
process.exit(fail ? 1 : 0);
