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
  let baseUrl  = (props.communityBaseUrl || "").replace(/\/$/, "");
  let supportEmail = props.supportEmail || "";

  async function api(action, params) {
    if (!sdk.connectors) throw new Error("Connector SDK not available — ensure the community-publisher connector is configured in Gainsight.");
    return sdk.connectors.execute({
      permalink: CONNECTOR,
      method:    "POST",
      payload:   { action, ...params },
    });
  }

  let selectedLangs = new Set(["en"]);
  let rawBodyHtml = null; // set when article is imported; takes priority over Quill content
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
        renderLangSections();
      });
    });
  }

  // ── per-language category sections ────────────────────────────────────────
  // Language detection: inSided returns one flat list for all languages.
  // We detect which language each category belongs to via:
  //   1. Unicode script ranges  (Japanese kana, Korean hangul, CJK)
  //   2. Distinctive diacritics (ß→de, ñ→es, ã/õ→pt, à/â/ç/ê/œ→fr, ä/ö/ü→de)
  //   3. English keywords in name/parent  ("french", "español", etc.)
  //   4. null = neutral / English (shown only in English dropdown)
  //
  // Each dropdown shows ONLY the categories detected for that language
  // (+ neutral/English as fallback if nothing language-specific is found).
  //
  // Auto-selection priority inside each filtered dropdown:
  //   A. Widget props  defaultCategories = '{"fr":69,"es":42}'  (admin, always wins)
  //   B. Auto-detect   first match in filtered list
  //   C. Remembered    localStorage, saved from last manual pick

  const LANG_KEYWORDS = {
    // Language name keywords (English + native) AND common community-category words in that language
    // that are unambiguous enough to serve as identifiers even without accented characters.
    fr: ["french", "français", "francais",
         "connaissances", "connaissance",   // "base de connaissances" = knowledgebase
         "nouvelles", "annonces",           // news / announcements
         "ressources fr", "articles fr"],   // avoid "ressources" alone — too close to English
    es: ["spanish", "español", "espanol",
         "conocimiento", "conocimientos",   // knowledge
         "noticias", "novedades",           // news / updates
         "preguntas frecuentes"],           // FAQ
    de: ["german", "deutsch",
         "wissensdatenbank", "neuigkeiten", // knowledge base / news
         "wissensartikel", "ankündigungen"],
    pt: ["portuguese", "português", "portugues", "brazil", "brasil",
         "conhecimento", "conhecimentos",   // knowledge
         "novidades", "comunicados"],       // news / announcements
    ja: ["japanese", "日本語", "japan", "ナレッジ", "お知らせ", "ナレッジベース"],
    ko: ["korean", "한국어", "korea", "지식베이스", "공지사항", "지식"],
    zh: ["chinese", "中文", "simplified", "mandarin", "知识库", "公告", "知识"],
  };

  // Returns a language code or null (= English / unknown).
  function detectTextLang(text) {
    if (!text) return null;
    const lower = text.toLowerCase();
    // Unambiguous Unicode scripts
    if (/[぀-ヿ]/.test(text))  return "ja";  // Hiragana / Katakana
    if (/[가-힯]/.test(text))  return "ko";  // Hangul
    if (/[一-鿿]/.test(text))  return "zh";  // CJK
    // Distinctive single characters (most reliable for Latin scripts)
    if (/[ß]/.test(text))              return "de";
    if (/[ñ]/.test(text))              return "es";
    if (/[ãõ]/.test(text))             return "pt";
    if (/[àâçèêëîïôùûüÿœæ]/.test(text)) return "fr";
    if (/[äöü]/.test(text))            return "de";
    if (/[áéíóú]/.test(text))          return "es";  // generic accented vowels → assume Spanish
    // English keywords in the category name itself
    for (const [lang, kws] of Object.entries(LANG_KEYWORDS)) {
      if (kws.some(k => lower.includes(k))) return lang;
    }
    return null;
  }

  // Returns detected language for a category, checking parent name first.
  function catLang(c, byId) {
    const pid = c.parentId || c.parent_id || c.sectionId || c.section?.id || null;
    const par = pid && byId[pid];
    return (par && detectTextLang(par.name || par.title || ""))
        || detectTextLang(c.name || c.title || "");
  }

  // Returns { items, wasFiltered }.
  // wasFiltered=true  → items is a language-specific subset
  // wasFiltered=false → no language-specific categories found, items = full list (fallback)
  function filterForLang(lang, list, byId) {
    if (lang === "en") {
      const items = list.filter(c => !catLang(c, byId));
      return { items: items.length ? items : list, wasFiltered: items.length > 0 };
    }
    const matched = list.filter(c => catLang(c, byId) === lang);
    return matched.length
      ? { items: matched, wasFiltered: true }
      : { items: list,    wasFiltered: false };
  }

  let _catCache   = null;
  let _defCatsMap = {};
  try { _defCatsMap = JSON.parse(props.defaultCategories || "{}"); } catch {}

  function _catPrefsKey() {
    return `cp_cats_${(baseUrl || "x").replace(/[^a-z0-9]/gi, "_").substring(0, 40)}`;
  }
  function saveCatPref(lang, catId) {
    try {
      const p = JSON.parse(localStorage.getItem(_catPrefsKey()) || "{}");
      if (catId) p[lang] = String(catId); else delete p[lang];
      localStorage.setItem(_catPrefsKey(), JSON.stringify(p));
    } catch {}
  }
  function loadCatPref(lang) {
    try { return JSON.parse(localStorage.getItem(_catPrefsKey()) || "{}")?.[lang] || null; }
    catch { return null; }
  }

  // Returns { id, src } for the best pre-selection, or null.
  function resolveDefaultCat(lang, filtered) {
    if (_defCatsMap[lang])     return { id: String(_defCatsMap[lang]),  src: "cfg"  };
    if (filtered[0])           return { id: String(filtered[0].id),     src: "auto" };
    const mem = loadCatPref(lang);
    if (mem)                   return { id: mem,                         src: "mem"  };
    return null;
  }

  async function fetchAllCategories() {
    if (_catCache) return _catCache;
    const data = await api("categories", {});
    const list = Array.isArray(data) ? data
      : Array.isArray(data.result) ? data.result
      : Array.isArray(data.result?.items) ? data.result.items
      : Array.isArray(data.items) ? data.items
      : [];
    if (list.length) _catCache = list;
    return list;
  }

  function fillCatSelect(lang, fullList) {
    const sel = sdk.$(`#cat-select-${lang}`);
    if (!sel) return;
    const l = LANGS.find(x => x.c === lang);
    if (!fullList.length) {
      sel.innerHTML = `<option value="">Could not load — enter ID manually</option>`;
      const manualId = `cat-manual-${lang}`;
      if (!sdk.$(`#${manualId}`)) {
        sel.insertAdjacentHTML("afterend",
          `<input type="text" id="${manualId}" placeholder="Paste section ID from URL (e.g. 69)"
            style="width:100%;padding:8px 12px;border:1px solid #d1d5db;border-radius:7px;font-size:12px;font-family:inherit;margin-top:5px">`
        );
      }
      return;
    }

    const byId = Object.fromEntries(fullList.map(c => [c.id, c]));
    const label = c => c.name || c.title || ("Category " + c.id);
    const pidOf = c => c.parentId || c.parent_id || c.sectionId || c.section?.id || null;

    function buildOptions(items) {
      const byParent = {}, noParent = [];
      for (const c of items) {
        const p = pidOf(c);
        p && byId[p] ? (byParent[p] = byParent[p] || []).push(c) : noParent.push(c);
      }
      let html = `<option value="">— Select ${l.l} section —</option>`;
      const shown = new Set();
      for (const c of items) {
        const p = pidOf(c);
        if (p && byId[p] && !shown.has(p)) {
          shown.add(p);
          html += `<optgroup label="${label(byId[p])}">`;
          for (const k of byParent[p]) html += `<option value="${k.id}">${label(k)} (ID: ${k.id})</option>`;
          html += `</optgroup>`;
        }
      }
      for (const c of noParent) html += `<option value="${c.id}">${label(c)} (ID: ${c.id})</option>`;
      return html;
    }

    const { items: display, wasFiltered } = filterForLang(lang, fullList, byId);
    sel.innerHTML = buildOptions(display);

    // Info row: shows filter status + "Show all" escape hatch
    const infoId = `cat-info-${lang}`;
    sdk.$(`#${infoId}`)?.remove();
    if (wasFiltered && display.length < fullList.length) {
      sel.insertAdjacentHTML("afterend",
        `<div id="${infoId}" style="font-size:10px;color:#6b7280;margin-top:3px;display:flex;gap:8px;align-items:center">
          <span>Showing ${display.length} of ${fullList.length} sections</span>
          <a href="#" id="cat-showall-${lang}" style="color:#4f46e5;text-decoration:underline">Show all ↓</a>
        </div>`
      );
      sdk.$(`#cat-showall-${lang}`)?.addEventListener("click", e => {
        e.preventDefault();
        sel.innerHTML = buildOptions(fullList);
        sdk.$(`#${infoId}`)?.remove();
        const saved = getCatId(lang);
        if (saved) sel.value = saved;
      });
    } else if (!wasFiltered && lang !== "en") {
      sel.insertAdjacentHTML("afterend",
        `<div id="${infoId}" style="font-size:10px;color:#9ca3af;margin-top:3px">
          Showing all sections — no ${l.l}-language sections detected
        </div>`
      );
    }

    // Auto-select: props config → first in filtered list → remembered
    const def = resolveDefaultCat(lang, display);
    if (def) {
      sel.value = def.id;
      const badge = def.src === "cfg"  ? { t: "Configured",   c: "#16a34a" }
                  : def.src === "auto" ? { t: "Auto-detected", c: "#2563eb" }
                  :                      { t: "Remembered",    c: "#9ca3af" };
      const badgeId = `cat-badge-${lang}`;
      sdk.$(`#${badgeId}`)?.remove();
      // Insert badge before the info div so ordering stays clean
      const infoEl = sdk.$(`#${infoId}`);
      const target = infoEl || sel;
      target.insertAdjacentHTML(infoEl ? "beforebegin" : "afterend",
        `<div id="${badgeId}" style="font-size:10px;color:${badge.c};margin-top:3px">✓ ${badge.t}</div>`
      );
    }

    // Remember every manual pick (becomes layer C next session)
    sel.addEventListener("change", () => {
      saveCatPref(lang, sel.value || null);
      sdk.$(`#cat-badge-${lang}`)?.remove();
    });
  }

  async function renderLangSections() {
    const body = el("lang-sections-body");
    if (!body) return;
    body.innerHTML = [...selectedLangs].map(lang => {
      const l = LANGS.find(x => x.c === lang);
      return `<div style="margin-bottom:8px">
        <div style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px;display:flex;align-items:center;gap:5px">
          ${l.f} ${l.l}
        </div>
        <select id="cat-select-${lang}" style="width:100%;padding:9px 12px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;font-family:inherit;color:#111827;background:#fff">
          <option value="">Loading…</option>
        </select>
      </div>`;
    }).join("");
    try {
      const list = await fetchAllCategories();
      if (!list.length) throw new Error("empty");
      [...selectedLangs].forEach(lang => fillCatSelect(lang, list));
    } catch {
      [...selectedLangs].forEach(lang => fillCatSelect(lang, []));
    }
  }

  function getCatId(lang) {
    const sel = sdk.$(`#cat-select-${lang}`);
    const man = sdk.$(`#cat-manual-${lang}`);
    return (sel?.value && sel.value !== "") ? sel.value : (man?.value?.trim() || "");
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

  // ── AI disclaimer appended to all translated articles ─────────────────────
  function buildDisclaimer() {
    const contact = supportEmail
      ? ` If you see any updates required in content please reach out to <a href="mailto:${supportEmail}">${supportEmail}</a>.`
      : "";
    return `<p><br></p><p>---</p><p><em>This is AI Translated Content.${contact}</em></p>`;
  }

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
  // ── publish ───────────────────────────────────────────────────────────────
  el("publish-btn").addEventListener("click", async () => {
    const title   = el("title").value.trim();
    const bodyHtml = rawBodyHtml || (quill ? quill.root.innerHTML : "");
    const isDraft  = el("draft-toggle").checked;

    hideError(); hideOk();
    if (!title || !bodyHtml || bodyHtml === "<p><br></p>") { showError("Add a title and body first."); return; }

    const langs = Array.from(selectedLangs);
    for (const lang of langs) {
      if (!getCatId(lang)) {
        const l = LANGS.find(x => x.c === lang);
        showError(`Select a community section for ${l.l}.`);
        return;
      }
    }

    const btn = el("publish-btn");
    btn.disabled = true; btn.textContent = "Publishing…";

    const jobs  = langs.map(c => { const l = LANGS.find(x => x.c === c); return { c, l:l.l, f:l.f, status:"pending", link:null, err:null }; });
    renderProgress(jobs, isDraft);

    for (let i = 0; i < jobs.length; i++) {
      jobs[i].status = "working"; renderProgress(jobs, isDraft);
      try {
        let txTitle = title, txBody = bodyHtml;

        if (jobs[i].c !== "en") {
          // Extract images, send HTML directly (Google Translate preserves tags), restore images
          const { withPlaceholders, imgs } = extractImgs(bodyHtml);
          const tx = await api("translate", { targetLang: TX_NAMES[jobs[i].c], title, body: withPlaceholders });
          if (tx.error) throw new Error(tx.error);
          txTitle = tx.title;
          txBody = restoreImgs(tx.body, imgs) + buildDisclaimer();
        }

        const result = await api("articles", {
          title:              txTitle,
          content:            txBody,
          categoryId:         parseInt(getCatId(jobs[i].c)),
          publishAfterCreate: !isDraft,
          lang:               jobs[i].c,
          originalTitle:      title,
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
      const linkItems = jobs
        .filter(j => j.status === "done" && j.link)
        .map(j => `<a href="${j.link}" target="_blank" style="color:#166534;font-weight:600;text-decoration:underline">${j.f} View ${j.l} →</a>`)
        .join("&nbsp;&nbsp;");
      showOk(
        `${isDraft ? "📝 Saved as draft" : "🎉 Published"}: <strong>${title}</strong> in ` +
        `${doneCount} language${doneCount > 1 ? "s" : ""}.` +
        (isDraft ? " Go to Control → Content → Articles to publish." : "") +
        (linkItems ? `<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:8px">${linkItems}</div>` : "")
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
    sdk.$(`#html-source`).value = "";
    sdk.$(`#import-url`).value = "";
    sdk.$(`#search-q`).value = "";
    el("search-results").innerHTML = "";
    el("search-wrap").style.display = "none";
    el("html-source-wrap").style.display = "none";
    rawBodyHtml = null;
    el("imported-preview").style.display = "none";
    el("imported-preview").innerHTML = "";
    el("clear-import-btn").style.display = "none";
    el("editor-wrap").style.display = "block";
    if (quill) quill.setContents([]);
    selectedLangs = new Set(["en"]); renderChips(); renderLangSections(); updateWordCount();
    hideOk(); hideError();
    el("progress").style.display = "none";
    el("reset-btn").style.display = "none";
  });

  // ── import article (URL fetch or raw HTML paste) ──────────────────────────
  el("html-toggle-btn").addEventListener("click", () => {
    const wrap = el("html-source-wrap");
    const visible = wrap.style.display === "flex";
    wrap.style.display = visible ? "none" : "flex";
  });

  el("import-url-btn").addEventListener("click", async () => {
    const url = sdk.$(`#import-url`).value.trim();
    if (!url) return;
    const btn = el("import-url-btn");
    btn.disabled = true; btn.textContent = "Fetching…";
    try {
      const data = await api("fetch-article", { url });
      if (data.error) throw new Error(data.error);
      sdk.$(`#html-source`).value = data.html || "";
    } catch (e) {
      alert("Import failed: " + e.message);
    } finally {
      btn.disabled = false; btn.textContent = "↓ Fetch";
    }
  });

  el("html-apply-btn").addEventListener("click", () => {
    const html = sdk.$(`#html-source`).value.trim();
    if (!html) return;
    rawBodyHtml = html;
    // Show as preview div — bypasses Quill entirely so tables/images are preserved
    const preview = el("imported-preview");
    preview.innerHTML = html;
    preview.style.display = "block";
    el("editor-wrap").style.display = "none";
    el("clear-import-btn").style.display = "inline-flex";
    // Update word/char count from raw text
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const wc = sdk.$(`#word-count`); const cc = sdk.$(`#char-count`);
    if (wc) wc.textContent = `${text.split(/\s+/).filter(Boolean).length} words`;
    if (cc) cc.textContent = `${text.length.toLocaleString()} chars`;
    sdk.$(`#html-source`).value = "";
    sdk.$(`#import-url`).value = "";
    el("html-source-wrap").style.display = "none";
  });

  el("clear-import-btn").addEventListener("click", () => {
    rawBodyHtml = null;
    el("imported-preview").style.display = "none";
    el("imported-preview").innerHTML = "";
    el("clear-import-btn").style.display = "none";
    el("editor-wrap").style.display = "block";
    updateWordCount();
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
  function showOk(msg)    { const b = el("ok-box");    b.innerHTML  = msg; b.style.display = "block"; }
  function hideOk()       { el("ok-box").style.display = "none"; }

  sdk.on("propsChanged", () => {
    const p = sdk.getProps();
    baseUrl = (p.communityBaseUrl || "").replace(/\/$/, "");
    supportEmail = p.supportEmail || "";
    try { _defCatsMap = JSON.parse(p.defaultCategories || "{}"); } catch { _defCatsMap = {}; }
  });

  // ── search (Feature 2) ────────────────────────────────────────────────────
  el("search-toggle-btn").addEventListener("click", () => {
    const wrap = el("search-wrap");
    const visible = wrap.style.display === "block";
    wrap.style.display = visible ? "none" : "block";
    if (!visible) setTimeout(() => sdk.$(`#search-q`).focus(), 50);
  });

  async function doSearch() {
    const q = sdk.$(`#search-q`).value.trim();
    if (!q) return;
    const btn     = el("search-btn");
    const results = el("search-results");
    btn.disabled = true; btn.textContent = "Searching…";
    results.innerHTML = `<div style="color:#9ca3af;padding:4px 0">Searching…</div>`;
    try {
      const data = await api("search-articles", { q });
      if (data.error) throw new Error(data.error);
      if (!data.results?.length) {
        results.innerHTML = `<div style="color:#9ca3af;padding:4px 0">No articles found for "<em>${q}</em>".</div>`;
      } else {
        results.innerHTML = data.results.map(r => {
          const href = r.url ? (baseUrl + r.url) : "#";
          return `<div style="padding:6px 0;border-bottom:1px solid #f3f4f6">
            <a href="${href}" target="_blank" style="color:#4f46e5;font-weight:500">${r.title}</a>
            ${r.categoryName ? `<span style="color:#9ca3af;font-size:11px;margin-left:6px">· ${r.categoryName}</span>` : ""}
            ${r.snippet ? `<div style="color:#6b7280;font-size:11px;margin-top:1px">${r.snippet}</div>` : ""}
          </div>`;
        }).join("");
      }
    } catch (e) {
      results.innerHTML = `<div style="color:#dc2626;font-size:11px">Search error: ${e.message}</div>`;
    } finally {
      btn.disabled = false; btn.textContent = "Search →";
    }
  }
  el("search-btn").addEventListener("click", doSearch);
  sdk.$(`#search-q`).addEventListener("keydown", e => { if (e.key === "Enter") doSearch(); });

  // ── language stats (Feature 4) ────────────────────────────────────────────
  const FLAGS = { en:"🇺🇸", es:"🇪🇸", fr:"🇫🇷", de:"🇩🇪", pt:"🇧🇷", ja:"🇯🇵", ko:"🇰🇷", zh:"🇨🇳" };

  async function loadLangStats() {
    const body = el("lang-stats-body");
    if (!body) return;
    body.innerHTML = `<div style="font-size:12px;color:#9ca3af;text-align:center;padding:4px 0">Loading…</div>`;
    try {
      const data = await api("language-stats");
      if (!data.languages?.length) {
        body.innerHTML = `<div style="font-size:12px;color:#9ca3af;text-align:center;padding:4px 0">No articles published yet through this agent.</div>`;
        return;
      }
      body.innerHTML = `
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px" id="lang-stat-chips">
          ${data.languages.map(l => `
            <button class="chip" data-lang="${l.lang}" style="font-size:12px">
              ${FLAGS[l.lang] || "🌐"} ${l.label} <strong style="color:#7c3aed;margin-left:3px">${l.count}</strong>
            </button>`).join("")}
        </div>
        <div id="lang-articles-list"></div>`;

      body.querySelectorAll(".chip[data-lang]").forEach(chip => {
        chip.addEventListener("click", () => {
          const lang     = chip.dataset.lang;
          const langData = data.languages.find(l => l.lang === lang);
          const listEl   = sdk.$(`#lang-articles-list`);

          if (chip.classList.contains("on")) {
            chip.classList.remove("on"); listEl.innerHTML = ""; return;
          }
          body.querySelectorAll(".chip[data-lang]").forEach(c => c.classList.remove("on"));
          chip.classList.add("on");

          if (!langData?.articles?.length) {
            listEl.innerHTML = `<div style="font-size:12px;color:#9ca3af">No article links stored for this language.</div>`;
            return;
          }
          listEl.innerHTML = `
            <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">
              ${FLAGS[lang] || "🌐"} ${langData.label} — ${langData.count} article${langData.count !== 1 ? "s" : ""}
            </div>
            ${langData.articles.map(a => `
              <div style="padding:5px 0;border-bottom:1px solid #f3f4f6;font-size:12px;display:flex;align-items:center;justify-content:space-between">
                ${a.url
                  ? `<a href="${baseUrl + a.url}" target="_blank" style="color:#4f46e5;text-decoration:underline;flex:1">${a.title}</a>`
                  : `<span style="color:#374151;flex:1">${a.title}</span>`}
                <span style="color:#9ca3af;font-size:10px;margin-left:8px;white-space:nowrap">${a.isDraft ? "draft" : "live"} · ${(a.publishedAt || "").substring(0, 10)}</span>
              </div>`).join("")}`;
        });
      });
    } catch (e) {
      if (body) body.innerHTML = `<div style="font-size:12px;color:#9ca3af;text-align:center">Coverage data unavailable.</div>`;
    }
  }

  el("lang-stats-refresh")?.addEventListener("click", loadLangStats);

  // ── init ───────────────────────────────────────────────────────────────────
  try {
    renderChips();
    renderLangSections().catch(e => console.error("renderLangSections:", e));
    loadLangStats().catch(e => console.error("loadLangStats:", e));
    el("reload-cats-btn")?.addEventListener("click", () => { _catCache = null; renderLangSections(); });
  } catch (e) {
    console.error("Widget init error:", e);
  }

  // Quill loads from CDN — wait for it then init
  function waitForQuill(tries) {
    if (window.Quill) { initQuill(); return; }
    if (tries > 0) setTimeout(() => waitForQuill(tries - 1), 200);
  }
  waitForQuill(20);
}
