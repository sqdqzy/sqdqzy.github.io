/**
 * ui.js — 场景控制界面（纯 DOM + CSS，零第三方依赖）
 * ---------------------------------------------------------------------------
 * 设计语言：深色玻璃面板（blur 14px）、1px 极细描边、2px 小圆角、暖色 --accent 作强调、
 *          衬线体只用于标题、字距拉开。像电影片尾的调色板，不是通用 SaaS 仪表盘。
 *
 * 位置（全部 fixed 小面板，避免遮住画布拖拽；#ui-root 本身 pointer-events:none，
 *        仅这些子元素接收事件，这条约定必须保持）：
 *   左上  品牌区     —— 林間小屋 / FOREST CABIN / 当前时段 + hint
 *   底部中 时段片     —— 6 档时段切换 + 快捷键提示
 *   右下  控制面板    —— 相机模式 / 镜头名 + 6 圆点 / 画质 / 全屏 / 重置视角 / 隐藏界面
 *   右上  性能读数    —— FPS / 三角面 / Draw call，可点击折叠
 *   中下  首屏提示    —— 「拖动旋转 · 滚轮缩放」，3s 后淡出
 *
 * 注意：index.html 的 .letterbox（z-index 40）盖在 #ui-root（z-index 30）之上，
 *       所以 body.cinema 时面板要整体避开上下 6.2vh 的黑边。
 */
import { clamp } from './core.js';

const PREFERS_REDUCED = typeof matchMedia === 'function'
  && matchMedia('(prefers-reduced-motion: reduce)').matches;

/* =========================================================================
 * 样式（全部自持，注入到 #ui-root）
 * ========================================================================= */
