# Setup — AI Bar Prep as a Claude connector

AI Bar Prep turns Claude — desktop, web, or the mobile app (text chats; see the
hands-free note below) — into a
spaced-repetition bar-exam drill coach. It's a remote MCP connector: you add one URL,
create an account, and drill. All scheduling state lives server-side, so your progress
follows you across devices.

## Quick start

1. **Add the connector.** Go to [claude.ai](https://claude.ai) → **Settings** →
   **Connectors** → **Add custom connector** and enter:
   ```
   https://www.barprepmcp.com/mcp
   ```
2. **Create your account.** Claude opens the AI Bar Prep sign-in page. Switch to the
   **Create account** tab — sign-ups are invite-only, so you'll need an invite code
   from the operator. Enter it with your email and a password of your choosing
   (minimum 8 characters), and you're signed in immediately. No approval step.
   Next time, sign in with the same email + password (no invite code needed).
3. **Enable it in a chat.** Click the tools/connectors icon next to the input box,
   toggle **AI Bar Prep** on, and make sure all its tools are enabled.
4. **Create a drill Project.** claude.ai → **Projects** → **Create Project** (name it
   e.g. **Bar Drill**), open **Project instructions**, and paste the full contents of
   [`PROJECT_INSTRUCTIONS.md`](./PROJECT_INSTRUCTIONS.md).
5. **Drill.** Start a chat in the Project, confirm the connector is toggled on, and
   say **"drill me"**. Claude pulls what's due and starts a session against the
   default deck — 575 cards across 10 subjects of black-letter law, plus a
   196-question MBE bank. New cards start as multiple choice; reviews graduate to
   typed fill-in-the-blank and full recitation graded 0–5.

Connectors are account-level: add it once and it's available on mobile too.

## Hands-free drilling on your phone

**Heads-up: Claude's voice mode does not currently support connectors** — a voice-mode
conversation can't reach the drill server at all (you'll see "not connected" errors).
Use a regular text chat in the mobile app instead; it has full tool access. For a
mostly-hands-free loop:

1. Open your **Bar Drill** Project → new chat → confirm the connector is toggled on.
2. Answer by **dictation**: tap the keyboard's mic and speak your answer or recitation.
3. Have prompts read aloud with the OS screen reader — on iOS enable
   **Settings → Accessibility → Spoken Content → Speak Screen**, then two-finger
   swipe down from the top (or ask Siri to "speak screen") to hear the card.

If Anthropic adds connector support to voice mode, true voice drilling will work here
with no changes — the coach instructions already cover it.

## Optional: bring your own rule sheet

**Heads-up before you paste anything: on the hosted service, custom deck builds are
currently in preview.** Trying a build registers your interest (so the operator knows
you want it) and your uploaded rules are kept safe for the moment builds go live —
but no cards are generated yet. If you want to build a custom deck *today*, self-host
with your own Anthropic API key and builds are free — see
[`SELF_HOSTING.md`](../SELF_HOSTING.md).

The default deck covers the standard subjects, but if you have your own outline — a
state-specific rule sheet, a bar-course handout, your class notes — you can build a
custom deck from it, right inside Claude.

1. **Upload your rules.** Paste your rule sheet into the chat and ask Claude to
   upload it. Claude structures the text into rule entries (name, statement, and
   optionally subject/subtopic/priority) and calls `upload_rules`. If structuring
   fails, a plain-text fallback still gets your material to the server. Only upload
   content you own or are licensed to use.
2. **Build the deck.** Ask Claude to build your deck; it calls `build_deck`, which
   generates high-quality cloze cards, distractors, and hints from your rules using
   the Anthropic API. Building is **chunked**: each call processes a batch, so keep
   saying **"continue building"** until the server reports `done: true`. If a session
   gets cut off, just say **"continue building"** — it resumes where it stopped.
   **On the hosted service** builds are in preview: trying registers your interest
   and your uploaded rules are kept, ready for when builds switch on. **Self-hosters**
   build free with their own key (see [`SELF_HOSTING.md`](../SELF_HOSTING.md)).
