// Nyansi media: free AI images and short AI videos through public Hugging Face Spaces (no keys, no billing).
//   POST /image  { prompt, aspect?: "1:1"|"16:9"|"9:16", seed? }            -> image bytes (X-Nyansi-Provider: ai | backup)
//   POST /video  { prompt, image?: dataURL (jpeg/png/webp), aspect?, seconds?: 1..6 }   (one clip = one video credit)
//                -> NDJSON stream of progress lines, last line { stage:"done", mime, url, ms } or { stage:"error", message }
//                   (the browser downloads the clip from url and joins several clips into one longer video)
//   POST /tts    { text, voice?: female|male|child|storyteller, accent?: ghana|neutral } -> audio/wav (Gemini TTS, free tier)
//   POST /storyboard { idea, mode: t2v|i2v, scenes, seconds, narration: bool } -> { scenes:[...], narration }
//   GET  /limits -> today's free use for this IP + device
// Daily limits are counted per IP and per device (X-Nyansi-Device header) in KV (binding LIMITS).

const IMAGE_SPACE = { host: "black-forest-labs-flux-1-schnell", fn: "infer" };      // FLUX.1 schnell (ZeroGPU)
const VIDEO_SPACE = { host: "lightricks-ltx-video-distilled", fn: "text_to_video" }; // LTX-Video distilled (ZeroGPU)
export const LIMITS = {
  image: { device: 20, ip: 60 },
  video: { device: 10, ip: 30 },                                                     // counted in 5-second clips
  voice: { device: 15, ip: 45 },
  globalVideo: 800                                                                   // whole app per day
};
const DIMS = {
  image: { "1:1": [1024, 1024], "16:9": [1216, 704], "9:16": [704, 1216] },
  video: { "1:1": [512, 512], "16:9": [768, 448], "9:16": [448, 768] }
};
const NEG = "worst quality, inconsistent motion, blurry, jittery, distorted, watermark, text";
const BLOCK = /\b(child|children|kid|kids|minor|underage|teen|schoolgirl|schoolboy|loli)\b[\s\S]*\b(nude|naked|sex|sexual|porn|explicit|nsfw)\b|\b(nude|naked|sex|sexual|porn|explicit|nsfw)\b[\s\S]*\b(child|children|kid|kids|minor|underage|teen|schoolgirl|schoolboy|loli)\b/i;

const day = () => new Date().toISOString().slice(0, 10);
const hfBase = h => `https://${h}.hf.space/gradio_api`;

function who(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const dev = (request.headers.get("X-Nyansi-Device") || "").replace(/[^\w-]/g, "").slice(0, 64) || "none";
  return { ip, dev };
}
async function usage(env, kind, { ip, dev }) {
  if (!env.LIMITS) return { device: 0, ip: 0, global: 0 };
  const d = day();
  const [a, b, g] = await Promise.all([
    env.LIMITS.get(`${kind}:${d}:dev:${dev}`), env.LIMITS.get(`${kind}:${d}:ip:${ip}`),
    kind === "video" ? env.LIMITS.get(`video:${d}:all`) : null
  ]);
  return { device: +a || 0, ip: +b || 0, global: +g || 0 };
}
async function count(env, kind, w, u) {
  if (!env.LIMITS) return;
  const d = day(), opt = { expirationTtl: 60 * 60 * 36 };
  const jobs = [env.LIMITS.put(`${kind}:${d}:ip:${w.ip}`, String(u.ip + 1), opt)];
  if (w.dev !== "none") jobs.push(env.LIMITS.put(`${kind}:${d}:dev:${w.dev}`, String(u.device + 1), opt));
  if (kind === "video") jobs.push(env.LIMITS.put(`video:${d}:all`, String(u.global + 1), opt));
  await Promise.all(jobs).catch(() => {});
}
function overLimit(kind, u, w) {
  const L = LIMITS[kind];
  if (kind === "video" && u.global >= LIMITS.globalVideo) return "Nyansi has used today's free video budget. Please try again tomorrow.";
  if ((w.dev !== "none" && u.device >= L.device) || u.ip >= L.ip) return `You've used today's ${L.device} free ${{ video: "video clips", image: "images", voice: "voice-overs" }[kind]}. It resets at midnight (GMT).`;
  return null;
}
export async function limitsInfo(request, env) {
  const w = who(request), [i, v, a] = await Promise.all([usage(env, "image", w), usage(env, "video", w), usage(env, "voice", w)]);
  const left = (k, u) => Math.max(0, Math.min(LIMITS[k].device - (w.dev !== "none" ? u.device : 0), LIMITS[k].ip - u.ip));
  return { day: day(), image: { limit: LIMITS.image.device, left: left("image", i) }, video: { limit: LIMITS.video.device, left: left("video", v), unit: "5-second clip" }, voice: { limit: LIMITS.voice.device, left: left("voice", a) } };
}

