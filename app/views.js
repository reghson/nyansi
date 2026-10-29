/* Nyansi: switch between Chat, Bot and Code, plus shared helpers. */
(() => {
  const $ = s => document.querySelector(s);
  const CFG = window.NYANSI_CONFIG;
  const TITLES = { bot: "Nyansi Bot", code: "Nyansi Code" };
  let chatTitle = "";

  // ----- free-plan daily usage (counted on this device) -----
  const dayKey = () => "nyansi.usage." + new Date().toISOString().slice(0, 10);
  const usage = () => JSON.parse(localStorage.getItem(dayKey()) || "{}");
  window.NyansiUsage = {
    limit: tool => (CFG.freeLimits || {})[tool] || 0,
    left(tool) { return Math.max(0, this.limit(tool) - (usage()[tool] || 0)); },
    use(tool) { const u = usage(); u[tool] = (u[tool] || 0) + 1; localStorage.setItem(dayKey(), JSON.stringify(u)); },
    label(tool) { const l = this.left(tool), n = this.limit(tool); return `Free plan: ${l} of ${n} ${tool === "bot" ? "tasks" : "runs"} left today`; },
    blockedMsg: "You've used today's free limit. It resets tomorrow. Pro and Max plans with higher limits are coming soon."
  };

  // ----- shared helpers -----
  window.NyansiUtil = {
    download(name, text, type = "text/plain") {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: type + ";charset=utf-8" }));
      a.download = name; document.body.append(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    },
    async copy(text, btn) {
      try { await navigator.clipboard.writeText(text); }
      catch { const t = document.createElement("textarea"); t.value = text; document.body.append(t); t.select(); document.execCommand("copy"); t.remove(); }
      if (btn) { const o = btn.textContent; btn.textContent = "Copied ✓"; setTimeout(() => btn.textContent = o, 1500); }
    },
    slug: s => (s || "nyansi").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "nyansi",
    wait: ms => new Promise(r => setTimeout(r, ms))
  };

  // ----- view switching -----
  function show(v) {
    if (!["chat", "bot", "code"].includes(v)) v = "chat";
    document.querySelectorAll(".view").forEach(el => el.hidden = el.id !== "view-" + v);
    document.querySelectorAll(".views button").forEach(b => b.classList.toggle("on", b.dataset.v === v));
    document.querySelectorAll(".tool-link").forEach(b => b.classList.toggle("on", b.dataset.v === v));
    document.body.dataset.view = v;
    const t = $("#chatTitle");
    if (v === "chat") { if (chatTitle) t.textContent = chatTitle; }
    else { if (!TITLES[t.textContent]) chatTitle = t.textContent; t.textContent = TITLES[v]; }
    $("#mode").hidden = v !== "chat";
    const url = new URL(location.href);
    if (v === "chat") url.searchParams.delete("view"); else url.searchParams.set("view", v);
    history.replaceState(null, "", url);
    document.dispatchEvent(new CustomEvent("nyansi:view", { detail: v }));
  }
  window.NyansiShow = show;
  document.querySelectorAll(".views button, .tool-link").forEach(b => b.addEventListener("click", () => {
    show(b.dataset.v); $("#side").classList.remove("open"); $("#scrim").classList.remove("show");
  }));
  // Opening a chat or starting a new one brings you back to Chat.
  $("#newChat").addEventListener("click", () => show("chat"));
  $("#convList").addEventListener("click", () => show("chat"));

  const start = new URLSearchParams(location.search).get("view");
  show(new URLSearchParams(location.search).get("q") ? "chat" : start || "chat");
})();
