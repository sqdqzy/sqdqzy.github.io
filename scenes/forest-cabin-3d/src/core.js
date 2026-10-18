/**
 * core.js — 森林小屋场景的共享契约层（由 Lead 维护，其他模块只读）
 * ---------------------------------------------------------------------------
 * 这里的任何导出都是「跨模块接口」，被 cabin/terrain/forest/sky/particles/postfx/ui 共同使用。
 * 规则：
 *   1. 其他模块只允许 import 'three' 与 './core.js'，模块之间不互相 import（由 main.js 装配）。
 *   2. 地形高度、路径、空地、池塘只有这里一份定义，所有模块必须调用 sampleTerrain() 取地面高度。
 *   3. 光照/色彩预设（TIME_PRESETS）是 atmosphere ↔ postfx ↔ particles ↔ cabin 的唯一通信格式。
 */
import * as THREE from 'three';

/* =========================================================================
 * 0. 数学 / 随机 / 噪声
 * ========================================================================= */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b - a === 0 ? 0 : (v - a) / (b - a));
export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}
/** 帧率无关的指数趋近 */
export const damp = (cur, target, lambda, dt) => lerp(cur, target, 1 - Math.exp(-lambda * dt));
export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

/** mulberry32：可复现随机数 */
export function makeRng(seed = 1337) {
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.range = (min, max) => min + rng() * (max - min);
  rng.int = (min, max) => Math.floor(min + rng() * (max - min + 1));
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length) % arr.length];
  rng.sign = () => (rng() < 0.5 ? -1 : 1);
  /** 近似正态分布，用于自然的尺寸/颜色分布 */
  rng.gauss = (mean = 0, sd = 1) => {
    const u = Math.max(1e-6, rng());
    const v = rng();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
  };
  return rng;
}

function hash2i(x, y) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

/** 2D value noise，返回 [-1,1] */
export function noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const n00 = hash2i(xi, yi), n10 = hash2i(xi + 1, yi);
  const n01 = hash2i(xi, yi + 1), n11 = hash2i(xi + 1, yi + 1);
  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return (a + (b - a) * v) * 2 - 1;
}

/** 分形噪声，返回约 [-1,1] */
export function fbm(x, y, octaves = 4, lacunarity = 2.0, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(x * freq, y * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / (norm || 1);
}

/** 域扭曲噪声：让地形/岩石更自然 */
export function warpedFbm(x, y, octaves = 4, warp = 1.4) {
  const wx = fbm(x * 0.5 + 5.2, y * 0.5 - 1.3, 2);
  const wy = fbm(x * 0.5 - 3.7, y * 0.5 + 8.1, 2);
  return fbm(x + wx * warp, y + wy * warp, octaves);
}

/* =========================================================================
 * 1. 世界布局常量（所有模块共用，保证「地形 / 木屋 / 路径 / 空地」完全对齐）
 * ========================================================================= */

export const WORLD = {
  size: 240,          // 地面边长（米）
  segments: 240,      // 地面网格分段
  half: 120,
  buildRadius: 112,   // 可布置内容的最大半径
  fogVisibility: 130,
};

/** 木屋院落（空地）——木屋落位于此，地面被压平 */
export const CLEARING = {
  center: { x: -9, z: 1 },
  inner: 8.6,         // 完全平坦区
  outer: 21,          // 过渡到自然地形的外缘
  height: 0,          // 由下方初始化（院子基准高程）
};

/** 木屋体积参数（cabin.js / props.js / 相机 都要用到） */
export const CABIN = {
  center: CLEARING.center,
  width: 7.4,         // X 方向（山墙面宽）
  depth: 5.8,         // Z 方向（进深）
  wallHeight: 3.05,
  logRadius: 0.19,
  roofRise: 2.25,
  roofOverhang: 0.95,
  foundation: 0.42,   // 石砌地基露出高度
  doorFacing: 1,      // 正门朝 +Z
  rotation: -0.16,    // 轻微转角，构图不死板
  porchDepth: 2.1,
  chimney: { x: 1.6, z: -1.5, radius: 0.46, height: 4.9 },
};
/** 正门世界坐标（路径终点、灯笼、台阶都以此为准） */
export const DOOR = { x: 0, z: 0 };
/** 生成后由 initDoorPoint() 写入 */
function initDoorPoint() {
  const s = Math.sin(CABIN.rotation), c = Math.cos(CABIN.rotation);
  const lx = 0, lz = CABIN.depth / 2 + CABIN.porchDepth * 0.4;
  DOOR.x = CABIN.center.x + lx * c + lz * s;
  DOOR.z = CABIN.center.z - lx * s + lz * c;
}

/** 池塘（reflect 水面 + 倒影，推进「电影感」） */
export const POND = {
  center: { x: 24, z: -22 },
  radius: 9.5,
  depth: 1.45,
  level: 0,           // 由下方初始化（水面高程）
};

/**
 * 朝阳缺口（林间空地开口）
 * ---------------------------------------------------------------------------
 * 默认预设「黄金时刻」的太阳在方位角 42°、仰角 18°。如果四周都是 15~25m 高的树，
 * 这个角度的阳光永远照不到院子——画面只剩环境光，又暗又平。
 * 所以从院子朝太阳方向开一个扇形缺口：扇形内只留草与低矮灌木，不放高大乔木。
 * 这是美术选择（真实林间木屋也总有这样一片向阳的空地），同时形成了进光通道，
 * 让阳光真正落在屋前，并在缺口两侧形成漂亮的光影边缘。
 */
export const SUN_GAP = {
  azimuth: 42,        // 与 golden 预设太阳方位一致（+Z 为 0°，向 +X 为正）
  halfAngle: 31,      // 半张角（度）
  edge: 12,           // 边缘渐隐宽度（度）
  radius: 78,         // 完全无乔木的半径
  fadeRadius: 92,     // 渐隐到自然森林
};

/** 返回 0..1 的「处于向阳缺口」权重 */
export function inSunGap(x, z, out = { angle: 0, radial: 0 }) {
  const dx = x - CLEARING.center.x, dz = z - CLEARING.center.z;
  const r = Math.hypot(dx, dz);
  if (r > SUN_GAP.fadeRadius) return 0;
  let ang = Math.atan2(dx, dz) / DEG;                 // 与 sunDirection 同一套约定
  let d = Math.abs(((ang - SUN_GAP.azimuth + 540) % 360) - 180);
  const angular = 1 - smoothstep(SUN_GAP.halfAngle, SUN_GAP.halfAngle + SUN_GAP.edge, d);
  const radial = 1 - smoothstep(SUN_GAP.radius, SUN_GAP.fadeRadius, r);
  out.angle = angular; out.radial = radial;
  return angular * radial;
}

/** 小径：从西南方林间通向木屋正门 */
export const PATH = {
  halfWidth: 1.35,
  points: [
    { x: 74, z: 108 },
    { x: 52, z: 84 },
    { x: 38, z: 62 },
    { x: 27, z: 43 },
    { x: 15, z: 27 },
    { x: 4, z: 17 },
    { x: -4, z: 11 },
    { x: -8.4, z: 7.2 },
  ],
};

/* ---- 地形基函数（先定义，再用于初始化 CLEARING.height / POND.level） ---- */

function hillsRaw(x, z) {
  let h = fbm(x * 0.0085, z * 0.0085, 4) * 7.2;
  h += fbm(x * 0.032 + 13.1, z * 0.032 - 7.4, 3) * 1.5;
  h += fbm(x * 0.13 - 4.2, z * 0.13 + 9.8, 2) * 0.3;
  const r = Math.hypot(x, z);
  const ring = smoothstep(50, 124, r);
  h += Math.pow(ring, 1.3) * 32;      // 远处环山，把视线封在森林里
  return h;
}

let _pondLevel = null;
function pondLevel() {
  if (_pondLevel === null) _pondLevel = hillsRaw(POND.center.x, POND.center.z) + 0.22;
  return _pondLevel;
}

function hills(x, z) {
  let h = hillsRaw(x, z);
  const dp = Math.hypot(x - POND.center.x, z - POND.center.z);
  const basin = 1 - smoothstep(0, POND.radius * 1.8, dp);
  if (basin > 1e-4) {
    const target = pondLevel() - POND.depth * (1 - smoothstep(0, POND.radius * 0.95, dp));
    h = lerp(h, target, basin);
  }
  return h;
}

/** 点到小径的最近点（内联，热路径） */
const _near = { dist: 0, x: 0, z: 0, t: 0 };
export function pathNearest(x, z, out = _near) {
  const pts = PATH.points;
  let best = Infinity, bx = 0, bz = 0, bt = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const abx = b.x - a.x, abz = b.z - a.z;
    const len2 = abx * abx + abz * abz;
    let t = len2 > 0 ? ((x - a.x) * abx + (z - a.z) * abz) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a.x + abx * t, pz = a.z + abz * t;
    const dx = x - px, dz = z - pz;
    const d2 = dx * dx + dz * dz;
    if (d2 < best) { best = d2; bx = px; bz = pz; bt = (i + t) / (pts.length - 1); }
  }
  out.dist = Math.sqrt(best);
  out.x = bx; out.z = bz; out.t = bt;
  return out;
}
export const pathDistance = (x, z) => pathNearest(x, z).dist;

