# AI Bar Prep — ElevenLabs TTS proxy

Keeps the ElevenLabs API key **off the device**. The app sends text; the proxy adds
the key and returns MP3 audio. Use this for any public/App Store build — never ship
the raw key in the app binary.

The app talks to the proxy when `ElevenLabsProxyURL` is set in `Secrets.plist`
(see `../appstore/` and the app's `Resources/Secrets.example.plist`). In proxy mode the
app sends **no** API key.

## Auth
Two ways to authorize `/tts`, `/stt`, and `/generate` (`Authorization: Bearer …`):

1. **Short-lived user tokens (preferred).** The app signs in with Apple and exchanges
   the Apple identity token for a 1-hour access token:

   **`POST /auth/apple`** (no auth required), JSON body:
   ```
   { "identity_token": "<Apple identity token JWT>", "user_id": "<optional apple user id>" }
   ```
   The proxy verifies the JWT against Apple's JWKS (RS256 signature,
   `iss=https://appleid.apple.com`, `exp`, `aud == APPLE_BUNDLE_ID`) and returns:
   ```
   { "access_token": "…", "expires_in": 3600, "user_id": "<apple sub>" }
   ```
   The access token is an HMAC-SHA256 compact token signed with `AUTH_SECRET`
   (payload `{sub, iat, exp}`). Errors: 400 missing `identity_token`, 401 invalid
   token, 500 if `AUTH_SECRET` isn't set.

2. **Static `APP_TOKEN` (beta fallback).** The old shared secret still works as
   `Bearer <APP_TOKEN>` and maps to the shared `default` user.

If **neither** `AUTH_SECRET` nor `APP_TOKEN` is set, auth is disabled (dev mode only).

## Request contracts
Routes by path. `Authorization: Bearer <access token or APP_TOKEN>` (see Auth above).

**Text-to-speech — `POST /tts`** (or `/`), JSON body, returns `audio/mpeg`:
```
{ "text": "…", "voice_id": "nPczCjzI2devNBz1zQrb", "model_id": "eleven_multilingual_v2" }
```

**Speech-to-text — `POST /stt`**, `multipart/form-data` (forwarded to OpenAI), returns JSON `{ "text": "…" }`:
```
file=<audio.m4a>  model=gpt-4o-mini-transcribe  language=en
```

**Question generation — `POST /generate`**, JSON body, returns JSON `{ "questions": [ …schema… ] }`:
```
{ "targets": [ { "subject": "torts", "subtopic": "negligence", "name": "Negligence",
                 "accuracy": 0.42, "hint": "proximate cause / intervening acts" } ],
  "count": 5, "avoid_ids": ["torts-001"], "note": "weak spots from desktop study session" }
```
Per-target `hint` and the top-level `note` are optional; when present (e.g. focus topics
imported from the desktop assistant) they sharpen the generated questions.
The provider is chosen by whichever key is set: **Anthropic** if `ANTHROPIC_API_KEY`,
else **OpenAI** if `OPENAI_API_KEY`. Override the model with the `GEN_MODEL` var.

`"use_server_context": true` (optional) folds the user's **server-stored** files into
the prompt: top-5 weakest areas from `progress.json` (`weakAreas`), focus topics + note
from `focus.json`, and up to ~2000 chars of `weakness.json`. Explicit `targets` keep
working unchanged — server context supplements them. When the body has **no** targets
but `use_server_context: true`, targets are derived server-side from
`progress.weakAreas` (top 3). If the Blob store is unavailable, context silently
degrades to none (explicit targets still work).

**Per-user content store — `/content`** (requires the same `Authorization` header;
each user's files live under the Blob key `users/<userId>/<name>`; with the shared
APP_TOKEN everyone maps to user `default` until per-user tokens land):

| Route | Meaning |
|---|---|
| `PUT /content/<name>` | body = raw file bytes; stores/overwrites the file (413 over 256 KB) |
| `GET /content/<name>` | returns the file bytes (404 if missing) |
| `GET /content` | lists the user's files: `{ "files": [ { "name", "size", "uploadedAt" } ] }` |
| `DELETE /content/<name>` | deletes the file (404 if missing) |

