# Claude app — bar-prep drills inside Claude

This directory makes AI Bar Prep a **Claude-native app**: a remote MCP connector that turns Claude (desktop, web, mobile — including voice mode) into a spaced-repetition drill coach for black-letter-law rules and MBE questions. It's multi-user: anyone you invite adds the connector by URL, creates an account on the sign-in page (self-serve with an invite code, no admin step), and drills your bundled deck — or pastes their own rule sheet and has the server build a **custom deck** from it (free when self-hosting with your own Anthropic key), then drills `default`, `custom`, or `both`. The bundled default deck in this repo is a small sample; bring your own rule sheet to build a full one (see the top-level `README.md`).

## Architecture

Claude talks MCP over HTTPS to `POST /mcp` on your deployment, authorized per user with OAuth 2.1 (hosted sign-in page with a create-account tab; self-validating HMAC tokens, no database). The server owns everything Claude shouldn't be trusted with: SM-2 scheduling, cloze grading, hint delivery (`get_hint`; a hinted review caps at quality 4), the 196-question MBE bank, and chunked custom-deck builds (`upload_rules` → `build_deck` until `done: true` → `set_deck`). Per-user state — SRS schedule, review log, uploaded rules, custom cards — lives in Vercel Blob under `users/<email>/`, so progress follows the user across every device.

## Files

- [`SETUP.md`](./SETUP.md) — for new users: add the connector, create an account, create the Project, drill; plus the bring-your-own-rule-sheet flow, troubleshooting, and admin notes.
- [`PROJECT_INSTRUCTIONS.md`](./PROJECT_INSTRUCTIONS.md) — paste into the claude.ai Project; defines the drill-coach behavior, iron rules, the 0–5 recite grading rubric, and the custom-deck setup flow.
