// AI Bar Prep proxy — single Node HTTP server entrypoint (Vercel Node runtime).
// Routes: POST /auth/apple · POST /tts (ElevenLabs) · POST /stt (OpenAI transcription)
// · POST /generate · PUT/GET/DELETE /content/<name> + GET /content (per-user file store)
// · POST /mcp (remote MCP drill server for claude.ai — lib/mcp.mjs, OAuth 2.1 Bearer
// auth via lib/oauth.mjs) + the OAuth endpoints /.well-known/oauth-protected-resource,
// /.well-known/oauth-authorization-server, /oauth/{register,authorize,token} · legacy
// POST /mcp/<MCP_SECRET> (path secret, curl testing).
// Keys are read from env (set in the Vercel dashboard). Shared logic in lib/core.mjs;
// auth in lib/auth.mjs; content store in lib/content.mjs.

import http from "node:http";
import fs from "node:fs";
import path2 from "node:path";
import { fileURLToPath } from "node:url";
const DATA_DIR = path2.join(path2.dirname(fileURLToPath(import.meta.url)), "data");
import { tts, stt, generate, readRaw } from "./lib/core.mjs";
import { appleAuth, requireAuth } from "./lib/auth.mjs";
import { handleContent, loadServerContext } from "./lib/content.mjs";
import { handleMcp, handleMcpRpc } from "./lib/mcp.mjs";
import {
  protectedResourceMetadata,
  authorizationServerMetadata,
  handleRegister,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleToken,
  verifyBearerToken,
  unauthorized,
} from "./lib/oauth.mjs";

const PORT = process.env.PORT || 3000;

// Browser clients (claude.ai, MCP inspector) hit the discovery/token/MCP
// endpoints cross-origin; these endpoints are public or Bearer-authed, so a
// permissive CORS policy is safe.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
function sendResult(res, r, extraHeaders) {
  const headers = { "Content-Type": r.contentType, ...(extraHeaders || {}), ...(r.headers || {}) };
  if (r.cache) headers["Cache-Control"] = "public, max-age=31536000, immutable";
  res.writeHead(r.status, headers);
  res.end(r.body);
}

// External origin of this deployment (issuer / resource identifier), derived
// from the forwarded headers Vercel sets; https unless plainly local.
function requestOrigin(req) {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost").split(",")[0].trim();
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = forwardedProto || (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) ? "http" : "https");
  return `${proto}://${host}`;
}

const server = http.createServer(async (req, res) => {
  const path = (req.url || "").split("?")[0].replace(/\/+$/, "");

  try {
    if (req.method === "POST" && path === "/auth/apple") {
      const raw = await readRaw(req);
      let body;
      try {
        body = JSON.parse(raw.toString() || "{}");
      } catch {
        return sendJson(res, 400, { error: "bad_request", message: "expected JSON body" });
      }
      return sendResult(res, await appleAuth(body));
    }

    // --- OAuth 2.1 for the MCP connector (lib/oauth.mjs) -------------------
    const isOAuthSurface = path.startsWith("/.well-known/") || path.startsWith("/oauth/") || path === "/mcp";
    if (req.method === "OPTIONS" && isOAuthSurface) {
      res.writeHead(204, CORS_HEADERS);
      return res.end();
    }
    // RFC 9728/8414 discovery — also answer the path-suffixed variants
    // (/.well-known/…/mcp) some clients probe for path-scoped resources.
    if (req.method === "GET" && (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp")) {
      return sendResult(res, protectedResourceMetadata(requestOrigin(req)), CORS_HEADERS);
    }
    if (req.method === "GET" && (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/oauth-authorization-server/mcp")) {
      return sendResult(res, authorizationServerMetadata(requestOrigin(req)), CORS_HEADERS);
    }
    if (path === "/oauth/register" && req.method === "POST") {
      return sendResult(res, handleRegister(await readRaw(req)), CORS_HEADERS);
    }
    if (path === "/oauth/authorize" && req.method === "GET") {
      const params = Object.fromEntries(new URL(req.url, "http://local").searchParams);
      return sendResult(res, handleAuthorizeGet(params));
    }
    if (path === "/oauth/authorize" && req.method === "POST") {
      // Client IP (x-forwarded-for is set by Vercel) keys the signup rate limit.
      const clientIp = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "");
      return sendResult(res, await handleAuthorizePost(await readRaw(req), clientIp));
    }
    if (path === "/oauth/token" && req.method === "POST") {
      return sendResult(res, handleToken(await readRaw(req), req.headers["content-type"]), CORS_HEADERS);
    }

    // Remote MCP server (Streamable HTTP, JSON responses), OAuth-protected:
    // Bearer access token required; its `sub` selects the per-user drill state.
    if (path === "/mcp") {
      const authHeader = req.headers.authorization || "";
      const user = verifyBearerToken(authHeader);
      if (!user) return sendResult(res, unauthorized(requestOrigin(req), Boolean(authHeader)), CORS_HEADERS);
      if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
      return sendResult(res, await handleMcpRpc(await readRaw(req), user.sub), CORS_HEADERS);
    }
    // Legacy path-secret MCP route (active only when MCP_SECRET is set; curl testing).
    if (path.startsWith("/mcp/")) {
      const raw = req.method === "POST" ? await readRaw(req) : Buffer.alloc(0);
      return sendResult(res, await handleMcp(req.method, path, raw));
    }

    // Per-user content store: PUT/GET/DELETE /content/<name>, GET /content (list).
    if (path === "/content" || path.startsWith("/content/")) {
      const user = requireAuth(req.headers.authorization || "");
      if (!user) return sendJson(res, 401, { error: "unauthorized" });
      const raw = req.method === "PUT" ? await readRaw(req) : null;
      return sendResult(res, await handleContent(req.method, path, user.sub, raw, req.headers["content-type"]));
    }

    if (req.method === "GET" && path === "/instructions") {
      const md = fs.readFileSync(path2.join(DATA_DIR, "instructions.md"));
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
      return res.end(md);
    }
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("AI Bar Prep proxy. POST /auth/apple, /tts, /stt, /generate; /content for per-user files; /mcp (OAuth) drill connector.");
    }
    if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });

    const user = requireAuth(req.headers.authorization || "");
    if (!user) return sendJson(res, 401, { error: "unauthorized" });

    if (path === "/stt") {
      const raw = await readRaw(req);
      return sendResult(res, await stt(raw, req.headers["content-type"]));
    }
    const raw = await readRaw(req);
    let body;
    try {
      body = JSON.parse(raw.toString() || "{}");
    } catch {
      return sendJson(res, 400, { error: "bad_request", message: "expected JSON body" });
    }
    if (path === "/generate") {
      // use_server_context: fold the user's stored progress/focus/weakness into
      // the prompt (loadServerContext degrades to null if Blob is unavailable).
      const serverContext = body.use_server_context ? await loadServerContext(user.sub) : null;
      return sendResult(res, await generate(body, serverContext));
    }
    return sendResult(res, await tts(body)); // "" or "/tts"
  } catch (e) {
    if (e?.code === "server_misconfigured") {
      return sendJson(res, 500, { error: "server_misconfigured", message: e.message });
    }
    return sendJson(res, 502, { error: "proxy_error", message: String(e) });
  }
});

server.listen(PORT, () => console.log(`proxy on :${PORT} (/auth/apple, /tts, /stt, /generate, /content, /mcp [OAuth], /oauth/*, legacy /mcp/<secret>)`));