// Call a Gradio endpoint (queue API), return the "complete" data array. onEvent gets queue/progress hints.
async function gradio(host, fn, data, { timeoutMs = 120_000, onEvent } = {}) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${hfBase(host)}/call/${fn}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data }), signal: ctl.signal });
    if (!r.ok) throw new Error(`space ${r.status}`);
    const { event_id } = await r.json();
    onEvent?.({ stage: "queued" });
    const s = await fetch(`${hfBase(host)}/call/${fn}/${event_id}`, { signal: ctl.signal });
    if (!s.ok || !s.body) throw new Error(`space stream ${s.status}`);
    const reader = s.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "", ev = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line.startsWith("event:")) { ev = line.slice(6).trim(); if (ev === "generating") onEvent?.({ stage: "generating" }); }
        else if (line.startsWith("data:")) {
          const d = line.slice(5).trim();
          if (ev === "complete") return JSON.parse(d);
          if (ev === "error") { let m = ""; try { m = JSON.parse(d) || ""; } catch { m = d; } throw new Error("space error" + (m && m !== "null" ? ": " + String(m).slice(0, 200) : "")); }
        }
      }
    }
    throw new Error("space closed early");
  } finally { clearTimeout(timer); }
}
const fileUrl = (host, f) => f?.url || `${hfBase(host)}/file=${f?.path}`;

async function uploadImage(host, dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || "");
  if (!m) throw Object.assign(new Error("Please use a JPG, PNG or WebP picture."), { user: true });
  const bin = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
  if (bin.length > 4 * 1024 * 1024) throw Object.assign(new Error("Picture is too big (max 4 MB)."), { user: true });
  const fd = new FormData();
  fd.append("files", new Blob([bin], { type: m[1] }), "input." + m[1].split("/")[1].replace("jpeg", "jpg"));
  const r = await fetch(`${hfBase(host)}/upload`, { method: "POST", body: fd });
  if (!r.ok) throw new Error("upload " + r.status);
  return (await r.json())[0];
}

function cleanPrompt(p) {
  const s = String(p || "").replace(/\s+/g, " ").trim().slice(0, 600);
  if (!s) throw Object.assign(new Error("Please describe what you want to create."), { user: true });
  if (BLOCK.test(s)) throw Object.assign(new Error("That request isn't allowed."), { user: true });
  return s;
}

export async function handleImage(request, env, cors, input) {
  const w = who(request), u = await usage(env, "image", w), over = overLimit("image", u, w);
  const H = (extra = {}) => ({ ...cors, "Access-Control-Expose-Headers": "X-Nyansi-Provider, X-Nyansi-Ms", ...extra });
  if (over) return new Response(JSON.stringify({ error: { message: over, type: "limit" } }), { status: 429, headers: H({ "Content-Type": "application/json" }) });
  let prompt;
  try { prompt = cleanPrompt(input.prompt); } catch (e) { return new Response(JSON.stringify({ error: { message: e.message } }), { status: 400, headers: H({ "Content-Type": "application/json" }) }); }
  const [wd, ht] = DIMS.image[input.aspect] || DIMS.image["1:1"];
  const seed = Number.isInteger(input.seed) ? input.seed : Math.floor(Math.random() * 2 ** 31);
  const t0 = Date.now();
  let img, provider = "ai";
  try {
    const out = await gradio(IMAGE_SPACE.host, IMAGE_SPACE.fn, [prompt, seed, false, wd, ht, 4], { timeoutMs: 60_000 });
    const r = await fetch(fileUrl(IMAGE_SPACE.host, out[0]));
    if (!r.ok) throw new Error("file " + r.status);
    img = new Response(r.body, { headers: { "Content-Type": r.headers.get("Content-Type") || "image/webp" } });
  } catch (e) {
    console.log("image space failed:", e.message);
    provider = "backup";
    const q = new URLSearchParams({ width: String(Math.round(wd * 0.75)), height: String(Math.round(ht * 0.75)), seed: String(seed), nologo: "true", referrer: "nyansi", safe: "true" });
    const r = await fetch(`https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${q}`, { headers: { Referer: "https://reghson.github.io/" } });
    if (!r.ok || !(r.headers.get("Content-Type") || "").startsWith("image/")) return new Response(JSON.stringify({ error: { message: "The free image service is busy. Please try again in a minute." } }), { status: 503, headers: H({ "Content-Type": "application/json" }) });
    img = new Response(r.body, { headers: { "Content-Type": r.headers.get("Content-Type") } });
  }
  await count(env, "image", w, u);
  return new Response(img.body, { headers: H({ "Content-Type": img.headers.get("Content-Type"), "X-Nyansi-Provider": provider, "X-Nyansi-Ms": String(Date.now() - t0), "Cache-Control": "no-store" }) });
}


