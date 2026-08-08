/*!
 * content.js —— 全站「可编辑 + 实时存 CloudBase 后台」模块（通用版）
 * 依赖：games/lib/cloudbase.full.js（window.cloudbase，UMD）
 * 设计要点：
 *   1) 页面加载时经云函数 contentApi 拉取已保存内容并覆盖（data-ckey 显式键 或 auto:路径 自动键）
 *   2) 侧栏/隐藏点「管理」输入口令后，才显示「编辑」按钮；口令仅用于解锁 UI
 *   3) 真正写入由云函数 contentApi 完成，且服务端再次校验口令 —— 只有知道口令的人才能改
 *   4) 进入编辑态后，自动把页面上【每一个含直接文本的叶子容器】设为可编辑（无需手动打标签），
 *      含 data-ckey 的元素同样可编辑；保存时按键回写后台。
 *   5) 普通访客看不到任何编辑入口，内容照常显示。
 */
(function () {
  const ENV_ID = window.ENV_ID || "__ENV_ID__";
  const REGION = "ap-shanghai";
  const FN = "contentApi";

  let app = null;
  const cache = {};                 // key -> html
  let editMode = false;
  let saveTimer = null;
  let unlocked = false;
  let passcode = "";
  let editBtn = null;

  /* ===== 样式注入 ===== */
  function injectStyle() {
    if (document.getElementById("cbEditorStyle")) return;
    const s = document.createElement("style");
    s.id = "cbEditorStyle";
    s.textContent = `
      [data-cb-chrome]{ }
      body.cb-editing [contenteditable="true"]{
        outline:2px dashed #6d5dfc; outline-offset:4px; border-radius:6px;
        cursor:text; transition:outline-color .15s;
      }
      body.cb-editing [contenteditable="true"]:hover{ outline-color:#a78bfa; }
      #cbEditBtn{ position:fixed; top:14px; right:14px; z-index:128;
        background:#6d5dfc; color:#fff; border:none; border-radius:10px;
        padding:9px 14px; font-weight:700; font-size:14px; cursor:pointer;
        box-shadow:0 6px 18px rgba(109,93,252,.4); font-family:inherit; }
      #cbEditBtn:disabled{ opacity:.6; cursor:default; }
      .cbAdminEntry{ cursor:pointer; font-family:inherit; }
      #cbToast{ position:fixed; top:60px; right:14px; z-index:130; background:#fff;
        border:1px solid #edeae2; border-radius:10px; padding:8px 12px; font-size:13px;
        box-shadow:0 6px 18px rgba(0,0,0,.12); transition:opacity .3s; opacity:0;
        font-family:inherit; max-width:280px; }
    `;
    document.head.appendChild(s);
  }

  /* ===== Toast ===== */
  function toast(msg, ok) {
    let t = document.getElementById("cbToast");
    if (!t) {
      t = document.createElement("div");
      t.id = "cbToast";
      document.body.appendChild(t);
    }
    t.textContent = (ok === false ? "⚠️ " : "✅ ") + msg;
    t.style.color = ok === false ? "#b45309" : "#15803d";
    t.style.opacity = "1";
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.style.opacity = "0"; }, 2800);
  }

  /* ===== 初始化 CloudBase（匿名登录，仅用于调用云函数）===== */
  async function ensureApp() {
    if (app) return app;
    if (!window.cloudbase) { console.error("cloudbase SDK 未加载"); return null; }
    app = window.cloudbase.init({ env: ENV_ID, region: REGION });
    try { await app.auth().signInAnonymously(); } catch (e) { /* 已登录则忽略 */ }
    return app;
  }

  async function callApi(action, extra) {
    const a = await ensureApp();
    if (!a) return null;
    try {
      const r = await a.callFunction({ name: FN, data: Object.assign({ action }, extra || {}) });
      return r && r.result ? r.result : (r || null);
    } catch (e) {
      console.error("contentApi call failed", e);
      return null;
    }
  }

  /* ===== 拉取全部已保存内容 ===== */
  async function loadAll() {
    const res = await callApi("load");
    if (res && res.ok && Array.isArray(res.items)) {
      res.items.forEach(it => { if (it && it.key) cache[it.key] = it.html; });
    }
    applyAll();
  }

  function resolveAuto(key) {
    const parts = key.slice(5).split("/");
    let node = document.body;
    for (const p of parts) {
      const seg = p.split(":");
      const tag = seg[0], idx = parseInt(seg[1], 10) - 1;
      const sibs = [...node.children].filter(c => !c.hasAttribute("data-cb-chrome"));
      node = sibs[idx];
      if (!node || node.tagName.toLowerCase() !== tag) return null;
    }
    return node;
  }

  /* 结构容器保护：auto: 位置键一旦因 DOM 变更错位解析到容器，整体替换 innerHTML 会清空整块内容。
     因此对 auto: 键命中以下容器时跳过套用，只保留叶子/小文本覆盖。data-ckey 显式键为人工指定，仍照常套用。 */
  function isStructuralContainer(el) {
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    if (["main","header","aside","nav","footer","section","article","form","table","ul","ol","body","html"].includes(tag)) return true;
    if (el.children.length > 6) return true;
    if (el.querySelector("#gameGrid, #worksTabs, .panel, form, table, canvas, iframe, .el-tabs, .el-tabs__content, .grid, .gamesWrap, .wrap")) return true;
    return false;
  }

  function applyAll() {
    Object.keys(cache).forEach(key => {
      let el = null;
      if (key.indexOf("auto:") === 0) el = resolveAuto(key);
      else el = document.querySelector('[data-ckey="' + cssEscape(key) + '"]');
      if (!el || cache[key] == null) return;
      if (key.indexOf("auto:") === 0 && isStructuralContainer(el)) {
        console.warn("[content] 跳过 auto: 结构容器覆盖，避免清空页面：", key);
        return;
      }
      el.innerHTML = cache[key];
    });
  }

  function cssEscape(s) {
    return s.replace(/["\\]/g, "\\$&");
  }

  /* ===== 编辑态：自动标记可编辑区域 ===== */
  const EXCLUDE_TAGS = "SCRIPT,STYLE,HEAD,META,LINK,BR,INPUT,TEXTAREA,SELECT,OPTION,IMG,SVG,PATH,CANVAS,BUTTON,CODE,PRE";
  function isExcludedTag(el) { return el.matches(EXCLUDE_TAGS); }
  function hasDirectText(el) {
    return [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 0);
  }
  function canEdit(el) {
    if (!el || el.closest("[data-cb-chrome]")) return false;
    if (isExcludedTag(el)) return false;
    if (el.hasAttribute("data-noedit") || el.closest("[data-noedit]")) return false;
    return true;
  }

  function autoKey(el) {
    const parts = [];
    let node = el;
    while (node && node !== document.body) {
      if (node.parentNode) {
        const sibs = [...node.parentNode.children].filter(c => !c.hasAttribute("data-cb-chrome"));
        const idx = sibs.indexOf(node) + 1;
        parts.unshift(node.tagName.toLowerCase() + ":" + idx);
      }
      node = node.parentNode;
    }
    return "auto:" + parts.join("/");
  }

  function setEditable(el, on) {
    el.setAttribute("contenteditable", on ? "true" : "false");
  }

  function enterEdit() {
    const marked = new Set();
    // 1) 显式 data-ckey
    document.querySelectorAll("[data-ckey]").forEach(el => {
      if (canEdit(el)) { setEditable(el, true); marked.add(el); }
    });
    // 2) 自动：含直接文本的叶子容器（其后代自动继承可编辑，不再单独标记）
    document.querySelectorAll("body *").forEach(el => {
      if (!canEdit(el)) return;
      if (el.hasAttribute("data-ckey")) return;
      if ([...marked].some(m => m.contains(el) && m !== el)) return; // 已是某可编辑元素的后代
      if (!hasDirectText(el)) return;
      setEditable(el, true);
      marked.add(el);
    });
    document.body.classList.add("cb-editing");
  }

  function exitEdit() {
    document.querySelectorAll('[contenteditable="true"]').forEach(el => setEditable(el, false));
    document.body.classList.remove("cb-editing");
  }

  /* 编辑态下统一监听输入（防抖保存） */
  let dirty = false;
  document.addEventListener("input", e => {
    if (editMode && e.target.closest && e.target.closest('[contenteditable="true"]')) { dirty = true; scheduleSave(); }
  });

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveAll().then(() => { dirty = false; }); }, 800);
  }

  /* 实时保存兜底：切后台 / 关页面前把未保存改动落库，避免换设备丢失 */
  function flushOnHide() {
    if (editMode && dirty) {
      clearTimeout(saveTimer);
      saveAll().then(() => { dirty = false; });
    }
  }
  document.addEventListener("visibilitychange", () => { if (document.hidden) flushOnHide(); });
  window.addEventListener("pagehide", flushOnHide);
  window.addEventListener("beforeunload", flushOnHide);

  /* ===== 保存到云函数（服务端再校验口令）===== */
  async function saveAll() {
    const els = [...document.querySelectorAll('[contenteditable="true"]')];
    if (!els.length) return { saved: 0, failed: 0 };
    const items = els.map(el => ({
      key: el.getAttribute("data-ckey") || autoKey(el),
      html: el.innerHTML
    }));
    const res = await callApi("save", { passcode, items });
    if (!res || !res.ok) {
      toast((res && res.message) || "保存失败（口令可能错误）", false);
      return { saved: 0, failed: items.length };
    }
    items.forEach(it => { cache[it.key] = it.html; });
    if (res.failed > 0) toast("已保存 " + res.saved + " 项，失败 " + res.failed + " 项", false);
    else toast("已保存到云端 ✓");
    return res;
  }

  /* ===== 管理入口：口令门（默认对访客隐藏，仅编辑态可见） ===== */
  var adminEntry = null;
  function buildAdminEntry() {
    const bar = document.getElementById("sidebar");
    if (bar) {
      const link = document.createElement("button");
      link.type = "button";
      link.className = "cbAdminEntry";
      link.setAttribute("data-cb-chrome", "");
      link.textContent = "⚙️ 管理";
      link.title = "内容管理（需口令）· 快捷键 Ctrl+Shift+E";
      link.style.cssText =
        "margin-top:8px;width:100%;text-align:left;background:none;border:none;" +
        "color:var(--muted);font-size:12px;padding:8px 12px;border-radius:8px;cursor:pointer;font-family:inherit";
      link.onmouseenter = () => link.style.background = "var(--bg)";
      link.onmouseleave = () => link.style.background = "none";
      link.onclick = tryUnlock;
      bar.appendChild(link);
      adminEntry = link;
    } else {
      // 无侧栏页面：编辑态才显示隐蔽触发点（默认隐藏，避免对外暴露后台入口）
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "cbAdminEntry";
      dot.setAttribute("data-cb-chrome", "");
      dot.title = "内容管理（需口令）· 快捷键 Ctrl+Shift+E";
      dot.textContent = "⚙";
      dot.style.cssText =
        "position:fixed;top:62px;right:14px;z-index:2147483000;width:30px;height:30px;border-radius:8px;" +
        "background:rgba(109,93,252,.10);border:1px solid rgba(109,93,252,.25);color:rgba(109,93,252,.55);" +
        "font-size:16px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;";
      dot.onmouseenter = () => { dot.style.background = "rgba(109,93,252,.20)"; dot.style.color = "rgba(109,93,252,.9)"; };
      dot.onmouseleave = () => { dot.style.background = "rgba(109,93,252,.10)"; dot.style.color = "rgba(109,93,252,.55)"; };
      dot.onclick = tryUnlock;
      document.body.appendChild(dot);
      adminEntry = dot;
    }
    if (adminEntry) adminEntry.style.display = "none"; // 默认对访客隐藏
  }

  // 快捷键 Ctrl+Shift+E 打开管理（任何页面）
  document.addEventListener("keydown", e => {
    if (e.ctrlKey && e.shiftKey && (e.key === "E" || e.key === "e")) {
      e.preventDefault();
      tryUnlock();
    }
  });

  function tryUnlock() {
    if (unlocked) { showEditBtn(); return; }
    const input = prompt("请输入编辑口令：");
    if (input === null) return;
    passcode = input;
    unlocked = true;          // 仅解锁 UI；真正写入仍由服务端校验口令
    showEditBtn();
    toast("已解锁编辑（保存时需口令）");
  }

  function showEditBtn() {
    if (adminEntry) adminEntry.style.display = ""; // 解锁后显示管理入口
    if (editBtn) { editBtn.style.display = "block"; return; }
    editBtn = document.createElement("button");
    editBtn.id = "cbEditBtn";
    editBtn.setAttribute("data-cb-chrome", "");
    editBtn.textContent = "✏️ 编辑";
    editBtn.onclick = async () => {
      if (!editMode) {
        editMode = true; enterEdit();
        editBtn.textContent = "✅ 完成";
      } else {
        editBtn.disabled = true; editBtn.textContent = "⏳ 保存中…";
        await saveAll();
        editMode = false; exitEdit();
        editBtn.textContent = "✏️ 编辑"; editBtn.disabled = false;
      }
    };
    document.body.appendChild(editBtn);
  }

  document.addEventListener("DOMContentLoaded", () => {
    injectStyle();
    buildAdminEntry();
    loadAll();
    // 延迟重试套用：覆盖游戏页等 JS 异步渲染的内容（首屏 DOMContentLoaded 时尚未生成）
    [800, 2000, 4000].forEach(d => setTimeout(applyAll, d));
    // 元素出现即套用：若目标元素晚于 loadAll 才插入 DOM，也能及时套上云端覆盖值
    if ('MutationObserver' in window) {
      const mo = new MutationObserver(muts => {
        let need = false;
        for (const m of muts) {
          m.addedNodes.forEach(n => {
            if (n.nodeType === 1) {
              if (n.hasAttribute && n.hasAttribute('data-ckey')) need = true;
              else if (n.querySelector && n.querySelector('[data-ckey]')) need = true;
            }
          });
        }
        if (need) applyAll();
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }
  });

  window.CBContent = { loadAll, saveAll, applyAll };
})();
