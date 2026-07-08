# Flashcard Schema

Flashcards drill ONE black-letter rule statement each, with a single "cloze"
(blanked-out) span. Two drill modes are derived from the same card:

1. **Missing-piece MCQ** — the statement is shown with the cloze span blanked;
   4 options (the answer + 3 distractors).
2. **Fill-in-the-blank** — same blanked statement; the user types the missing
   piece (graded case/whitespace/punctuation-insensitively, with alternate
   phrasings and small-typo tolerance).

There are two file formats: the **rule-statements input** you supply, and the
**pre-computed flashcards output** produced by `tools/precompute_flashcards.py`
and bundled into the app.

## 1. Rule-statements input — `data/rules/<subject>.json`

This is what the user supplies. One file per subject (or a mixed file — see
below).

```json
{
  "subject": "torts",
  "rules": [
    {
      "id": "torts-rule-001",
      "subtopic": "negligence",
      "name": "Negligence elements",
      "priority": "H",
      "statement": "To establish negligence, a plaintiff must prove duty, breach, actual and proximate causation, and damages.",
      "acceptable": ["actual and proximate cause", "causation"]
    }
  ]
}
```

Field rules:
- `subject` (file level): must match a subject key in `blueprint.json`
  (`civpro`, `conlaw`, `contracts`, `crim`, `evidence`, `realprop`, `torts`).
- `id`: unique rule id, `<subjectKey>-rule-NNN` recommended.
- `subtopic`: must match a subtopic key of the subject in `blueprint.json`.
- `name`: short rule name (shown as the card title).
- `priority`: `"H"`, `"M"`, or `"L"` (how heavily the rule tends to be examined).
- `statement`: ONE self-contained rule sentence (or two short sentences),
  written to be listenable by TTS. The cloze heuristics work best when the
  statement uses markers like "must prove", "requires", "is defined as",
  "unless", "only if", or an enumerated element list ("A, B, C, and D").
- `acceptable` (optional): alternate correct phrasings for the *primary* card's
  typed answer. The pipeline attaches them to the first card emitted for the
  rule.

**Mixed files:** a file may omit the top-level `subject` (or set
`"subject": "mixed"`) if every rule carries its own `"subject"` key. The
bundled sample (`data/rules/sample.json`) does this and is marked
`"sample": true`.

Drop new files in `data/rules/`, run the pipeline, and copy the produced deck
into `AIBarPrep/AIBarPrep/Resources/Flashcards/` (or push it to the device at
`Documents/flashcards/<name>.json` — the app merges both locations at launch).
Because bundle resources are flattened, give decks file names that do not
collide with the question files (e.g. `flashcards-torts.json` or keep the
subject-per-file names unique).

## 2. Pre-computed flashcards — `data/flashcards/<subject>.json`

Produced by the pipeline; this is what the app loads.

```json
{
  "subject": "torts",
  "cards": [
    {
      "id": "fc-torts-0001",
      "ruleId": "torts-rule-001",
      "subject": "torts",
      "subtopic": "negligence",
      "rule": "Negligence elements",
      "priority": "H",
      "statement": "To establish negligence, a plaintiff must prove duty, breach, actual and proximate causation, and damages.",
      "clozeStart": 62,
      "clozeLength": 30,
      "answer": "actual and proximate causation",
      "acceptable": ["actual and proximate cause", "causation"],
      "distractors": [
        "foreseeability of the plaintiff",
        "breach of a statutory duty",
        "res ipsa loquitur"
      ]
    }
  ]
}
```

Validation rules (enforced by the pipeline and re-checked by the app):
- `statement[clozeStart : clozeStart + clozeLength]` must equal `answer`
  exactly. Offsets are counted in Unicode code points (Python string indices).
- Exactly **3** `distractors`, all distinct from each other and from
  `answer`/`acceptable` after normalization, and none appearing verbatim in
  the statement.
- `acceptable` may be empty; entries are alternate phrasings accepted in
  fill-in-the-blank mode.
- `subject`/`subtopic` must be valid `blueprint.json` keys (the app drops
  cards with unknown keys).
- `id`: `fc-<subjectKey>-NNNN`, unique across all decks. A rule may produce up
  to 2 cards (different cloze spans).
- A deck file may set `"sample": true` to mark demo content.

## 3. Grading (fill-in-the-blank)

The app normalizes both sides (lowercase, strip punctuation, collapse
whitespace) and accepts the input if it matches `answer` or any `acceptable`
entry, or is within a small Levenshtein distance of one of them (distance 2
for answers of 8+ characters, 1 for 5–7, exact below that).
