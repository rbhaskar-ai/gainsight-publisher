const LANGS = [
  { c: "en", l: "English",    f: "🇺🇸" },
  { c: "es", l: "Spanish",    f: "🇪🇸" },
  { c: "fr", l: "French",     f: "🇫🇷" },
  { c: "de", l: "German",     f: "🇩🇪" },
  { c: "pt", l: "Portuguese", f: "🇧🇷" },
  { c: "ja", l: "Japanese",   f: "🇯🇵" },
  { c: "ko", l: "Korean",     f: "🇰🇷" },
  { c: "zh", l: "Chinese",    f: "🇨🇳" },
];

const TX_NAMES = {
  es:"Spanish", fr:"French", de:"German", pt:"Portuguese (Brazilian)",
  ja:"Japanese", ko:"Korean", zh:"Simplified Chinese",
};

const CONNECTOR = "community-publisher";

export function init(sdk) {
  const props   = sdk.getProps();
  let baseUrl = (props.communityBaseUrl || "https://netskope-us-sandbox-community.insided.com").replace(/\/$/, "");

  // Gainsight SDK: use window.WidgetServiceSDK for connector calls (sdk param is widget context only)
  // Per docs: payload (not body) is the correct field name
  async function api(action, params) {
    const connSdk = (sdk.connectors) ? sdk : new window.WidgetServiceSDK();
    return connSdk.connectors.execute({
      permalink: CONNECTOR,
      method:    "POST",
      payload:   { action, ...params },
    });
  }

  let selectedLangs = new Set(["en"]);
  const el = (id) => sdk.$(`#${id}`);

  // ── word count ──
  el("body").addEventListener("input", updateWordCount);
  function updateWordCount() {
    const t = el("body").value;
    el("word-count").textContent =
      `${t.length.toLocaleString()} chars · ${t.split(/\s+/).filter(Boolean).length} words`;
  }

  // ── language chips ──
  function renderChips() {
    const wrap = el("lang-chips");
    wrap.innerHTML = LANGS.map(l =>
      `<div class="chip${selectedLangs.has(l.c) ? " on" : ""}" data-lang="${l.c}">${l.f} ${l.l}` +
      (l.c === "en" ? ' <span style="font-size:9px;opacity:.5">(source)</span>' : "") +
      `</div>`
    ).join("");
    wrap.querySelectorAll(".chip").forEach(chip => {
      chip.addEventListener("click", () => {
        const c = chip.dataset.lang;
        if (c === "en") return;
        selectedLangs.has(c) ? selectedLangs.delete(c) : selectedLangs.add(c);
        renderChips();
      });
    });
  }
  renderChips();

  // ── load categories ──
  async function loadCategories() {
    const sel = el("category-select");
    sel.innerHTML = `<option value="">Loading sections…</option>`;
    const existing = sdk.$(`#cat-manual-wrap`);
    if (existing) existing.remove();
    try {
      const data = await api("categories");
      const list = Array.isArray(data) ? data : (data.items || data.result || []);
      if (!list.length) throw new Error("Empty list");
      sel.innerHTML = `<option value="">— Select a section —</option>` +
        list.map(c => `<option value="${c.id}">${c.name || c.title || "Category " + c.id}</option>`).join("");
    } catch (e) {
      sel.innerHTML = `<option value="">Could not load — enter ID below</option>`;
      sel.insertAdjacentHTML("afterend",
        `<div id="cat-manual-wrap" style="margin-top:8px">
          <div style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px">Category ID</div>
          <input type="text" id="cat-manual" placeholder="e.g. 17  (find it in Control → Categories URL)" style="width:100%;padding:9px 12px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;font-family:inherit;color:#111827;background:#fff">
          <div style="font-size:11px;color:#9ca3af;margin-top:5px">Go to Control Panel → Categories → click any category → copy the ID from the URL</div>
        </div>`);
    }
  }
  loadCategories();
  el("reload-cats-btn").addEventListener("click", loadCategories);

  // ── AI generate ──
  el("ai-btn").addEventListener("click", async () => {
    const prompt = el("ai-prompt").value.trim();
    if (!prompt) return;
    const btn = el("ai-btn");
    btn.disabled = true; btn.textContent = "✦ Generating…";
    el("ai-err").style.display = "none";
    try {
      const data = await api("generate", { prompt });
      if (data.error) throw new Error(data.error);
      el("title").value = data.title || "";
      el("body").value  = data.body  || "";
      updateWordCount();
    } catch (e) {
      const b = el("ai-err"); b.textContent = "AI error: " + e.message; b.style.display = "block";
    } finally {
      btn.disabled = false; btn.textContent = "✦ Generate";
    }
  });

  // ── publish ──
  el("publish-btn").addEventListener("click", async () => {
    const title   = el("title").value.trim();
    const body    = el("body").value.trim();
    const isDraft = el("draft-toggle").checked;
    const catSel  = el("category-select");
    const catMan  = sdk.$(`#cat-manual`);
    const catId   = (catSel?.value && catSel.value !== "") ? catSel.value : (catMan?.value?.trim() || "");

    hideError(); hideOk();
    if (!title || !body) { showError("Add a title and body first."); return; }
    if (!catId)          { showError("Select a community section."); return; }

    const btn = el("publish-btn");
    btn.disabled = true; btn.textContent = "Publishing…";

    const langs = Array.from(selectedLangs);
    const jobs  = langs.map(c => { const l = LANGS.find(x => x.c === c); return { c, l:l.l, f:l.f, status:"pending", link:null, err:null }; });
    renderProgress(jobs, isDraft);

    for (let i = 0; i < jobs.length; i++) {
      jobs[i].status = "working"; renderProgress(jobs, isDraft);
      try {
        let txTitle = title, txBody = body;

        // translate non-English
        if (jobs[i].c !== "en") {
          const tx = await api("translate", { targetLang: TX_NAMES[jobs[i].c], title, body });
          if (tx.error) throw new Error(tx.error);
          txTitle = tx.title; txBody = tx.body;
        }

        // create (+ publish if not draft)
        const result = await api("articles", {
          title:              txTitle,
          content:            txBody,
          categoryId:         parseInt(catId),
          publishAfterCreate: !isDraft,
        });
        if (result.error) throw new Error(result.error);
        if (!result.id)   throw new Error("No article ID returned");

        if (result.seoCommunityUrl) jobs[i].link = baseUrl + result.seoCommunityUrl;
        jobs[i].status = "done";
      } catch (e) {
        jobs[i].status = "error"; jobs[i].err = e.message;
      }
      renderProgress(jobs, isDraft);
    }

    const doneCount = jobs.filter(j => j.status === "done").length;
    if (doneCount > 0) {
      showOk(
        `${isDraft ? "📝 Saved as draft" : "🎉 Published"}: "${title}" in ` +
        `${doneCount} language${doneCount > 1 ? "s" : ""}.` +
        (isDraft ? " Go to Control → Content → Articles to publish." : "")
      );
      el("reset-btn").style.display = "inline-flex";
    }
    btn.disabled = false; btn.textContent = "🚀 Publish";
  });

  // ── reset ──
  el("reset-btn").addEventListener("click", () => {
    el("title").value = ""; el("body").value = ""; el("ai-prompt").value = "";
    selectedLangs = new Set(["en"]); renderChips(); updateWordCount();
    hideOk(); hideError();
    el("progress").style.display  = "none";
    el("reset-btn").style.display = "none";
  });

  // ── helpers ──
  function renderProgress(jobs, isDraft) {
    el("progress").style.display = "block";
    el("progress-rows").innerHTML = jobs.map(j => {
      const color = j.status==="done"?"#16a34a":j.status==="working"?"#d97706":j.status==="error"?"#dc2626":"#d1d0c8";
      const anim  = j.status === "working" ? "animation:pulse 1s infinite;" : "";
      const msg   = j.status==="pending"?"Waiting…"
                  : j.status==="working"?`→ ${isDraft?"saving draft…":"publishing…"}`
                  : j.status==="done"?(isDraft?"✓ Saved as draft":"✓ Published")
                  : j.err;
      const link = j.link
        ? `<a href="${j.link}" target="_blank" style="margin-left:auto;color:#6366f1;font-size:11px">View →</a>` : "";
      return `<div class="prow">
        <div class="dot" style="background:${color};${anim}"></div>
        <span style="min-width:90px">${j.f} ${j.l}</span>
        <span style="color:#6b6b67;flex:1">${msg}</span>${link}
      </div>`;
    }).join("");
  }

  function showError(msg) { const b = el("error-box"); b.textContent = msg; b.style.display = "block"; }
  function hideError()    { el("error-box").style.display = "none"; }
  function showOk(msg)    { const b = el("ok-box");    b.textContent = msg; b.style.display = "block"; }
  function hideOk()       { el("ok-box").style.display  = "none"; }

  sdk.on("propsChanged", () => {
    const p = sdk.getProps();
    baseUrl = (p.communityBaseUrl || "https://netskope-us-sandbox-community.insided.com").replace(/\/$/, "");
  });
}