CLEARING.height = hillsRaw(CLEARING.center.x, CLEARING.center.z) + 0.14;
POND.level = pondLevel();
initDoorPoint();

/** 世界任意点的地面高度（唯一权威实现） */
export function terrainHeight(x, z) {
  let h = hills(x, z);
  const dCab = Math.hypot(x - CLEARING.center.x, z - CLEARING.center.z);
  const clearMask = 1 - smoothstep(CLEARING.inner, CLEARING.outer, dCab);
  const n = pathNearest(x, z);
  const pathMask = (1 - smoothstep(PATH.halfWidth, PATH.halfWidth * 3.4, n.dist)) * (1 - clearMask);
  if (pathMask > 1e-4) {
    const ph = hillsRaw(n.x, n.z) - 0.22;     // 踩踏出的浅凹
    h = lerp(h, ph, pathMask * 0.9);
  }
  if (clearMask > 1e-4) {
    h = lerp(h, CLEARING.height + fbm(x * 0.16, z * 0.16, 2) * 0.07, clearMask);
  }
  return h;
}

const _nA = new THREE.Vector3(), _nB = new THREE.Vector3(), _nC = new THREE.Vector3();
/** 地面法线（有限差分） */
export function terrainNormal(x, z, out = new THREE.Vector3(), eps = 0.7) {
  const hL = terrainHeight(x - eps, z), hR = terrainHeight(x + eps, z);
  const hD = terrainHeight(x, z - eps), hU = terrainHeight(x, z + eps);
  return out.set(hL - hR, 2 * eps, hD - hU).normalize();
}

/** 地面坡度（0=平地，1≈45°+） */
export function terrainSlope(x, z, eps = 1.2) {
  const n = terrainNormal(x, z, _nA, eps);
  return 1 - clamp(n.y, 0, 1);
}

/** 一次性取齐某点的所有环境信息（放置物件必用） */
export function sampleTerrain(x, z) {
  const y = terrainHeight(x, z);
  const near = pathNearest(x, z);
  const cabinDist = Math.hypot(x - CLEARING.center.x, z - CLEARING.center.z);
  const clearing = 1 - smoothstep(CLEARING.inner, CLEARING.outer, cabinDist);
  const pondDist = Math.hypot(x - POND.center.x, z - POND.center.z);
  const pondDepth = POND.level - y;                    // >0 表示在水面以下
  const slope = terrainSlope(x, z);
  const r = Math.hypot(x, z);
  const sunGap = inSunGap(x, z);
  return { y, slope, pathDist: near.dist, pathT: near.t, cabinDist, clearing, pondDist, pondDepth, radius: r, sunGap };
}

/**
 * 植被/道具放置约束：返回 blocked 为 true 的地方禁止生成实体。
 * radius = 物件自身半径（避免压到小径与水面）。
 */
export function placement(x, z, radius = 1) {
  const s = sampleTerrain(x, z);
  let blocked = false;
  if (s.radius > WORLD.buildRadius) blocked = true;
  if (s.clearing > 0.06) blocked = true;                       // 院子留空
  if (s.pathDist < PATH.halfWidth + radius * 0.9) blocked = true;
  if (s.pondDepth > -0.3) blocked = true;                      // 水面及浅滩
  if (s.slope > 0.62) blocked = true;                          // 陡壁
  return { ...s, blocked };
}

/**
 * 乔木专用放置约束：在 placement() 基础上再排除「向阳缺口」。
 * 高大乔木请用这个函数；草 / 灌木 / 蕨类 / 石头 / 蘑菇继续用 placement()。
 */
export function canPlantTree(x, z, radius = 1) {
  const s = placement(x, z, radius);
  if (!s.blocked && s.sunGap > 0.18) return { ...s, blocked: true };
  return s;
}

/* =========================================================================
 * 2. 色彩与光照预设（atmosphere ↔ postfx ↔ particles ↔ cabin 的唯一通信格式）
 * ========================================================================= */

export const PALETTE = {
  bark: '#4a3b30', barkLight: '#7c6553', barkBirch: '#d9d5c8',
  pine: '#2f4530', pineLight: '#4c6b3f', leaf: '#5a7038', leafWarm: '#8a8636',
  grass: '#525f33', grassDry: '#8e8d55', soil: '#4b3c2d',
  log: '#8a6742', logDark: '#5d432c', logLight: '#b08e60',
  roof: '#42352f', roofMoss: '#5a6a45',
  stone: '#8b857a', stoneDark: '#5e5a52', plaster: '#cfc4ae',
  glass: '#2b3a44', metal: '#6d6a66', fabric: '#c9b79b',
  lampGlow: '#ffb057', windowGlow: '#ffb469',
  smoke: '#cfcabf', dust: '#ffe4b5',
};

/** 供 UI 使用的顺序与中文名 */
export const PRESET_ORDER = ['dawn', 'morning', 'golden', 'overcast', 'dusk', 'night'];

