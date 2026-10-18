/**
 * main.js — 装配与主循环
 * ---------------------------------------------------------------
 * 职责：建渲染器 / 相机 / 后处理，按阶段装配各模块，
 * 每帧把 sky 的状态广播给所有模块，跑电影运镜或自由漫游。
 * 各模块互不 import，只在这里组装；任何一步失败都会显示在页面上而不是白屏。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  CLEARING, CABIN, POND, PATH, WORLD, terrainHeight,
  clamp, lerp, smoothstep, damp, setAnisotropy, updateWind, tickWind,
  countTris, texture, TAU,
} from './core.js';
import { createSky, TIME_PRESETS, PRESET_ORDER } from './sky.js';
import { createTerrain } from './terrain.js';
import { createCabin } from './cabin.js';
import { createForest } from './forest.js';
import { createProps } from './props.js';
import { createAtmos } from './atmos.js';
import { createPost } from './post.js';
import { createUI } from './ui.js';

/* ------------------------------------------------------------- 画质档 */
const QUALITY = {
  low: { key: 'low', label: '流畅', pr: 0.85, shadowMap: 1024, shadowRadius: 1, trees: 0.55, grass: 0.4, particles: 0.4, far: 260, volumetric: 0, segments: 128, aniso: 2 },
  medium: { key: 'medium', label: '均衡', pr: 1.2, shadowMap: 2048, shadowRadius: 2, trees: 0.8, grass: 0.75, particles: 0.7, far: 330, volumetric: 0.8, segments: 160, aniso: 4 },
  high: { key: 'high', label: '高画质', pr: 1.6, shadowMap: 2048, shadowRadius: 3, trees: 1.0, grass: 1.0, particles: 1.0, far: 400, volumetric: 1, segments: 176, aniso: 8 },
  ultra: { key: 'ultra', label: '电影级', pr: 2.0, shadowMap: 4096, shadowRadius: 4, trees: 1.25, grass: 1.3, particles: 1.3, far: 480, volumetric: 1, segments: 200, aniso: 16 },
};

const params = new URLSearchParams(location.search);
const qKey = params.get('q') && QUALITY[params.get('q')] ? params.get('q') : (localStorage.getItem('fc-quality') || 'high');
const Q = QUALITY[qKey];
const shotMode = params.has('shot');
if (shotMode) document.body.classList.add('shot');

/* --------------------------------------------------------- 载入进度 */
const loadEl = document.getElementById('loading');
const barEl = document.getElementById('load-bar');
const stageEl = document.getElementById('load-stage');
function progress(p, label) {
  if (barEl) barEl.style.transform = `scaleX(${p})`;
  if (label && stageEl) stageEl.textContent = label;
}
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
async function stage(p, label, fn) {
  progress(p, label);
  await nextFrame();
  const t0 = performance.now();
  let out = null;
  try {
    out = await fn();
  } catch (err) {
    console.error(`[stage:${label}]`, err);
    fatal(`${label} 失败：\n${(err && err.stack) || err}`);
  }
  console.log(`[stage] ${label} — ${(performance.now() - t0).toFixed(0)}ms`);
  await nextFrame();
  return out;
}
function fatal(msg) {
  const box = document.getElementById('fatal');
  const body = document.getElementById('fatal-body');
  if (box && body) { body.textContent = String(msg); box.classList.add('show'); }
}
window.addEventListener('error', (e) => fatal(`${e.message}\n${e.filename}:${e.lineno}\n${(e.error && e.error.stack) || ''}`));
window.addEventListener('unhandledrejection', (e) => fatal(`Unhandled: ${(e.reason && (e.reason.stack || e.reason.message)) || e.reason}`));

/* ------------------------------------------------------------- 渲染器 */
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: false, powerPreference: 'high-performance',
  stencil: false, alpha: false, preserveDrawingBuffer: true,
});
setAnisotropy(Q.aniso);
let pixelRatio = Math.min(window.devicePixelRatio || 1, Q.pr);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(innerWidth, innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;   // 由 OutputPass 应用
renderer.toneMappingExposure = TIME_PRESETS.golden.exposure;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(new THREE.Color(TIME_PRESETS.golden.fog.color), TIME_PRESETS.golden.fog.density);

const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, Q.far);
const G = CLEARING.height;
camera.position.set(15, G + 6.5, 22);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.target.set(0, G + 2.0, 0);
controls.minDistance = 4;
controls.maxDistance = 78;
controls.maxPolarAngle = Math.PI * 0.49;
controls.update();

