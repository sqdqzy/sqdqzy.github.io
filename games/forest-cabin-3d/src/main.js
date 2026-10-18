/**
 * main.js — 装配层 / 控制器（Lead 所有）
 * ---------------------------------------------------------------------------
 * 职责：
 *   1. 渲染器、相机、OrbitControls、后处理装配
 *   2. 分阶段构建场景（cabin / props / terrain / forest / sky / particles）
 *   3. 每帧把 atmosphere 解析出的 state 广播给其他模块（单向数据流）
 *   4. 电影运镜（Cinematic Director）+ 自由漫游
 *   5. UI 事件入口、键盘快捷键、性能自适应
 *
 * 约定：模块之间互不 import，只由这里装配；任何模块缺失/报错都不应导致整站白屏。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  getQuality, getPreset, TIME_PRESETS, PRESET_ORDER, QUALITY_PRESETS,
  configureTextures, updateWind, CABIN, DOOR, CLEARING, POND, WORLD,
  terrainHeight, countScene, damp, clamp, lerp, smoothstep, TAU, DEG,
} from './core.js';

const params = new URLSearchParams(location.search);
const qualityKey = params.get('q') && QUALITY_PRESETS[params.get('q')] ? params.get('q') : (localStorage.getItem('fc-quality') || 'high');
const QUALITY = getQuality(qualityKey);
const isShot = params.get('shot') === '1' || params.has('shot');
if (isShot) document.body.classList.add('shot');

/* ------------------------------------------------------------------ 载入进度 */
const loadEl = document.getElementById('loading');
const barEl = document.getElementById('load-bar');
const stageEl = document.getElementById('load-stage');
let progress = 0;
function setProgress(p, label) {
  progress = Math.max(progress, p);
  if (barEl) barEl.style.right = (100 - progress * 100).toFixed(1) + '%';
  if (label && stageEl) stageEl.textContent = label;
}
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
async function stage(p, label, fn) {
  setProgress(p, label);
  await nextFrame();
  const t0 = performance.now();
  let out = null;
  try { out = await fn(); } catch (err) {
    console.error(`[stage:${label}]`, err);
    (window.__fatal || console.error)(`阶段「${label}」失败：\n${(err && err.stack) || err}`);
  }
  console.log(`[stage] ${label} — ${(performance.now() - t0).toFixed(0)}ms`);
  await nextFrame();
  return out;
}

/* ------------------------------------------------------------------ 渲染器 */
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: QUALITY.key === 'ultra', powerPreference: 'high-performance',
  stencil: false, alpha: false, preserveDrawingBuffer: true,
});
const basePixelRatio = Math.min(window.devicePixelRatio || 1, QUALITY.pixelRatio);
renderer.setPixelRatio(basePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = QUALITY.shadows;
renderer.shadowMap.type = THREE.PCFShadowMap;   // r185 已弃用 PCFSoftShadowMap；柔和度用 light.shadow.radius
renderer.toneMapping = THREE.ACESFilmicToneMapping;   // 由 OutputPass 应用
renderer.toneMappingExposure = getPreset('golden').exposure;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.info.autoReset = false;
configureTextures(QUALITY.anisotropy);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(new THREE.Color(getPreset('golden').fog.color), getPreset('golden').fog.density);

const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, QUALITY.far);
camera.position.set(16, 7.5, 30);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.055;
controls.target.set(CABIN.center.x, CLEARING.height + 1.5, CABIN.center.z);
controls.minDistance = 5;
controls.maxDistance = 90;
controls.maxPolarAngle = Math.PI * 0.495;   // 不允许钻到地下
controls.autoRotateSpeed = 0.28;
controls.enablePan = true;
controls.update();

/* ------------------------------------------------------------------ 场景模块 */
const app = {
  THREE, scene, camera, renderer, controls, QUALITY, qualityKey,
  modules: {}, errors: [], ready: false, frames: 0,
  presetName: params.get('preset') && TIME_PRESETS[params.get('preset')] ? params.get('preset') : 'golden',
  cinematic: params.get('cam') !== 'free',
  shotIndex: 0,
  stats: { fps: 0, triangles: 0, meshes: 0, calls: 0 },
};
window.__scene = app;
setProgress(0.04, '正在准备渲染器…');

const opt = { scene, renderer, camera, quality: QUALITY, qualityKey, preset: app.presetName, rng: undefined };

