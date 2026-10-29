// Nyansi Bot (agent mode)
(() => {
  const $ = s => document.querySelector(s);
  const U = window.NyansiUtil, Q = window.NyansiUsage, P = window.NYANSI_PROMPTS;
  const KEY = "nyansi.bot.v1";
  const MAX_STEPS = 6;
  let runs = JSON.parse(localStorage.getItem(KEY) || "[]");
  let run = null, stopping = false, busy = false;
  const save = () => localStorage.setItem(KEY, JSON.stringify(runs.slice(0, 12)));
  const clip = (s, n) => s.length > n ? s.slice(0, n) + "…" : s;

  function parsePlan(text) {
    let steps = [];
    const m = text.match(/\[[\s\S]*\]/);
    if (m) { try { steps = JSON.parse(m[0]).map(x => typeof x === "string" ? x : (x.title || x.step || JSON.stringify(x))); } catch { } }
    if (!steps.length) steps = text.split("\n").map(l => l.replace(/^\s*(\d+[.)]|[-*•])\s*/, "").replace(/\*\*/g, "").trim()).filter(l => l && l.length < 140);
    steps = steps.map(s => String(s).trim()).filter(Boolean).slice(0, MAX_STEPS);
    if (steps.length < 2) steps = ["Understand the task and gather key facts", "Draft the main content", "Review and polish the final result"];
    return steps;
  }

  // ----- rendering -----
  function quota() { $("#botQuota").textContent = Q.label("bot"); }
  function renderRecent() {
    $("#botRecentWrap").hidden = !runs.length;
    const ul = $("#botRecent"); ul.innerHTML = "";
    runs.forEach(r => {
      const li = document.createElement("li");
      li.textContent = (r.final ? "✅ " : "⏸ ") + r.task;
      li.onclick = () => { if (busy) return; run = r; render(); $("#botRun").scrollIntoView({ behavior: "smooth" }); };
      ul.append(li);
    });
  }
  function render() {
    if (!run) { $("#botRun").hidden = true; return; }
    $("#botRun").hidden = false;
    $("#botRunTitle").textContent = run.steps.length ? `Steps for: ${clip(run.task, 70)}` : "Planning…";
    const ol = $("#botSteps"); ol.innerHTML = "";
    if (!run.steps.length && !run.error) { ol.innerHTML = '<li class="st working"><span class="ck"></span><div class="st-b"><b>Breaking your task into steps…</b></div></li>'; }
    run.steps.forEach((s, i) => {
      const li = document.createElement("li"); li.className = "st " + s.status;
      const ck = document.createElement("span"); ck.className = "ck"; ck.textContent = s.status === "done" ? "✓" : s.status === "error" ? "!" : "";
      const b = document.createElement("div"); b.className = "st-b";
      const t = document.createElement("b"); t.textContent = `${i + 1}. ${s.title}`; b.append(t);
      if (s.status === "working") { const w = document.createElement("small"); w.textContent = "Working on this…"; b.append(w); }
      if (s.output) {
        const d = document.createElement("details"); const sm = document.createElement("summary"); sm.textContent = "See what Nyansi did";
        const c = document.createElement("div"); c.className = "bubble md"; c.innerHTML = window.renderMarkdown(s.output);
        d.append(sm, c); b.append(d);
      }
      li.append(ck, b); ol.append(li);
    });
    const done = run.steps.filter(s => s.status === "done").length;
    $("#botStatus").textContent = run.final ? "Done" : run.error ? "Stopped" : run.steps.length ? `${done}/${run.steps.length} steps` : "";
    $("#botResult").hidden = !run.final;
    if (run.final) $("#botFinal").innerHTML = window.renderMarkdown(run.final);
    if (run.error) {
      const li = document.createElement("li"); li.className = "st error";
      li.innerHTML = '<span class="ck">!</span><div class="st-b"><b></b></div>'; li.querySelector("b").textContent = run.error;
      ol.append(li);
    }
  }
  function setBusy(b) {
    busy = b; $("#botGo").disabled = b; $("#botStop").hidden = !b; $("#botStop").textContent = "■ Stop";
    $("#botGo").textContent = b ? "Working…" : "Start task →";
  }

  // ----- the step-by-step loop -----
  async function start(task) {
    task = task.trim(); if (!task || busy) return;
    if (Q.left("bot") <= 0) { run = { task, steps: [], error: Q.blockedMsg }; render(); return; }
    Q.use("bot"); quota();
    run = { id: Date.now().toString(36), task, steps: [], final: "", created: Date.now() };
    runs.unshift(run); save(); renderRecent();
    stopping = false; setBusy(true); render();
    $("#botRun").scrollIntoView({ behavior: "smooth", block: "start" });
    try {
      const plan = await window.NyansiAI.askText("Task: " + task, P.botPlan);
      run.steps = parsePlan(plan).map(title => ({ title, status: "todo", output: "" }));
      save(); render();
      for (let i = 0; i < run.steps.length; i++) {
        if (stopping) throw new Error("You stopped the task. The steps finished so far are kept above.");
        const s = run.steps[i]; s.status = "working"; render();
        const earlier = run.steps.slice(0, i).map((p, j) => `### Step ${j + 1}: ${p.title}\n${clip(p.output, 1400)}`).join("\n\n");
        const msg = `Overall task: ${task}\n\nPlan:\n${run.steps.map((p, j) => `${j + 1}. ${p.title}`).join("\n")}\n\n` +
          (earlier ? `Results so far:\n${earlier}\n\n` : "") + `Now do step ${i + 1}: ${s.title}`;
        s.output = await window.NyansiAI.askText(msg, P.botStep);
        s.status = "done"; save(); render();
        await U.wait(1200);
      }
      if (stopping) throw new Error("You stopped the task before the final result.");
      const all = run.steps.map((p, j) => `### ${j + 1}. ${p.title}\n${clip(p.output, 1800)}`).join("\n\n");
      const finalMsg = "Task: " + task + "\n\nNotes:\n" + all;
      run.final = await window.NyansiAI.askText(finalMsg, P.botFinal);
    } catch (e) {
      run.steps.forEach(s => { if (s.status === "working") s.status = "error"; });
      run.error = "⚠️ " + (e.message || "Something went wrong. Please try again.");
    }
    save(); setBusy(false); render(); renderRecent();
    if (run.final) $("#botResult").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ----- events -----
  const ta = $("#botTask");
  $("#botForm").addEventListener("submit", e => { e.preventDefault(); start(ta.value); });
  ta.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)) { e.preventDefault(); start(ta.value); } });
  $("#botStop").onclick = () => { stopping = true; $("#botStop").textContent = "Stopping…"; };
  document.querySelectorAll("#botChips button").forEach(b => b.onclick = () => { ta.value = b.dataset.p; start(b.dataset.p); });
  const fileText = () => "# " + run.task + "\n\n" + run.final + "\n\n---\nMade with Nyansi Bot · https://reghson.github.io/nyansi/\n";
  $("#botCopy").onclick = e => U.copy(run.final, e.currentTarget);
  $("#botMd").onclick = () => U.download("nyansi-" + U.slug(run.task) + ".md", fileText(), "text/markdown");
  $("#botTxt").onclick = () => U.download("nyansi-" + U.slug(run.task) + ".txt", fileText());
  $("#botFinal").addEventListener("click", e => { if (e.target.classList.contains("copy")) U.copy(e.target.closest(".code").querySelector("code").innerText, e.target); });

  quota(); renderRecent();
  document.addEventListener("nyansi:view", e => { if (e.detail === "bot") quota(); });
})();
