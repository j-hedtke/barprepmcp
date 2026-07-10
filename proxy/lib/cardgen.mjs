// Flashcard generation from user-uploaded rule statements — one Anthropic
// Messages API call per ~8-rule chunk (raw fetch, zero-dep). The model returns
// strict JSON cards WITHOUT cloze offsets; the server computes clozeStart /
// clozeLength via statement.indexOf(answer) and validates every card against
// the deck quality bar, dropping invalid ones.
//
// Env:
//   CARDGEN_MODEL       model id (default "claude-fable-5")
//   ANTHROPIC_API_BASE  API origin (default https://api.anthropic.com;
//                       overridable so tests can point at a local stub)
// The API key is supplied per call by lib/mcp.mjs (always the server's
// ANTHROPIC_API_KEY; builds are enabled via SELF_HOST_FREE_BUILDS=1).

const anthropicBase = () => process.env.ANTHROPIC_API_BASE || "https://api.anthropic.com";
const cardgenModel = () => process.env.CARDGEN_MODEL || "claude-fable-5";
const MAX_TOKENS = 16000; // generous — fable-5 thinking tokens count against max_tokens

// ---------------------------------------------------------------------------
// Prompt — embeds the card quality bar (see FLASHCARD_SCHEMA.md and the
// bundled deck): load-bearing 3-12 word exact-substring cloze, 3 distractors
// that pass the substitution test, structure-only hintRecite, role-only
// hintCloze sharing no content words with the answer.
// ---------------------------------------------------------------------------

export function buildPrompt(rules) {
  return `You are generating bar-exam flashcards from black-letter rule statements.

For EACH rule in <rules> below, produce EXACTLY ONE flashcard object with these fields:
- "ruleId": the rule's id, copied exactly.
- "answer": the single legally load-bearing span of the rule statement — the phrase a bar examinee must know cold (an element, a standard, a numeric threshold, an exception). It MUST be an EXACT character-for-character substring of that rule's statement (same case, spacing, and punctuation), 3 to 12 words long, never starting or ending mid-word.
- "distractors": exactly 3 alternatives that (a) are grammatically correct when pasted into the blank in place of the answer, (b) sound legally plausible to a novice but are WRONG, and (c) are distinct from the answer and from each other. Apply the substitution test: read the full statement with each distractor in the blank — it must read naturally and be believable-but-incorrect.
- "hintRecite": a structural skeleton of the whole rule for recitation from memory — describe the SHAPE only ("Define the doctrine, list the three elements, then state the exception"), with ZERO substantive content.
- "hintCloze": a short description of the ROLE the blanked span plays in the rule (e.g. "the standard the actor must meet", "the numeric threshold"). It must give away nothing: no word of 4 or more letters that appears in the answer may appear in the hint.
- "acceptable": optional array (may be empty) of alternate phrasings a grader should accept for a typed answer.

Return ONLY strict JSON, no prose, no markdown fences, in exactly this shape:
{"cards":[{"ruleId":"...","answer":"...","distractors":["...","...","..."],"hintRecite":"...","hintCloze":"...","acceptable":[]}]}

<rules>
${JSON.stringify(rules.map(({ id, name, subject, subtopic, statement }) => ({ id, name, subject, subtopic, statement })), null, 1)}
</rules>`;
}

// ---------------------------------------------------------------------------
// Validation — exact substring, 3 distinct distractors ≠ answer, both hint
// fields present, hintCloze shares no 4+-letter content word with the answer.
// ---------------------------------------------------------------------------

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const contentWords = (s) => String(s ?? "").toLowerCase().match(/[\p{L}]{4,}/gu) ?? [];

export function validateCard(raw, rule) {
  if (!raw || typeof raw !== "object" || !rule) return null;
  const answer = typeof raw.answer === "string" ? raw.answer : "";
  if (!answer.trim()) return null;
  const clozeStart = rule.statement.indexOf(answer); // server computes offsets
  if (clozeStart < 0) return null; // must be an exact substring

  const distractors = Array.isArray(raw.distractors)
    ? raw.distractors.filter((d) => typeof d === "string" && d.trim()).map((d) => d.trim())
    : [];
  if (distractors.length !== 3) return null;
  const normed = new Set(distractors.map(norm));
  if (normed.size !== 3 || normed.has(norm(answer))) return null; // distinct, ≠ answer

  const hintRecite = typeof raw.hintRecite === "string" ? raw.hintRecite.trim() : "";
  const hintCloze = typeof raw.hintCloze === "string" ? raw.hintCloze.trim() : "";
  if (!hintRecite || !hintCloze) return null;
  const answerWords = new Set(contentWords(answer));
  if (contentWords(hintCloze).some((w) => answerWords.has(w))) return null;

  return {
    id: `cfc-${rule.id}`,
    ruleId: rule.id,
    subject: rule.subject,
    subtopic: rule.subtopic,
    rule: rule.name,
    priority: rule.priority,
    statement: rule.statement,
    clozeStart,
    clozeLength: answer.length,
    answer,
    acceptable: Array.isArray(raw.acceptable)
      ? raw.acceptable.filter((a) => typeof a === "string" && a.trim()).slice(0, 8)
      : [],
    distractors,
    hintRecite,
    hintCloze,
  };
}

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model returned no JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

// ---------------------------------------------------------------------------
// One chunk = one Messages API call. Returns { cards, dropped }.
// ---------------------------------------------------------------------------

export async function generateCards(rules, apiKey) {
  const model = cardgenModel();
  const headers = {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
  };
  const body = {
    model,
    max_tokens: MAX_TOKENS,
    messages: [{ role: "user", content: buildPrompt(rules) }],
  };
  // claude-fable-5: thinking is always on (no `thinking` param), and its safety
  // classifiers can decline with stop_reason "refusal" — opt into the
  // server-side fallback so a false positive is re-served by Opus 4.8.
  if (model.startsWith("claude-fable")) {
    headers["anthropic-beta"] = "server-side-fallback-2026-06-01";
    body.fallbacks = [{ model: "claude-opus-4-8" }];
  }

  const r = await fetch(`${anthropicBase()}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Anthropic API error (${r.status}): ${text.slice(0, 300)}`);
  }
  const msg = await r.json();
  if (msg.stop_reason === "refusal") {
    throw new Error("The model declined to generate cards for this batch of rules.");
  }
  const text = (msg.content ?? [])
    .filter((b) => b?.type === "text")
    .map((b) => b.text)
    .join("");
  const parsed = extractJson(text);
  const rawCards = Array.isArray(parsed?.cards) ? parsed.cards : [];

  const ruleById = new Map(rules.map((r2) => [r2.id, r2]));
  const seen = new Set();
  const cards = [];
  let dropped = 0;
  for (const raw of rawCards) {
    const rule = ruleById.get(raw?.ruleId);
    if (!rule || seen.has(rule.id)) {
      dropped += 1;
      continue;
    }
    const card = validateCard(raw, rule);
    if (!card) {
      dropped += 1;
      continue;
    }
    seen.add(rule.id);
    cards.push(card);
  }
  if (dropped) console.warn(`[cardgen] dropped ${dropped} invalid card(s) in a ${rules.length}-rule chunk`);
  return { cards, dropped };
}
