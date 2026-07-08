// Per-user content routes (/content, /content/<name>) and the server-side
// study context that /generate can fold into its prompt. Storage: lib/store.mjs
// (Vercel Blob). Auth: callers resolve the user via requireAuth (lib/auth.mjs)
// and pass the resulting user id in.

import { putFile, getFile, listFiles, deleteFile, validName, MAX_CONTENT_BYTES } from "./store.mjs";

function json(status, obj) {
  return { status, contentType: "application/json", body: JSON.stringify(obj) };
}

// Handles PUT/GET/DELETE /content/<name> and GET /content for one user.
// Returns { status, contentType, body } result objects like lib/core.mjs.
export async function handleContent(method, path, userId, rawBody, contentType) {
  // The "_system" namespace holds the self-signup registry (lib/registry.mjs);
  // no authenticated sub should ever resolve to it, but refuse it outright.
  if (userId === "_system") return json(403, { error: "forbidden", message: "reserved namespace" });
  let name;
  try {
    name = decodeURIComponent(path.slice("/content".length).replace(/^\//, ""));
  } catch {
    return json(400, { error: "bad_request", message: "malformed file name" });
  }

  if (!name) {
    if (method === "GET") return json(200, { files: await listFiles(userId) });
    return json(405, { error: "method_not_allowed", message: "GET /content lists files; use /content/<name> for files" });
  }

  if (!validName(name)) {
    return json(400, {
      error: "bad_request",
      message: "file name not allowed; use progress.json, focus.json, weakness.json, or content-*.md / content-*.json",
    });
  }

  if (method === "PUT") {
    if (!rawBody || !rawBody.length) return json(400, { error: "bad_request", message: "empty body" });
    if (rawBody.length > MAX_CONTENT_BYTES) return json(413, { error: "file_too_large", max_bytes: MAX_CONTENT_BYTES });
    const ct = contentType || (name.endsWith(".json") ? "application/json" : "text/markdown");
    await putFile(userId, name, rawBody, ct);
    return json(200, { ok: true, name, size: rawBody.length });
  }
  if (method === "GET") {
    const file = await getFile(userId, name);
    if (!file) return json(404, { error: "not_found", name });
    return { status: 200, contentType: file.contentType, body: file.body };
  }
  if (method === "DELETE") {
    const deleted = await deleteFile(userId, name);
    return deleted ? json(200, { ok: true, name }) : json(404, { error: "not_found", name });
  }
  return json(405, { error: "method_not_allowed" });
}

// Fetches the user's stored progress/focus/weakness for /generate
// (use_server_context: true). Returns null when the user has none.
export async function loadServerContext(userId) {
  const [progress, focus, weakness] = await Promise.all([
    readJson(userId, "progress.json"),
    readJson(userId, "focus.json"),
    readText(userId, "weakness.json"),
  ]);
  if (!progress && !focus && !weakness) return null;
  return { progress, focus, weakness };
}

async function readJson(userId, name) {
  try {
    const file = await getFile(userId, name);
    return file ? JSON.parse(file.body.toString("utf8")) : null;
  } catch {
    return null;
  }
}

async function readText(userId, name) {
  try {
    const file = await getFile(userId, name);
    return file ? file.body.toString("utf8") : null;
  } catch {
    return null;
  }
}
