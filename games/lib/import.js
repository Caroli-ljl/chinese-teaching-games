/* =========================================================================
 * lib/import.js —— 共享「导入新 HTML」逻辑（教师端 / 首页 复用）
 * 功能：读取本地 HTML 文件 → 检测 GAME_TYPE → 存入 CloudBase imports 集合
 *       （upsert：同名 game_type 覆盖）。渲染由 play.html?gt= 负责。
 * 全局暴露：window.openImportModal()
 * 依赖：games/lib/cloudbase.full.js（须先于本文件引入）
 * 红线：禁止运行时 CDN；所有库本地化。
 * ========================================================================= */
(function () {
  'use strict';
  const ENV_ID = window.ENV_ID || '__ENV_ID__';
  const ACCESS_KEY = window.ACCESS_KEY || '__ACCESS_KEY__';

  let tcb = null, db = null, cloudPromise = null;
  function initCloud() {
    if (cloudPromise) return cloudPromise;
    cloudPromise = (async () => {
      if (!window.cloudbase) throw new Error('CloudBase SDK 未加载');
      tcb = window.cloudbase.init({ env: ENV_ID, region: 'ap-shanghai', accessKey: ACCESS_KEY, auth: { detectSessionInUrl: true } });
      const auth = (typeof tcb.auth === 'function') ? tcb.auth() : tcb.auth;
      const r = await auth.signInAnonymously();
      if (r && r.error) throw new Error((r.error.message || r.error.description) || '匿名登录失败');
      db = tcb.database();
      return true;
    })();
    return cloudPromise;
  }

  function toast(msg, bad) {
    let el = document.getElementById('impToast');
    if (!el) { el = document.createElement('div'); el.id = 'impToast'; el.style.cssText = 'position:fixed;left:50%;bottom:30px;transform:translateX(-50%);background:' + (bad ? '#ef4444' : '#1f2937') + ';color:#fff;padding:10px 18px;border-radius:999px;font-size:14px;z-index:200;opacity:0;transition:.25s;box-shadow:0 8px 24px rgba(0,0,0,.2)'; document.body.appendChild(el); }
    el.textContent = msg; el.style.opacity = '1';
    clearTimeout(el._t); el._t = setTimeout(() => { el.style.opacity = '0'; }, 2600);
  }

  function ensureModal() {
    if (document.getElementById('importMask')) return;
    const m = document.createElement('div');
    m.className = 'modal-mask'; m.id = 'importMask';
    m.innerHTML = '<div class="modal"><h3>＋ 导入新 HTML 游戏</h3>' +
      '<label style="font-size:13px;font-weight:600;display:block;margin:12px 0 5px">① 选择游戏 HTML 文件</label>' +
      '<input type="file" id="impFile" accept=".html,.htm" style="width:100%;padding:9px 11px;border:1px solid #f0e6d6;border-radius:10px;font-size:14px;font-family:inherit">' +
      '<label style="font-size:13px;font-weight:600;display:block;margin:12px 0 5px">② 游戏名称</label>' +
      '<input type="text" id="impName" placeholder="例如：我的课堂小游戏" style="width:100%;padding:9px 11px;border:1px solid #f0e6d6;border-radius:10px;font-size:14px;font-family:inherit">' +
      '<label style="font-size:13px;font-weight:600;display:block;margin:12px 0 5px">③ 游戏类型标识（GAME_TYPE，英文/数字）</label>' +
      '<input type="text" id="impGt" placeholder="留空则自动从文件中读取，否则用文件名生成" style="width:100%;padding:9px 11px;border:1px solid #f0e6d6;border-radius:10px;font-size:14px;font-family:inherit">' +
      '<div class="note" style="font-size:12px;color:#6b7280;line-height:1.6;background:#f4fbfa;border-left:3px solid #14b8a6;padding:8px 10px;border-radius:0 8px 8px 0;margin:10px 0">提示：导入的游戏若设置了 <code>window.GAME_TYPE</code> 并引用 <code>games/lib/common.js</code>，就能像其他游戏一样自动同步云端成绩与学情。内容保存在你的 CloudBase 环境内。</div>' +
      '<div class="row" style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px"><button class="btn" id="impCancel" style="border:1px solid #f0e6d6;background:#fff;padding:8px 14px;border-radius:10px;cursor:pointer">取消</button><button class="btn primary" id="impConfirm" style="background:#f59e0b;color:#fff;border:none;padding:8px 14px;border-radius:10px;cursor:pointer">导入并上线</button></div>' +
      '</div>';
    document.body.appendChild(m);
    m.addEventListener('click', e => { if (e.target === m) m.classList.remove('show'); });
    m.querySelector('#impCancel').addEventListener('click', () => m.classList.remove('show'));
    m.querySelector('#impConfirm').addEventListener('click', doImport);
  }

  window.openImportModal = function () {
    ensureModal();
    const m = document.getElementById('importMask');
    m.classList.add('show');
    const f = m.querySelector('#impFile'); if (f) f.value = '';
    const n = m.querySelector('#impName'); if (n) n.value = '';
    const g = m.querySelector('#impGt'); if (g) g.value = '';
  };

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsText(file);
    });
  }

  function slug(s) { return (s || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || ('imp_' + Date.now().toString(36)); }

  async function doImport() {
    const m = document.getElementById('importMask');
    const file = m.querySelector('#impFile').files[0];
    if (!file) { toast('请先选择 HTML 文件', true); return; }
    const name = (m.querySelector('#impName').value || '').trim() || file.name.replace(/\.html?$/i, '');
    let gt = (m.querySelector('#impGt').value || '').trim();
    try {
      const txt = await readFile(file);
      const auto = (txt.match(/window\.GAME_TYPE\s*=\s*['"]([^'"]+)['"]/) || [])[1];
      if (!gt) gt = auto || ('imp_' + slug(file.name));
      gt = slug(gt);
      await initCloud();
      if (!db) { toast('云端未连接，无法保存', true); return; }
      const { data } = await db.collection('imports').get();
      const exist = (data || []).find(d => d.game_type === gt);
      if (exist) {
        await db.collection('imports').doc(exist._id).update({ name: name, html: txt, ts: Date.now() });
      } else {
        await db.collection('imports').add({ game_type: gt, name: name, html: txt, ts: Date.now() });
      }
      m.classList.remove('show');
      toast('✅ 已导入「' + name + '」，可在教师端与首页直接打开');
      if (typeof window.refreshImportedGames === 'function') window.refreshImportedGames();
    } catch (e) {
      console.warn('import', e);
      toast('导入失败：' + (e && e.message ? e.message : e), true);
    }
  }

  // 供首页/教师端拉取已导入游戏列表
  window.loadImportedGames = async function () {
    await initCloud();
    if (!db) return [];
    try { const { data } = await db.collection('imports').get(); return (data || []).map(d => ({ game_type: d.game_type, name: d.name })); }
    catch (e) { return []; }
  };
})();
