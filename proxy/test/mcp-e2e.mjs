// End-to-end local test of the MCP drill server (proxy/lib/mcp.mjs).
// Run from proxy/:  node test/mcp-e2e.mjs
// Spawns the proxy on :8788 and drives the full drill over JSON-RPC, verifying
// SM-2 state persists in Blob. Needs a real BLOB_READ_WRITE_TOKEN — from the
// environment, or read at runtime from proxy/.env.local (never committed).
// Uses (and then deletes) users/default/{srs.json, drill-log.json} — don't run
// against a store holding drill state you care about.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gradeTyped, stemToken, levenshtein } from "../lib/srs.mjs";
import { extractMcqLetter } from "../lib/mcp.mjs";

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

const PORT = Number(process.env.TEST_PORT) || 8788;
const BASE = `http://127.0.0.1:${PORT}`;
const MCP = `${BASE}/mcp/test`;
const APP = { Authorization: "Bearer localtest" };

const server = spawn("node", ["index.mjs"], {
  cwd: WT,
  env: { ...process.env, BLOB_READ_WRITE_TOKEN: BLOB, MCP_SECRET: "test", APP_TOKEN: "localtest", PORT: String(PORT) },
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

let rpcId = 0;
async function rpcRaw(body, expectJson = true) {
  const r = await fetch(MCP, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  const text = await r.text();
  return { status: r.status, json: expectJson && text ? JSON.parse(text) : null, text };
}
async function rpc(method, params) {
  const { json } = await rpcRaw(JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, ...(params ? { params } : {}) }));
  return json;
}
async function call(tool, args = {}) {
  const res = await rpc("tools/call", { name: tool, arguments: args });
  const r = res.result;
  if (r?.isError) return { isError: true, text: r.content[0].text };
  return JSON.parse(r.content[0].text);
}

const cards = JSON.parse(fs.readFileSync(`${WT}/data/cards.json`, "utf8")).cards;
const questions = JSON.parse(fs.readFileSync(`${WT}/data/questions.json`, "utf8")).questions;

// 0. pre-clean leftover state. NOTE: Blob reads sit behind a ≤60s edge cache,
// so a re-run within a minute may still see the previous run's state server-
// side. Aggregate assertions below are therefore DELTAS against a baseline.
await fetch(`${BASE}/content/srs.json`, { method: "DELETE", headers: APP });
await fetch(`${BASE}/content/drill-log.json`, { method: "DELETE", headers: APP });
const runStart = new Date().toISOString();

step("path secret / method handling");
check("wrong secret -> 404", (await fetch(`${BASE}/mcp/wrong`, { method: "POST", body: "{}" })).status === 404);
check("GET /mcp/test -> 405", (await fetch(MCP)).status === 405);
check("DELETE /mcp/test -> 405", (await fetch(MCP, { method: "DELETE" })).status === 405);

step("initialize");
{
  const res = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  show(res);
  check("echoes client protocolVersion", res.result.protocolVersion === "2025-06-18");
  check("serverInfo + tools capability", res.result.serverInfo.name === "aibarprep-drill" && "tools" in res.result.capabilities);
}

step("notifications/initialized -> 202 empty body");
{
  const { status, text } = await rpcRaw(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), false);
  check("202 + empty", status === 202 && text === "");
}

step("ping / unknown method / parse error");
check("ping -> {}", JSON.stringify((await rpc("ping")).result) === "{}");
check("unknown method -> -32601", (await rpc("bogus/method")).error?.code === -32601);
check("parse error -> -32700", (await rpcRaw("not json{{{")).json.error.code === -32700);

step("tools/list");
{
  const res = await rpc("tools/list");
  const names = res.result.tools.map((t) => t.name);
  console.log("  tools:", names.join(", "));
  check("12 tools", names.length === 12);
  check("every tool has description + inputSchema", res.result.tools.every((t) => t.description.length > 40 && t.inputSchema.type === "object"));
}

