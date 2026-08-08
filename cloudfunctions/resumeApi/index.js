'use strict';
// 简历云函数（事件函数）
// 职责：把简历内容 / 照片 / 附件简历统一存到云端（云数据库 + 云存储），
// 使「本人编辑后，HR 访问网页也能看到同一份」。
// 前端通过 CloudBase Web SDK 的 callFunction 调用。
// 所有数据库 / 存储访问都在函数 admin 上下文内完成，HR 只需匿名 callFunction(action:'get') 即可读取；
// 写操作（saveContent/savePhoto/saveAttach/remove*）须携带正确的 RESUME_EDIT_KEY，避免访客随意篡改。

const cloudbase = require('@cloudbase/node-sdk');
const app = cloudbase.init({});
const db = app.database();
// 注意：本版本 @cloudbase/node-sdk 的存储方法直接挂在 app 上（app.uploadFile / app.getTempFileURL / app.deleteFile），
// 并没有 app.storage() 访问器，误用会触发「app.storage is not a function」导致函数加载即崩溃。

const COLL = 'resume_profile';
const DOC_ID = 'main';
const EDIT_KEY = process.env.RESUME_EDIT_KEY || '';

function keyOk(key) {
  if (!EDIT_KEY) return true;            // 未配置口令 = 开放写入（仅个人站点可接受）
  return key === EDIT_KEY;
}

const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'application/pdf': 'pdf', 'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/plain': 'txt'
};
function mimeExt(mime) { return MIME_EXT[mime] || 'bin'; }

async function getDoc() {
  try {
    const { data } = await db.collection(COLL).doc(DOC_ID).get();
    return (data && data[0]) || null;
  } catch (e) { return null; }
}

async function ensureColl() {
  try { await db.createCollection(COLL); }
  catch (e) { if (!/already|exist/i.test(e.message || String(e))) throw e; }
}

async function save(set) {
  await ensureColl();
  const cur = await getDoc();
  const merged = Object.assign({}, cur || {}, set, { updatedAt: Date.now() });
  delete merged._id;   // 不能更新 _id 字段
  await db.collection(COLL).doc(DOC_ID).set(merged);
}

async function urlFor(fileID) {
  if (!fileID) return '';
  try {
    const r = await app.getTempFileURL({ fileList: [{ fileID: fileID, maxAge: 24 * 3600 }] });
    const item = r.fileList && r.fileList[0];
    return (item && item.tempFileURL) || '';
  } catch (e) { return ''; }
}

function dataUrlToBuffer(dataUrl) {
  const m = String(dataUrl || '').match(/^data:([\w\/\-\.\+]+);base64,(.+)$/);
  if (!m) throw new Error('文件格式无法识别（须为 base64 data URL）');
  return { mime: m[1], buf: Buffer.from(m[2], 'base64') };
}

function safeName(name) {
  return String(name || '').replace(/[^\w\u4e00-\u9fa5\.\-\(\)（） ]/g, '').slice(0, 120) || 'attachment';
}

exports.main = async (event) => {
  const action = (event && event.action) || '';
  try {
    switch (action) {
      case 'get': {
        const doc = await getDoc();
        const photoUrl = await urlFor(doc && doc.photoFileID);
        const attachUrl = await urlFor(doc && doc.attachFileID);
        return {
          ok: true,
          content: (doc && doc.content) || '',
          photoUrl,
          attachName: (doc && doc.attachName) || '',
          attachUrl,
          updatedAt: (doc && doc.updatedAt) || 0
        };
      }
      case 'saveContent': {
        if (!keyOk(event.key)) throw new Error('编辑口令错误');
        const content = (event.content || '').toString();
        if (content.length > 1.5 * 1024 * 1024) throw new Error('内容过大（超过 1.5MB）');
        await save({ content });
        return { ok: true };
      }
      case 'savePhoto': {
        if (!keyOk(event.key)) throw new Error('编辑口令错误');
        const { mime, buf } = dataUrlToBuffer(event.data);
        if (!/^image\//.test(mime)) throw new Error('照片须为图片格式');
        if (buf.length > 2 * 1024 * 1024) throw new Error('照片过大（超过 2MB），请压缩后再传');
        const cur = await getDoc();
        if (cur && cur.photoFileID) { try { await app.deleteFile({ fileList: [cur.photoFileID] }); } catch (e) {} }
        const cloudPath = 'resume/photo_' + Date.now() + '_' + Math.floor(Math.random() * 1e4) + '.' + mimeExt(mime);
        const up = await app.uploadFile({ cloudPath, fileContent: buf });
        const fileID = (up && up.fileID) || up;
        await save({ photoFileID: fileID });
        const url = await urlFor(fileID);
        return { ok: true, photoUrl: url };
      }
      case 'saveAttach': {
        if (!keyOk(event.key)) throw new Error('编辑口令错误');
        const { mime, buf } = dataUrlToBuffer(event.data);
        if (buf.length > 8 * 1024 * 1024) throw new Error('附件过大（超过 8MB），请压缩后再传');
        const name = safeName(event.name) + '.' + mimeExt(mime);
        const cur = await getDoc();
        if (cur && cur.attachFileID) { try { await app.deleteFile({ fileList: [cur.attachFileID] }); } catch (e) {} }
        const cloudPath = 'resume/attach_' + Date.now() + '_' + Math.floor(Math.random() * 1e4) + '.' + mimeExt(mime);
        const up = await app.uploadFile({ cloudPath, fileContent: buf });
        const fileID = (up && up.fileID) || up;
        await save({ attachFileID: fileID, attachName: name });
        const url = await urlFor(fileID);
        return { ok: true, attachUrl: url, attachName: name };
      }
      case 'removePhoto': {
        if (!keyOk(event.key)) throw new Error('编辑口令错误');
        const cur = await getDoc();
        if (cur && cur.photoFileID) { try { await app.deleteFile({ fileList: [cur.photoFileID] }); } catch (e) {} }
        await save({ photoFileID: '' });
        return { ok: true };
      }
      case 'removeAttach': {
        if (!keyOk(event.key)) throw new Error('编辑口令错误');
        const cur = await getDoc();
        if (cur && cur.attachFileID) { try { await app.deleteFile({ fileList: [cur.attachFileID] }); } catch (e) {} }
        await save({ attachFileID: '', attachName: '' });
        return { ok: true };
      }
      default:
        throw new Error('未知 action：' + action);
    }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
};