await stage(0.10, '铺设地形与池塘水面…', async () => {
  const m = await import('./terrain.js');
  app.modules.terrain = m.createTerrain(opt);
  if (app.modules.terrain?.group) scene.add(app.modules.terrain.group);
});

await stage(0.24, '建造木屋与院落…', async () => {
  const m = await import('./cabin.js');
  app.modules.cabin = m.createCabin(opt);
  if (app.modules.cabin?.group) scene.add(app.modules.cabin.group);
});

await stage(0.42, '摆放生活道具…', async () => {
  const m = await import('./props.js');
  app.modules.props = m.createProps(opt);
  if (app.modules.props?.group) scene.add(app.modules.props.group);
});

await stage(0.58, '种植森林（树木、灌木、草…）', async () => {
  const m = await import('./forest.js');
  app.modules.forest = m.createForest(opt);
  if (app.modules.forest?.group) scene.add(app.modules.forest.group);
});

await stage(0.76, '布置天空、太阳与雾…', async () => {
  const m = await import('./sky.js');
  app.modules.sky = m.createAtmosphere(opt);
  if (app.modules.sky?.group) scene.add(app.modules.sky.group);
  app.modules.sky?.setPreset?.(app.presetName, true);
});

await stage(0.86, '播撒尘埃、落叶与萤火…', async () => {
  const m = await import('./particles.js');
  app.modules.particles = m.createParticles(opt);
  if (app.modules.particles?.group) scene.add(app.modules.particles.group);
});

const postfx = await stage(0.93, '架设后处理与调色…', async () => {
  const m = await import('./postfx.js');
  const fx = m.createPostFX({ renderer, scene, camera, quality: QUALITY });
  fx?.setSize?.(window.innerWidth, window.innerHeight, basePixelRatio);
  return fx;
});
app.modules.postfx = postfx;

const ui = await stage(0.97, '点亮界面…', async () => {
  const m = await import('./ui.js');
  return m.createUI({
    presets: PRESET_ORDER.map((k) => ({ key: k, label: TIME_PRESETS[k].label, hint: TIME_PRESETS[k].hint })),
    quality: Object.values(QUALITY_PRESETS).map((q) => ({ key: q.key, label: q.label })),
    qualityKey,
    presetKey: app.presetName,
    cinematic: app.cinematic,
    stats: app.stats,
    onPreset: (k) => setPreset(k),
    onQuality: (k) => { localStorage.setItem('fc-quality', k); location.href = withParam('q', k); },
    onCamera: (mode) => setCinematic(mode === 'cinematic'),
    onShot: (i) => gotoShot(i),
    onReset: () => resetView(),
    onFullscreen: () => toggleFullscreen(),
    onHideUI: () => toggleUI(),
  });
});
app.modules.ui = ui;

// 后处理已自带暗角/调色时，关闭 CSS 兜底暗角，避免叠加成"黑圈"
if (postfx?.gradeActive !== false) {
  const vig = document.getElementById('vignette');
  if (vig) vig.style.opacity = '0';
}
if (postfx?.gradeActive === false) console.warn('[main] postfx 未启用调色，使用 CSS 兜底暗角');

/* ------------------------------------------------------------------ 状态广播 */
function broadcast(state, dt) {
  renderer.toneMappingExposure = state.exposure;

  if (scene.fog) {
    scene.fog.color.set(state.fog.color);
    scene.fog.density = state.fog.density;
  }

  const t = performance.now() / 1000;
  app.modules.terrain?.setState?.(state, t, dt);
  app.modules.cabin?.setState?.(state, t, dt);
  app.modules.props?.setState?.(state, t, dt);
  app.modules.forest?.setState?.(state, t, dt);
  app.modules.particles?.setState?.(state, t, dt);
  postfx?.setState?.(state, t, dt);
  ui?.setState?.(state);
}

/* ------------------------------------------------------------------ 预设切换 */
let presetBlend = 1;                      // 0..1，切换动画进度
let presetFrom = getPreset('golden');
let presetTo = getPreset('golden');
function setPreset(name, instant = false) {
  if (!TIME_PRESETS[name]) return;
  presetFrom = app.modules.sky?.state || getPreset(app.presetName);
  presetTo = getPreset(name);
  app.presetName = name;
  presetBlend = instant ? 1 : 0;
  app.modules.sky?.setPreset?.(name, instant);
  ui?.setPreset?.(name);
}
app.setPreset = setPreset;

