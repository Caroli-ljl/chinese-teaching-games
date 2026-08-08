/* =========================================================================
 * lib/common.js —— 中文教学游戏合集 · 共享内核
 * 一次编写，全合集复用。提供：
 *   • 中文发音引擎（百度真人普通话 + 有道真人兜底 + 本机中文嗓）
 *   • Web Audio 轻量音效 + 震动
 *   • Toast / Combo / Flash 失败四重提示（视觉+画面+声音+震动）
 *   • CloudBase 初始化与匿名登录（国内节点，微信不翻车）
 *   • 昵称关卡（开玩前必须填名字，成绩归属清晰）
 *   • 云端存分（自动附加 GAME_TYPE，教师端按游戏筛选）
 *   • 实时擂台（常驻前三名，监听变更即时刷新）
 *   • 双人对战 PK（同设备轮流上场，localStorage 战绩）
 *   • 跨设备联机对战（房间文档 + watch() + 1.5s 轮询兜底）
 *
 * 各游戏 HTML 需提供的全局（运行时已定义即可）：
 *   window.ENV_ID       CloudBase 环境 ID
 *   window.GAME_TYPE    本游戏类型标识（如 'emoji_match'）
 *   state               游戏状态对象（含 score/matched/attempts/playing 等）
 *   buildDeck()         返回当前牌组（联机/PK 使用）
 *   setupRound(cards)   用一副牌开局
 *   startGame()         开始游戏（内部含昵称关卡判断）
 * HTML 须包含的标准 DOM（id 一致）：
 *   #toast #comboPop #flash #overlay #liveboard #lbStatus
 *   #nickInput #nameOverlay #nameInput #nameConfirm #cloudDot #winAgain
 *   #netOverlay #cloudOverlay #netHud #pkOverlay #rankOverlay #soundOverlay
 *   以及各控制按钮（#soundBtn/#netBtn/#cloudBtn/#pkBtn/#rankBtn 等，可选）
 * ========================================================================= */