step("get_due_summary (baseline)");
let base;
{
  const s = await call("get_due_summary");
  show(s);
  const st = await call("get_stats");
  base = { ...st.totals, reviews_today: s.reviews_today };
  check(`bundled content: ${cards.length} cards / ${questions.length} questions`, s.total_cards === cards.length && s.total_mbe_questions === questions.length);
  const subjectCount = JSON.parse(fs.readFileSync(`${WT}/data/blueprint.json`, "utf8")).subjects.length;
  check("per-subject breakdown + suggested session present", Object.keys(s.by_subject).length >= subjectCount && typeof s.suggested_session === "string");
}

step("next_card (auto: new card -> cloze-mcq, no answer leak)");
let cardId, cardAnswer;
{
  const c = await call("next_card");
  show(c);
  const card = cards.find((x) => x.id === c.card_id);
  cardId = c.card_id; cardAnswer = card.answer;
  check("mode cloze-mcq for new card", c.mode === "cloze-mcq");
  check("prompt blanked, no answer text", c.prompt.includes("_____") && !c.prompt.includes(card.answer));
  check("4 shuffled options incl. answer", c.options.length === 4 && c.options.includes(card.answer));
  check("no statement/answer fields leaked", !("answer" in c) && !("statement" in c) && !("canonical_statement" in c));
}

step("submit_review — cloze-mcq CORRECT (SM-2 first rep -> 1 day)");
{
  const r = await call("submit_review", { card_id: cardId, mode: "cloze-mcq", user_answer: cardAnswer });
  show(r);
  check("correct, quality 5", r.correct === true && r.quality === 5);
  check("one round-trip: no needs_verdict on an exact answer", !("needs_verdict" in r));
  check("reps=1, interval 1d, ease 2.6", r.card_stats.reps === 1 && r.card_stats.interval_days === 1 && r.card_stats.ease === 2.6);
  check("next_due ≈ 1 day", r.next_due_days > 0.9 && r.next_due_days <= 1.01);
}

step("submit_review — typed cloze WRONG -> needs_verdict escalation (nothing recorded)");
{
  const before = (await call("get_stats")).totals;
  const esc = await call("submit_review", { card_id: cardId, mode: "cloze", user_answer: "complete nonsense wrong answer" });
  show(esc);
  check(
    "needs_verdict with answer + acceptable + statement + user_answer echoed",
    esc.needs_verdict === true && esc.answer === cardAnswer && Array.isArray(esc.acceptable) && esc.canonical_statement.length > 0 && esc.user_answer === "complete nonsense wrong answer" && esc.rule_name.length > 0
  );
  check(
    "rubric instructions: strict semantics / lax syntax / unsure -> FAIL / call again with verdict",
    /STRICT on semantics/.test(esc.instructions) && /LAX on syntax/.test(esc.instructions) && /unsure, FAIL/.test(esc.instructions) && /verdict: 'pass' or 'fail'/.test(esc.instructions)
  );
  check("nothing scheduled or recorded yet", !("card_stats" in esc) && !("next_due" in esc) && !("correct" in esc));
  const after = (await call("get_stats")).totals;
  check("stats unchanged until the verdict", after.card_reviews === before.card_reviews && after.card_correct === before.card_correct);
}

step("submit_review — verdict 'fail' records the lapse (10 min, ease -0.2, reps reset)");
{
  const r = await call("submit_review", { card_id: cardId, mode: "cloze", verdict: "fail" });
  show(r);
  check("wrong, quality 2, reveals answer + statement", r.correct === false && r.quality === 2 && r.answer === cardAnswer && r.canonical_statement.length > 0);
  check("lapse: reps 0, lapses 1, ease 2.4, due ~10min", r.card_stats.reps === 0 && r.card_stats.lapses === 1 && r.card_stats.ease === 2.4 && r.next_due_days <= 0.01);
}