/* ------------------------------------------------------------------ 相机：电影运镜 */
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const CAB = V(CABIN.center.x, CLEARING.height, CABIN.center.z);
const G = CLEARING.height;   // 院落地坪高度

/* ------------------------------------------------------------------ 视线自动清理
 * 相机掉进树冠里会让整屏被一片叶子糊住。这里用射线检测「相机→目标」是否被植被挡住，
 * 被挡住就把机位逐步抬高（再不行就缩短距离），保证每个镜头的视线干净。
 * 只把植被当遮挡物：栅栏、门廊、地面之类出现在画面里是正常的。
 */
const _vegRe = /forest|treewall|spruce|pine|birch|broad|dead|canopy|foliage|shrub/i;
const _sightMeshes = [];
function refreshSightMeshes() {
  _sightMeshes.length = 0;
  scene.traverse((o) => { if (o.isMesh) _sightMeshes.push(o); });
}
const _rc = new THREE.Raycaster();
function sightBlocked(from, to) {
  const dir = new THREE.Vector3().subVectors(to, from);
  const dist = dir.length();
  if (dist < 0.01) return false;
  _rc.set(from, dir.normalize());
  _rc.far = dist;
  const hits = _rc.intersectObjects(_sightMeshes, false);
  for (const h of hits) {
    if (h.distance > dist - 1.2) break;
    if (_vegRe.test(h.object.name || '')) return true;
  }
  return false;
}
/** 为某个镜头求出无遮挡机位（首次进入该镜头时计算一次并缓存） */
function clearSight(shot) {
  if (shot._cleared) return shot._cleared;
  let best = shot.pos.clone();
  let ok = false;
  // 1) 抬高
  for (let i = 0; i < 16; i++) {
    if (!sightBlocked(best, shot.target)) { ok = true; break; }
    best.y += 1.15;
  }
  // 2) 抬高无效则向目标靠近（越靠近越可能进空地）
  if (!ok) {
    best = shot.pos.clone();
    for (let i = 0; i < 10; i++) {
      best.lerp(shot.target, 0.1);
      if (!sightBlocked(best, shot.target)) { ok = true; break; }
      best.y += 0.5;
    }
  }
  shot._cleared = best;
  if (!ok) console.warn(`[camera] 镜头「${shot.name}」视线仍可能被植被遮挡`);
  return best;
}
refreshSightMeshes();
/** 六个镜头（全部落在院子空地内或小径廊道上，再用 clearSight 兜底）
 *  默认黄金时刻的太阳在方位角 42°（相机这一侧偏右、仰角 12.5°）：
 *  → 正面机位是暖光正打，长影落向屋后；逆光机位放到屋后西北侧回头看太阳。 */
const SHOTS = [
  { name: '建立镜头', pos: V(CAB.x + 12.0, G + 8.2, CAB.z + 17.0), target: V(CAB.x + 0.5, G + 2.6, CAB.z - 0.5), dur: 20, fov: 42, path: 'ease' },
  { name: '黄金逆光', pos: V(CAB.x - 13.0, G + 3.0, CAB.z - 3.4), target: V(CAB.x + 0.5, G + 2.3, CAB.z + 0.5), dur: 17, fov: 38, path: 'dolly' },
  { name: '门前小径', pos: V(DOOR.x + 4.6, G + 1.9, DOOR.z + 9.2), target: V(DOOR.x - 0.4, G + 1.6, DOOR.z), dur: 15, fov: 32, path: 'push' },
  { name: '环屋巡游', pos: V(CAB.x, G + 3.8, CAB.z), target: V(CAB.x, G + 1.9, CAB.z), dur: 22, fov: 38, path: 'orbit', orbitR: 12.6, orbitH: 3.8 },
  { name: '池塘倒影', pos: V(POND.center.x + 3.2, POND.level + 0.95, POND.center.z + 10.6), target: V(POND.center.x - 1.2, POND.level + 1.9, POND.center.z - 6.5), dur: 18, fov: 40, path: 'float' },
  { name: '檐下仰视', pos: V(CAB.x - 7.0, G + 1.25, CAB.z + 8.6), target: V(CAB.x + 1.6, G + 5.2, CAB.z - 0.8), dur: 17, fov: 40, path: 'tilt' },
];
for (const s of SHOTS) clearSight(s);   // 初始化时就把每个镜头的视线清干净
let shotTime = 0;
let shotFrom = { pos: camera.position.clone(), target: controls.target.clone(), fov: camera.fov };
const camTargetPos = new THREE.Vector3();
const camTargetLook = new THREE.Vector3();
const _sph = new THREE.Spherical();

