#!/usr/bin/env python3
"""Precompute flashcards from black-letter rule statements.

Reads data/rules/*.json and writes data/flashcards/<name>.json (one output per
input file, same stem). Stdlib only; fully deterministic by default.

Cloze-selection heuristics (documented, in order):
1. MARKER SCAN — find the first marker phrase from a fixed priority list
   ("must prove", "must show", ..., "requires", "is defined as", "means",
   "only if", "unless", "if"). The candidate segment is the text after the
   marker up to the next sentence boundary (period/semicolon) or end.
2. ENUMERATION — if the segment contains a comma-separated element list
   ("A, B, C, and D"), split it into elements (commas, optionally followed by
   "and"/"or"). The PRIMARY cloze is the longest element (after trimming
   leading stopwords/articles); the SECONDARY cloze (second card) is the
   second-longest element, if it is at least MIN_SPAN chars.
3. SHRINK — a span longer than MAX_SPAN chars is shrunk deterministically:
   prefer the longest comma-delimited part; else drop everything through the
   first " that "; else through the first " to "; else keep the last 8 words.
   Leading stopwords are re-trimmed after each step.
4. FALLBACK — if no marker matches, take the longest comma/semicolon-delimited
   clause of the whole statement, trimmed and shrunk the same way.

Distractors (deterministic): candidates are the answers of OTHER rules in the
SAME subject (never the same rule), ranked by closeness in length to the
correct answer (tie-break: card id). If fewer than 3 remain, candidates from
other subjects are appended with the same ranking. Candidates equal to the
answer/acceptable after normalization, duplicates, or phrases appearing
verbatim in the statement are skipped. Exactly 3 are required.

--llm mode: POSTs {statement, answer, subject, count} to a /generate-style
endpoint per card for better distractors, falling back to the deterministic
ones on any error. Off by default (no key/endpoint required).
"""

import argparse
import json
import re
import sys
import unicodedata
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

MARKERS = [
    "must prove",
    "must show",
    "must establish",
    "must demonstrate",
    "requires proof of",
    "requires that",
    "requires",
    "is defined as",
    "consists of",
    "means",
    "occurs when",
    "only if",
    "unless",
    "if",
]

LEADING_STOPWORDS = {
    "a", "an", "the", "that", "it", "is", "are", "its", "his", "her",
    "and", "or", "of", "to", "be",
}

MIN_SPAN = 6      # chars — spans shorter than this are rejected
MAX_SPAN = 72     # chars — spans longer than this get shrunk
ENUM_SPLIT = re.compile(r"[,;]\s*(?:and\s+|or\s+)?")


# ---------------------------------------------------------------------------
# Span selection
# ---------------------------------------------------------------------------

def _trim(statement, start, end):
    """Trim whitespace, leading stopwords, and trailing punctuation from the
    span [start, end); returns adjusted (start, end)."""
    while start < end and statement[start].isspace():
        start += 1
    while end > start and (statement[end - 1].isspace() or statement[end - 1] in ".;,:"):
        end -= 1
    # Strip leading enumeration markers ("(1) ", "1) ", "(a) ") and stopwords.
    changed = True
    while changed:
        changed = False
        text = statement[start:end]
        marker = re.match(r"(?:\(?\d{1,2}\)|\([a-z]\))\s+", text)
        if marker:
            start += marker.end()
            changed = True
            continue
        match = re.match(r"([A-Za-z']+)\s+", text)
        if match and match.group(1).lower() in LEADING_STOPWORDS:
            start += match.end()
            changed = True
    return start, end


def _shrink(statement, start, end):
    """Deterministically shrink an over-long span (see module docstring)."""
    while end - start > MAX_SPAN:
        text = statement[start:end]
        if ", " in text:
            parts = []
            offset = 0
            for piece in text.split(", "):
                parts.append((len(piece), start + offset, start + offset + len(piece)))
                offset += len(piece) + 2
            _, start, end = max(parts, key=lambda p: (p[0], -p[1]))
        elif " that " in text:
            start += text.index(" that ") + len(" that ")
        elif " to " in text:
            start += text.index(" to ") + len(" to ")
        else:
            words = list(re.finditer(r"\S+", text))
            if len(words) <= 8:
                break
            start += words[-8].start()
        start, end = _trim(statement, start, end)
    return _trim(statement, start, end)


def _segment_after_marker(statement):
    """Return (seg_start, seg_end) after the first marker, or None."""
    lower = statement.lower()
    for marker in MARKERS:
        idx = lower.find(marker + " ")
        if idx == -1:
            continue
        seg_start = idx + len(marker) + 1
        # Extend past semicolons that continue an enumeration ("; (2) ...",
        # "; and (3) ...") so numbered element lists stay in one segment.
        pos = seg_start
        while True:
            boundary = re.search(r"[.;]", statement[pos:])
            if not boundary:
                seg_end = len(statement)
                break
            bpos = pos + boundary.start()
            if statement[bpos] == ";" and re.match(
                    r"\s*(?:and\s+|or\s+)?\(?\d{1,2}\)", statement[bpos + 1:]):
                pos = bpos + 1
                continue
            seg_end = bpos
            break
        return seg_start, seg_end
    return None