/**
 * 每个预设的字段必须齐全（blendPreset 依赖同构结构）。
 * sun.azimuth: 以 +Z 为 0°，向 +X 方向为正，单位度。elevation: 地平线仰角（度）。
 */
export const TIME_PRESETS = {
  dawn: {
    key: 'dawn', label: '破晓', hint: '06:10 · 冷雾与第一缕暖光',
    sun: { azimuth: 96, elevation: 8.0, color: '#ffd2ae', intensity: 3.8, angular: 1.6, bias: -0.0004 },
    ambient: { sky: '#9cc0e0', ground: '#5a5442', intensity: 1.45 },
    fill: { color: '#8aa6cd', intensity: 0.7, azimuth: 260, elevation: 34 },
    hemisphere: { intensity: 1.35 },
    sky: { top: '#2f5280', horizon: '#ffc9a0', ground: '#3a434c', turbidity: 6.5, rayleigh: 2.4, mie: 0.006, mieG: 0.82 },
    fog: { color: '#a9b7c6', density: 0.0052 },
    cloud: { coverage: 0.62, speed: 0.004, color: '#dfe6f0', sunColor: '#ffc79a' },
    exposure: 1.7,
    bloom: { strength: 0.26, threshold: 1.35, radius: 0.66 },
    grade: { temperature: 0.02, tint: -0.01, contrast: 1.05, saturation: 1.1, lift: 0.004, gamma: 1.0, vignette: 0.3, grain: 0.03, chromatic: 0.0007, sharpen: 0.26 },
    volumetric: { strength: 0.34, density: 1.0, samples: 32 },
    particles: { dust: 0.35, pollen: 0.2, leaves: 0.12, fireflies: 0.0, stars: 0.0, birds: 0.25, haze: 0.5 },
    nightFactor: 0.42,
    wind: { strength: 0.5, speed: 0.55 },
  },
  morning: {
    key: 'morning', label: '清晨', hint: '09:00 · 明亮通透',
    sun: { azimuth: 128, elevation: 27, color: '#fff6e8', intensity: 4.2, angular: 1.1, bias: -0.0003 },
    ambient: { sky: '#a8ccee', ground: '#655c48', intensity: 1.55 },
    fill: { color: '#9db8d8', intensity: 0.7, azimuth: 300, elevation: 40 },
    hemisphere: { intensity: 1.5 },
    sky: { top: '#3f7ec0', horizon: '#d9e8f4', ground: '#70705f', turbidity: 3.2, rayleigh: 1.4, mie: 0.004, mieG: 0.8 },
    fog: { color: '#c2d4e4', density: 0.0038 },
    cloud: { coverage: 0.4, speed: 0.006, color: '#ffffff', sunColor: '#fff4dd' },
    exposure: 1.06,
    bloom: { strength: 0.2, threshold: 1.35, radius: 0.58 },
    grade: { temperature: 0.0, tint: 0.0, contrast: 1.03, saturation: 1.12, lift: 0.003, gamma: 1.0, vignette: 0.26, grain: 0.024, chromatic: 0.0005, sharpen: 0.22 },
    volumetric: { strength: 0.26, density: 0.8, samples: 28 },
    particles: { dust: 0.5, pollen: 0.55, leaves: 0.1, fireflies: 0.0, stars: 0.0, birds: 0.5, haze: 0.35 },
    nightFactor: 0.08,
    wind: { strength: 0.7, speed: 0.75 },
  },
  golden: {
    key: 'golden', label: '黄金时刻', hint: '17:40 · 低角度暖光斜切林间',
    sun: { azimuth: 42, elevation: 18, color: '#ffe6cc', intensity: 5.8, angular: 1.3, bias: -0.0005 },
    ambient: { sky: '#9dc3e8', ground: '#655a45', intensity: 1.5 },
    fill: { color: '#9bb4cd', intensity: 0.9, azimuth: 222, elevation: 42 },
    hemisphere: { intensity: 1.25 },
    sky: { top: '#3a6d9f', horizon: '#ffdcbc', ground: '#5f5140', turbidity: 7.5, rayleigh: 2.4, mie: 0.016, mieG: 0.86 },
    fog: { color: '#b3b0a4', density: 0.0038 },
    cloud: { coverage: 0.5, speed: 0.005, color: '#f3e4cf', sunColor: '#ffd0a4' },
    exposure: 1.42,
    bloom: { strength: 0.28, threshold: 1.5, radius: 0.66 },
    grade: { temperature: 0.0, tint: 0.01, contrast: 1.05, saturation: 1.12, lift: 0.008, gamma: 1.0, vignette: 0.28, grain: 0.032, chromatic: 0.0009, sharpen: 0.28 },
    volumetric: { strength: 0.32, density: 1.0, samples: 40 },
    particles: { dust: 1.0, pollen: 0.85, leaves: 0.3, fireflies: 0.05, stars: 0.0, birds: 0.4, haze: 0.55 },
    nightFactor: 0.26,
    wind: { strength: 0.6, speed: 0.6 },
  },
  overcast: {
    key: 'overcast', label: '阴天', hint: '11:20 · 柔和漫射、低饱和',
    sun: { azimuth: 200, elevation: 44, color: '#eef3fa', intensity: 2.4, angular: 3.2, bias: -0.0002 },
    ambient: { sky: '#c2ccd8', ground: '#615c4d', intensity: 1.8 },
    fill: { color: '#c8d1db', intensity: 0.8, azimuth: 20, elevation: 55 },
    hemisphere: { intensity: 1.8 },
    sky: { top: '#8d9aab', horizon: '#c9d2da', ground: '#6e6d64', turbidity: 12, rayleigh: 0.6, mie: 0.03, mieG: 0.75 },
    fog: { color: '#aeb9c4', density: 0.0052 },
    cloud: { coverage: 0.95, speed: 0.009, color: '#b4bec9', sunColor: '#dde4ec' },
    exposure: 0.78,
    bloom: { strength: 0.16, threshold: 1.35, radius: 0.55 },
    grade: { temperature: -0.05, tint: 0.01, contrast: 1.02, saturation: 1.02, lift: 0.003, gamma: 1.02, vignette: 0.24, grain: 0.028, chromatic: 0.0004, sharpen: 0.2 },
    volumetric: { strength: 0.22, density: 0.9, samples: 24 },
    particles: { dust: 0.2, pollen: 0.2, leaves: 0.3, fireflies: 0.0, stars: 0.0, birds: 0.2, haze: 0.6 },
    nightFactor: 0.05,
    wind: { strength: 0.9, speed: 1.0 },
  },
  dusk: {
    key: 'dusk', label: '黄昏', hint: '19:05 · 蓝调与暖窗光',
    sun: { azimuth: 272, elevation: 3.2, color: '#ffc9a8', intensity: 3.0, angular: 2.2, bias: -0.0005 },
    ambient: { sky: '#8fa8d0', ground: '#484338', intensity: 1.35 },
    fill: { color: '#7b96c8', intensity: 0.65, azimuth: 88, elevation: 30 },
    hemisphere: { intensity: 1.25 },
    sky: { top: '#22376a', horizon: '#ffb184', ground: '#33343d', turbidity: 9, rayleigh: 3.0, mie: 0.02, mieG: 0.88 },
    fog: { color: '#8e8ba2', density: 0.0050 },
    cloud: { coverage: 0.66, speed: 0.005, color: '#c9a894', sunColor: '#ffa96e' },
    exposure: 1.95,
    bloom: { strength: 0.32, threshold: 1.38, radius: 0.72 },
    grade: { temperature: 0.02, tint: 0.02, contrast: 1.07, saturation: 1.1, lift: 0.006, gamma: 1.0, vignette: 0.38, grain: 0.04, chromatic: 0.0011, sharpen: 0.28 },
    volumetric: { strength: 0.36, density: 1.2, samples: 36 },
    particles: { dust: 0.6, pollen: 0.3, leaves: 0.25, fireflies: 0.45, stars: 0.12, birds: 0.3, haze: 0.6 },
    nightFactor: 0.68,
    wind: { strength: 0.45, speed: 0.5 },
  },
  night: {
    key: 'night', label: '月夜', hint: '22:30 · 月光、星空与萤火',
    sun: { azimuth: 300, elevation: 38, color: '#aecaff', intensity: 1.4, angular: 1.4, bias: -0.0004 },
    ambient: { sky: '#38496e', ground: '#1c2028', intensity: 0.95 },
    fill: { color: '#48608e', intensity: 0.55, azimuth: 120, elevation: 42 },
    hemisphere: { intensity: 1.0 },
    sky: { top: '#050912', horizon: '#16253e', ground: '#0a0e16', turbidity: 2.0, rayleigh: 0.35, mie: 0.002, mieG: 0.8 },
    fog: { color: '#101a2c', density: 0.0055 },
    cloud: { coverage: 0.3, speed: 0.003, color: '#2c3648', sunColor: '#8aa8d6' },
    exposure: 3.2,
    bloom: { strength: 0.42, threshold: 1.2, radius: 0.8 },
    grade: { temperature: -0.14, tint: 0.02, contrast: 1.09, saturation: 1.05, lift: 0.008, gamma: 1.0, vignette: 0.46, grain: 0.05, chromatic: 0.0014, sharpen: 0.26 },
    volumetric: { strength: 0.35, density: 1.3, samples: 32 },
    particles: { dust: 0.25, pollen: 0.1, leaves: 0.15, fireflies: 1.0, stars: 1.0, birds: 0.0, haze: 0.5 },
    nightFactor: 1.0,
    wind: { strength: 0.3, speed: 0.35 },
  },
};

