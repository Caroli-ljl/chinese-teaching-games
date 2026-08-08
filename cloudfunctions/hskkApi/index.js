'use strict';

// HSKK 易错发音档案 · 云函数
// 实时读取飞书多维表格，将姓名匿名化后返回给前端展示。
// 飞书凭证仅存于环境变量，不进入前端。

const cloudbase = require('@cloudbase/node-sdk');
cloudbase.init({});

const APP_ID = process.env.FEISHU_APP_ID || '';
const APP_SECRET = process.env.FEISHU_APP_SECRET || '';
// 不写死默认值：飞书多维表格的 app_token / table_id 属敏感标识，必须从环境变量读取。
const APP_TOKEN = process.env.FEISHU_APP_TOKEN || '';
const TABLE_ID = process.env.FEISHU_TABLE_ID || '';
const FIELD_DATE = process.env.FIELD_DATE || '日期';
const FIELD_NAME = process.env.FIELD_NAME || '姓名';
const FIELD_WORD = process.env.FIELD_WORD || '生词/句子';
const FIELD_CORR = process.env.FIELD_CORR || '纠音方法';

let _token = null;
let _exp = 0;

async function getFeishuToken() {
  const now = Date.now();
  if (_token && _exp > now) return _token;
  if (!APP_ID || !APP_SECRET) throw new Error('云函数未配置 FEISHU_APP_ID / FEISHU_APP_SECRET');
  const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET })
  });
  const j = await r.json().catch(() => ({}));
  if (j.code !== 0) throw new Error('获取飞书 tenant_access_token 失败：' + (j.msg || JSON.stringify(j)));
  _token = j.tenant_access_token;
  _exp = now + (Number(j.expire) - 60) * 1000;
  return _token;
}

async function listRecords() {
  const token = await getFeishuToken();
  let all = [];
  let pageToken = '';
  do {
    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records?page_size=500${pageToken ? '&page_token=' + pageToken : ''}`;
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    const j = await r.json().catch(() => ({}));
    if (j.code !== 0) throw new Error('读取飞书多维表格失败：' + (j.msg || JSON.stringify(j)));
    all = all.concat(j.data.items || []);
    pageToken = j.data.page_token || '';
    if (!j.data.has_more) break;
  } while (pageToken);
  return all;
}

function fmtDate(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number') {
    const d = new Date(v);
    if (!isNaN(d.getTime())) {
      return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    }
  }
  if (typeof v === 'string') return v.trim();
  if (v && typeof v === 'object' && v.text) return v.text;
  return String(v);
}

function anonymize(items) {
  // 1) 收集全部真实姓名（去重）
  const rawNames = [];
  items.forEach(it => {
    const f = it.fields || {};
    const rn = f[FIELD_NAME] ? String(f[FIELD_NAME]).trim() : '';
    if (rn && rawNames.indexOf(rn) === -1) rawNames.push(rn);
  });
  // 2) 按姓名排序后稳定编号：同一真实姓名始终对应同一「学员N」，不随飞书返回顺序变化
  rawNames.sort((a, b) => a.localeCompare(b, 'zh'));
  const nameMap = new Map();
  rawNames.forEach((rn, i) => nameMap.set(rn, '学员' + (i + 1)));

  // 3) 内容脱敏：把正文中出现的真实姓名（长度>=2，降低误伤）替换为对应匿名标签。
  //    先按姓名长度降序替换，避免短名误替换长名子串。
  const redactPairs = rawNames
    .filter(rn => rn.length >= 2)
    .sort((a, b) => b.length - a.length)
    .map(rn => [rn, nameMap.get(rn)]);
  function redact(s) {
    if (!s) return s;
    let out = String(s);
    for (const [rn, label] of redactPairs) {
      if (rn && out.indexOf(rn) !== -1) out = out.split(rn).join(label);
    }
    return out;
  }

  const rows = items.map(it => {
    const f = it.fields || {};
    const rawName = f[FIELD_NAME] ? String(f[FIELD_NAME]).trim() : '';
    const label = rawName ? (nameMap.get(rawName) || '匿名') : '匿名';
    return {
      date: fmtDate(f[FIELD_DATE]),
      student: label,
      content: redact(f[FIELD_WORD] ? String(f[FIELD_WORD]) : ''),
      correction: redact(f[FIELD_CORR] ? String(f[FIELD_CORR]) : '')
    };
  });
  // 按日期倒序，yyyy/MM/dd 字符串可直接比较
  rows.sort((a, b) => b.date.localeCompare(a.date));
  return rows;
}

exports.main = async (event) => {
  try {
    const action = (event && event.action) || 'list';
    if (action !== 'list') return { ok: false, error: '未知 action：' + action };
    const items = await listRecords();
    const data = anonymize(items);
    return { ok: true, data, total: data.length };
  } catch (e) {
    console.error('hskkApi error', e);
    return { ok: false, error: (e && e.message) || String(e) };
  }
};