step("submit_review — typed cloze FUZZY (1 typo -> server-pass quality 4, one call)");
{
  const typo = cardAnswer.slice(0, -1) + (cardAnswer.endsWith("x") ? "y" : "x");
  const r = await call("submit_review", { card_id: cardId, mode: "cloze", user_answer: typo });
  show({ typo, correct: r.correct, quality: r.quality });
  check("fuzzy match: correct, quality 4", r.correct === true && r.quality === 4);
  check("server-pass path records in one call (no needs_verdict)", !("needs_verdict" in r) && r.card_stats.reps === 1);
}

step("submit_review — verdict 'pass' records correct at quality 4");
{
  const esc = await call("submit_review", { card_id: cardId, mode: "cloze", user_answer: "entirely different words the matcher rejects" });
  check("semantically-different answer escalates", esc.needs_verdict === true);
  const r = await call("submit_review", { card_id: cardId, mode: "cloze", verdict: "pass" });
  show(r);
  check("pass verdict: correct, quality 4", r.correct === true && r.quality === 4);
  check("scheduled exactly once: reps 2, interval 3d", r.card_stats.reps === 2 && r.card_stats.interval_days === 3);
}

step("submit_review — verdict after hint: caps combine (min of caps -> quality 4, hint_used)");
{
  const h = await call("get_hint", { card_id: cardId, mode: "cloze" });
  show(h);
  check("hint served for the pending review", typeof h.hint === "string" && h.hint.length > 0);
  const esc = await call("submit_review", { card_id: cardId, mode: "cloze", user_answer: "still not the right words at all" });
  check("hinted attempt still escalates (hint cap survives, unrecorded)", esc.needs_verdict === true);
  const r = await call("submit_review", { card_id: cardId, mode: "cloze", verdict: "pass" });
  show(r);
  check("verdict pass after hint: quality 4 with hint_used", r.correct === true && r.quality === 4 && r.hint_used === true);
}

step("submit_review — invalid verdict rejected (nothing recorded)");
{
  const before = (await call("get_stats")).totals;
  const r = await call("submit_review", { card_id: cardId, mode: "cloze", verdict: "maybe" });
  check('verdict "maybe" -> error naming pass/fail', r.isError === true && /"pass" or "fail"/.test(r.text));
  const after = (await call("get_stats")).totals;
  check("invalid verdict recorded nothing", after.card_reviews === before.card_reviews);
}

step("gradeTyped unit — stemmed reordering, inflection, length-scaled tolerance");
{
  // The reported real-world failure: reordered + inflected phrase was graded wrong.
  const answer = "financial benefits improperly received";
  const acceptable = ["improperly received financial benefits"];
  const exact = gradeTyped("financial benefits improperly received", answer, acceptable);
  check("exact answer -> 5", exact.correct === true && exact.quality === 5);
  const alt = gradeTyped("improperly received financial benefits", answer, acceptable);
  check("exact acceptable alternate -> 5", alt.correct === true && alt.quality === 5);
  const reported = gradeTyped("Improperly receiving financial benefits", answer, acceptable);
  check("reorder + inflection (reported case) -> correct at 5", reported.correct === true && reported.quality === 5);

  check('stemmer: "receiving" and "received" share a stem', stemToken("receiving") === stemToken("received"));
  const inflect = gradeTyped("wrongfully receiving benefits", "wrongfully received benefits");
  check("inflection alone (no reorder) -> 5", inflect.correct === true && inflect.quality === 5);

  const typoReorder = gradeTyped("improperly receiving finansial benefits", answer, acceptable);
  check("one typo inside a reordered phrase -> 4", typoReorder.correct === true && typoReorder.quality === 4);

  const wrong = gradeTyped("beneficial payments knowingly accepted", answer, acceptable);
  check("genuinely wrong answer of similar length -> wrong (2)", wrong.correct === false && wrong.quality === 2);

  const short = gradeTyped("dust", "duty");
  check('short answer stays strict: "dust" vs "duty" -> wrong', short.correct === false && short.quality === 2);

  const target25 = "unconscionable agreements"; // 25 chars -> tolerance 3
  const threeEdits = "unkonzcionible agreements";
  check("tolerance fixture is 25 chars / 3 edits", target25.length === 25 && levenshtein(threeEdits, target25) === 3);
  const fuzzy25 = gradeTyped(threeEdits, target25);
  check("25-char answer with 3 edits -> 4 (length-scaled tolerance)", fuzzy25.correct === true && fuzzy25.quality === 4);
}

