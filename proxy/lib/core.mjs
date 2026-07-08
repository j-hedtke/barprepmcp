// Shared proxy logic for the Vercel serverless functions in ../api/.
// Keeps provider API keys server-side (read from env, set in the Vercel dashboard).

const ELEVEN_BASE = "https://api.elevenlabs.io";
const OPENAI_BASE = "https://api.openai.com";
const ANTHROPIC_BASE = "https://api.anthropic.com";
const DEFAULT_VOICE = "nPczCjzI2devNBz1zQrb"; // Brian
const DEFAULT_MODEL = "eleven_multilingual_v2";
const DEFAULT_GEN_MODEL_ANTHROPIC = "claude-sonnet-4-6";
const DEFAULT_GEN_MODEL_OPENAI = "gpt-4o";
const MAX_TEXT_LEN = 5000;

export function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(status, obj) {
  return { status, contentType: "application/json", body: JSON.stringify(obj) };
}

// Returns an error object if the shared APP_TOKEN is set and the header doesn't match.
export function unauthorized(authHeader) {
  if (process.env.APP_TOKEN && authHeader !== `Bearer ${process.env.APP_TOKEN}`) {
    return { error: "unauthorized" };
  }
  return null;
}

export async function tts(body) {
  if (!process.env.ELEVENLABS_API_KEY) return json(500, { error: "server_misconfigured", message: "ELEVENLABS_API_KEY not set" });
  const text = (body.text || "").toString();
  if (!text.trim()) return json(400, { error: "bad_request", message: "text is required" });
  if (text.length > MAX_TEXT_LEN) return json(413, { error: "text_too_long", max: MAX_TEXT_LEN });

  const voiceId = (body.voice_id || DEFAULT_VOICE).toString();
  const modelId = (body.model_id || DEFAULT_MODEL).toString();
  if (process.env.ALLOWED_VOICES) {
    const allow = process.env.ALLOWED_VOICES.split(",").map((s) => s.trim());
    if (!allow.includes(voiceId)) return json(403, { error: "voice_not_allowed", voice_id: voiceId });
  }

  const upstream = await fetch(`${ELEVEN_BASE}/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: modelId }),
  });
  if (!upstream.ok) return { status: upstream.status, contentType: "application/json", body: await upstream.text() };
  const audio = Buffer.from(await upstream.arrayBuffer());
  return { status: 200, contentType: "audio/mpeg", body: audio, cache: true };
}

export async function stt(rawBody, contentType) {
  if (!process.env.OPENAI_API_KEY) return json(500, { error: "server_misconfigured", message: "OPENAI_API_KEY not set" });
  const upstream = await fetch(`${OPENAI_BASE}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": contentType || "multipart/form-data" },
    body: rawBody,
  });
  return { status: upstream.status, contentType: "application/json", body: await upstream.text() };
}

const SCHEMA_INSTRUCTION = `Return ONLY a JSON object of the form {"questions":[...]}. Each question object MUST have:
- "subject": exactly the subject key given for that target
- "subtopic": exactly the subtopic key given for that target
- "rule": short name of the controlling black-letter rule tested
- "priority": "H", "M", or "L"
- "difficulty": 1, 2, or 3
- "stem": a self-contained, original MBE-style hypothetical, 80-180 words, listenable when read aloud (no tables/citations), ending in a clear call of the question
- "choices": exactly 4 plausible answer strings
- "correctIndex": integer 0-3
- "explanation": 60-150 words stating the rule, applying it, and saying why each wrong choice is wrong
Write ORIGINAL questions (do not copy any source). Vary correctIndex across the set. Do not reuse any id in the avoid list. No prose outside the JSON.`;

function buildGenPrompt(targets, count, avoidIds, note, serverContext) {
  const t = targets
    .map((x) => {
      const acc = x.accuracy != null ? `${Math.round(x.accuracy * 100)}%` : "unknown";
      const hint = x.hint ? ` — focus specifically on: ${x.hint}` : "";
      return `- subject="${x.subject}", subtopic="${x.subtopic}" (${x.name || x.subtopic}); user's accuracy here is ${acc}${hint}`;
    })
    .join("\n");
  const ctx = note ? `\nStudy context from the user's prep: ${note}\n` : "";
  const server = serverContextSummary(serverContext);
  return `Generate ${count} bar-exam (MBE) multiple-choice questions targeting these weak areas, distributed across them:\n${t}\n${ctx}${server}\nAvoid duplicating these question ids: ${(avoidIds || []).join(", ") || "(none)"}\n\n${SCHEMA_INSTRUCTION}`;
}