export const getPreset = (name) => TIME_PRESETS[name] || TIME_PRESETS.golden;

/** 混合两个预设（用于平滑过渡）。返回全新结构，不修改输入。 */
export function blendPreset(a, b, t) {
  const ca = new THREE.Color(), cb = new THREE.Color();
  const mix = (x, y) => {
    if (typeof x === 'number' && typeof y === 'number') return lerp(x, y, t);
    if (typeof x === 'string' && typeof y === 'string') {
      ca.set(x); cb.set(y);
      return '#' + ca.lerp(cb, t).getHexString();
    }
    if (x && y && typeof x === 'object') {
      const out = {};
      for (const k of Object.keys(x)) out[k] = k in y ? mix(x[k], y[k]) : x[k];
      return out;
    }
    return t < 0.5 ? x : y;
  };
  const merged = mix(a, b);
  merged.key = t < 0.5 ? a.key : b.key;
  merged.label = t < 0.5 ? a.label : b.label;
  merged.hint = t < 0.5 ? a.hint : b.hint;
  return merged;
}

/** 由方位角/仰角求太阳方向（单位向量，y 向上） */
export function sunDirection(azimuth, elevation, out = new THREE.Vector3()) {
  const az = azimuth * DEG, el = elevation * DEG;
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
}

export const QUALITY_PRESETS = {
  low: { key: 'low', label: '流畅', pixelRatio: 0.9, shadowMap: 1024, shadows: true, treeDensity: 0.5, grassDensity: 0.3, grassDistance: 36, volumetric: 0.0, bloom: false, shadowRadius: 1, anisotropy: 2, far: 260 },
  medium: { key: 'medium', label: '均衡', pixelRatio: 1.25, shadowMap: 2048, shadows: true, treeDensity: 0.78, grassDensity: 0.65, grassDistance: 52, volumetric: 0.55, bloom: true, shadowRadius: 2, anisotropy: 4, far: 320 },
  high: { key: 'high', label: '高画质', pixelRatio: 1.6, shadowMap: 2048, shadows: true, treeDensity: 1.0, grassDensity: 1.0, grassDistance: 68, volumetric: 1.0, bloom: true, shadowRadius: 3, anisotropy: 8, far: 400 },
  ultra: { key: 'ultra', label: '电影级', pixelRatio: 2.0, shadowMap: 4096, shadows: true, treeDensity: 1.22, grassDensity: 1.3, grassDistance: 84, volumetric: 1.0, bloom: true, shadowRadius: 4, anisotropy: 16, far: 480 },
};
export const getQuality = (k) => QUALITY_PRESETS[k] || QUALITY_PRESETS.high;

/* =========================================================================
 * 3. 程序化贴图（全部用 canvas 生成，零外部素材）
 * ========================================================================= */

const _texRegistry = new Set();
const _texCache = new Map();
let _anisotropy = 8;

export function configureTextures(maxAniso = 8) {
  _anisotropy = Math.max(1, Math.min(16, maxAniso | 0));
  for (const t of _texRegistry) { t.anisotropy = _anisotropy; t.needsUpdate = true; }
}

function makeCanvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function registerTexture(t) {
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = _anisotropy;
  t.colorSpace = THREE.SRGBColorSpace;
  _texRegistry.add(t);
  return t;
}

function ctx2d(size) {
  const c = makeCanvas(size);
  return { c, g: c.getContext('2d', { willReadFrequently: true }) };
}

/**
 * ⚠ 画布颜色必须写「sRGB 字节」，不能写 THREE.Color 的线性分量。
 * three 的 ColorManagement 会把 hex 转成线性值（r152+ 默认开启），
 * 若直接把 col.r*255 写进 2D 画布，贴图会被二次伽马压暗 2~4 倍。
 * 这里统一在输出时把线性值转回 sRGB。
 */
const linToSrgb1 = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const c255 = (v) => Math.round(clamp(linToSrgb1(v), 0, 1) * 255);

const hexToRgb = (hex) => {
  const c = new THREE.Color(hex);
  return [c255(c.r), c255(c.g), c255(c.b)];
};
const rgba = (hex, a) => { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; };
/** 线性 Color → 不透明 rgb() 字符串（sRGB 输出） */
const rgbOf = (c) => `rgb(${c255(c.r)},${c255(c.g)},${c255(c.b)})`;
/** 线性 Color → 带透明度 rgba() 字符串（sRGB 输出） */
const rgbaOf = (c, a) => `rgba(${c255(c.r)},${c255(c.g)},${c255(c.b)},${a})`;

