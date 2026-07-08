#!/usr/bin/env bash
# AI Bar Prep — self-host deployment script.
#
# Deploys your own private instance of the drill server to YOUR Vercel account,
# so your study data lives entirely under your control. Run from the repo root:
#
#   ./scripts/self-host.sh
#
# Needs: Node.js >= 18 (https://nodejs.org), and openssl (preinstalled on
# macOS/Linux; on Windows use WSL). A free Vercel account is created during
# login if you don't have one.
set -euo pipefail

say()  { printf "\n\033[1m%s\033[0m\n" "$*"; }
fail() { printf "\033[31merror:\033[0m %s\n" "$*" >&2; exit 1; }

[ -f proxy/index.mjs ] || fail "run this from the repo root (proxy/index.mjs not found)"
command -v node >/dev/null || fail "Node.js is required — install from https://nodejs.org"
node -e 'process.exit(parseInt(process.versions.node) >= 18 ? 0 : 1)' || fail "Node.js >= 18 required (you have $(node -v))"
command -v openssl >/dev/null || fail "openssl is required"

VC="npx --yes vercel@latest"

say "1/6 — Vercel login (a free account is created if you don't have one)"
if $VC whoami >/dev/null 2>&1; then
  echo "already logged in as: $($VC whoami 2>/dev/null | tail -1)"
else
  $VC login
fi

say "2/6 — Create your project"
read -r -p "Project name [my-bar-drill]: " PROJECT
PROJECT=${PROJECT:-my-bar-drill}
$VC link --yes --project "$PROJECT" --cwd proxy

say "3/6 — Create your private storage (Vercel Blob)"
$VC blob create-store "${PROJECT}-data" --access private --yes --cwd proxy \
  || echo "(store may already exist — continuing)"

say "4/6 — Secrets"
AUTH_SECRET=$(openssl rand -hex 32)
INVITE_CODE=$(openssl rand -hex 6)
printf '%s' "$AUTH_SECRET" | $VC env add AUTH_SECRET production --cwd proxy
printf '%s' "$INVITE_CODE" | $VC env add INVITE_CODES production --cwd proxy
echo
echo "Custom deck builds (optional): with your own Anthropic API key"
echo "(console.anthropic.com), you can turn your own rule sheets into decks."
echo "You pay Anthropic directly for generation; no other billing exists."
read -r -p "Anthropic API key (or press Enter to skip): " ANTHROPIC_KEY
if [ -n "${ANTHROPIC_KEY}" ]; then
  printf '%s' "$ANTHROPIC_KEY" | $VC env add ANTHROPIC_API_KEY production --cwd proxy
  printf '%s' "1" | $VC env add SELF_HOST_FREE_BUILDS production --cwd proxy
  echo "custom deck builds: ENABLED (free on your own key)"
else
  echo "custom deck builds: skipped (re-run later or add ANTHROPIC_API_KEY + SELF_HOST_FREE_BUILDS=1 in the Vercel dashboard)"
fi

say "5/6 — Bundle content and deploy"
node proxy/bundle-content.mjs
DEPLOY_OUT=$($VC deploy --prod --yes --cwd proxy 2>&1) || { echo "$DEPLOY_OUT"; fail "deploy failed"; }
URL=$(echo "$DEPLOY_OUT" | grep -oE 'https://[a-zA-Z0-9.-]+\.vercel\.app' | head -1)
[ -n "$URL" ] || fail "could not determine deployment URL — check 'npx vercel ls'"

say "6/6 — Done. Your private drill server is live."
cat <<EOF

  Connector URL:     ${URL}/mcp
  Your invite code:  ${INVITE_CODE}
  Instructions:      ${URL}/instructions

Next steps:
  1. On claude.ai (web): Settings -> Connectors -> Add custom connector -> ${URL}/mcp
  2. Create account: invite code above + your email + a password
  3. Create a Project, paste the contents of ${URL}/instructions into its
     Project instructions, enable the connector in a chat, and say "drill me"

Everything — accounts, schedules, decks — lives in YOUR Vercel account.
To add more users, hand them the invite code (or rotate it: edit the
INVITE_CODES env var in the Vercel dashboard and redeploy).
EOF
