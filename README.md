# barprepmcp — AI Bar Prep, self-hosted

A self-hosted, spaced-repetition **bar-exam drill coach for Claude**. It's a remote
[MCP](https://modelcontextprotocol.io) connector: deploy it to your own Vercel account,
add one URL to claude.ai, and Claude becomes a drill coach that quizzes you on
black-letter-law rules and MBE-style questions, tracks what's due with server-side
spaced repetition (SM-2), and grades your recall strictly. Your accounts, schedules,
and decks live entirely in **your** infrastructure.

This repo contains the full engine and tooling. It ships with **196 original,
AI-authored MBE practice questions** and a small **sample rule deck** — but no
proprietary study content (see the note at the bottom).

## Quick start

Requirements: [Node.js](https://nodejs.org) ≥ 18 (macOS/Linux, or Windows via WSL) and
`openssl`. A free Vercel account is created during login if you don't have one.

```sh
git clone https://github.com/<you>/barprepmcp.git && cd barprepmcp
./scripts/self-host.sh
```

The script logs you into Vercel, creates a project and a private Blob store, generates
your `AUTH_SECRET` and a personal invite code, optionally enables custom deck builds on
your own Anthropic API key, bundles the content, deploys, and prints your connector URL.
Then, on claude.ai: **Settings → Connectors → Add custom connector →
`https://<your-deployment>.vercel.app/mcp`**, create your account with the invite code,
paste [`claude-app/PROJECT_INSTRUCTIONS.md`](claude-app/PROJECT_INSTRUCTIONS.md) into a
Project, and say **"drill me"**. Full walkthrough in
[`SELF_HOSTING.md`](SELF_HOSTING.md) and [`claude-app/SETUP.md`](claude-app/SETUP.md).

## Loading your own rule sheet

The bundled deck is intentionally small. To drill your own outline (a state-specific
rule sheet, a bar-course handout, class notes), there are two paths:

1. **Inside Claude (easiest).** Paste your rules into the chat and ask Claude to upload
   and build a deck: it calls `upload_rules`, then `build_deck`, which generates cloze
   cards, distractors, and hints from your rules via the Anthropic API. Self-hosters run
   this **free** by setting `ANTHROPIC_API_KEY` and `SELF_HOST_FREE_BUILDS=1` (the
   deploy script offers both) — you pay Anthropic directly for exactly what you build.
2. **Precompute locally.** Drop rule files into `data/rules/` following
   [`FLASHCARD_SCHEMA.md`](FLASHCARD_SCHEMA.md), run
   `python3 tools/precompute_flashcards.py` to emit `data/flashcards/<name>.json`, then
   `node proxy/bundle-content.mjs` and redeploy. See `data/rules/sample.json` for the
   input format.

Only upload content you own or are licensed to use.

## Architecture

Claude talks MCP over HTTPS to `POST /mcp` on your Vercel deployment
(`proxy/index.mjs`), authorized per user with OAuth 2.1 (a hosted sign-in page with a
create-account tab; self-validating HMAC tokens, no database — `proxy/lib/oauth.mjs`).
The server (`proxy/lib/mcp.mjs`) owns everything the model shouldn't be trusted with:
SM-2 scheduling, cloze grading, hint delivery, the MBE question bank, and chunked
custom-deck builds. Bundled content lives in `proxy/data/` (regenerated from
`data/flashcards`, `data/questions`, and `blueprint.json` by `proxy/bundle-content.mjs`),
and per-user state — SRS schedule, review log, uploaded rules, custom cards — lives in
Vercel Blob under `users/<email>/`, so progress follows you across every device.

## License

MIT — see [`LICENSE`](LICENSE). Copyright © 2026 Joshua Hedtke.

## A note on content

The maintainer runs a hosted instance of this project, but **this repository contains no
proprietary study content**. The 196 MBE questions in `data/questions/` are original,
AI-authored work published under the MIT license; `data/rules/sample.json` is a small set
of universally known black-letter standards written for this repo. The full study deck
used by the hosted service is derived from separately licensed material and is **not**
included here — bring your own rule sheet (see above) to build a deck.
