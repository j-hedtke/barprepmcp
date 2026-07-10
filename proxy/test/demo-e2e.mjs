// End-to-end local test of the demo choreography (DEMO_SUB / DEMO_SCRIPT in
// proxy/lib/mcp.mjs). Run from proxy/:  node test/demo-e2e.mjs
// Spawns the proxy on :8795 with the demo account provisioned via DRILL_USERS,
// mints an OAuth access token through the real register → authorize → token
// dance, and drives the fixed serve script end to end: typed cloze with a hint
// (verdict-fail lapse) → MCQ by letter → the SAME first card requeued despite
// its future due time → recite two-step — asserting the script cursor advances
// ONLY on actually-recorded reviews (not on needs_verdict / needs_rating /
// get_hint), that grading/lapse/hint machinery is the real thing, and that the
// account falls through to normal scheduling once the script is exhausted.
// Needs a real BLOB_READ_WRITE_TOKEN — from the environment, or read at
// runtime from proxy/.env.local (never committed). Writes (and then deletes)
// users/demo@barprepmcp.com/{srs.json, drill-log.json}. NOTE the same ≤60s
// Blob edge-cache staleness caveat as the other suites: the pre-clean step
// polls until the demo state is verifiably absent before asserting.
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

const PORT = Number(process.env.TEST_PORT) || 8795;
const BASE = `http://127.0.0.1:${PORT}`;
const DEMO_EMAIL = "demo@barprepmcp.com"; // must equal DEMO_SUB in lib/mcp.mjs
const DEMO_CODE = "demopass123";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

