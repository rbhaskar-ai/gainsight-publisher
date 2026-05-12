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

const TX_CODES = {
  es: "es", fr: "fr", de: "de", pt: "pt-BR",
  ja: "ja", ko: "ko", zh: "zh-CN",
};

// Connector permalinks — must match exactly what Gainsight generates when you save each connector
const CONN = {
  categories:    "insided-get-categories",
  createArticle: "insided-create-article",
  publishArticle:"insided-publish-article",
  getArticle:    "insided-get-article",
  ai:            "anthropic-ai",
};

export function init(sdk) {
  /* ── config from widget settings in No-Code Builder ── */
  const props    = sdk.getProps();
  const authorId = props.authorId            || "";
  const baseUrl  = (props.communityBaseUrl   || "https://netskope-us-sandbox-community.insided.com").replace(/\/$/, "");

  /* ── state ── */
  let selectedLangs = new Set(["en"]);

  /* ── DOM helpers — sdk.$() scopes to this widget's shadow DOM ── */
  const el = (id) => sdk.$(`#${id}`);

  /* ── word count ── */
  el("body").addEventListener("input", updateWordCount);
  function updateWordCount() {
    const t = el("body").value;
    el("word-count").textContent =
      `${t.length.toLocaleString()} chars · ${t.split(/\s+/).filter(Boolean).length} words`;
  }

  /* ── language chips ── */
  function renderChips() {
    const wrap = el("lang-chips");
    wrap.innerHTML = LANGS.map(l =>
      `<div class="chip${selectedLangs.has(l.c) ? " on" : ""}" data-lang="${l.c}">` +
      `${l.f} ${l.l}` +
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

  /* ── load categories ── */
  async function loadCategories() {
    const sel = el("category-select");
    sel.innerHTML = `<option value="">Loading sections…</option>`;
    try {
      const data = await sdk.connectors.execute({ permalink: CONN.categories, method: "GET" });
      const list = Array.isArray(data) ? data : (data.items || data.result || []);
      if (!list.length) throw new Error("No categories returned");
      sel.innerHTML =
        `<option value="">Select a section…</option>` +
        list.map(c => `<option value="${c.id}">${c.name || c.title || "Category " + c.id}</option>`).join("");
    } catch (e) {
      sel.innerHTML = `<option value="">Could not load — enter ID manually below</option>`;
      if (!sdk.$(`#cat-manual`)) {
        sel.insertAdjacentHTML("afterend",
          `<input type="text" id="cat-manual" placeholder="Enter category ID manually (e.g. 17)" style="margin-top:6px">`
        );
      }
    }
  }
  loadCategories();
  el("reload-cats-btn").addEventListener("click", loadCategories);

  /* ── AI generate ── */
  (async () => {
    try {
      await sdk.connectors.execute({ permalink: CONN.ai, method: "GET", path: "/v1/models" });
      el("ai-btn").disabled = false;
      el("ai-tip").textContent = "Powered by Claude";
    } catch {
      el("ai-btn").disabled = true;
      el("ai-tip").textContent = "Set up Anthropic connector to enable";
    }
  })();

  el("ai-btn").addEventListener("click", async () => {
    const prompt = el("ai-prompt").value.trim();
    if (!prompt) return;
    const btn = el("ai-btn");
    btn.disabled = true; btn.textContent = "✦ Generating…";
    el("ai-err").style.display = "none";
    try {
      const data = await sdk.connectors.execute({
        permalink: CONN.ai,
        method: "POST",
        body: {
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1500,
          messages: [{ role: "user", content:
            `Write a community article about: ${prompt}.\nFirst line = plain title (no # or * prefix).\nThen 4-6 paragraphs. Plain text, no markdown. 400-600 words. Practical and educational.`
          }],
        },
      });
      const text  = data.content[0].text.trim();
      const lines = text.split("\n").filter(l => l.trim());
      el("title").value = lines[0].replace(/^[#*\s]+/, "").trim();
      el("body").value  = lines.slice(1).join("\n\n").trim();
      updateWordCount();
    } catch (e) {
      const b = el("ai-err"); b.textContent = "AI error: " + e.message; b.style.display = "block";
    } finally { btn.disabled = false; btn.textContent = "✦ Generate"; }
  });

  /* ── translation via MyMemory (free, no auth required) ── */
  async function translate(title, body, langCode) {
    const txChunk = async (text) => {
      const chunks = []; let cur = "";
      for (const para of text.split(/\n+/)) {
        if (!para.trim()) { cur += "\n\n"; continue; }
        if ((cur + para).length > 490) { if (cur.trim()) chunks.push(cur.trim()); cur = para + "\n\n"; }
        else cur += para + "\n\n";
      }
      if (cur.trim()) chunks.push(cur.trim());
      const out = [];
      for (const chunk of chunks) {
        const r = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=en|${langCode}`);
        const d = await r.json();
        if (d.responseStatus !== 200) throw new Error(d.responseDetails || "Translation failed");
        out.push(d.responseData.translatedText);
      }
      return out.join("\n\n");
    };
    const [t, b] = await Promise.all([txChunk(title), txChunk(body)]);
    return { title: t, body: b };
  }

  /* ── publish ── */
  el("publish-btn").addEventListener("click", async () => {
    const title   = el("title").value.trim();
    const body    = el("body").value.trim();
    const isDraft = el("draft-toggle").checked;
    const catSel  = el("category-select");
    const catMan  = sdk.$(`#cat-manual`);
    const catId   = (catSel && catSel.value) || (catMan && catMan.value) || "";

    hideError(); hideOk();
    if (!title || !body)  { showError("Add a title and body first."); return; }
    if (!catId)           { showError("Select or enter a community section ID."); return; }
    if (!authorId)        { showError("Author User ID not configured — ask your admin to update widget settings."); return; }

    const btn = el("publish-btn");
    btn.disabled = true; btn.textContent = "Publishing…";

    const langs = Array.from(selectedLangs);
    const jobs  = langs.map(c => { const l = LANGS.find(x => x.c === c); return { c, l: l.l, f: l.f, status: "pending", link: null, err: null }; });
    renderProgress(jobs, isDraft);

    for (let i = 0; i < jobs.length; i++) {
      jobs[i].status = "working"; renderProgress(jobs, isDraft);
      try {
        /* translate if not English */
        let txTitle = title, txBody = body;
        if (jobs[i].c !== "en") {
          const tx = await translate(title, body, TX_CODES[jobs[i].c]);
          txTitle = tx.title; txBody = tx.body;
        }

        /* Step 1 — create draft */
        const created = await sdk.connectors.execute({
          permalink: CONN.createArticle,
          method:    "POST",
          body:      { title: txTitle, content: txBody, categoryId: parseInt(catId) },
        });
        if (!created || !created.id) throw new Error("No article ID in response — check Create Article connector");

        /* Step 2 — publish immediately if draft toggle is OFF */
        if (!isDraft) {
          await sdk.connectors.execute({
            permalink: CONN.publishArticle,
            method:    "POST",
            body:      { articleId: String(created.id) },  // Jinja2 in connector URL reads articleId
          });
        }

        /* Step 3 — fetch full article for the SEO link */
        try {
          const full   = await sdk.connectors.execute({
            permalink: CONN.getArticle,
            method:    "GET",
            body:      { articleId: String(created.id) },
          });
          const result = full.result || full;
          if (result.seoCommunityUrl) jobs[i].link = baseUrl + result.seoCommunityUrl;
        } catch (_) { /* link unavailable, non-fatal */ }

        jobs[i].status = "done";
      } catch (e) { jobs[i].status = "error"; jobs[i].err = e.message; }
      renderProgress(jobs, isDraft);
    }

    const doneCount = jobs.filter(j => j.status === "done").length;
    if (doneCount > 0) {
      showOk(`${isDraft ? "📝 Saved as draft" : "🎉 Published"}: "${title}" in ${doneCount} language${doneCount > 1 ? "s" : ""}.` +
             (isDraft ? " Go to Control → Content → Articles to publish." : ""));
      el("reset-btn").style.display = "inline-flex";
    }
    btn.disabled = false; btn.textContent = "🚀 Publish";
  });

  /* ── reset ── */
  el("reset-btn").addEventListener("click", () => {
    el("title").value = ""; el("body").value = ""; el("ai-prompt").value = "";
    selectedLangs = new Set(["en"]); renderChips(); updateWordCount();
    hideOk(); hideError();
    el("progress").style.display = "none";
    el("reset-btn").style.display = "none";
  });

  /* ── render helpers ── */
  function renderProgress(jobs, isDraft) {
    el("progress").style.display = "block";
    el("progress-rows").innerHTML = jobs.map(j => {
      const color = j.status==="done"?"#16a34a":j.status==="working"?"#d97706":j.status==="error"?"#dc2626":"#d1d0c8";
      const anim  = j.status === "working" ? "animation:pulse 1s infinite;" : "";
      const msg   = j.status==="pending"?"Waiting…":j.status==="working"?`→ ${isDraft?"saving draft…":"publishing…"}`:j.status==="done"?(isDraft?"✓ Saved as draft":"✓ Published"):j.err;
      const link  = j.link ? `<a href="${j.link}" target="_blank" style="margin-left:auto;color:#6366f1;font-size:11px">View →</a>` : "";
      return `<div class="prow"><div class="dot" style="background:${color};${anim}"></div><span style="min-width:90px">${j.f} ${j.l}</span><span style="color:#6b6b67;flex:1">${msg}</span>${link}</div>`;
    }).join("");
  }
  function showError(msg) { const b = el("error-box"); b.textContent = msg; b.style.display = "block"; }
  function hideError()    { el("error-box").style.display = "none"; }
  function showOk(msg)    { const b = el("ok-box");    b.textContent = msg; b.style.display = "block"; }
  function hideOk()       { el("ok-box").style.display  = "none"; }

  sdk.on("propsChanged", () => location.reload());
}
