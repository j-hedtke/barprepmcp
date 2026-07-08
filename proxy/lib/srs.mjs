// SM-2-lite spaced repetition + unified MBE/flashcard weakness signal.
// Direct port of the iOS app's FlashcardSRS.applyReview (Models/FlashcardRecord.swift),
// FlashcardGrader (Models/Flashcard.swift), FlashcardEngine selection
// (Services/FlashcardEngine.swift), and StatsService.unifiedAccuracy
// (Services/StatsService.swift). Pure logic — no I/O; state persistence lives in
// lib/mcp.mjs (Blob via lib/store.mjs).

export const WEAKNESS_FACTOR = 2.0; // FlashcardEngine.weaknessFactor
export const FLASHCARD_ANSWER_WEIGHT = 0.5; // StatsService.flashcardAnswerWeight
export const MASTERED_INTERVAL_DAYS = 21;
const DAY_MS = 86_400_000;
const LAPSE_DELAY_MS = 10 * 60_000; // lapse → due again in 10 minutes

// ---------------------------------------------------------------------------
// Grading (typed cloze) — port of FlashcardGrader
// ---------------------------------------------------------------------------

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Length-scaled whole-string edit tolerance: exact below 5 chars (so "duty"
 * doesn't accept "dust"), 1 for 5–7, 2 for 8–19, 3 for 20–39, 4 for 40+.
 */
function typoTolerance(target) {
  if (target.length >= 40) return 4;
  if (target.length >= 20) return 3;
  if (target.length >= 8) return 2;
  if (target.length >= 5) return 1;
  return 0;
}

export function levenshtein(a, b) {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/**
 * Light suffix stemmer for grading, applied per normalized token.
 * Order matters: "ies"→"y", then strip "ing", "ed", "es", "s" — first suffix
 * whose result stays ≥3 chars wins. After "ing"/"ed", undouble a trailing
 * doubled consonant (Porter-style, except ll/ss/zz) so gemination pairs land
 * on one stem ("running"→"run"). "receiving" and "received" both → "receiv".
 */
export function stemToken(token) {
  if (token.length <= 3) return token;
  if (token.endsWith("ies") && token.length >= 5) return token.slice(0, -3) + "y"; // parties → party
  for (const suffix of ["ing", "ed"]) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) {
      let stem = token.slice(0, -suffix.length);
      const last = stem[stem.length - 1];
      if (stem.length >= 4 && last === stem[stem.length - 2] && !"aeioulsz".includes(last)) {
        stem = stem.slice(0, -1); // bann → ban
      }
      return stem;
    }
  }
  if (token.endsWith("es") && token.length - 2 >= 3) return token.slice(0, -2);
  if (token.endsWith("s") && !token.endsWith("ss") && token.length - 1 >= 3) return token.slice(0, -1);
  return token;
}

const stemmedTokens = (normalized) => normalized.split(" ").filter(Boolean).map(stemToken);

/**
 * Compare two stemmed token multisets (order-insensitive). Returns
 * { typos } when they match — typos = number of tokens that only matched a
 * counterpart at Levenshtein ≤ 1 on the stems — or null when they don't.
 * Known limitation: multiset matching cannot detect meaning-flipping
 * reorderings (e.g. "buyer pays seller" vs "seller pays buyer") — an accepted
 * trade-off for a self-graded study tool.
 */
export function multisetMatch(userStems, targetStems) {
  if (userStems.length < 2 || userStems.length !== targetStems.length) return null;
  const remaining = [...targetStems];
  const unmatched = [];
  for (const stem of userStems) {
    const i = remaining.indexOf(stem);
    if (i >= 0) remaining.splice(i, 1);
    else unmatched.push(stem);
  }
  for (const stem of unmatched) {
    const i = remaining.findIndex((t) => levenshtein(stem, t) <= 1);
    if (i < 0) return null;
    remaining.splice(i, 1);
  }
  return { typos: unmatched.length };
}

/**
 * Grade a typed/selected cloze answer against answer + acceptable alternates.
 * Returns { correct, quality }:
 *   5 — exact normalized match, or stemmed token-multiset equality with no
 *       typo-pairings (pure reordering/inflection is semantically identical);
 *   4 — multiset match that needed ≤1-edit stem pairings, or whole string
 *       within the length-scaled Levenshtein tolerance;
 *   2 — wrong.
 */
export function gradeTyped(input, answer, acceptable = []) {
  const typed = normalize(input);
  if (!typed) return { correct: false, quality: 2 };
  const targets = [answer, ...acceptable].map(normalize).filter(Boolean);
  for (const target of targets) {
    if (typed === target) return { correct: true, quality: 5 };
  }
  const typedStems = stemmedTokens(typed);
  let typoMultiset = false;
  if (typedStems.length >= 2) {
    for (const target of targets) {
      const m = multisetMatch(typedStems, stemmedTokens(target));
      if (m?.typos === 0) return { correct: true, quality: 5 };
      if (m) typoMultiset = true;
    }
  }
  for (const target of targets) {
    const tol = typoTolerance(target);
    if (tol > 0 && Math.abs(typed.length - target.length) <= tol && levenshtein(typed, target) <= tol) {
      return { correct: true, quality: 4 };
    }
  }
  if (typoMultiset) return { correct: true, quality: 4 };
  return { correct: false, quality: 2 };
}

