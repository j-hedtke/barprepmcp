// Remote MCP server (Streamable HTTP, stateless JSON-RPC 2.0 over plain JSON
// responses) exposing a spaced-repetition drill over the bundled flashcard deck
// (data/cards.json) and MBE question bank (data/questions.json). Claude
// (claude.ai custom connector) is the UI; all drill state lives server-side in
// Vercel Blob under users/<sub>/{srs.json, drill-log.json} via lib/store.mjs.
//
// Routes (wired in index.mjs):
//   POST /mcp                OAuth 2.1 Bearer token (lib/oauth.mjs); the token's
//                            `sub` selects the per-user state namespace.
//   POST /mcp/<MCP_SECRET>   legacy path secret (curl testing); maps to sub
//                            "default". 404 on mismatch or when MCP_SECRET is
//                            unset; 405 for GET/DELETE — no SSE stream.
// The Streamable HTTP transport permits plain application/json responses, which
// is what claude.ai's connector accepts for stateless servers.

import fs from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getFile, putFile } from "./store.mjs";
import { stripeEnabled, createCheckoutSession, retrieveCheckoutSession, deckBuildPriceCents } from "./billing.mjs";
import { generateCards } from "./cardgen.mjs";
import {
  gradeTyped,
  normalize,
  newCardState,
  applyReview,
  unifiedAccuracy,
  unifiedSignals,
  blueprintMaps,
  pickNextCard,
  pickNextQuestion,
  clozeParts,
  studyStreak,
  MASTERED_INTERVAL_DAYS,
} from "./srs.mjs";

const SERVER_NAME = "aibarprep-drill";
const SERVER_VERSION = "1.0.0";
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const LEGACY_USER = "default"; // legacy path-secret identity — same namespace as the app's beta APP_TOKEN

// ---------------------------------------------------------------------------
// Demo choreography — the one dedicated demo account plays a FIXED serve
// script instead of the SRS scheduler, so a live walkthrough always shows the
// same arc: typed cloze (with a good hint) → quick MCQ → the SAME first card
// requeued after its lapse → recite. ONLY next_card's card+mode pick is
// scripted; hints, grading, lapse math, verdict escalation, stats, and logs
// all run the completely normal machinery, so everything the demo shows is
// real. state.demoStep (default 0) is the script cursor; it advances only
// when a review is actually RECORDED (see toolSubmitReview), and once the
// script is exhausted the account falls through to normal scheduling.
// demoStep lives in the per-sub srs.json, so no other user is affected.
// ---------------------------------------------------------------------------
const DEMO_SUB = "demo@barprepmcp.com";
const DEMO_SCRIPT = [
  { id: "fc-civpro-0052", mode: "cloze" }, // claim preclusion — typed, good hint
  { id: "fc-evidence-0014", mode: "cloze-mcq" }, // misrepresentation — quick MCQ
  { id: "fc-civpro-0052", mode: "cloze" }, // the SAME card, requeued right after its lapse
  { id: "fc-contracts-0076", mode: "recite" }, // part-performance land-sale rule
];

// Fabricated volume overlaid on the demo account's stats so filming shows a
// lived-in schedule; real session actions still move every number. Never
// applies to any other sub.
const DEMO_STATS_BASELINE = {
  totals: { card_reviews: 412, card_correct: 353, cards_started: 286, cards_mastered: 38, mbe_answered: 57, mbe_correct: 41 },
  due_today: 14, due_tomorrow: 23, due_now: 12, study_streak_days: 12, reviews_today: 26,
  per_subject: { civpro: [64, 54], conlaw: [52, 45], contracts: [71, 58], crim: [48, 44], evidence: [59, 50], realprop: [46, 39], torts: [43, 38], agency: [9, 8], partnerships: [7, 6], corps: [13, 11] },
  weak_areas: [
    { subject: "evidence", subject_name: "Evidence", subtopic: "hearsay", subtopic_name: "Hearsay and Circumstances of its Admissibility", exam_ratio: 0.25, unified_accuracy: 0.58, mbe_answered: 9, mbe_correct: 5, card_reviews: 18, card_correct: 11, source: "both", priority_score: 0.105 },
    { subject: "civpro", subject_name: "Civil Procedure", subtopic: "verdicts-and-judgments", subtopic_name: "Verdicts and Judgments", exam_ratio: 0.083, unified_accuracy: 0.55, mbe_answered: 4, mbe_correct: 2, card_reviews: 11, card_correct: 6, source: "both", priority_score: 0.0374 },
    { subject: "contracts", subject_name: "Contracts", subtopic: "defenses-to-enforceability", subtopic_name: "Defenses to Enforceability", exam_ratio: 0.125, unified_accuracy: 0.64, mbe_answered: 6, mbe_correct: 4, card_reviews: 14, card_correct: 9, source: "both", priority_score: 0.045 },
    { subject: "realprop", subject_name: "Real Property", subtopic: "mortgages-security-devices", subtopic_name: "Mortgages/Security Devices", exam_ratio: 0.2, unified_accuracy: 0.67, mbe_answered: 5, mbe_correct: 3, card_reviews: 12, card_correct: 9, source: "both", priority_score: 0.066 },
    { subject: "torts", subject_name: "Torts", subtopic: "negligence", subtopic_name: "Negligence", exam_ratio: 0.5, unified_accuracy: 0.72, mbe_answered: 12, mbe_correct: 9, card_reviews: 20, card_correct: 14, source: "both", priority_score: 0.14 },
  ],
};

const LOG_CAP = 500;
const RECENT_QUESTION_CAP = 30;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Bundled content (proxy/data/, produced by bundle-content.mjs — committed)
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
function loadBundled(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(here, "..", "data", name), "utf8"));
  } catch {
    return null;
  }
}
const CARDS = loadBundled("cards.json")?.cards ?? [];
const QUESTIONS = loadBundled("questions.json")?.questions ?? [];
const BLUEPRINT = loadBundled("blueprint.json") ?? { subjects: [] };
const cardsById = new Map(CARDS.map((c) => [c.id, c]));
const questionsById = new Map(QUESTIONS.map((q) => [q.id, q]));
const { ratio: ratioMap, subjectName, subtopicName } = blueprintMaps(BLUEPRINT);
const SUBJECT_KEYS = BLUEPRINT.subjects.map((s) => s.key);

// ---------------------------------------------------------------------------
// Server-side state: srs.json + drill-log.json in Blob (lib/store.mjs), keyed
// per user (users/<sub>/…). Loaded once per tool call, saved after mutations.
// Module-level per-user caches keep the freshest copy for the lifetime of the
// serverless instance so rapid review→next-card sequences never see the Blob
// edge cache's ≤60s staleness.
// ---------------------------------------------------------------------------

const srsCaches = new Map(); // sub -> state
const logCaches = new Map(); // sub -> log

function emptyState() {
  // lastCard: id of the last card served in ANY mode (next_card's avoidId).
  // lastServe: the last cloze-mcq serving — { cardId, options: [4 strings in
  // the exact shuffled order returned to the client] } — so submit_review can
  // map a bare letter answer (A-D) back to the option text the user picked.
  // Cleared when that card's review is recorded or it is re-served non-MCQ.
  return { cards: {}, mbe: {}, lastCard: null, lastServe: null, recentQuestions: [], updatedAt: null };
}

