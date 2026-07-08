# Question Bank JSON Schema

Each subject has one file: `data/questions/<subjectKey>.json`.

```json
{
  "subject": "torts",
  "questions": [
    {
      "id": "torts-001",
      "subject": "torts",
      "subtopic": "negligence",
      "rule": "Standard of care — reasonably prudent person",
      "priority": "H",
      "difficulty": 2,
      "stem": "Full MBE-style fact pattern ending in a call of the question…",
      "choices": [
        "Choice A text",
        "Choice B text",
        "Choice C text",
        "Choice D text"
      ],
      "correctIndex": 1,
      "explanation": "Why the correct answer is right AND why each distractor is wrong, stating the controlling black-letter rule."
    }
  ]
}
```

Field rules:
- `id`: `<subjectKey>-NNN`, zero padded, unique within the file.
- `subject` / `subtopic`: must exactly match keys in `blueprint.json`.
- `rule`: short name of the controlling black-letter rule being tested.
- `priority`: `"H"`, `"M"`, or `"L"` — how heavily the tested rule tends to be examined.
- `difficulty`: 1 (easy), 2 (medium), 3 (hard).
- `stem`: a self-contained MBE-style hypothetical. Written to be listenable when read by text-to-speech (avoid tables, citations, or layout-dependent text). Use generic parties ("a plaintiff", "the defendant", or simple names). 80–180 words.
- `choices`: exactly 4. Plausible distractors that each map to a recognizable wrong rule application.
- `correctIndex`: 0–3. Distribute roughly evenly across the file.
- `explanation`: 60–150 words, states the rule, applies it, and dispatches each wrong choice.

Content rules:
- Questions must be ORIGINAL work. Draw only on the black-letter rules themselves as the source of which rules to test; never copy prose from any commercial study product.
- Per-subject subtopic counts must match `bankCount` in `blueprint.json`.
- Within each subtopic, favor H-priority rules (~60% H / ~30% M / ~10% L where ratings exist).
- For Contracts, ~1/4 of questions across the file must involve a sale of goods governed by the UCC.
