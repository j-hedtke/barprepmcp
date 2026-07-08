// Bundles repo content into proxy/data/ so it deploys with the proxy.
//   node bundle-content.mjs
// Merges ../data/flashcards/*.json → data/cards.json (flat card list, deduped by id),
// ../data/questions/*.json → data/questions.json (flat question list), and copies
// ../blueprint.json → data/blueprint.json. proxy/data/ is COMMITTED — re-run this
// whenever the source decks/banks change, then commit the result.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const outDir = path.join(here, "data");
fs.mkdirSync(outDir, { recursive: true });

const blueprint = JSON.parse(fs.readFileSync(path.join(repoRoot, "blueprint.json"), "utf8"));
const validSubtopics = new Set();
for (const s of blueprint.subjects) for (const t of s.subtopics) validSubtopics.add(`${s.key}/${t.key}`);

function readDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ file: f, doc: JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) }));
}

// --- Flashcards ---
const cards = [];
const cardIds = new Set();
let droppedCards = 0;
for (const { file, doc } of readDir(path.join(repoRoot, "data", "flashcards"))) {
  for (const card of doc.cards || []) {
    const ok =
      card &&
      typeof card.id === "string" &&
      !cardIds.has(card.id) &&
      typeof card.statement === "string" &&
      typeof card.answer === "string" &&
      card.statement.includes(card.answer) &&
      Array.isArray(card.distractors) &&
      card.distractors.length === 3 &&
      validSubtopics.has(`${card.subject}/${card.subtopic}`);
    if (!ok) {
      droppedCards += 1;
      console.warn(`  ! dropped invalid/duplicate card ${card?.id ?? "<no id>"} (${file})`);
      continue;
    }
    cardIds.add(card.id);
    cards.push({
      id: card.id,
      ruleId: card.ruleId ?? null,
      subject: card.subject,
      subtopic: card.subtopic,
      rule: card.rule,
      priority: card.priority ?? "M",
      statement: card.statement,
      clozeStart: card.clozeStart,
      clozeLength: card.clozeLength,
      answer: card.answer,
      acceptable: Array.isArray(card.acceptable) ? card.acceptable : [],
      distractors: card.distractors,
      hintRecite: card.hintRecite || undefined,
      hintCloze: card.hintCloze || undefined,
      sample: doc.sample === true || undefined,
    });
  }
}

// --- Project instructions (served at GET /instructions for onboarding) ---
fs.copyFileSync(path.join(repoRoot, "claude-app", "PROJECT_INSTRUCTIONS.md"), path.join(outDir, "instructions.md"));

// --- MBE questions ---
const questions = [];
const questionIds = new Set();
let droppedQuestions = 0;
for (const { file, doc } of readDir(path.join(repoRoot, "data", "questions"))) {
  for (const q of doc.questions || []) {
    const ok =
      q &&
      typeof q.id === "string" &&
      !questionIds.has(q.id) &&
      typeof q.stem === "string" &&
      Array.isArray(q.choices) &&
      q.choices.length === 4 &&
      Number.isInteger(q.correctIndex) &&
      q.correctIndex >= 0 &&
      q.correctIndex <= 3 &&
      validSubtopics.has(`${q.subject}/${q.subtopic}`);
    if (!ok) {
      droppedQuestions += 1;
      console.warn(`  ! dropped invalid/duplicate question ${q?.id ?? "<no id>"} (${file})`);
      continue;
    }
    questionIds.add(q.id);
    questions.push(q);
  }
}

fs.writeFileSync(path.join(outDir, "cards.json"), JSON.stringify({ cards }, null, 1) + "\n");
fs.writeFileSync(path.join(outDir, "questions.json"), JSON.stringify({ questions }, null, 1) + "\n");
fs.writeFileSync(path.join(outDir, "blueprint.json"), JSON.stringify(blueprint, null, 1) + "\n");

console.log(
  `bundled ${cards.length} cards (${droppedCards} dropped), ${questions.length} questions (${droppedQuestions} dropped), blueprint v${blueprint.version} → ${outDir}`
);