/** 叠加细颗粒（让程序化贴图不「塑料」） */
function grainOverlay(g, size, amount = 0.1, scale = 1.6) {
  const img = g.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 255 * amount * 2;
    d[i] = clamp(d[i] + n, 0, 255);
    d[i + 1] = clamp(d[i + 1] + n, 0, 255);
    d[i + 2] = clamp(d[i + 2] + n, 0, 255);
  }
  g.putImageData(img, 0, 0);
}

/* ---- 木材：原木墙面 / 木板 / 屋顶木瓦 / 树皮 ---- */
function texWood(size = 1024, { base = '#8a6742', dark = '#5d432c', light = '#b08e60', boards = 0, rings = 46 } = {}) {
  const { c, g } = ctx2d(size);
  g.fillStyle = base; g.fillRect(0, 0, size, size);
  // 年轮 / 纹理（沿 X 方向的拉伸噪声）
  for (let i = 0; i < rings; i++) {
    const y = (i / rings) * size + (Math.random() - 0.5) * 6;
    g.strokeStyle = i % 3 === 0 ? rgba(dark, 0.5) : rgba(light, 0.22);
    g.lineWidth = 0.6 + Math.random() * 2.6;
    g.beginPath();
    for (let x = 0; x <= size; x += 8) {
      const wob = Math.sin(x * 0.011 + i) * 5 + Math.sin(x * 0.031 + i * 2.1) * 2.4;
      const yy = y + wob;
      x === 0 ? g.moveTo(x, yy) : g.lineTo(x, yy);
    }
    g.stroke();
  }
  // 节疤
  const knots = 6 + Math.floor(Math.random() * 5);
  for (let i = 0; i < knots; i++) {
    const kx = Math.random() * size, ky = Math.random() * size;
    const kr = 6 + Math.random() * 16;
    const rg = g.createRadialGradient(kx, ky, 1, kx, ky, kr);
    rg.addColorStop(0, rgba(dark, 0.85));
    rg.addColorStop(0.6, rgba(dark, 0.35));
    rg.addColorStop(1, rgba(dark, 0));
    g.fillStyle = rg;
    g.beginPath(); g.arc(kx, ky, kr, 0, TAU); g.fill();
    for (let r = 2; r < kr; r += 2.2) {
      g.strokeStyle = rgba(dark, 0.25); g.lineWidth = 0.8;
      g.beginPath(); g.arc(kx, ky, r, 0, TAU); g.stroke();
    }
  }
  // 板缝
  if (boards > 0) {
    const h = size / boards;
    for (let i = 1; i < boards; i++) {
      const y = i * h;
      g.fillStyle = rgba('#1a1208', 0.55); g.fillRect(0, y - 1.4, size, 2.8);
      g.fillStyle = rgba('#ffffff', 0.06); g.fillRect(0, y + 1.6, size, 1.2);
      // 钉子
      for (let x = h * 0.3; x < size; x += h * 1.4) {
        g.fillStyle = rgba('#2a2018', 0.7);
        g.beginPath(); g.arc(x + Math.random() * 6, y - 4, 1.6, 0, TAU); g.fill();
      }
    }
  }
  grainOverlay(g, size, 0.07);
  return c;
}

/* ---- 石砌地基 / 烟囱 ---- */
function texStone(size = 1024, { base = '#8b857a', dark = '#4f4a43' } = {}) {
  const { c, g } = ctx2d(size);
  g.fillStyle = dark; g.fillRect(0, 0, size, size);
  const rows = 9;
  for (let r = 0; r < rows; r++) {
    const y = (r / rows) * size, h = size / rows;
    let x = -Math.random() * h * 1.6;
    while (x < size) {
      const w = h * (0.9 + Math.random() * 1.5);
      const inset = 1.6 + Math.random() * 2.2;
      const shade = 0.75 + Math.random() * 0.45;
      const col = new THREE.Color(base).multiplyScalar(shade);
      g.fillStyle = rgbOf(col);
      roundRect(g, x + inset, y + inset, w - inset * 2, h - inset * 2, 4 + Math.random() * 5);
      g.fill();
      // 石头表面斑驳
      g.save();
      g.clip();
      for (let i = 0; i < 26; i++) {
        g.fillStyle = rgba(Math.random() < 0.5 ? '#ffffff' : '#000000', 0.05 + Math.random() * 0.06);
        g.beginPath();
        g.arc(x + Math.random() * w, y + Math.random() * h, 2 + Math.random() * 9, 0, TAU);
        g.fill();
      }
      g.restore();
      x += w;
    }
  }
  grainOverlay(g, size, 0.09);
  return c;
}