step("recite two-step");
{
  const c = await call("next_card", { mode: "recite" });
  show(c);
  const card = cards.find((x) => x.id === c.card_id);
  check("recite prompt = rule name only (no statement)", c.prompt.startsWith("Recite the rule:") && !c.prompt.includes(card.statement));
  check("recite card is a new card (seen 0)", c.is_new_card === true);
  const s1 = await call("submit_review", { card_id: c.card_id, mode: "recite", user_answer: "my recitation attempt of the rule" });
  show(s1);
  check("step 1: needs_rating + canonical statement, NOT scheduled", s1.needs_rating === true && s1.canonical_statement === card.statement && !("card_stats" in s1));
  check("step 1: new card gets the substance grading bar", s1.grading_bar === "substance" && /SUBSTANCE/.test(s1.instructions));
  const s2 = await call("submit_review", { card_id: c.card_id, mode: "recite", rating: 4 });
  show(s2);
  check("step 2: rating 4 -> correct, scheduled exactly once", s2.correct === true && s2.quality === 4 && s2.card_stats.seen === 1);
  const s3 = await call("submit_review", { card_id: c.card_id, mode: "recite", user_answer: "x", rating: 7 });
  check("rating clamped to 0-5", s3.quality === 5);
}

step("extractMcqLetter unit — conservative letter parsing");
{
  check('"b" -> 1', extractMcqLetter("b") === 1);
  check('"B." -> 1', extractMcqLetter("B.") === 1);
  check('"(a)" -> 0', extractMcqLetter("(a)") === 0);
  check('"option b" -> 1', extractMcqLetter("option b") === 1);
  check('"answer is c" -> 2', extractMcqLetter("answer is c") === 2);
  check('"The answer is D" -> 3', extractMcqLetter("The answer is D") === 3);
  check('"I\'ll go with c" -> 2', extractMcqLetter("I'll go with c") === 2);
  check("real answer text -> null", extractMcqLetter("financial benefits improperly received") === null);
  check('"a duty of care" -> null (letter not trailing)', extractMcqLetter("a duty of care") === null);
  check('"b and c" -> null (ambiguous)', extractMcqLetter("b and c") === null);
  check('"e" -> null (not A-D)', extractMcqLetter("e") === null);
  check("empty -> null", extractMcqLetter("") === null);
}

step("cloze-mcq letter answer — correct letter maps via the persisted serve");
let mcq1;
{
  const c = await call("next_card", { mode: "cloze" }); // fresh card -> resolves cloze-mcq
  show(c);
  mcq1 = c;
  check("fresh card resolves to cloze-mcq with 4 options", c.mode === "cloze-mcq" && c.options.length === 4);
  const card = cards.find((x) => x.id === c.card_id);
  const letter = "ABCD"[c.options.findIndex((o) => o === card.answer)];
  const r = await call("submit_review", { card_id: c.card_id, mode: "cloze-mcq", user_answer: `${letter}.` });
  show({ letter, correct: r.correct, quality: r.quality });
  check(`correct letter "${letter}." -> correct, quality 5 (the real-session bug)`, r.correct === true && r.quality === 5);
  const again = await call("submit_review", { card_id: c.card_id, mode: "cloze-mcq", user_answer: letter.toLowerCase() });
  check("letter after serve consumed -> error asking for FULL TEXT (nothing recorded)", again.isError === true && /FULL TEXT/.test(again.text));
}

