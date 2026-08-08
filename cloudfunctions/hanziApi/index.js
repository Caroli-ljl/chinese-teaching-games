'use strict';

// 汉字词卡云函数（事件函数）
// ① generate：用 PAT 调用 Coze 工作流，返回智能词卡（word/pinyin/phrase/sentence/audio/image）
// ② add/list/setPhase/remove：云端读写「全班共享」汉字表（集合 hanzi_cards）
// 前端通过 CloudBase Web SDK 的 callFunction 调用，PAT 仅存于本函数环境变量，绝不进前端。

const cloudbase = require('@cloudbase/node-sdk');
const app = cloudbase.init({});
const db = app.database();
const _ = db.command;

const COZE_PAT = process.env.COZE_PAT || '';
const COZE_WORKFLOW_ID = process.env.COZE_WORKFLOW_ID || '';
const COZE_BOT_ID = process.env.COZE_BOT_ID || '7634067880002863133';
const COLL = 'hanzi_cards';
const PHASES = ['none', 'learning', 'review'];

// 从原文按字段名抓取（对畸形 / 多段拼接的 JSON 同样有效）
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
  if (!raw) return null;
  if (typeof raw !== 'string') {
    if (Array.isArray(raw)) { const o = {}; raw.forEach(x => { if (x && typeof x === 'object') Object.assign(o, x); }); return o; }
    return raw;
  }
  const s = String(raw).trim();
  let obj = null;
  try { obj = JSON.parse(s); } catch (e) { obj = null; }
  const KEYS = ['word', 'pinyin', 'phrase', 'sentence', 'audio', 'image', 'link'];
  if (obj && typeof obj === 'object') {
    // JSON 解析成功：用正则补全可能缺失的字段
    KEYS.forEach(k => { if (obj[k] === undefined || obj[k] === '') { const v = regexGet(s, k); if (v) obj[k] = v; } });
    return obj;
  }
  // 退路：纯正则逐字段抓取（兼容多段拼接 / 未转义内容）
  const o = {};
  KEYS.forEach(k => { o[k] = regexGet(s, k); });
  return o;
}

async function callCoze(word) {
  if (!COZE_PAT) throw new Error('云函数未配置 COZE_PAT 环境变量');
  if (!COZE_WORKFLOW_ID) throw new Error('云函数未配置 COZE_WORKFLOW_ID 环境变量');
  const resp = await fetch('https://api.coze.cn/v1/workflow/run', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + COZE_PAT,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      workflow_id: COZE_WORKFLOW_ID,
      parameters: { word: word },
      is_async: false
    })
  });
  const json = await resp.json().catch(() => ({}));
  if (json.code !== 0 && json.code !== '0') {
    let msg = json.msg || JSON.stringify(json);
    if (/plugin has reached the plan limit/i.test(msg)) {
      msg = 'Coze 工作流里的插件（图片 / 语音生成）本月调用次数已达上限，请到 Coze 升级套餐或更换插件后重试。';
    }
    throw new Error(msg);
  }
  const raw = json.data;
  const obj = parseCozeData(raw);
  const card = {
    word: dig(obj, 'word') || word,
    pinyin: dig(obj, 'pinyin') || '',
    phrase: dig(obj, 'phrase') || '',
    sentence: dig(obj, 'sentence') || '',
    audio: dig(obj, 'audio') || '',
    image: dig(obj, 'image') || '',
    link: dig(obj, 'link') || dig(obj, 'charAudio') || dig(obj, 'wordAudio') || dig(obj, 'pronunciation') || dig(obj, 'char_audio') || dig(obj, 'word_audio') || dig(obj, 'voice2') || ''
  };
  if (!card.pinyin && !card.phrase && !card.sentence && !card.audio && !card.image && !card.link) {
    throw new Error('Coze 工作流返回的内容为空（API 的 data 字段为空）。请到 Coze 检查：①工作流「结束」节点是否输出了包含 word/pinyin/phrase/sentence/audio/image 的结构化对象；②图片/语音生成插件额度是否耗尽（插件报错会让整段输出为空）。');
  }
  return card;
}