function shotCamera(shot, tIn) {
  const p = shot.dur > 0 ? clamp(tIn / shot.dur, 0, 1) : 0;
  const base = shot._cleared || shot.pos;
  if (shot.path === 'orbit') {
    const a = p * TAU * 0.85 + 0.6;
    const r = shot.orbitR * (1 - 0.08 * p);
    camTargetPos.set(base.x + Math.sin(a) * r, shot.orbitH + G + Math.sin(p * 2.2) * 0.5, base.z + Math.cos(a) * r);
    camTargetLook.copy(shot.target);
  } else if (shot.path === 'push') {
    camTargetPos.lerpVectors(base, base.clone().add(shot.target.clone().sub(base).multiplyScalar(0.42)), smoothstep(0, 1, p));
    camTargetLook.copy(shot.target);
  } else if (shot.path === 'dolly') {
    // 沿 X 缓慢横移，制造视差
    camTargetPos.copy(base).add(V(Math.sin(p * 1.1) * 2.4 - 1.6, Math.sin(p * 2.0) * 0.3, -Math.cos(p * 0.9) * 1.6));
    camTargetLook.copy(shot.target).add(V(0, Math.sin(p * 1.6) * 0.16, 0));
  } else if (shot.path === 'float') {
    camTargetPos.copy(base).add(V(Math.sin(p * 0.8) * 1.4, Math.sin(p * 1.9) * 0.18, Math.sin(p * 1.3) * 2.0));
    camTargetLook.copy(shot.target).add(V(Math.sin(p * 0.7) * 0.7, 0, 0));
  } else if (shot.path === 'tilt') {
    camTargetPos.copy(base).add(V(0, Math.sin(p * 1.4) * 0.26, Math.cos(p * 0.7) * 0.9));
    camTargetLook.copy(shot.target).add(V(0, Math.cos(p * 1.2) * 1.1, 0));
  } else {
    // ease：高处缓慢下降
    camTargetPos.copy(base).add(V(Math.sin(p * 0.6) * 1.6, -p * 2.0, Math.cos(p * 0.5) * 2.0));
    camTargetLook.copy(shot.target);
  }
  // 手持感呼吸噪声
  const t = performance.now() * 0.001;
  camTargetPos.x += Math.sin(t * 0.63) * 0.055 + Math.sin(t * 1.71) * 0.022;
  camTargetPos.y += Math.sin(t * 0.87 + 1.3) * 0.045;
  camTargetPos.z += Math.cos(t * 0.71 + 0.4) * 0.05;
}

let camTransition = 1;  // 1 = 已完成
let prevShotIndex = 0;
function gotoShot(i) {
  const n = SHOTS.length;
  app.shotIndex = ((i % n) + n) % n;
  shotTime = 0;
  camTransition = 0;
  shotFrom = { pos: camera.position.clone(), target: controls.target.clone(), fov: camera.fov };
  ui?.setShot?.(app.shotIndex, n, SHOTS[app.shotIndex].name);
}
function setCinematic(on) {
  app.cinematic = on;
  controls.enabled = !on;
  if (on) { camTransition = 0; shotTime = 0; shotFrom = { pos: camera.position.clone(), target: controls.target.clone(), fov: camera.fov }; }
  else { controls.target.copy(camTargetLook); controls.update(); }
  ui?.setCameraMode?.(on ? 'cinematic' : 'free');
}
function resetView() {
  setCinematic(false);
  camera.position.set(CAB.x + 17, CLEARING.height + 3.4, CAB.z + 20);
  controls.target.set(CAB.x, CLEARING.height + 1.9, CAB.z);
  controls.update();
  camTargetLook.copy(controls.target);
}
app.gotoShot = gotoShot;
app.setCinematic = setCinematic;

