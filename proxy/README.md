# AI Bar Prep server

A zero-dependency Node server (single Vercel entrypoint, `index.mjs`) that exposes a
spaced-repetition bar-exam drill as a **remote MCP connector** for Claude, with OAuth
2.1 sign-in, per-user state in Vercel Blob, and optional custom-deck generation.
The hosted instance runs at https://www.barprepmcp.com; self-hosters deploy with `../scripts/self-host.sh`. This document is the reference.

## The MCP connector — `POST /mcp`

Add `https://www.barprepmcp.com/mcp` (hosted) — or `https://<your-deployment>.vercel.app/mcp` for self-hosters — to claude.ai as a custom connector.
claude.ai discovers the authorization server, sends the user through the hosted
sign-in page, and caches a per-user token. Claude becomes the drill UI; all state
lives server-side under `users/<sub>/` — every signed-in user gets their own schedule.

Transport: stateless JSON-RPC 2.0 over Streamable HTTP with plain JSON responses (no
SSE) — `initialize`, `ping`, `tools/list`, `tools/call`; notifications (no `id`) get
HTTP 202.

### Auth (lib/oauth.mjs — OAuth 2.1 per the MCP authorization spec)

Everything is stateless: client ids, authorization codes, and access/refresh tokens
are self-validating HMAC-SHA256 compact blobs `base64url(payload).base64url(sig)`
keyed by `AUTH_SECRET`. No token database.

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/oauth-protected-resource` | RFC 9728 resource metadata |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 AS metadata (code + PKCE S256, `authorization_code`/`refresh_token`, auth method `none`) |
| `POST /oauth/register` | RFC 7591 dynamic client registration (self-validating `client_id`) |
| `GET /oauth/authorize` | Hosted sign-in page: **Sign in** (email + password) and **Create account** tabs |
| `POST /oauth/authorize` | Credential check → 5-minute signed code → 302 to `redirect_uri` |
| `POST /oauth/token` | Code exchange (PKCE verified) or refresh rotation |

- **Accounts.** Two sources, checked in order: the `DRILL_USERS` env var
  (`email:password,email2:password2` — operator-provisioned), then the self-serve
  registry (`users/_system/registry.json`, sha256 password hashes). **Self-signup is
  gated by invite codes**: the Create-account tab requires a code from the
  `INVITE_CODES` env var (comma-separated; empty/unset = signups closed; the code each
  account used is recorded for cohort attribution). Registration is rate-limited
  per IP.
- **Tokens.** Access `{sub, iat, exp}` lives 30 days; refresh 90 days; the refresh
  grant rotates both. `sub` = lowercased email = the user's Blob namespace.
- Missing/invalid Bearer on `/mcp` → 401 with
  `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"`.
- Legacy path secret: `POST /mcp/<MCP_SECRET>` (only while the `MCP_SECRET` env var is
  set) maps to the shared `default` user — handy for curl testing.

### Tools (see lib/mcp.mjs for full contracts)

| Tool | Notes |
|---|---|
| `get_due_summary` | Due/new counts per subject, suggested session |
| `next_card` | SRS pick: due-first, then new weighted by weakness. Modes: `cloze-mcq` (4 shuffled options; the served order is persisted so letter answers map correctly), typed `cloze`, `recite`. Never contains the answer |
| `get_hint` | Stored hints, typed-cloze/recite only; a hinted review caps at quality 4 |
| `submit_review` | Typed cloze: deterministic matcher (exact/stemmed-reorder/typo-tolerant) records in one call; unmatchable answers return `needs_verdict` for a Claude-judged binary pass/fail (strict semantics, lax syntax). MCQ: full option text or a letter for the most recent serve. Recite: two-step — reveal canonical statement, then Claude's 0–5 rating records |
| `next_mbe_question` / `submit_mbe_answer` | 196-question MBE bank; answers withheld until submit |
| `get_stats` / `get_weak_areas` | Totals, per-subject accuracy, mastered counts; weakest subtopics ranked |
| `upload_rules` | Store the user's own rule sheet (structured entries or raw text) |
| `build_deck` | Chunked card generation from uploaded rules (~8 rules/call; client loops until `done: true`; resumable). Runs only with `SELF_HOST_FREE_BUILDS=1` + the server's own `ANTHROPIC_API_KEY` (self-host mode, free on the operator's key); otherwise it returns a friendly not-enabled preview message and records interest |
| `set_deck` | Drill `default`, `custom`, or `both` |
| `set_card_importance` | Per-user scheduling override for a card or its whole rule: `high` / `normal` / `low` (rare + double intervals) / `off` (suspend). New-card picks also weight the deck's own H/M/L priority |
| `queue_card` | Search the active deck by doctrinal keywords, then bubble a confirmed card to the front of the queue (next serve) |

