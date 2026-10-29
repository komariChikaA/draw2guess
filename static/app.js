"use strict";

(() => {
  const $ = (selector) => document.querySelector(selector);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const formatNumber = (value) => new Intl.NumberFormat("zh-CN").format(Number(value) || 0);
  const state = { libraries: [], loaded: false, totalWords: 0, routeId: null, library: null, page: 1, pageSize: 60, query: "", loadingWords: false, submitting: false, overviewRequest: 0, wordRequest: 0, toastTimer: null, searchTimer: null, lastRefresh: 0, pendingDelete: null, memoryOwner: "" };
  const OWNER_RE = /^[A-Za-z0-9_-]{32,64}$/;

  function createOwner() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  }

  function getOwner() {
    try {
      const stored = localStorage.getItem("huacai-owner") || "";
      if (OWNER_RE.test(stored)) return stored;
      const token = createOwner();
      localStorage.setItem("huacai-owner", token);
      return token;
    } catch (_) {
      if (!OWNER_RE.test(state.memoryOwner)) state.memoryOwner = createOwner();
      return state.memoryOwner;
    }
  }

  async function api(path, options = {}) {
    let response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", "X-Huacai-Owner": getOwner(), ...options.headers }, cache: "no-store", signal: controller.signal });
    } catch (error) {
      if (error.name === "AbortError") throw new Error("服务器响应有点慢，请稍后重试。重复提交的题目会自动跳过。");
      throw new Error("暂时连接不上服务器，请检查网络后重试。");
    } finally {
      clearTimeout(timeout);
    }
    let result;
    try { result = await response.json(); } catch (_) { throw new Error("服务器暂时没有正确响应，请稍后重试。"); }
    if (!response.ok) throw new Error(result.error || "操作没有成功，请稍后重试。");
    return result;
  }

  function showToast(message) {
    clearTimeout(state.toastTimer);
    $("#toast").textContent = message;
    $("#toast").hidden = false;
    state.toastTimer = setTimeout(() => { $("#toast").hidden = true; }, 3600);
  }

  function showFeedback(element, message, isError = false) {
    element.textContent = message;
    element.classList.toggle("error", isError);
    element.hidden = false;
  }

  function renderState(target, { title, message, action = "", actionText = "重试" }) {
    target.innerHTML = `<div class="state-block"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(message)}</p>${action ? `<button class="button" data-action="${escapeHtml(action)}">${escapeHtml(actionText)}</button>` : ""}</div>`;
  }

  function renderLibraries() {
    const query = $("#library-search").value.trim().toLocaleLowerCase();
    const libraries = state.libraries.filter((library) => `${library.name} ${library.description || ""}`.toLocaleLowerCase().includes(query));
    $("#library-count").textContent = formatNumber(state.libraries.length);
    $("#library-count").hidden = false;
    $("#collection-summary").innerHTML = query
      ? `找到 ${formatNumber(libraries.length)} 个题库`
      : `共 ${formatNumber(state.libraries.length)} 个题库，${formatNumber(state.totalWords)} 条词条`;
    const grid = $("#library-grid");
    grid.setAttribute("aria-busy", "false");
    if (!libraries.length) {
      renderState(grid, { title: query ? "没有找到相关题库" : "暂无题库", message: query ? "请换一个关键词，或新建题库。" : "点击下方按钮创建第一个题库。", action: "create", actionText: "新建题库" });
      return;
    }
    grid.innerHTML = libraries.map((library) => `<a class="library-row" href="#library/${Number(library.id)}" aria-label="进入${escapeHtml(library.name)}，${formatNumber(library.word_count)}条词条"><div class="library-info"><h2>${escapeHtml(library.name)}</h2>${library.description ? `<p class="library-description">${escapeHtml(library.description)}</p>` : ""}</div><span class="library-word-count">${formatNumber(library.word_count)} 条词条</span><span class="library-enter">进入题库 →</span></a>`).join("");
  }

  async function loadLibraries({ quiet = false } = {}) {
    const request = ++state.overviewRequest;
    if (!quiet && !state.loaded) {
      $("#library-grid").setAttribute("aria-busy", "true");
      $("#library-grid").innerHTML = '<p class="loading-text">正在加载…</p>';
      $("#collection-summary").textContent = "";
    }
    try {
      const result = await api("/api/libraries");
      if (request !== state.overviewRequest) return;
      state.libraries = result.libraries;
      state.totalWords = result.total_words;
      state.loaded = true;
      state.lastRefresh = Date.now();
      renderLibraries();
    } catch (error) {
      if (request !== state.overviewRequest || quiet) return;
      $("#library-grid").setAttribute("aria-busy", "false");
      $("#collection-summary").textContent = "";
      renderState($("#library-grid"), { title: "题库加载失败", message: error.message, action: "reload-libraries", actionText: "重新加载" });
    }
  }

  function renderDetailHeading(library) {
    $("#detail-heading").className = "detail-heading";
    $("#detail-heading").innerHTML = `<div class="detail-title-wrap"><h1>${escapeHtml(library.name)}</h1>${library.description ? `<p>${escapeHtml(library.description)}</p>` : ""}</div><div class="detail-actions"><button class="button detail-mobile-add" data-action="focus-add">添加词条</button><a class="button" id="export-link" href="/api/libraries/${Number(library.id)}/export" download>导出 TXT</a><button class="button" id="share-library">复制链接</button></div>`;
    document.title = `${library.name} · 你画我猜题库`;
  }

  function renderWords(result) {
    const total = Number(result.total) || 0;
    const fullCount = Number(result.library.word_count) || 0;
    $("#word-count").textContent = formatNumber(fullCount);
    const from = total ? (state.page - 1) * state.pageSize + 1 : 0;
    const to = Math.min(state.page * state.pageSize, total);
    $("#word-results-summary").textContent = state.query
      ? `找到 ${formatNumber(total)} 条词条${total ? `，当前显示 ${from}–${to} 条` : ""}`
      : total ? `共 ${formatNumber(total)} 条，当前显示 ${from}–${to} 条` : "暂无词条";
    if (!result.words.length) {
      renderState($("#words-grid"), { title: state.query ? "没有找到相关词条" : "暂无词条", message: state.query ? "请尝试其他关键词。" : "你可以在添加词条表单中提交，一行一个。", action: state.query ? "clear-word-search" : "focus-add", actionText: state.query ? "查看全部词条" : "添加词条" });
    } else {
      $("#words-grid").innerHTML = result.words.map((word) => `<div class="word-card"><span class="word-text">${escapeHtml(word.text)}</span>${word.contributor ? `<span class="word-author">来自 ${escapeHtml(word.contributor)}</span>` : ""}${word.owned ? `<button type="button" class="word-delete" data-action="delete-word" data-word-id="${Number(word.id)}" data-word-text="${escapeHtml(word.text)}">删除</button>` : ""}</div>`).join("");
    }
    const pages = Math.ceil(total / state.pageSize);
    $("#pagination").hidden = pages <= 1;
    $("#pagination").innerHTML = pages > 1 ? `<button type="button" data-page="${state.page - 1}" aria-label="上一页" ${state.page <= 1 ? "disabled" : ""}>←</button><span>第 ${state.page} / ${pages} 页</span><button type="button" data-page="${state.page + 1}" aria-label="下一页" ${state.page >= pages ? "disabled" : ""}>→</button>` : "";
    $("#words-grid").setAttribute("aria-busy", "false");
  }

  async function loadWords({ initial = false, quiet = false } = {}) {
    if (state.routeId === null) return;
    const routeId = state.routeId;
    const request = ++state.wordRequest;
    state.loadingWords = true;
    if (initial) {
      $("#detail-content").hidden = true;
      $("#detail-heading").className = "detail-heading";
      $("#detail-heading").innerHTML = '<p class="loading-text">正在加载题库…</p>';
    } else if (!quiet) {
      $("#words-grid").setAttribute("aria-busy", "true");
      $("#words-grid").innerHTML = '<p class="words-loading">正在加载…</p>';
      $("#pagination").hidden = true;
    }
    try {
      const params = new URLSearchParams({ page: String(state.page), page_size: String(state.pageSize) });
      if (state.query) params.set("q", state.query);
      const result = await api(`/api/libraries/${routeId}/words?${params}`);
      if (request !== state.wordRequest || routeId !== state.routeId) return;
      state.library = result.library;
      // A concurrent contribution or search can change the last page.
      const pages = Math.max(1, Math.ceil(result.total / state.pageSize));
      if (state.page > pages) { state.page = pages; loadWords({ quiet }); return; }
      renderDetailHeading(result.library);
      $("#detail-content").hidden = false;
      renderWords(result);
      state.lastRefresh = Date.now();
    } catch (error) {
      if (request !== state.wordRequest || routeId !== state.routeId || quiet) return;
      if (initial) {
        renderState($("#detail-heading"), { title: "题库加载失败", message: error.message, action: "reload-words", actionText: "重新加载" });
      } else {
        renderState($("#words-grid"), { title: "词条加载失败", message: error.message, action: "reload-words", actionText: "重新加载" });
      }
      $("#words-grid").setAttribute("aria-busy", "false");
    } finally {
      if (request === state.wordRequest) state.loadingWords = false;
    }
  }

  function route() {
    const match = location.hash.match(/^#library\/([1-9]\d*)$/);
    const id = match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : null;
    const changed = state.routeId !== id;
    state.routeId = id;
    $("#overview-view").hidden = id !== null;
    $("#detail-view").hidden = id === null;
    if (id !== null) {
      if (changed) {
        clearTimeout(state.searchTimer);
        state.query = "";
        state.page = 1;
        state.library = null;
        $("#word-search").value = "";
        $("#words-input").value = "";
        $("#add-feedback").hidden = true;
        $("#similar-results").hidden = true;
        updateInputCount();
        window.scrollTo(0, 0);
      }
      loadWords({ initial: changed || !state.library });
    } else {
      state.wordRequest++;
      state.loadingWords = false;
      document.title = "你画我猜题库";
      if (changed) { window.scrollTo(0, 0); loadLibraries({ quiet: state.loaded }); }
      else if (!state.loaded) loadLibraries();
    }
  }

  function openCreate() {
    $("#create-feedback").hidden = true;
    $("#create-dialog").showModal();
    document.body.classList.add("modal-open");
    requestAnimationFrame(() => $("#library-name").focus());
  }

  function closeCreate() {
    if ($("#create-submit").disabled) return;
    $("#create-dialog").close();
  }

  async function createLibrary(event) {
    event.preventDefault();
    const name = $("#library-name").value.trim();
    const description = $("#library-description").value.trim();
    if (!name) { showFeedback($("#create-feedback"), "请填写题库名称。", true); $("#library-name").focus(); return; }
    const button = $("#create-submit");
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = "正在创建…";
    $("#create-feedback").hidden = true;
    try {
      const result = await api("/api/libraries", { method: "POST", body: JSON.stringify({ name, description, color: "mint" }) });
      $("#create-dialog").close();
      $("#create-form").reset();
      location.hash = `library/${Number(result.library.id)}`;
      loadLibraries({ quiet: state.loaded });
      showToast("题库已创建。");
    } catch (error) { showFeedback($("#create-feedback"), error.message, true); }
    finally { button.disabled = false; button.textContent = "创建题库"; }
  }

  function getInputWords() { return $("#words-input").value.split(/\r?\n/).map((word) => word.trim()).filter(Boolean); }
  function updateInputCount() {
    const count = getInputWords().length;
    $("#words-input-count").textContent = `${count} 条`;
    $("#words-input-count").classList.toggle("over-limit", count > 200);
  }

  async function addWords(event) {
    event.preventDefault();
    if (state.submitting || !state.library) return;
    const words = getInputWords();
    const feedback = $("#add-feedback");
    if (!words.length) { showFeedback(feedback, "请输入词条，一行一个。", true); $("#words-input").focus(); return; }
    if (words.length > 200) { showFeedback(feedback, `当前有 ${words.length} 条，每次最多提交 200 条，请分批添加。`, true); return; }
    const longWord = words.find((word) => Array.from(word).length > 50);
    if (longWord) { showFeedback(feedback, `“${longWord.slice(0, 16)}…”超过 50 字，请缩短后再提交。`, true); return; }
    const routeId = state.routeId;
    const submittedValue = $("#words-input").value;
    const contributor = $("#contributor").value.trim();
    try { localStorage.setItem("huacai-contributor", contributor); } catch (_) { /* Private browsing may disable storage. */ }
    state.submitting = true;
    $("#add-submit").disabled = true;
    $("#add-submit").textContent = "正在提交…";
    feedback.hidden = true;
    try {
      const result = await api(`/api/libraries/${routeId}/words`, { method: "POST", body: JSON.stringify({ words, contributor, owner: getOwner() }) });
      if (routeId !== state.routeId) { showToast(`原题库已添加 ${result.added} 条词条。`); return; }
      const duplicates = Array.isArray(result.duplicates) ? result.duplicates : [];
      feedback.classList.remove("error");
      feedback.innerHTML = result.added
        ? `已添加 ${formatNumber(result.added)} 条。${duplicates.length ? `跳过 ${formatNumber(duplicates.length)} 条重复词条。` : ""}`
        : "未添加新词条，提交的内容均已存在。";
      if (duplicates.length) feedback.innerHTML += `<span class="duplicate-list">重复词条：${duplicates.map(escapeHtml).join("、")}</span>`;
      feedback.hidden = false;
      if (result.added && $("#words-input").value === submittedValue) { $("#words-input").value = ""; updateInputCount(); }
      if (result.added) {
        $("#similar-results").hidden = true;
        state.page = 1;
        state.query = "";
        $("#word-search").value = "";
        await loadWords({ quiet: true });
        loadLibraries({ quiet: true });
      }
    } catch (error) { if (routeId === state.routeId) showFeedback(feedback, error.message, true); else showToast(error.message); }
    finally {
      state.submitting = false;
      $("#add-submit").disabled = false;
      $("#add-submit").textContent = "提交";
    }
  }

  function uniqueInputWords() {
    const seen = new Set();
    const words = [];
    for (const word of getInputWords()) {
      const key = word.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ");
      if (seen.has(key)) continue;
      seen.add(key);
      words.push(word);
    }
    return words;
  }

  function renderSimilarResults(results, truncated) {
    const groups = results.map((item) => {
      const matches = Array.isArray(item.matches) ? item.matches : [];
      if (!matches.length) {
        return `<div class="similar-group"><div class="similar-word">${escapeHtml(item.word)}</div><p class="similar-status">未发现明显相似的词条</p></div>`;
      }
      const exact = matches.some((match) => match.reason === "完全相同");
      const nearExact = matches.some((match) => match.reason.startsWith("仅写法不同"));
      const status = exact ? "已有完全相同的词条" : nearExact ? "已有写法几乎相同的词条" : `发现 ${formatNumber(matches.length)} 条相近词条`;
      const list = matches.map((match) => `<span class="similar-match">${escapeHtml(match.text)}${match.contributor ? ` · 来自 ${escapeHtml(match.contributor)}` : ""}<span class="similar-reason">（${escapeHtml(match.reason)}）</span></span>`).join("");
      return `<div class="similar-group"><div class="similar-word">${escapeHtml(item.word)}</div><p class="similar-status hit">${status}</p>${list}</div>`;
    }).join("");
    $("#similar-results").innerHTML = `<h3>查重结果</h3>${truncated ? `<p class="similar-status">每次最多查重 20 条，已检查前 20 条。</p>` : ""}${groups}`;
    $("#similar-results").hidden = false;
  }

  async function checkSimilar() {
    if (state.submitting || !state.library) return;
    const words = uniqueInputWords();
    const feedback = $("#add-feedback");
    if (!words.length) { showFeedback(feedback, "请输入词条，一行一个，再点查重。", true); $("#words-input").focus(); return; }
    const truncated = words.length > 20;
    const routeId = state.routeId;
    state.submitting = true;
    $("#check-similar").disabled = true;
    $("#check-similar").textContent = "正在查重…";
    feedback.hidden = true;
    try {
      const result = await api(`/api/libraries/${routeId}/similar`, { method: "POST", body: JSON.stringify({ words: words.slice(0, 20) }) });
      if (routeId !== state.routeId) return;
      const results = Array.isArray(result.results) ? result.results : [];
      renderSimilarResults(results, truncated);
      const hits = results.filter((item) => Array.isArray(item.matches) && item.matches.length).length;
      showToast(hits ? `查到 ${formatNumber(hits)} 条有相近词条。` : "没有发现明显相似的词条。");
    } catch (error) {
      if (routeId === state.routeId) showFeedback(feedback, error.message, true);
      else showToast(error.message);
    } finally {
      state.submitting = false;
      $("#check-similar").disabled = false;
      $("#check-similar").textContent = "查重";
    }
  }

  function openDelete(target) {
    if (state.submitting || $("#confirm-delete").disabled) return;
    const wordId = Number(target.dataset.wordId);
    const wordText = target.dataset.wordText || "";
    if (!Number.isSafeInteger(wordId) || wordId < 1) return;
    state.pendingDelete = { id: wordId, text: wordText };
    $("#delete-message").textContent = wordText ? `确定删除「${wordText}」？删除后无法恢复。` : "确定删除这条词条？删除后无法恢复。";
    $("#delete-dialog").showModal();
    document.body.classList.add("modal-open");
  }

  function closeDelete() {
    if ($("#confirm-delete").disabled) return;
    $("#delete-dialog").close();
  }

  async function confirmDelete() {
    if (state.submitting || !state.pendingDelete || !state.library) return;
    const routeId = state.routeId;
    const { id, text } = state.pendingDelete;
    const button = $("#confirm-delete");
    state.submitting = true;
    button.disabled = true;
    button.textContent = "正在删除…";
    try {
      await api(`/api/libraries/${routeId}/words/${id}`, { method: "DELETE", body: JSON.stringify({ owner: getOwner() }) });
      $("#delete-dialog").close();
      state.pendingDelete = null;
      if (routeId !== state.routeId) { showToast(text ? `已删除「${text}」。` : "词条已删除。"); return; }
      showToast(text ? `已删除「${text}」。` : "词条已删除。");
      await loadWords({ quiet: true });
      loadLibraries({ quiet: true });
    } catch (error) {
      showToast(error.message);
    } finally {
      state.submitting = false;
      button.disabled = false;
      button.textContent = "删除";
    }
  }

  async function shareLibrary() {
    const url = `${location.origin}${location.pathname}#library/${state.routeId}`;
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(url);
      else {
        const input = document.createElement("textarea");
        input.value = url;
        input.setAttribute("readonly", "");
        input.className = "sr-only";
        document.body.append(input);
        input.select();
        const copied = document.execCommand("copy");
        input.remove();
        if (!copied) throw new Error("copy failed");
      }
      showToast("题库链接已复制。");
    } catch (_) { showToast("复制失败，请直接复制浏览器地址。 "); }
  }

  function refresh() {
    if (document.hidden || state.submitting || state.loadingWords || Date.now() - state.lastRefresh < 25000) return;
    if (state.routeId !== null && state.library) loadWords({ quiet: true });
    else if (state.routeId === null) loadLibraries({ quiet: true });
  }

  $("#open-create").addEventListener("click", openCreate);
  $("#close-create").addEventListener("click", closeCreate);
  $("#create-dialog").addEventListener("click", (event) => { if (event.target === $("#create-dialog")) closeCreate(); });
  $("#create-dialog").addEventListener("cancel", (event) => { if ($("#create-submit").disabled) event.preventDefault(); });
  $("#create-dialog").addEventListener("close", () => document.body.classList.remove("modal-open"));
  $("#create-form").addEventListener("submit", createLibrary);
  $("#add-words-form").addEventListener("submit", addWords);
  $("#check-similar").addEventListener("click", checkSimilar);
  $("#close-delete").addEventListener("click", closeDelete);
  $("#confirm-delete").addEventListener("click", confirmDelete);
  $("#delete-dialog").addEventListener("click", (event) => { if (event.target === $("#delete-dialog")) closeDelete(); });
  $("#delete-dialog").addEventListener("cancel", (event) => { if ($("#confirm-delete").disabled) event.preventDefault(); });
  $("#delete-dialog").addEventListener("close", () => { document.body.classList.remove("modal-open"); if (!$("#confirm-delete").disabled) state.pendingDelete = null; });
  $("#words-input").addEventListener("input", updateInputCount);
  $("#library-search").addEventListener("input", () => { if (state.loaded) renderLibraries(); });
  $("#word-search").addEventListener("input", () => {
    clearTimeout(state.searchTimer);
    // Invalidate the previous response before waiting for the debounce.
    state.wordRequest++;
    state.query = $("#word-search").value.trim();
    state.page = 1;
    state.searchTimer = setTimeout(() => loadWords(), 260);
  });
  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action], [data-page], #share-library");
    if (!target || target.disabled) return;
    if (target.id === "share-library") { shareLibrary(); return; }
    if (target.dataset.page) {
      state.page = Number(target.dataset.page);
      loadWords();
      $("#words-title").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      return;
    }
    switch (target.dataset.action) {
      case "create": openCreate(); break;
      case "reload-libraries": loadLibraries(); break;
      case "reload-words": loadWords({ initial: !state.library }); break;
      case "focus-add": $("#words-input").focus(); $("#add-title").scrollIntoView({ behavior: "smooth", block: "center" }); break;
      case "clear-word-search": clearTimeout(state.searchTimer); $("#word-search").value = ""; state.query = ""; state.page = 1; loadWords(); break;
      case "delete-word": openDelete(target); break;
    }
  });
  window.addEventListener("hashchange", route);
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  try { $("#contributor").value = localStorage.getItem("huacai-contributor") || ""; } catch (_) { /* Storage is optional. */ }
  setInterval(refresh, 30000);
  route();
})();