export async function handleVideo(request, env, cors, input) {
  const w = who(request), u = await usage(env, "video", w), over = overLimit("video", u, w);
  const H = { ...cors, "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" };
  const { readable, writable } = new TransformStream();
  const out = writable.getWriter(), enc = new TextEncoder();
  const send = o => out.write(enc.encode(JSON.stringify(o) + "\n")).catch(() => {});
  const run = async () => {
    const t0 = Date.now();
    try {
      if (over) throw Object.assign(new Error(over), { user: true, limit: true });
      const prompt = cleanPrompt(input.prompt || (input.image ? "gentle natural motion, cinematic" : ""));
      const [wd, ht] = DIMS.video[input.aspect] || DIMS.video["16:9"];
      const secs = Math.min(6, Math.max(1, Math.round((+input.seconds || 5) * 2) / 2)); // >6 s per clip is unreliable on the free GPU
      let path = null, mode = "text-to-video";
      if (input.image) { send({ stage: "uploading" }); path = await uploadImage(VIDEO_SPACE.host, input.image); mode = "image-to-video"; }
      send({ stage: "starting", mode });
      const res = await gradio(VIDEO_SPACE.host, VIDEO_SPACE.fn,
        [prompt, NEG, path, null, ht, wd, mode, secs, 9, 42, true, 1, true],
        { timeoutMs: 170_000, onEvent: send });
      const f = res[0]?.video || res[0];
      const url = fileUrl(VIDEO_SPACE.host, f);
      if (!url) throw new Error("no file");
      await count(env, "video", w, u);
      // The browser downloads the clip straight from the Space (CORS allows our origin); no big base64 here.
      await send({ stage: "done", mode, mime: "video/mp4", seconds: secs, width: wd, height: ht, ms: Date.now() - t0, url });
    } catch (e) {
      console.log("video failed:", e.message);
      const quota = /quota|ZeroGPU|GPU/i.test(e.message);
      await send({ stage: "error", limit: !!e.limit, message: e.user ? e.message : quota ? "The free AI video GPU is out of quota right now." : "The free AI video service is busy or down right now." });
    } finally { out.close().catch(() => {}); }
  };
  const p = run();
  return { response: new Response(readable, { headers: H }), done: p };
}

// ---------------- voice-over (Gemini TTS, free tier) ----------------
// 3.1 / 2.5 speak at a natural pace; the 3.8 models are slower, so they are backups. Free quotas are small, hence the chain.
const TTS_MODELS = ["gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts", "gemini-3.8-flash-lite-tts", "gemini-3.8-flash-tts"];
const VOICES = {
  female: { name: "Kore", style: "Read this at a natural, lively pace in a clear, warm, friendly female voice" },
  male: { name: "Charon", style: "Read this at a natural pace in a calm, confident, deep male voice" },
  child: { name: "Leda", style: "Read this at a natural, lively pace in a bright, cheerful, playful young child's voice" },
  storyteller: { name: "Sulafat", style: "Tell this like a warm, wise storyteller telling a folk tale, expressive but not slow" }
};
function wav(pcm, rate = 24000) {
  const h = new DataView(new ArrayBuffer(44)), w = (o, t) => [...t].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); h.setUint32(4, 36 + pcm.length, true); w(8, "WAVE"); w(12, "fmt "); h.setUint32(16, 16, true); h.setUint16(20, 1, true);
  h.setUint16(22, 1, true); h.setUint32(24, rate, true); h.setUint32(28, rate * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true);
  w(36, "data"); h.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length); out.set(new Uint8Array(h.buffer)); out.set(pcm, 44); return out;
}
export async function handleTTS(request, env, cors, input) {
  const w = who(request), u = await usage(env, "voice", w), over = overLimit("voice", u, w);
  const J = (o, st) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, "Content-Type": "application/json" } });
  if (over) return J({ error: { message: over, type: "limit" } }, 429);
  const text = String(input.text || "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 700);
  if (!text) return J({ error: { message: "Write something for Nyansi to say." } }, 400);
  if (BLOCK.test(text)) return J({ error: { message: "That narration isn't allowed." } }, 400);
  const v = VOICES[input.voice] || VOICES.female;
  const accent = input.accent === "ghana" ? ", with a natural Ghanaian English accent" : "";
  const body = { contents: [{ parts: [{ text: `${v.style}${accent}:\n${text}` }] }],
    generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: v.name } } } } };
  const t0 = Date.now();
  for (const m of TTS_MODELS) {
    try {
      const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 40000);
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY }, body: JSON.stringify(body), signal: ac.signal }).finally(() => clearTimeout(timer));
      if (!r.ok) { console.log("tts", m, r.status); continue; }
      const d = await r.json(), part = d.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      if (!part) { console.log("tts", m, "no audio"); continue; }
      let bin = Uint8Array.from(atob(part.inlineData.data), c => c.charCodeAt(0));
      const mime = part.inlineData.mimeType || "";
      if (!/wav/i.test(mime)) bin = wav(bin, +(/rate=(\d+)/.exec(mime)?.[1] || 24000));
      await count(env, "voice", w, u);
      return new Response(bin, { headers: { ...cors, "Content-Type": "audio/wav", "X-Nyansi-Ms": String(Date.now() - t0), "Access-Control-Expose-Headers": "X-Nyansi-Ms" } });
    } catch (e) { console.log("tts", m, e.name); }
  }
  return J({ error: { message: "The free voice service is busy right now. Please try again later." } }, 503);
}

