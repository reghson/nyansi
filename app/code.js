// Nyansi Code (coding mode)
(() => {
  const $ = s => document.querySelector(s);
  const U = window.NyansiUtil, Q = window.NyansiUsage, P = window.NYANSI_PROMPTS;
  const KEY = "nyansi.code.v1";
  const CM = "https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/";
  const EXT = { html: "html", javascript: "js", css: "css", python: "py" };
  const NAMES = { html: "HTML page", javascript: "JavaScript", css: "CSS", python: "Python" };
  const CM_MODE = { html: "htmlmixed", javascript: "javascript", css: "css", python: "python" };
  const STARTER = `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;background:#0B0920;color:#F4F1FF}
  button{padding:12px 22px;border:0;border-radius:999px;background:linear-gradient(135deg,#FFD15C,#F59E0B,#F0567A);font-weight:700;font-size:1rem}
</style>
</head>
<body>
  <div style="text-align:center">
    <h1>Hello from Nyansi Code 👋</h1>
    <p>Clicks: <b id="n">0</b></p>
    <button onclick="n.textContent=+n.textContent+1">Tap me</button>
  </div>
</body>
</html>`;

  // ----- editor: CodeMirror (from CDN) if available, otherwise the plain textarea -----
  const saved = JSON.parse(localStorage.getItem(KEY) || "null") || { code: STARTER, lang: "html" };
  const area = $("#codeArea"); area.value = saved.code; $("#codeLang").value = saved.lang;
  let cm = null;
  const get = () => cm ? cm.getValue() : area.value;
  const persist = () => localStorage.setItem(KEY, JSON.stringify({ code: get(), lang: $("#codeLang").value }));
  const set = v => { if (cm) cm.setValue(v); else area.value = v; persist(); };
  let timer = null;
  const changed = () => { persist(); clearTimeout(timer); timer = setTimeout(runPreview, 900); };
  function initEditor() {
    if (cm || !window.CodeMirror) return;
    cm = window.CodeMirror.fromTextArea(area, {
      mode: CM_MODE[$("#codeLang").value], lineNumbers: true, lineWrapping: true, tabSize: 2, indentUnit: 2,
      autoCloseTags: true, autoCloseBrackets: true, theme: "nyansi", viewportMargin: 50
    });
    cm.setSize("100%", "100%");
    cm.on("change", changed);
  }
  area.addEventListener("input", changed);

  // ----- live preview in a sandboxed iframe (scripts allowed, no access to the app) -----
  const frame = $("#preview"), con = $("#codeConsole");
  const CAPTURE = "<script>(function(){var send=function(k,a){try{parent.postMessage({nyansiPreview:1,kind:k,text:[].map.call(a,function(x){try{return typeof x==='object'?JSON.stringify(x):String(x)}catch(e){return String(x)}}).join(' ')},'*')}catch(e){}};" +
    "['log','info','warn','error'].forEach(function(k){var o=console[k];console[k]=function(){send(k,arguments);o.apply(console,arguments)}});" +
    "window.onerror=function(m,s,l){send('error',[m+(l?' (line '+l+')':'')])}})();<\/script>";
  function buildDoc(code, lang) {
    const head = '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' + CAPTURE;
    if (lang === "html") return /<head[^>]*>/i.test(code) ? code.replace(/<head[^>]*>/i, m => m + head) : head + code;
    if (lang === "javascript") return "<!doctype html><html><head>" + head + "<style>body{font-family:system-ui;padding:12px}</style></head><body><div id=\"app\"></div><script>\n" + code.replace(/<\/script/gi, "<\\/script") + "\n<\/script></body></html>";
    if (lang === "css") return "<!doctype html><html><head>" + head + "<style>\n" + code + "\n</style></head><body><h1>Heading</h1><p>A paragraph with <a href=\"#\">a link</a>.</p><button>Button</button><div class=\"box card container\">Box</div></body></html>";
    return "<!doctype html><html><body style=\"font-family:system-ui;padding:16px;color:#555\"><p>Live preview works for HTML, CSS and JavaScript.</p><p>Copy or download this " + NAMES[lang] + " code to run it on your computer or in an online runner.</p></body></html>";
  }
  function runPreview() {
    con.textContent = ""; con.hidden = true;
    frame.srcdoc = buildDoc(get(), $("#codeLang").value);
  }
  window.addEventListener("message", e => {
    if (e.source !== frame.contentWindow || !e.data || !e.data.nyansiPreview) return;
    con.hidden = false;
    const line = document.createElement("div"); line.className = "c-" + e.data.kind;
    line.textContent = (e.data.kind === "error" ? "✖ " : "› ") + String(e.data.text).slice(0, 500);
    con.append(line); con.scrollTop = 1e9;
  });

  // ----- tabs (phones show one pane at a time) -----
  const grid = $(".code-grid");
  function tab(t) {
    grid.dataset.show = t;
    document.querySelectorAll(".code-tabs button").forEach(b => b.classList.toggle("on", b.dataset.t === t));
    if (t === "notes") $("#notesDot").hidden = true;
    if (t === "edit" && cm) setTimeout(() => cm.refresh(), 0);
  }
  document.querySelectorAll(".code-tabs button").forEach(b => b.onclick = () => tab(b.dataset.t));
  const isPhone = () => matchMedia("(max-width: 800px)").matches;

  // ----- AI actions: build, fix, explain -----
  const notes = $("#codeNotes");
  const setNotes = (md, err) => { notes.innerHTML = window.renderMarkdown(md); notes.classList.toggle("err", !!err); if (isPhone() && grid.dataset.show !== "notes") $("#notesDot").hidden = false; };
  function splitReply(text) {
    const blocks = [...text.matchAll(/```[\w+#-]*[^\n]*\n([\s\S]*?)```/g)];
    const open = !blocks.length && text.match(/```[^\n]*\n([\s\S]*)$/);
    if (open) return { code: open[1].trim(), rest: "(The answer was cut short. Ask again if the code looks incomplete.)" };
    if (!blocks.length) return /^\s*(<!doctype|<html|<)/i.test(text) ? { code: text.trim(), rest: "" } : { code: "", rest: text };
    const best = blocks.reduce((a, b) => b[1].length > a[1].length ? b : a);
    return { code: best[1].replace(/\n$/, ""), rest: text.replace(best[0], "").trim() };
  }
  let busy = false;
  const quota = () => { $("#codeQuota").textContent = Q.label("code").replace("Free plan: ", ""); };
  function setBusy(b, act) {
    busy = b;
    document.querySelectorAll(".code-actions button").forEach(x => { x.disabled = b; x.classList.toggle("spin", b && x.dataset.act === act); });
  }
  async function act(kind) {
    if (busy) return;
    const ask = $("#codeAsk").value.trim(), lang = $("#codeLang").value, code = get().trim();
    if (kind === "build" && !ask) { setNotes("✏️ Type what you want to build in the box at the top first.", true); if (isPhone()) tab("notes"); return; }
    if (kind !== "build" && !code) { setNotes("✏️ Paste or write some code in the editor first.", true); if (isPhone()) tab("notes"); return; }
    if (Q.left("code") <= 0) { setNotes("⚠️ " + Q.blockedMsg, true); if (isPhone()) tab("notes"); return; }
    const fence = "```" + EXT[lang] + "\n" + code + "\n```";
    const useCurrent = code && code !== STARTER.trim();
    let msg = "Language: " + NAMES[lang] + "\n";
    if (kind === "build") msg += "Request: " + ask + (useCurrent ? "\n\nCurrent code:\n" + fence : "");
    else if (kind === "fix") msg += (ask ? "Problem: " + ask + "\n\n" : "") + "Code:\n" + fence;
    else msg += (ask ? "Question: " + ask + "\n\n" : "") + "Code:\n" + fence;
    const sys = kind === "build" ? P.codeBuild : kind === "fix" ? P.codeFix : P.codeExplain;
    Q.use("code"); quota(); setBusy(true, kind);
    notes.classList.remove("err");
    notes.innerHTML = '<p class="hint"><span class="dots"><i></i><i></i><i></i></span> Nyansi is ' + (kind === "build" ? "writing your code" : kind === "fix" ? "fixing your code" : "reading your code") + "…</p>";
    try {
      const reply = await window.NyansiAI.askText(msg, sys);
      if (kind === "explain") { setNotes(reply); if (isPhone()) tab("notes"); }
      else {
        const parts = splitReply(reply);
        if (parts.code) { set(parts.code); runPreview(); }
        setNotes(parts.rest || (parts.code ? "✅ Done. Your code is in the editor and the preview is updated." : reply));
        if (isPhone()) tab(parts.code && lang !== "python" ? "preview" : "notes");
      }
    } catch (e) {
      setNotes("⚠️ " + (e.message || "Network problem. Please try again."), true);
    }
    setBusy(false);
  }

  // ----- buttons -----
  document.querySelectorAll(".code-actions button").forEach(b => b.onclick = () => act(b.dataset.act));
  $("#codeAsk").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)) { e.preventDefault(); act("build"); } });
  $("#codeRun").onclick = () => { runPreview(); if (isPhone()) tab("preview"); };
  $("#codeReload").onclick = runPreview;
  $("#codeCopy").onclick = e => U.copy(get(), e.currentTarget);
  $("#codeDl").onclick = () => U.download("nyansi-code." + EXT[$("#codeLang").value], get(), $("#codeLang").value === "html" ? "text/html" : "text/plain");
  $("#codeClear").onclick = () => { if (confirm("Clear the editor?")) { set(""); runPreview(); } };
  $("#codeLang").onchange = () => { if (cm) cm.setOption("mode", CM_MODE[$("#codeLang").value]); persist(); runPreview(); };
  $("#codeNotes").addEventListener("click", e => { if (e.target.classList.contains("copy")) U.copy(e.target.closest(".code").querySelector("code").innerText, e.target); });

  let started = false;
  function onShow() {
    quota();
    if (!started) { started = true; initEditor(); runPreview(); }
    if (cm) setTimeout(() => cm.refresh(), 0);
  }
  document.addEventListener("nyansi:view", e => { if (e.detail === "code") onShow(); });
  if (document.body.dataset.view === "code") onShow();
})();
