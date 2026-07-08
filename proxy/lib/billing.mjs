// Stripe billing for custom deck builds — raw fetch, zero-dep (no stripe SDK).
// Env:
//   STRIPE_SECRET_KEY       enables the paid-build path (unset → paid path unavailable)
//   DECK_BUILD_PRICE_CENTS  one-time price of a deck build in USD cents (default 999)
//   STRIPE_API_BASE         Stripe API origin (default https://api.stripe.com;
//                           overridable so tests can point at a local stub)
//
// Flow (driven by the build_deck tool in lib/mcp.mjs):
//   1. build_deck needs the server's ANTHROPIC_API_KEY but the user has no
//      credit → createCheckoutSession() → user pays at session.url.
//   2. Next build_deck call → retrieveCheckoutSession(); payment_status
//      "paid" → one build credit is granted and immediately consumed for the
//      current build (paid=true in users/<sub>/build-state.json).

const stripeBase = () => process.env.STRIPE_API_BASE || "https://api.stripe.com";

export function deckBuildPriceCents() {
  const n = Number(process.env.DECK_BUILD_PRICE_CENTS);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 999;
}

export function stripeEnabled() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

async function stripeFetch(path, { method = "GET", form = null } = {}) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not set");
  const r = await fetch(`${stripeBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Stripe error (${r.status}): ${text.slice(0, 300)}`);
  }
  return r.json();
}

/**
 * Create a Checkout Session for one deck build. Returns the session object
 * ({ id, url, ... }); store `id` as users/<sub>/billing.json pendingSession
 * and hand `url` to the user.
 */
export async function createCheckoutSession(sub, origin) {
  const base = (origin || "https://example.com").replace(/\/+$/, "");
  return stripeFetch("/v1/checkout/sessions", {
    method: "POST",
    form: {
      mode: "payment",
      client_reference_id: sub,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": String(deckBuildPriceCents()),
      "line_items[0][price_data][product_data][name]": "Custom deck build",
      success_url: `${base}/billing/success`,
      cancel_url: `${base}/billing/success`,
    },
  });
}

/** Retrieve a Checkout Session; check payment_status === "paid". */
export async function retrieveCheckoutSession(sessionId) {
  return stripeFetch(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
}