// ---------------- storyboard: scene prompts + narration that fits the length ----------------
const TEXT_MODELS = ["gemini-flash-lite-latest", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash"];
export async function handleStoryboard(request, env, cors, input) {
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, "Content-Type": "application/json" } });
  const idea = cleanPrompt(input.idea || "");
  const n = Math.min(4, Math.max(1, +input.scenes || 1)), secs = Math.min(24, Math.max(2, +input.seconds || 5));
  const words = Math.max(5, Math.round((secs - 1.2) * 2));
  if (!idea && input.mode !== "i2v") return J({ error: { message: "Describe the video first." } }, 400);
  const task = input.mode === "i2v"
    ? `The video starts from the user's picture${idea ? ` (user's note: "${idea}")` : ""}. Each scene continues from the last frame of the one before.`
    : `Video idea from the user: "${idea}".`;
  const sys = `You write plans for short AI videos made of ${n} scene(s) of about ${Math.round(secs / n)} seconds each (${secs} seconds in total). ${task}
Return JSON: {"scenes": [${n} strings], "narration": string}.
- Each scene is one vivid English sentence for a video AI: subject, action, camera move, light. Keep the same characters, place and style in every scene so the story flows; scene 2+ continue the action.
- ${input.narration ? `narration: a voice-over of at most ${words} words (it must fit in ${secs} seconds when spoken), simple warm English that tells the story. No stage directions.` : 'narration: ""'}
- Nothing sexual, hateful or violent; no real famous people.`;
  for (const m of TEXT_MODELS) {
    try {
      const body = { systemInstruction: { parts: [{ text: sys }] }, contents: [{ role: "user", parts: [{ text: idea || "Animate the picture in a natural, cinematic way." }] }],
        generationConfig: { temperature: 0.8, maxOutputTokens: 800, responseMimeType: "application/json" } };
      if (/^gemini-3/.test(m)) body.generationConfig.thinkingConfig = { thinkingLevel: "low" };
      const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 15000);
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY }, body: JSON.stringify(body), signal: ac.signal }).finally(() => clearTimeout(timer));
      if (!r.ok) { console.log("storyboard", m, r.status); continue; }
      const d = await r.json(), txt = (d.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join("");
      const j = JSON.parse(txt.replace(/^```(?:json)?|```$/g, "").trim());
      let scenes = (Array.isArray(j.scenes) ? j.scenes : []).map(x => cleanPrompt(String(x))).filter(Boolean).slice(0, n);
      while (scenes.length < n) scenes.push(scenes[scenes.length - 1] || idea);
      let narration = String(j.narration || "").trim();
      const ws = narration.split(/\s+/); if (ws.length > words + 3) narration = ws.slice(0, words).join(" ").replace(/[,;:]?$/, ".");
      return J({ scenes, narration: input.narration ? narration : "", model: m });
    } catch (e) { console.log("storyboard", m, e.message); }
  }
  return J({ error: { message: "Couldn't plan the scenes right now." } }, 503);
}