function roundRect(g, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

/* ---- 屋顶木瓦 ---- */
function texShingle(size = 1024, { base = '#42352f', moss = '#5a6a45' } = {}) {
  const { c, g } = ctx2d(size);
  g.fillStyle = '#241c17'; g.fillRect(0, 0, size, size);
  const rows = 16, cols = 22;
  const rh = size / rows, cw = size / cols;
  for (let r = rows - 1; r >= 0; r--) {
    const y = r * rh;
    const offset = (r % 2) * cw * 0.5;
    for (let i = -1; i <= cols; i++) {
      const x = i * cw + offset;
      const t = 0.72 + Math.random() * 0.5;
      const col = new THREE.Color(base).multiplyScalar(t);
      if (Math.random() < 0.28) col.lerp(new THREE.Color(moss), Math.random() * 0.55);
      g.fillStyle = rgbOf(col);
      const w = cw * 1.06, h = rh * 2.05;
      g.save();
      g.translate(x, y);
      g.fillRect(0, 0, w, h);
      // 木瓦纵向纹理
      g.strokeStyle = rgba('#000000', 0.22); g.lineWidth = 1;
      for (let k = 0; k < 5; k++) {
        g.beginPath(); g.moveTo((k / 5) * w + Math.random(), 0); g.lineTo((k / 5) * w + Math.random() * 2, h); g.stroke();
      }
      g.fillStyle = rgba('#000000', 0.4);
      g.fillRect(0, h - rh * 0.28, w, rh * 0.28);   // 下层阴影
      g.fillStyle = rgba('#ffffff', 0.05);
      g.fillRect(0, 0, w, 1.4);
      g.restore();
    }
  }
  grainOverlay(g, size, 0.1);
  return c;
}

/* ---- 树皮 ---- */
function texBark(size = 512, { base = '#4a3b30', light = '#8a7360' } = {}) {
  const { c, g } = ctx2d(size);
  g.fillStyle = base; g.fillRect(0, 0, size, size);
  for (let i = 0; i < 220; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const h = 30 + Math.random() * 190;
    const w = 1 + Math.random() * 5;
    g.strokeStyle = Math.random() < 0.5 ? rgba(light, 0.12 + Math.random() * 0.22) : rgba('#1c1410', 0.2 + Math.random() * 0.3);
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(x, y);
    for (let k = 0; k < 6; k++) g.lineTo(x + Math.sin(k * 1.3 + i) * 6 + (Math.random() - 0.5) * 3, y + (h / 6) * k);
    g.stroke();
  }
  // 苔藓/裂纹
  for (let i = 0; i < 40; i++) {
    g.fillStyle = rgba('#000000', 0.12 + Math.random() * 0.16);
    g.beginPath(); g.ellipse(Math.random() * size, Math.random() * size, 2 + Math.random() * 8, 6 + Math.random() * 26, Math.random() * TAU, 0, TAU); g.fill();
  }
  grainOverlay(g, size, 0.12);
  return c;
}

/* ---- 白桦树皮 ---- */
function texBirch(size = 512) {
  const { c, g } = ctx2d(size);
  g.fillStyle = '#ddd8c9'; g.fillRect(0, 0, size, size);
  for (let i = 0; i < 130; i++) {
    const y = Math.random() * size;
    const w = 20 + Math.random() * 130;
    const h = 2 + Math.random() * 7;
    g.fillStyle = rgba('#3b3630', 0.35 + Math.random() * 0.5);
    g.beginPath();
    g.ellipse(Math.random() * size, y, w / 2, h / 2, (Math.random() - 0.5) * 0.12, 0, TAU);
    g.fill();
  }
  for (let i = 0; i < 60; i++) {
    g.fillStyle = rgba('#a89c86', 0.12 + Math.random() * 0.2);
    g.fillRect(Math.random() * size, Math.random() * size, 3 + Math.random() * 40, 1 + Math.random() * 3);
  }
  grainOverlay(g, size, 0.05);
  return c;
}

/* ---- 地面：草地/泥土混合 ---- */
function texGround(size = 1024) {
  const { c, g } = ctx2d(size);
  const grad = g.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, '#4e5c34');
  grad.addColorStop(0.5, '#5a6638');
  grad.addColorStop(1, '#46522f');
  g.fillStyle = grad; g.fillRect(0, 0, size, size);
  // 大块土壤/枯草斑
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * size, y = Math.random() * size, r = 14 + Math.random() * 90;
    const rg = g.createRadialGradient(x, y, 1, x, y, r);
    const kind = Math.random();
    const col = kind < 0.4 ? '#6d5a3c' : kind < 0.75 ? '#8b8a4e' : '#3f4c2c';
    rg.addColorStop(0, rgba(col, 0.5));
    rg.addColorStop(1, rgba(col, 0));
    g.fillStyle = rg;
    g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
  }
  // 草叶笔触
  for (let i = 0; i < 5200; i++) {
    const x = Math.random() * size, y = Math.random() * size;
    const len = 3 + Math.random() * 11;
    const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.5;
    const shade = 0.6 + Math.random() * 0.75;
    const base = Math.random() < 0.35 ? '#8d8b4c' : '#5f7136';
    const col = new THREE.Color(base).multiplyScalar(shade);
    g.strokeStyle = rgbaOf(col, 0.35 + Math.random() * 0.5);
    g.lineWidth = 0.7 + Math.random() * 0.9;
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + Math.cos(ang) * len * 0.5, y + Math.sin(ang) * len * 0.5, x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    g.stroke();
  }
  // 碎石
  for (let i = 0; i < 260; i++) {
    const x = Math.random() * size, y = Math.random() * size, r = 0.8 + Math.random() * 2.6;
    g.fillStyle = rgba(Math.random() < 0.5 ? '#9a9384' : '#6b6459', 0.35 + Math.random() * 0.4);
    g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
  }
  grainOverlay(g, size, 0.09);
  return c;
}

/* ---- 碎石路 ---- */
function texGravel(size = 512) {
  const { c, g } = ctx2d(size);
  g.fillStyle = '#6b6355'; g.fillRect(0, 0, size, size);
  for (let i = 0; i < 2600; i++) {
    const x = Math.random() * size, y = Math.random() * size, r = 1 + Math.random() * 4.6;
    const t = 0.6 + Math.random() * 0.85;
    const col = new THREE.Color(Math.random() < 0.3 ? '#a89c86' : '#8a8172').multiplyScalar(t);
    g.fillStyle = rgbaOf(col, 0.85);
    g.beginPath(); g.ellipse(x, y, r, r * (0.6 + Math.random() * 0.6), Math.random() * TAU, 0, TAU); g.fill();
    g.fillStyle = rgba('#3a342c', 0.2);
    g.beginPath(); g.ellipse(x + r * 0.4, y + r * 0.5, r * 0.8, r * 0.5, 0, 0, TAU); g.fill();
  }
  grainOverlay(g, size, 0.11);
  return c;
}

/* ---- 布/麻布（窗帘、坐垫、晾晒衣物） ---- */
function texFabric(size = 256, { base = '#c9b79b' } = {}) {
  const { c, g } = ctx2d(size);
  g.fillStyle = base; g.fillRect(0, 0, size, size);
  for (let i = 0; i < size; i += 2) {
    g.fillStyle = rgba('#000000', 0.05 + Math.random() * 0.05);
    g.fillRect(i, 0, 1, size);
    g.fillStyle = rgba('#ffffff', 0.04 + Math.random() * 0.05);
    g.fillRect(0, i, size, 1);
  }
  for (let i = 0; i < 40; i++) {
    g.fillStyle = rgba('#000000', 0.03 + Math.random() * 0.04);
    g.beginPath(); g.arc(Math.random() * size, Math.random() * size, 4 + Math.random() * 20, 0, TAU); g.fill();
  }
  grainOverlay(g, size, 0.06);
  return c;
}

/* ---- 铁器 ---- */
function texMetal(size = 256, { base = '#6d6a66' } = {}) {
  const { c, g } = ctx2d(size);
  g.fillStyle = base; g.fillRect(0, 0, size, size);
  for (let i = 0; i < 700; i++) {
    g.fillStyle = rgba(Math.random() < 0.5 ? '#3b322a' : '#b9b2a4', 0.05 + Math.random() * 0.22);
    g.beginPath(); g.arc(Math.random() * size, Math.random() * size, 1 + Math.random() * 12, 0, TAU); g.fill();
  }
  grainOverlay(g, size, 0.08);
  return c;
}

/* ---- 带透明通道的叶片/草簇卡片（billboard 用） ---- */
function texGrassCard(size = 256, { blades = 26, color = '#617437', dry = '#9a9558', alpha = true } = {}) {
  const { c, g } = ctx2d(size);
  if (alpha) { g.clearRect(0, 0, size, size); } else { g.fillStyle = '#000'; g.fillRect(0, 0, size, size); }
  const cx = size / 2;
  for (let i = 0; i < blades; i++) {
    const bx = cx + (Math.random() - 0.5) * size * 0.82;
    const h = size * (0.35 + Math.random() * 0.62);
    const bend = (bx - cx) * 0.5 + (Math.random() - 0.5) * size * 0.42;
    const base = Math.random() < 0.28 ? dry : color;
    const col = new THREE.Color(base).multiplyScalar(0.62 + Math.random() * 0.72);
    const w = size * (0.012 + Math.random() * 0.022);
    g.fillStyle = rgbaOf(col, 0.72 + Math.random() * 0.28);
    g.beginPath();
    g.moveTo(bx - w, size);
    g.quadraticCurveTo(bx - w * 0.4 + bend * 0.4, size - h * 0.55, bx + bend, size - h);
    g.quadraticCurveTo(bx + w * 0.6 + bend * 0.4, size - h * 0.5, bx + w, size);
    g.closePath();
    g.fill();
  }
  return c;
}