def _enumeration_elements(statement, seg_start, seg_end):
    """Split the segment into enumerated elements, keeping absolute offsets."""
    text = statement[seg_start:seg_end]
    spans = []
    prev = 0
    for match in ENUM_SPLIT.finditer(text):
        spans.append((seg_start + prev, seg_start + match.start()))
        prev = match.end()
    spans.append((seg_start + prev, seg_end))
    trimmed = [_trim(statement, s, e) for s, e in spans]
    return [(s, e) for s, e in trimmed if e - s >= MIN_SPAN]


def choose_spans(statement):
    """Return up to 2 (start, length) cloze spans for the statement."""
    segment = _segment_after_marker(statement)
    if segment is None:
        # Fallback: longest clause of the whole statement.
        clauses = []
        prev = 0
        for match in re.finditer(r"[,;.]", statement):
            clauses.append((prev, match.start()))
            prev = match.end()
        clauses.append((prev, len(statement)))
        trimmed = [_trim(statement, s, e) for s, e in clauses]
        trimmed = [(s, e) for s, e in trimmed if e - s >= MIN_SPAN]
        if not trimmed:
            return []
        start, end = max(trimmed, key=lambda p: (p[1] - p[0], -p[0]))
        start, end = _shrink(statement, start, end)
        return [(start, end - start)] if end - start >= MIN_SPAN else []

    seg_start, seg_end = segment
    elements = _enumeration_elements(statement, seg_start, seg_end)
    spans = []
    if len(elements) >= 2:
        ordered = sorted(elements, key=lambda p: (-(p[1] - p[0]), p[0]))
        for start, end in ordered[:2]:
            start, end = _shrink(statement, start, end)
            if end - start >= MIN_SPAN:
                spans.append((start, end - start))
    else:
        start, end = _trim(statement, seg_start, seg_end)
        start, end = _shrink(statement, start, end)
        if end - start >= MIN_SPAN:
            spans.append((start, end - start))
    # A cloze that swallows (almost) the whole statement is useless.
    spans = [s for s in spans if s[1] <= 0.85 * len(statement)]
    return spans[:2]


# ---------------------------------------------------------------------------
# Distractors
# ---------------------------------------------------------------------------

def normalize(text):
    text = unicodedata.normalize("NFKD", text).lower()
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def pick_distractors(card, all_cards):
    answer_norm = normalize(card["answer"])
    banned = {answer_norm} | {normalize(a) for a in card["acceptable"]}
    statement_norm = normalize(card["statement"])

    def rank(pool):
        return sorted(pool, key=lambda c: (abs(len(c["answer"]) - len(card["answer"])), c["id"]))

    same_subject = rank([c for c in all_cards
                         if c["subject"] == card["subject"] and c["ruleId"] != card["ruleId"]])
    other_subject = rank([c for c in all_cards if c["subject"] != card["subject"]])

    picked, seen = [], set()
    for candidate in same_subject + other_subject:
        text = candidate["answer"]
        norm = normalize(text)
        if norm in banned or norm in seen or norm in statement_norm:
            continue
        seen.add(norm)
        picked.append(text)
        if len(picked) == 3:
            break
    return picked


def llm_distractors(card, endpoint, token):
    payload = json.dumps({
        "kind": "flashcard-distractors",
        "subject": card["subject"],
        "statement": card["statement"],
        "answer": card["answer"],
        "count": 3,
    }).encode()
    request = urllib.request.Request(endpoint, data=payload,
                                     headers={"Content-Type": "application/json"})
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=30) as response:
        body = json.load(response)
    distractors = body.get("distractors", [])
    answer_norm = normalize(card["answer"])
    cleaned, seen = [], set()
    for d in distractors:
        if not isinstance(d, str):
            continue
        norm = normalize(d)
        if not norm or norm == answer_norm or norm in seen:
            continue
        seen.add(norm)
        cleaned.append(d.strip())
    if len(cleaned) != 3:
        raise ValueError(f"endpoint returned {len(cleaned)} usable distractors")
    return cleaned


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

def load_blueprint():
    with open(REPO_ROOT / "blueprint.json") as fh:
        blueprint = json.load(fh)
    return {s["key"]: {t["key"] for t in s["subtopics"]} for s in blueprint["subjects"]}


