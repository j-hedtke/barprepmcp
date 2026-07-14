// set_card_importance end-to-end: suspension ("off"), rule-scope fan-out,
// interval scaling for "low", override clearing, and unknown-card errors.
// Spawns one local server (legacy /mcp/<secret> path → sub "default") against
// the real Blob store; uses and then DELETES users/default/{srs,drill-log}.json.
// Run: AUTH_SECRET=t MCP_SECRET=ts APP_TOKEN=localtest BLOB_READ_WRITE_TOKEN=<token> \
//      TEST_PORT=8798 node test/importance-e2e.mjs

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.TEST_PORT) || 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = process.env.MCP_SECRET || "ts";
const APP = { Authorization: `Bearer ${process.env.APP_TOKEN || "localtest"}` };

const cards = JSON.parse(fs.readFileSync(path.join(WT, "data", "cards.json"), "utf8")).cards;
const byRule = new Map();
for (const c of cards) {
  if (!c.ruleId) continue;
  if (!byRule.has(c.ruleId)) byRule.set(c.ruleId, []);
  byRule.get(c.ruleId).push(c);
}
const soloCard = cards.find((c) => c.ruleId && byRule.get(c.ruleId).length === 1);
const multiRule = [...byRule.values()].find((g) => g.length >= 2);
const lowCard = cards.find((c) => c.id !== soloCard.id && !multiRule.some((m) => m.id === c.id));

let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? "ok" : "FAIL"} - ${name}`);
  if (!ok) failures += 1;
};

const server = spawn(process.execPath, ["index.mjs"], {
  cwd: WT,
  env: {
    ...process.env,
    PORT: String(PORT),
    MCP_SECRET: SECRET,
    AUTH_SECRET: process.env.AUTH_SECRET || "testsecret",
    APP_TOKEN: process.env.APP_TOKEN || "localtest",
  },
  stdio: "ignore",
});

async function waitUp() {
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`${BASE}/`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server never came up");
}

let rpcId = 0;
async function call(name, args = {}) {
  const r = await fetch(`${BASE}/mcp/${SECRET}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await r.json();
  const text = body?.result?.content?.[0]?.text;
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { text };
  }
  return { isError: body?.result?.isError === true, data };
}

try {
  await waitUp();
  // Start from a clean slate for the shared legacy user.
  await fetch(`${BASE}/content/srs.json`, { method: "DELETE", headers: APP });
  await fetch(`${BASE}/content/drill-log.json`, { method: "DELETE", headers: APP });

  const before = await call("get_due_summary");

  const off = await call("set_card_importance", { card_id: soloCard.id, importance: "off" });
  check("off: accepted", !off.isError && off.data.importance === "off");
  const after = await call("get_due_summary");
  check("off: total_cards drops by 1", after.data.total_cards === before.data.total_cards - 1);
  check("off: suspended_cards reported", after.data.suspended_cards === 1);

  const rule = await call("set_card_importance", { card_id: multiRule[0].id, importance: "low", scope: "rule" });
  check(`rule scope: fans out to ${multiRule.length} sibling cards`, !rule.isError && rule.data.updated_card_ids.length === multiRule.length);

  const clear = await call("set_card_importance", { card_id: multiRule[0].id, importance: "normal", scope: "rule" });
  check("normal: clears the rule's overrides", !clear.isError && clear.data.updated_card_ids.length === multiRule.length);
  const cleared = await call("submit_review", { card_id: multiRule[0].id, mode: "cloze", user_answer: multiRule[0].answer });
  check("normal: cleared card schedules at the standard 1d interval", !cleared.isError && cleared.data.next_due_days === 1);

  await call("set_card_importance", { card_id: lowCard.id, importance: "low" });
  const rev = await call("submit_review", { card_id: lowCard.id, mode: "cloze", user_answer: lowCard.answer });
  check("low: correct review records", !rev.isError && rev.data.correct === true);
  check("low: first correct interval is doubled (2d)", rev.data.next_due_days === 2);

  const lapseCard = cards.find(
    (c) => c.id !== soloCard.id && c.id !== lowCard.id && !multiRule.some((m) => m.id === c.id)
  );
  const miss = await call("submit_review", { card_id: lapseCard.id, mode: "cloze-mcq", user_answer: lapseCard.distractors[0] });
  check("miss: wrong MCQ answer records a lapse", !miss.isError && miss.data.correct === false);
  const demote = await call("set_card_importance", { card_id: lapseCard.id, importance: "low" });
  check(
    "low on a due/imminent card defers it out of the queue",
    !demote.isError && (demote.data.deferred_card_ids ?? []).includes(lapseCard.id)
  );

  const unknown = await call("set_card_importance", { card_id: "fc-nope-9999", importance: "low" });
  check("unknown card id errors", unknown.isError === true);

  // queue_card: search -> queue -> next serve is the queued card.
  const target = cards.find(
    (c) => c.id !== soloCard.id && c.id !== lowCard.id && c.id !== lapseCard.id && !multiRule.some((m) => m.id === c.id)
  );
  const found = await call("queue_card", { query: target.rule });
  check("queue_card search returns matches with status", !found.isError && (found.data.matches ?? []).some((m) => m.card_id === target.id && m.status === "new"));
  const q = await call("queue_card", { card_id: target.id });
  check("queue_card queues by id", !q.isError && q.data.queued === true && q.data.was === "new");
  const serve = await call("next_card", {});
  check("queued card is the very next serve", serve.data.card_id === target.id);
  const offQ = await call("queue_card", { card_id: soloCard.id });
  check("queueing a suspended card un-suspends it", !offQ.isError && offQ.data.importance_cleared === true);
} finally {
  await fetch(`${BASE}/content/srs.json`, { method: "DELETE", headers: APP }).catch(() => {});
  await fetch(`${BASE}/content/drill-log.json`, { method: "DELETE", headers: APP }).catch(() => {});
  server.kill();
}

console.log(failures === 0 ? "PASS importance-e2e" : `FAIL importance-e2e (${failures})`);
process.exit(failures ? 1 : 0);