/* 叶簇卡片。
 * 三个关键取舍（都是为了"看起来像叶子"而不是"一张撕破的纸"）：
 *  1. 固定种子 —— 同一版本每次刷新的树冠完全一致（原来用 Math.random，刷新就换一棵树）。
 *  2. 双层叶片：先画一层放大 1.35 倍的深色实心"核"（alpha=1），再在上面画带高光的叶面。
 *     远处 mipmap 会把半透明边缘平均掉，纯半透明的卡片在远处会被 alphaTest 打成
 *     千疮百孔的碎片；有了实心核，低分辨率下卡片依然保持"有肉"的叶团。
 *  3. 叶片更小更密，并带叶尖与中脉，避免放大后变成一坨圆饼。 */
function texLeafCluster(size = 256, { color = '#41602f', count = 90, spread = 0.85, leafScale = 1, seed = 4211 } = {}) {
  const { c, g } = ctx2d(size);
  g.clearRect(0, 0, size, size);
  const rng = makeRng(seed);
  const cx = size / 2, cy = size * 0.54;
  const base = new THREE.Color(color);

  const leafPath = (w, h) => {
    // 柳叶形：两端收尖，中段最宽
    g.beginPath();
    g.moveTo(0, -h);
    g.bezierCurveTo(w, -h * 0.36, w, h * 0.34, 0, h);
    g.bezierCurveTo(-w, h * 0.34, -w, -h * 0.36, 0, -h);
    g.closePath();
  };

  for (let i = 0; i < count; i++) {
    const ang = rng() * TAU;
    const rad = Math.pow(rng(), 0.58) * size * 0.5 * spread;
    const x = cx + Math.cos(ang) * rad;
    const y = cy + Math.sin(ang) * rad * 0.82;
    const lum = 0.55 + rng() * 0.95;
    const col = base.clone().multiplyScalar(lum);
    col.offsetHSL((rng() - 0.5) * 0.055, (rng() - 0.5) * 0.14, 0);
    const w = size * 0.038 * leafScale * (0.62 + rng() * 0.85);
    const h = w * (1.7 + rng() * 1.1);
    const rot = rng() * TAU;

    g.save();
    g.translate(x, y);
    g.rotate(rot);

    // ① 实心核（深色，alpha 满）—— 保证 mip 之后卡片不被 alphaTest 打碎
    const core = base.clone().multiplyScalar(lum * 0.52);
    g.fillStyle = rgba(`#${core.getHexString()}`, 1);
    leafPath(w * 1.32, h * 1.14);
    g.fill();

    // ② 叶面
    g.fillStyle = rgba(`#${col.getHexString()}`, 1);
    leafPath(w, h);
    g.fill();

    // ③ 迎光面提亮 + 中脉：一两片亮叶在逆光时会"透"出来，是树冠的高频细节来源
    if (rng() < 0.34) {
      const hi = col.clone().multiplyScalar(1.35).lerp(new THREE.Color('#d8e08a'), 0.22);
      g.fillStyle = rgba(`#${hi.getHexString()}`, 0.92);
      leafPath(w * 0.72, h * 0.86);
      g.fill();
    }
    g.strokeStyle = rgba('#1c2a14', 0.38);
    g.lineWidth = Math.max(0.7, size * 0.0035);
    g.beginPath(); g.moveTo(0, -h * 0.82); g.lineTo(0, h * 0.82); g.stroke();

    g.restore();
  }
  return c;
}

/* ---- 粒子精灵 ---- */
function texRadial(size, stops) {
  const { c, g } = ctx2d(size);
  const rg = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [p, col] of stops) rg.addColorStop(p, col);
  g.fillStyle = rg;
  g.fillRect(0, 0, size, size);
  return c;
}
function texGlowSprite(size = 128) {
  return texRadial(size, [[0, 'rgba(255,240,210,1)'], [0.25, 'rgba(255,214,150,0.72)'], [0.6, 'rgba(255,180,90,0.22)'], [1, 'rgba(255,160,60,0)']]);
}
function texSmokeSprite(size = 128) {
  const { c, g } = ctx2d(size);
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x / size - 0.5) * 2, dy = (y / size - 0.5) * 2;
      const d = Math.sqrt(dx * dx + dy * dy);
      const n = fbm(x * 0.045, y * 0.045, 4) * 0.5 + 0.5;
      let a = clamp(1 - d, 0, 1);
      a = Math.pow(a, 1.6) * (0.45 + n * 0.75);
      const i = (y * size + x) * 4;
      img.data[i] = 236; img.data[i + 1] = 232; img.data[i + 2] = 226;
      img.data[i + 3] = clamp(a, 0, 1) * 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}
function texStarSprite(size = 64) {
  return texRadial(size, [[0, 'rgba(255,255,255,1)'], [0.18, 'rgba(220,235,255,0.7)'], [0.45, 'rgba(160,190,255,0.18)'], [1, 'rgba(120,150,255,0)']]);
}
function texDustSprite(size = 64) {
  return texRadial(size, [[0, 'rgba(255,244,222,1)'], [0.4, 'rgba(255,232,190,0.4)'], [1, 'rgba(255,220,170,0)']]);
}
function texFireflySprite(size = 64) {
  return texRadial(size, [[0, 'rgba(230,255,180,1)'], [0.22, 'rgba(180,255,120,0.75)'], [0.55, 'rgba(120,220,80,0.16)'], [1, 'rgba(80,180,60,0)']]);
}

/** 所有贴图键：getTexture(key, opts) 取用，自动缓存 */
const TEXTURE_BUILDERS = {
  wood: (o) => texWood(o.size || 1024, o),
  planks: (o) => texWood(o.size || 1024, { boards: o.boards || 9, ...o }),
  shingle: (o) => texShingle(o.size || 1024, o),
  bark: (o) => texBark(o.size || 512, o),
  birch: (o) => texBirch(o.size || 512),
  stone: (o) => texStone(o.size || 1024, o),
  ground: (o) => texGround(o.size || 1024),
  gravel: (o) => texGravel(o.size || 512),
  fabric: (o) => texFabric(o.size || 256, o),
  metal: (o) => texMetal(o.size || 256, o),
  grassCard: (o) => texGrassCard(o.size || 256, o),
  leafCard: (o) => texLeafCluster(o.size || 256, o),
  glow: (o) => texGlowSprite(o.size || 128),
  smoke: (o) => texSmokeSprite(o.size || 128),
  star: (o) => texStarSprite(o.size || 64),
  dust: (o) => texDustSprite(o.size || 64),
  firefly: (o) => texFireflySprite(o.size || 64),
};
export const TEX_KEYS = Object.keys(TEXTURE_BUILDERS);

export function getTexture(key, opts = {}) {
  const cacheKey = key + '|' + JSON.stringify(opts);
  let t = _texCache.get(cacheKey);
  if (t) return t;
  const builder = TEXTURE_BUILDERS[key];
  if (!builder) throw new Error(`[core] unknown texture key: ${key}`);
  const canvas = builder(opts);
  t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = _anisotropy;
  t.colorSpace = THREE.SRGBColorSpace;
  const isAlpha = key === 'grassCard' || key === 'leafCard' || key === 'glow' || key === 'smoke' || key === 'star' || key === 'dust' || key === 'firefly';
  if (isAlpha) t.colorSpace = THREE.SRGBColorSpace;
  t.name = key;
  _texRegistry.add(t);
  _texCache.set(cacheKey, t);
  return t;
}

