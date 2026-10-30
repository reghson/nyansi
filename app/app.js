(() => {
  const CFG = window.NYANSI_CONFIG;
  const $ = s => document.querySelector(s);
  const KEY = "nyansi.convs.v1";
  const SYSTEM = {
    chat: "You are Nyansi, a friendly, wise AI assistant made in Ghana. Give clear, accurate, well-structured answers in simple language. Use markdown (headings, lists, bold, code blocks) when helpful. Keep answers concise unless asked for detail.",
    write: "You are Nyansi, an expert writing assistant. Help write and polish captions, emails, essays, CVs, scripts and posts. Be clear, engaging and match the requested tone. Use markdown.",
    code: "You are Nyansi, an expert programming assistant. Explain step by step, give complete working code in fenced code blocks with the language name, and keep explanations short.",
    story: "You are Nyansi, a creative director for viral short-form video (YouTube Shorts, TikTok, Reels). Give punchy hooks, scene-by-scene scripts, dynamic dialogue, captions and hashtags. Use markdown."
  };

  let convs = JSON.parse(localStorage.getItem(KEY) || "[]");
  let current = null, busy = false;
  const save = () => localStorage.setItem(KEY, JSON.stringify(convs.slice(0, 60)));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  // ---------- AI providers (configure in config.js) ----------
  // 1) Nyansi backend (Cloudflare Worker + Gemini, key kept on the server).
  // 2) Automatic fallback: free Pollinations.AI. Both speak the OpenAI chat format.
  const sleep = ms => new Promise(res => setTimeout(res, ms));
  const backendReady = () => CFG.provider === "backend" && CFG.chatEndpoint && !CFG.chatEndpoint.includes("<");

  async function askBackend(msgs) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), CFG.backendTimeoutMs || 25000);
    try {
      const r = await fetch(CFG.chatEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: msgs }), signal: ctl.signal });
      if (!r.ok) throw new Error("backend " + r.status);
      const text = (await r.json())?.choices?.[0]?.message?.content;
      if (!text || !text.trim()) throw new Error("backend empty");
      return text.trim();
    } finally { clearTimeout(timer); }
  }

  async function askPollinations(msgs) {
    const body = { model: CFG.fallbackModel || CFG.model || "openai", messages: msgs, referrer: CFG.referrer, private: true };
    const endpoint = CFG.fallbackEndpoint || CFG.chatEndpoint;
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (r.status === 429) { lastErr = new Error("Busy right now — too many requests. Wait a few seconds and try again."); await sleep(4000 * (attempt + 1)); continue; }
        if (!r.ok) throw new Error("The AI service returned an error (" + r.status + ").");
        const data = await r.json();
        const text = data?.choices?.[0]?.message?.content;
        if (!text) throw new Error("The AI sent an empty answer. Please try again.");
        return text.trim();
      } catch (e) { lastErr = e; await sleep(1500); }
    }
    throw lastErr;
  }

  async function askAI(messages, mode, system) {
    const msgs = [{ role: "system", content: system || SYSTEM[mode] || SYSTEM.chat }, ...messages.slice(-CFG.maxHistory)];
    if (backendReady()) {
      try { return await askBackend(msgs); }
      catch (e) { console.warn("Nyansi backend failed, using free fallback:", e.message || e); }
    }
    return askPollinations(msgs);
  }
  // Shared with Nyansi Bot and Nyansi Code (bot.js / code.js).
  window.NyansiAI = { ask: (messages, system) => askAI(messages, null, system), askText: (text, system) => askAI([{ role: "user", content: text }], null, system) };
  function imageURL(prompt) {
    const seed = Math.floor(Math.random() * 1e6);
    return CFG.imageEndpoint + encodeURIComponent(prompt) + `?width=1024&height=1024&nologo=true&seed=${seed}&referrer=${CFG.referrer}`;
  }

  // ---------- UI ----------
  function renderList() {
    const ul = $("#convList"); ul.innerHTML = "";
    convs.forEach(c => {
      const li = document.createElement("li");
      li.className = c.id === current?.id ? "active" : "";
      const t = document.createElement("span"); t.textContent = c.title || "New chat";
      const del = document.createElement("button"); del.className = "del"; del.textContent = "🗑"; del.title = "Delete chat";
      del.onclick = e => { e.stopPropagation(); if (!confirm("Delete this chat?")) return; convs = convs.filter(x => x.id !== c.id); save(); if (current?.id === c.id) newChat(); else renderList(); };
      li.append(t, del); li.onclick = () => { open(c.id); closeSide(); };
      ul.append(li);
    });
  }
  function bubble(m) {
    const row = document.createElement("div"); row.className = "row " + (m.role === "user" ? "user" : "ai");
    const av = document.createElement("div"); av.className = "av";
    if (m.role === "user") av.textContent = "You"; else { const i = document.createElement("img"); i.src = "../icons/logo.svg"; av.append(i); }
    const b = document.createElement("div"); b.className = "bubble";
    if (m.role === "user") b.textContent = m.content;
    else if (m.image) {
      b.innerHTML = `<p>${m.content ? window.renderMarkdown(m.content) : ""}</p>`;
      const img = document.createElement("img"); img.className = "gen"; img.alt = m.prompt; img.src = m.image; img.loading = "lazy";
      img.onerror = () => { img.replaceWith(Object.assign(document.createElement("p"), { textContent: "Image couldn't load. Try again." })); };
      const a = document.createElement("a"); a.href = m.image; a.target = "_blank"; a.rel = "noopener"; a.append(img); b.append(a);
    } else b.innerHTML = window.renderMarkdown(m.content);
    if (m.error) b.classList.add("err");
    row.append(av, b); return row;
  }
  function renderThread() {
    const th = $("#thread"); th.innerHTML = "";
    const msgs = current?.messages || [];
    $("#empty").style.display = msgs.length ? "none" : "";
    msgs.forEach(m => th.append(bubble(m)));
    $("#chatTitle").textContent = current?.title || "New chat";
    th.scrollTop = th.scrollHeight;
  }
  function open(id) { current = convs.find(c => c.id === id); renderList(); renderThread(); }
  function newChat() { current = null; renderList(); renderThread(); $("#input").focus(); }

  async function send(text) {
    text = text.trim(); if (!text || busy) return;
    const mode = $("#mode").value;
    if (!current) { current = { id: uid(), title: text.slice(0, 48), messages: [], created: Date.now() }; convs.unshift(current); }
    current.messages.push({ role: "user", content: text }); save(); renderList(); renderThread();
    $("#input").value = ""; autosize();
    busy = true; $("#send").disabled = true;
    const typing = document.createElement("div"); typing.className = "row ai"; typing.innerHTML = '<div class="av"><img src="../icons/logo.svg"></div><div class="bubble"><span class="dots"><i></i><i></i><i></i></span></div>';
    $("#thread").append(typing); $("#thread").scrollTop = 1e9;
    try {
      if (mode === "image" || /^\/(image|img|draw)\s+/i.test(text)) {
        const prompt = text.replace(/^\/(image|img|draw)\s+/i, "");
        const url = imageURL(prompt);
        await new Promise(res => { const i = new Image(); i.onload = i.onerror = res; i.src = url; setTimeout(res, 45000); });
        current.messages.push({ role: "assistant", content: "Here's your image:", image: url, prompt });
      } else {
        const history = current.messages.filter(m => !m.error && !m.image).map(m => ({ role: m.role, content: m.content }));
        const answer = await askAI(history, mode);
        current.messages.push({ role: "assistant", content: answer });
      }
    } catch (e) {
      current.messages.push({ role: "assistant", content: "⚠️ " + (e.message || "Network problem. Check your connection and try again."), error: true });
    }
    current.updated = Date.now(); save(); busy = false; $("#send").disabled = false; renderThread();
  }

  // ---------- events ----------
  const input = $("#input");
  function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 180) + "px"; }
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)) { e.preventDefault(); send(input.value); } });
  $("#composer").addEventListener("submit", e => { e.preventDefault(); send(input.value); });
  $("#newChat").onclick = () => { newChat(); closeSide(); };
  document.querySelectorAll(".chips button").forEach(b => b.onclick = () => { if (b.dataset.m) $("#mode").value = b.dataset.m; send(b.dataset.p); });
  $("#mode").onchange = () => { input.placeholder = $("#mode").value === "image" ? "Describe the image you want…" : "Message Nyansi…"; };
  $("#thread").addEventListener("click", e => { if (e.target.classList.contains("copy")) { navigator.clipboard?.writeText(e.target.closest(".code").querySelector("code").innerText); e.target.textContent = "Copied"; setTimeout(() => e.target.textContent = "Copy", 1500); } });
  const side = $("#side"), scrim = $("#scrim");
  function closeSide() { side.classList.remove("open"); scrim.classList.remove("show"); }
  $("#openSide").onclick = () => { side.classList.add("open"); scrim.classList.add("show"); };
  $("#closeSide").onclick = closeSide; scrim.onclick = closeSide;

  // theme
  const applyTheme = t => { document.documentElement.dataset.theme = t; $("#themeBtn").textContent = t === "dark" ? "☀️ Light mode" : "🌙 Dark mode"; document.querySelector('meta[name=theme-color]').content = t === "dark" ? "#0B0920" : "#ffffff"; };
  applyTheme(localStorage.getItem("nyansi.theme") || "dark");
  $("#themeBtn").onclick = () => { const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; localStorage.setItem("nyansi.theme", t); applyTheme(t); };

  // install (PWA)
  let deferred; window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferred = e; $("#installBtn").hidden = false; });
  $("#installBtn").onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $("#installBtn").hidden = true; };
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("../sw.js", { scope: "../" });

  const q = new URLSearchParams(location.search).get("q");
  if (convs.length) open(convs[0].id); else newChat();
  if (q) { newChat(); send(q); }
})();