const STYLE = `
#ui-root .fx-panel {
  position: fixed;
  z-index: 1;
  margin: 0;
  padding: 0;
  color: var(--ink);
  font-family: var(--sans);
  font-size: 12px;
  line-height: 1.4;
  letter-spacing: .06em;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 2px;
  -webkit-backdrop-filter: blur(14px) saturate(1.1);
  backdrop-filter: blur(14px) saturate(1.1);
  box-shadow: 0 10px 30px rgba(0, 0, 0, .28), inset 0 1px 0 rgba(255, 255, 255, .03);
  pointer-events: auto;
  transition: opacity .55s cubic-bezier(.22, .61, .36, 1) var(--d, 0s),
              transform .55s cubic-bezier(.22, .61, .36, 1) var(--d, 0s),
              bottom .7s cubic-bezier(.4, 0, .2, 1),
              top .7s cubic-bezier(.4, 0, .2, 1),
              border-color .35s ease, background-color .35s ease;
}
#ui-root .fx-panel.fx-pre { opacity: 0; transform: translateY(10px) scale(.99); }
#ui-root .fx-panel.fx-in { opacity: 1; transform: none; }

/* 底部中/右下两块在窄屏时要合成「一条底部控制栏」，用一个不生成盒子的 dock 容器包住；
   #ui-root 的 pointer-events:none 约定保持不变：dock 自身不吃事件，只有面板吃。 */
#ui-root > .fx-dock { display: contents; pointer-events: none; }
#ui-root > .fx-dock > .fx-panel { pointer-events: auto; }

#ui-root .fx-mono,
#ui-root .fx-perf-body { font-family: ui-monospace, "Cascadia Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace; }

#ui-root button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
#ui-root button:focus-visible,
#ui-root select:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
#ui-root button:focus:not(:focus-visible) { outline: none; }

/* ---------------- 左上：品牌 ---------------- */
#ui-root > .fx-brand {
  top: 22px; left: 24px;
  padding: 13px 20px 12px;
  max-width: min(52vw, 520px);
}
body.cinema #ui-root > .fx-brand { top: calc(6.2vh + 18px); }
body.booting #ui-root > .fx-brand { top: 22px; }

#ui-root .fx-brand-title {
  font-family: var(--serif);
  font-size: clamp(19px, 2.1vw, 26px);
  letter-spacing: .34em;
  text-indent: .34em;
  line-height: 1.15;
  color: #f7f1e6;
  text-shadow: 0 2px 22px rgba(255, 170, 90, .22);
}
#ui-root .fx-brand-sub {
  margin-top: 3px;
  font-size: 9.5px;
  letter-spacing: .42em;
  text-indent: .42em;
  text-transform: uppercase;
  color: var(--ink-dim);
}
#ui-root .fx-brand-now {
  margin-top: 9px;
  padding-top: 8px;
  border-top: 1px solid var(--line);
  display: flex; align-items: center; gap: 7px;
  font-size: 11px;
  color: var(--ink-dim);
  min-width: 0;
}
#ui-root .fx-brand-dot {
  width: 5px; height: 5px; border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 9px 1px rgba(255, 180, 105, .75);
  flex: 0 0 auto;
  transition: background-color .4s ease, box-shadow .4s ease;
}
#ui-root .fx-brand-label { color: var(--ink); letter-spacing: .18em; flex: 0 0 auto; }
#ui-root .fx-brand-sep { color: rgba(242, 236, 225, .3); }
#ui-root .fx-brand-hint {
  color: var(--ink-dim);
  letter-spacing: .1em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  min-width: 0;
  transition: opacity .3s ease;
}

/* ---------------- 底部中：时段片 + 快捷键 ---------------- */
#ui-root .fx-times {
  /* 用 left/right + margin:auto 做水平居中，避免与 fx-pre 的 transform 动画打架 */
  left: 0; right: 0; bottom: 24px;
  margin: 0 auto;
  width: fit-content;
  max-width: calc(100vw - 32px);
  padding: 8px 10px 6px;
  display: flex; flex-direction: column; align-items: center; gap: 5px;
}
body.cinema #ui-root .fx-times { bottom: calc(6.2vh + 16px); }
body.booting #ui-root .fx-times { bottom: 24px; }

#ui-root .fx-times-row { display: flex; align-items: stretch; gap: 2px; }
#ui-root .fx-chip {
  position: relative;
  padding: 6px 11px 7px;
  display: flex; align-items: baseline; gap: 6px;
  color: var(--ink-dim);
  letter-spacing: .16em;
  white-space: nowrap;
  border-radius: 2px;
  transition: color .28s ease, background-color .28s ease, transform .28s ease;
}
#ui-root .fx-chip-idx {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 9px;
  letter-spacing: 0;
  opacity: .5;
}
#ui-root .fx-chip:hover { color: var(--ink); background: rgba(242, 236, 225, .05); }
#ui-root .fx-chip::after {
  content: '';
  position: absolute; left: 16%; right: 16%; bottom: 0; height: 1px;
  background: var(--accent);
  opacity: 0; transform: scaleX(.4);
  transition: opacity .34s ease, transform .34s cubic-bezier(.22, .61, .36, 1);
}
#ui-root .fx-chip[aria-pressed="true"] { color: var(--ink); }
#ui-root .fx-chip[aria-pressed="true"] .fx-chip-idx { opacity: .85; color: var(--accent); }
#ui-root .fx-chip[aria-pressed="true"]::after { opacity: 1; transform: scaleX(1); box-shadow: 0 0 12px 1px rgba(255, 180, 105, .5); }
#ui-root .fx-keys {
  font-size: 9.5px;
  letter-spacing: .16em;
  color: rgba(242, 236, 225, .34);
  white-space: nowrap;
}

/* ---------------- 右下：控制面板 ---------------- */
#ui-root .fx-ctl {
  right: 24px; bottom: 24px;
  width: 268px;
  padding: 11px 13px 12px;
  display: flex; flex-direction: column; gap: 9px;
}
body.cinema #ui-root .fx-ctl { bottom: calc(6.2vh + 16px); }
body.booting #ui-root .fx-ctl { bottom: 24px; }

#ui-root .fx-seg {
  display: flex; gap: 2px;
  padding: 2px;
  border: 1px solid var(--line);
  border-radius: 2px;
  background: rgba(0, 0, 0, .18);
}
#ui-root .fx-seg-btn {
  flex: 1 1 0;
  padding: 5px 8px;
  font-size: 11px;
  letter-spacing: .18em;
  color: var(--ink-dim);
  border-radius: 1px;
  transition: color .28s ease, background-color .28s ease, box-shadow .28s ease;
}
#ui-root .fx-seg-btn:hover { color: var(--ink); }
#ui-root .fx-seg-btn[aria-pressed="true"] {
  color: #1a1410;
  background: linear-gradient(180deg, rgba(255, 190, 122, .94), rgba(238, 158, 84, .9));
  box-shadow: 0 0 14px rgba(255, 170, 90, .28);
}

#ui-root .fx-shot-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
#ui-root .fx-shot-name {
  font-size: 11px; letter-spacing: .2em; color: var(--ink);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
#ui-root .fx-dots { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
#ui-root .fx-dot {
  width: 6px; height: 6px; padding: 0; border-radius: 50%;
  background: rgba(242, 236, 225, .22);
  transition: background-color .3s ease, box-shadow .3s ease, transform .3s ease;
}
#ui-root .fx-dot:hover { background: rgba(242, 236, 225, .5); transform: scale(1.25); }
#ui-root .fx-dot[aria-pressed="true"] {
  background: var(--accent);
  box-shadow: 0 0 10px 1px rgba(255, 180, 105, .6);
}

#ui-root .fx-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
#ui-root .fx-field { display: flex; align-items: center; gap: 6px; flex: 1 1 auto; min-width: 0; }
#ui-root .fx-field-label { font-size: 9.5px; letter-spacing: .2em; color: var(--ink-dim); flex: 0 0 auto; }
#ui-root .fx-select {
  flex: 1 1 auto; min-width: 0;
  padding: 4px 6px;
  font: inherit; font-size: 11px; letter-spacing: .12em;
  color: var(--ink);
  background: rgba(0, 0, 0, .28);
  border: 1px solid var(--line);
  border-radius: 2px;
  cursor: pointer;
  appearance: none; -webkit-appearance: none;
  transition: border-color .28s ease, background-color .28s ease;
}
#ui-root .fx-select:hover { border-color: rgba(255, 180, 105, .45); }
#ui-root .fx-select option { background: #16130f; color: #f2ece1; }

#ui-root .fx-btn {
  padding: 4px 9px;
  font-size: 11px; letter-spacing: .14em;
  color: var(--ink-dim);
  border: 1px solid var(--line);
  border-radius: 2px;
  background: rgba(0, 0, 0, .18);
  white-space: nowrap;
  transition: color .28s ease, border-color .28s ease, background-color .28s ease;
}
#ui-root .fx-btn:hover { color: var(--ink); border-color: rgba(255, 180, 105, .5); background: rgba(255, 180, 105, .07); }
#ui-root .fx-btn:active { transform: translateY(1px); }

/* ---------------- 右上：性能读数 ---------------- */
#ui-root > .fx-perf {
  top: 22px; right: 24px;
  min-width: 148px;
  padding: 7px 10px 8px;
  font-size: 10.5px;
  color: rgba(242, 236, 225, .58);
}
body.cinema #ui-root > .fx-perf { top: calc(6.2vh + 18px); }
body.booting #ui-root > .fx-perf { top: 22px; }
#ui-root .fx-perf-head {
  display: flex; align-items: center; gap: 6px;
  width: 100%;
  font-size: 9px; letter-spacing: .34em;
  color: rgba(242, 236, 225, .45);
  transition: color .28s ease;
}
#ui-root .fx-perf-head:hover { color: var(--ink); }
#ui-root .fx-perf-pip {
  width: 4px; height: 4px; border-radius: 50%;
  background: #8fbf6a;
  box-shadow: 0 0 8px rgba(143, 191, 106, .7);
  flex: 0 0 auto;
}
#ui-root .fx-perf-caret { margin-left: auto; opacity: .5; font-size: 8px; transition: transform .3s ease; }
#ui-root > .fx-perf[data-collapsed="1"] .fx-perf-caret { transform: rotate(-90deg); }
#ui-root .fx-perf-body { margin-top: 6px; display: flex; flex-direction: column; gap: 2px; }
#ui-root > .fx-perf[data-collapsed="1"] .fx-perf-body { display: none; }
#ui-root .fx-perf-line { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; }
#ui-root .fx-perf-line > span { letter-spacing: .22em; font-size: 9px; opacity: .72; }
#ui-root .fx-perf-line > b { font-weight: 400; color: rgba(242, 236, 225, .82); font-variant-numeric: tabular-nums; }

/* ---------------- 首屏提示 ---------------- */
#ui-root > .fx-hint {
  position: fixed;
  left: 50%; bottom: calc(6.2vh + 108px);
  transform: translateX(-50%);
  padding: 7px 15px;
  font-size: 10.5px; letter-spacing: .22em;
  color: rgba(242, 236, 225, .62);
  background: rgba(16, 14, 12, .4);
  border: 1px solid var(--line);
  border-radius: 2px;
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
  pointer-events: none !important;
  opacity: 0;
  transition: opacity .9s ease .2s;
  z-index: 1;
}
body.booting #ui-root > .fx-hint { bottom: 108px; }
#ui-root > .fx-hint.fx-show { opacity: 1; }

/* ---------------- 窄屏：一条底部控制栏 + 折叠品牌区 ---------------- */
@media (max-width: 820px) {
  #ui-root > .fx-brand { top: 12px; left: 12px; padding: 9px 13px 9px; max-width: 62vw; }
  body.cinema #ui-root > .fx-brand { top: calc(6.2vh + 10px); }
  #ui-root .fx-brand-title { font-size: 15px; letter-spacing: .26em; text-indent: .26em; }
  #ui-root .fx-brand-sub { display: none; }
  #ui-root .fx-brand-now { margin-top: 5px; padding-top: 5px; font-size: 10px; }
  #ui-root .fx-brand-hint { display: none; }

  #ui-root > .fx-perf { top: 12px; right: 12px; min-width: 104px; padding: 6px 8px; font-size: 10px; }
  body.cinema #ui-root > .fx-perf { top: calc(6.2vh + 10px); }
  #ui-root .fx-perf-body { display: none; }
  #ui-root > .fx-perf[data-collapsed="0"] .fx-perf-body { display: flex; }

  /* 底部两块的定位交给 dock（flex 纵向排列），不再各自算 bottom，永远不会互相压住 */
  #ui-root > .fx-dock {
    display: flex;
    flex-direction: column;
    gap: 6px;
    position: fixed;
    left: 8px; right: 8px;
    bottom: calc(6.2vh + 12px);
    z-index: 1;
  }
  body.booting #ui-root > .fx-dock { bottom: 12px; }
  #ui-root > .fx-dock > .fx-panel {
    position: static;
    top: auto; right: auto; bottom: auto; left: auto;
    width: auto; max-width: none; margin: 0;
  }
  #ui-root .fx-times { padding: 5px 6px 4px; align-items: stretch; }
  #ui-root .fx-times-row {
    overflow-x: auto;
    scrollbar-width: none;
    justify-content: space-between;
  }
  #ui-root .fx-times-row::-webkit-scrollbar { display: none; }
  #ui-root .fx-chip { padding: 5px 7px 6px; font-size: 11px; letter-spacing: .1em; gap: 4px; }
  #ui-root .fx-chip-idx { display: none; }
  #ui-root .fx-keys { display: none; }

  #ui-root .fx-ctl { padding: 8px 9px; gap: 7px; }
  #ui-root .fx-actions { gap: 5px; }
  #ui-root .fx-btn { padding: 4px 7px; font-size: 10.5px; letter-spacing: .08em; }

  #ui-root > .fx-hint { bottom: calc(6.2vh + 230px); font-size: 10px; letter-spacing: .16em; }
  body.booting #ui-root > .fx-hint { bottom: 230px; }
}

@media (prefers-reduced-motion: reduce) {
  #ui-root .fx-panel,
  #ui-root .fx-chip,
  #ui-root .fx-chip::after,
  #ui-root .fx-dot,
  #ui-root .fx-seg-btn,
  #ui-root > .fx-hint { transition-duration: .01ms !important; transition-delay: 0s !important; }
  #ui-root .fx-panel.fx-pre { opacity: 1; transform: none; }
}
`;