3. **Choose what you drill.** Ask Claude to call `set_deck` with `default`, `custom`,
   or `both`. The bundled deck is the default; `both` interleaves your custom cards
   with it.

Your custom deck gets the same scheduling, hints, and strict grading as the default
one.

## Troubleshooting

**Connector won't add / sign-in page never appears**
- Check the URL: exactly `https://www.barprepmcp.com/mcp` — no trailing path.
- Confirm the server is up: `curl -s https://www.barprepmcp.com/.well-known/oauth-authorization-server`
  should return JSON metadata, not a 404 page.

**Sign-in rejects your email/password**
- Emails and passwords are matched case-insensitively (leading/trailing spaces are
  trimmed).
- If you never created an account, use the **Create account** tab first — you'll
  need an operator invite code, and the password must be at least 8 characters.
- "That invite code isn't valid" means the invite is wrong, expired (rotated), or
  missing — ask the operator for a current one. If the tab says sign-ups are
  closed, the operator isn't accepting new accounts right now.

**Tools error mid-session**
- Remove and re-add the connector to sign in again — tokens last 30 days and refresh
  automatically, but a stale token after a server change can require a fresh sign-in.
- If it persists, contact support (see the server operator's contact info).

**Custom deck build stalls**
- Say **"continue building"** — builds are chunked and resumable; nothing is lost.
- If `build_deck` says custom deck builds aren't switched on yet, that's the hosted
  service's preview mode: your interest is recorded and your uploaded rules are kept.
  To build today, self-host with your own Anthropic key
  ([`SELF_HOSTING.md`](../SELF_HOSTING.md)).

## Admin notes (server operators only)

Everything below is configuration on the Vercel project
(dashboard → barprepmcp → Settings → Environment Variables, **Production**).
**Redeploy after changing env vars** — changes don't apply to existing deployments.

- `AUTH_SECRET` — signs all OAuth artifacts (client ids, codes, tokens). Required.
- `BLOB_READ_WRITE_TOKEN` — Vercel Blob token; all per-user state
  (`users/<email>/…`) lives in Blob, so a missing/rotated token breaks every
  stateful tool.
- `INVITE_CODES` — comma-separated operator-issued invite codes that gate
  self-serve signup (codes are trimmed and matched case-insensitively). Unset or
  empty → sign-ups are **closed**: the Create account tab shows a closed notice
  and register attempts are rejected; sign-in is unaffected. Each signup records
  which invite it used (`invite` on its registry entry), so cohorts are
  attributable per code. Rotate codes by editing the env var and redeploying.
- `DRILL_USERS` — optional legacy env-provisioned accounts,
  `email:accessCode,email2:code2` (the "access code" is what the UI now calls the
  password). Still honored alongside self-serve signup; not invite-gated.
- `MCP_SECRET` — optional legacy path secret: `POST /mcp/<MCP_SECRET>` maps to the
  shared `default` user, handy for curl testing. Unset to disable.
- `SELF_HOST_FREE_BUILDS` — set to `1` (together with `ANTHROPIC_API_KEY`) to
  enable custom deck builds, free on the operator's own key. With either unset,
  `build_deck` answers with the friendly preview message and records the user's
  interest (`users/_system/interest.json`); uploaded rules are kept.
- `CARDGEN_MODEL` — optional override of the Anthropic model used for card
  generation.
- `ANTHROPIC_API_KEY` — the service key used for deck builds (and `/generate`).
  Generation spend lands on this key, so watch usage if you enable builds.

Debugging: without a token, `POST /mcp` should return HTTP 401 with a
`WWW-Authenticate: Bearer resource_metadata=…` header. Check function logs via the
Vercel dashboard (Deployments → latest → Logs) or `vercel logs barprepmcp`.