/* ---- 调试 / 截图锚点（Lead 视觉验收用） ---- */
let paused = false;
app.setPaused = (v) => { paused = !!v; };
/** 把相机直接放到某个镜头的 tIn 时刻（用于稳定截图） */
app.applyShot = (i, tIn) => {
  app.cinematic = true;
  controls.enabled = false;
  app.shotIndex = clamp(i | 0, 0, SHOTS.length - 1);
  const shot = SHOTS[app.shotIndex];
  shotTime = tIn ?? shot.dur * 0.5;
  shotCamera(shot, shotTime);
  camera.position.copy(camTargetPos);
  controls.target.copy(camTargetLook);
  camera.lookAt(camTargetLook);
  camera.fov = shot.fov || camera.fov;
  camera.updateProjectionMatrix();
  camTransition = 1;
  shotFrom = { pos: camera.position.clone(), target: camTargetLook.clone(), fov: camera.fov };
  ui?.setShot?.(app.shotIndex, SHOTS.length, shot.name);
  ui?.setCameraMode?.('cinematic');
};
/** 把相机放到任意机位（世界坐标数组简写） */
app.placeCamera = (px, py, pz, tx, ty, tz, fov) => {
  app.cinematic = false;
  controls.enabled = true;
  camera.position.set(px, py, pz);
  controls.target.set(tx, ty, tz);
  if (fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
  controls.update();
};
app.shots = SHOTS.map((s) => s.name);

/* ---- 后处理 A/B 调试开关（Lead 归因用） ---- */
let postfxEnabled = true;
app.setPostFXEnabled = (v) => { postfxEnabled = !!v; };
app.passNames = () => (postfx?.composer?.passes || []).map((p, i) => `${i}:${p.constructor?.name || p.type || '?'}`);
app.setPassEnabled = (i, v) => { const p = postfx?.composer?.passes?.[i]; if (p) p.enabled = !!v; return !!p; };
/** 冻结大气状态机，之后可以直接改 app.state 做对比测试 */
app.freezeSky = () => { const sky = app.modules.sky; if (sky) sky.update = () => {}; };
/** 隐藏某个模块的 group */
app.hide = (key, v = false) => { const g = app.modules[key]?.group; if (g) g.visible = v; return !!g; };

/* ------------------------------------------------------------------ 交互 */
function withParam(key, value) {
  const u = new URL(location.href);
  u.searchParams.set(key, value);
  return u.toString();
}
function toggleUI() { document.body.classList.toggle('ui-hidden'); }
function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  else document.exitFullscreen?.();
}
const camModeLabel = () => (app.cinematic ? '电影运镜' : '自由漫游');
window.addEventListener('keydown', (e) => {
  if (e.target && /input|textarea/i.test(e.target.tagName)) return;
  const k = e.key.toLowerCase();
  if (k === 'c') setCinematic(!app.cinematic);
  else if (k === 'h') toggleUI();
  else if (k === 'f') toggleFullscreen();
  else if (k === 'r') resetView();
  else if (k === 'p') app.setPaused(!paused);
  else if (k === ' ') { e.preventDefault(); gotoShot(app.shotIndex + 1); }
  else if (k === 'arrowright' && app.cinematic) gotoShot(app.shotIndex + 1);
  else if (k === 'arrowleft' && app.cinematic) gotoShot(app.shotIndex - 1);
  else if (/^[1-6]$/.test(k) && PRESET_ORDER[+k - 1]) setPreset(PRESET_ORDER[+k - 1]);
});

/* ------------------------------------------------------------------ 自适应分辨率 */
let fpsAccum = 0, fpsFrames = 0, currentPR = basePixelRatio, perfCooldown = 4;
function adaptPerformance(dt) {
  fpsAccum += dt; fpsFrames++;
  if (fpsAccum < 1) return;
  const fps = fpsFrames / fpsAccum;
  app.stats.fps = fps;
  fpsAccum = 0; fpsFrames = 0;
  perfCooldown -= 1;
  if (perfCooldown > 0) return;
  const floorPR = Math.max(0.62, basePixelRatio * 0.55);
  if (fps < 42 && currentPR > floorPR) {
    currentPR = Math.max(floorPR, currentPR - 0.12);
    renderer.setPixelRatio(currentPR);
    postfx?.setSize?.(window.innerWidth, window.innerHeight, currentPR);
    perfCooldown = 3;
  } else if (fps > 58 && currentPR < basePixelRatio) {
    currentPR = Math.min(basePixelRatio, currentPR + 0.08);
    renderer.setPixelRatio(currentPR);
    postfx?.setSize?.(window.innerWidth, window.innerHeight, currentPR);
    perfCooldown = 6;
  }
}

