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
  const props  = sdk.getProps();
  let baseUrl  = (props.communityBaseUrl || "https://netskope-us-sandbox-community.insided.com").replace(/\/$/, "");

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

  // ── Quill editor ──────────────────────────────────────────────────────────
  let quill = null;

  function initQuill() {
    const editorEl = sdk.$(`#editor`);
    if (!editorEl || quill) return;

    quill = new window.Quill(editorEl, {
      theme: "snow",
      placeholder: "Write your article here…",
      modules: {
        toolbar: {
          container: [
            [{ header: [1, 2, 3, false] }],
            ["bold", "italic", "underline", "strike"],
            [{ color: [] }, { background: [] }],
            [{ list: "ordered" }, { list: "bullet" }],
            [{ align: [] }],
            ["blockquote", "code-block"],
            ["link", "image"],
            ["clean"],
          ],
          handlers: { image: imageUploadHandler },
        },
      },
    });

    quill.on("text-change", updateWordCount);
  }

  // ── image upload via community API ────────────────────────────────────────
  function imageUploadHandler() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.click();
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (e) => {
        const dataUrl   = e.target.result;
        const base64    = dataUrl.split(",")[1];
        const mimeType  = file.type;
        const filename  = file.name;
        const range     = quill.getSelection(true);

        // Insert placeholder while uploading
        quill.insertText(range.index, " ", "user");
        quill.setSelection(range.index + 1);

        try {
          const result = await api("upload-image", { imageBase64: base64, mimeType, filename });
          // Remove placeholder
          quill.deleteText(range.index, 1);
          const url = result.url || result.imageUrl || result.src || result.link;
          if (url) {
            quill.insertEmbed(range.index, "image", url, "user");
          } else {
            throw new Error("No URL returned");
          }
        } catch (err) {
          // Fallback: embed as data URL (works but won't be community-hosted)
          quill.deleteText(range.index, 1);
          quill.insertEmbed(range.index, "image", dataUrl, "user");
          console.warn("Image upload failed, using data URL:", err.message);
        }
        quill.setSelection(range.index + 1);
      };
      reader.readAsDataURL(file);
    };
  }

  // ── word count ────────────────────────────────────────────────────────────
  function updateWordCount() {
    if (!quill) return;
    const text = quill.getText().trim();
    const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
    const chars = text.length;
    const wc = sdk.$(`#word-count`);
    const cc = sdk.$(`#char-count`);
    if (wc) wc.textContent = `${words} words`;
    if (cc) cc.textContent = `${chars.toLocaleString()} chars`;
  }

  // ── language chips ────────────────────────────────────────────────────────
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

  // ── categories ────────────────────────────────────────────────────────────
  async function loadCategories() {
    const sel = el("category-select");
    sel.innerHTML = `<option value="">Loading sections…</option>`;
    const existing = sdk.$(`#cat-manual-wrap`);
    if (existing) existing.remove();
    try {
      const data = await api("categories");
      const list = Array.isArray(data) ? data : (data.items || data.result || []);
      if (!list.length) throw new Error("Empty");
      sel.innerHTML = `<option value="">— Select a section —</option>` +
        list.map(c => `<option value="${c.id}">${c.name || c.title || "Category " + c.id}</option>`).join("");
    } catch (e) {
      sel.innerHTML = `<option value="">Could not load — enter ID below</option>`;
      sel.insertAdjacentHTML("afterend",
        `<div id="cat-manual-wrap" style="margin-top:8px">
          <div style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px">Category ID</div>
          <input type="text" id="cat-manual" placeholder="e.g. 17  (Control Panel → Categories URL)" style="width:100%;padding:9px 12px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;font-family:inherit;color:#111827;background:#fff">
          <div style="font-size:11px;color:#9ca3af;margin-top:5px">Go to Control Panel → Categories → click any category → copy the ID from the URL</div>
        </div>`);
    }
  }

  // ── AI generate ───────────────────────────────────────────────────────────
  el("ai-btn").addEventListener("click", async () => {
    const prompt = el("ai-prompt").value.trim();
    const url    = el("ai-url").value.trim();
    if (!prompt && !url) {
      const b = el("ai-err"); b.textContent = "Enter a topic or paste a URL."; b.style.display = "block"; return;
    }
    const btn = el("ai-btn");
    btn.disabled = true; btn.textContent = "✦ Generating…";
    el("ai-err").style.display = "none";
    try {
      const params = {};
      if (prompt) params.prompt = prompt;
      if (url)    params.url    = url;
      const data = await api("generate", params);
      if (data.error) throw new Error(data.error);
      el("title").value = data.title || "";
      if (quill) {
        quill.clipboard.dangerouslyPasteHTML(
          (data.body || "").replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")
        );
        updateWordCount();
      }
    } catch (e) {
      const b = el("ai-err"); b.textContent = "AI error: " + e.message; b.style.display = "block";
    } finally {
      btn.disabled = false; btn.textContent = "✦ Generate article";
    }
  });

  // ── translation helpers ───────────────────────────────────────────────────
  // Extract <img> tags, replace with placeholders, translate text, restore images
  function extractImgs(html) {
    const imgs = [];
    const withPlaceholders = html.replace(/<img[^>]*>/gi, m => {
      imgs.push(m); return `[IMG${imgs.length - 1}]`;
    });
    return { withPlaceholders, imgs };
  }
  function restoreImgs(text, imgs) {
    return text.replace(/\[IMG(\d+)\]/g, (_, i) => imgs[+i] || "");
  }
  function htmlToPlain(html) {
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  // ── publish ───────────────────────────────────────────────────────────────
  el("publish-btn").addEventListener("click", async () => {
    const title   = el("title").value.trim();
    const bodyHtml = quill ? quill.root.innerHTML : "";
    const isDraft  = el("draft-toggle").checked;
    const catSel   = el("category-select");
    const catMan   = sdk.$(`#cat-manual`);
    const catId    = (catSel?.value && catSel.value !== "") ? catSel.value : (catMan?.value?.trim() || "");

    hideError(); hideOk();
    if (!title || !bodyHtml || bodyHtml === "<p><br></p>") { showError("Add a title and body first."); return; }
    if (!catId) { showError("Select or enter a community section."); return; }

    const btn = el("publish-btn");
    btn.disabled = true; btn.textContent = "Publishing…";

    const langs = Array.from(selectedLangs);
    const jobs  = langs.map(c => { const l = LANGS.find(x => x.c === c); return { c, l:l.l, f:l.f, status:"pending", link:null, err:null }; });
    renderProgress(jobs, isDraft);

    for (let i = 0; i < jobs.length; i++) {
      jobs[i].status = "working"; renderProgress(jobs, isDraft);
      try {
        let txTitle = title, txBody = bodyHtml;

        if (jobs[i].c !== "en") {
          // Extract images, translate text only, restore images
          const { withPlaceholders, imgs } = extractImgs(bodyHtml);
          const plainText = htmlToPlain(withPlaceholders);
          const tx = await api("translate", { targetLang: TX_NAMES[jobs[i].c], title, body: plainText });
          if (tx.error) throw new Error(tx.error);
          txTitle = tx.title;
          // Wrap translated paragraphs in <p> tags and restore images
          const restoredBody = restoreImgs(tx.body, imgs);
          txBody = restoredBody.split(/\n+/).filter(Boolean).map(p => `<p>${p}</p>`).join("");
        }

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

  // ── reset ──────────────────────────────────────────────────────────────────
  el("reset-btn").addEventListener("click", () => {
    el("title").value = "";
    el("ai-prompt").value = "";
    el("ai-url").value = "";
    if (quill) quill.setContents([]);
    selectedLangs = new Set(["en"]); renderChips(); updateWordCount();
    hideOk(); hideError();
    el("progress").style.display = "none";
    el("reset-btn").style.display = "none";
  });

  // ── helpers ────────────────────────────────────────────────────────────────
  function renderProgress(jobs, isDraft) {
    el("progress").style.display = "block";
    el("progress-rows").innerHTML = jobs.map(j => {
      const color = j.status==="done"?"#16a34a":j.status==="working"?"#d97706":j.status==="error"?"#dc2626":"#d1d0c8";
      const anim  = j.status === "working" ? "animation:pulse 1s infinite;" : "";
      const msg   = j.status==="pending"?"Waiting…"
                  : j.status==="working"?`→ ${isDraft?"saving draft…":"publishing…"}`
                  : j.status==="done"?(isDraft?"✓ Saved as draft":"✓ Published")
                  : j.err;
      const link  = j.link ? `<a href="${j.link}" target="_blank" style="margin-left:auto;color:#6366f1;font-size:11px">View →</a>` : "";
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
  function hideOk()       { el("ok-box").style.display = "none"; }

  sdk.on("propsChanged", () => {
    const p = sdk.getProps();
    baseUrl = (p.communityBaseUrl || "https://netskope-us-sandbox-community.insided.com").replace(/\/$/, "");
  });

  // ── init ───────────────────────────────────────────────────────────────────
  renderChips();
  loadCategories();
  el("reload-cats-btn").addEventListener("click", loadCategories);

  // Quill loads from CDN — wait for it then init
  function waitForQuill(tries) {
    if (window.Quill) { initQuill(); return; }
    if (tries > 0) setTimeout(() => waitForQuill(tries - 1), 200);
  }
  waitForQuill(20);
}