def build_cards(rules_files, valid_keys):
    """First pass: cloze spans + card skeletons. Returns (files_out, errors)."""
    files_out = []   # (stem, file_subject, sample_flag, [cards])
    errors = []
    counters = {}

    for path in sorted(rules_files):
        with open(path) as fh:
            data = json.load(fh)
        file_subject = data.get("subject")
        sample_flag = bool(data.get("sample"))
        cards = []
        for rule in data.get("rules", []):
            subject = rule.get("subject", file_subject)
            subtopic = rule.get("subtopic", "")
            where = f"{path.name}:{rule.get('id', '?')}"
            if subject not in valid_keys:
                errors.append(f"{where}: unknown subject {subject!r}")
                continue
            if subtopic not in valid_keys[subject]:
                errors.append(f"{where}: unknown subtopic {subtopic!r} for {subject}")
                continue
            statement = rule["statement"].strip()
            spans = choose_spans(statement)
            if not spans:
                errors.append(f"{where}: no usable cloze span found")
                continue
            for span_index, (start, length) in enumerate(spans):
                counters[subject] = counters.get(subject, 0) + 1
                cards.append({
                    "id": f"fc-{subject}-{counters[subject]:04d}",
                    "ruleId": rule["id"],
                    "subject": subject,
                    "subtopic": subtopic,
                    "rule": rule["name"],
                    "priority": rule.get("priority", "M"),
                    "statement": statement,
                    "clozeStart": start,
                    "clozeLength": length,
                    "answer": statement[start:start + length],
                    "acceptable": list(rule.get("acceptable", [])) if span_index == 0 else [],
                    "distractors": [],
                })
        files_out.append((path.stem, file_subject or "mixed", sample_flag, cards))
    return files_out, errors


def validate(all_cards, valid_keys):
    errors = []
    seen_ids = set()
    for card in all_cards:
        cid = card["id"]
        if cid in seen_ids:
            errors.append(f"{cid}: duplicate card id")
        seen_ids.add(cid)
        start, length = card["clozeStart"], card["clozeLength"]
        if card["statement"][start:start + length] != card["answer"]:
            errors.append(f"{cid}: cloze bounds do not match answer")
        if len(card["distractors"]) != 3:
            errors.append(f"{cid}: expected 3 distractors, got {len(card['distractors'])}")
        if len(set(map(normalize, card["distractors"]))) != len(card["distractors"]):
            errors.append(f"{cid}: duplicate distractors")
        if normalize(card["answer"]) in map(normalize, card["distractors"]):
            errors.append(f"{cid}: answer duplicated in distractors")
        if card["subject"] not in valid_keys or card["subtopic"] not in valid_keys.get(card["subject"], set()):
            errors.append(f"{cid}: invalid subject/subtopic")
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--rules-dir", default=str(REPO_ROOT / "data" / "rules"))
    parser.add_argument("--out-dir", default=str(REPO_ROOT / "data" / "flashcards"))
    parser.add_argument("--llm", action="store_true",
                        help="use a /generate-style endpoint for distractors")
    parser.add_argument("--endpoint", default=None,
                        help="LLM endpoint URL (or env AIBARPREP_GENERATE_ENDPOINT)")
    parser.add_argument("--token", default=None,
                        help="bearer token (or env AIBARPREP_GENERATE_TOKEN)")
    args = parser.parse_args()

    import os
    endpoint = args.endpoint or os.environ.get("AIBARPREP_GENERATE_ENDPOINT")
    token = args.token or os.environ.get("AIBARPREP_GENERATE_TOKEN")

    rules_dir = Path(args.rules_dir)
    out_dir = Path(args.out_dir)
    rules_files = sorted(rules_dir.glob("*.json"))
    if not rules_files:
        print(f"No rule files found in {rules_dir}", file=sys.stderr)
        return 1

    valid_keys = load_blueprint()
    files_out, errors = build_cards(rules_files, valid_keys)
    all_cards = [card for _, _, _, cards in files_out for card in cards]

    # Second pass: distractors (needs the full card pool).
    for card in all_cards:
        deterministic = pick_distractors(card, all_cards)
        if args.llm and endpoint:
            try:
                card["distractors"] = llm_distractors(card, endpoint, token)
                continue
            except Exception as exc:  # noqa: BLE001 — fall back deterministically
                print(f"  [llm] {card['id']}: {exc}; using deterministic distractors",
                      file=sys.stderr)
        card["distractors"] = deterministic

    errors += validate(all_cards, valid_keys)

    out_dir.mkdir(parents=True, exist_ok=True)
    for stem, file_subject, sample_flag, cards in files_out:
        payload = {"subject": file_subject}
        if sample_flag:
            payload["sample"] = True
        payload["cards"] = cards
        out_path = out_dir / f"{stem}.json"
        with open(out_path, "w") as fh:
            json.dump(payload, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        print(f"Wrote {out_path} ({len(cards)} cards)")

    # Summary table.
    by_subject = {}
    for _, _, _, cards in files_out:
        for card in cards:
            entry = by_subject.setdefault(card["subject"], {"rules": set(), "cards": 0})
            entry["rules"].add(card["ruleId"])
            entry["cards"] += 1
    print(f"\n{'Subject':<12}{'Rules':>6}{'Cards':>7}")
    print("-" * 25)
    for subject in sorted(by_subject):
        entry = by_subject[subject]
        print(f"{subject:<12}{len(entry['rules']):>6}{entry['cards']:>7}")
    total_rules = sum(len(e["rules"]) for e in by_subject.values())
    print("-" * 25)
    print(f"{'TOTAL':<12}{total_rules:>6}{len(all_cards):>7}")

    if errors:
        print(f"\n{len(errors)} validation error(s):", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1
    print(f"\nAll {len(all_cards)} cards valid (cloze bounds, 3 distractors, blueprint keys).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
