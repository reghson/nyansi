// Nyansi API — Cloudflare Worker that keeps the Gemini key secret.
// POST /chat  { messages:[{role,content}], model?, stream?, search? }  ->  OpenAI chat.completions shape
// GET  /health
// POST /image, POST /video, POST /tts, POST /storyboard, GET /limits  -> see media.js (free AI images, video clips, voice-overs)
//
// Accuracy: the model gets today's date and a free `web_search` tool (Wikipedia + Google News RSS).
// For current facts it searches first and cites results; a short "Sources" list is appended.
// Google Search grounding (tools:[{google_search:{}}]) is tried when GOOGLE_GROUNDING="on" or "auto";
// on the free tier it returns 429 (quota 0), so "auto" remembers that and skips it for an hour.

// Model chain, tried in order on 429/5xx/404/timeouts. Override with env CHAT_MODELS="a,b,c".
// Measured 30 Oct 2026: gemini-3.5-flash = most accurate (1.3-5.7 s); flash-lite = fastest (~0.7 s);
// gemini-flash-latest / gemini-3.8-flash = frequent 503s and 20 s+ hangs; 2.5-* = not available.
const DEFAULT_MODELS = ["gemini-flash-lite-latest", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash"]; // 3.5-flash is last: free tier only allows ~20 requests/day
const TIMEOUTS = { "gemini-3.5-flash": 7000 };          // per call; others use DEFAULT_TIMEOUT
const DEFAULT_TIMEOUT = 12_000;
const TOTAL_BUDGET_MS = 22_000;                          // whole request, across fallbacks
const MAX_BODY = 64 * 1024;
const MAX_MESSAGES = 40;
const MAX_TOOL_ROUNDS = 2;
const RATE = { limit: 30, windowMs: 60_000 };          // per IP per isolate (best effort)
const hits = new Map();
let groundingBlockedUntil = 0;
import { handleImage, handleVideo, limitsInfo, handleTTS, handleStoryboard } from "./media.js";

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || "https://reghson.github.io").split(",").map(s => s.trim());
  const ok = origin && (allowed.includes(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
  return ok ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-Nyansi-Device", "Access-Control-Max-Age": "86400", "Vary": "Origin" } : { "Vary": "Origin" };
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

export function todayString(d = new Date()) {
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

export function accuracyRules(searchOn) {
  return [
    `Today's date is ${todayString()} (UTC). Use it for anything involving "today", ages, "current" or "latest".`,
    "Your built-in knowledge stops some time before today, so it may be out of date for recent events.",
    searchOn
      ? "For anything that may have changed recently — who holds an office, news, sports results, prices, exchange rates, weather, schedules, releases, or any question with 'current', 'latest', 'now', 'today' or a recent year — call web_search first and base your answer on the results. If the results don't contain the answer, call web_search once more with a more specific query (for example add 'final', 'winner', 'result' or the year). Cite the results you used like [1], [2]. Do not write a Sources list or URLs yourself; it is added automatically."
      : "For recent events, say your information may be out of date.",
    "If you are not sure, or the search results do not clearly answer the question, say so plainly instead of guessing.",
    "Never invent names, numbers, dates, quotes, links or news. Do not claim abilities you do not have (you cannot browse freely, make calls, send messages or remember other chats)."
  ].join("\n");
}

export function toGemini(messages) {
  const sys = [], contents = [];
  for (const m of messages) {
    const text = textOf(m.content);
    if (!text) continue;
    if (m.role === "system" || m.role === "developer") { sys.push(text); continue; }
    const role = m.role === "assistant" ? "model" : "user";
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push({ text });
    else contents.push({ role, parts: [{ text }] });
  }
  if (!contents.length || contents[0].role !== "user") contents.unshift({ role: "user", parts: [{ text: "Hello" }] });
  return { sys, contents };
}

// ---------------- free web search (Wikipedia + Google News RSS) ----------------
const UA = "NyansiBot/1.0 (https://reghson.github.io/nyansi/)";
const decode = s => (s || "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/<[^>]+>/g, "").trim();
async function getText(url, ms = 4000) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { headers: { "User-Agent": UA }, signal: ac.signal }); return r.ok ? await r.text() : ""; }
  catch { return ""; } finally { clearTimeout(t); }
}
async function searchNews(q) {
  const xml = await getText(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-GH&gl=GH&ceid=GH:en`);
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 6).map(([, it]) => {
    const g = tag => decode((it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1]);
    const date = g("pubDate");
    return { title: g("title"), source: g("source") || "Google News", date: date ? new Date(date).toISOString().slice(0, 10) : "", url: g("link"), snippet: "" };
  }).filter(r => r.title && r.url);
}
async function searchWiki(q) {
  const u = `https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrlimit=4&prop=extracts|info&exintro=1&explaintext=1&exchars=1200&inprop=url`;
  try {
    const j = JSON.parse(await getText(u) || "{}");
    return (j.query?.pages || []).sort((a, b) => a.index - b.index).map(p => ({ title: p.title, source: "Wikipedia", date: "", url: p.fullurl, snippet: (p.extract || "").slice(0, 1200) }));
  } catch { return []; }
}
export async function webSearch(q) {
  const [news, wiki] = await Promise.all([searchNews(q), searchWiki(q)]);
  return [...wiki.slice(0, 3), ...news.slice(0, 5), ...wiki.slice(3)];
}
const SEARCH_TOOL = { functionDeclarations: [{
  name: "web_search",
  description: "Search the web (Wikipedia and recent news headlines) for current or factual information. Use for recent events, people in office, sports results, prices, dates and anything you are not certain about.",
  parameters: { type: "OBJECT", properties: { query: { type: "STRING", description: "A short search query, e.g. 'president of Ghana 2026'" } }, required: ["query"] }
}] };

// ---------------- Gemini calls ----------------
class GemError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
async function gemini(env, model, body, deadline) {
  const ms = Math.min(TIMEOUTS[model] || DEFAULT_TIMEOUT, (deadline || Infinity) - Date.now());
  if (ms < 1500) throw new GemError(504, "out of time");
  if (/^gemini-3/.test(model)) body = { ...body, generationConfig: { ...body.generationConfig, thinkingConfig: { thinkingLevel: "low" } } };
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY }, body: JSON.stringify(body), signal: ac.signal });
    if (!r.ok) throw new GemError(r.status, (await r.text()).slice(0, 2000));
    return await r.json();
  } catch (e) { if (e instanceof GemError) throw e; throw new GemError(504, "timeout/network: " + e.name); }
  finally { clearTimeout(timer); }
}
const partsText = c => (c?.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join("");
const finish = r => ({ STOP: "stop", MAX_TOKENS: "length", SAFETY: "content_filter", RECITATION: "content_filter" }[r] || "stop");

// One model, with optional search tool loop. Returns {text, sources, searched, finish, usage}.
async function runModel(env, model, sysText, contents, mode, deadline, prior = []) {
  const gen = { temperature: 0.4, maxOutputTokens: 4096 };
  if (mode === "grounding") {
    const d = await gemini(env, model, { systemInstruction: { parts: [{ text: sysText }] }, contents, tools: [{ google_search: {} }], generationConfig: gen }, deadline);
    const c = d.candidates?.[0];
    const sources = (c?.groundingMetadata?.groundingChunks || []).map(g => g.web).filter(Boolean).map(w => ({ title: w.title, url: w.uri, source: w.title }));
    return { text: partsText(c), sources: sources.slice(0, 5), cite: false, searched: sources.length > 0, finish: c?.finishReason, usage: d.usageMetadata };
  }
  const convo = contents.slice();
  const results = prior.slice(); let searched = results.length > 0, d, c;
  if (results.length) { // results found by an earlier model that failed: give them as text, no tool loop
    mode = "plain";
    const last = convo[convo.length - 1];
    convo[convo.length - 1] = { role: "user", parts: [...last.parts, { text: "\n\nWeb search results (cite the ones you use as [n]):\n" + JSON.stringify(results.map((r, i) => ({ n: i + 1, ...r }))) }] };
  }
  try {
  for (let round = 0; ; round++) {
    const body = { systemInstruction: { parts: [{ text: sysText }] }, contents: convo, generationConfig: gen };
    if (mode === "tools") { body.tools = [SEARCH_TOOL]; body.toolConfig = { functionCallingConfig: { mode: round < MAX_TOOL_ROUNDS ? "AUTO" : "NONE" } }; }
    d = await gemini(env, model, body, deadline);
    c = d.candidates?.[0];
    const calls = (c?.content?.parts || []).filter(p => p.functionCall);
    if (!calls.length || round >= MAX_TOOL_ROUNDS) break;
    convo.push(c.content); // keep thought signatures as returned
    const responses = await Promise.all(calls.slice(0, 2).map(async p => {
      const q = String(p.functionCall.args?.query || "").slice(0, 200);
      const found = q ? await webSearch(q) : [];
      searched = true;
      const numbered = found.map(r => { let i = results.findIndex(x => x.url === r.url); if (i < 0) { results.push(r); i = results.length - 1; } return { n: i + 1, ...r }; });
      return { functionResponse: { name: "web_search", response: { query: q, results: numbered.length ? numbered : "No results found." } } };
    }));
    convo.push({ role: "user", parts: responses });
  }
    if (!partsText(c).trim()) throw new GemError(502, "empty answer (" + (c?.finishReason || "none") + ")");
  } catch (e) { e.results = results; throw e; }
  return { text: partsText(c), sources: results, cite: true, searched, finish: c?.finishReason, usage: d.usageMetadata };
}

export function withSources(text, sources, cite) {
  if (!sources.length) return text;
  let list;
  if (cite) {
    const used = [...new Set([...text.matchAll(/\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g)].flatMap(m => m[1].split(",").map(Number)))].filter(n => sources[n - 1]).sort((a, b) => a - b);
    if (!used.length) return text; // nothing cited -> don't pretend
    list = used.slice(0, 6).map(n => `[${n}] [${sources[n - 1].title.replace(/[\[\]]/g, "")}](${sources[n - 1].url})${sources[n - 1].date ? " — " + sources[n - 1].date : ""}`);
  } else {
    list = sources.slice(0, 5).map(s => `[${(s.title || s.url).replace(/[\[\]]/g, "")}](${s.url})`);
  }
  return text.trim() + "\n\n**Sources**\n" + list.map(l => "- " + l).join("\n");
}

const coolUntil = {}; // model -> time until we stop trying it first (per worker instance)

async function answer(env, messages, preferred, searchOn) {
  const { sys, contents } = toGemini(messages);
  const sysText = [sys.join("\n\n"), accuracyRules(searchOn)].filter(Boolean).join("\n\n");
  let chain = (env.CHAT_MODELS ? env.CHAT_MODELS.split(",").map(s => s.trim()) : DEFAULT_MODELS);
  if (preferred && /^gemini-[\w.-]+$/.test(preferred)) chain = [preferred, ...chain.filter(m => m !== preferred)];
  const grounding = searchOn && (env.GOOGLE_GROUNDING || "auto") !== "off" && Date.now() > groundingBlockedUntil;
  let last, carried = [];
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const cool = chain.filter(m => (coolUntil[m] || 0) > Date.now());
  if (cool.length < chain.length) chain = [...chain.filter(m => !cool.includes(m)), ...cool]; // rate-limited models go last
  for (const model of chain) {
    if (deadline - Date.now() < 1500) break;
    if (grounding && Date.now() > groundingBlockedUntil) {
      try { return { model, ...(await runModel(env, model, sysText, contents, "grounding", deadline)), grounded: true }; }
      catch (e) { last = e; if (e.status === 429 || e.status === 400 || e.status === 403) groundingBlockedUntil = Date.now() + 3600_000; else if (![500, 503, 504, 404].includes(e.status)) throw e; }
    }
    try { return { model, ...(await runModel(env, model, sysText, contents, searchOn ? "tools" : "plain", deadline, carried)) }; }
    catch (e) { last = e; if (e.results?.length) carried = e.results; if (e.status === 429 || e.status === 504) coolUntil[model] = Date.now() + (/PerDay|per day/i.test(e.message) ? 3600_000 : 60_000); console.log("model failed", model, e.status, e.message.slice(0, 120)); if (![429, 500, 502, 503, 504, 404].includes(e.status)) break; }
  }
  throw last || new GemError(502, "no model");
}

function sse(text, model, fr, cors) {
  const id = "chatcmpl-" + crypto.randomUUID(), created = Math.floor(Date.now() / 1000), enc = new TextEncoder();
  const ev = (delta, f = null) => "data: " + JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: f }] }) + "\n\n";
  const pieces = text.match(/[\s\S]{1,200}/g) || [""];
  const out = [ev({ role: "assistant", content: "" }), ...pieces.map(p => ev({ content: p })), ev({}, fr), "data: [DONE]\n\n"].join("");
  return new Response(enc.encode(out), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...cors } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url), origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);
    if (request.method === "OPTIONS") return new Response(null, { status: cors["Access-Control-Allow-Origin"] ? 204 : 403, headers: cors });
    if (url.pathname === "/health") return json({ ok: true }, 200, cors);
    if (["/image", "/video", "/limits", "/tts", "/storyboard"].includes(url.pathname)) {
      if (origin && !cors["Access-Control-Allow-Origin"]) return err("Origin not allowed", 403, cors, "forbidden");
      if (url.pathname === "/limits") return json(await limitsInfo(request, env), 200, cors);
      if (request.method !== "POST") return err("Not found", 404, cors, "not_found");
      if (rateLimited(request.headers.get("CF-Connecting-IP") || "local")) return err("Too many requests. Please wait a minute.", 429, cors, "rate_limit");
      const raw = await request.text();
      if (raw.length > 6 * 1024 * 1024) return err("Picture is too big", 413, cors, "invalid_request_error");
      let input; try { input = JSON.parse(raw); } catch { return err("Invalid JSON", 400, cors, "invalid_request_error"); }
      if (url.pathname === "/image") return handleImage(request, env, cors, input);
      if (url.pathname === "/tts") return handleTTS(request, env, cors, input);
      if (url.pathname === "/storyboard") return handleStoryboard(request, env, cors, input);
      const v = await handleVideo(request, env, cors, input);
      ctx?.waitUntil?.(v.done);
      return v.response;
    }
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
    const preferred = typeof input.model === "string" && input.model.startsWith("gemini-") ? input.model : null;

    const t0 = Date.now();
    let a;
    try { a = await answer(env, input.messages.slice(-MAX_MESSAGES), preferred, input.search !== false); }
    catch (e) {
      const busy = [429, 503, 504].includes(e.status);
      return err(busy ? "Nyansi is very busy right now. Please try again in a moment." : "AI service error (" + (e.status || 502) + ")", busy ? 503 : 502, cors);
    }
    const text = withSources(a.text || "", a.sources || [], a.cite);
    if (!text.trim()) return err("The AI sent an empty answer. Please try again.", 502, cors);
    const fr = finish(a.finish);
    if (input.stream) return sse(text, a.model, fr, cors);
    const u = a.usage || {};
    return json({
      id: "chatcmpl-" + crypto.randomUUID(), object: "chat.completion", created: Math.floor(Date.now() / 1000), model: a.model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: fr }],
      usage: { prompt_tokens: u.promptTokenCount || 0, completion_tokens: u.candidatesTokenCount || 0, total_tokens: u.totalTokenCount || 0 },
      nyansi: { provider: "gemini", model: a.model, searched: !!a.searched, grounded: !!a.grounded, ms: Date.now() - t0 }
    }, 200, cors);
  }
};