// ===== 智能体对话回退：工作流无结构化输出时，改走 Coze Bot Chat API =====
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function tryParseJson(s){ try{ return JSON.parse(s); }catch(e){ return null; } }
function extractMdImage(s){ const m=s.match(/!\[[^\]]*\]\(([^)]+)\)/); return m?m[1].trim():''; }
function normalizeCard(obj, fallbackWord){
  const get=(keys)=>{ for(const k of keys){ const v=dig(obj,k); if(v!==undefined&&v!==''&&v!==null) return (typeof v==='string')?v:String(v); } return ''; };
  return {
    word: get(['word','汉字','字']) || fallbackWord,
    pinyin: get(['pinyin','拼音']),
    phrase: get(['phrase','词语','词组','组词']),
    sentence: get(['sentence','句子','例句']),
    image: get(['image','图片','图']),
    audio: get(['audio','发音','音频','语音']),
    link: get(['link','charAudio','wordAudio','pronunciation','发音2','第二发音','音频2'])
  };
}
function parseBotText(text, fallbackWord){
  if(!text) return { word:fallbackWord, rawText:text };
  let obj = tryParseJson(text);
  if(!obj){
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if(fence) obj = tryParseJson(fence[1].trim());
  }
  if(obj && typeof obj==='object'){
    const card = normalizeCard(obj, fallbackWord);
    card.rawText = text;
    return card;
  }
  // 标签式解析：兼容「拼音：nǐ」「pinyin: nǐ」等自由文本
  const pick=(labels)=>{ for(const l of labels){ const re=new RegExp('(?:^|\\n)\\s*'+l+'\\s*[:：]\\s*([^\\n]+)','i'); const m=text.match(re); if(m) return m[1].trim(); } return ''; };
  const word = pick(['汉字','字','word']) || fallbackWord;
  const pinyin = pick(['拼音','pinyin']);
  const phrase = pick(['词语','词组','组词','phrase']);
  const sentence = pick(['句子','例句','sentence']);
  let image = pick(['图片','图','image']); if(!image) image = extractMdImage(text);
  const audio = pick(['发音','音频','语音','audio','voice']);
  const link = pick(['link','发音2','第二发音','音频2']);
  return { word, pinyin, phrase, sentence, image, audio, link, rawText:text };
}
async function callCozeBot(word){
  if(!COZE_PAT) throw new Error('云函数未配置 COZE_PAT 环境变量');
  if(!COZE_BOT_ID) throw new Error('云函数未配置 COZE_BOT_ID 环境变量');
  // 1) 发起对话（Coze 国内版对话接口为 /v3/chat）
  const chatResp = await fetch('https://api.coze.cn/v3/chat', {
    method:'POST',
    headers:{ 'Authorization':'Bearer '+COZE_PAT, 'Content-Type':'application/json' },
    body: JSON.stringify({
      bot_id: COZE_BOT_ID,
      user_id: 'jialu_card_student',
      stream: false,
      auto_save_history: false,
      additional_messages:[ { role:'user', content:'请为汉字「'+word+'」生成智能词卡', content_type:'text' } ]
    })
  });
  const chatJson = await chatResp.json().catch(()=>({}));
  if(chatJson.code!==0 && chatJson.code!=='0'){
    let msg = chatJson.msg || JSON.stringify(chatJson);
    if(/Insufficient coze credits|4028/i.test(msg)) msg='Coze 账户额度（credits）已耗尽，汉字词卡暂无法生成。请到 Coze 充值 / 升级付费版后重试。';
    throw new Error(msg);
  }
  const chatId = chatJson.data.id;
  const conversationId = chatJson.data.conversation_id;
  // 2) 轮询直到完成
  let status='in_progress';
  for(let i=0;i<35;i++){
    await sleep(1000);
    const r = await fetch('https://api.coze.cn/v3/chat/'+chatId+'/retrieve',{ headers:{ 'Authorization':'Bearer '+COZE_PAT } });
    const j = await r.json().catch(()=>({}));
    if(j && j.data) status = j.data.status;
    if(status==='completed') break;
    if(status==='failed'){ const er=(j.data&&j.data.last_error)?JSON.stringify(j.data.last_error):''; throw new Error('Coze 智能体执行失败 '+er); }
  }
  if(status!=='completed') throw new Error('Coze 智能体响应超时，请稍后重试');
  // 3) 读取智能体回复
  const m = await fetch('https://api.coze.cn/v3/chat/'+chatId+'/message/list?conversation_id='+encodeURIComponent(conversationId),{ headers:{ 'Authorization':'Bearer '+COZE_PAT } });
  const mj = await m.json().catch(()=>({}));
  if(mj.code!==0 && mj.code!=='0') throw new Error(mj.msg||'读取智能体消息失败');
  const answers = (mj.data||[]).filter(x=>x.role==='assistant' && x.type==='answer').map(x=>x.content||'');
  const text = answers.join('\n').trim();
  if(!text) throw new Error('Coze 智能体未返回文本（消息列表为空）。请确认智能体已绑定词卡工作流，并在 Coze 内对话测试能看到输出。');
  const card = parseBotText(text, word);
  card.fromBot = true;
  return card;
}