const app = {
  scene, camera, renderer, controls, Q, qKey,
  presetName: params.get('preset') && TIME_PRESETS[params.get('preset')] ? params.get('preset') : 'golden',
  cinematic: params.get('cam') !== 'free',
  shotIndex: 0,
  paused: false,
  time: 0,
  errors: [],
  stats: { fps: 0, tris: 0, calls: 0 },
  THREE,
};
window.__scene = app;

/* ---------------------------------------------------------- 装配模块 */
progress(0.05, '铺设地形…');
const terrain = await stage(0.2, '铺设地形与池塘水面…', () => {
  const m = createTerrain({ quality: Q, texture });
  scene.add(m.group);
  return m;
});

const cabin = await stage(0.42, '建造木屋…', () => {
  const m = createCabin({ quality: Q, texture });
  scene.add(m.group);
  return m;
});

const props = await stage(0.55, '摆放院落道具…', () => {
  const m = createProps({ quality: Q });
  scene.add(m.group);
  return m;
});

const forest = await stage(0.72, '种植森林…', () => {
  const m = createForest({ quality: Q });
  scene.add(m.group);
  return m;
});

const sky = await stage(0.84, '布置天空与光照…', () => {
  const m = createSky({ quality: Q, preset: app.presetName, camera, texture });
  scene.add(m.group);
  m.setPreset(app.presetName, true);
  return m;
});

const atmos = await stage(0.9, '播撒炊烟与浮尘…', () => {
  const m = createAtmos({ quality: Q, chimney: cabin?.chimneyTop || new THREE.Vector3(0, 6, 0) });
  scene.add(m.group);
  return m;
});

const post = await stage(0.96, '架设后处理…', () => {
  const m = createPost({ renderer, scene, camera, quality: Q });
  m.setSize(innerWidth, innerHeight, pixelRatio);
  return m;
});

app.terrain = terrain; app.cabin = cabin; app.forest = forest;
app.sky = sky; app.post = post;

/* -------------------------------------------------------- 电影运镜 */
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const SHOTS = [
  { name: '建立镜头', pos: V(14.5, G + 5.2, 17.5), look: V(-0.4, G + 2.2, 0.4), dur: 22, fov: 38, path: 'ease' },
  { name: '门前小径', pos: V(-1.6, G + 1.85, 15.5), look: V(-1.4, G + 1.7, 4.0), dur: 17, fov: 33, path: 'push' },
  { name: '逆光林隙', pos: V(-13.5, G + 2.7, -11.0), look: V(2.2, G + 2.2, 3.4), dur: 19, fov: 40, path: 'dolly' },
  { name: '环屋巡游', pos: V(0, G + 3.6, 0), look: V(0, G + 2.0, 0), dur: 26, fov: 40, path: 'orbit', radius: 13.5, height: 3.6 },
  { name: '池塘', pos: V(POND.center.x + 4.5, G + 2.1, POND.center.z + 11.5), look: V(POND.center.x - 1, G + 1.4, POND.center.z - 5), dur: 20, fov: 42, path: 'float' },
  { name: '檐下仰视', pos: V(-6.2, G + 1.3, 9.5), look: V(1.6, G + 5.6, -0.6), dur: 18, fov: 46, path: 'tilt' },
];
app.shots = SHOTS.map((s) => s.name);

let shotTime = 0;

/* ------------------------------------------------------------------
 * 视线清理
 * 镜头一不小心就会怼进树干里，整屏被一张木纹糊住。这里在初始化时
 * 沿「机位 → 目标」逐段检测是否穿过树冠圆柱，被挡就把机位往目标拉近，
 * 直到视线干净为止。只在启动时算一次，运行期零开销。
 * ------------------------------------------------------------------ */
