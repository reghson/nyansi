/* Nyansi Create: Text to Image, Image to Video, Text to Video.
 * Real AI runs on Nyansi's backend (free open models). If the AI video service is down or today's
 * free videos are used up, Nyansi can make an "Animated slideshow" in the browser instead —
 * clearly labelled, because it is a zoom-and-pan animation of a still picture, not AI motion.
 * Videos can be 5–20 s (several 5 s AI scenes joined on the device) with an optional voice-over and music. */
(() => {
  const $ = s => document.querySelector(s);
  const CFG = window.NYANSI_CONFIG, U = window.NyansiUtil;
  const API = (CFG.mediaEndpoint || (CFG.chatEndpoint || "").replace(/\/chat$/, "")).replace(/\/$/, "");
  const apiOK = API && !API.includes("<");
  const DEVICE = localStorage.getItem("nyansi.device") || (() => { const d = (crypto.randomUUID?.() || String(Math.random()).slice(2) + Date.now()); localStorage.setItem("nyansi.device", d); return d; })();
  const HDR = { "Content-Type": "application/json", "X-Nyansi-Device": DEVICE };
  const LIMITS = CFG.mediaLimits || { image: 20, video: 10, voice: 15 };
  let tab = "t2i", i2vSource = null, busy = false;

  // ---------- gallery (IndexedDB) ----------
  const DB = new Promise((res, rej) => {
    const r = indexedDB.open("nyansi-create", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("items", { keyPath: "id" });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const store = async mode => (await DB).transaction("items", mode).objectStore("items");
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function saveItem(it) {
    await req((await store("readwrite")).put(it));
    const all = await allItems();
    for (const old of all.slice(30)) await req((await store("readwrite")).delete(old.id)); // keep the newest 30
    renderGallery();
  }
  const allItems = async () => (await req((await store("readonly")).getAll())).sort((a, b) => b.created - a.created);
  const delItem = async id => { await req((await store("readwrite")).delete(id)); renderGallery(); };

  // ---------- helpers ----------
  const ext = mime => mime.includes("mp4") ? "mp4" : mime.includes("webm") ? "webm" : mime.includes("png") ? "png" : mime.includes("jpeg") ? "jpg" : "webp";
  function downloadBlob(blob, name) {
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  const loadImg = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("Couldn't read that picture.")); i.src = src; });
  async function toDataURL(blob, max = 768) {
    const url = URL.createObjectURL(blob);
    try {
      const img = await loadImg(url), k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas"); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      return { data: c.toDataURL("image/jpeg", 0.9), ratio: c.width / c.height };
    } finally { URL.revokeObjectURL(url); }
  }
  const nearestAspect = r => r > 1.25 ? "16:9" : r < 0.8 ? "9:16" : "1:1";

  // ---------- free limits ----------
  async function refreshLimits() {
    const el = $("#createQuota");
    if (!apiOK) { el.textContent = "Create needs the Nyansi backend"; return; }
    try {
      const r = await fetch(API + "/limits", { headers: { "X-Nyansi-Device": DEVICE } });
      const j = await r.json();
      el.textContent = `Free today: ${j.image.left}/${j.image.limit} images · ${j.video.left}/${j.video.limit} video clips · ${j.voice?.left ?? "–"}/${j.voice?.limit ?? LIMITS.voice} voices`;
    } catch { el.textContent = `Free plan: ${LIMITS.image} images + ${LIMITS.video} video clips (5 s each) a day`; }
  }

  // ---------- progress ----------
  function progress(box, label, pct) {
    box.hidden = false;
    box.querySelector(".pg-l").textContent = label;
    box.querySelector(".pg-bar i").style.width = Math.max(3, Math.min(100, pct)) + "%";
  }
  function ticker(box, expectMs, from = 25, to = 92) {
    const t0 = Date.now(); let label = "Working…";
    const id = setInterval(() => {
      const s = (Date.now() - t0) / 1000, p = from + (to - from) * (1 - Math.exp(-(Date.now() - t0) / expectMs));
      progress(box, `${label} ${s.toFixed(0)} s`, p);
    }, 250);
    return { set(l) { label = l; }, stop() { clearInterval(id); } };
  }

  // ---------- result card ----------
  function showResult(item, { fallbackNote } = {}) {
    const box = $("#createResult"); box.hidden = false; box.innerHTML = "";
    const url = URL.createObjectURL(item.blob);
    const media = item.kind === "image" ? Object.assign(document.createElement("img"), { src: url, alt: item.prompt })
      : Object.assign(document.createElement("video"), { src: url, controls: true, loop: !item.sound, autoplay: !item.sound, muted: !item.sound, playsInline: true });
    media.className = "cr-media";
    const tag = document.createElement("span");
    tag.className = "cr-tag" + (item.ai ? "" : " alt");
    tag.textContent = item.label;
    const p = document.createElement("p"); p.className = "cr-prompt"; p.textContent = item.prompt;
    const btns = document.createElement("div"); btns.className = "btns";
    const dl = Object.assign(document.createElement("button"), { className: "go-btn sm", textContent: "⬇ Download" });
    dl.onclick = () => downloadBlob(item.blob, `nyansi-${U.slug(item.prompt)}.${ext(item.mime)}`);
    btns.append(dl);
    if (item.kind === "image") {
      const an = Object.assign(document.createElement("button"), { className: "ghost-btn sm", textContent: "🎞 Animate this" });
      an.onclick = () => { useForVideo(item.blob, item.prompt); setTab("i2v"); };
      btns.append(an);
    }
    box.append(tag, media, p, btns);
    if (fallbackNote) { const n = document.createElement("p"); n.className = "cr-note"; n.textContent = fallbackNote; box.append(n); }
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function showError(msg, offer) {
    const box = $("#createResult"); box.hidden = false; box.innerHTML = "";
    const p = document.createElement("p"); p.className = "err"; p.textContent = "⚠️ " + msg; box.append(p);
    if (offer) {
      const b = Object.assign(document.createElement("button"), { className: "ghost-btn sm", textContent: "🎞 Make an animated slideshow instead" });
      b.onclick = offer; box.append(b);
      const n = document.createElement("p"); n.className = "cr-note"; n.textContent = "An animated slideshow zooms and pans across a still picture with your caption. It is made on your phone and is not AI motion."; box.append(n);
    }
  }

  // ---------- Text to Image ----------
  async function makeImage(prompt, aspect) {
    const t0 = performance.now();
    const r = await fetch(API + "/image", { method: "POST", headers: HDR, body: JSON.stringify({ prompt, aspect }) });
    if (!r.ok) { let m = "Image service error (" + r.status + ")"; try { m = (await r.json()).error.message; } catch {} throw new Error(m); }
    const blob = await r.blob(), provider = r.headers.get("X-Nyansi-Provider") || "ai";
    const ms = Math.round(performance.now() - t0);
    console.info(`[Nyansi Create] image via ${provider === "ai" ? "Nyansi AI" : "backup"} in ${ms} ms`);
    return { blob, provider, ms };
  }
  async function runT2I() {
    const prompt = $("#t2iPrompt").value.trim(); if (!prompt) return $("#t2iPrompt").focus();
    const pg = $("#createProgress"), tk = ticker(pg, 6000, 10, 95); tk.set("Drawing your picture…");
    try {
      const { blob, provider, ms } = await makeImage(prompt, $("#t2iAspect").value);
      tk.stop(); progress(pg, `Done in ${(ms / 1000).toFixed(1)} s`, 100);
      const item = { id: "c" + Date.now(), kind: "image", prompt, blob, mime: blob.type, ai: true, label: provider === "ai" ? "🖼 AI image" : "🖼 AI image (backup service)", created: Date.now() };
      await saveItem(item); showResult(item);
    } catch (e) { tk.stop(); pg.hidden = true; showError(e.message); }
    refreshLimits();
  }

  // ---------- Image to Video / Text to Video (real AI) ----------
  // Long videos are made of 5-second AI scenes. Each new scene starts from the last frame of the one
  // before, so the story flows. Nyansi then joins the scenes on this device and mixes in the voice-over
  // and background music (made for Nyansi, free to use) into one video file.
  const CLIP = 5;                                         // seconds per AI scene (the free GPU is reliable up to ~6 s)
  const VOICE_LABEL = { female: "Female voice", male: "Male voice", child: "Child voice", storyteller: "Storyteller" };
  let AC = null;                                          // AudioContext, created on the button tap (phones need a tap)
  const audioCtx = () => { try { AC = AC || new (window.AudioContext || window.webkitAudioContext)(); AC.resume?.(); } catch { AC = null; } return AC; };
  const opt = p => ({ len: +$(`#${p}Len`).value, narr: $(`#${p}Narr`).value.trim(), voice: $(`#${p}Voice`).value, accent: $(`#${p}Accent`).value, music: $(`#${p}Music`).value });

  async function postJSON(path, body) {
    const r = await fetch(API + path, { method: "POST", headers: HDR, body: JSON.stringify(body) });
    if (!r.ok) { let m = "Service error (" + r.status + ")"; try { m = (await r.json()).error.message; } catch {} throw Object.assign(new Error(m), { status: r.status }); }
    return r;
  }
  async function clipsLeft() {
    try { const j = await (await fetch(API + "/limits", { headers: { "X-Nyansi-Device": DEVICE } })).json(); return j.video.left; } catch { return null; }
  }

  // One AI clip. onStage(label) gets "waiting for GPU" style hints.
  async function makeClip(body, onStage) {
    const r = await fetch(API + "/video", { method: "POST", headers: HDR, body: JSON.stringify(body) });
    if (!r.ok || !r.body) { let m = "Video service error (" + r.status + ")"; try { m = (await r.json()).error.message; } catch {} throw Object.assign(new Error(m), { soft: r.status !== 429 }); }
    const rd = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "", last = null;
    for (;;) {
      const { value, done } = await rd.read(); if (done) break;
      buf += value; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
        const ev = JSON.parse(line); last = ev;
        if (ev.stage === "uploading") onStage("Sending the picture…");
        else if (ev.stage === "starting" || ev.stage === "queued") onStage("Waiting for a free AI video GPU…");
        else if (ev.stage === "generating") onStage("Making the video…");
      }
    }
    if (!last || last.stage !== "done") throw Object.assign(new Error(last?.message || "The AI video service didn't finish."), { soft: !last?.limit, limit: !!last?.limit });
    onStage("Downloading the scene…");
    const v = await fetch(last.url);
    if (!v.ok) throw Object.assign(new Error("Couldn't download the video (" + v.status + ")."), { soft: true });
    return await v.blob();
  }

  const loadVideo = blob => new Promise((res, rej) => {
    const v = document.createElement("video");
    Object.assign(v, { muted: true, playsInline: true, preload: "auto", src: URL.createObjectURL(blob) });
    v.setAttribute("playsinline", ""); v.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none";
    document.body.append(v);
    v.onloadeddata = () => res(v); v.onerror = () => rej(new Error("Couldn't read a video scene."));
  });
  const dropVideo = v => { URL.revokeObjectURL(v.src); v.remove(); };
  // Last frame of a clip as a JPEG, used as the start picture of the next scene.
  async function lastFrame(blob) {
    const v = await loadVideo(blob);
    try {
      await new Promise(r => { v.onseeked = r; v.currentTime = Math.max(0, v.duration - 0.06); });
      const k = Math.min(1, 768 / Math.max(v.videoWidth, v.videoHeight)), c = document.createElement("canvas");
      c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
      c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.9);
    } finally { dropVideo(v); }
  }

  // Music files are stored as base64 text (AAC audio in an .m4a) so they can live in the repo as text.
  const b64Blob = (b64, type) => { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type }); };
  async function decode(blob) {
    const ac = audioCtx(); if (!ac) throw new Error("no audio");
    const ab = await blob.arrayBuffer();
    return await new Promise((res, rej) => { const p = ac.decodeAudioData(ab, res, rej); p?.then?.(res, rej); });
  }
  // Remove silence at the start and end of the voice-over so it fits the video better.
  function trimSilence(buf) {
    const d = buf.getChannelData(0), th = 0.012, sr = buf.sampleRate;
    let a = 0, b = d.length - 1;
    while (a < b && Math.abs(d[a]) < th) a++;
    while (b > a && Math.abs(d[b]) < th) b--;
    a = Math.max(0, a - Math.round(sr * 0.05)); b = Math.min(d.length, b + Math.round(sr * 0.12));
    if (b - a < sr * 0.3) return buf;
    const out = AC.createBuffer(buf.numberOfChannels, b - a, sr);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) out.copyToChannel(buf.getChannelData(ch).subarray(a, b), ch);
    return out;
  }

  // Join scenes + voice + music on this device. Plays the scenes into a canvas and records it with the
  // mixed audio (MediaRecorder). Runs in real time, so a 20-second video takes about 20 seconds.
  async function compose(clips, { voice, music, onP }) {
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) throw new Error("this browser can't join videos");
    const vids = [];
    for (const b of clips) vids.push(await loadVideo(b));
    const W = vids[0].videoWidth || 768, H = vids[0].videoHeight || 448;
    const c = Object.assign(document.createElement("canvas"), { width: W, height: H }), g = c.getContext("2d");
    const prev = $("#createResult"); prev.hidden = false; prev.innerHTML = "";
    c.className = "cr-media"; c.style.width = "100%"; c.style.height = "auto"; prev.append(c);
    const note = Object.assign(document.createElement("p"), { className: "cr-note", textContent: "Joining scenes with sound… keep this screen on." }); prev.append(note);
    const vidDur = vids.reduce((s, v) => s + (isFinite(v.duration) ? v.duration : CLIP), 0);
    const ac = (voice || music) ? audioCtx() : null;
    let total = vidDur, rate = 1, voiceAt = 0.35, hold = 0;
    const tracks = [c.captureStream(30).getVideoTracks()[0]];
    let dest = null, srcs = [];
    if (ac) {
      dest = ac.createMediaStreamDestination();
      if (voice) {
        const need = voice.duration + voiceAt + 0.3;
        if (need > vidDur) rate = Math.min(1.12, (voice.duration) / (vidDur - voiceAt - 0.3));
        const spoken = voice.duration / rate;
        if (spoken + voiceAt + 0.3 > vidDur) hold = Math.min(3, spoken + voiceAt + 0.4 - vidDur); // hold the last picture a moment so the voice can finish
        total = vidDur + hold;
      }
      tracks.push(dest.stream.getAudioTracks()[0]);
    }
    const types = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=avc1,opus", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    const mime = types.find(t => MediaRecorder.isTypeSupported(t)) || "";
    const rec = new MediaRecorder(new MediaStream(tracks), mime ? { mimeType: mime, videoBitsPerSecond: 3_500_000, audioBitsPerSecond: 128_000 } : {});
    const chunks = []; rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    let cur = 0;
    const draw = () => { const v = vids[Math.min(cur, vids.length - 1)]; if (v.readyState >= 2) g.drawImage(v, 0, 0, W, H); };
    draw();
    return await new Promise((res, rej) => {
      rec.onstop = () => { vids.forEach(dropVideo); srcs.forEach(s => { try { s.stop(); } catch {} }); res({ blob: new Blob(chunks, { type: (mime || "video/webm").split(";")[0] }), seconds: total, rate, hold }); };
      rec.onerror = e => rej(e.error || new Error("recording failed"));
      vids.forEach((v, i) => v.onended = () => { if (i === cur && cur < vids.length - 1) { cur++; vids[cur].play().catch(() => {}); } });
      rec.start(250);
      const t0 = performance.now();
      vids[0].play().catch(() => {});
      if (ac) {
        const now = ac.currentTime + 0.05;
        if (music) {
          const m = ac.createBufferSource(), mg = ac.createGain(); m.buffer = music; m.loop = true;
          const lo = voice ? 0.11 : 0.28, hi = voice ? 0.2 : 0.28;
          mg.gain.setValueAtTime(0, now); mg.gain.linearRampToValueAtTime(hi, now + 0.6);
          if (voice) mg.gain.linearRampToValueAtTime(lo, now + voiceAt);                 // duck under the voice
          mg.gain.setValueAtTime(voice ? lo : hi, now + Math.max(0.7, total - 1.4)); mg.gain.linearRampToValueAtTime(0, now + total - 0.1);
          m.connect(mg).connect(dest); m.start(now); srcs.push(m);
        }
        if (voice) {
          const s = ac.createBufferSource(), vg = ac.createGain(); s.buffer = voice; s.playbackRate.value = rate;
          vg.gain.value = 1; s.connect(vg).connect(dest); s.start(now + voiceAt); srcs.push(s);
          const end = now + total - 0.05; vg.gain.setValueAtTime(1, end - 0.25); vg.gain.linearRampToValueAtTime(0, end);
        }
      }
      (function loop() {
        const t = (performance.now() - t0) / 1000;
        draw(); onP?.(Math.min(1, t / total));
        if (t < total) requestAnimationFrame(loop); else setTimeout(() => rec.stop(), 150);
      })();
    });
  }

  // The whole video flow, for both tabs.
  async function videoFlow({ mode, prompt, image, aspect, o, label }) {
    const pg = $("#createProgress"), n = Math.max(1, Math.round(o.len / CLIP)), t0 = performance.now();
    const notes = [];
    const left = await clipsLeft();
    if (left !== null && left < n) throw Object.assign(new Error(left ? `A ${o.len}-second video uses ${n} clips, but you have ${left} left today. Pick ${left * CLIP} seconds or less.` : "You've used today's free video clips. They come back tomorrow."), { soft: false });
    const wantVoice = o.voice !== "none";
    // 1) plan the scenes (and write the narration if the box is empty)
    let scenes = [prompt], narration = o.narr;
    if (n > 1 || (wantVoice && !narration)) {
      progress(pg, n > 1 ? `Planning ${n} scenes…` : "Writing the narration…", 4);
      try {
        const j = await (await postJSON("/storyboard", { idea: prompt, mode, scenes: n, seconds: o.len, narration: wantVoice && !narration })).json();
        if (n > 1) scenes = j.scenes.map((s, i) => i === 0 ? `${prompt}. ${s}` : s);
        if (wantVoice && !narration) { narration = j.narration; const box = $(`#${mode}Narr`); if (box && !box.value) { box.value = narration; box.dispatchEvent(new Event("input")); } }
      } catch { if (n > 1) scenes = Array.from({ length: n }, (_, i) => i ? `${prompt}, the action continues` : prompt); }
    }
    // 2) voice and music in the background while the scenes are made
    const voiceP = wantVoice && narration ? postJSON("/tts", { text: narration, voice: o.voice, accent: o.accent }).then(r => r.blob()).then(decode).then(trimSilence)
      .catch(e => { notes.push(`The voice-over couldn't be made (${e.message}). Your video is ready without it.`); return null; }) : Promise.resolve(null);
    if (wantVoice && !narration) notes.push("No narration was written, so there is no voice-over.");
    const musicP = o.music !== "none" ? fetch(`music/${o.music}.m4a.b64`).then(r => { if (!r.ok) throw new Error(r.status); return r.text(); }).then(t => b64Blob(t.trim(), "audio/mp4")).then(decode)
      .catch(() => { notes.push("The background music couldn't be loaded, so the video has no music."); return null; }) : Promise.resolve(null);
    // 3) the AI scenes, one after another
    const clips = []; let start = image;
    for (let k = 0; k < n; k++) {
      const base = 8 + 72 * k / n, span = 72 / n, sTag = n > 1 ? `Scene ${k + 1} of ${n}: ` : "";
      const tk = ticker(pg, 14000, base, base + span * 0.95); tk.set(sTag + (start ? "Sending the picture…" : "Starting…"));
      try {
        let blob;
        try { blob = await makeClip({ prompt: scenes[k], image: start || undefined, aspect, seconds: CLIP }, l => tk.set(sTag + l)); }
        catch (e) { if (e.limit || !e.soft) throw e; tk.set(sTag + "Trying again…"); blob = await makeClip({ prompt: scenes[k], image: start || undefined, aspect, seconds: CLIP }, l => tk.set(sTag + l)); }
        clips.push(blob); tk.stop();
        if (k < n - 1) start = await lastFrame(blob);
      } catch (e) {
        tk.stop();
        if (!clips.length) { pg.hidden = true; throw e; }
        notes.push(`Only ${clips.length} of ${n} scenes could be made (${e.message}), so the video is shorter.`); break;
      }
    }
    // 4) join + sound
    const [voice, music] = await Promise.all([voiceP, musicP]);
    let blob, mime = "video/mp4", secs = clips.length * CLIP;
    if (clips.length === 1 && !voice && !music) blob = clips[0];
    else {
      progress(pg, "Joining scenes and adding sound… keep this screen on", 82);
      try {
        const out = await compose(clips, { voice, music, onP: p => progress(pg, `Joining scenes and adding sound… ${Math.round(p * 100)}% (keep this screen on)`, 82 + p * 17) });
        blob = out.blob; mime = blob.type; secs = out.seconds;
        if (out.hold > 0.2) notes.push(`The voice-over was a little longer than the video, so the last picture stays on screen for ${out.hold.toFixed(1)} s more. Use fewer words or a longer length for a perfect fit.`);
      } catch (e) {
        blob = clips[0]; notes.push(`Couldn't join the scenes on this device (${e.message}), so this is scene 1 only, without sound.`);
      }
    }
    const ms = performance.now() - t0;
    progress(pg, `Done in ${(ms / 1000).toFixed(0)} s`, 100);
    console.info(`[Nyansi Create] ${mode} ${clips.length}×${CLIP}s voice=${!!voice} music=${!!music} ${mime} in ${Math.round(ms)} ms`);
    const extra = [`${Math.round(secs)} s`, voice ? VOICE_LABEL[o.voice] : "", music ? "music" : ""].filter(Boolean).join(" · ");
    const item = { id: "c" + Date.now(), kind: "video", prompt: narration ? `${prompt}\n🗣 “${narration}”` : prompt, blob, mime, ai: true, sound: !!(voice || music) && blob !== clips[0], label: `${label} · ${extra}`, created: Date.now() };
    await saveItem(item); showResult(item, { fallbackNote: notes.join(" ") || "" });
  }

  function useForVideo(blob, prompt) {
    i2vSource = { blob, prompt };
    const prev = $("#i2vPreview"); prev.innerHTML = "";
    const img = Object.assign(document.createElement("img"), { src: URL.createObjectURL(blob), alt: "Picture to animate" });
    prev.append(img); prev.hidden = false; $("#i2vDrop").classList.add("has");
    if (prompt && !$("#i2vPrompt").value) $("#i2vPrompt").placeholder = "How should it move? e.g. the camera slowly pushes in, leaves sway in the wind";
  }

  async function runI2V() {
    if (!i2vSource) { showError("Pick or upload a picture first."); return; }
    audioCtx();
    const prompt = $("#i2vPrompt").value.trim() || "gentle natural motion, slow cinematic camera move";
    let img;
    try { img = await toDataURL(i2vSource.blob); } catch (e) { return showError(e.message); }
    const aspect = nearestAspect(img.ratio);
    try { await videoFlow({ mode: "i2v", prompt, image: img.data, aspect, o: opt("i2v"), label: "🎞 AI video from picture" }); }
    catch (e) { showError(e.message, e.soft === false ? null : () => slideshowFlow(i2vSource.blob, $("#i2vPrompt").value.trim() || i2vSource.prompt || "", aspect)); }
    refreshLimits();
  }

  async function runT2V() {
    const prompt = $("#t2vPrompt").value.trim(); if (!prompt) return $("#t2vPrompt").focus();
    audioCtx();
    const aspect = $("#t2vAspect").value, pg = $("#createProgress");
    try { await videoFlow({ mode: "t2v", prompt, aspect, o: opt("t2v"), label: "🎬 AI video from text" }); }
    catch (e) {
      showError(e.message, e.soft === false ? null : async () => {
        const tk = ticker(pg, 6000, 10, 60); tk.set("Drawing a picture for the slideshow…");
        try { const { blob } = await makeImage(prompt, aspect); tk.stop(); await slideshowFlow(blob, prompt, aspect); }
        catch (er) { tk.stop(); pg.hidden = true; showError(er.message); }
      });
    }
    refreshLimits();
  }

  // "Auto-write narration" buttons
  async function autoNarr(p) {
    const btn = $(`#${p}NarrAuto`), box = $(`#${p}Narr`), idea = $(`#${p}Prompt`).value.trim();
    if (p === "t2v" && !idea) { $("#t2vPrompt").focus(); return; }
    btn.disabled = true; const old = btn.textContent; btn.textContent = "Writing…";
    try {
      const j = await (await postJSON("/storyboard", { idea: idea || i2vSource?.prompt || "", mode: p, scenes: 1, seconds: +$(`#${p}Len`).value, narration: true })).json();
      box.value = j.narration || ""; box.dispatchEvent(new Event("input"));
      if ($(`#${p}Voice`).value === "none") $(`#${p}Voice`).value = "storyteller";
    } catch (e) { box.placeholder = "Couldn't write it right now: " + e.message; }
    finally { btn.disabled = false; btn.textContent = old; }
  }
  ["i2v", "t2v"].forEach(p => {
    $(`#${p}NarrAuto`).onclick = () => autoNarr(p);
    const upd = () => {
      const len = +$(`#${p}Len`).value, n = Math.round(len / CLIP), fit = Math.round((len - 1.2) * 2.2);
      const w = $(`#${p}Narr`).value.trim().split(/\s+/).filter(Boolean).length, el = $(`#${p}Words`);
      $(`#${p}Cost`).textContent = `Uses ${n} of your ${LIMITS.video} daily video clips`;
      el.textContent = w ? `${w} words · about ${fit} fit in ${len} s` : `About ${fit} words fit in ${len} s`;
      el.classList.toggle("over", w > fit + 2);
    };
    $(`#${p}Len`).onchange = upd; $(`#${p}Narr`).oninput = upd; upd();
    $(`#${p}NarrAuto`).addEventListener("click", () => setTimeout(upd, 50));
  });

  // ---------- Animated slideshow (browser fallback, NOT AI motion) ----------
  async function slideshowFlow(imgBlob, caption, aspect) {
    const pg = $("#createProgress");
    try {
      progress(pg, "Making an animated slideshow on your device…", 5);
      const blob = await slideshow(imgBlob, caption, aspect, p => progress(pg, "Making an animated slideshow on your device…", 5 + p * 95));
      progress(pg, "Slideshow ready", 100);
      const item = { id: "c" + Date.now(), kind: "video", prompt: caption || "Animated slideshow", blob, mime: blob.type, ai: false, label: "🎞 Animated slideshow (not AI motion)", created: Date.now() };
      await saveItem(item);
      showResult(item, { fallbackNote: "This is an animated slideshow made on your device: zoom, pan and a caption over your picture. AI motion video will be used again when the free AI video service is back." });
    } catch (e) { pg.hidden = true; showError("Couldn't make the slideshow: " + e.message); }
  }
  async function slideshow(imgBlob, caption, aspect = "16:9", onP) {
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) throw new Error("this browser can't record video");
    const url = URL.createObjectURL(imgBlob), img = await loadImg(url);
    const [W, H] = { "16:9": [1280, 720], "9:16": [720, 1280], "1:1": [960, 960] }[aspect] || [1280, 720];
    const c = Object.assign(document.createElement("canvas"), { width: W, height: H }), g = c.getContext("2d");
    const types = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    const mime = types.find(t => MediaRecorder.isTypeSupported(t)) || "";
    const rec = new MediaRecorder(c.captureStream(30), mime ? { mimeType: mime, videoBitsPerSecond: 4_000_000 } : {});
    const chunks = []; rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    const DUR = 7000, ease = t => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const base = Math.max(W / img.naturalWidth, H / img.naturalHeight);
    const words = String(caption || "").trim().split(/\s+/).filter(Boolean).slice(0, 18);
    function wrap(text, maxW) { const lines = []; let l = ""; for (const w of text.split(" ")) { const t = l ? l + " " + w : w; if (g.measureText(t).width > maxW && l) { lines.push(l); l = w; } else l = t; } if (l) lines.push(l); return lines.slice(0, 3); }
    function frame(t) {
      const k = t / DUR, e = ease(k);
      g.fillStyle = "#0B0920"; g.fillRect(0, 0, W, H);
      // Ken Burns: slow zoom in + diagonal pan
      const s = base * (1.04 + 0.16 * e), iw = img.naturalWidth * s, ih = img.naturalHeight * s;
      const x = (W - iw) / 2 + (iw - W) * 0.35 * (0.5 - e), y = (H - ih) / 2 + (ih - H) * 0.3 * (e - 0.5);
      g.globalAlpha = Math.min(1, t / 600) * Math.min(1, (DUR - t) / 500); // fade in / out
      g.drawImage(img, x, y, iw, ih);
      // caption
      if (words.length && t > 900) {
        const a = Math.min(1, (t - 900) / 500) * Math.min(1, (DUR - t) / 500);
        const fs = Math.round(Math.min(W, H) * 0.052); g.font = `800 ${fs}px "Plus Jakarta Sans", system-ui, sans-serif`;
        const lines = wrap(words.join(" "), W * 0.84), lh = fs * 1.3, bh = lines.length * lh + fs * 0.9;
        const by = H - bh - H * 0.06 + (1 - a) * 20;
        g.globalAlpha = a * 0.62; g.fillStyle = "#0B0920"; g.beginPath(); g.roundRect?.(W * 0.05, by, W * 0.9, bh, fs * 0.5); g.fill();
        g.globalAlpha = a; g.fillStyle = "#FFFFFF"; g.textAlign = "center"; g.textBaseline = "top";
        lines.forEach((ln, i) => g.fillText(ln, W / 2, by + fs * 0.45 + i * lh));
      }
      // small brand mark
      g.globalAlpha = 0.85; g.font = `700 ${Math.round(Math.min(W, H) * 0.03)}px system-ui, sans-serif`; g.textAlign = "right"; g.textBaseline = "top"; g.fillStyle = "#FFD15C";
      g.fillText("Nyansi", W - 18, 16); g.globalAlpha = 1;
    }
    frame(0);
    return new Promise((res, rej) => {
      rec.onstop = () => { URL.revokeObjectURL(url); res(new Blob(chunks, { type: (mime || "video/webm").split(";")[0] })); };
      rec.onerror = e => rej(e.error || new Error("recording failed"));
      rec.start(250);
      const t0 = performance.now();
      (function loop() {
        const t = performance.now() - t0;
        frame(Math.min(t, DUR)); onP?.(Math.min(1, t / DUR));
        if (t < DUR) requestAnimationFrame(loop); else setTimeout(() => rec.stop(), 120);
      })();
    });
  }

  // ---------- gallery UI ----------
  let urls = [];
  async function renderGallery() {
    const items = await allItems().catch(() => []);
    urls.forEach(u => URL.revokeObjectURL(u)); urls = [];
    const g = $("#createGallery"); g.innerHTML = "";
    $("#createGalleryWrap").hidden = !items.length;
    // recent images to pick for Image to Video
    const picks = $("#i2vPicks"); picks.innerHTML = "";
    items.filter(i => i.kind === "image").slice(0, 8).forEach(it => {
      const u = URL.createObjectURL(it.blob); urls.push(u);
      const b = document.createElement("button"); b.type = "button"; b.title = it.prompt;
      b.append(Object.assign(document.createElement("img"), { src: u, alt: it.prompt }));
      b.onclick = () => useForVideo(it.blob, it.prompt); picks.append(b);
    });
    $("#i2vPicksWrap").hidden = !picks.children.length;
    for (const it of items) {
      const u = URL.createObjectURL(it.blob); urls.push(u);
      const card = document.createElement("div"); card.className = "g-item";
      const m = it.kind === "image" ? Object.assign(document.createElement("img"), { src: u, alt: it.prompt, loading: "lazy" })
        : Object.assign(document.createElement("video"), { src: u, muted: true, playsInline: true, preload: "metadata" });
      if (it.kind === "video") { card.onmouseenter = () => m.play().catch(() => {}); card.onmouseleave = () => m.pause(); }
      const badge = document.createElement("span"); badge.className = "g-badge" + (it.ai ? "" : " alt");
      badge.textContent = it.kind === "image" ? "Image" : it.ai ? "AI video" : "Slideshow";
      const bar = document.createElement("div"); bar.className = "g-bar";
      const dl = Object.assign(document.createElement("button"), { textContent: "⬇", title: "Download" });
      dl.onclick = e => { e.stopPropagation(); downloadBlob(it.blob, `nyansi-${U.slug(it.prompt)}.${ext(it.mime)}`); };
      const del = Object.assign(document.createElement("button"), { textContent: "✕", title: "Delete" });
      del.onclick = e => { e.stopPropagation(); if (confirm("Delete this creation?")) delItem(it.id); };
      bar.append(dl, del);
      card.onclick = () => showResult(it);
      card.append(m, badge, bar); g.append(card);
    }
  }

  // ---------- tabs & wiring ----------
  function setTab(t) {
    tab = t;
    document.querySelectorAll(".cr-tabs button").forEach(b => b.classList.toggle("on", b.dataset.t === t));
    document.querySelectorAll(".cr-pane").forEach(p => p.hidden = p.dataset.t !== t);
  }
  document.querySelectorAll(".cr-tabs button").forEach(b => b.onclick = () => setTab(b.dataset.t));
  async function guard(fn, btn) {
    if (busy) return; busy = true; btn.disabled = true; $("#createResult").hidden = true;
    try { await fn(); } finally { busy = false; btn.disabled = false; }
  }
  $("#t2iGo").onclick = e => guard(runT2I, e.currentTarget);
  $("#i2vGo").onclick = e => guard(runI2V, e.currentTarget);
  $("#t2vGo").onclick = e => guard(runT2V, e.currentTarget);
  $("#i2vFile").onchange = e => { const f = e.target.files?.[0]; if (f) useForVideo(f, ""); };
  document.querySelectorAll("#view-create .chips button").forEach(b => b.onclick = () => {
    const t = b.closest(".cr-pane").dataset.t, box = t === "t2i" ? "#t2iPrompt" : t === "t2v" ? "#t2vPrompt" : "#i2vPrompt";
    $(box).value = b.dataset.p; $(box).focus();
  });
  ["#t2iPrompt", "#t2vPrompt", "#i2vPrompt"].forEach(s => $(s).addEventListener("keydown", e => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $(s.replace("Prompt", "Go")).click(); }
  }));
  document.addEventListener("nyansi:view", e => { if (e.detail === "create") { refreshLimits(); renderGallery(); } });
  window.NyansiCreate = { slideshow, setTab };
  setTab(new URLSearchParams(location.search).get("tab") || "t2i");
  if (document.body.dataset.view === "create") { refreshLimits(); renderGallery(); }
})();