step("cloze-mcq letter answer — wrong letter is a clean lapse (quality 2)");
{
  const c = await call("next_card", { mode: "cloze" });
  check("second fresh mcq serve", c.mode === "cloze-mcq" && c.options.length === 4);
  const card = cards.find((x) => x.id === c.card_id);
  const wrongIdx = (c.options.findIndex((o) => o === card.answer) + 1) % 4;
  const r = await call("submit_review", { card_id: c.card_id, mode: "cloze-mcq", user_answer: `option ${"abcd"[wrongIdx]}` });
  show({ pick: `option ${"abcd"[wrongIdx]}`, correct: r.correct, quality: r.quality });
  check('"option <x>" wrong pick -> wrong, quality 2', r.correct === false && r.quality === 2);
  check("clean lapse, no escalation: reps 0, lapses 1", r.card_stats.reps === 0 && r.card_stats.lapses === 1 && !("needs_verdict" in r));
}

step("cloze-mcq letter answer — mismatched card_id errors; full text still works");
let mcq3Id;
{
  const c = await call("next_card", { mode: "cloze" });
  check("third fresh mcq serve", c.mode === "cloze-mcq");
  mcq3Id = c.card_id;
  const card = cards.find((x) => x.id === c.card_id);
  const stale = await call("submit_review", { card_id: mcq1.card_id, mode: "cloze-mcq", user_answer: "answer is a" });
  check("letter for a card that is not the last serve -> error asking for FULL TEXT", stale.isError === true && /FULL TEXT/.test(stale.text));
  const r = await call("submit_review", { card_id: c.card_id, mode: "cloze-mcq", user_answer: card.answer });
  check("full-text option answer still grades correct in one call", r.correct === true && r.quality === 5 && !("needs_verdict" in r));
}

step("next_mbe_question (no answer leak)");
let qId, qCorrect;
{
  const q = await call("next_mbe_question", { subject: "torts" });
  show({ ...q, stem: q.stem.slice(0, 80) + "…" });
  const src = questions.find((x) => x.id === q.question_id);
  qId = q.question_id; qCorrect = src.correctIndex;
  check("torts question with 4 choices", q.subject === "torts" && q.choices.length === 4);
  check("no correctIndex/explanation leaked", !("correctIndex" in q) && !("explanation" in q) && !("rule" in q));
  const q2 = await call("next_mbe_question", { subject: "torts" });
  check("recently-served avoided on next draw", q2.question_id !== q.question_id);
  check("bad subject rejected", (await call("next_mbe_question", { subject: "bogus" })).isError === true);
}

step("submit_mbe_answer (wrong then right)");
{
  const w = await call("submit_mbe_answer", { question_id: qId, choice_index: (qCorrect + 1) % 4 });
  show({ correct: w.correct, correctIndex: w.correctIndex, rule: w.rule });
  check("wrong pick: correct=false, reveals correctIndex + explanation + rule", w.correct === false && w.correctIndex === qCorrect && w.explanation.length > 40 && w.rule.length > 0);
  const r = await call("submit_mbe_answer", { question_id: qId, choice_index: qCorrect });
  check("right pick: correct=true, stats accumulate", r.correct === true && r.question_stats.answered === 2 && r.question_stats.correct === 1);
}

step("get_stats");
{
  const s = await call("get_stats");
  show(s.totals);
  check("+10 card reviews (5 typed/mcq incl. 3 verdicts + 2 recite + 3 mcq-letter section), +8 correct", s.totals.card_reviews === base.card_reviews + 10 && s.totals.card_correct === base.card_correct + 8);
  check("+2 MBE answered, +1 correct", s.totals.mbe_answered === base.mbe_answered + 2 && s.totals.mbe_correct === base.mbe_correct + 1);
  check("per-subject unified accuracy present for torts", s.per_subject.torts.unified_accuracy !== null);
  const d = await call("get_due_summary");
  check("+12 reviews today (streak/log signal)", d.reviews_today === base.reviews_today + 12);
}