(function(){
'use strict';
const $ = s=>document.querySelector(s);
const ENV_ID = window.ENV_ID || '__ENV_ID__';
// CloudBase 前端初始化所需 publishable key（公开密钥）。
// 真实值来自站点根 config.js（由部署流水线从仓库 Secrets 注入），此处仅留占位兜底。
const ACCESS_KEY = window.ACCESS_KEY || '__ACCESS_KEY__';
const GT = ()=> window.GAME_TYPE || 'pinyin';

// ---------- 标准 DOM 引用 ----------
const toastEl=$('#toast'), comboPop=$('#comboPop'), flash=$('#flash');
const overlay=$('#overlay');
const netOverlay=$('#netOverlay'), cloudOverlay=$('#cloudOverlay');
const liveboard=document.getElementById('liveboard'), lbStatus=document.getElementById('lbStatus');
const nickInput=document.getElementById('nickInput');
const nameOverlay=document.getElementById('nameOverlay');
const nameInput=document.getElementById('nameInput');
const nameConfirm=document.getElementById('nameConfirm');
const cloudDot=document.getElementById('cloudDot');
const winAgainBtn=document.getElementById('winAgain');
const netHud=document.getElementById('netHud');
const pkOverlay=$('#pkOverlay'), rankOverlay=$('#rankOverlay');
const soundOverlay=$('#soundOverlay');

// ---------- 全局运行状态 ----------
let tcb=null, db=null, NICK=localStorage.getItem('hpm_nick')||'';
let cloudReady=false; let cloudPromise=null;
let netJustEnded=false;
let actx;

// ===================== 轻量音效（Web Audio，无需音频文件） =====================
function beep(freq,dur=0.12,type='sine'){
  unlockAudio();
  try{
    actx = actx || new (window.AudioContext||window.webkitAudioContext)();
    const o=actx.createOscillator(), g=actx.createGain();
    o.type=type; o.frequency.value=freq; o.connect(g); g.connect(actx.destination);
    g.gain.setValueAtTime(.18,actx.currentTime);
    g.gain.exponentialRampToValueAtTime(.0001,actx.currentTime+dur);
    o.start(); o.stop(actx.currentTime+dur);
  }catch(e){}
}
function vibrate(p){ try{ if(navigator.vibrate) navigator.vibrate(p); }catch(e){} }

// ===================== 发音引擎（只发中文汉语音） =====================
const P = {method:'baidu', tpl:'', autoSpeak:false, spd:3, vol:1};
let voices=[], zhVoice=null, audioUnlocked=false;
function loadPronounce(){ try{ const k=(GT())+'_pronounce'; const s=JSON.parse(localStorage.getItem(k)||'{}'); Object.assign(P,s); }catch(e){} }
function savePronounce(){ try{ localStorage.setItem((GT())+'_pronounce',JSON.stringify(P)); }catch(e){} }
function setSoundStatus(txt,cls){ const el=document.getElementById('soundStatus'); if(el){ el.textContent=txt; el.className='status'+(cls?' '+cls:''); } }
function loadVoices(){
  if(!('speechSynthesis' in window)) return;
  try{ voices = window.speechSynthesis.getVoices()||[]; }catch(e){ voices=[]; }
  pickVoice();
}
function pickVoice(){
  const zh = voices.filter(v=>/^zh/i.test(v.lang)||/chinese|中文|普通话|国语|漢語/i.test(v.name));
  if(!zh.length){ zhVoice=null; return; }
  const hints=['Xiaoxiao','Yunxi','Yunyang','Yunjian','Xiaoyi','Xiaonan','Xiaoyu','Neural','Online','Natural','Ting','Mei','Huihui','Yaoyao','Kangkang','Xiaomeng','Yuchen'];
  for(const h of hints){ const v=zh.find(x=>x.name.indexOf(h)>=0); if(v){ zhVoice=v; return; } }
  zhVoice=zh[0];
}
function unlockAudio(){
  try{
    actx = actx || new (window.AudioContext||window.webkitAudioContext)();
    if(actx.state==='suspended') actx.resume();
  }catch(e){}
  if(!audioUnlocked){
    try{
      const t=new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=');
      t.play().then(()=>{audioUnlocked=true;}).catch(()=>{});
    }catch(e){}
  }
}
function browserSpeak(text){
  if(!('speechSynthesis' in window) || !text) return;
  try{
    window.speechSynthesis.cancel();
    const u=new SpeechSynthesisUtterance(text);
    u.lang='zh-CN';
    if(zhVoice) u.voice=zhVoice;
    u.rate = P.spd<=3 ? 0.9 : (P.spd<=5 ? 1.0 : 1.1);
    window.speechSynthesis.speak(u);
  }catch(e){}
}
const audioCache = {};
function baiduUrl(text){ return 'https://fanyi.baidu.com/gettts?lan=zh&text='+encodeURIComponent(text)+'&spd='+(P.spd||3)+'&source=web'; }
function youdaoUrl(text){ return 'https://dict.youdao.com/dictvoice?audio='+encodeURIComponent(text)+'&le=zh&type=2'; }
function srcFor(text, source){
  if(source==='custom' && P.tpl) return P.tpl.replace(/\{text\}/g,encodeURIComponent(text)).replace(/\{q\}/g,encodeURIComponent(text)).replace(/\{word\}/g,encodeURIComponent(text));
  if(source==='baidu') return baiduUrl(text);
  return youdaoUrl(text);
}
function ensureAudio(text, source){
  const spd = source==='baidu' ? (P.spd||3) : '';
  const key=text+'@'+source+(spd?'@'+spd:'');
  if(audioCache[key]) return audioCache[key];
  const a=new Audio();
  a.preload='auto';
  a.referrerPolicy='no-referrer'; // 绕过跨站防盗链：不发送 Referer 即触发放行分支
  a.volume = Math.max(0,Math.min(1,parseFloat(P.vol)||1));
  a.src=srcFor(text,source); a._failed=false; a._loading=true;
  a.addEventListener('error',()=>{ a._failed=true; a._loading=false; });
  a.addEventListener('canplay',()=>{ a._loading=false; });
  a.load();
  audioCache[key]=a;
  return a;
}
function playSound(text){
  if(!text) return;
  unlockAudio();
  const m=P.method;
  if(m==='browser'){ browserSpeak(text); return; }
  const primary = (m==='custom'&&P.tpl) ? 'custom' : (m==='baidu' ? 'baidu' : 'youdao');
  const sec = (primary==='baidu') ? 'youdao' : 'baidu';
  const a = ensureAudio(text, primary);
  if(a && !a._failed){
    try{
      a.volume=Math.max(0,Math.min(1,parseFloat(P.vol)||1));
      if(a.readyState<2 && !a._loading) a.load();
      const pr=a.play();
      if(pr&&pr.catch) pr.catch(()=>{
        const b=ensureAudio(text,sec);
        if(b&&!b._failed){ try{ b.volume=a.volume; if(b.readyState<2&&!b._loading)b.load(); const p2=b.play(); if(p2&&p2.catch)p2.catch(()=>browserSpeak(text)); }catch(e){ browserSpeak(text); } }
        else browserSpeak(text);
      });
      return;
    }catch(e){}
  }
  browserSpeak(text);
}
function speak(text){ playSound(text); }
// 进词即预加载：遍历当前牌组所有文本，提前拉好主音源 + 备用音源音频（依赖全局 state.cards）
function preloadDeck(){
  if(!window.state || !window.state.cards) return;
  if(P.method==='browser'){ setSoundStatus('🎙 离线嗓模式（需本机中文语音）',''); return; }
  setSoundStatus('🔄 预加载中文发音中…','');
  const set=new Set();
  window.state.cards.forEach(c=>{ if(c.type!=='hanzi') return; set.add(c.text); });
  set.forEach(t=>{
    if(P.method==='custom'&&P.tpl){ ensureAudio(t,'custom'); }
    else if(P.method==='baidu'){ ensureAudio(t,'baidu'); ensureAudio(t,'youdao'); }
    else { ensureAudio(t,'youdao'); }
  });
  const name = P.method==='baidu' ? '百度真人普通话' : (P.method==='custom' ? '自定义接口' : '有道真人');
  setSoundStatus('✅ 中文发音就绪（'+name+'）','ok');
}

// ===================== Toast / Combo / Flash（失败四重提示） =====================
function toastMsg(msg){ if(!toastEl) return; toastEl.textContent=msg; toastEl.classList.add('show'); clearTimeout(toastEl._t); toastEl._t=setTimeout(()=>toastEl.classList.remove('show'),1800); }
function showCombo(n){
  if(!comboPop) return;
  comboPop.textContent='🔥 连击 x'+n;
  comboPop.classList.add('show');
  clearTimeout(comboPop._t);
  comboPop._t=setTimeout(()=>comboPop.classList.remove('show'),650);
}
function failFeedback(){
  if(flash){ flash.classList.add('show'); setTimeout(()=>flash.classList.remove('show'),200); }
  toastMsg(['差一点点~','再试试看!','不对哦 😯','别急，慢慢来','哎呀，差一点！','加油，你可以的！'][Math.floor(Math.random()*6)]);
  beep(200,.18,'square');
  vibrate([60,40,60]);
}

// ===================== CloudBase 初始化 =====================
if(cloudDot){ cloudDot.textContent='☁️ 连接中…'; cloudDot.className='status'; }
function initCloud(){
  if(cloudPromise) return cloudPromise;
  cloudPromise=(async()=>{
    try{
      if(!window.cloudbase) throw new Error('CloudBase SDK 未加载（请确认 lib/cloudbase.full.js 存在）');
      tcb=window.cloudbase.init({
        env: ENV_ID,
        region: 'ap-shanghai',
        accessKey: ACCESS_KEY,
        auth: { detectSessionInUrl: true }
      });
      const auth = (typeof tcb.auth === 'function') ? tcb.auth() : tcb.auth;
      if(!auth || typeof auth.signInAnonymously !== 'function') throw new Error('auth 实例不可用');
      const r = await auth.signInAnonymously();
      if(r && r.error){ const err=r.error; throw new Error((err&&(err.message||err.description))||(typeof err==='string'?err:'匿名登录失败')); }
      db=tcb.database();
      cloudReady=true;
      if(cloudDot){ cloudDot.textContent='☁️ 云端已连'; cloudDot.className='status ok'; }
    }catch(e){
      cloudReady=false;
      if(cloudDot){ cloudDot.textContent='☁️ 云端不可用'; cloudDot.className='status warn'; cloudDot.title='云端连接失败：'+(e&&e.message||e); }
      console.warn('cloudbase init',e);
      toastMsg('☁️ 云端不可用：'+(e&&e.message?e.message:e));
    }
    return cloudReady;
  })();
  return cloudPromise;
}

// ===================== 昵称关卡 =====================
function syncNick(v){ NICK=(v||'').trim().slice(0,12); localStorage.setItem('hpm_nick',NICK); if(nickInput) nickInput.value=NICK; }
if(nickInput){ nickInput.value=NICK; nickInput.addEventListener('input',()=>syncNick(nickInput.value)); }
function openNameGate(){ if(nameInput) nameInput.value=NICK; if(nameOverlay) nameOverlay.classList.add('show'); if(nameInput) setTimeout(()=>nameInput.focus(),50); }
if(nameConfirm){
  nameConfirm.addEventListener('click',()=>{
    const v=(nameInput.value||'').trim();
    if(!v){ toastMsg('请先输入名字再开始'); if(nameInput) nameInput.focus(); return; }
    syncNick(v);
    if(nameOverlay) nameOverlay.classList.remove('show');
    if(typeof startGame==='function') startGame();
  });
  if(nameInput) nameInput.addEventListener('keydown',e=>{ if(e.key==='Enter') nameConfirm.click(); });
}

// ===================== 联机对战（房间文档 + watch + 轮询） =====================
const net={active:false,roomCode:'',name:'',isHost:false,opponent:null,opScore:0,opMatched:0,started:false,deck:null,myKey:'',opponentKey:'',watcher:null,pollTimer:null,_joinedToast:false,_decided:false};
function genRoomCode(){ return Math.random().toString(36).slice(2,7).toUpperCase(); }
function cleanupNet(){
  try{ if(net.watcher) net.watcher.close(); }catch(e){}
  net.watcher=null;
  if(net.pollTimer){ clearInterval(net.pollTimer); net.pollTimer=null; }
  if(netHud) netHud.style.display='none';
}
function netLeave(){
  cleanupNet();
  net.active=false; net.opponent=null; net.opScore=0; net.opMatched=0;
  net._joinedToast=false; net._decided=false;
}
function renderNetHud(){
  if(!netHud) return;
  netHud.innerHTML=`<span>你 <b>${net.name||'-'}</b>: <b>${window.state?window.state.score:0}</b></span>`+
    `<span>对手 <b>${net.opponent||'等待加入…'}</b>: <b>${net.opScore}</b></span>`+
    `<span style="color:var(--muted);font-size:12px;">房间 ${net.roomCode}</span>`;
}
function netSync(){
  if(net.active && tcb && window.state){
    const upd={}; upd[net.myKey+'score']=window.state.score; upd[net.myKey+'matched']=window.state.matched;
    db.collection('rooms').doc(net.roomCode).update(upd).catch(()=>{});
  }
  renderNetHud();
}
function watchRoom(){
  if(!tcb) return;
  try{
    net.watcher=db.collection('rooms').doc(net.roomCode).watch({
      onChange:(snap)=>{ const d=snap.docs&&snap.docs[0]; if(d) applyRoomDoc(d); },
      onError:()=>{}
    });
  }catch(e){}
}
function startRoomPoll(){
  net.pollTimer=setInterval(()=>{
    if(tcb && net.active){ db.collection('rooms').doc(net.roomCode).get().then(({data})=>{ const d=data&&data[0]; if(d) applyRoomDoc(d); }).catch(()=>{}); }
  }, 1500);
}
async function openNet(){
  const name=$('#netName').value.trim()||'玩家';
  if(!tcb || !cloudReady){ toastMsg('云端未连接或不可达，无法联机（请确认已填写 CloudBase 环境 ENV_ID、已开启匿名登录；或用电脑/手机浏览器打开）'); if(netOverlay) netOverlay.classList.remove('show'); return; }
  let room=$('#netRoom').value.trim().toUpperCase();
  net.isHost=!room; if(!room) room=genRoomCode();
  net.name=name; net.roomCode=room; net._joinedToast=false; net._decided=false;
  syncNick(name);
  if(netOverlay) netOverlay.classList.remove('show');
  const lvl=$('#netLevel'); if(lvl) net.level=lvl.value;
  const tm=$('#timedMode'); if(tm) tm.checked=false;
  try{
    const uid = (tcb.auth() && tcb.auth().currentUser) ? tcb.auth().currentUser.uid : 'u';
    if(net.isHost){
      net.myKey='p1'; net.opponentKey='p2';
      const deck=buildDeck(); net.deck=deck;
      await db.collection('rooms').doc(room).set({
        p1:name, p2:null, players:[name,null],
        p1score:0,p1matched:0,p2score:0,p2matched:0,
        p1finished:false,p2finished:false,
        deck:deck, host:uid, ts:Date.now(), status:'waiting'
      });
      watchRoom(); startRoomPoll();
      beginNetRound(deck);
      toastMsg('房间 '+room+' 已创建，把房间号发给对手');
    }else{
      const { data } = await db.collection('rooms').doc(room).get();
      const doc = data && data[0];
      if(!doc){ toastMsg('房间 '+room+' 不存在，请检查房间号'); return; }
      net.myKey='p2'; net.opponentKey='p1';
      net.deck=doc.deck; net.opponent=doc.p1||'对手';
      const players=[doc.p1||'玩家1', name];
      await db.collection('rooms').doc(room).update({ p2:name, players:players, p2finished:false });
      watchRoom(); startRoomPoll();
      beginNetRound(doc.deck);
      toastMsg('已加入房间 '+room);
    }
  }catch(e){ toastMsg('联机失败：'+(e&&e.message?e.message:e)); }
}
function beginNetRound(deck){
  setupRound(deck);
  net.active=true; net.opScore=0; net.opMatched=0; netJustEnded=false;
  if(netHud) netHud.style.display='flex';
  renderNetHud();
  toastMsg('对战开始！');
}
function applyRoomDoc(doc){
  if(!doc) return;
  net.opponent = doc[net.opponentKey] || net.opponent;
  net.opScore = doc[net.opponentKey+'score']||0;
  net.opMatched = doc[net.opponentKey+'matched']||0;
  renderNetHud();
  if(net.isHost && doc.p2 && !net._joinedToast){ net._joinedToast=true; toastMsg('对手 '+doc.p2+' 已加入'); }
  if(doc.p1finished && doc.p2finished && !net._decided){
    net._decided=true;
    const meScore = doc[net.myKey+'score']||0;
    const opScore = doc[net.opponentKey+'score']||0;
    const winner = meScore===opScore ? '平局' : (meScore>opScore ? net.name : doc[net.opponentKey]);
    showNetResult(winner, meScore, opScore, doc[net.opponentKey]);
  }
}
function showNetResult(winner, me, op, opName){
  net.active=false; if(window.state){ window.state.playing=false; }
  clearTimerSafe();
  const t = winner==='平局' ? '平局！' : ('🎉 '+(winner===net.name?'你获胜！':opName+' 获胜'));
  if($('#endTitle')) $('#endTitle').textContent='对战结束';
  if($('#stars')) $('#stars').textContent='🏆';
  if($('#winText')) $('#winText').innerHTML=`你 <b>${me}</b> : <b>${op}</b> ${opName}<br>${t}`;
  if(overlay) overlay.classList.add('show');
  if(winAgainBtn) winAgainBtn.textContent='返回';
  netJustEnded=true;
  cleanupNet();
}
function netFinish(){
  if(window.state) window.state.playing=false;
  clearTimerSafe();
  net.active=false;
  const finalScore=window.state?window.state.score:0;
  const upd={}; upd[net.myKey+'score']=finalScore; upd[net.myKey+'matched']=(window.state?window.state.matched:0); upd[net.myKey+'finished']=true;
  if(tcb) db.collection('rooms').doc(net.roomCode).update(upd).catch(()=>{});
  cloudSaveScore({player:net.name,mode:'online',score:finalScore,correct:(window.state?window.state.matched:0),wrong:((window.state?window.state.attempts:0)-(window.state?window.state.matched:0)),duration:0,room:net.roomCode});
  if($('#endTitle')) $('#endTitle').textContent='🏁 你完成啦！';
  if($('#stars')) $('#stars').textContent='🏆';
  if($('#winText')) $('#winText').innerHTML=`你得分 <b>${finalScore}</b> · 对手 <b>${net.opScore}</b><br>成绩已上传云端，等待对手…`;
  if(overlay) overlay.classList.add('show');
  if(winAgainBtn) winAgainBtn.textContent='返回';
  netJustEnded=true;
  cleanupNet();
  setTimeout(()=>{ if(tcb){ db.collection('rooms').doc(net.roomCode).get().then(({data})=>{ const d=data&&data[0]; if(d && d[net.opponentKey+'finished']) applyRoomDoc(d); }).catch(()=>{}); } }, 700);
}
// 帮助：清除本游戏计时器（游戏可挂到 window.__stopTimer；没有则空操作）
function clearTimerSafe(){ try{ if(typeof window.__stopTimer==='function') window.__stopTimer(); }catch(e){} }

// ===================== 云端存分 / 学情数据 =====================
async function cloudSaveScore(rec){
  rec.game_type = rec.game_type || GT();
  if(!tcb) return;
  try{ rec.created_at=new Date().toISOString(); await db.collection('scores').add(rec); setTimeout(refreshLiveboard,500); }catch(e){ console.warn('save score',e); }
}
async function logAttempt(hanzi,pinyin,correct){
  if(!tcb) return;
  try{ await db.collection('attempts').add({player:net.active?net.name:(NICK||'匿名学员'),hanzi,pinyin:typeof pinyin==='string'?pinyin:'',correct,game_type:GT(),created_at:new Date().toISOString()}); }catch(e){}
}
async function viewCloudRank(){
  if(!tcb){ toastMsg('云端未连接'); return; }
  const list=document.getElementById('cloudList'); if(!list) return;
  try{
    const { data } = await db.collection('scores').orderBy('score','desc').limit(20).get();
    if(!data||!data.length){ list.innerHTML='<div style="color:var(--muted);padding:16px 0;">还没有云端战绩，去玩一局上传吧！</div>'; }
    else{
      list.innerHTML=data.map((r,i)=>`<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:9px 12px;border:1px solid var(--line);border-radius:12px;margin-bottom:7px;font-size:14px;">
        <span>#${i+1} <b style="color:var(--ink)">${r.player}</b></span>
        <span style="color:var(--ok-d);font-weight:700;">${r.score} 分</span>
        <span style="color:var(--muted);font-size:12px;">${r.mode==='online'?'联机':'单人'}</span>
      </div>`).join('');
    }
    if(cloudOverlay) cloudOverlay.classList.add('show');
  }catch(e){ list.innerHTML='<div style="color:var(--bad)">读取失败：'+(e&&e.message?e.message:e)+'</div>'; }
}

// ===================== 实时擂台（前三名） =====================
async function refreshLiveboard(){
  if(!tcb) return;
  try{
    // 取当前游戏（game_type）的前三名：先按 score 降序拉一批，再客户端按 game_type 过滤，
    // 避免「where+orderBy 不同字段」需要复合索引而报错（CloudBase 单字段索引即可）。
    const { data } = await db.collection('scores').orderBy('score','desc').limit(60).get();
    const rows=(data||[]).filter(r=>r.game_type===GT()).slice(0,3);
    if(lbStatus){ lbStatus.textContent='已同步'; lbStatus.className='status ok'; }
    renderLiveboard(rows);
  }catch(e){ if(lbStatus){ lbStatus.textContent='同步失败'; lbStatus.className='status warn'; } }
}
function renderLiveboard(rows){
  if(!liveboard) return;
  if(!rows.length){ liveboard.innerHTML='<div class="lb-empty">还没有战绩，快来抢占榜首！</div>'; return; }
  const medals=['🥇','🥈','🥉'];
  const cls=['lb-1','lb-2','lb-3'];
  liveboard.innerHTML=rows.map((r,i)=>{
    const me=(NICK && r.player===NICK)?' lb-me':'';
    return `<div class="lb-card ${cls[i]}${me}">
      <div class="lb-rank">${medals[i]}</div>
      <div class="lb-name">${r.player}</div>
      <div class="lb-score">${r.score} 分</div>
    </div>`;
  }).join('');
  if(lbStatus){ lbStatus.textContent='已同步'; lbStatus.className='status ok'; }
}
function setupLiveboardRealtime(){
  if(!tcb) return;
  try{ db.collection('scores').watch({ onChange:()=>refreshLiveboard(), onError:()=>{} }); }catch(e){}
}

// ===================== 双人对战 PK（同设备，localStorage 战绩） =====================
const pk = { active:false, names:['',''], idx:0, scores:[0,0], times:[0,0], level:'entry', timed:false };
function startPk(){
  const p1=$('#pkP1').value.trim()||'玩家1';
  const p2=$('#pkP2').value.trim()||'玩家2';
  pk.names=[p1,p2]; pk.scores=[0,0]; pk.times=[0,0]; pk.idx=0; pk.active=true;
  const lvl=$('#pkLevel'); pk.level=lvl?lvl.value:'entry';
  const tm=$('#pkTimed'); pk.timed=tm?tm.checked:false;
  if(lvl){ }
  if(pkOverlay) pkOverlay.classList.remove('show');
  toastMsg(p1+' 先来，加油！');
  if(typeof startGame==='function') startGame();
}
function pkEnd(){
  const i=pk.idx;
  pk.scores[i]=(window.state?window.state.score:0);
  pk.times[i]=0;
  if(window.state) window.state.playing=false;
  if(i===0){
    pk.idx=1;
    if($('#endTitle')) $('#endTitle').textContent=pk.names[0]+' 完成！';
    if($('#stars')) $('#stars').textContent='⭐⭐⭐';
    if($('#winText')) $('#winText').innerHTML=`${pk.names[0]} 本局 <b>${(window.state?window.state.score:0)}</b> 分<br>${pk.names[1]}，准备好了吗？`;
    if(overlay) overlay.classList.add('show');
    if(winAgainBtn) winAgainBtn.textContent=pk.names[1]+' 开始 →';
  }else{
    pk.active=false;
    const [a,b]=pk.scores;
    const winner = a===b ? '平局' : (a>b?pk.names[0]:pk.names[1]);
    savePkHistory({p1:pk.names[0], p2:pk.names[1], s1:a, s2:b, winner, date:new Date().toLocaleDateString()});
    if($('#endTitle')) $('#endTitle').textContent = winner==='平局' ? '平局！' : (winner+' 获胜！');
    if($('#stars')) $('#stars').textContent='🏆';
    if($('#winText')) $('#winText').innerHTML=`${pk.names[0]}: <b>${a}</b> 分　|　${pk.names[1]}: <b>${b}</b> 分<br>${winner==='平局'?'不分胜负，再战一局？':'🎉 恭喜 '+winner}`;
    if(overlay) overlay.classList.add('show');
    if(winAgainBtn) winAgainBtn.textContent='再玩一次';
  }
}
function savePkHistory(rec){
  try{ const k=(GT())+'_pk_history'; const h=JSON.parse(localStorage.getItem(k)||'[]'); h.unshift(rec); localStorage.setItem(k,JSON.stringify(h.slice(0,20))); }catch(e){}
}
function viewHistory(){
  const list=document.getElementById('rankList'); if(!list) return;
  let h=[]; try{ h=JSON.parse(localStorage.getItem((GT())+'_pk_history')||'[]'); }catch(e){}
  if(!h.length){ list.innerHTML='<div style="color:var(--muted);padding:18px 0;">还没有对战记录，去「双人对战」来一局吧！</div>'; return; }
  list.innerHTML=h.map(r=>`<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:12px;margin-bottom:8px;font-size:14px;">
    <span><b style="color:var(--ink)">${r.p1}</b> ${r.s1} : ${r.s2} <b style="color:var(--ink)">${r.p2}</b></span>
    <span style="color:${r.winner==='平局'?'var(--muted)':'var(--ok-d)'};font-weight:700;">${r.winner}</span>
    <span style="color:var(--muted);font-size:12px;">${r.date}</span>
  </div>`).join('');
}

// ===================== 发音设置面板（通用，HTML 须含相关控件） =====================
function fillSoundUI(){
  const m=$('#pMethod'); if(m) m.value=P.method;
  const tpl=$('#pTpl'); if(tpl) tpl.value=P.tpl;
  const tplRow=$('#tplRow'); if(tplRow) tplRow.style.display = P.method==='custom' ? 'block' : 'none';
  const pa=$('#pAuto'); if(pa) pa.checked=P.autoSpeak;
  const rateLabels=['很慢','慢','正常','较快','快','很快','极快'];
  const rate=$('#pRate'); if(rate){ rate.value=P.spd; const rv=$('#pRateV'); if(rv) rv.textContent=rateLabels[(P.spd||3)-1]||'正常'; }
  const vol=$('#pVol'); if(vol){ vol.value=P.vol; const vv=$('#pVolV'); if(vv) vv.textContent=parseFloat(P.vol).toFixed(1); }
  const vi=$('#voiceInfo');
  if(vi) vi.innerHTML = ('speechSynthesis' in window)
    ? ('默认<b>百度翻译 TTS 真人普通话</b>（lan=zh 锁死普通话）+ 有道真人女声兜底：进词即预加载，点卡秒播。语速走百度原生 spd(1~7)、音量可调；联网失败/离线回退本机中文嗓「'+(zhVoice?zhVoice.name:'系统默认中文嗓')+'」。')
    : '⚠️ 当前浏览器不支持语音合成；默认走百度在线真人发音，请用 Chrome/Edge 打开并确保联网。';
}
function bindSoundUI(){
  if(!soundOverlay) return;
  const sb=$('#soundBtn'); if(sb) sb.addEventListener('click',()=>{ fillSoundUI(); soundOverlay.classList.add('show'); });
  const pm=$('#pMethod'); if(pm) pm.addEventListener('change',e=>{ P.method=e.target.value; const tr=$('#tplRow'); if(tr) tr.style.display=P.method==='custom'?'block':'none'; for(const k in audioCache) delete audioCache[k]; if(window.state&&window.state.cards&&window.state.cards.length) preloadDeck(); });
  const pr=$('#pRate'); if(pr) pr.addEventListener('input',e=>{ P.spd=parseInt(e.target.value)||3; const labels=['很慢','慢','正常','较快','快','很快','极快']; const rv=$('#pRateV'); if(rv) rv.textContent=labels[P.spd-1]||'正常'; });
  if(pr) pr.addEventListener('change',e=>{ for(const k in audioCache) delete audioCache[k]; if(window.state&&window.state.cards&&window.state.cards.length) preloadDeck(); setSoundStatus('✅ 已按新语速预加载','ok'); });
  const pv=$('#pVol'); if(pv) pv.addEventListener('input',e=>{ P.vol=parseFloat(e.target.value); const vv=$('#pVolV'); if(vv) vv.textContent=P.vol.toFixed(1); });
  const pa=$('#pAuto'); if(pa) pa.addEventListener('change',e=>{ P.autoSpeak=e.target.checked; });
  const pt=$('#pTpl'); if(pt) pt.addEventListener('input',e=>{ P.tpl=e.target.value.trim(); });
  const st=$('#soundTest'); if(st) st.addEventListener('click',()=>{ speak('你好'); });
  const ts=$('#testSoundBtn'); if(ts) ts.addEventListener('click',()=>{ unlockAudio(); speak('你好'); setSoundStatus('🔊 已播放「你好」，没听到？请看说明','warn'); });
  const sc=$('#soundClose'); if(sc) sc.addEventListener('click',()=>{ savePronounce(); soundOverlay.classList.remove('show'); });
}

// ===================== 通用按钮接线（存在才绑定） =====================
function bindCommonButtons(){
  const nb=$('#netBtn'); if(nb) nb.addEventListener('click',()=>{ if(NICK) { const nn=$('#netName'); if(nn) nn.value=NICK; } if(netOverlay) netOverlay.classList.add('show'); });
  const ns=$('#netStart'); if(ns) ns.addEventListener('click',openNet);
  const nc=$('#netCancel'); if(nc) nc.addEventListener('click',()=>{ if(netOverlay) netOverlay.classList.remove('show'); });
  const cb=$('#cloudBtn'); if(cb) cb.addEventListener('click',viewCloudRank);
  const cc=$('#cloudClose'); if(cc) cc.addEventListener('click',()=>{ if(cloudOverlay) cloudOverlay.classList.remove('show'); });
  const pkb=$('#pkBtn'); if(pkb) pkb.addEventListener('click',()=>{ if(pkOverlay) pkOverlay.classList.add('show'); });
  const pks=$('#pkStart'); if(pks) pks.addEventListener('click',startPk);
  const pkc=$('#pkCancel'); if(pkc) pkc.addEventListener('click',()=>{ if(pkOverlay) pkOverlay.classList.remove('show'); });
  const rb=$('#rankBtn'); if(rb) rb.addEventListener('click',()=>{ viewHistory(); if(rankOverlay) rankOverlay.classList.add('show'); });
  const rc=$('#rankClose'); if(rc) rc.addEventListener('click',()=>{ if(rankOverlay) rankOverlay.classList.remove('show'); });
  const rcl=$('#rankClear'); if(rcl) rcl.addEventListener('click',()=>{ try{ localStorage.removeItem((GT())+'_pk_history'); }catch(e){} viewHistory(); toastMsg('战绩已清空'); });
  const wa=$('#winAgain'); if(wa) wa.addEventListener('click',()=>{
    if(overlay) overlay.classList.remove('show');
    if(netJustEnded){ netJustEnded=false; if(typeof resetGame==='function') resetGame(); return; }
    if(pk.active){ pk.idx=1; startPk(); return; }
    if(typeof startGame==='function') startGame();
  });
}

// ===================== 初始化 =====================
loadPronounce();
loadVoices();
if('speechSynthesis' in window){ window.speechSynthesis.onvoiceschanged=loadVoices; }
bindSoundUI();
bindCommonButtons();
// 返回上一级悬浮按钮：所有加载本内核的游戏自动获得，回到游戏列表（works.html）。放在右下角，避免与游戏顶部控制栏重叠
(function injectHome(){
  try{
    // 用绝对路径 + _top，避免游戏在 iframe(/games/ 子目录) 内时相对解析成 /games/works.html(404 回退简历页) 或被套在 iframe 里
    const worksUrl = (window.top && window.top.location.origin ? window.top.location.origin : location.origin) + '/works.html';
    if(document.getElementById('cbHomeBtn')) return;
    const b=document.createElement('a');
    b.id='cbHomeBtn'; b.href=worksUrl; b.target='_top'; b.title='返回游戏列表';
    b.textContent='←';
    b.style.cssText='position:fixed;right:12px;bottom:12px;z-index:99999;text-decoration:none;'+
      'background:rgba(64,158,255,.92);color:#fff;font-weight:700;font-size:18px;'+
      'width:44px;height:44px;border-radius:50%;border:none;'+
      'display:flex;align-items:center;justify-content:center;'+
      'box-shadow:0 4px 12px rgba(64,158,255,.4)';
    document.body.appendChild(b);
  }catch(e){}
})();
initCloud().then((ok)=>{ if(ok){ refreshLiveboard(); setupLiveboardRealtime(); setInterval(refreshLiveboard,8000); } });

// 暴露全局 API 供各游戏剧本使用
window.CB = {
  speak, cloudSaveScore, logAttempt, refreshLiveboard, setupLiveboardRealtime,
  viewCloudRank, initCloud, net, pk, netLeave, netSync, netFinish,
  openNameGate, syncNick, failFeedback, showCombo, beep, vibrate, preloadDeck,
  get NICK(){ return NICK; }, set NICK(v){ syncNick(v); },
  get cloudReady(){ return cloudReady; }, get tcb(){ return tcb; }, get db(){ return db; },
  P
};

})();