Allowed names (400 otherwise): `progress.json`, `focus.json`, `weakness.json`,
`srs.json`, `drill-log.json` (the MCP drill server's state — see below), and
user-supplied source content `content-*.md` / `content-*.json`.

Storage is **Vercel Blob** via its REST API (no SDK — `lib/store.mjs`). Blobs are
`access: public`, but the store hostname is a random id, so URLs are unguessable;
the data is study progress, not credentials. Setup: Vercel dashboard → **Storage →
Create Blob store** → connect to the project (or `vercel blob store add`), which
injects `BLOB_READ_WRITE_TOKEN`; without it all `/content` ops return
`server_misconfigured` (500).

All routes return the upstream JSON error with its status code on failure.

## Remote MCP drill server — `POST /mcp` (OAuth 2.1)

`lib/mcp.mjs` exposes a spaced-repetition bar-prep drill as a **remote MCP server**
(Model Context Protocol, Streamable HTTP transport with plain JSON responses — no
SSE). Add it to claude.ai as a **custom connector** with your deployment's public
URL `https://<your-deployment>.vercel.app/mcp`; claude.ai discovers the authorization
server, sends the user through the sign-in page, and caches a per-user token.
Claude (desktop/mobile/voice) becomes the drill UI and all state lives server-side
under `users/<sub>/` — each signed-in user gets their own drill state.

### Connector auth (lib/oauth.mjs — OAuth 2.1 per the MCP authorization spec)

Everything is **stateless**: client ids, authorization codes, and tokens are all
self-validating HMAC-SHA256 compact blobs `base64url(JSON payload).base64url(sig)`
keyed by `AUTH_SECRET` (the same primitive as `/auth/apple` tokens). No database.

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/oauth-protected-resource` | RFC 9728 resource metadata (`resource: <origin>/mcp`, `authorization_servers: [<origin>]`) |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 AS metadata (code + PKCE S256, grants `authorization_code`/`refresh_token`, auth method `none`) |
| `POST /oauth/register` | RFC 7591 dynamic client registration — validates `redirect_uris` (https, or `http://localhost` for dev tools) and returns a **self-validating** `client_id` = `base64url({redirect_uris, iat}).HMAC` |
| `GET /oauth/authorize` | Minimal HTML sign-in page (email + access code; OAuth params carried in hidden fields). Invalid `client_id`/`redirect_uri` renders an error page — never redirects |
| `POST /oauth/authorize` | Checks credentials against `DRILL_USERS`; success mints a 5-minute signed authorization code and 302s to `redirect_uri?code=…&state=…` |
| `POST /oauth/token` | `authorization_code` (verifies code sig/exp, redirect_uri, client binding, PKCE S256) or `refresh_token` (rotates both tokens). Form-encoded or JSON body; OAuth error JSON (`invalid_grant` etc., 400) on failure |

- **Tokens:** access token `{sub, iat, exp, typ:"access"}` lives **30 days**
  (`expires_in: 2592000`); refresh token `{…, typ:"refresh"}` lives **90 days**;
  the refresh grant rotates both. `sub` is the user's lowercased email and is the
  per-user Blob namespace.
- **`POST /mcp`** requires `Authorization: Bearer <access token>`. Missing/invalid →
  HTTP 401 with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"`.
- **Users are provisioned by env var** — no signup. Set `DRILL_USERS` on Vercel:
  `email:accessCode,email2:code2` (emails case-insensitive, codes compared
  timing-safe), redeploy, and hand each user their access code.
- **PKCE (S256) is mandatory**; clients are public (`token_endpoint_auth_method:
  "none"`). CSRF is covered by the OAuth `state` param + PKCE — no cookies/sessions.
- **Legacy path secret:** `POST /mcp/<MCP_SECRET>` still works while the
  `MCP_SECRET` env var is set (404 when unset or on mismatch; GET/DELETE → 405) and
  maps to the shared `default` user — handy for curl testing.

### Protocol + content

- Stateless JSON-RPC 2.0: `initialize`, `ping`, `tools/list`, `tools/call`;
  notifications (no `id`) get HTTP 202 with an empty body.

Content served comes from **`proxy/data/`** (committed): `cards.json` (flashcards),
`questions.json` (196-question MBE bank), `blueprint.json`. Regenerate with
`node bundle-content.mjs` (merges `../data/flashcards/*.json`,
`../data/questions/*.json`, copies `../blueprint.json`) and commit the result.

Tools (see `lib/mcp.mjs` for full contracts): `get_due_summary`, `next_card`,
`submit_review` (server-graded cloze; two-step Claude-graded recite),
`next_mbe_question`, `submit_mbe_answer`, `get_stats`, `get_weak_areas`.

State (Vercel Blob via `lib/store.mjs`, under `users/<sub>/` — the token's `sub`,
or `default` for the legacy path secret):
- `srs.json` — `{ cards: { <cardId>: {ease, intervalDays, due, reps, lapses, seen,
  correct, typedCorrect, typedSeen, mcqCorrect, mcqSeen} }, mbe: { <questionId>:
  {answered, correct, lastAnswered} }, lastCard, recentQuestions, updatedAt }`.
  SM-2-lite: correct → 1d → 3d → ×ease (ease +0.1, max 3.0); wrong → lapse
  (ease −0.2, min 1.3, reps reset, due again in 10 min).
- `drill-log.json` — append-capped review log (last 500 events).

Both files are also readable/deletable through the authenticated `/content` routes
(they're in the allowlist), which is how tests inspect and clean up state.

Both implementations cache by a hash of `(voice_id, model_id, text)`, so identical hypos
cost at most one ElevenLabs synthesis regardless of how many users replay them.

## Deploying to Vercel
Deployed to Vercel using `index.mjs` as the Node server entrypoint (Vercel's Node
server runtime rather than zero-config `api/` functions). `index.mjs` routes every
path and reuses `lib/core.mjs`. Routes on your deployment:

| Route | URL |
|---|---|
| MCP connector | `https://<your-deployment>.vercel.app/mcp` |
| TTS | `https://<your-deployment>.vercel.app/tts` |
| STT | `https://<your-deployment>.vercel.app/stt` |
| Generate | `https://<your-deployment>.vercel.app/generate` |
| Content | `https://<your-deployment>.vercel.app/content[/<name>]` |

The one-command `scripts/self-host.sh` sets the required vars for you. To manage them
by hand, set environment variables in the Vercel dashboard (Project → Settings →
Environment Variables, **Production**), then redeploy:
```
AUTH_SECRET          # REQUIRED: signs ALL tokens (MCP OAuth client ids / codes /
                     # access+refresh tokens, and /auth/apple tokens); any long random string
BLOB_READ_WRITE_TOKEN # for /content and all per-user drill state — auto-injected when a Blob store is connected
INVITE_CODES         # comma-separated invite codes that gate self-serve signup (empty → signups closed)
ANTHROPIC_API_KEY    # preferred for /generate; also the key custom deck builds run on
SELF_HOST_FREE_BUILDS # set to 1 to run build_deck free on your own ANTHROPIC_API_KEY (no Stripe)
CARDGEN_MODEL        # optional, overrides the card-generation model id
GEN_MODEL            # optional, overrides the /generate model id
ELEVENLABS_API_KEY   # optional, for /tts
OPENAI_API_KEY       # optional, for /stt (and /generate if no Anthropic key)
DRILL_USERS          # optional legacy env-provisioned MCP users: "email:accessCode,email2:code2"
MCP_SECRET           # optional legacy path secret for /mcp/<MCP_SECRET> (curl testing; unset to disable)
STRIPE_SECRET_KEY    # optional, only if you want paid (non-self-host) deck builds
```
Redeploy after changing env vars: `npm run deploy:vercel` (or the dashboard's Redeploy).

## Text-to-speech note
`/tts` (ElevenLabs) and `/stt` (OpenAI) are optional voice helpers for the companion
iOS client and are not required by the Claude MCP connector. If you use TTS on
ElevenLabs' free plan, only some default voices work via API (e.g. Brian
`nPczCjzI2devNBz1zQrb`, George `JBFqnCBsd6RMkjVDRZzb`) and the monthly character cap is
low — upgrade the plan or pre-render static audio for production use.
