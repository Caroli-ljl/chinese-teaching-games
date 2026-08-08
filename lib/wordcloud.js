/* =========================================================================
 * lib/wordcloud.js —— 轻量中文词云引擎（零依赖、本地化、禁外链）
 * 用法：MiniCloud(canvasEl, items, opts)
 *   items: [{ text, weight, color, meta }]   weight=错误次数，color=该游戏色，meta=附加信息
 *   opts:  { fontFamily, minFont, maxFont, padding, onTooltip }
 * 特性：螺旋排布 + 矩形碰撞检测；悬浮显示文字/次数/来源；点击回调可选。
 * 全局暴露 window.MiniCloud
 * ========================================================================= */
(function (global) {
  'use strict';

  function measure(ctx, text, font) {
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width);
    return w;
  }

  function rectsOverlap(a, b) {
    return !(b.x > a.x + a.w || b.x + b.w < a.x || b.y > a.y + a.h || b.y + b.h < a.y);
  }

  function MiniCloud(canvas, items, opts) {
    opts = opts || {};
    if (!canvas) return null;
    const fontFamily = opts.fontFamily || '"PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif';
    const minFont = opts.minFont || 16;
    const maxFont = opts.maxFont || 64;
    const pad = opts.padding != null ? opts.padding : 4;
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));

    const rect = canvas.getBoundingClientRect();
    const W = Math.max(320, Math.floor(rect.width || canvas.clientWidth || 600));
    const H = Math.max(260, Math.floor(rect.height || canvas.clientHeight || 420));
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.height = H + 'px';

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    const list = (items || []).slice().sort((a, b) => (b.weight || 1) - (a.weight || 1));
    const maxW = list.length ? Math.max.apply(null, list.map(function (i) { return i.weight || 1; })) : 1;
    const minW = list.length ? Math.min.apply(null, list.map(function (i) { return i.weight || 1; })) : 1;

    function fontSizeFor(weight) {
      if (maxW === minW) return Math.round((minFont + maxFont) / 2);
      const t = (weight - minW) / (maxW - minW);
      return Math.round(minFont + Math.pow(t, 0.7) * (maxFont - minFont));
    }

    const placed = [];
    const layout = [];
    const cx = W / 2, cy = H / 2;
    const maxR = Math.sqrt(W * W + H * H) / 2 + 40;

    list.forEach(function (it) {
      const fs = fontSizeFor(it.weight || 1);
      const font = '700 ' + fs + 'px ' + fontFamily;
      ctx.font = font;
      const w = measure(ctx, it.text, font);
      const h = fs; // 中文近似方形
      let done = false;
      // 螺旋搜索：最大的词优先放中心
      for (let i = 0; i < 2600; i++) {
        const t = i * 0.22;
        const r = 2 + 3.2 * t;
        if (r > maxR) break;
        const x = cx + r * Math.cos(t) - w / 2;
        const y = cy + r * Math.sin(t) - h / 2;
        const box = { x: x - pad, y: y - pad * 0.6, w: w + pad * 2, h: h + pad * 1.2 };
        let hit = false;
        for (let k = 0; k < placed.length; k++) {
          if (rectsOverlap(box, placed[k])) { hit = true; break; }
        }
        if (!hit) {
          placed.push(box);
          layout.push({ x: x + w / 2, y: y + h / 2, w: w, h: h, fs: fs, color: it.color || '#333', text: it.text, meta: it.meta, weight: it.weight });
          done = true;
          break;
        }
      }
      if (!done) {
        // 放不下就叠在中心偏下，保证都出现
        const x = cx - w / 2, y = cy - h / 2 + (placed.length % 5) * 6;
        placed.push({ x: x - pad, y: y - pad, w: w + pad * 2, h: h + pad * 2 });
        layout.push({ x: x + w / 2, y: y + h / 2, w: w, h: h, fs: fs, color: it.color || '#333', text: it.text, meta: it.meta, weight: it.weight });
      }
    });

    // 绘制
    layout.forEach(function (p) {
      ctx.font = '700 ' + p.fs + 'px ' + fontFamily;
      ctx.fillStyle = p.color;
      ctx.shadowColor = 'rgba(0,0,0,0.08)';
      ctx.shadowBlur = 2;
      ctx.fillText(p.text, p.x, p.y);
      ctx.shadowBlur = 0;
    });

    // 悬浮提示
    let tip = null;
    function ensureTip() {
      if (tip) return tip;
      tip = document.createElement('div');
      tip.style.cssText = 'position:fixed;z-index:999;pointer-events:none;background:rgba(31,41,55,.94);color:#fff;' +
        'font-size:12px;line-height:1.5;padding:7px 10px;border-radius:8px;max-width:240px;box-shadow:0 6px 18px rgba(0,0,0,.25);' +
        'opacity:0;transition:opacity .12s;transform:translateY(4px)';
      document.body.appendChild(tip);
      return tip;
    }
    function hit(px, py) {
      for (let i = layout.length - 1; i >= 0; i--) {
        const p = layout[i];
        if (Math.abs(px - p.x) <= p.w / 2 + 2 && Math.abs(py - p.y) <= p.h / 2 + 2) return p;
      }
      return null;
    }
    canvas.onmousemove = function (e) {
      const r = canvas.getBoundingClientRect();
      const p = hit(e.clientX - r.left, e.clientY - r.top);
      const el = ensureTip();
      if (p) {
        const meta = p.meta || {};
        let html = '<b style="font-size:14px">' + p.text + '</b>　错 ' + (p.weight || 0) + ' 次';
        if (meta.games && meta.games.length) html += '<br><span style="opacity:.8">来源：' + meta.games.join('、') + '</span>';
        el.innerHTML = html;
        el.style.left = (e.clientX + 12) + 'px';
        el.style.top = (e.clientY + 12) + 'px';
        el.style.opacity = '1';
        canvas.style.cursor = 'pointer';
      } else {
        el.style.opacity = '0';
        canvas.style.cursor = 'default';
      }
    };
    canvas.onmouseleave = function () { if (tip) tip.style.opacity = '0'; };

    return {
      count: layout.length,
      layout: layout,
      draw: function () { MiniCloud(canvas, items, opts); }
    };
  }

  global.MiniCloud = MiniCloud;
})(window);
