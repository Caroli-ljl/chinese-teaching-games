'use strict';

// 学生语法错误档案 · 云函数（事件函数）
// 代理两个 Coze 工作流：
//   ① genImage ：学生输入词语 → 输出情景图片（辅助看图说话 / 造句）
//   ② correct  ：学生输入句子 → 调用 Coze 批改工作流，返回结构化批改结果（飞书写入由 saveCorrection 单独完成）
// 另提供图片云端存档（跨设备、持久）：
//   saveImage   ：下载 Coze 原图 → 服务端压缩（最长边 800px / JPEG q72）→ 上传云存储 → 写库
//   listImages  ：读取已存档图片（签发临时访问 URL，持久、换设备可见）
//   removeImage ：删除某条存档
// 前端通过 CloudBase Web SDK 的 callFunction 调用，PAT 仅存于本函数环境变量，绝不进前端。

const cloudbase = require('@cloudbase/node-sdk');
const app = cloudbase.init({});
const db = app.database();
const Jimp = require('jimp');

const COZE_PAT = process.env.COZE_PAT || '';
const COZE_IMG_WF = process.env.COZE_IMG_WF || '';        // 图片工作流 ID
const COZE_CORRECT_WF = process.env.COZE_CORRECT_WF || ''; // 批改工作流 ID

const IMG_KEYS = ['data', 'image', 'img', 'url', 'picture', 'pic', 'photo', 'image_url', 'img_url'];
const CORRECT_KEYS = [
  'correct', 'isCorrect', 'hasError', 'has_error', 'valid', 'ok', 'status',
  'errors', 'error', 'reason', 'explanation', 'feedback', 'comment',
  'corrected', 'correction', 'correctSentence', 'fixed', 'score', 'image'
];

// 大小写不敏感的字段提取（顶层 + 一层嵌套）
function findVal(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  const lower = keys.map(k => String(k).toLowerCase());
  for (const k of Object.keys(obj)) {
    if (lower.includes(k.toLowerCase())) {
      const v = obj[k];
      if (v !== undefined && v !== null && v !== '') return v;
    }
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object') {
      const r = findVal(v, keys);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

// 对畸形 / 多段拼接字符串按字段名抓取（大小写不敏感）
function regexGet(s, key) {
  const m = s.match(new RegExp('"' + key + '"\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|[^,}\\]\\r\\n]+)', 'i'));
  if (!m) return '';
  let v = m[1].trim();
  if (v.charAt(0) === '"' && v.charAt(v.length - 1) === '"') {
    try { return JSON.parse(v); } catch (e) { return v.slice(1, -1); }
  }
  return v;
}

function parseCozeData(raw) {
  if (!raw) return {};
  if (typeof raw !== 'string') {
    if (Array.isArray(raw)) { const o = {}; raw.forEach(x => { if (x && typeof x === 'object') Object.assign(o, x); }); return o; }
    return raw;
  }
  const s = String(raw).trim();
  try { return JSON.parse(s); } catch (e) { return {}; }
}

function extract(raw, keys) {
  const parsed = parseCozeData(raw);
  let v = findVal(parsed, keys);
  if (!v || !String(v).trim()) {
    const s = String(raw || '');
    for (const k of keys) { const r = regexGet(s, k); if (r) { v = r; break; } }
  }
  return { parsed, value: v };
}

// 在 Coze 工作流「结束」节点的输出里定位真正的批改字段。
// 兼容多种输出形态：
//   ① 扁平字段 {correct_sentence, error_reason, ...}
//   ② {records:[{fields:{...}}]}（records 是对象数组）
//   ③ 双层嵌套 {records:{records:[...]}}
//   ④ records 是「字符串化的 JSON 数组」"[{fields:{...}}]"（Coze 常见序列化）
function deepFindFields(obj) {
  const want = ['student_id', 'sentence', 'error_reason', 'correct_sentence', 'corrected', 'explanation', 'isCorrect', 'is_correct'];
  if (!obj || typeof obj !== 'object') return obj;
  if (want.some(k => obj[k] !== undefined)) return obj;
  // 先把 records 这一层（可能是字符串）尝试解析成对象/数组
  let rec = obj.records;
  if (typeof rec === 'string') {
    try { rec = JSON.parse(rec); } catch (e) { rec = null; }
  }
  if (Array.isArray(rec) && rec[0]) {
    if (rec[0].fields && typeof rec[0].fields === 'object') return rec[0].fields;
    if (typeof rec[0] === 'object') return rec[0];
  }
  if (rec && typeof rec === 'object') {
    // 双层嵌套 {records:{records:[...]}} 或 {records:[{fields}]}
    const inner = rec.records;
    if (Array.isArray(inner) && inner[0]) {
      if (inner[0].fields && typeof inner[0].fields === 'object') return inner[0].fields;
      if (typeof inner[0] === 'object') return inner[0];
    }
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object' && want.some(kk => v[kk] !== undefined)) return v;
  }
  return obj;
}

async function ensureColl(name) {
  try { await db.createCollection(name); }
  catch (e) { if (!/already|exist/i.test(e.message || String(e))) throw e; }
}
async function urlFor(fileID) {
  if (!fileID) return '';
  try {
    const r = await app.getTempFileURL({ fileList: [{ fileID: fileID, maxAge: 24 * 3600 }] });
    const item = r.fileList && r.fileList[0];
    return (item && item.tempFileURL) || '';
  } catch (e) { return ''; }
}

// ---- 飞书多维表格直写（不依赖 Coze 默认账号授权）----
// 思路：网页 → 本云函数 → 飞书开放平台 API 直写，彻底绕开 Coze 工作流在 API 调用时
// 不携带「默认账号」飞书授权、导致网页端写不进飞书的问题。
let _fsToken = null, _fsExp = 0;
async function getFeishuToken() {
  const id = process.env.FEISHU_APP_ID, secret = process.env.FEISHU_APP_SECRET;
  if (!id || !secret) throw new Error('云函数未配置飞书凭证：请在云函数环境变量设置 FEISHU_APP_ID 与 FEISHU_APP_SECRET');
  const now = Date.now();
  if (_fsToken && _fsExp > now) return _fsToken;
  const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: id, app_secret: secret })
  });
  const j = await r.json().catch(() => ({}));
  if (j.code !== 0) throw new Error('获取飞书 tenant_access_token 失败：' + (j.msg || JSON.stringify(j)));
  _fsToken = j.tenant_access_token; _fsExp = now + (Number(j.expire) - 60) * 1000;
  return _fsToken;
}
async function writeFeishuRecord(fields) {
  const appToken = process.env.FEISHU_BITABLE_APP_TOKEN, tableId = process.env.FEISHU_BITABLE_TABLE_ID;
  if (!appToken || !tableId) throw new Error('云函数未配置飞书多维表格：请在环境变量设置 FEISHU_BITABLE_APP_TOKEN 与 FEISHU_BITABLE_TABLE_ID');
  const token = await getFeishuToken();
  const url = 'https://open.feishu.cn/open-apis/bitable/v1/apps/' + appToken + '/tables/' + tableId + '/records';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ fields })
  });
  const j = await r.json().catch(() => ({}));
  if (j.code !== 0) throw new Error('写入飞书多维表格失败：' + (j.msg || JSON.stringify(j)));
  return j.data;
}

