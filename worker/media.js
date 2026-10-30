// Nyansi media: free AI images and short AI videos through public Hugging Face Spaces (no keys, no billing).
//   POST /image  { prompt, aspect?: "1:1"|"16:9"|"9:16", seed? }            -> image bytes (X-Nyansi-Provider: ai | backup)
//   POST /video  { prompt, image?: dataURL (jpeg/png/webp), aspect?, seconds?: 2|4 }
//                -> NDJSON stream of progress lines, last line { stage:"done", mime, b64, ms } or { stage:"error", message }
//   GET  /limits -> today's free use for this IP + device
// Daily limits are counted per IP and per device (X-Nyansi-Device header) in KV (binding LIMITS).

const IMAGE_SPACE = { host: "black-forest-labs-flux-1-schnell", fn: "infer" };      // FLUX.1 schnell (ZeroGPU)
const VIDEO_SPACE = { host: "lightricks-ltx-video-distilled", fn: "text_to_video" }; // LTX-Video distilled (ZeroGPU)
export const LIMITS = {
  image: { device: 20, ip: 60 },
  video: { device: 5, ip: 15 },
  globalVideo: 400                                                                   // whole app per day
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
  if ((w.dev !== "none" && u.device >= L.device) || u.ip >= L.ip) return `You've used today's ${L.device} free ${kind === "video" ? "videos" : "images"}. It resets at midnight (GMT).`;
  return null;
}
export async function limitsInfo(request, env) {
  const w = who(request), [i, v] = await Promise.all([usage(env, "image", w), usage(env, "video", w)]);
  const left = (k, u) => Math.max(0, Math.min(LIMITS[k].device - (w.dev !== "none" ? u.device : 0), LIMITS[k].ip - u.ip));
  return { day: day(), image: { limit: LIMITS.image.device, left: left("image", i) }, video: { limit: LIMITS.video.device, left: left("video", v) } };
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

function b64(buf) {
  const bytes = new Uint8Array(buf); let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
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
      const secs = input.seconds === 4 ? 4 : 2;
      let path = null, mode = "text-to-video";
      if (input.image) { send({ stage: "uploading" }); path = await uploadImage(VIDEO_SPACE.host, input.image); mode = "image-to-video"; }
      send({ stage: "starting", mode });
      const res = await gradio(VIDEO_SPACE.host, VIDEO_SPACE.fn,
        [prompt, NEG, path, null, ht, wd, mode, secs, 9, 42, true, 1, true],
        { timeoutMs: 170_000, onEvent: send });
      send({ stage: "downloading" });
      const f = res[0]?.video || res[0];
      const r = await fetch(fileUrl(VIDEO_SPACE.host, f));
      if (!r.ok) throw new Error("file " + r.status);
      const buf = await r.arrayBuffer();
      await count(env, "video", w, u);
      await send({ stage: "done", mode, mime: "video/mp4", seconds: secs, width: wd, height: ht, ms: Date.now() - t0, b64: b64(buf) });
    } catch (e) {
      console.log("video failed:", e.message);
      const quota = /quota|ZeroGPU|GPU/i.test(e.message);
      await send({ stage: "error", limit: !!e.limit, message: e.user ? e.message : quota ? "The free AI video GPU is out of quota right now." : "The free AI video service is busy or down right now." });
    } finally { out.close().catch(() => {}); }
  };
  const p = run();
  return { response: new Response(readable, { headers: H }), done: p };
}
