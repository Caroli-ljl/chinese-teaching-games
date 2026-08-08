'use strict';

// 全站内容编辑器 · 后端代理（事件函数）
// 职责：
//   ① load  —— 返回 portfolio_content 集合全部文档（前端据此覆盖页面文案）
//   ② save  —— 校验口令（服务端，绝不信任前端）后，逐条写入 / 更新文档
// 前端（content.js）只通过本函数读写内容；只有知道 CONTENT_PASSCODE 的人才能改。
// 数据库访问走函数管理员身份（@cloudbase/node-sdk 在云函数内默认具备环境内管理员权限），
// 与前端匿名登录的安全规则解耦，因此即便集合对客户端只读/禁写也不影响本函数写入。

const cloudbase = require('@cloudbase/node-sdk');
const app = cloudbase.init({});
const db = app.database();

const COLL = 'portfolio_content';
// 不设置默认值：未配置环境变量时 fail-closed（拒绝任何写入），避免默认口令泄露后被滥改。
const PASSCODE = process.env.CONTENT_PASSCODE || '';

exports.main = async (event, context) => {
  try {
    const body = (typeof event === 'string') ? JSON.parse(event || '{}') : (event || {});
    const action = body.action || 'load';

    if (action === 'load') {
      const res = await db.collection(COLL).limit(1000).get();
      const items = (res.data || []).map(d => ({ key: d._id, html: d.html, updatedAt: d.updatedAt || 0 }));
      return { ok: true, items };
    }

    if (action === 'save') {
      // 口令服务端校验：前端传来的 passcode 必须与环境变量一致
      const passcode = body.passcode || '';
      if (!PASSCODE || passcode !== PASSCODE) {
        return { ok: false, code: 'FORBIDDEN', message: '口令错误，无写入权限' };
      }
      const items = Array.isArray(body.items) ? body.items : [];
      let ok = 0, fail = 0, errors = [];
      for (const it of items) {
        if (!it || !it.key || typeof it.html !== 'string') { fail++; continue; }
        // 只允许字母数字、冒号、斜杠、下划线、横线（防注入/越权 doc id）
        if (!/^[\w/:.\-]+$/.test(it.key)) { fail++; errors.push(it.key + ':badKey'); continue; }
        try {
          await db.collection(COLL).doc(it.key).set({ html: it.html, updatedAt: Date.now() });
          ok++;
        } catch (e) {
          fail++;
          errors.push(it.key + ':' + (e.message || 'err'));
        }
      }
      return { ok: true, saved: ok, failed: fail, errors };
    }

    if (action === 'del') {
      const passcode = body.passcode || '';
      if (!PASSCODE || passcode !== PASSCODE) {
        return { ok: false, code: 'FORBIDDEN', message: '口令错误，无删除权限' };
      }
      const keys = Array.isArray(body.keys) ? body.keys : [];
      let ok = 0, fail = 0;
      for (const k of keys) {
        if (!/^[\w/:.\-]+$/.test(k)) { fail++; continue; }
        try { await db.collection(COLL).doc(k).remove(); ok++; } catch (e) { fail++; }
      }
      return { ok: true, removed: ok, failed: fail };
    }

    return { ok: false, code: 'BAD_ACTION', message: '未知 action：' + action };
  } catch (e) {
    return { ok: false, code: 'SERVER_ERROR', message: e.message || String(e) };
  }
};