async function callCoze(workflowId, params) {
  if (!COZE_PAT) throw new Error('云函数未配置 COZE_PAT 环境变量');
  if (!workflowId) throw new Error('云函数未配置工作流 ID 环境变量（COZE_IMG_WF / COZE_CORRECT_WF）');
  const resp = await fetch('https://api.coze.cn/v1/workflow/run', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + COZE_PAT,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      workflow_id: workflowId,
      parameters: params,
      is_async: false
    })
  });
  const json = await resp.json().catch(() => ({}));
  if (json.code !== 0 && json.code !== '0') {
    let msg = json.msg || JSON.stringify(json);
    if (/plugin has reached the plan limit/i.test(msg)) {
      msg = 'Coze 工作流里的图片 / 语音插件本月调用次数已达上限，请到 Coze 升级套餐或更换插件后重试。';
    } else if (/insufficient coze credits|quota/i.test(msg)) {
      msg = 'Coze 账户额度（credits）已不足，工作流无法执行。请到 Coze 充值或升级付费版后重试。';
    }
    throw new Error(msg);
  }
  return { data: json.data, debugUrl: json.debug_url || '' };
}

exports.main = async (event) => {
  const action = (event && event.action) || '';
  try {
    switch (action) {
      case 'genImage': {
        const word = (event.word || '').trim();
        if (!word) throw new Error('请输入词语');
        // 图片工作流「开始」节点输入变量名为 text
        const { data: raw, debugUrl } = await callCoze(COZE_IMG_WF, { text: word });
        const { parsed, value } = extract(raw, IMG_KEYS);
        if (!value || !String(value).trim()) {
          const hint = 'Coze 图片工作流未返回图片。常见原因都在 Coze 侧：\n' +
            '① 图片生成插件额度 / 权限不足——Coze 账户 credits 可能已耗尽（可看完整报错）；\n' +
            '② 工作流「结束」节点未把图片 URL 作为结构化输出——若你在 Coze 编辑器里能看到图、但接口 data 为空，就是这个问题，需把最终产出节点连到「结束」节点并声明输出变量。\n' +
            '请到 Coze 检查这两处；修复后本页面会自动显示图片，无需改代码。';
          throw new Error(hint + (raw ? '\n\n原始 data：' + String(raw).slice(0, 800) : '') + (debugUrl ? '\n\nCoze 调试：' + debugUrl : ''));
        }
        return { ok: true, data: parsed };
      }
      case 'correct': {
        const sentence = (event.sentence || '').trim();
        if (!sentence) throw new Error('请输入句子');
        // 批改工作流「开始」节点输入变量名为 text
        const { data: raw, debugUrl } = await callCoze(COZE_CORRECT_WF, { text: sentence });
        const parsed = parseCozeData(raw);
        // 归一化：兼容「结束」节点直接输出扁平字段，或输出 {records:[{fields:{...}}]} 嵌套结构
        const norm = deepFindFields(parsed);
        return { ok: true, data: norm, debugUrl };
      }
      case 'saveImage': {
        const word = (event.word || '').trim() || '未命名';
        const text = (event.text || '').trim();
        const imageUrl = (event.imageUrl || '').trim();
        if (!imageUrl) throw new Error('缺少图片地址');
        if (!/^https:\/\//i.test(imageUrl)) throw new Error('图片地址须为 https');
        if (!/(coze|byteimg|volc)\./i.test(imageUrl)) throw new Error('仅支持 Coze 生成的图片');
        // 1) 服务端下载原图（不受浏览器 CORS 限制）
        const resp = await fetch(imageUrl);
        if (!resp.ok) throw new Error('下载图片失败（HTTP ' + resp.status + '）');
        const buf = Buffer.from(await resp.arrayBuffer());
        // 2) 服务端压缩：最长边 800px、JPEG q72（画质下降但体积小、持久）
        const image = await Jimp.read(buf);
        const MAX = 800;
        if (image.bitmap.width >= image.bitmap.height) {
          if (image.bitmap.width > MAX) image.resize(MAX, Jimp.AUTO);
        } else {
          if (image.bitmap.height > MAX) image.resize(Jimp.AUTO, MAX);
        }
        const outBuf = await image.getBufferAsync(Jimp.MIME_JPEG, { quality: 72 });
        // 3) 上传云存储（压缩版）
        const cloudPath = 'archive/' + Date.now() + '_' + Math.floor(Math.random() * 1e4) + '.jpg';
        const up = await app.uploadFile({ cloudPath, fileContent: outBuf });
        const fileID = (up && up.fileID) || up;
        // 4) 写库
        await ensureColl('archive_images');
        const added = await db.collection('archive_images').add({ word, text, fileID, ts: Date.now() });
        const url = await urlFor(fileID);
        return { ok: true, fileID, url, id: (added && added.id) || '' };
      }
      case 'listImages': {
        await ensureColl('archive_images');
        const { data } = await db.collection('archive_images').orderBy('ts', 'desc').limit(100).get();
        const list = (data || []).map(d => ({ id: d._id, word: d.word, text: d.text, fileID: d.fileID, ts: d.ts }));
        if (list.length) {
          const r = await app.getTempFileURL({ fileList: list.map(x => ({ fileID: x.fileID, maxAge: 24 * 3600 })) });
          const map = {};
          (r.fileList || []).forEach((it, i) => { map[it.fileID || (list[i] && list[i].fileID)] = it.tempFileURL; });
          list.forEach(x => { x.url = map[x.fileID] || ''; });
        }
        return { ok: true, list };
      }
      case 'removeImage': {
        const id = (event.id || '').trim();
        const fileID = (event.fileID || '').trim();
        if (!id) throw new Error('缺少记录 id');
        if (fileID) { try { await app.deleteFile({ fileList: [fileID] }); } catch (e) {} }
        await db.collection('archive_images').doc(id).remove();
        return { ok: true };
      }
      case 'saveCorrection': {
        // 网页端批改后，把结果直写飞书多维表格（不依赖 Coze 默认账号）
        const sentence = (event.sentence || '').trim();
        const data = event.data || {};
        const student = (event.student || '').trim();
        if (!sentence) throw new Error('缺少原句');
        const corrected = findVal(data, ['correct_sentence', 'corrected', 'correction', 'correctSentence', 'fixed']);
        let explanation = findVal(data, ['error_reason', 'explanation', 'errors', 'error', 'reason', 'feedback', 'comment']);
        let studentId = findVal(data, ['student_id', 'student', 'name']) || student;
        // 结构化字段都没取到时，兜底把整段返回写进「错误原因」
        if ((corrected == null || !String(corrected).trim()) && (explanation == null || !String(explanation).trim())) {
          explanation = JSON.stringify(data, null, 2);
        }
        // 字段名映射：默认对齐用户飞书表真实列 student_id / sentence / error_reason / correct_sentence
        // 列名若变动，用环境变量 FEISHU_FIELDS 覆盖，如 {"sentence":"原句"}
        let fmap = { sentence: 'sentence', corrected: 'correct_sentence', explanation: 'error_reason', student: 'student_id' };
        try { const fm = process.env.FEISHU_FIELDS; if (fm) fmap = Object.assign(fmap, JSON.parse(fm)); } catch (e) {}
        const fields = {};
        if (fmap.sentence) fields[fmap.sentence] = sentence;
        if (fmap.corrected && corrected != null && String(corrected).trim()) fields[fmap.corrected] = String(corrected);
        if (fmap.explanation && explanation != null && String(explanation).trim()) fields[fmap.explanation] = String(explanation);
        if (fmap.student && studentId) fields[fmap.student] = studentId;
        if (!Object.keys(fields).length) throw new Error('没有可写入飞书的字段');
        await writeFeishuRecord(fields);
        return { ok: true };
      }
      default:
        throw new Error('未知 action：' + action);
    }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
};