function sightClear(from, to) {
  const trees = forest?.trees;
  if (!trees || !trees.length) return true;
  // 机位本身就在树冠里：这一条必须单独判。过滤「离机位太近」的树会漏掉
  // 正好糊在镜头上的那几株 —— 实测池塘镜头就死在这儿。
  for (let i = 0; i < trees.length; i++) {
    const t = trees[i];
    if (from.y > t.top || from.y < t.base - 1.2) continue;
    if (Math.hypot(t.x - from.x, t.z - from.z) < t.r * 0.85 + 0.4) return false;
  }
  const dx = to.x - from.x, dz = to.z - from.z;
  const len2 = dx * dx + dz * dz;
  if (len2 < 0.04) return true;
  for (let i = 0; i < trees.length; i++) {
    const t = trees[i];
    const s = ((t.x - from.x) * dx + (t.z - from.z) * dz) / len2;
    if (s < 0 || s > 0.995) continue;
    const cx = from.x + dx * s, cz = from.z + dz * s;
    const cy = lerp(from.y, to.y, s);
    if (cy > t.top || cy < t.base - 0.8) continue;
    if (Math.hypot(t.x - cx, t.z - cz) < t.r * 0.8 + 0.45) return false;
  }
  return true;
}
for (const s of SHOTS) {
  const p = s.pos.clone();
  for (let i = 0; i < 40 && !sightClear(p, s.look); i++) p.lerp(s.look, 0.06);
  if (!sightClear(p, s.look)) {
    // 实在清不出来就把机位抬到目标正上方一点，至少不会怼在树干里
    p.lerp(s.look, 0.55);
    p.y = terrainHeight(p.x, p.z) + 2.6;
  }
  s._pos = p;
}
let camFrom = { pos: camera.position.clone(), look: controls.target.clone(), fov: camera.fov };
let camBlend = 1;
const _p = new THREE.Vector3();
const _l = new THREE.Vector3();

function shotPose(shot, t) {
  const p = clamp(t / shot.dur, 0, 1);
  const base = shot._pos || shot.pos;
  if (shot.path === 'orbit') {
    const a = p * TAU * 0.8 + 0.7;
    _p.set(Math.sin(a) * shot.radius, G + shot.height + Math.sin(p * 2.3) * 0.4, Math.cos(a) * shot.radius);
    _l.set(shot.look.x, shot.look.y, shot.look.z);
  } else if (shot.path === 'push') {
    _p.copy(base).lerp(new THREE.Vector3().lerpVectors(base, shot.look, 0.42), smoothstep(0, 1, p));
    _l.copy(shot.look);
  } else if (shot.path === 'dolly') {
    _p.copy(base).add(V(Math.sin(p * 1.1) * 2.6 - 1.2, Math.sin(p * 2) * 0.22, -Math.cos(p * 0.9) * 1.4));
    _l.copy(shot.look).add(V(0, Math.sin(p * 1.6) * 0.14, 0));
  } else if (shot.path === 'float') {
    _p.copy(base).add(V(Math.sin(p * 0.8) * 1.2, Math.sin(p * 1.9) * 0.16, Math.sin(p * 1.3) * 1.8));
    _l.copy(shot.look).add(V(Math.sin(p * 0.7) * 0.6, 0, 0));
  } else if (shot.path === 'tilt') {
    _p.copy(base).add(V(0, Math.sin(p * 1.4) * 0.2, Math.cos(p * 0.7) * 0.8));
    _l.copy(shot.look).add(V(0, Math.cos(p * 1.2) * 0.9, 0));
  } else {
    _p.copy(base).add(V(Math.sin(p * 0.6) * 1.6, -p * 2.6, Math.cos(p * 0.5) * 2.0));
    _l.copy(shot.look);
  }
  // 手持呼吸：极小幅度的低频噪声，让画面「有空气」
  const t2 = performance.now() * 0.001;
  _p.x += Math.sin(t2 * 0.61) * 0.05 + Math.sin(t2 * 1.63) * 0.018;
  _p.y += Math.sin(t2 * 0.83 + 1.3) * 0.04;
  _p.z += Math.cos(t2 * 0.71 + 0.4) * 0.045;

  // 离地保护：池塘一带是盆地，镜头一旦低于地面整屏就是黑的
  _p.y = Math.max(_p.y, terrainHeight(_p.x, _p.z) + 1.15);
}