step("get_weak_areas");
{
  const w = await call("get_weak_areas", { limit: 5 });
  show(w);
  check("areas returned, sorted hardest-first", w.weak_areas.length >= 1 && w.weak_areas.every((a, i, arr) => i === 0 || arr[i - 1].priority_score >= a.priority_score));
  check("unified accuracy blends mbe + cards", w.weak_areas.every((a) => a.unified_accuracy >= 0 && a.unified_accuracy <= 1));
}

step("persistence: SM-2 state actually in Blob (users/default/srs.json via /content)");
{
  // Blob reads go through a ≤60s edge cache + eventually-consistent listing, so
  // poll until the freshly written state is visible (up to ~90s).
  const fetchFresh = async (name, ready) => {
    for (let i = 0; i < 18; i++) {
      try {
        const doc = JSON.parse(await (await fetch(`${BASE}/content/${name}`, { headers: APP })).text());
        if (ready(doc)) return doc;
      } catch {}
      await new Promise((r) => setTimeout(r, 5000));
    }
    return null;
  };
  const srs = await fetchFresh("srs.json", (d) => d.cards?.[cardId]?.seen === 5 && (d.cards?.[mcq3Id]?.seen ?? 0) >= 1);
  if (srs) console.log(`  cards tracked: ${Object.keys(srs.cards).length}, mbe tracked: ${Object.keys(srs.mbe).length}, updatedAt: ${srs.updatedAt}`);
  const st = srs?.cards?.[cardId];
  check("card SM-2 state persisted (seen/ease/due/interval)", !!st && st.seen === 5 && typeof st.ease === "number" && typeof st.due === "string" && "intervalDays" in st);
  check("mbe stats persisted", srs?.mbe?.[qId]?.answered === 2 && srs?.mbe?.[qId]?.correct === 1);
  check("lastServe cleared after the recorded mcq reviews", srs?.lastServe == null);
  const log = await fetchFresh("drill-log.json", (d) => (d.events ?? []).filter((e) => e.ts >= runStart).length === 12);
  if (log) console.log(`  drill-log events: ${log.events.length}`);
  const mine = (log?.events ?? []).filter((e) => e.ts >= runStart);
  check("drill-log persisted 12 events this run (10 card incl. clamp + 2 mbe)", mine.length === 12 && mine.every((e) => e.ts && e.type && e.subject));
  check('verdict-recorded reviews logged with via: "verdict" (1 fail + 2 pass)', mine.filter((e) => e.via === "verdict").length === 3 && mine.filter((e) => e.via === "verdict" && e.correct).length === 2);
  check('letter-mapped reviews logged with via: "letter" (1 correct + 1 wrong)', mine.filter((e) => e.via === "letter").length === 2 && mine.filter((e) => e.via === "letter" && e.correct).length === 1);
}

step("legacy routes intact");
check("/tts without token -> 401", (await fetch(`${BASE}/tts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"text":"hi"}' })).status === 401);
check("GET / -> 200 banner", (await fetch(`${BASE}/`)).status === 200);
check("/content without token -> 401", (await fetch(`${BASE}/content`)).status === 401);

step("cleanup: delete test blobs");
check("deleted srs.json", (await fetch(`${BASE}/content/srs.json`, { method: "DELETE", headers: APP })).status === 200);
check("deleted drill-log.json", (await fetch(`${BASE}/content/drill-log.json`, { method: "DELETE", headers: APP })).status === 200);

console.log(`\n================ RESULT: ${pass} passed, ${fail} failed ================`);
server.kill();
process.exit(fail ? 1 : 0);
