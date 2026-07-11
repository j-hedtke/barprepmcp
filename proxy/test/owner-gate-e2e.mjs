// Owner-gated bundled deck (DECK_OWNERS) — spins two local servers against the
// real Blob store and drills the legacy /mcp/<secret> path (sub "default"):
//   server A: DECK_OWNERS=default            → "default" IS an owner  → full deck (no sample cards)
//   server B: DECK_OWNERS=owner@example.com  → "default" NOT an owner → sample cards only
// Run: AUTH_SECRET=t MCP_SECRET=ts BLOB_READ_WRITE_TOKEN=<token> TEST_PORT=8791 node test/owner-gate-e2e.mjs

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "index.mjs");
const PORT_A = Number(process.env.TEST_PORT || 8791);
const PORT_B = PORT_A + 1;
const SECRET = process.env.MCP_SECRET || "ts";

const bundle = JSON.parse(fs.readFileSync(path.join(here, "..", "data", "cards.json"), "utf8")).cards;
const sampleCount = bundle.filter((c) => c.sample === true).length;
const fullCount = bundle.length - sampleCount;
const aFullDeckCardId = bundle.find((c) => c.sample !== true)?.id;

let failures = 0;
function check(name, ok) {
  console.log(`${ok ? "ok" : "FAIL"} - ${name}`);
  if (!ok) failures += 1;
}

function startServer(port, deckOwners) {
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      PORT: String(port),
      DECK_OWNERS: deckOwners,
      AUTH_SECRET: process.env.AUTH_SECRET || "testsecret",
      MCP_SECRET: SECRET,
    },
    stdio: "ignore",
  });
  return child;
}

async function waitFor(port) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://localhost:${port}/`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`server on :${port} never came up`);
}

async function call(port, name, args = {}) {
  const r = await fetch(`http://localhost:${port}/mcp/${SECRET}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await r.json();
  const item = body?.result?.content?.[0]?.text;
  let data = null;
  try {
    data = item ? JSON.parse(item) : null;
  } catch {
    data = { text: item }; // tool errors are plain text
  }
  return { isError: body?.result?.isError === true, data };
}

const a = startServer(PORT_A, "default");
const b = startServer(PORT_B, "owner@example.com");
try {
  await waitFor(PORT_A);
  await waitFor(PORT_B);

  const ownerSummary = await call(PORT_A, "get_due_summary");
  check(`owner sees the full deck without sample cards (${fullCount})`, ownerSummary.data?.total_cards === fullCount);

  const gatedSummary = await call(PORT_B, "get_due_summary");
  check(`non-owner sees only the sample deck (${sampleCount})`, gatedSummary.data?.total_cards === sampleCount);

  const served = await call(PORT_B, "next_card");
  check("non-owner is served a sample card", String(served.data?.card_id || "").startsWith("fc-sample-"));

  const hint = await call(PORT_B, "get_hint", { card_id: aFullDeckCardId });
  check("non-owner cannot resolve a full-deck card id", hint.isError === true);

  const ownerServedPool = await call(PORT_A, "get_due_summary");
  check("owner summary spans all blueprint subjects", Object.keys(ownerServedPool.data?.by_subject || {}).length === 10);
} finally {
  a.kill();
  b.kill();
}

console.log(failures === 0 ? "PASS owner-gate-e2e" : `FAIL owner-gate-e2e (${failures})`);
process.exit(failures ? 1 : 0);