/** 由已有贴图canvas 生成法线贴图（细节提升的关键） */
export function normalFromCanvas(canvas, strength = 1.6) {
  const size = canvas.width;
  const src = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, size, size).data;
  const lum = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    lum[i] = (src[i * 4] * 0.299 + src[i * 4 + 1] * 0.587 + src[i * 4 + 2] * 0.114) / 255;
  }
  const out = document.createElement('canvas');
  out.width = out.height = size;
  const og = out.getContext('2d', { willReadFrequently: true });
  const img = og.createImageData(size, size);
  const at = (x, y) => lum[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  og.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(out);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = _anisotropy;
  t.name = 'normal';
  _texRegistry.add(t);
  return t;
}

const _normalCache = new Map();
/** 取某贴图对应的法线贴图（缓存） */
export function getNormal(key, strength = 1.6, opts = {}) {
  const ck = key + '|' + strength + '|' + JSON.stringify(opts);
  let n = _normalCache.get(ck);
  if (!n) { n = normalFromCanvas(getTexture(key, opts).image, strength); _normalCache.set(ck, n); }
  return n;
}

/** 便捷：克隆贴图并设置独立 repeat（避免共享贴图被重复修改） */
export function repeatOf(tex, rx, ry = rx) {
  const t = tex.clone();
  t.needsUpdate = true;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  t.anisotropy = _anisotropy;
  _texRegistry.add(t);
  return t;
}

/* =========================================================================
 * 4. 风：共享顶点着色器补丁（树、灌木、草都必须用同一份实现）
 * ========================================================================= */

const _windUniform = { value: 0 };
const _windMaterials = [];

/**
 * 给 MeshStandardMaterial / MeshLambertMaterial 注入风摆动。
 * 仅依赖顶点高度与实例世界坐标，兼容 InstancedMesh。
 */
export function applyWindSway(material, { strength = 0.08, speed = 0.8, height = 3, scale = 0.06, twist = 0.45, gust = 0.4 } = {}) {
  const key = `wind|${strength}|${speed}|${height}|${scale}|${twist}|${gust}`;
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader) => {
    if (prev) prev(shader);
    shader.uniforms.uWindTime = _windUniform;
    shader.uniforms.uWindGust = _windUniform;
    shader.vertexShader = `uniform float uWindTime;\n` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      /* glsl */`
      #include <begin_vertex>
      {
        vec3 wBase = vec3(0.0);
        #ifdef USE_INSTANCING
          wBase = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        #endif
        wBase += modelMatrix[3].xyz;
        float bendAmt = clamp(transformed.y / ${height.toFixed(3)}, 0.0, 2.2);
        bendAmt *= bendAmt;
        float ph = wBase.x * ${scale.toFixed(4)} + wBase.z * ${(scale * 1.37).toFixed(4)};
        float w = sin(uWindTime * ${speed.toFixed(3)} + ph) * 0.6
                + sin(uWindTime * ${(speed * 1.73).toFixed(3)} + ph * 2.1) * 0.3
                + sin(uWindTime * ${(speed * 0.41).toFixed(3)} + ph * 0.37) * 0.4;
        float gustF = 1.0 + ${gust.toFixed(2)} * sin(uWindTime * 0.19 + wBase.x * 0.012 + wBase.z * 0.009);
        transformed.x += w * ${strength.toFixed(4)} * bendAmt * gustF;
        transformed.z += w * ${(strength * twist).toFixed(4)} * bendAmt * gustF;
      }
      `
    );
  };
  material.customProgramCacheKey = () => key;
  material.userData.windSway = true;
  _windMaterials.push(material);
  return material;
}

/** 每帧更新风时间（main.js 调用） */
export function updateWind(t) { _windUniform.value = t; }
export const windMaterials = _windMaterials;

/* =========================================================================
 * 5. 轻量事件总线（UI ↔ main 之间）
 * ========================================================================= */

export function createSignal() {
  const listeners = new Set();
  return {
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit(payload) { for (const fn of listeners) fn(payload); },
    clear() { listeners.clear(); },
  };
}

/* =========================================================================
 * 6. 通用几何 / 材质小工具
 * ========================================================================= */

/** 合并多个 mesh 的几何（带 matrix），减少 draw call */
export function mergeMeshes(meshes, material) {
  const geos = [];
  for (const m of meshes) {
    const g = m.geometry.clone();
    m.updateMatrix();
    g.applyMatrix4(m.matrix);
    geos.push(g);
  }
  const merged = mergeGeometriesSimple(geos);
  return new THREE.Mesh(merged, material);
}

/** 不依赖 addons 的简易 geometry 合并（仅 position/normal/uv，非索引） */
export function mergeGeometriesSimple(geometries) {
  const list = geometries.map((g) => (g.index ? g.toNonIndexed() : g));
  let total = 0;
  for (const g of list) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let o = 0;
  for (const g of list) {
    const p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      pos[(o + i) * 3] = p.getX(i); pos[(o + i) * 3 + 1] = p.getY(i); pos[(o + i) * 3 + 2] = p.getZ(i);
      if (n) { nor[(o + i) * 3] = n.getX(i); nor[(o + i) * 3 + 1] = n.getY(i); nor[(o + i) * 3 + 2] = n.getZ(i); }
      if (u) { uv[(o + i) * 2] = u.getX(i); uv[(o + i) * 2 + 1] = u.getY(i); }
    }
    o += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
}

/** 把 mesh 数组转成 InstancedMesh（自动写入位置/旋转/缩放） */
export function makeInstanced(geometry, material, transforms, { shadows = true, receive = true, name = '' } = {}) {
  const mesh = new THREE.InstancedMesh(geometry, material, transforms.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  transforms.forEach((t, i) => {
    e.set(t.rx || 0, t.ry || 0, t.rz || 0);
    q.setFromEuler(e);
    m.compose(
      new THREE.Vector3(t.x, t.y, t.z),
      q,
      new THREE.Vector3(t.sx ?? t.s ?? 1, t.sy ?? t.s ?? 1, t.sz ?? t.s ?? 1)
    );
    mesh.setMatrixAt(i, m);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = shadows;
  mesh.receiveShadow = receive;
  mesh.frustumCulled = true;
  if (name) mesh.name = name;
  return mesh;
}

/** 统计并打印信息（调试/性能面板用） */
export function countScene(scene) {
  let meshes = 0, tris = 0, instanced = 0;
  scene.traverse((o) => {
    if (o.isMesh) {
      meshes++;
      const g = o.geometry;
      const n = g.index ? g.index.count / 3 : (g.attributes.position?.count || 0) / 3;
      tris += n * (o.isInstancedMesh ? o.count : 1);
      if (o.isInstancedMesh) instanced++;
    }
  });
  return { meshes, triangles: Math.round(tris), instanced };
}