function gotoShot(i) {
  const n = SHOTS.length;
  app.shotIndex = ((i % n) + n) % n;
  shotTime = 0;
  camBlend = 0;
  camFrom = { pos: camera.position.clone(), look: controls.target.clone(), fov: camera.fov };
  ui?.setShot?.(app.shotIndex, n, SHOTS[app.shotIndex].name);
}
app.gotoShot = gotoShot;

function setCinematic(on) {
  app.cinematic = on;
  controls.enabled = !on;
  if (on) { camBlend = 0; shotTime = 0; camFrom = { pos: camera.position.clone(), look: controls.target.clone(), fov: camera.fov }; }
  ui?.setCameraMode?.(on ? 'cinematic' : 'free');
}
app.setCinematic = setCinematic;

/* 截图 / 调试锚点 */
app.applyShot = (i, t) => {
  app.cinematic = true;
  controls.enabled = false;
  app.shotIndex = clamp(i | 0, 0, SHOTS.length - 1);
  const s = SHOTS[app.shotIndex];
  shotPose(s, t ?? s.dur * 0.5);
  camera.position.copy(_p);
  controls.target.copy(_l);
  camera.lookAt(_l);
  if (s.fov) { camera.fov = s.fov; camera.updateProjectionMatrix(); }
  camBlend = 1;
  app.paused = true;
};
app.placeCamera = (px, py, pz, tx, ty, tz, fov) => {
  app.cinematic = false;
  controls.enabled = true;
  camera.position.set(px, py, pz);
  controls.target.set(tx, ty, tz);
  if (fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
  controls.update();
};
app.setPaused = (v) => { app.paused = !!v; };
app.setPreset = (name) => sky.setPreset(name);
app.setPostEnabled = (v) => { app.postOff = !v; };
app.hide = (k, v) => { if (app[k] && app[k].group) app[k].group.visible = v; };
app.ready = false;

/* --------------------------------------------------------------- 界面 */
const ui = await stage(0.99, '点亮界面…', () => createUI({
  presets: PRESET_ORDER.map((k) => ({ key: k, label: TIME_PRESETS[k].label, hint: TIME_PRESETS[k].hint })),
  qualities: Object.values(QUALITY).map((q) => ({ key: q.key, label: q.label })),
  qualityKey: qKey,
  presetKey: app.presetName,
  cinematic: app.cinematic,
  shots: SHOTS.map((s) => s.name),
  onPreset: (k) => sky.setPreset(k),
  onShot: (i) => gotoShot(i),
  onCamera: (v) => setCinematic(v),
  onQuality: (k) => { localStorage.setItem('fc-quality', k); const u = new URL(location.href); u.searchParams.set('q', k); location.href = u.toString(); },
}));
app.ui = ui;

/* ------------------------------------------------------------ 尺寸 */
function onResize() {
  const w = innerWidth, h = innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  post.setSize(w, h, pixelRatio);
}
addEventListener('resize', onResize);
onResize();

/* ------------------------------------------------------------ 快捷键 */
addEventListener('keydown', (e) => {
  if (e.target && /input|textarea/i.test(e.target.tagName)) return;
  const k = e.key.toLowerCase();
  if (k === 'c') setCinematic(!app.cinematic);
  else if (k === 'h') document.body.classList.toggle('ui-hidden');
  else if (k === 'f') { document.fullscreenElement ? document.exitFullscreen?.() : document.documentElement.requestFullscreen?.().catch(() => {}); }
  else if (k === 'r') { setCinematic(false); app.placeCamera(18, G + 4.2, 24, 0, G + 2.0, 0); }
  else if (k === 'p') app.setPaused(!app.paused);
  else if (k === ' ') { e.preventDefault(); gotoShot(app.shotIndex + 1); }
  else if (k === 'arrowright') gotoShot(app.shotIndex + 1);
  else if (k === 'arrowleft') gotoShot(app.shotIndex - 1);
  else if (/^[1-5]$/.test(k)) sky.setPreset(PRESET_ORDER[+k - 1]);
});

/* ------------------------------------------------- 自适应分辨率 */
let fpsAcc = 0, fpsFrames = 0, cooldown = 4;
function adapt(dt) {
  fpsAcc += dt; fpsFrames++;
  if (fpsAcc < 1) return;
  const fps = fpsFrames / fpsAcc;
  app.stats.fps = fps;
  fpsAcc = 0; fpsFrames = 0;
  if (--cooldown > 0) return;
  const base = Math.min(devicePixelRatio || 1, Q.pr);
  const floor = Math.max(0.6, base * 0.55);
  if (fps < 42 && pixelRatio > floor) {
    pixelRatio = Math.max(floor, pixelRatio - 0.12);
    renderer.setPixelRatio(pixelRatio); post.setSize(innerWidth, innerHeight, pixelRatio); cooldown = 3;
  } else if (fps > 58 && pixelRatio < base) {
    pixelRatio = Math.min(base, pixelRatio + 0.08);
    renderer.setPixelRatio(pixelRatio); post.setSize(innerWidth, innerHeight, pixelRatio); cooldown = 6;
  }
}

/* ------------------------------------------------------------ 主循环 */
let last = performance.now() / 1000;
let frames = 0;

function tick() {
  const now = performance.now() / 1000;
  const raw = Math.min(now - last, 0.25);
  last = now;
  const dt = app.paused ? 0 : Math.min(raw, 1 / 20);
  app.time += dt;
  const t = app.time;

  // 1) 大气状态（sky 是唯一写入者）
  sky?.update(t, dt, camera);
  const state = sky ? sky.state : null;
  if (!state) { renderer.render(scene, camera); requestAnimationFrame(tick); return; }

  // 2) 相机
  if (app.cinematic) {
    const s = SHOTS[app.shotIndex];
    shotTime += dt;
    if (shotTime > s.dur) gotoShot(app.shotIndex + 1);
    shotPose(s, shotTime);
    camBlend = Math.min(1, camBlend + dt / 2.4);
    const k = smoothstep(0, 1, camBlend);
    camera.position.lerpVectors(camFrom.pos, _p, k);
    const look = new THREE.Vector3().lerpVectors(camFrom.look, _l, k);
    camera.lookAt(look);
    controls.target.copy(look);
    if (s.fov) {
      const fov = lerp(camFrom.fov, s.fov, k);
      if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
    }
  } else {
    controls.update();
    camera.fov = damp(camera.fov, 44, 3, dt);
    camera.updateProjectionMatrix();
  }

  // 3) 世界更新（任何模块缺失都只是少一块内容，不能让整站停摆）
  updateWind(t, state.wind, state.wind);
  if (forest) tickWind(forest.windMats, t);
  terrain?.update(t, dt, state, camera);
  cabin?.update(t, dt, state);
  forest?.update(t, dt, state);
  atmos?.update(t, dt, camera, state);
  post?.setState(state, t, dt);

  // 4) 渲染
  renderer.toneMappingExposure = state.exposure * (state.exposureScale ?? 1);
  scene.fog.color.set(state.fog.color);
  scene.fog.density = state.fog.density;
  if (app.postOff) renderer.render(scene, camera);
  else post.render(dt, t);

  // 5) 统计
  if (++frames % 40 === 0) {
    app.stats.tris = countTris(scene);
    app.stats.calls = renderer.info.render.calls;
    ui?.setStats?.(app.stats);
  }
  adapt(raw);
  requestAnimationFrame(tick);
}

progress(1, '完成');
gotoShot(0);
if (!app.cinematic) { app.placeCamera(18, G + 4.2, 24, 0, G + 2.0, 0); gotoShot(0); }
tick();

setTimeout(() => {
  loadEl?.classList.add('hidden');
  app.ready = true;
  ui?.reveal?.();
  console.log('%c林间小屋 / Forest Cabin', 'color:#ffb469;font-weight:bold', `three r${THREE.REVISION} · ${qKey} · 树 ${forest.count} · 草 ${forest.grass} · 三角面 ${countTris(scene)}`);
}, shotMode ? 60 : 400);