// 在对象顶层或一层嵌套中查找字段（兼容 Coze 不同输出结构）
function dig(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (obj[key] !== undefined) return obj[key];
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object' && v[key] !== undefined) return v[key];
  }
  return undefined;
}

exports.main = async (event) => {
  const action = (event && event.action) || '';
  try {
    switch (action) {
      case 'generate': {
        const word = (event.word || '').trim();
        if (!word) throw new Error('请输入汉字');
        let card = null, usedBot = false, wfErr = null;
        try { card = await callCoze(word); }
        catch (e) { wfErr = (e && e.message) || String(e); }
        if (!card && wfErr) {
          // 工作流失败 / 返回空 → 回退到智能体对话输出
          try { card = await callCozeBot(word); usedBot = true; }
          catch (e) {
            const botErr = (e && e.message) || String(e);
            throw new Error('工作流出错：' + wfErr + '\n智能体也出错：' + botErr);
          }
        }
        if (card && typeof card === 'object') card.fromBot = usedBot;
        return { ok: true, card };
      }
      case 'add': {
        const card = event.card || {};
        const word = (card.word || '').trim();
        if (!word) throw new Error('词卡缺少 word 字段');
        const { data: exist } = await db.collection(COLL).where({ word }).limit(1).get();
        if (exist && exist.length) {
          const id = exist[0]._id;
          await db.collection(COLL).doc(id).update({
            pinyin: card.pinyin, phrase: card.phrase,
            sentence: card.sentence, audio: card.audio, image: card.image, link: card.link
          });
          return { ok: true, card: Object.assign({}, exist[0], card), updated: true };
        }
        const doc = {
          word, pinyin: card.pinyin || '', phrase: card.phrase || '',
          sentence: card.sentence || '', audio: card.audio || '', image: card.image || '',
          link: card.link || '',
          phase: 'none', createdAt: Date.now()
        };
        const res = await db.collection(COLL).add(doc);
        return { ok: true, card: Object.assign({ _id: res.id || res._id }, doc), updated: false };
      }
      case 'init': {
        try { await db.createCollection(COLL); } catch (e) {
          if (!/already|exist/i.test(e.message || String(e))) throw e;
        }
        return { ok: true, collection: COLL };
      }
      case 'list': {
        const { data } = await db.collection(COLL).orderBy('createdAt', 'asc').limit(1000).get();
        return { ok: true, cards: data || [] };
      }
      case 'setPhase': {
        const ids = event.ids || [];
        const phase = event.phase;
        if (!Array.isArray(ids) || !ids.length) throw new Error('缺少 ids');
        if (!PHASES.includes(phase)) throw new Error('非法的 phase：' + phase);
        const r = await db.collection(COLL).where({ _id: _.in(ids) }).update({ phase });
        return { ok: true, updated: (r && r.updated) || ids.length };
      }
      case 'remove': {
        const ids = event.ids || [];
        if (!Array.isArray(ids) || !ids.length) throw new Error('缺少 ids');
        const r = await db.collection(COLL).where({ _id: _.in(ids) }).remove();
        return { ok: true, removed: (r && r.removed) || ids.length };
      }
      default:
        throw new Error('未知 action：' + action);
    }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
};
