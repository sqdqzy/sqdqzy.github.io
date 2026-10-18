/**
 * ui.js — 控制界面（自建 DOM，样式内联注入）
 * 界面要克制：默认只留标题与一行提示，其余收进右下角的面板，
 * 免得在「电影感」的画面上压一层厚重的 GUI。
 */
export function createUI(opts) {
  const root = document.getElementById('ui-root');
  const style = document.createElement('style');
  style.textContent = `
    .fc-panel{position:fixed;right:18px;bottom:18px;z-index:30;font:12px/1.6 "PingFang SC","Microsoft YaHei",system-ui,sans-serif;
      color:rgba(244,238,228,.9);background:rgba(16,15,13,.62);backdrop-filter:blur(14px);
      border:1px solid rgba(244,238,228,.14);border-radius:12px;padding:12px 13px;min-width:184px;
      box-shadow:0 12px 40px rgba(0,0,0,.42);opacity:0;transform:translateY(8px);transition:.5s}
    .fc-panel.in{opacity:1;transform:none}
    .fc-panel h4{margin:0 0 8px;font-size:11px;letter-spacing:.22em;color:rgba(244,238,228,.45);font-weight:400}
    .fc-row{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:9px}
    .fc-btn{appearance:none;border:1px solid rgba(244,238,228,.18);background:rgba(244,238,228,.06);
      color:rgba(244,238,228,.78);padding:5px 9px;border-radius:7px;cursor:pointer;font:inherit;
      transition:.18s;white-space:nowrap}
    .fc-btn:hover{background:rgba(255,180,105,.16);border-color:rgba(255,180,105,.45);color:#ffd9ad}
    .fc-btn.on{background:rgba(255,180,105,.2);border-color:rgba(255,180,105,.6);color:#ffdcae}
    .fc-title{position:fixed;left:22px;bottom:22px;z-index:30;font-family:"Songti SC","Noto Serif SC",Georgia,serif;
      color:rgba(246,238,224,.9);text-shadow:0 2px 24px rgba(0,0,0,.6);opacity:0;transition:.8s}
    .fc-title.in{opacity:1}
    .fc-title b{display:block;font-size:21px;letter-spacing:.34em;font-weight:400}
    .fc-title span{display:block;margin-top:5px;font:11px/1.4 "PingFang SC",system-ui,sans-serif;
      letter-spacing:.18em;color:rgba(246,238,224,.5)}
    .fc-hint{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:30;
      font:11px/1 "PingFang SC",system-ui,sans-serif;letter-spacing:.16em;color:rgba(246,238,224,.32);
      opacity:0;transition:.8s}
    .fc-hint.in{opacity:1}
    body.ui-hidden .fc-panel,body.ui-hidden .fc-title,body.ui-hidden .fc-hint{opacity:0;pointer-events:none}
    .fc-lb{position:fixed;left:0;right:0;height:0;background:#000;z-index:25;pointer-events:none;transition:height .8s cubic-bezier(.4,0,.2,1)}
    body.cinema .fc-lb{height:5.6vh}
    body.shot .fc-lb,body.shot .fc-panel,body.shot .fc-title,body.shot .fc-hint,body.shot #loading{display:none!important}
  `;
  document.head.appendChild(style);

  const el = document.createElement('div');
  el.className = 'fc-panel';
  el.innerHTML = '<h4>时 刻</h4><div class="fc-row" data-row="preset"></div>'
    + '<h4>镜 头</h4><div class="fc-row" data-row="shot"></div>'
    + '<h4>画 质</h4><div class="fc-row" data-row="quality"></div>'
    + '<div class="fc-row" data-row="mode"></div>';
  root.appendChild(el);

  const title = document.createElement('div');
  title.className = 'fc-title';
  title.innerHTML = '<b>林 間 小 屋</b><span>FOREST CABIN · PROCEDURAL SCENE</span>';
  root.appendChild(title);

  const hint = document.createElement('div');
  hint.className = 'fc-hint';
  hint.textContent = '拖动旋转 · 滚轮缩放 · C 切换运镜 · 空格换镜头 · 1-5 换时刻 · H 隐藏界面';
  root.appendChild(hint);

  for (const cls of ['lb', 'lb']) {
    const d = document.createElement('div');
    d.className = 'fc-lb';
    root.appendChild(d);
  }

  const row = (name) => el.querySelector(`[data-row="${name}"]`);
  const mkBtn = (parent, label, on, fn) => {
    const b = document.createElement('button');
    b.className = 'fc-btn' + (on ? ' on' : '');
    b.textContent = label;
    b.addEventListener('click', fn);
    parent.appendChild(b);
    return b;
  };

  const presetBtns = {};
  for (const p of opts.presets) {
    presetBtns[p.key] = mkBtn(row('preset'), p.label, p.key === opts.presetKey, () => {
      opts.onPreset(p.key);
      for (const k in presetBtns) presetBtns[k].classList.toggle('on', k === p.key);
    });
  }
  const shotBtns = [];
  opts.shots.forEach((name, i) => {
    const b = mkBtn(row('shot'), String(i + 1), i === 0, () => { opts.onShot(i); selectShot(i); });
    b.title = name;
    shotBtns.push(b);
  });
  function selectShot(i) { shotBtns.forEach((b, k) => b.classList.toggle('on', k === i)); }
  for (const q of opts.qualities) mkBtn(row('quality'), q.label, q.key === opts.qualityKey, () => opts.onQuality(q.key));
  mkBtn(row('mode'), '自由漫游', !opts.cinematic, () => {
    opts.onCamera(!opts.cinematic);
    row('mode').firstChild.classList.toggle('on', opts.cinematic);
  });

  document.body.classList.add('cinema');

  return {
    reveal() {
      setTimeout(() => { el.classList.add('in'); title.classList.add('in'); hint.classList.add('in'); }, 350);
    },
    setShot(i, n, name) { selectShot(i); },
    setCameraMode() {},
    setStats() {},
    setPreset(k) { for (const x in presetBtns) presetBtns[x].classList.toggle('on', x === k); },
  };
}