async function loadState(sub) {
  if (srsCaches.has(sub)) return srsCaches.get(sub);
  let state = null;
  const file = await getFile(sub, "srs.json");
  if (file) {
    try {
      state = JSON.parse(file.body.toString("utf8"));
    } catch {
      state = null;
    }
  }
  if (!state || typeof state !== "object") state = emptyState();
  state.cards ??= {};
  state.mbe ??= {};
  state.recentQuestions ??= [];
  srsCaches.set(sub, state);
  return state;
}

async function saveState(sub, state) {
  state.updatedAt = new Date().toISOString();
  srsCaches.set(sub, state);
  await putFile(sub, "srs.json", Buffer.from(JSON.stringify(state)), "application/json");
}

async function loadLog(sub) {
  if (logCaches.has(sub)) return logCaches.get(sub);
  let log = null;
  try {
    const file = await getFile(sub, "drill-log.json");
    if (file) log = JSON.parse(file.body.toString("utf8"));
  } catch {
    log = null;
  }
  if (!log || !Array.isArray(log.events)) log = { events: [] };
  logCaches.set(sub, log);
  return log;
}

// Append-capped review log (last 500 events). Best-effort: a log failure must
// never fail the review itself.
async function appendLog(sub, event) {
  try {
    const log = await loadLog(sub);
    log.events.push(event);
    if (log.events.length > LOG_CAP) log.events = log.events.slice(-LOG_CAP);
    logCaches.set(sub, log);
    await putFile(sub, "drill-log.json", Buffer.from(JSON.stringify(log)), "application/json");
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Per-user custom decks: rules uploaded via upload_rules live in
// users/<sub>/custom-rules.json; build_deck turns them into flashcards in
// users/<sub>/custom-cards.json (chunked + resumable via build-state.json,
// paid via billing.json — one-time Stripe Checkout build credit; generation
// always runs on the server's ANTHROPIC_API_KEY); set_deck stores the deck
// preference in prefs.json. Same module-level per-sub cache pattern as
// srs.json above.
// ---------------------------------------------------------------------------

const BUILD_CHUNK = 8; // rules per build_deck call — one Anthropic call, well under Vercel's 60s cap
const RULES_CAP = 500;

const jsonCaches = new Map(); // "<sub>/<name>" -> parsed doc
const customDeckCaches = new Map(); // sub -> { cards, byId }

async function loadUserJson(sub, name, fallback) {
  const key = `${sub}/${name}`;
  if (jsonCaches.has(key)) return jsonCaches.get(key);
  let doc = null;
  try {
    const file = await getFile(sub, name);
    if (file) doc = JSON.parse(file.body.toString("utf8"));
  } catch {
    doc = null;
  }
  if (!doc || typeof doc !== "object") doc = fallback();
  jsonCaches.set(key, doc);
  return doc;
}

async function saveUserJson(sub, name, doc) {
  jsonCaches.set(`${sub}/${name}`, doc);
  await putFile(sub, name, Buffer.from(JSON.stringify(doc)), "application/json");
}

const loadRules = (sub) => loadUserJson(sub, "custom-rules.json", () => ({ rules: [] }));
const loadPrefs = (sub) => loadUserJson(sub, "prefs.json", () => ({ deck: "default" }));
const loadBilling = (sub) => loadUserJson(sub, "billing.json", () => ({ credits: 0, pendingSession: null }));
const loadBuildState = (sub) => loadUserJson(sub, "build-state.json", () => ({}));

async function loadCustomDeck(sub) {
  if (customDeckCaches.has(sub)) return customDeckCaches.get(sub);
  const doc = await loadUserJson(sub, "custom-cards.json", () => ({ cards: [] }));
  const cards = Array.isArray(doc.cards) ? doc.cards : [];
  const deck = { cards, byId: new Map(cards.map((c) => [c.id, c])) };
  customDeckCaches.set(sub, deck);
  return deck;
}

async function saveCustomDeck(sub, cards) {
  customDeckCaches.set(sub, { cards, byId: new Map(cards.map((c) => [c.id, c])) });
  await saveUserJson(sub, "custom-cards.json", { cards, updatedAt: new Date().toISOString() });
}

/** Card pool honoring the user's set_deck preference. */
async function activeDeck(sub) {
  const pref = ["default", "custom", "both"].includes((await loadPrefs(sub)).deck)
    ? (await loadPrefs(sub)).deck
    : "default";
  const custom = await loadCustomDeck(sub);
  if (pref === "custom") return { pref, cards: custom.cards, byId: custom.byId };
  if (pref === "both") {
    return { pref, cards: [...CARDS, ...custom.cards], byId: new Map([...cardsById, ...custom.byId]) };
  }
  return { pref, cards: CARDS, byId: cardsById };
}

/** Look a card up in the bundled deck or the user's custom deck. */
async function findCard(sub, cardId) {
  return cardsById.get(cardId) ?? (await loadCustomDeck(sub)).byId.get(cardId) ?? null;
}

// Text fallback for upload_rules: each paragraph / numbered item is one rule.
function rulesFromText(text) {
  const items = [];
  for (const block of String(text).split(/\n\s*\n+/)) {
    for (let part of block.split(/\n(?=\s*\d+[.)]\s)/)) {
      part = part.replace(/^\s*\d+[.)]\s*/, "").replace(/\s+/g, " ").trim();
      if (part) items.push({ statement: part });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Tool definitions — descriptions are written FOR Claude running the drill.
// ---------------------------------------------------------------------------

const SUBJECT_ENUM_NOTE = `Valid subject keys: ${SUBJECT_KEYS.join(", ")}.`;

// Rubric handed to Claude when the server matcher can't accept a typed cloze
// answer (needs_verdict escalation). Kept as one constant so the tool
// description and the escalation response never drift apart.
const CLOZE_VERDICT_INSTRUCTIONS =
  "The server's matcher could not accept this typed answer — judge it yourself, BINARY pass/fail, against `answer` (and the `acceptable` alternates) in the context of canonical_statement. Be VERY STRICT on semantics: every legally operative element, standard, party, and quantum in the expected answer must be present and unaltered in meaning — a wrong standard, wrong party, wrong number or time period, or a missing element is FAIL. Be LAX on syntax: word order, tense/inflection, plurals, articles, abbreviations, punctuation, and true synonyms that preserve the legal meaning are all fine. When unsure, FAIL. Then call submit_review again with the same card_id, mode 'cloze', and verdict: 'pass' or 'fail' — only that second call records the review.";

const TOOLS = [
  {
    name: "get_due_summary",
    description:
      "Call this FIRST when starting a bar-prep drill session. Returns how many flashcards are due for review, how many are brand new, a per-subject breakdown, the user's study streak, and a suggested session (e.g. \"12 due + 8 new\"). Use it to propose a session plan to the user before drilling.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "next_card",
    description:
      "Serve the next flashcard, chosen by spaced repetition: due cards first (soonest due), then new cards weighted toward the user's weakest subtopics. The response NEVER contains the answer — present the COMPLETE prompt to the user verbatim (the full rule statement with its blank, first word to last; never elide or start mid-sentence — the user is internalizing the whole rule) and wait for their reply, then call submit_review. Three resolved modes: 'cloze-mcq' (blanked rule statement + 4 shuffled options — read the statement, saying 'blank' for the gap, then the options; the user picks one, and you MUST pass the FULL TEXT of the picked option to submit_review, never just its letter — a bare letter is accepted only as a fallback for the most recently served card), 'cloze' (same blanked statement, the user must SAY/TYPE the missing words — do not offer options), and 'recite' (the user must recite the whole rule from memory given only its name; the canonical statement is revealed by submit_review, which YOU then grade 0-5). Optional mode param: 'auto' (default — the server picks), 'cloze', or 'recite'. Optional subject filters to one subject. If the user asks for a hint on a 'cloze' or 'recite' card, call get_hint — never invent a hint yourself, and never volunteer one unasked. " +
      SUBJECT_ENUM_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["auto", "cloze", "recite"], description: "Drill mode preference; 'auto' lets the server pick (new cards → cloze-mcq; seen cards → typed cloze or recite, 50/50)." },
        subject: { type: "string", description: "Optional subject key to drill only that subject." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_hint",
    description:
      "Fetch the stored hint for the card currently being answered — ONLY when the user explicitly asks for a hint, and ONLY for modes 'cloze' (typed fill-in-the-blank) and 'recite'. Never invent your own hint and never offer one unasked; multiple-choice cards and MBE questions have no hints. Present the returned hint verbatim. Using a hint caps that review's quality at 4 so the scheduler shows the card again sooner — mention this briefly the first time the user asks.",
    inputSchema: {
      type: "object",
      properties: {
        card_id: { type: "string", description: "The card_id returned by next_card." },
        mode: { type: "string", enum: ["cloze", "recite"], description: "The resolved mode next_card returned for this serving." },
      },
      required: ["card_id", "mode"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_review",
    description:
      "Record the user's answer to the card served by next_card. Answers are withheld until this call — never guess or reveal them earlier. Mode 'cloze-mcq': pass the FULL TEXT of the option the user picked in user_answer (not the letter); the SERVER grades and records it in one call. A bare letter A-D (or 'option b' / 'the answer is C') is accepted only as a fallback and only for the most recently served card — if the server cannot map the letter to that serving it returns an error and you must resubmit with the option's full text. Mode 'cloze' (typed): pass the user's answer verbatim in user_answer; if the server's matcher accepts it (quality 5 exact/reordered, 4 with typos) it records in that same call — but if the matcher rejects it, NOTHING is recorded and the response is { needs_verdict: true } with the expected answer: YOU then judge BINARY pass/fail (VERY STRICT on semantics — every legally operative element, standard, party, and quantum must be present and unaltered in meaning; a wrong standard, wrong party, wrong number/time period, or missing element is FAIL — but LAX on syntax: word order, tense, plurals, articles, abbreviations, and true synonyms preserving the legal meaning are fine; when unsure, FAIL) and call submit_review again with the same card_id, mode 'cloze', and verdict: 'pass' or 'fail' — only that second call records (pass = quality 4, fail = quality 2). For mode 'recite' it is a TWO-STEP call: (1) call with user_answer = the user's recitation and NO rating — the server returns { canonical_statement, needs_rating: true } WITHOUT scheduling anything; (2) YOU compare the recitation against the canonical statement and call submit_review again with rating 0-5 (grade STRICTLY: 5 = every element present and precise, 4 = all elements, minor wording slips, 3 = substantively correct but missing precision, 2 = missing an element, 1 = only fragments, 0 = blank/wrong rule; 3+ counts as correct) — only this second call updates the schedule. The response includes the updated SM-2 stats and when the card is next due. Before doing ANYTHING else (especially before calling next_card), announce the result to the user as its own message part: (1) the verdict — correct or not; (2) the exact correct answer / canonical language, quoted; (3) if wrong or imprecise, one line on what was off. Never fold the verdict into a transition sentence or skip straight to the next card.",
    inputSchema: {
      type: "object",
      properties: {
        card_id: { type: "string", description: "The card_id returned by next_card." },
        mode: { type: "string", enum: ["cloze", "cloze-mcq", "recite"], description: "The resolved mode next_card returned." },
        user_answer: { type: "string", description: "The user's answer/recitation, verbatim. Required for cloze and cloze-mcq, and for recite step 1." },
        rating: { type: "integer", minimum: 0, maximum: 5, description: "Recite mode step 2 only: your strict 0-5 grade of the recitation against the canonical statement." },
        verdict: { type: "string", enum: ["pass", "fail"], description: "Cloze escalation step 2 only: your binary judgment of the typed answer after a needs_verdict response (strict on semantics, lax on syntax; when unsure, fail)." },
      },
      required: ["card_id", "mode"],
      additionalProperties: false,
    },
  },
  {
    name: "next_mbe_question",
    description:
      "Serve one multiple-choice MBE practice question from the 196-question bank, weighted toward the user's weakest subtopics (blended flashcard + MBE signal) and avoiding recently-served questions. The response contains the fact-pattern stem and 4 choices but NO answer or explanation — read the stem and choices to the user, wait for their pick (A/B/C/D or 0-3), then call submit_mbe_answer. Optional subject filters to one subject. " +
      SUBJECT_ENUM_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Optional subject key to drill only that subject." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "submit_mbe_answer",
    description:
      "Record the user's choice for the question served by next_mbe_question and get the verdict. Returns correct (bool), correctIndex (0-3), the correct choice text, the full explanation, and the black-letter rule tested — walk the user through why the right answer is right and their wrong choice (if any) is wrong. This also updates the weakness model that steers future card and question selection.",
    inputSchema: {
      type: "object",
      properties: {
        question_id: { type: "string", description: "The question_id returned by next_mbe_question." },
        choice_index: { type: "integer", minimum: 0, maximum: 3, description: "The user's pick, 0-3 (A=0, B=1, C=2, D=3)." },
      },
      required: ["question_id", "choice_index"],
      additionalProperties: false,
    },
  },
  {
    name: "get_stats",
    description:
      "Progress overview: total card reviews and MBE answers, per-subject accuracy (flashcards, MBE, and the unified blend), number of mastered cards (interval ≥ 21 days), and cards due today/tomorrow. Use when the user asks how they're doing or at the end of a session.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_weak_areas",
    description:
      "The user's weakest subtopics, hardest-first, scored by exam weight × (1 − unified accuracy) where unified accuracy blends MBE answers (full weight) and flashcard reviews (half weight). Use it to target a session ('let's hit hearsay today') or to answer 'what should I study?'.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Max areas to return (default 10)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "upload_rules",
    description:
      "Upload the user's OWN rule sheet (e.g. a state-specific outline) to build a personal flashcard deck from. Prefer structured `rules` — one object per black-letter rule with a short name and ONE self-contained rule statement (at least 8 words); pre-structure the user's document yourself before calling. `text` is a fallback: each paragraph or numbered item becomes one rule, named after its first ~8 words. Rules may use ANY subject/subtopic strings (e.g. \"california-community-property\"); subject defaults to \"custom\". mode \"add\" (default) merges with previously uploaded rules; \"replace\" starts the rule set over (and clears previously built custom cards). Cap: 500 rules; statements under 8 words are skipped. Uploading only STORES the rules — cards are generated afterwards: tell the user, then call build_deck. Only accept content the user owns or is licensed to use (their own outlines, notes, or authored materials); confirm this if the source is unclear.",
    inputSchema: {
      type: "object",
      properties: {
        rules: {
          type: "array",
          description: "Structured rules (preferred).",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Short rule name (card title). Derived from the statement if omitted." },
              statement: { type: "string", description: "ONE self-contained black-letter rule statement, ≥ 8 words." },
              subject: { type: "string", description: "Any subject key string (default \"custom\")." },
              subtopic: { type: "string", description: "Any subtopic key string (default \"general\")." },
              priority: { type: "string", enum: ["H", "M", "L"], description: "Exam priority (default M)." },
            },
            required: ["statement"],
            additionalProperties: false,
          },
        },
        text: { type: "string", description: "Fallback: raw rule-sheet text; each paragraph/numbered item becomes one rule." },
        mode: { type: "string", enum: ["add", "replace"], description: "\"add\" (default) merges; \"replace\" starts over." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "build_deck",
    description:
      "Generate flashcards from the rules stored by upload_rules. Each call processes ~8 rules (serverless time limit), so YOU MUST KEEP CALLING build_deck until the response has done: true — after each call, report progress briefly and immediately call it again. Card generation is paid for with a one-time Stripe Checkout credit per deck build: if the response contains payment_required with a checkout_url, give the user the link, and once they say they've paid, call build_deck again to verify the payment and continue the build. Invalid model-generated cards are dropped and counted in cards_dropped_invalid. When done: true, suggest set_deck to start drilling the custom cards. (Preview note: if builds are not yet enabled on this server, the tool returns a friendly message and records the user's interest — relay it warmly and continue with the default deck.)",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "set_deck",
    description:
      "Choose which flashcard deck next_card, get_due_summary, get_stats, and get_weak_areas draw from: \"default\" (the bundled bar-prep deck), \"custom\" (only the user's own cards built by build_deck), or \"both\" (merged pool). Persists across sessions. Custom cards use the same spaced-repetition scheduling, grading, and hints as bundled cards.",
    inputSchema: {
      type: "object",
      properties: {
        deck: { type: "string", enum: ["default", "custom", "both"], description: "Deck preference." },
      },
      required: ["deck"],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

// Conservative parser for a multiple-choice letter answer ("B", "b.", "(c)",
// "option b", "the answer is D", "I'll go with c"). Returns the 0-based option
// index (A=0..D=3) or null when the text is anything more than filler words
// plus one trailing letter — real answer text must fall through to gradeTyped,
// never be misread as a letter.
const MCQ_LETTER_FILLER = new Set([
  "the", "my", "answer", "option", "choice", "letter", "pick", "picked", "choose", "chose",
  "select", "selected", "go", "going", "with", "is", "it", "its", "i", "d", "ll", "s", "final",
]);
export function extractMcqLetter(input) {
  const tokens = normalize(input).split(" ").filter(Boolean);
  if (!tokens.length || tokens.length > 6) return null;
  const last = tokens[tokens.length - 1];
  if (!/^[a-d]$/.test(last)) return null;
  for (const t of tokens.slice(0, -1)) {
    if (!MCQ_LETTER_FILLER.has(t)) return null;
  }
  return last.charCodeAt(0) - 97;
}

function validateSubject(subject) {
  if (subject != null && !SUBJECT_KEYS.includes(subject)) {
    throw new ToolError(`Unknown subject "${subject}". ${SUBJECT_ENUM_NOTE}`);
  }
}

class ToolError extends Error {}

async function toolGetDueSummary(_args, sub) {
  const state = await loadState(sub);
  const log = await loadLog(sub);
  const deck = await activeDeck(sub);
  const now = Date.now();

  let due = 0;
  let fresh = 0;
  const bySubject = {};
  if (deck.pref !== "custom") {
    for (const key of SUBJECT_KEYS) bySubject[key] = { subject: subjectName.get(key) ?? key, due: 0, new: 0 };
  }
  for (const card of deck.cards) {
    const st = state.cards[card.id];
    const bucket = bySubject[card.subject] ?? (bySubject[card.subject] = { subject: card.subject, due: 0, new: 0 });
    if (!st) {
      fresh += 1;
      bucket.new += 1;
    } else if (Date.parse(st.due) <= now) {
      due += 1;
      bucket.due += 1;
    }
  }
  let streak = studyStreak(log.events, now);
  const today = new Date(now).toISOString().slice(0, 10);
  let reviewedToday = log.events.filter((e) => (e.ts ?? "").slice(0, 10) === today).length;
  const suggestedDue = Math.min(due, 20);
  const suggestedNew = Math.min(fresh, Math.max(0, 20 - suggestedDue), 8);
  const parts = [];
  if (suggestedDue) parts.push(`${suggestedDue} due`);
  if (suggestedNew) parts.push(`${suggestedNew} new`);
  if (sub === DEMO_SUB) {
    const b = DEMO_STATS_BASELINE;
    due += b.due_now; streak = Math.max(streak, b.study_streak_days); reviewedToday += b.reviews_today;
  }
  return {
    deck: deck.pref,
    due_now: due,
    new_never_seen: fresh,
    total_cards: deck.cards.length,
    total_mbe_questions: QUESTIONS.length,
    by_subject: bySubject,
    study_streak_days: streak,
    reviews_today: reviewedToday,
    suggested_session: parts.length ? parts.join(" + ") + " cards" : "all caught up — try a few MBE questions",
  };
}

async function toolNextCard({ mode = "auto", subject = null } = {}, sub) {
  const deck = await activeDeck(sub);
  if (subject != null && !SUBJECT_KEYS.includes(subject) && !deck.cards.some((c) => c.subject === subject)) {
    throw new ToolError(`Unknown subject "${subject}". ${SUBJECT_ENUM_NOTE} Custom-deck subjects are also accepted when the active deck includes custom cards.`);
  }
  if (!deck.cards.length) {
    throw new ToolError(
      deck.pref === "custom"
        ? "Your custom deck is empty — call upload_rules, then build_deck until done, first."
        : "No flashcard deck bundled on the server."
    );
  }
  const state = await loadState(sub);
  const now = Date.now();

  // Demo choreography: the demo account's serve comes from DEMO_SCRIPT with
  // the scripted mode forced (scheduler and new-vs-review resolution
  // bypassed); the serve payload below is built exactly like a normal serve.
  // Falls through to normal scheduling once the script is exhausted.
  let card = null;
  let demoMode = null;
  if (sub === DEMO_SUB && (state.demoStep ?? 0) < DEMO_SCRIPT.length) {
    const scripted = DEMO_SCRIPT[state.demoStep ?? 0];
    card = cardsById.get(scripted.id) ?? null;
    if (card) demoMode = scripted.mode;
  }
  if (!card) {
    const signals = unifiedSignals(state, deck.byId, questionsById);
    card = pickNextCard(deck.cards, state, BLUEPRINT, { subject, avoidId: state.lastCard, now, signals });
  }
  if (!card) throw new ToolError(subject ? `No cards available for subject "${subject}".` : "No cards available.");

  const st = state.cards[card.id];
  const isNew = !st || (st.seen ?? 0) === 0;
  let resolved;
  if (demoMode) resolved = demoMode; // demo choreography: scripted mode wins
  else if (mode === "recite") resolved = "recite";
  else if (mode === "cloze") resolved = isNew ? "cloze-mcq" : "cloze";
  else resolved = isNew ? "cloze-mcq" : Math.random() < 0.5 ? "cloze" : "recite";

  const result = {
    card_id: card.id,
    subject: card.subject,
    subject_name: subjectName.get(card.subject) ?? card.subject,
    subtopic: card.subtopic,
    subtopic_name: subtopicName.get(`${card.subject}/${card.subtopic}`) ?? card.subtopic,
    rule_name: card.rule,
    priority: card.priority,
    mode: resolved,
    is_custom_card: !cardsById.has(card.id),
    is_new_card: isNew,
    due_status: st ? (Date.parse(st.due) <= now ? "due" : "early-review") : "new",
  };
  if (resolved === "recite") {
    result.prompt = `Recite the rule: ${card.rule} (${subjectName.get(card.subject) ?? card.subject})`;
  } else {
    const parts = clozeParts(card);
    if (!parts) throw new ToolError(`Card ${card.id} has an invalid cloze span.`);
    result.prompt = `${parts[0]}_____${parts[1]}`;
    if (resolved === "cloze-mcq") {
      result.options = [card.answer, ...card.distractors].sort(() => Math.random() - 0.5);
    }
  }

  state.lastCard = card.id;
  if (resolved === "cloze-mcq") {
    // Persist the exact shuffled option order so submit_review can map a bare
    // letter answer (A-D) back to the option text the user actually picked.
    state.lastServe = { cardId: card.id, options: [...result.options] };
  } else if (state.lastServe?.cardId === card.id) {
    state.lastServe = null; // same card re-served non-MCQ — the old A-D order is stale
  }
  await saveState(sub, state);
  return result;
}

async function toolGetHint({ card_id, mode } = {}, sub) {
  const card = await findCard(sub, card_id);
  if (!card) throw new ToolError(`Unknown card_id "${card_id}".`);
  if (!["cloze", "recite"].includes(mode)) {
    throw new ToolError("Hints are only available for typed fill-in-the-blank ('cloze') and recitation ('recite') — not multiple choice.");
  }
  const hint = mode === "recite" ? card.hintRecite : card.hintCloze;
  if (!hint) throw new ToolError("No hint is stored for this card.");
  const state = await loadState(sub);
  const now = Date.now();
  const st = state.cards[card_id] ?? newCardState(now);
  st.hintPending = true;
  state.cards[card_id] = st;
  await saveState(sub, state);
  return {
    card_id,
    mode,
    hint,
    note: "Hint used: this review's quality will cap at 4, so the card returns sooner than a clean pass.",
  };
}

async function toolSubmitReview({ card_id, mode, user_answer, rating, verdict } = {}, sub) {
  const card = await findCard(sub, card_id);
  if (!card) throw new ToolError(`Unknown card_id "${card_id}".`);
  if (!["cloze", "cloze-mcq", "recite"].includes(mode)) {
    throw new ToolError(`mode must be "cloze", "cloze-mcq", or "recite" (got "${mode}").`);
  }
  const state = await loadState(sub);
  const now = Date.now();

  let correct;
  let quality;
  let via = null;
  if (mode === "recite") {
    if (rating == null) {
      // Step 1 of 2: reveal the canonical statement for Claude to grade against.
      // Nothing is scheduled or recorded until the rated second call.
      if (typeof user_answer !== "string" || !user_answer.trim()) {
        throw new ToolError("Recite step 1 requires user_answer (the user's recitation, verbatim).");
      }
      return {
        needs_rating: true,
        card_id,
        rule_name: card.rule,
        canonical_statement: card.statement,
        instructions:
          "Grade the user's recitation STRICTLY against canonical_statement (5 = complete and precise, 4 = all elements with minor wording slips, 3 = substantively correct, 2 = missing an element, 1 = fragments, 0 = wrong rule). Then call submit_review again with the same card_id, mode 'recite', and your integer rating 0-5 to record it.",
      };
    }
    quality = Math.max(0, Math.min(5, Math.round(Number(rating))));
    if (!Number.isFinite(quality)) throw new ToolError("rating must be an integer 0-5.");
    correct = quality >= 3;
  } else if (mode === "cloze" && verdict !== undefined) {
    // Cloze escalation step 2 of 2: Claude's binary judgment of a typed answer
    // the server matcher rejected. Stateless guard: a verdict for a card with
    // no pending escalation is still accepted and recorded — tracking pending
    // escalations server-side would add state (and failure modes) for no real
    // safety gain on a self-graded study tool.
    if (verdict !== "pass" && verdict !== "fail") {
      throw new ToolError(`verdict must be "pass" or "fail" (got "${verdict}").`);
    }
    correct = verdict === "pass";
    quality = correct ? 4 : 2; // pass = semantically right but syntactically off
    via = "verdict";
  } else {
    if (typeof user_answer !== "string") {
      throw new ToolError(`mode "${mode}" requires user_answer (the user's answer, verbatim).`);
    }
    const letterIdx = mode === "cloze-mcq" ? extractMcqLetter(user_answer) : null;
    if (letterIdx != null) {
      // Letter fallback: the client sent "B" instead of the option's text.
      // The letter only means something relative to the shuffled order of the
      // most recent cloze-mcq serve, persisted in state.lastServe — map it to
      // the option TEXT and grade that, never the literal letter string.
      const serve = state.lastServe;
      if (serve?.cardId !== card_id || !Array.isArray(serve.options) || letterIdx >= serve.options.length) {
        throw new ToolError(
          `Cannot map the letter answer ${JSON.stringify(user_answer)} to an option: card "${card_id}" is not the most recently served multiple-choice card, so its shuffled A-D order is unknown. Call submit_review again with the FULL TEXT of the option the user chose.`
        );
      }
      correct = normalize(serve.options[letterIdx]) === normalize(card.answer);
      quality = correct ? 5 : 2; // an explicit wrong pick is a clean lapse — no escalation
      via = "letter";
    } else {
      ({ correct, quality } = gradeTyped(user_answer, card.answer, card.acceptable ?? []));
    }
    if (mode === "cloze" && !correct) {
      // Cloze escalation step 1 of 2: the matcher couldn't accept the typed
      // answer, so instead of auto-failing, hand Claude the expected answer and
      // the strict-semantics / lax-syntax rubric. Nothing is scheduled or
      // recorded (a pending hint cap also survives) until the verdict call.
      return {
        needs_verdict: true,
        card_id,
        user_answer,
        answer: card.answer,
        acceptable: card.acceptable ?? [],
        canonical_statement: card.statement,
        rule_name: card.rule,
        instructions: CLOZE_VERDICT_INSTRUCTIONS,
      };
    }
  }

  const st = state.cards[card_id] ?? newCardState(now);
  const hintUsed = Boolean(st.hintPending);
  if (hintUsed) {
    quality = Math.min(quality, 4);
    delete st.hintPending;
  }
  applyReview(st, correct, now);
  st.seen += 1;
  if (correct) st.correct += 1;
  if (mode === "cloze") {
    st.typedSeen += 1;
    if (correct) st.typedCorrect += 1;
  } else if (mode === "cloze-mcq") {
    st.mcqSeen += 1;
    if (correct) st.mcqCorrect += 1;
  }
  state.cards[card_id] = st;
  // Demo choreography: a review that is actually RECORDED (applyReview above)
  // advances the serve script. The needs_verdict / needs_rating first steps
  // and get_hint return earlier and never reach this point.
  if (sub === DEMO_SUB && (state.demoStep ?? 0) < DEMO_SCRIPT.length) {
    state.demoStep = (state.demoStep ?? 0) + 1;
  }
  if (mode === "cloze-mcq" && state.lastServe?.cardId === card_id) {
    state.lastServe = null; // review recorded — the persisted A-D mapping is spent
  }
  await saveState(sub, state);
  await appendLog(sub, {
    ts: new Date(now).toISOString(),
    type: "card",
    id: card_id,
    subject: card.subject,
    subtopic: card.subtopic,
    mode,
    correct,
    quality,
    ...(via ? { via } : {}),
    ...(hintUsed ? { hint_used: true } : {}),
  });

  return {
    correct,
    quality,
    ...(hintUsed ? { hint_used: true } : {}),
    answer: card.answer,
    acceptable: card.acceptable ?? [],
    canonical_statement: card.statement,
    rule_name: card.rule,
    next_due: st.due,
    next_due_days: Math.round((Date.parse(st.due) - now) / DAY_MS * 100) / 100,
    card_stats: {
      seen: st.seen,
      correct: st.correct,
      reps: st.reps,
      lapses: st.lapses,
      ease: Math.round(st.ease * 100) / 100,
      interval_days: Math.round(st.intervalDays * 100) / 100,
    },
  };
}

async function toolNextMbeQuestion({ subject = null } = {}, sub) {
  validateSubject(subject);
  if (!QUESTIONS.length) throw new ToolError("No MBE question bank bundled on the server.");
  const state = await loadState(sub);
  const signals = unifiedSignals(state, cardsById, questionsById);
  const q = pickNextQuestion(QUESTIONS, state, BLUEPRINT, { subject, recentIds: state.recentQuestions, signals });
  if (!q) throw new ToolError(subject ? `No questions available for subject "${subject}".` : "No questions available.");

  state.recentQuestions = [...(state.recentQuestions ?? []).filter((id) => id !== q.id), q.id].slice(-RECENT_QUESTION_CAP);
  await saveState(sub, state);

  return {
    question_id: q.id,
    subject: q.subject,
    subject_name: subjectName.get(q.subject) ?? q.subject,
    subtopic: q.subtopic,
    subtopic_name: subtopicName.get(`${q.subject}/${q.subtopic}`) ?? q.subtopic,
    difficulty: q.difficulty,
    priority: q.priority,
    stem: q.stem,
    choices: q.choices,
    times_answered: state.mbe[q.id]?.answered ?? 0,
  };
}

async function toolSubmitMbeAnswer({ question_id, choice_index } = {}, sub) {
  const q = questionsById.get(question_id);
  if (!q) throw new ToolError(`Unknown question_id "${question_id}".`);
  const idx = Number(choice_index);
  if (!Number.isInteger(idx) || idx < 0 || idx > 3) throw new ToolError("choice_index must be an integer 0-3.");

  const state = await loadState(sub);
  const now = Date.now();
  const correct = idx === q.correctIndex;
  const rec = state.mbe[question_id] ?? { answered: 0, correct: 0, lastAnswered: null };
  rec.answered += 1;
  if (correct) rec.correct += 1;
  rec.lastAnswered = new Date(now).toISOString();
  state.mbe[question_id] = rec;
  await saveState(sub, state);
  await appendLog(sub, {
    ts: new Date(now).toISOString(),
    type: "mbe",
    id: question_id,
    subject: q.subject,
    subtopic: q.subtopic,
    correct,
  });

  return {
    correct,
    correctIndex: q.correctIndex,
    correct_choice: q.choices[q.correctIndex],
    explanation: q.explanation,
    rule: q.rule,
    question_stats: rec,
  };
}

async function toolGetStats(_args, sub) {
  const state = await loadState(sub);
  const deck = await activeDeck(sub);
  const now = Date.now();

  const perSubject = {};
  const bucket = (key) =>
    (perSubject[key] ??= {
      subject: subjectName.get(key) ?? key,
      card_reviews: 0,
      card_correct: 0,
      mbe_answered: 0,
      mbe_correct: 0,
    });
  if (deck.pref !== "custom") for (const key of SUBJECT_KEYS) bucket(key);
  for (const card of deck.cards) bucket(card.subject);

  let cardReviews = 0;
  let cardCorrect = 0;
  let cardsStarted = 0;
  let mastered = 0;
  let dueToday = 0;
  let dueTomorrow = 0;
  const endOfToday = Date.parse(new Date(now).toISOString().slice(0, 10)) + DAY_MS;
  for (const [cid, st] of Object.entries(state.cards)) {
    const card = deck.byId.get(cid);
    if (!card) continue; // review state for a card outside the active deck
    cardsStarted += 1;
    cardReviews += st.seen ?? 0;
    cardCorrect += st.correct ?? 0;
    if ((st.intervalDays ?? 0) >= MASTERED_INTERVAL_DAYS) mastered += 1;
    const due = Date.parse(st.due);
    if (due < endOfToday) dueToday += 1;
    else if (due < endOfToday + DAY_MS) dueTomorrow += 1;
    bucket(card.subject).card_reviews += st.seen ?? 0;
    bucket(card.subject).card_correct += st.correct ?? 0;
  }
  let mbeAnswered = 0;
  let mbeCorrect = 0;
  for (const [qid, rec] of Object.entries(state.mbe)) {
    const q = questionsById.get(qid);
    mbeAnswered += rec.answered ?? 0;
    mbeCorrect += rec.correct ?? 0;
    if (q && perSubject[q.subject]) {
      perSubject[q.subject].mbe_answered += rec.answered ?? 0;
      perSubject[q.subject].mbe_correct += rec.correct ?? 0;
    }
  }
  for (const s of Object.values(perSubject)) {
    s.card_accuracy = s.card_reviews ? Math.round((s.card_correct / s.card_reviews) * 100) / 100 : null;
    s.mbe_accuracy = s.mbe_answered ? Math.round((s.mbe_correct / s.mbe_answered) * 100) / 100 : null;
    const unified = unifiedAccuracy(s.mbe_correct, s.mbe_answered, s.card_correct, s.card_reviews);
    s.unified_accuracy = unified == null ? null : Math.round(unified * 100) / 100;
  }

  if (sub === DEMO_SUB) {
    const b = DEMO_STATS_BASELINE;
    cardReviews += b.totals.card_reviews; cardCorrect += b.totals.card_correct;
    cardsStarted += b.totals.cards_started; mastered += b.totals.cards_mastered;
    mbeAnswered += b.totals.mbe_answered; mbeCorrect += b.totals.mbe_correct;
    dueToday += b.due_today; dueTomorrow += b.due_tomorrow;
    for (const [k, [r, c]] of Object.entries(b.per_subject)) {
      bucket(k).card_reviews += r; bucket(k).card_correct += c;
    }
  }
  return {
    deck: deck.pref,
    totals: {
      card_reviews: cardReviews,
      card_correct: cardCorrect,
      card_accuracy: cardReviews ? Math.round((cardCorrect / cardReviews) * 100) / 100 : null,
      cards_started: cardsStarted,
      cards_in_deck: deck.cards.length,
      cards_mastered: mastered,
      mbe_answered: mbeAnswered,
      mbe_correct: mbeCorrect,
      mbe_accuracy: mbeAnswered ? Math.round((mbeCorrect / mbeAnswered) * 100) / 100 : null,
    },
    due_today: dueToday,
    due_tomorrow: dueTomorrow,
    per_subject: perSubject,
  };
}

async function toolGetWeakAreas({ limit = 10 } = {}, sub) {
  const state = await loadState(sub);
  const deck = await activeDeck(sub);
  const signals = unifiedSignals(state, deck.byId, questionsById);
  const areas = [];
  for (const [key, s] of signals) {
    if (s.mbeAnswered + s.fcAnswered <= 0) continue;
    const [subject, subtopic] = key.split("/");
    const unified = unifiedAccuracy(s.mbeCorrect, s.mbeAnswered, s.fcCorrect, s.fcAnswered) ?? 0;
    const ratio = ratioMap.get(key) ?? 0;
    areas.push({
      subject,
      subject_name: subjectName.get(subject) ?? subject,
      subtopic,
      subtopic_name: subtopicName.get(key) ?? subtopic,
      exam_ratio: ratio,
      unified_accuracy: Math.round(unified * 100) / 100,
      mbe_answered: s.mbeAnswered,
      mbe_correct: s.mbeCorrect,
      card_reviews: s.fcAnswered,
      card_correct: s.fcCorrect,
      source: s.mbeAnswered > 0 ? (s.fcAnswered > 0 ? "both" : "mbe") : "flashcards",
      priority_score: Math.round(ratio * (1 - unified) * 10000) / 10000,
    });
  }
  areas.sort((a, b) => b.priority_score - a.priority_score);
  const capped = areas.slice(0, Math.max(1, Math.min(50, Number(limit) || 10)));
  if (sub === DEMO_SUB) {
    const seen = new Set(capped.map((a) => `${a.subject}/${a.subtopic}`));
    const merged = [...capped, ...DEMO_STATS_BASELINE.weak_areas.filter((a) => !seen.has(`${a.subject}/${a.subtopic}`))]
      .sort((a, b) => b.priority_score - a.priority_score)
      .slice(0, limit);
    return { weak_areas: merged };
  }
  return { weak_areas: capped, note: capped.length ? undefined : "No signal yet — drill some cards or MBE questions first." };
}

// ---------------------------------------------------------------------------
// Custom deck tools: upload_rules → build_deck (chunked/resumable/paid) →
// set_deck.
// ---------------------------------------------------------------------------

async function toolUploadRules({ rules, text, mode = "add" } = {}, sub) {
  if (!["add", "replace"].includes(mode)) throw new ToolError('mode must be "add" or "replace".');
  let incoming = null;
  if (Array.isArray(rules) && rules.length) incoming = rules;
  else if (typeof text === "string" && text.trim()) incoming = rulesFromText(text);
  if (!incoming || !incoming.length) {
    throw new ToolError("Provide `rules` (array of {name, statement, subject?, subtopic?, priority?}) or `text` (raw rule sheet).");
  }

  const prior = await loadRules(sub);
  const existing = mode === "replace" ? [] : Array.isArray(prior.rules) ? prior.rules : [];

  let skipped = 0;
  const cleaned = [];
  for (const r of incoming) {
    const statement = String(r?.statement ?? "").replace(/\s+/g, " ").trim();
    if (statement.split(/\s+/).length < 8) {
      skipped += 1; // too short to be a self-contained rule
      continue;
    }
    cleaned.push({
      id: null, // assigned below
      name: String(r?.name ?? "").trim() || statement.split(/\s+/).slice(0, 8).join(" "),
      statement,
      subject: String(r?.subject ?? "").trim() || "custom",
      subtopic: String(r?.subtopic ?? "").trim() || "general",
      priority: ["H", "M", "L"].includes(r?.priority) ? r.priority : "M",
    });
  }
  const all = [...existing, ...cleaned];
  if (all.length > RULES_CAP) {
    throw new ToolError(`Rule cap is ${RULES_CAP} (this upload would make ${all.length}). Upload fewer rules or use mode "replace".`);
  }
  if (!all.length) throw new ToolError("No valid rules found — every statement must be at least 8 words.");
  all.forEach((r, i) => {
    r.id = r.id || `custom-rule-${String(i + 1).padStart(3, "0")}`;
  });

  await saveUserJson(sub, "custom-rules.json", { rules: all, updatedAt: new Date().toISOString() });
  if (mode === "replace") await saveCustomDeck(sub, []);

  // Reset the resumable build to cover the full rule set. A paid-but-unfinished
  // build keeps its credit when the user merely adds more rules.
  const priorState = await loadBuildState(sub);
  const keepPaid = mode === "add" && priorState.paid === true && (priorState.nextIndex ?? 0) < (priorState.totalRules ?? 0);
  await saveUserJson(sub, "build-state.json", {
    totalRules: all.length,
    nextIndex: 0,
    cardsBuilt: 0,
    startedAt: new Date().toISOString(),
    paid: keepPaid,
  });

  return {
    rules_total: all.length,
    added: cleaned.length,
    skipped_too_short: skipped,
    mode,
    note: "Rules stored. Now call build_deck (repeatedly, until done: true) to generate the flashcards.",
  };
}

// Interest counter for the not-yet-enabled paid build feature: appends per-sub
// counts to users/_system/interest.json so demand is measurable. Best-effort.
async function recordBuildInterest(sub) {
  try {
    const existing = await getFile("_system", "interest.json");
    const doc = existing ? JSON.parse(existing.body.toString()) : { requests: {}, updatedAt: null };
    const entry = doc.requests[sub] ?? { count: 0, firstAt: new Date().toISOString() };
    entry.count += 1;
    entry.lastAt = new Date().toISOString();
    doc.requests[sub] = entry;
    doc.updatedAt = new Date().toISOString();
    await putFile("_system", "interest.json", Buffer.from(JSON.stringify(doc, null, 2)), "application/json");
  } catch {
    // never let interest bookkeeping break the response
  }
}

async function toolBuildDeck(_args, sub, ctx = {}) {
  const rulesDoc = await loadRules(sub);
  const rules = Array.isArray(rulesDoc.rules) ? rulesDoc.rules : [];
  if (!rules.length) throw new ToolError("No custom rules uploaded — call upload_rules first.");

  let state = await loadBuildState(sub);
  if (!Number.isInteger(state.totalRules) || state.totalRules !== rules.length || !Number.isInteger(state.nextIndex)) {
    state = {
      totalRules: rules.length,
      nextIndex: 0,
      cardsBuilt: 0,
      startedAt: new Date().toISOString(),
      paid: false,
    };
  }
  if (state.nextIndex >= state.totalRules) {
    return {
      done: true,
      nextIndex: state.nextIndex,
      totalRules: state.totalRules,
      cardsBuilt: state.cardsBuilt,
      remaining: 0,
      note: 'Build already complete. Call set_deck {"deck":"custom"} or {"deck":"both"} to drill these cards.',
    };
  }

  // --- payment gate ------------------------------------------------------
  // Builds always run on the server's ANTHROPIC_API_KEY, paid for with a
  // one-time Stripe Checkout build credit. Check order matters: the
  // missing-env-key case must fail BEFORE any Stripe call so we never take
  // (or even request) a payment for a build the server cannot run.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  // Self-host mode: the operator pays Anthropic directly on their own key, so
  // builds are free — no Stripe, no easter egg. Never set on the hosted service.
  if (!state.paid && process.env.SELF_HOST_FREE_BUILDS === "1" && apiKey) {
    state.paid = true;
  }
  if (!state.paid && !stripeEnabled()) {
    // Preview easter egg: the feature is advertised but not switched on.
    // Record the request as an interest signal (best-effort) and respond
    // warmly as a NORMAL result so the client relays it, not as an error.
    await recordBuildInterest(sub);
    return {
      available: false,
      interest_noted: true,
      message:
        "You found custom deck builds early! Turning your own rule sheet into a drillable deck " +
        "isn't switched on in this free version yet — but your request was just recorded, and your " +
        "uploaded rules are safely stored, so the moment builds go live you're first in line. " +
        "If enough people ask, it ships. Tell the operator you want it!",
    };
  }
  if (!apiKey) {
    throw new ToolError(
      "server_misconfigured: card generation is unavailable — the server has no ANTHROPIC_API_KEY configured. No payment was requested; ask the server operator to fix this."
    );
  }
  if (!state.paid) {
    const billing = await loadBilling(sub);
    billing.credits = Number.isInteger(billing.credits) ? billing.credits : 0;
    if (billing.pendingSession) {
      let session = null;
      try {
        session = await retrieveCheckoutSession(billing.pendingSession);
      } catch {
        session = null;
      }
      if (session?.payment_status === "paid") {
        billing.credits += 1;
        billing.pendingSession = null;
        await saveUserJson(sub, "billing.json", billing);
      } else if (session?.url && billing.credits < 1) {
        return {
          payment_required: true,
          checkout_url: session.url,
          price_usd: deckBuildPriceCents() / 100,
          message: "Payment not yet received. Pay here, then ask me to continue the build: " + session.url,
        };
      } else {
        billing.pendingSession = null; // dead/expired session — recreate below
        await saveUserJson(sub, "billing.json", billing);
      }
    }
    if (billing.credits >= 1) {
      billing.credits -= 1; // consume one credit for this whole build
      await saveUserJson(sub, "billing.json", billing);
      state.paid = true;
      await saveUserJson(sub, "build-state.json", state);
    } else {
      const session = await createCheckoutSession(sub, ctx.origin);
      billing.pendingSession = session.id;
      await saveUserJson(sub, "billing.json", billing);
      return {
        payment_required: true,
        checkout_url: session.url,
        price_usd: deckBuildPriceCents() / 100,
        message: "Pay here, then ask me to continue the build: " + session.url,
      };
    }
  }

  // --- one chunk: one Anthropic call, validate, persist ----------------------
  const chunk = rules.slice(state.nextIndex, state.nextIndex + BUILD_CHUNK);
  let generated;
  try {
    generated = await generateCards(chunk, apiKey);
  } catch (e) {
    throw new ToolError(`Card generation failed (nothing was consumed for this chunk — call build_deck again): ${e?.message ?? e}`);
  }

  const deck = await loadCustomDeck(sub);
  const chunkRuleIds = new Set(chunk.map((r) => r.id));
  const cards = [...deck.cards.filter((c) => !chunkRuleIds.has(c.ruleId)), ...generated.cards]; // idempotent per rule
  await saveCustomDeck(sub, cards);

  state.nextIndex += chunk.length;
  state.cardsBuilt = cards.length;
  const done = state.nextIndex >= state.totalRules;
  await saveUserJson(sub, "build-state.json", state);

  return {
    done,
    nextIndex: state.nextIndex,
    totalRules: state.totalRules,
    cardsBuilt: state.cardsBuilt,
    remaining: state.totalRules - state.nextIndex,
    cards_added: generated.cards.length,
    cards_dropped_invalid: generated.dropped,
    note: done
      ? 'Deck complete. Call set_deck {"deck":"custom"} or {"deck":"both"}, then start drilling with next_card.'
      : "Not finished — call build_deck again NOW with the same arguments to process the next chunk.",
  };
}

async function toolSetDeck({ deck } = {}, sub) {
  if (!["default", "custom", "both"].includes(deck)) {
    throw new ToolError('deck must be "default", "custom", or "both".');
  }
  if (deck !== "default") {
    const custom = await loadCustomDeck(sub);
    if (!custom.cards.length) {
      throw new ToolError(`Deck "${deck}" needs custom cards, but none are built yet — call upload_rules, then build_deck until done: true.`);
    }
  }
  const prefs = await loadPrefs(sub);
  prefs.deck = deck;
  await saveUserJson(sub, "prefs.json", prefs);
  const active = await activeDeck(sub);
  return { deck, total_cards: active.cards.length, note: "Deck preference saved — next_card, get_due_summary, get_stats, and get_weak_areas now use this pool." };
}

const TOOL_HANDLERS = {
  get_due_summary: toolGetDueSummary,
  next_card: toolNextCard,
  get_hint: toolGetHint,
  submit_review: toolSubmitReview,
  next_mbe_question: toolNextMbeQuestion,
  submit_mbe_answer: toolSubmitMbeAnswer,
  get_stats: toolGetStats,
  get_weak_areas: toolGetWeakAreas,
  upload_rules: toolUploadRules,
  build_deck: toolBuildDeck,
  set_deck: toolSetDeck,
};

// ---------------------------------------------------------------------------
// JSON-RPC / HTTP plumbing
// ---------------------------------------------------------------------------

function json(status, obj) {
  return { status, contentType: "application/json", body: JSON.stringify(obj) };
}
function rpcResult(id, result) {
  return json(200, { jsonrpc: "2.0", id, result });
}
function rpcError(id, code, message, status = 200) {
  return json(status, { jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function secretMatches(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Handles the legacy /mcp/<secret> path (curl testing). Returns { status,
 * contentType, body } like the other lib handlers. Only active when the
 * MCP_SECRET env var is set (404 otherwise); identity is the shared
 * "default" user. The OAuth-protected /mcp route calls handleMcpRpc directly.
 */
export async function handleMcp(method, urlPath, rawBody, origin = "") {
  const secret = process.env.MCP_SECRET;
  const given = urlPath.slice("/mcp".length).replace(/^\//, "");
  if (!secret || !given || !secretMatches(given, secret)) return json(404, { error: "not_found" });

  if (method !== "POST") {
    // No SSE stream (GET) and no session teardown (DELETE) — stateless server.
    return json(405, { error: "method_not_allowed" });
  }
  return handleMcpRpc(rawBody, LEGACY_USER, origin);
}

/**
 * Processes one JSON-RPC message for the given user (`sub` — the per-user Blob
 * namespace). Stateless: every POST is a self-contained JSON-RPC message.
 * `origin` is the deployment's external origin (for Stripe redirect URLs).
 */
export async function handleMcpRpc(rawBody, sub, origin = "") {
  let msg;
  try {
    msg = JSON.parse(rawBody.toString("utf8") || "");
  } catch {
    return rpcError(null, -32700, "Parse error", 400);
  }
  if (Array.isArray(msg) || typeof msg !== "object" || msg === null || typeof msg.method !== "string") {
    return rpcError(msg?.id, -32600, "Invalid Request", 400);
  }

  // Notifications (no id) — including notifications/initialized — get 202 + empty body.
  if (!("id" in msg) || msg.id === undefined) {
    return { status: 202, contentType: "application/json", body: "" };
  }

  const { id, method: rpcMethod, params = {} } = msg;
  try {
    switch (rpcMethod) {
      case "initialize":
        return rpcResult(id, {
          protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: TOOLS });
      case "tools/call": {
        const name = params?.name;
        const handler = TOOL_HANDLERS[name];
        if (!handler) return rpcError(id, -32602, `Unknown tool: ${name}`);
        try {
          const payload = await handler(params?.arguments ?? {}, sub, { origin });
          return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(payload) }] });
        } catch (e) {
          const message = e instanceof ToolError ? e.message : `Tool failed: ${e?.message ?? e}`;
          return rpcResult(id, { content: [{ type: "text", text: message }], isError: true });
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${rpcMethod}`);
    }
  } catch (e) {
    return rpcError(id, -32603, `Internal error: ${e?.message ?? e}`);
  }
}
