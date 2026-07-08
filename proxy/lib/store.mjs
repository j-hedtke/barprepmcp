// Tiny per-user file store over the Vercel Blob REST API — plain fetch, no SDK.
// Env: BLOB_READ_WRITE_TOKEN (create a Blob store in the Vercel dashboard —
// Storage → Create Blob store → connect to project — or `vercel blob store add`;
// the token is injected automatically once connected).
//
// Blob keys are `users/<userId>/<name>`. The linked store is PRIVATE: puts must
// send `x-vercel-blob-access: private`, and reads require the RW token (plain
// url/downloadUrl fetches return 403). All app access goes through the
// authenticated /content routes; blobs are never exposed directly.

const BLOB_API = "https://blob.vercel-storage.com";
const BLOB_API_VERSION = "7";

export const MAX_CONTENT_BYTES = 256 * 1024; // 256 KB per file

// Allowed file names: fixed app files + user-supplied source content.
// srs.json / drill-log.json hold the MCP drill server's spaced-repetition state
// and review log (see lib/mcp.mjs). registry.json is the self-signup account
// registry (lib/registry.mjs) stored under the reserved "_system" userId —
// harmless under a real user's namespace, but /content refuses the "_system"
// namespace itself (see lib/content.mjs). custom-rules.json / custom-cards.json
// / prefs.json / billing.json / build-state.json hold per-user custom decks and
// the paid deck-build state (see lib/mcp.mjs).
const FIXED_NAMES = new Set([
  "progress.json",
  "focus.json",
  "weakness.json",
  "srs.json",
  "drill-log.json",
  "registry.json",
  "custom-rules.json",
  "custom-cards.json",
  "prefs.json",
  "billing.json",
  "build-state.json",
]);
const CONTENT_NAME_RE = /^content-[A-Za-z0-9_-]{1,64}\.(md|json)$/;

export function validName(name) {
  return FIXED_NAMES.has(name) || CONTENT_NAME_RE.test(name);
}

function token() {
  const t = process.env.BLOB_READ_WRITE_TOKEN;
  if (!t) {
    const e = new Error("BLOB_READ_WRITE_TOKEN not set — create a Vercel Blob store and connect it to the project");
    e.code = "server_misconfigured";
    throw e;
  }
  return t;
}

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${token()}`, "x-api-version": BLOB_API_VERSION, ...extra };
}

// The stored blob key. Vercel Blob percent-DECODES the PUT URL path, so the
// key must be built raw (an encoded segment like josh%40test.com would be
// stored as josh@test.com and never match list/get/delete lookups). The
// charset guard keeps a userId from escaping its users/<id>/ namespace.
// Note the underscore: the reserved "_system" userId (lib/registry.mjs)
// deliberately passes this guard.
const USER_ID_RE = /^[A-Za-z0-9._@+-]+$/;
function pathname(userId, name) {
  if (!USER_ID_RE.test(userId)) {
    const e = new Error(`invalid user id for blob storage: ${JSON.stringify(userId)}`);
    e.code = "server_misconfigured";
    throw e;
  }
  return `users/${userId}/${name}`;
}

async function blobError(prefix, r) {
  const text = await r.text().catch(() => "");
  return new Error(`${prefix} (${r.status}): ${text.slice(0, 300)}`);
}

// PUT https://blob.vercel-storage.com/<pathname> — body is the raw bytes.
// x-add-random-suffix: 0 keeps keys deterministic so re-PUTs overwrite;
// x-allow-overwrite: 1 is required by newer API versions for that overwrite.
export async function putFile(userId, name, bodyBuffer, contentType) {
  const key = pathname(userId, name);
  const r = await fetch(`${BLOB_API}/${key.split("/").map(encodeURIComponent).join("/")}`, {
    method: "PUT",
    headers: authHeaders({
      "x-content-type": contentType || "application/octet-stream",
      "x-add-random-suffix": "0",
      "x-allow-overwrite": "1",
      "x-vercel-blob-access": "private", // the linked store is private; public access is rejected
      "x-cache-control-max-age": "60", // minimum edge cache; content may be up to 60s stale
    }),
    body: bodyBuffer,
  });
  if (!r.ok) throw await blobError("blob put failed", r);
  return r.json(); // { url, downloadUrl, pathname, contentType, ... }
}

// List via GET https://blob.vercel-storage.com?prefix=<prefix>.
async function listBlobs(prefix) {
  const r = await fetch(`${BLOB_API}?prefix=${encodeURIComponent(prefix)}&limit=1000`, {
    headers: authHeaders(),
  });
  if (!r.ok) throw await blobError("blob list failed", r);
  const data = await r.json();
  return Array.isArray(data.blobs) ? data.blobs : [];
}

async function findBlob(userId, name) {
  const key = pathname(userId, name);
  const blobs = await listBlobs(key);
  return blobs.find((b) => b.pathname === key) || null;
}

// GET the blob's url with the RW-token Authorization header — the store is
// private, so unauthenticated fetches of url/downloadUrl return 403.
export async function getFile(userId, name) {
  const blob = await findBlob(userId, name);
  if (!blob) return null;
  const r = await fetch(blob.url, { headers: authHeaders() });
  if (r.status === 404) return null;
  if (!r.ok) throw await blobError("blob get failed", r);
  return {
    body: Buffer.from(await r.arrayBuffer()),
    contentType: r.headers.get("content-type") || blob.contentType || "application/octet-stream",
  };
}

export async function listFiles(userId) {
  const prefix = `${pathname(userId, "")}`;
  const blobs = await listBlobs(prefix);
  return blobs.map((b) => ({
    name: b.pathname.slice(prefix.length),
    size: b.size,
    uploadedAt: b.uploadedAt,
  }));
}

// DELETE via POST https://blob.vercel-storage.com/delete with { urls: [...] }.
export async function deleteFile(userId, name) {
  const blob = await findBlob(userId, name);
  if (!blob) return false;
  const r = await fetch(`${BLOB_API}/delete`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ urls: [blob.url] }),
  });
  if (!r.ok) throw await blobError("blob delete failed", r);
  return true;
}