// ---------------------------------------------------------------------------
// SM-2-lite scheduling — port of FlashcardSRS
// ---------------------------------------------------------------------------

export function newCardState(now = Date.now()) {
  return {
    ease: 2.5,
    intervalDays: 0,
    due: new Date(now).toISOString(),
    reps: 0,
    lapses: 0,
    seen: 0,
    correct: 0,
    typedCorrect: 0,
    typedSeen: 0,
    mcqCorrect: 0,
    mcqSeen: 0,
  };
}

/**
 * Correct: interval grows 1d → 3d → ×ease, ease drifts up +0.1 (max 3.0).
 * Wrong: lapse — ease −0.2 (min 1.3), reps reset, due again in 10 minutes.
 * Mutates and returns `state`.
 */
export function applyReview(state, wasCorrect, now = Date.now()) {
  if (wasCorrect) {
    state.reps += 1;
    if (state.reps === 1) state.intervalDays = 1;
    else if (state.reps === 2) state.intervalDays = 3;
    else state.intervalDays = Math.max(state.intervalDays, 3) * state.ease;
    state.ease = Math.min(state.ease + 0.1, 3.0);
    state.due = new Date(now + state.intervalDays * DAY_MS).toISOString();
  } else {
    state.lapses += 1;
    state.reps = 0;
    state.intervalDays = 0;
    state.ease = Math.max(state.ease - 0.2, 1.3);
    state.due = new Date(now + LAPSE_DELAY_MS).toISOString();
  }
  state.lastReviewed = new Date(now).toISOString();
  return state;
}

// ---------------------------------------------------------------------------
// Unified weakness — port of StatsService
// ---------------------------------------------------------------------------

/** unified = (mbeCorrect + 0.5·fcCorrect) / (mbeAnswered + 0.5·fcAnswered); null when no signal. */
export function unifiedAccuracy(mbeCorrect, mbeAnswered, fcCorrect, fcAnswered) {
  const weighted = mbeAnswered + FLASHCARD_ANSWER_WEIGHT * fcAnswered;
  if (weighted <= 0) return null;
  return (mbeCorrect + FLASHCARD_ANSWER_WEIGHT * fcCorrect) / weighted;
}

const keyOf = (subject, subtopic) => `${subject}/${subtopic}`;

/**
 * Per-subtopic raw counts from both item types.
 * srsState: { cards: {cardId: {seen, correct, …}}, mbe: {qid: {answered, correct, …}} }
 * Returns Map<"subject/subtopic", {mbeAnswered, mbeCorrect, fcAnswered, fcCorrect}>.
 */
export function unifiedSignals(srsState, cardsById, questionsById) {
  const signals = new Map();
  const bump = (key) => {
    if (!signals.has(key)) signals.set(key, { mbeAnswered: 0, mbeCorrect: 0, fcAnswered: 0, fcCorrect: 0 });
    return signals.get(key);
  };
  for (const [qid, rec] of Object.entries(srsState.mbe ?? {})) {
    const q = questionsById.get(qid);
    if (!q) continue;
    const s = bump(keyOf(q.subject, q.subtopic));
    s.mbeAnswered += rec.answered ?? 0;
    s.mbeCorrect += rec.correct ?? 0;
  }
  for (const [cid, rec] of Object.entries(srsState.cards ?? {})) {
    const c = cardsById.get(cid);
    if (!c) continue;
    const s = bump(keyOf(c.subject, c.subtopic));
    s.fcAnswered += rec.seen ?? 0;
    s.fcCorrect += rec.correct ?? 0;
  }
  return signals;
}

export function blueprintMaps(blueprint) {
  const ratio = new Map();
  const subjectName = new Map();
  const subtopicName = new Map();
  for (const s of blueprint.subjects) {
    subjectName.set(s.key, s.name);
    for (const t of s.subtopics) {
      ratio.set(keyOf(s.key, t.key), t.ratio);
      subtopicName.set(keyOf(s.key, t.key), t.name);
    }
  }
  return { ratio, subjectName, subtopicName };
}

/** weight ∝ ratio × (1 + 2·(1 − accuracy)); accuracy 0 when no signal (full boost). */
export function weaknessWeight(key, signals, ratioMap) {
  const s = signals.get(key);
  const acc = s ? unifiedAccuracy(s.mbeCorrect, s.mbeAnswered, s.fcCorrect, s.fcAnswered) ?? 0 : 0;
  const ratio = ratioMap.get(key) ?? 0.1;
  return Math.max(ratio * (1 + WEAKNESS_FACTOR * (1 - acc)), 0.0001);
}

export function weightedRandom(entries, rng = Math.random) {
  // entries: [{ key, weight }]
  const total = entries.reduce((a, e) => a + e.weight, 0);
  if (total <= 0) return entries.length ? entries[Math.floor(rng() * entries.length)].key : null;
  let roll = rng() * total;
  for (const e of entries) {
    roll -= e.weight;
    if (roll < 0) return e.key;
  }
  return entries.length ? entries[entries.length - 1].key : null;
}