/* ------------------------------------------------------------------ 尺寸 */
function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  postfx?.setSize?.(w, h, renderer.getPixelRatio());
  app.modules.sky?.resize?.(w, h);
}
window.addEventListener('resize', onResize);

/* ------------------------------------------------------------------ 主循环 */
let lastTime = performance.now() / 1000;
let elapsed = 0;
let _stateCache = getPreset('golden');

function tick() {
  const now = performance.now() / 1000;
  const raw = Math.min(now - lastTime, 0.25);   // 自己算 delta，THREE.Clock 在 r185 已弃用
  lastTime = now;
  const dt = paused ? 0 : Math.min(raw, 1 / 20);
  if (!paused) elapsed += dt;

  // ---- 1. 光照/氛围状态机（sky.js 是 state 的唯一写入者）
  const sky = app.modules.sky;
  sky?.update?.(elapsed, dt, camera);
  let state = sky?.state;
  if (!state) {
    presetBlend = Math.min(1, presetBlend + dt * 0.6);
    state = presetBlend >= 1 ? presetTo : blendFallback(presetFrom, presetTo, smoothstep(0, 1, presetBlend));
    _stateCache = state;
  }
  state = state || _stateCache;
  app.state = state;

  // ---- 2. 相机
  if (app.cinematic) {
    const shot = SHOTS[app.shotIndex];
    shotTime += dt;
    if (shotTime > shot.dur) { gotoShot(app.shotIndex + 1); }
    shotCamera(shot, shotTime);
    camTransition = Math.min(1, camTransition + dt / 2.6);
    const k = smoothstep(0, 1, camTransition);
    camera.position.lerpVectors(shotFrom.pos, camTargetPos, k);
    const look = new THREE.Vector3().lerpVectors(shotFrom.target, camTargetLook, k);
    camera.lookAt(look);
    controls.target.copy(look);
    if (shot.fov) {
      const fov = lerp(shotFrom.fov, shot.fov, k);
      if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
    }
  } else {
    controls.update();
    camera.fov = damp(camera.fov, 42, 3, dt);
    camera.updateProjectionMatrix();
  }

  // ---- 3. 世界更新
  updateWind(elapsed);
  app.modules.terrain?.update?.(elapsed, dt, state);
  app.modules.cabin?.update?.(elapsed, dt, state);
  app.modules.props?.update?.(elapsed, dt, state);
  app.modules.forest?.update?.(elapsed, dt, state);
  app.modules.particles?.update?.(elapsed, dt, camera, state);
  broadcast(state, dt);

  // ---- 4. 渲染
  renderer.info.reset();
  if (postfxEnabled && postfx?.render) postfx.render(dt, elapsed);
  else renderer.render(scene, camera);
  app.frames++;

  // ---- 5. 统计
  if (app.frames % 30 === 0) {
    const c = countScene(scene);
    app.stats.triangles = c.triangles;
    app.stats.meshes = c.meshes;
    app.stats.drawCalls = renderer.info.render.calls;
    ui?.setStats?.(app.stats);
  }
  adaptPerformance(raw);
  requestAnimationFrame(tick);
}

/** postfx 缺失时的降级混合 */
function blendFallback(a, b, t) {
  const out = JSON.parse(JSON.stringify(a));
  const walk = (x, y, o) => {
    for (const k of Object.keys(x)) {
      if (typeof x[k] === 'number' && typeof y[k] === 'number') o[k] = lerp(x[k], y[k], t);
      else if (typeof x[k] === 'string') o[k] = t < 0.5 ? x[k] : y[k];
      else if (x[k] && typeof x[k] === 'object') { o[k] = o[k] || {}; walk(x[k], y[k] || {}, o[k]); }
    }
  };
  walk(a, b, out);
  return out;
}

/* ------------------------------------------------------------------ 启动 */
setProgress(1, '完成');
onResize();
app.modules.sky?.setPreset?.(app.presetName, true);
gotoShot(0);
if (!app.cinematic) { resetView(); gotoShot(0); }
tick();

setTimeout(() => {
  loadEl?.classList.add('hidden');
  document.body.classList.remove('booting');
  app.ready = true;
  ui?.reveal?.();
}, isShot ? 60 : 500);

console.log('%c林间小屋 / Forest Cabin', 'color:#ffb469;font-weight:bold', `three r${THREE.REVISION} · 质量=${QUALITY.key}`);
