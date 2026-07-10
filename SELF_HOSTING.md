# Self-hosting AI Bar Prep

Run your own private instance — your accounts, schedules, and decks live entirely in
**your** Vercel account, under your control. The hosted service at barprepmcp.com never
sees your data.

## One-command deploy

Requirements: [Node.js](https://nodejs.org) ≥ 18 (macOS/Linux; Windows via WSL). A free
Vercel account is created during login if you don't have one.

```sh
git clone <this repo> && cd aibarprep
./scripts/self-host.sh
```

The script walks you through Vercel login, creates a project and a private Blob store,
generates your secrets and a personal invite code, optionally enables custom deck
builds on your own Anthropic API key, deploys, and prints your personal connector URL.
Then follow the printed next steps (add the connector on claude.ai, create your
account, paste the instructions into a Project).

## Custom deck builds when self-hosting

On the hosted service, custom deck builds are currently a preview — trying one just
registers your interest. Self-hosters don't wait: provide your own
`ANTHROPIC_API_KEY` and set `SELF_HOST_FREE_BUILDS=1` (the script offers both), and
`build_deck` runs free on your key — you pay Anthropic directly for exactly what you
generate; there is no other billing anywhere.

## Operating notes

- **Add users:** share your invite code. Rotate/expand codes via the `INVITE_CODES`
  env var in the Vercel dashboard (comma-separated), then redeploy.
- **Envs that matter:** `AUTH_SECRET` (token signing — rotating it signs everyone out),
  `BLOB_READ_WRITE_TOKEN` (injected by the Blob store), `INVITE_CODES`,
  `ANTHROPIC_API_KEY` + `SELF_HOST_FREE_BUILDS` (optional builds),
  `CARDGEN_MODEL` (optional, default `claude-fable-5`).
- **Update:** `git pull`, then `node proxy/bundle-content.mjs` and
  `npx vercel@latest deploy --prod --cwd proxy`.
- **Backup:** your state is small JSON files in the Blob store
  (`npx vercel@latest blob list --cwd proxy`).