/* =========================================================================
 * createUI
 * ========================================================================= */
export function createUI(opts = {}) {
  const {
    presets = [], quality = [], qualityKey, presetKey, cinematic = true, stats,
    onPreset, onQuality, onCamera, onShot, onReset, onFullscreen, onHideUI,
  } = opts;

  const root = document.getElementById('ui-root');
  if (!root) {
    console.warn('[ui] 找不到 #ui-root，界面未创建');
    return {
      reveal() {}, setPreset() {}, setQuality() {}, setCameraMode() {},
      setShot() {}, setStats() {}, setState() {}, destroy() {},
    };
  }

  const presetList = Array.isArray(presets) && presets.length
    ? presets
    : [{ key: 'golden', label: '黄金时刻', hint: '17:40 · 逆光穿林的丁达尔光束' }];
  const qualityList = Array.isArray(quality) && quality.length
    ? quality
    : [{ key: 'high', label: '高画质' }];
  const presetByKey = new Map(presetList.map((p) => [p.key, p]));

  const disposers = [];
  const timers = [];
  const on = (el, type, fn, opt) => { el.addEventListener(type, fn, opt); disposers.push(() => el.removeEventListener(type, fn, opt)); };
  const later = (fn, ms) => { const id = setTimeout(fn, ms); timers.push(id); return id; };

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  /* ------------------------------------------------------------ 样式注入 */
  const style = el('style');
  style.textContent = STYLE;
  root.appendChild(style);

  /* ------------------------------------------------------------ 底部 dock（桌面端 display:contents，窄屏时合成一条控制栏） */
  const dock = el('div', 'fx-dock');

  /* ------------------------------------------------------------ 品牌区（左上） */
  const brand = el('div', 'fx-panel fx-brand fx-pre');
  brand.setAttribute('role', 'banner');
  const brandTitle = el('div', 'fx-brand-title', '林間小屋');
  const brandSub = el('div', 'fx-brand-sub', 'FOREST CABIN');
  const brandNow = el('div', 'fx-brand-now');
  const brandDot = el('span', 'fx-brand-dot');
  const brandLabel = el('span', 'fx-brand-label', '');
  const brandSep = el('span', 'fx-brand-sep', '·');
  const brandHint = el('span', 'fx-brand-hint', '');
  brandNow.append(brandDot, brandLabel, brandSep, brandHint);
  brand.append(brandTitle, brandSub, brandNow);

  /* ------------------------------------------------------------ 时段片（底部中） */
  const times = el('div', 'fx-panel fx-times fx-pre');
  times.setAttribute('role', 'group');
  times.setAttribute('aria-label', '时段切换');
  const timesRow = el('div', 'fx-times-row');
  const chips = new Map();
  presetList.forEach((p, i) => {
    const btn = el('button', 'fx-chip');
    btn.type = 'button';
    btn.setAttribute('aria-label', `切换到${p.label}`);
    btn.setAttribute('aria-pressed', 'false');
    btn.append(el('span', 'fx-chip-idx', String(i + 1)), el('span', 'fx-chip-label', p.label));
    on(btn, 'click', () => { onPreset?.(p.key); setPreset(p.key); });
    chips.set(p.key, btn);
    timesRow.appendChild(btn);
  });
  const keys = el('div', 'fx-keys', '1–6 切换时段 · C 运镜 · H 隐藏界面 · 空格 下一镜');
  times.append(timesRow, keys);

  /* ------------------------------------------------------------ 控制面板（右下） */
  const ctl = el('div', 'fx-panel fx-ctl fx-pre');
  ctl.setAttribute('role', 'group');
  ctl.setAttribute('aria-label', '场景控制');

  // 相机模式
  const seg = el('div', 'fx-seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', '相机模式');
  const segBtns = new Map();
  [['cinematic', '电影运镜'], ['free', '自由漫游']].forEach(([mode, label]) => {
    const b = el('button', 'fx-seg-btn', label);
    b.type = 'button';
    b.setAttribute('aria-label', `切换到${label}`);
    b.setAttribute('aria-pressed', 'false');
    on(b, 'click', () => { onCamera?.(mode); setCameraMode(mode); });
    segBtns.set(mode, b);
    seg.appendChild(b);
  });

  // 镜头名 + 圆点
  const shotRow = el('div', 'fx-shot-row');
  const shotName = el('span', 'fx-shot-name', '建立镜头');
  const dots = el('span', 'fx-dots');
  dots.setAttribute('role', 'group');
  dots.setAttribute('aria-label', '镜头切换');
  shotRow.append(shotName, dots);

  // 动作行
  const actions = el('div', 'fx-actions');
  const field = el('label', 'fx-field');
  const fieldLabel = el('span', 'fx-field-label', '画质');
  const select = el('select', 'fx-select');
  select.setAttribute('aria-label', '画质档位');
  qualityList.forEach((qq) => {
    const o = el('option', null, qq.label);
    o.value = qq.key;
    select.appendChild(o);
  });
  select.value = qualityKey || qualityList[0].key;
  on(select, 'change', () => onQuality?.(select.value));
  field.append(fieldLabel, select);

  const btnFull = el('button', 'fx-btn', '全屏');
  btnFull.type = 'button';
  btnFull.setAttribute('aria-label', '进入全屏');
  on(btnFull, 'click', () => onFullscreen?.());

  const btnReset = el('button', 'fx-btn', '重置视角');
  btnReset.type = 'button';
  btnReset.setAttribute('aria-label', '重置视角');
  on(btnReset, 'click', () => onReset?.());

  const btnHide = el('button', 'fx-btn', '隐藏界面');
  btnHide.type = 'button';
  btnHide.setAttribute('aria-label', '隐藏界面');
  on(btnHide, 'click', () => onHideUI?.());

  actions.append(field, btnFull, btnReset, btnHide);
  ctl.append(seg, shotRow, actions);

  /* ------------------------------------------------------------ 性能读数（右上） */
  const perf = el('div', 'fx-panel fx-perf fx-pre');
  const narrow = typeof window !== 'undefined' && window.innerWidth < 820;
  let storedPerf = null;
  try { storedPerf = localStorage.getItem('fc-perf-collapsed'); } catch (e) { /* 隐私模式 */ }
  let perfCollapsed = storedPerf === null ? narrow : storedPerf === '1';
  perf.setAttribute('data-collapsed', perfCollapsed ? '1' : '0');

  const perfHead = el('button', 'fx-perf-head');
  perfHead.type = 'button';
  perfHead.setAttribute('aria-label', '折叠或展开性能读数');
  perfHead.setAttribute('aria-expanded', perfCollapsed ? 'false' : 'true');
  perfHead.append(el('span', 'fx-perf-pip'), el('span', null, 'PERF'), el('span', 'fx-perf-caret', '▾'));
  const perfBody = el('div', 'fx-perf-body');
  const perfVals = {};
  [['fps', 'FPS'], ['tris', '三角面'], ['calls', 'DRAW']].forEach(([k, label]) => {
    const line = el('div', 'fx-perf-line');
    const b = el('b', 'fx-mono', '–');
    perfVals[k] = b;
    line.append(el('span', null, label), b);
    perfBody.appendChild(line);
  });
  perf.append(perfHead, perfBody);
  on(perfHead, 'click', () => {
    perfCollapsed = !perfCollapsed;
    perf.setAttribute('data-collapsed', perfCollapsed ? '1' : '0');
    perfHead.setAttribute('aria-expanded', perfCollapsed ? 'false' : 'true');
    try { localStorage.setItem('fc-perf-collapsed', perfCollapsed ? '1' : '0'); } catch (e) { /* ignore */ }
  });

  /* ------------------------------------------------------------ 首屏提示 */
  const hint = el('div', 'fx-hint', '拖动旋转 · 滚轮缩放');
  hint.setAttribute('role', 'note');

  dock.append(times, ctl);
  // 注意：hint 与 style 必须留在 #ui-root 直接子级（选择器与 pointer-events 约定依赖这一点）
  root.append(brand, dock, perf, hint);

  /* ------------------------------------------------------------ 状态更新 */
  function setPreset(key) {
    if (!key) return;
    chips.forEach((btn, k) => btn.setAttribute('aria-pressed', k === key ? 'true' : 'false'));
    const p = presetByKey.get(key);
    if (p) {
      brandLabel.textContent = p.label || '';
      brandHint.textContent = p.hint || '';
      brandNow.title = `${p.label || ''} · ${p.hint || ''}`;
      brandSep.style.display = p.hint ? '' : 'none';
    }
  }

  function setQuality(key) {
    if (!key) return;
    if ([...select.options].some((o) => o.value === key)) select.value = key;
  }

  function setCameraMode(mode) {
    segBtns.forEach((b, m) => b.setAttribute('aria-pressed', m === mode ? 'true' : 'false'));
  }

  let shotCount = 0;
  function setShot(i, n, name) {
    const count = Math.max(1, n || 1);
    if (count !== shotCount) {
      shotCount = count;
      dots.textContent = '';
      for (let k = 0; k < count; k++) {
        const d = el('button', 'fx-dot');
        d.type = 'button';
        d.setAttribute('aria-label', `切换到第 ${k + 1} 个镜头`);
        d.setAttribute('aria-pressed', 'false');
        on(d, 'click', () => { onShot?.(k); setShot(k, count, null); });
        dots.appendChild(d);
      }
    }
    const idx = clamp(i | 0, 0, count - 1);
    [...dots.children].forEach((d, k) => d.setAttribute('aria-pressed', k === idx ? 'true' : 'false'));
    if (name) shotName.textContent = name;
  }

  /* ---- setStats：节流写入，绝不每帧动 DOM ---- */
  const STATS_INTERVAL = 320;
  let lastStatsAt = 0;
  let statsTimer = 0;
  let pendingStats = stats || null;
  const lastText = { fps: '', tris: '', calls: '' };

  const fmtTris = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n | 0));

  function flushStats() {
    statsTimer = 0;
    const s = pendingStats;
    if (!s) return;
    const text = {
      fps: (typeof s.fps === 'number' && s.fps > 0) ? s.fps.toFixed(1) : '–',
      tris: fmtTris(s.triangles || 0),
      calls: String(s.drawCalls || s.calls || 0),
    };
    for (const k of Object.keys(lastText)) {
      if (text[k] !== lastText[k]) {
        lastText[k] = text[k];
        perfVals[k].textContent = text[k];
      }
    }
  }

  function setStats(s) {
    if (!s) return;
    pendingStats = s;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - lastStatsAt >= STATS_INTERVAL) {
      lastStatsAt = now;
      flushStats();
    } else if (!statsTimer) {
      statsTimer = later(flushStats, Math.max(60, STATS_INTERVAL - (now - lastStatsAt)));
    }
  }

  /* ---- setState：只更新必要文本 ---- */
  let lastName = '';
  function setState(state) {
    if (!state) return;
    const key = state.key || presetKey;
    const p = presetByKey.get(key);
    const label = state.label || (p && p.label) || '';
    const hintText = state.hint || (p && p.hint) || '';
    const name = label + '·' + hintText;
    if (name === lastName) return;
    lastName = name;
    if (label) brandLabel.textContent = label;
    brandHint.textContent = hintText;
    brandNow.title = `${label} · ${hintText}`;
    brandSep.style.display = hintText ? '' : 'none';
    if (state.key && chips.has(state.key)) {
      chips.forEach((btn, k) => btn.setAttribute('aria-pressed', k === state.key ? 'true' : 'false'));
    }
  }

  /* ---- reveal：错峰淡入（总时长 < 1.2s）---- */
  let revealed = false;
  function reveal() {
    if (revealed) return;
    revealed = true;
    const seq = [
      [brand, 0],
      [times, 90],
      [ctl, 180],
      [perf, 260],
    ];
    for (const [node, delay] of seq) {
      node.style.setProperty('--d', PREFERS_REDUCED ? '0ms' : `${delay}ms`);
      node.classList.remove('fx-pre');
      node.classList.add('fx-in');
    }
    // 首屏提示：淡入 → 3s 后淡出
    later(() => hint.classList.add('fx-show'), PREFERS_REDUCED ? 0 : 520);
    later(() => hint.classList.remove('fx-show'), 3000);
    later(() => { hint.remove(); }, 4200);
  }

  /* ---- destroy ---- */
  function destroy() {
    for (const t of timers) clearTimeout(t);
    timers.length = 0;
    for (const fn of disposers) { try { fn(); } catch (e) { /* ignore */ } }
    disposers.length = 0;
    [brand, times, ctl, perf, hint, style].forEach((n) => n.remove());
  }

  /* ---- 全屏按钮文字跟随状态 ---- */
  const onFsChange = () => {
    const fs = !!document.fullscreenElement;
    btnFull.textContent = fs ? '退出全屏' : '全屏';
    btnFull.setAttribute('aria-label', fs ? '退出全屏' : '进入全屏');
  };
  on(document, 'fullscreenchange', onFsChange);
  onFsChange();

  /* ---- 初始状态 ---- */
  setPreset(presetKey || presetList[0].key);
  setQuality(qualityKey || qualityList[0].key);
  setCameraMode(cinematic ? 'cinematic' : 'free');
  setShot(0, 6, null);

  return { reveal, setPreset, setQuality, setCameraMode, setShot, setStats, setState, destroy };
}