// Compact summary of the user's server-stored files (progress.json, focus.json,
// weakness.json — see lib/content.mjs) folded into the generation prompt when
// the app sends use_server_context: true.
function serverContextSummary(ctx) {
  if (!ctx) return "";
  const parts = [];
  const weak = ctx.progress?.weakAreas;
  if (Array.isArray(weak) && weak.length) {
    const top = weak.slice(0, 5).map((w) => {
      const acc = w.accuracy != null ? `${Math.round(w.accuracy * 100)}%` : "?";
      return `${w.subjectName || w.subject} / ${w.subtopicName || w.subtopic} (accuracy ${acc}, ${w.answered ?? "?"} answered)`;
    });
    parts.push(`Weakest areas from the user's tracked progress: ${top.join("; ")}.`);
  }
  const focusTopics = Array.isArray(ctx.focus?.topics) ? ctx.focus.topics : [];
  if (focusTopics.length) {
    const names = focusTopics
      .map((t) => t.text || [t.subject, t.subtopic].filter(Boolean).join("/"))
      .filter(Boolean);
    if (names.length) parts.push(`The user's current focus topics: ${names.join("; ")}.`);
  }
  if (ctx.focus?.note) parts.push(`Focus note: ${ctx.focus.note}`);
  if (ctx.weakness) parts.push(`Weakness notes from the user's prep:\n${String(ctx.weakness).slice(0, 2000)}`);
  if (!parts.length) return "";
  return `\nServer-stored study context for this user (use it to sharpen the questions):\n${parts.join("\n")}\n`;
}

function extractJSON(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in model output");
  return JSON.parse(raw.slice(start, end + 1));
}

// serverContext (optional): { progress, focus, weakness } loaded by the caller
// (index.mjs, via lib/content.mjs) when the request body sets use_server_context.
// It supplements explicit targets; with no targets at all it derives them from
// progress.weakAreas (top 3).
export async function generate(body, serverContext = null) {
  let targets = Array.isArray(body.targets) ? body.targets : [];
  const count = Math.min(Math.max(parseInt(body.count, 10) || 5, 1), 20);
  if (!targets.length && Array.isArray(serverContext?.progress?.weakAreas)) {
    targets = serverContext.progress.weakAreas.slice(0, 3).map((w) => ({
      subject: w.subject,
      subtopic: w.subtopic,
      name: w.subtopicName || w.subtopic,
      accuracy: w.accuracy,
    }));
  }
  if (!targets.length) {
    return json(400, { error: "bad_request", message: "targets[] required (or use_server_context: true with an uploaded progress.json)" });
  }
  const prompt = buildGenPrompt(targets, count, body.avoid_ids, body.note, serverContext);

  try {
    let parsed;
    if (process.env.ANTHROPIC_API_KEY) {
      const model = process.env.GEN_MODEL || DEFAULT_GEN_MODEL_ANTHROPIC;
      const r = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 4096, messages: [{ role: "user", content: prompt }] }),
      });
      if (!r.ok) return { status: r.status, contentType: "application/json", body: await r.text() };
      const data = await r.json();
      parsed = extractJSON((data.content || []).map((b) => b.text || "").join(""));
    } else if (process.env.OPENAI_API_KEY) {
      const model = process.env.GEN_MODEL || DEFAULT_GEN_MODEL_OPENAI;
      const r = await fetch(`${OPENAI_BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: "You are a bar-exam question writer. Output strict JSON only." },
            { role: "user", content: prompt },
          ],
          response_format: { type: "json_object" },
        }),
      });
      if (!r.ok) return { status: r.status, contentType: "application/json", body: await r.text() };
      const data = await r.json();
      parsed = extractJSON(data.choices?.[0]?.message?.content || "");
    } else {
      return json(500, { error: "server_misconfigured", message: "Set ANTHROPIC_API_KEY or OPENAI_API_KEY for /generate" });
    }
    const questions = Array.isArray(parsed.questions) ? parsed.questions : [];
    return json(200, { questions });
  } catch (e) {
    return json(502, { error: "generation_failed", message: String(e) });
  }
}
