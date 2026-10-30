// Nyansi API — Cloudflare Worker that keeps the Gemini key secret.
// POST /chat  { messages:[{role,content}], model?, stream? }  ->  OpenAI chat.completions shape
// GET  /health
// Tried in order; falls back on 429/5xx/404/timeouts. (gemini-flash-latest was hanging/503 on 30 Oct 2026,
// so the fast lite models go first. 2.5-* models are not available to new keys.)
const MODELS = ["gemini-flash-lite-latest", "gemini-3.5-flash-lite", "gemini-flash-latest", "gemini-3.1-flash-lite", "gemini-3.5-flash"];
const ATTEMPT_TIMEOUT_MS = 12_000;   // per model, until response headers arrive
const MAX_BODY = 64 * 1024;          // bytes of request JSON
const MAX_MESSAGES = 40;
const RATE = { limit: 30, windowMs: 60_000 }; // per IP per isolate (best effort)
const hits = new Map();

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || "https://reghson.github.io").split(",").map(s => s.trim());
  const ok = origin && (allowed.includes(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
  return ok ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400", "Vary": "Origin" } : { "Vary": "Origin" };
}
const json = (obj, status, cors) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors } });
const err = (msg, status, cors, type = "api_error") => json({ error: { message: msg, type } }, status, cors);

function rateLimited(ip) {
  const now = Date.now(), h = hits.get(ip) || { n: 0, t: now };
  if (now - h.t > RATE.windowMs) { h.n = 0; h.t = now; }
  h.n++; hits.set(ip, h);
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.t > RATE.windowMs) hits.delete(k);
  return h.n > RATE.limit;
}

const textOf = c => typeof c === "string" ? c : Array.isArray(c) ? c.map(p => typeof p === "string" ? p : p?.text || "").join("") : String(c ?? "");

export function toGemini(messages) {
  const sys = [], contents = [];
  for (const m of messages) {
    const text = textOf(m.content);
    if (!text) continue;
    if (m.role === "system" || m.role === "developer") { sys.push(text); continue; }
    const role = m.role === "assistant" ? "model" : "user";
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push({ text }); // Gemini prefers alternating roles
    else contents.push({ role, parts: [{ text }] });
  }
  if (!contents.length || contents[0].role !== "user") contents.unshift({ role: "user", parts: [{ text: "Hello" }] });
  const body = { contents, generationConfig: { temperature: 0.7, maxOutputTokens: 4096 } };
  if (sys.length) body.systemInstruction = { parts: [{ text: sys.join("\n\n") }] };
  return body;
}

const candText = d => (d?.candidates?.[0]?.content?.parts || []).map(p => p.thought ? "" : p.text || "").join("");
const finish = r => ({ STOP: "stop", MAX_TOKENS: "length", SAFETY: "content_filter", RECITATION: "content_filter" }[r] || (r ? "stop" : null));

async function callGemini(env, body, stream, preferred) {
  const order = preferred && !MODELS.includes(preferred) && /^gemini-[\w.-]+$/.test(preferred) ? [preferred, ...MODELS] : preferred ? [preferred, ...MODELS.filter(m => m !== preferred)] : MODELS;
  let last;
  for (const model of order) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
    let r;
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), ATTEMPT_TIMEOUT_MS);
    try {
      r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY }, body: JSON.stringify(body), signal: ac.signal });
    } catch (e) { clearTimeout(timer); last = { status: 504, text: "timeout/network: " + e.name }; continue; }
    if (r.ok) {
      if (stream) { clearTimeout(timer); return { r, model }; }
      // Non-stream: keep the timeout running while the body is read.
      const done = r.json().finally(() => clearTimeout(timer));
      return { r, model, done };
    }
    clearTimeout(timer);
    last = { status: r.status, text: (await r.text()).slice(0, 300) };
    if (![429, 500, 503, 404].includes(r.status)) break; // only fall back on busy/unavailable
  }
  return { fail: last };
}

function sseFromGemini(geminiRes, model, cors) {
  const id = "chatcmpl-" + crypto.randomUUID(), created = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder(), dec = new TextDecoder();
  const chunk = (delta, fr = null) => enc.encode("data: " + JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: fr }] }) + "\n\n");
  let buf = "", first = true, fr = null;
  const ts = new TransformStream({
    transform(bytes, ctl) {
      buf += dec.decode(bytes, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        try {
          const d = JSON.parse(line.slice(5));
          const t = candText(d);
          fr = finish(d?.candidates?.[0]?.finishReason) || fr;
          if (t || first) { ctl.enqueue(chunk(first ? { role: "assistant", content: t } : { content: t })); first = false; }
        } catch { /* ignore partial */ }
      }
    },
    flush(ctl) { ctl.enqueue(chunk({}, fr || "stop")); ctl.enqueue(enc.encode("data: [DONE]\n\n")); }
  });
  return new Response(geminiRes.body.pipeThrough(ts), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...cors } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);
    if (request.method === "OPTIONS") return new Response(null, { status: cors["Access-Control-Allow-Origin"] ? 204 : 403, headers: cors });
    if (url.pathname === "/health") return json({ ok: true }, 200, cors);
    if (url.pathname !== "/chat" || request.method !== "POST") return err("Not found", 404, cors, "not_found");
    if (origin && !cors["Access-Control-Allow-Origin"]) return err("Origin not allowed", 403, cors, "forbidden");
    if (!env.GEMINI_API_KEY) return err("Server is missing its AI key", 500, cors);

    const ip = request.headers.get("CF-Connecting-IP") || "local";
    if (rateLimited(ip)) return err("Too many requests. Please wait a minute.", 429, cors, "rate_limit");

    const raw = await request.text();
    if (raw.length > MAX_BODY) return err("Message too long", 413, cors, "invalid_request_error");
    let input;
    try { input = JSON.parse(raw); } catch { return err("Invalid JSON", 400, cors, "invalid_request_error"); }
    if (!Array.isArray(input.messages) || !input.messages.length) return err("messages is required", 400, cors, "invalid_request_error");
    const messages = input.messages.slice(-MAX_MESSAGES);
    const body = toGemini(messages);
    const preferred = typeof input.model === "string" && input.model.startsWith("gemini-") ? input.model : null;

    const res = await callGemini(env, body, !!input.stream, preferred);
    if (res.fail) {
      const busy = [429, 503].includes(res.fail.status);
      return err(busy ? "Nyansi is very busy right now. Please try again in a moment." : "AI service error (" + res.fail.status + ")", busy ? 503 : 502, cors);
    }
    if (input.stream) return sseFromGemini(res.r, res.model, cors);

    let d;
    try { d = await res.done; } catch { return err("AI service timed out. Please try again.", 504, cors); }
    const text = candText(d);
    const u = d.usageMetadata || {};
    return json({
      id: "chatcmpl-" + crypto.randomUUID(), object: "chat.completion", created: Math.floor(Date.now() / 1000), model: res.model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: finish(d?.candidates?.[0]?.finishReason) || "stop" }],
      usage: { prompt_tokens: u.promptTokenCount || 0, completion_tokens: u.candidatesTokenCount || 0, total_tokens: u.totalTokenCount || 0 }
    }, 200, cors);
  }
};
