# Claude app — bar-prep drills inside Claude

This directory makes AI Bar Prep a **Claude-native app**: a remote MCP connector that turns Claude (desktop, web, mobile — including voice mode) into a spaced-repetition drill coach for black-letter-law rules and MBE questions. It's multi-user: anyone adds the connector by URL, creates an account on the sign-in page (self-serve, no admin step), and drills the bundled **575-card default deck** across 10 subjects — or pastes their own rule sheet and has the server build a **custom deck** from it, then drills `default`, `custom`, or `both`. Custom builds are **in preview on the hosted service** (trying one records your interest and keeps your uploaded rules); **self-hosters build free** on their own Anthropic key (see [`../SELF_HOSTING.md`](../SELF_HOSTING.md)).

## Architecture

Claude talks MCP over HTTPS to `https://www.barprepmcp.com/mcp`, authorized per user with OAuth 2.1 (hosted sign-in page with a create-account tab; self-validating HMAC tokens, no database). The server owns everything Claude shouldn't be trusted with: SM-2 scheduling, cloze grading, hint delivery (`get_hint`; a hinted review caps at quality 4), the 196-question MBE bank, and chunked custom-deck builds (`upload_rules` → `build_deck` until `done: true` → `set_deck`). Per-user state — SRS schedule, review log, uploaded rules, custom cards — lives in Vercel Blob under `users/<email>/`, so progress follows the user across every device.

## Files

- [`SETUP.md`](./SETUP.md) — for new users: add the connector, create an account, create the Project, drill; plus the bring-your-own-rule-sheet flow, troubleshooting, and admin notes.
- [`PROJECT_INSTRUCTIONS.md`](./PROJECT_INSTRUCTIONS.md) — paste into the claude.ai Project; defines the drill-coach behavior, iron rules, the 0–5 recite grading rubric, and the custom-deck setup flow.
- [`LAUNCH_CHECKLIST.md`](./LAUNCH_CHECKLIST.md) — what a public launch still needs.

## Other clients

The **iOS app** (`AIBarPrep/`) and the **local desktop MCP server** (`mcp/`) remain usable against the same backend and question bank — the Blob state means progress is shared wherever you drill.