// ---------------------------------------------------------------------------
// Selection — port of FlashcardEngine.pickCard
// ---------------------------------------------------------------------------

/**
 * Order of preference: 1) DUE cards (soonest first), 2) NEW cards weighted by
 * unified weakness per subtopic, 3) not-yet-due review cards (soonest due).
 * Avoids `avoidId` (the last-served card) unless it's the only candidate.
 */
export function pickNextCard(cards, srsState, blueprint, { subject = null, avoidId = null, now = Date.now(), signals = null, rng = Math.random } = {}) {
  const { ratio } = blueprintMaps(blueprint);
  let pool = subject ? cards.filter((c) => c.subject === subject) : cards;
  if (!pool.length) return null;
  let fresh = pool.filter((c) => c.id !== avoidId);
  if (!fresh.length) fresh = pool;

  // 1. Due cards, soonest due first.
  const due = fresh
    .map((c) => ({ c, st: srsState.cards?.[c.id] }))
    .filter(({ st }) => st && Date.parse(st.due) <= now)
    .sort((a, b) => Date.parse(a.st.due) - Date.parse(b.st.due));
  if (due.length) return due[0].c;

  // 2. New cards, weakness-weighted by subtopic.
  const newCards = fresh.filter((c) => !srsState.cards?.[c.id]);
  if (newCards.length) {
    const groups = new Map();
    for (const c of newCards) {
      const key = keyOf(c.subject, c.subtopic);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    const entries = [...groups.keys()].map((key) => ({ key, weight: weaknessWeight(key, signals ?? new Map(), ratio) }));
    const chosen = weightedRandom(entries, rng);
    const group = groups.get(chosen) ?? newCards;
    return group[Math.floor(rng() * group.length)];
  }

  // 3. Review cards not yet due, soonest due first.
  const upcoming = fresh
    .map((c) => ({ c, st: srsState.cards?.[c.id] }))
    .filter(({ st }) => st)
    .sort((a, b) => Date.parse(a.st.due) - Date.parse(b.st.due));
  return upcoming.length ? upcoming[0].c : null;
}

/**
 * MBE question selection: pick a subtopic weighted by unified weakness, then a
 * question within it — never-answered first, else least-recently answered.
 * Avoids ids in `recentIds` (recently served) unless nothing else remains.
 */
export function pickNextQuestion(questions, srsState, blueprint, { subject = null, recentIds = [], signals = null, rng = Math.random } = {}) {
  const { ratio } = blueprintMaps(blueprint);
  let pool = subject ? questions.filter((q) => q.subject === subject) : questions;
  if (!pool.length) return null;
  const recent = new Set(recentIds);
  let candidates = pool.filter((q) => !recent.has(q.id));
  if (!candidates.length) candidates = pool;

  const groups = new Map();
  for (const q of candidates) {
    const key = keyOf(q.subject, q.subtopic);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(q);
  }
  const entries = [...groups.keys()].map((key) => ({ key, weight: weaknessWeight(key, signals ?? new Map(), ratio) }));
  const chosen = weightedRandom(entries, rng);
  const group = groups.get(chosen) ?? candidates;

  const unanswered = group.filter((q) => !srsState.mbe?.[q.id]);
  if (unanswered.length) return unanswered[Math.floor(rng() * unanswered.length)];
  const byOldest = [...group].sort(
    (a, b) => Date.parse(srsState.mbe[a.id]?.lastAnswered ?? 0) - Date.parse(srsState.mbe[b.id]?.lastAnswered ?? 0)
  );
  return byOldest[0];
}

/**
 * Cloze split — port of Flashcard.clozeRange: trust offsets when
 * statement[clozeStart ..< +clozeLength] === answer, else fall back to the
 * first occurrence of `answer`. Returns [prefix, suffix] or null.
 */
export function clozeParts(card) {
  const { statement, clozeStart, clozeLength, answer } = card;
  if (
    Number.isInteger(clozeStart) &&
    clozeStart >= 0 &&
    Number.isInteger(clozeLength) &&
    clozeLength > 0 &&
    statement.slice(clozeStart, clozeStart + clozeLength) === answer
  ) {
    return [statement.slice(0, clozeStart), statement.slice(clozeStart + clozeLength)];
  }
  const i = statement.indexOf(answer);
  if (i >= 0) return [statement.slice(0, i), statement.slice(i + answer.length)];
  return null;
}

/** Consecutive study days ending today or yesterday (UTC), from drill-log events. */
export function studyStreak(events, now = Date.now()) {
  const days = new Set(
    (events ?? []).map((e) => new Date(Date.parse(e.ts)).toISOString().slice(0, 10)).filter((d) => d !== "Invalid Da")
  );
  if (!days.size) return 0;
  let cursor = new Date(now);
  let streak = 0;
  // A streak may end today or yesterday (today's session not started yet).
  if (!days.has(cursor.toISOString().slice(0, 10))) cursor = new Date(cursor.getTime() - DAY_MS);
  while (days.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor = new Date(cursor.getTime() - DAY_MS);
  }
  return streak;
}