### Content and state

- **Deck content** is committed in `proxy/data/` (`cards.json`, `questions.json`,
  `blueprint.json`, `instructions.md` — the last served at `GET /instructions` for
  onboarding). Regenerate from `../data/` with `node bundle-content.mjs` and commit.
- **Per-user state** lives in a **private** Vercel Blob store (lib/store.mjs — raw
  REST, no SDK; private stores need the `x-vercel-blob-access: private` header on
  writes and token-authenticated reads):
  - `srs.json` — per-card SM-2 state (`ease`, `intervalDays`, `due`, `reps`,
    `lapses`, mode tallies), MBE stats, `lastCard`, `lastServe` (the shuffled MCQ
    option order), `recentQuestions`. SM-2-lite: correct → 1d → 3d → ×ease
    (ease +0.1 max 3.0); wrong → lapse (ease −0.2 min 1.3, due again in 10 min)
  - `drill-log.json` — append-capped review log (last 500 events)
  - `custom-rules.json`, `custom-cards.json`, `prefs.json`, `build-state.json` —
    custom-deck pipeline state

### `/content` — authenticated per-user file routes

`PUT/GET/DELETE /content/<name>` and `GET /content` (list), Bearer-authed with the
same tokens. Allowed names: `progress.json`, `focus.json`, `weakness.json`,
`srs.json`, `drill-log.json`, `custom-rules.json`, `custom-cards.json`, `prefs.json`,
`build-state.json`, and `content-*.md|json` (≤256 KB). The reserved
`_system` namespace (signup registry) is refused outright. Tests use these routes to
inspect and clean state.

## Auxiliary routes

- `POST /generate` — MBE-style question generation (Anthropic via
  `ANTHROPIC_API_KEY`, else OpenAI; `GEN_MODEL` overrides). Accepts explicit
  weak-area `targets` and/or `use_server_context: true` to fold the user's stored
  progress/focus/weakness files into the prompt.
- `POST /auth/apple`, `POST /tts` (ElevenLabs), `POST /stt` (OpenAI) — legacy
  helpers from a retired iOS client; not used by the MCP connector. Safe to ignore
  (they no-op to `server_misconfigured` without their env keys).

## Deploying

`../scripts/self-host.sh` does all of this in one command. By hand: deploy with
`npx vercel@latest deploy --prod` (Node server entrypoint `index.mjs`), connect a
**private** Blob store (injects `BLOB_READ_WRITE_TOKEN`), and set env vars
(Production), then redeploy:

```
AUTH_SECRET           # REQUIRED — signs all tokens; any long random string
BLOB_READ_WRITE_TOKEN # auto-injected by the connected Blob store
INVITE_CODES          # comma-separated signup invite codes (empty = signups closed)
ANTHROPIC_API_KEY     # for /generate and custom deck builds
SELF_HOST_FREE_BUILDS # "1" = build_deck runs free on your own ANTHROPIC_API_KEY;
                      # unset = builds answer with the preview message + record interest
CARDGEN_MODEL         # optional — card-generation model (default claude-fable-5)
GEN_MODEL             # optional — /generate model override
DRILL_USERS           # optional — operator-provisioned accounts "email:password,…"
DECK_OWNERS           # optional — comma-separated emails that get the FULL bundled
                      # deck; everyone else's "default" deck is only the cards from
                      # files marked "sample": true. Unset = whole bundle for all.
MCP_SECRET            # optional — legacy /mcp/<secret> curl-testing path
ELEVENLABS_API_KEY    # optional — legacy /tts only
OPENAI_API_KEY        # optional — legacy /stt (and /generate fallback)
```

## Tests

Seven end-to-end suites in `test/` (each spins a local server against a real Blob
store): `oauth-e2e`, `signup-e2e`, `mcp-e2e`, `deck-e2e`, `demo-e2e`, `owner-gate-e2e`, `importance-e2e`.

```sh
AUTH_SECRET=testsecret MCP_SECRET=test DRILL_USERS='you@test.com:code123' \
BLOB_READ_WRITE_TOKEN=<your token> TEST_PORT=8790 node test/oauth-e2e.mjs
```