const server = spawn("node", ["index.mjs"], {
  cwd: WT,
  env: {
    ...process.env,
    BLOB_READ_WRITE_TOKEN: BLOB,
    MCP_SECRET: "test",
    AUTH_SECRET: "testsecret",
    DRILL_USERS: `${DEMO_EMAIL}:${DEMO_CODE}`,
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
const show = (o) => console.log("  " + JSON.stringify(o).slice(0, 600));

const cards = JSON.parse(fs.readFileSync(`${WT}/data/cards.json`, "utf8")).cards;
const byId = new Map(cards.map((c) => [c.id, c]));
const civpro = byId.get("fc-civpro-0052"); // script steps 0 and 2
const misrep = byId.get("fc-evidence-0014"); // script step 1
const partPerf = byId.get("fc-contracts-0076"); // script step 3

// ---------------------------------------------------------------------------
step("OAuth dance: register → authorize (DRILL_USERS) → token");
let accessToken;
{
  const reg = await (await fetch(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT_URI], client_name: "demo-e2e", token_endpoint_auth_method: "none" }),
  })).json();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authRes = await fetch(`${BASE}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      action: "signin",
      response_type: "code",
      client_id: reg.client_id,
      redirect_uri: REDIRECT_URI,
      state: "demo-e2e",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "drill",
      resource: `${BASE}/mcp`,
      email: DEMO_EMAIL,
      access_code: DEMO_CODE,
    }).toString(),
    redirect: "manual",
  });
  const loc = authRes.headers.get("location") || "";
  check("credentials accepted → 302 with code", authRes.status === 302 && loc.startsWith(REDIRECT_URI));
  const code = loc ? new URL(loc).searchParams.get("code") : null;
  const tok = await (await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, client_id: reg.client_id, code_verifier: verifier }).toString(),
  })).json();
  accessToken = tok.access_token;
  check("access token minted for the demo account", typeof accessToken === "string" && accessToken.length > 20);
}
const AUTH = { Authorization: `Bearer ${accessToken}` };

let rpcId = 0;
async function call(tool, args = {}) {
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const res = (await r.json())?.result;
  if (!res) return { isError: true, text: `http ${r.status}` };
  if (res.isError) return { isError: true, text: res.content[0].text };
  return JSON.parse(res.content[0].text);
}

// ---------------------------------------------------------------------------
step("pre-clean: demo blobs verifiably absent (script must start at step 0)");
{
  // Delete BEFORE any tool call so the spawned server's in-process caches are
  // never primed with leftover state, then poll until the listing agrees —
  // Blob listing/edge cache would otherwise let a crashed prior run leak in.
  await fetch(`${BASE}/content/srs.json`, { method: "DELETE", headers: AUTH });
  await fetch(`${BASE}/content/drill-log.json`, { method: "DELETE", headers: AUTH });
  let clean = false;
  for (let i = 0; i < 12 && !clean; i++) {
    if ((await fetch(`${BASE}/content/srs.json`, { headers: AUTH })).status === 404) clean = true;
    else await new Promise((r) => setTimeout(r, 5000));
  }
  check("users/demo/srs.json absent", clean);
}
const runStart = new Date().toISOString();

// ---------------------------------------------------------------------------
step("step 0: fc-civpro-0052 as TYPED cloze (forced on a new card)");
{
  const c = await call("next_card");
  show(c);
  check("serves fc-civpro-0052", c.card_id === "fc-civpro-0052");
  check("mode forced to typed cloze on a NEW card (normal resolution would say cloze-mcq)", c.mode === "cloze" && c.is_new_card === true && !("options" in c));
  check("blanked prompt built like a normal serve, no answer leak", c.prompt.includes("_____") && !c.prompt.includes(civpro.answer) && c.prompt.startsWith(civpro.statement.slice(0, 40)));
}

step("step 0: get_hint works and does NOT advance the script");
{
  const h = await call("get_hint", { card_id: "fc-civpro-0052", mode: "cloze" });
  show(h);
  check("stored cloze hint served verbatim", h.hint === civpro.hintCloze);
  const again = await call("next_card");
  check("script unmoved after get_hint (same serve)", again.card_id === "fc-civpro-0052" && again.mode === "cloze");
}

step("step 0: wrong typed answer → needs_verdict (unrecorded) → verdict fail records the lapse");
{
  const esc = await call("submit_review", { card_id: "fc-civpro-0052", mode: "cloze", user_answer: "an appeal was fully exhausted" });
  show(esc);
  check("wrong answer escalates through the normal matcher (nothing recorded)", esc.needs_verdict === true && esc.answer === civpro.answer && !("card_stats" in esc));
  const again = await call("next_card");
  check("needs_verdict did NOT advance the script (same serve again)", again.card_id === "fc-civpro-0052" && again.mode === "cloze");
  const r = await call("submit_review", { card_id: "fc-civpro-0052", mode: "cloze", verdict: "fail" });
  show(r);
  check("verdict fail → real lapse math (quality 2, reps 0, lapses 1, due ~10min)", r.correct === false && r.quality === 2 && r.card_stats.reps === 0 && r.card_stats.lapses === 1 && r.next_due_days <= 0.01);
  check("hint quality cap engaged on the recorded review (hint_used)", r.hint_used === true);
}

// ---------------------------------------------------------------------------
step("step 1: fc-evidence-0014 as cloze-mcq; correct letter records via persisted serve");
{
  const c = await call("next_card");
  show(c);
  check("recorded lapse advanced the script → fc-evidence-0014 cloze-mcq", c.card_id === "fc-evidence-0014" && c.mode === "cloze-mcq");
  check("4 shuffled options include the answer; prompt blanked", c.options?.length === 4 && c.options.includes(misrep.answer) && c.prompt.includes("_____"));
  const letter = "ABCD"[c.options.indexOf(misrep.answer)];
  const r = await call("submit_review", { card_id: c.card_id, mode: "cloze-mcq", user_answer: letter });
  show({ letter, correct: r.correct, quality: r.quality });
  check(`correct letter "${letter}" maps through lastServe → correct, quality 5`, r.correct === true && r.quality === 5 && r.card_stats.reps === 1);
}

// ---------------------------------------------------------------------------
step("step 2: the requeue moment — fc-civpro-0052 AGAIN despite its future due time");
{
  const c = await call("next_card");
  show(c);
  check("SAME card fc-civpro-0052 re-served as typed cloze", c.card_id === "fc-civpro-0052" && c.mode === "cloze");
  check("served early: its lapse due-time (~10min out) is in the future", c.due_status === "early-review" && c.is_new_card === false);
  const r = await call("submit_review", { card_id: c.card_id, mode: "cloze", user_answer: civpro.answer });
  show({ correct: r.correct, quality: r.quality, reps: r.card_stats.reps });
  check("exact typed answer → quality 5, recovery rep after the lapse", r.correct === true && r.quality === 5 && r.card_stats.reps === 1 && r.card_stats.lapses === 1);
  check("hint cap was consumed by step 0 — no lingering hint_used", !("hint_used" in r));
}

// ---------------------------------------------------------------------------
step("step 3: recite of the part-performance land-sale rule (two-step)");
{
  const c = await call("next_card");
  show(c);
  check("serves fc-contracts-0076 as recite", c.card_id === "fc-contracts-0076" && c.mode === "recite");
  check("recite prompt names the rule, withholds the statement", c.prompt.startsWith("Recite the rule: Part Performance Exception to the Statute of Frauds") && !c.prompt.includes(partPerf.statement));
  const s1 = await call("submit_review", {
    card_id: c.card_id,
    mode: "recite",
    user_answer: "an oral land-sale contract is enforceable with two of: payment, possession, substantial improvements",
  });
  check("recite step 1 → needs_rating + canonical statement, nothing recorded", s1.needs_rating === true && s1.canonical_statement === partPerf.statement && !("card_stats" in s1));
  const again = await call("next_card");
  check("needs_rating did NOT advance the script (recite re-served)", again.card_id === "fc-contracts-0076" && again.mode === "recite");
  const r = await call("submit_review", { card_id: c.card_id, mode: "recite", rating: 4 });
  show({ correct: r.correct, quality: r.quality, seen: r.card_stats.seen });
  check("rating 4 records through the normal recite machinery", r.correct === true && r.quality === 4 && r.card_stats.seen === 1);
}

// ---------------------------------------------------------------------------
step("get_stats reflects the recorded demo history");
{
  const s = await call("get_stats");
  show(s.totals);
  // The demo account overlays a fabricated volume baseline (412/353/286 + streak/due numbers) for filming.
  check("baseline + 4 reviews, +3 correct, +3 started", s.totals.card_reviews === 416 && s.totals.card_correct === 356 && s.totals.cards_started === 289);
  const d = await call("get_due_summary");
  // reviews_today derives from drill-log.json, which can trail by the 60s Blob
  // edge cache on rapid reruns; exact event counts are asserted in the
  // persistence section instead.
  check("baseline + session reviews today", d.reviews_today >= 30 && d.reviews_today <= 31);
}

// ---------------------------------------------------------------------------
step("script exhausted: next_card falls back to normal scheduling");
let extraId;
{
  const c = await call("next_card");
  show(c);
  extraId = c.card_id;
  check("serves a card (no crash) outside the script", typeof c.card_id === "string" && !["fc-civpro-0052", "fc-evidence-0014", "fc-contracts-0076"].includes(c.card_id));
  check("normal auto resolution again: fresh scheduler pick is a new card → cloze-mcq", c.is_new_card === true && c.mode === "cloze-mcq");
  const r = await call("submit_review", { card_id: c.card_id, mode: "cloze-mcq", user_answer: byId.get(c.card_id).answer });
  check("post-script review records normally", r.correct === true && r.quality === 5);
}

// ---------------------------------------------------------------------------
step("persistence: demoStep + scripted reviews actually in Blob");
{
  const fetchFresh = async (name, ready) => {
    // ≤60s edge cache + eventually-consistent listing — poll up to ~90s.
    for (let i = 0; i < 18; i++) {
      try {
        const doc = JSON.parse(await (await fetch(`${BASE}/content/${name}`, { headers: AUTH })).text());
        if (ready(doc)) return doc;
      } catch {}
      await new Promise((r) => setTimeout(r, 5000));
    }
    return null;
  };
  const srs = await fetchFresh("srs.json", (d) => d.demoStep === 4 && Object.keys(d.cards ?? {}).length >= 4);
  check("demoStep persisted at 4 — post-script review did not grow it", srs?.demoStep === 4);
  check("all scripted cards tracked in SM-2 state", Boolean(srs?.cards?.["fc-civpro-0052"] && srs?.cards?.["fc-evidence-0014"] && srs?.cards?.["fc-contracts-0076"] && srs?.cards?.[extraId]));
  check("fc-civpro-0052 carries both the lapse and the recovery", srs?.cards?.["fc-civpro-0052"]?.seen === 2 && srs?.cards?.["fc-civpro-0052"]?.lapses === 1);
  const log = await fetchFresh("drill-log.json", (d) => (d.events ?? []).filter((e) => e.ts >= runStart).length === 5);
  const ev = (log?.events ?? []).filter((e) => e.ts >= runStart);
  check("drill-log holds the 5 recorded reviews (4 scripted + 1 post-script)", ev.length === 5);
  check("step 0 logged as hinted verdict-fail lapse", ev[0]?.id === "fc-civpro-0052" && ev[0]?.via === "verdict" && ev[0]?.hint_used === true && ev[0]?.correct === false);
  check("step 1 logged as letter-mapped mcq pass", ev[1]?.id === "fc-evidence-0014" && ev[1]?.via === "letter" && ev[1]?.correct === true);
  check("steps 2-3 logged as typed pass + recite", ev[2]?.id === "fc-civpro-0052" && ev[2]?.mode === "cloze" && ev[2]?.correct === true && ev[3]?.id === "fc-contracts-0076" && ev[3]?.mode === "recite");
}

// ---------------------------------------------------------------------------
step("cleanup: delete demo blobs");
{
  const del = async (name) => {
    for (let i = 0; i < 12; i++) {
      const r = await fetch(`${BASE}/content/${name}`, { method: "DELETE", headers: AUTH });
      if (r.status === 200) return true;
      await new Promise((r2) => setTimeout(r2, 5000));
    }
    return false;
  };
  check("deleted users/demo/srs.json", await del("srs.json"));
  check("deleted users/demo/drill-log.json", await del("drill-log.json"));
}

console.log(`\n================ RESULT: ${pass} passed, ${fail} failed ================`);
server.kill();
process.exit(fail ? 1 : 0);
