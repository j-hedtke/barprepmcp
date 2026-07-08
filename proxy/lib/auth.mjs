// Short-lived user tokens via Sign in with Apple. Zero-dependency (Node 18+ built-ins).
//
// Flow: the app signs in with Apple, POSTs the identity token to /auth/apple, and we
// verify it against Apple's JWKS (RS256, iss/exp/aud checks). On success we mint an
// HMAC-SHA256-signed compact access token `base64url(payload).base64url(sig)` with
// payload {sub, iat, exp: now+3600}, keyed by the AUTH_SECRET env var.
//
// Routes then call requireAuth(authHeader), which accepts either a valid short-lived
// token or (beta fallback) the static APP_TOKEN.

import { createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify } from "node:crypto";

const APPLE_ISS = "https://appleid.apple.com";
const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
const DEFAULT_BUNDLE_ID = "com.joshhedtke.aibarprep";
const ACCESS_TOKEN_TTL_S = 3600;
const JWKS_TTL_MS = 6 * 60 * 60 * 1000; // re-fetch Apple keys at most every 6h

// Module-scope JWKS cache (persists for the lifetime of the serverless instance).
let jwksCache = { keys: null, fetchedAt: 0 };

function json(status, obj) {
  return { status, contentType: "application/json", body: JSON.stringify(obj) };
}

function b64urlJSON(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

async function fetchAppleKeys(force = false) {
  const now = Date.now();
  if (!force && jwksCache.keys && now - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
  const r = await fetch(APPLE_JWKS_URL);
  if (!r.ok) throw new Error(`apple JWKS fetch failed (${r.status})`);
  const data = await r.json();
  jwksCache = { keys: Array.isArray(data.keys) ? data.keys : [], fetchedAt: now };
  return jwksCache.keys;
}

// Verifies an Apple identity token (JWT). Returns the payload on success, throws on failure.
export async function verifyAppleIdentityToken(identityToken) {
  const parts = String(identityToken).split(".");
  if (parts.length !== 3) throw new Error("malformed identity token");

  let header;
  try {
    header = decodeSegment(parts[0]);
  } catch {
    throw new Error("malformed identity token header");
  }
  if (header.alg !== "RS256") throw new Error(`unexpected alg ${header.alg}`);

  // Find the Apple public key by kid; refresh the cache once on a miss (key rotation).
  let keys = await fetchAppleKeys();
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await fetchAppleKeys(true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error("unknown apple key id");

  const publicKey = createPublicKey({ key: jwk, format: "jwk" });
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2], "base64url");
  if (!cryptoVerify("RSA-SHA256", signed, publicKey, signature)) throw new Error("bad signature");

  let payload;
  try {
    payload = decodeSegment(parts[1]);
  } catch {
    throw new Error("malformed identity token payload");
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== APPLE_ISS) throw new Error("bad iss");
  if (!payload.exp || payload.exp < now) throw new Error("identity token expired");
  const bundleId = process.env.APPLE_BUNDLE_ID || DEFAULT_BUNDLE_ID;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(bundleId)) throw new Error("bad aud");
  if (!payload.sub) throw new Error("missing sub");
  return payload;
}

function signPayloadSegment(payloadB64) {
  return createHmac("sha256", process.env.AUTH_SECRET).update(payloadB64).digest("base64url");
}

// Mints a short-lived access token for a verified Apple user id.
export function mintAccessToken(sub) {
  const now = Math.floor(Date.now() / 1000);
  const payloadB64 = b64urlJSON({ sub, iat: now, exp: now + ACCESS_TOKEN_TTL_S });
  return { token: `${payloadB64}.${signPayloadSegment(payloadB64)}`, expiresIn: ACCESS_TOKEN_TTL_S };
}

// Validates a `Bearer <payload>.<sig>` access token. Returns {sub} or null.
export function verifyAccessToken(authHeader) {
  if (!process.env.AUTH_SECRET) return null;
  const match = /^Bearer\s+(.+)$/.exec(authHeader || "");
  if (!match) return null;
  const parts = match[1].split(".");
  if (parts.length !== 2) return null;

  const expected = createHmac("sha256", process.env.AUTH_SECRET).update(parts[0]).digest();
  const got = Buffer.from(parts[1], "base64url");
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;

  let payload;
  try {
    payload = decodeSegment(parts[0]);
  } catch {
    return null;
  }
  if (!payload.sub || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return { sub: payload.sub };
}

// Route guard: accepts a valid short-lived user token OR (beta fallback) the static
// APP_TOKEN, which maps to the shared "default" user. Returns {sub} or null.
// If neither AUTH_SECRET nor APP_TOKEN is configured, auth is disabled (dev mode) —
// matching the old behavior where an unset APP_TOKEN meant no auth check.
export function requireAuth(authHeader) {
  const user = verifyAccessToken(authHeader);
  if (user) return user;
  if (process.env.APP_TOKEN && authHeader === `Bearer ${process.env.APP_TOKEN}`) return { sub: "default" };
  if (!process.env.APP_TOKEN && !process.env.AUTH_SECRET) return { sub: "default" };
  return null;
}

// POST /auth/apple handler. Body: {identity_token, user_id?}. Returns a result object
// in the same {status, contentType, body} shape as the lib/core.mjs handlers.
export async function appleAuth(body) {
  if (!process.env.AUTH_SECRET) {
    return json(500, { error: "server_misconfigured", message: "AUTH_SECRET not set" });
  }
  const identityToken = (body?.identity_token || "").toString();
  if (!identityToken) return json(400, { error: "bad_request", message: "identity_token is required" });

  let payload;
  try {
    payload = await verifyAppleIdentityToken(identityToken);
  } catch (e) {
    return json(401, { error: "invalid_identity_token", message: String(e.message || e) });
  }
  const { token, expiresIn } = mintAccessToken(payload.sub);
  return json(200, { access_token: token, expires_in: expiresIn, user_id: payload.sub });
}
