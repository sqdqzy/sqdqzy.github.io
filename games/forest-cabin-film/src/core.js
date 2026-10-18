/**
 * core.js — 共享底层：数学、噪声、地形契约、世界布局、程序化贴图缓存
 * ---------------------------------------------------------------
 * 这一层是唯一的"事实来源"。其它模块都从这里取地形高度、世界坐标常量与贴图，
 * 保证「木屋不会悬空」「小径一定贴着地面」「草不长进水里」这类约束只有一处实现。
 */
import * as THREE from 'three';

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};
/** 帧率无关的指数趋近（λ 越大追得越快） */
export const damp = (cur, target, lambda, dt) => lerp(cur, target, 1 - Math.exp(-lambda * dt));

/** 固定种子的确定性随机数：同一个版本刷新多少次，森林布局都一模一样 */
export function makeRng(seed = 1337) {
  let a = seed >>> 0;
  const r = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.range = (min, max) => min + r() * (max - min);
  r.int = (min, max) => Math.floor(min + r() * (max - min + 1));
  r.pick = (arr) => arr[Math.floor(r() * arr.length) % arr.length];
  return r;
}

/* ------------------------------------------------------------------ 噪声 */
function hash2(x, y) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
const fade = (t) => t * t * (3 - 2 * t);

/** 2D value noise，返回 [-1, 1] */
export function noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = fade(xf), v = fade(yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return (lerp(lerp(a, b, u), lerp(c, d, u), v) * 2 - 1);
}

/** 分形噪声：octaves 个倍频叠加，lacunarity 频率倍率，gain 振幅衰减 */
export function fbm(x, y, octaves = 4, lacunarity = 2.0, gain = 0.5) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(x * freq, y * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / (norm || 1);
}

/* ------------------------------------------------------------- 世界布局 */
export const PALETTE = {
  bark: '#4a3b30', barkLight: '#7c6553', barkBirch: '#ded8c9',
  pine: '#3c5236', pineLight: '#4c6b3f', leaf: '#5d7434',
  grass: '#5a6738', grassDry: '#8b8a53', soil: '#6d5c44',
  log: '#8a6a45', logDark: '#5c4128', logLight: '#b3936a',
  roof: '#4a3c34', roofMoss: '#5a6a45',
  stone: '#8b857a', stoneDark: '#5e5a52',
  lampGlow: '#ffb057', windowGlow: '#ffb469',
};

export const WORLD = {
  size: 210,            // 地形边长（米）
  segments: 176,
  treeFar: 96,          // 超过这个半径不再种树，由「林线」树墙接手
};

export const CABIN = {
  center: new THREE.Vector3(0, 0, 0),
  width: 8.4,           // X 方向
  depth: 6.6,           // Z 方向
  wallH: 3.5,
  roofPitch: 1.02,      // 屋脊抬升 / 半跨
};

export const CLEARING = {
  // 院子半径必须 ≥ 树高 / tan(太阳仰角)，否则黄金时刻木屋会整栋落在林子的投影里，
  // 画面直接变成「一间黑房子」。13° 的太阳 × 19m 的院子 ≈ 刚好擦到屋脊。
  radius: 21,
  feather: 14,
  height: 0,
};

export const POND = {
  center: new THREE.Vector3(-20, 0, 17),
  radius: 8.2,
  level: -1.15,         // 水面高程
};

export const PATH = {
  // 小径：从西南林间绕到正门
  from: new THREE.Vector2(-34, -30),
  to: new THREE.Vector2(0, CABIN.depth / 2 + 4.2),
  halfWidth: 1.45,
};

/* ------------------------------------------------------- 地形高度（契约） */

/** 小径中心线到 (x,z) 的近似距离：按参数化折线采样取最近点 */
function pathDistance(x, z) {
  const ax = PATH.from.x, az = PATH.from.y;
  const bx = PATH.to.x, bz = PATH.to.y;
  // 折线：林间 → 院门，带一个轻微弯曲，避免看起来像尺子画的
  const mx = lerp(ax, bx, 0.52) + 5.5, mz = lerp(az, bz, 0.52) + 7.0;
  let best = Infinity;
  for (const [p0, p1] of [[[ax, az], [mx, mz]], [[mx, mz], [bx, bz]]]) {
    const vx = p1[0] - p0[0], vz = p1[1] - p0[1];
    const wx = x - p0[0], wz = z - p0[1];
    const len2 = vx * vx + vz * vz || 1e-6;
    const t = clamp((wx * vx + wz * vz) / len2, 0, 1);
    const cx = p0[0] + vx * t, cz = p0[1] + vz * t;
    const d = Math.hypot(x - cx, z - cz);
    if (d < best) best = d;
  }
  return best;
}

/** 地表基础起伏：远处环山 + 中景缓坡 + 近景细碎 */
function baseHeight(x, z) {
  const r = Math.hypot(x, z);
  let h = fbm(x * 0.011 + 5.2, z * 0.011 - 3.7, 4) * 7.5;
  h += fbm(x * 0.045 - 1.1, z * 0.045 + 8.4, 3) * 1.6;
  h += fbm(x * 0.17 + 12.0, z * 0.17 - 6.0, 2) * 0.32;
  // 环山：把视线封在林子里，地平线上永远只有树
  const rim = smoothstep(WORLD.size * 0.30, WORLD.size * 0.50, r);
  h += rim * (16 + fbm(x * 0.03, z * 0.03, 3) * 9);
  // 池塘盆地
  const pd = Math.hypot(x - POND.center.x, z - POND.center.z);
  h -= (1 - smoothstep(POND.radius * 0.45, POND.radius * 1.5, pd)) * 3.4;
  return h;
}

/** 权威地形高度函数：全场景只有这一处 */
export function terrainHeight(x, z) {
  const r = Math.hypot(x, z);
  const h = baseHeight(x, z);
  const k = 1 - smoothstep(CLEARING.radius, CLEARING.radius + CLEARING.feather, r);
  let out = lerp(h, CLEARING.height, k);
  // 小径压平并微微下凹（被踩实的土路）
  const pd = pathDistance(x, z);
  const pk = 1 - smoothstep(PATH.halfWidth, PATH.halfWidth * 4.2, pd);
  out = lerp(out, out - 0.16, pk);
  return out;
}

/** 采样地形：高度 + 坡度 + 到木屋/小径/池塘的距离，供摆放模块做排除 */
export function sampleTerrain(x, z) {
  const h = terrainHeight(x, z);
  const e = 0.6;
  const gx = (terrainHeight(x + e, z) - terrainHeight(x - e, z)) / (2 * e);
  const gz = (terrainHeight(x, z + e) - terrainHeight(x, z - e)) / (2 * e);
  return {
    y: h,
    slope: Math.min(1, Math.hypot(gx, gz)),
    gx, gz,
    cabinDist: Math.hypot(x - CABIN.center.x, z - CABIN.center.z),
    pathDist: pathDistance(x, z),
    pondDist: Math.hypot(x - POND.center.x, z - POND.center.z),
  };
}

/** 摆放许可：院子、水面、小径、陡坡都自动排除 */
export function placement(x, z, margin = 1) {
  const s = sampleTerrain(x, z);
  const blocked =
    s.cabinDist < CLEARING.radius * 0.92 ||
    s.pondDist < POND.radius * 1.12 ||
    s.pathDist < PATH.halfWidth * 1.6 + margin ||
    s.slope > 0.46;
  return { ...s, blocked };
}

/* ------------------------------------------------------------- 程序化贴图 */
function makeCanvas(size, h = size) {
  const c = document.createElement('canvas');
  c.width = size; c.height = h;
  return c;
}
function hexRgb(hex) {
  const v = parseInt(hex.replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function css(hex, a = 1) {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
/** THREE.Color（线性工作空间）→ css 字符串，用于把「调亮后的颜色」画进 canvas */
function cssOf(color, a = 1) {
  const s = (v) => {
    const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055;
    return Math.round(clamp(c, 0, 1) * 255);
  };
  return `rgba(${s(color.r)},${s(color.g)},${s(color.b)},${a})`;
}

/** 木板：竖向板材 + 木纹 + 缝隙 + 结疤 */
function texPlanks(size, { base = '#8a6a45', dark = '#5c4128', light = '#b3936a', boards = 10, seed = 5 } = {}) {
  const c = makeCanvas(size);
  const g = c.getContext('2d');
  const rng = makeRng(seed);
  const bw = size / boards;
  g.fillStyle = base;
  g.fillRect(0, 0, size, size);
  for (let b = 0; b < boards; b++) {
    const x0 = b * bw;
    const shade = 0.78 + rng() * 0.44;
    const col = new THREE.Color(base).multiplyScalar(shade);
    g.fillStyle = cssOf(col);
    g.fillRect(x0, 0, bw, size);
    // 木纹
    const lines = 26 + Math.floor(rng() * 22);
    for (let i = 0; i < lines; i++) {
      const x = x0 + rng() * bw;
      g.strokeStyle = css(rng() < 0.35 ? dark : light, 0.06 + rng() * 0.16);
      g.lineWidth = 0.6 + rng() * 1.8;
      g.beginPath();
      g.moveTo(x, 0);
      for (let y = 0; y <= size; y += size / 10) {
        g.lineTo(x + Math.sin(y * 0.03 + b) * bw * 0.05, y);
      }
      g.stroke();
    }
    // 结疤
    if (rng() < 0.45) {
      const kx = x0 + bw * (0.2 + rng() * 0.6), ky = rng() * size;
      const kr = size * (0.008 + rng() * 0.016);
      for (let i = 5; i >= 1; i--) {
        g.fillStyle = css(dark, 0.1 + 0.06 * i);
        g.beginPath();
        g.ellipse(kx, ky, kr * i * 0.5, kr * i * 0.8, rng() * 0.6, 0, TAU);
        g.fill();
      }
    }
    // 板缝
    g.fillStyle = css('#241708', 0.55);
    g.fillRect(x0, 0, Math.max(1, size / 300), size);
    g.fillStyle = css(light, 0.12);
    g.fillRect(x0 + size / 300, 0, Math.max(1, size / 420), size);
  }
  return c;
}

/** 树皮：竖向裂纹 */
function texBark(size, { base = '#5a4636', seed = 11 } = {}) {
  const c = makeCanvas(size);
  const g = c.getContext('2d');
  const rng = makeRng(seed);
  g.fillStyle = base;
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 420; i++) {
    const x = rng() * size;
    const dark = rng() < 0.6;
    g.strokeStyle = css(dark ? '#2c2016' : '#8a7358', 0.05 + rng() * 0.22);
    g.lineWidth = 0.8 + rng() * 3.2;
    g.beginPath();
    let y = 0, xx = x;
    g.moveTo(xx, y);
    while (y < size) {
      y += size / 14;
      xx += (rng() - 0.5) * size * 0.02;
      g.lineTo(xx, y);
    }
    g.stroke();
  }
  for (let i = 0; i < 60; i++) {
    g.fillStyle = css(rng() < 0.5 ? '#1d150e' : '#9c866a', 0.04 + rng() * 0.08);
    g.beginPath();
    g.ellipse(rng() * size, rng() * size, size * (0.01 + rng() * 0.05), size * (0.03 + rng() * 0.1), 0, 0, TAU);
    g.fill();
  }
  return c;
}

/** 白桦树皮：白底 + 黑斑 + 横向皮孔 */
function texBirch(size, { seed = 23 } = {}) {
  const c = makeCanvas(size);
  const g = c.getContext('2d');
  const rng = makeRng(seed);
  g.fillStyle = '#ded8c9';
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 26; i++) {
    g.fillStyle = css('#ffffff', 0.1 + rng() * 0.3);
    g.beginPath();
    g.ellipse(rng() * size, rng() * size, size * (0.06 + rng() * 0.16), size * (0.03 + rng() * 0.1), 0, 0, TAU);
    g.fill();
  }
  for (let i = 0; i < 46; i++) {
    const x = rng() * size, y = rng() * size;
    const w = size * (0.03 + rng() * 0.12), h = size * (0.008 + rng() * 0.022);
    g.fillStyle = css('#241d16', 0.35 + rng() * 0.55);
    g.beginPath();
    g.ellipse(x, y, w, h, 0, 0, TAU);
    g.fill();
  }
  for (let i = 0; i < 220; i++) {
    g.fillStyle = css('#4a4034', 0.1 + rng() * 0.3);
    const y = rng() * size;
    g.fillRect(rng() * size, y, size * (0.01 + rng() * 0.04), Math.max(1, size / 400));
  }
  return c;
}

/** 屋瓦：横向瓦垄 + 苔痕 */
function texShingle(size, { base = '#4a3c34', seed = 31 } = {}) {
  const c = makeCanvas(size);
  const g = c.getContext('2d');
  const rng = makeRng(seed);
  g.fillStyle = base;
  g.fillRect(0, 0, size, size);
  const rows = 12, cols = 16;
  const rh = size / rows, cw = size / cols;
  for (let r = 0; r < rows; r++) {
    for (let k = -1; k <= cols; k++) {
      const x = k * cw + (r % 2) * cw * 0.5;
      const y = r * rh;
      const col = new THREE.Color(base).multiplyScalar(0.68 + rng() * 0.62);
      g.fillStyle = cssOf(col);
      g.beginPath();
      g.moveTo(x + 0.6, y);
      g.lineTo(x + cw - 0.6, y);
      g.lineTo(x + cw - 0.6, y + rh * 1.5);
      g.lineTo(x + 0.6, y + rh * 1.5);
      g.closePath();
      g.fill();
      g.fillStyle = css('#100a06', 0.4);
      g.fillRect(x, y + rh * 1.34, cw, Math.max(1, rh * 0.16));
    }
  }
  // 苔与雨渍
  for (let i = 0; i < 60; i++) {
    g.fillStyle = css(rng() < 0.62 ? '#5d7040' : '#2a2018', 0.04 + rng() * 0.13);
    g.beginPath();
    g.ellipse(rng() * size, rng() * size, size * (0.02 + rng() * 0.09), size * (0.02 + rng() * 0.07), 0, 0, TAU);
    g.fill();
  }
  return c;
}

/** 石材：颗粒 + 裂纹 */
function texStone(size, { base = '#8d867a', seed = 47 } = {}) {
  const c = makeCanvas(size);
  const g = c.getContext('2d');
  const rng = makeRng(seed);
  g.fillStyle = base;
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = css(rng() < 0.5 ? '#5f5a50' : '#b4ada0', 0.05 + rng() * 0.2);
    g.beginPath();
    g.arc(rng() * size, rng() * size, size * (0.002 + rng() * 0.012), 0, TAU);
    g.fill();
  }
  for (let i = 0; i < 30; i++) {
    g.strokeStyle = css('#3b3630', 0.12 + rng() * 0.25);
    g.lineWidth = 0.6 + rng() * 1.4;
    g.beginPath();
    let x = rng() * size, y = rng() * size;
    g.moveTo(x, y);
    for (let k = 0; k < 5; k++) {
      x += (rng() - 0.5) * size * 0.2; y += (rng() - 0.5) * size * 0.2;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  return c;
}

/** 地面：草皮 + 裸土 + 落叶碎屑 */
function texGround(size, { seed = 61 } = {}) {
  const c = makeCanvas(size);
  const g = c.getContext('2d');
  const rng = makeRng(seed);
  g.fillStyle = '#4c5a33';
  g.fillRect(0, 0, size, size);
  // 大块深浅：对比必须够。平铺到 210m 的地面上时，低对比的贴图
  // 在中远景会糊成一片均匀的浅绿，也就是「高尔夫果岭」。
  for (let i = 0; i < 340; i++) {
    const col = rng() < 0.52 ? '#2f3a20' : '#7f8d54';
    g.fillStyle = css(col, 0.18 + rng() * 0.4);
    g.beginPath();
    g.ellipse(rng() * size, rng() * size, size * (0.02 + rng() * 0.12), size * (0.02 + rng() * 0.1), rng() * TAU, 0, TAU);
    g.fill();
  }
  // 草丝
  for (let i = 0; i < 17000; i++) {
    const x = rng() * size, y = rng() * size;
    const len = size * (0.006 + rng() * 0.026);
    const ang = -Math.PI / 2 + (rng() - 0.5) * 1.6;
    const col = rng() < 0.42 ? '#8b9a5e' : (rng() < 0.7 ? '#3c4826' : '#95915a');
    g.strokeStyle = css(col, 0.18 + rng() * 0.4);
    g.lineWidth = 0.6 + rng() * 1.1;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    g.stroke();
  }
  // 落叶/碎石
  for (let i = 0; i < 700; i++) {
    g.fillStyle = css(rng() < 0.6 ? '#6b5533' : '#3a2c1c', 0.12 + rng() * 0.35);
    g.beginPath();
    g.ellipse(rng() * size, rng() * size, size * (0.002 + rng() * 0.008), size * (0.001 + rng() * 0.005), rng() * TAU, 0, TAU);
    g.fill();
  }
  return c;
}

/** 草簇卡片：底部为基座的细叶 */
function texGrassCard(size, { seed = 77 } = {}) {
  const c = makeCanvas(size);
  const g = c.getContext('2d');
  const rng = makeRng(seed);
  g.clearRect(0, 0, size, size);
  // 叶片要占满整张卡片。只画十几根细草丝的话，一半以上是透明区域，
  // 实例再多，远处看到的也只是一堆稀疏的碎刺而不是草地。
  g.lineCap = 'round';
  for (let i = 0; i < 36; i++) {
    const bx = size * (0.5 + (rng() - 0.5) * 0.88);
    const h = size * (0.5 + rng() * 0.48);
    const bend = (rng() - 0.5) * size * 0.5;
    const w = size * (0.012 + rng() * 0.022);
    const col = new THREE.Color(rng() < 0.42 ? '#78894c' : '#4e5f2e').multiplyScalar(0.72 + rng() * 0.58);
    g.strokeStyle = cssOf(col, 0.92 + rng() * 0.08);
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(bx, size);
    g.quadraticCurveTo(bx + bend * 0.35, size - h * 0.6, bx + bend, size - h);
    g.stroke();
    // 叶尖加宽，否则远看每根草只剩一条 1px 的线
    g.lineWidth = w * 2.1;
    g.beginPath();
    g.moveTo(bx + bend * 0.74, size - h * 0.82);
    g.lineTo(bx + bend, size - h);
    g.stroke();
  }
  return c;
}

/**
 * 叶簇卡片。
 * 三点讲究：
 *  1) 固定种子 → 每次刷新的树冠完全一致；
 *  2) 双层叶片：先画一层放大 1.3 倍的深色实心「核」，再画带高光的叶面。
 *     远处 mipmap 会把半透明边缘平均掉，纯半透明的卡片在远处会被 alphaTest
 *     打成千疮百孔的碎片；有了实心核，低分辨率下依然保持「有肉」的叶团；
 *  3) 叶片小而密、带叶尖和中脉，避免放大后变成一坨圆饼。
 */
function texLeafCard(size, { color = '#5d7434', count = 190, seed = 8123 } = {}) {
  const c = makeCanvas(size);
  const g = c.getContext('2d');
  const rng = makeRng(seed);
  g.clearRect(0, 0, size, size);
  const cx = size / 2, cy = size * 0.54;
  const base = new THREE.Color(color);

  const leafPath = (w, h) => {
    g.beginPath();
    g.moveTo(0, -h);
    g.bezierCurveTo(w, -h * 0.36, w, h * 0.34, 0, h);
    g.bezierCurveTo(-w, h * 0.34, -w, -h * 0.36, 0, -h);
    g.closePath();
  };

  for (let i = 0; i < count; i++) {
    const ang = rng() * TAU;
    const rad = Math.pow(rng(), 0.56) * size * 0.48;
    const x = cx + Math.cos(ang) * rad;
    const y = cy + Math.sin(ang) * rad * 0.84;
    const lum = 0.55 + rng() * 0.95;
    const col = base.clone().multiplyScalar(lum);
    col.offsetHSL((rng() - 0.5) * 0.055, (rng() - 0.5) * 0.13, 0);
    const w = size * 0.038 * (0.62 + rng() * 0.85);
    const h = w * (1.7 + rng() * 1.1);

    g.save();
    g.translate(x, y);
    g.rotate(rng() * TAU);
    // 实心核
    const core = base.clone().multiplyScalar(lum * 0.5);
    g.fillStyle = cssOf(core, 1);
    leafPath(w * 1.32, h * 1.14);
    g.fill();
    // 叶面
    g.fillStyle = cssOf(col, 1);
    leafPath(w, h);
    g.fill();
    // 少数叶片提亮：逆光时「透」出来的高频细节
    if (rng() < 0.32) {
      const hi = col.clone().multiplyScalar(1.3).lerp(new THREE.Color('#dce48c'), 0.22);
      g.fillStyle = cssOf(hi, 0.9);
      leafPath(w * 0.72, h * 0.86);
      g.fill();
    }
    // 中脉
    g.strokeStyle = css('#1c2a14', 0.36);
    g.lineWidth = Math.max(0.7, size * 0.0035);
    g.beginPath(); g.moveTo(0, -h * 0.8); g.lineTo(0, h * 0.8); g.stroke();
    g.restore();
  }
  return c;
}

/** 针叶：不透明底色（所以材质色必须给暗绿，见 needleMat） */
function texNeedle(size, { seed = 31 } = {}) {
  const c = makeCanvas(size);
  const g = c.getContext('2d');
  const rng = makeRng(seed);
  g.fillStyle = '#2b3a29';
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 4200; i++) {
    const x = rng() * size, y = rng() * size;
    const len = size * (0.012 + rng() * 0.038);
    const ang = -Math.PI / 2 + (rng() - 0.5) * 2.1;
    const col = new THREE.Color(rng() < 0.3 ? '#4a6a3c' : (rng() < 0.5 ? '#1e2c1b' : '#37492c')).multiplyScalar(0.7 + rng() * 0.7);
    g.strokeStyle = cssOf(col, 0.35 + rng() * 0.45);
    g.lineWidth = 0.6 + rng() * 1.2;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    g.stroke();
  }
  for (let i = 0; i < 30; i++) {
    g.fillStyle = css(rng() < 0.5 ? '#111a10' : '#6a7f52', 0.03 + rng() * 0.06);
    g.beginPath();
    g.arc(rng() * size, rng() * size, size * (0.04 + rng() * 0.18), 0, TAU);
    g.fill();
  }
  return c;
}

/* ------------------------------------------------------------ 精灵/粒子 */
function texRadial(size, stops) {
  const c = makeCanvas(size);
  const g = c.getContext('2d');
  const rg = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [p, col] of stops) rg.addColorStop(p, col);
  g.fillStyle = rg;
  g.fillRect(0, 0, size, size);
  return c;
}

const BUILDERS = {
  planks: texPlanks,
  logs: (s, o) => texPlanks(s, { boards: 5, base: '#7d5f3e', dark: '#4a3320', light: '#a8875c', seed: 9, ...o }),
  bark: texBark,
  birch: texBirch,
  shingle: texShingle,
  stone: texStone,
  ground: texGround,
  grassCard: texGrassCard,
  leafCard: texLeafCard,
  needle: texNeedle,
  glow: (s) => texRadial(s, [[0, 'rgba(255,242,214,1)'], [0.22, 'rgba(255,214,150,0.62)'], [0.58, 'rgba(255,178,88,0.16)'], [1, 'rgba(255,160,60,0)']]),
  dust: (s) => texRadial(s, [[0, 'rgba(255,246,226,0.95)'], [0.35, 'rgba(255,232,190,0.35)'], [1, 'rgba(255,220,170,0)']]),
  smoke: (s) => {
    const c = makeCanvas(s);
    const g = c.getContext('2d');
    const img = g.createImageData(s, s);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const dx = x / s - 0.5, dy = y / s - 0.5;
        const d = Math.hypot(dx, dy) * 2;
        const n = fbm(x * 0.05, y * 0.05, 3) * 0.5 + 0.5;
        const i = (y * s + x) * 4;
        img.data[i] = 232; img.data[i + 1] = 228; img.data[i + 2] = 220;
        img.data[i + 3] = clamp(1 - d, 0, 1) ** 1.7 * (0.35 + n * 0.85) * 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  },
  firefly: (s) => texRadial(s, [[0, 'rgba(226,255,170,1)'], [0.2, 'rgba(176,255,112,0.7)'], [0.55, 'rgba(120,220,80,0.14)'], [1, 'rgba(80,180,60,0)']]),
};

const _cache = new Map();
let _aniso = 8;
export function setAnisotropy(v) { _aniso = clamp(v | 0, 1, 16); }

export function texture(key, opts = {}) {
  const ck = key + '|' + JSON.stringify(opts);
  let t = _cache.get(ck);
  if (t) return t;
  const b = BUILDERS[key];
  if (!b) throw new Error('[core] 未知贴图: ' + key);
  t = new THREE.CanvasTexture(b(opts.size || 512, opts));
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = _aniso;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  _cache.set(ck, t);
  return t;
}

/** 克隆一份贴图并设置独立 repeat（绝不能直接改共享贴图的 repeat） */
export function repeated(tex, rx, ry = rx) {
  const t = tex.clone();
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  t.anisotropy = _aniso;
  t.needsUpdate = true;
  return t;
}

/** 由灰度高度图生成法线贴图（细节全靠它，不依赖任何外部素材） */
export function normalFrom(source, strength = 1.5) {
  const img = source.image;
  const size = img.width;
  const d = img.getContext('2d').getImageData(0, 0, size, size).data;
  const lum = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) lum[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) / 255;
  const out = makeCanvas(size);
  const og = out.getContext('2d');
  const img2 = og.createImageData(size, size);
  const at = (x, y) => lum[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      const i = (y * size + x) * 4;
      img2.data[i] = (nx / len * 0.5 + 0.5) * 255;
      img2.data[i + 1] = (ny / len * 0.5 + 0.5) * 255;
      img2.data[i + 2] = (nz / len * 0.5 + 0.5) * 255;
      img2.data[i + 3] = 255;
    }
  }
  og.putImageData(img2, 0, 0);
  const t = new THREE.CanvasTexture(out);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = _aniso;
  return t;
}

const _ncache = new Map();
export function normalTex(key, strength = 1.5, opts = {}) {
  const ck = key + '|' + strength + '|' + JSON.stringify(opts);
  let t = _ncache.get(ck);
  if (!t) { t = normalFrom(texture(key, opts), strength); _ncache.set(ck, t); }
  return t;
}

/**
 * 顶点色 / 材质色只能是「乘子」，不是 albedo。
 * three 里 diffuse = material.color × map × vertexColor × instanceColor；
 * 如果 map 已经带着正确的木色 / 石色，再乘一次 albedo 等于把颜色乘两遍 —— 画面会整体发黑。
 * 这里只取颜色的「色相倾向」（归一化到亮度 1），再乘一个明度系数。
 */
export function asMultiplier(hexOrColor, mul = 1, hue = 0.35) {
  const c = hexOrColor && hexOrColor.isColor ? hexOrColor : new THREE.Color(hexOrColor);
  const lum = Math.max(0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b, 1e-3);
  const k = 1 / lum;
  return new THREE.Color(
    (1 + (c.r * k - 1) * hue) * mul,
    (1 + (c.g * k - 1) * hue) * mul,
    (1 + (c.b * k - 1) * hue) * mul,
  );
}

/* -------------------------------------------------------------- 几何工具 */
/** 合并若干几何体（position / normal / uv / color，缺 color 的补白色）。
 *
 *  color 必须一起合并：材质开了 vertexColors 而几何体没有 color 属性时，
 *  three 的着色器会读到 (0,0,0) —— 整批物件变成纯黑，而且**不会报任何错**。
 *  这个坑很隐蔽：画面看起来"就是有点暗"，很容易归因到光照上。 */
export function mergeGeos(list) {
  const parts = list.filter(Boolean);
  if (!parts.length) return new THREE.BufferGeometry();
  let vCount = 0, iCount = 0, anyColor = false;
  for (const g of parts) {
    if (!g.attributes.normal) g.computeVertexNormals();
    vCount += g.attributes.position.count;
    iCount += g.index ? g.index.count : g.attributes.position.count;
    if (g.attributes.color) anyColor = true;
  }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const col = anyColor ? new Float32Array(vCount * 3) : null;
  const idx = new Uint32Array(iCount);
  let vo = 0, io = 0;
  for (const g of parts) {
    if (!g.attributes.normal) g.computeVertexNormals();
    const p = g.attributes.position, nAttr = g.attributes.normal, uAttr = g.attributes.uv, cAttr = g.attributes.color;
    pos.set(p.array.subarray(0, p.count * 3), vo * 3);
    if (nAttr) nor.set(nAttr.array.subarray(0, p.count * 3), vo * 3);
    if (uAttr) uv.set(uAttr.array.subarray(0, p.count * 2), vo * 2);
    if (col) {
      if (cAttr) col.set(cAttr.array.subarray(0, p.count * 3), vo * 3);
      else for (let i = 0; i < p.count; i++) { col[(vo + i) * 3] = 1; col[(vo + i) * 3 + 1] = 1; col[(vo + i) * 3 + 2] = 1; }
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.array[i] + vo;
      io += g.index.count;
    } else {
      for (let i = 0; i < p.count; i++) idx[io + i] = i + vo;
      io += p.count;
    }
    vo += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

/** 就地摆放：平移 / 欧拉旋转 / 缩放 */
export function place(geo, o = {}) {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(o.rx || 0, o.ry || 0, o.rz || 0));
  geo.applyMatrix4(new THREE.Matrix4().compose(
    new THREE.Vector3(o.x || 0, o.y || 0, o.z || 0),
    q,
    new THREE.Vector3(o.sx ?? o.s ?? 1, o.sy ?? o.s ?? 1, o.sz ?? o.s ?? 1),
  ));
  return geo;
}

/** 建 InstancedMesh 并写好矩阵 / 颜色；boundingSphere 必须重算，否则整批会被误剔除 */
export function instanced(geo, mat, list, { shadows = true, receive = true, name = '', pad = 0.6 } = {}) {
  const mesh = new THREE.InstancedMesh(geo, mat, list.length);
  mesh.name = name;
  mesh.castShadow = shadows;
  mesh.receiveShadow = receive;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const col = new THREE.Color();
  let anyColor = false;
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    e.set(it.rx || 0, it.ry || 0, it.rz || 0);
    q.setFromEuler(e);
    p.set(it.x, it.y, it.z);
    s.set(it.sx ?? it.s ?? 1, it.sy ?? it.s ?? 1, it.sz ?? it.s ?? 1);
    m.compose(p, q, s);
    mesh.setMatrixAt(i, m);
    if (it.color) { mesh.setColorAt(i, col.set(it.color)); anyColor = true; }
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (anyColor && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  if (mesh.boundingSphere) {
    if (!isFinite(mesh.boundingSphere.radius)) mesh.boundingSphere.radius = WORLD.size;
    else mesh.boundingSphere.radius += pad;
  }
  return mesh;
}

/** 统计三角面（调试 / 画质预算用） */
export function countTris(root) {
  let tris = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    const n = g.index ? g.index.count : (g.attributes.position ? g.attributes.position.count : 0);
    tris += (n / 3) * (o.isInstancedMesh ? o.count : 1);
  });
  return Math.round(tris);
}

/* ------------------------------------------------------------------ 风向 */
export const _wind = { x: 0.72, z: 0.69, time: 0, strength: 1, speed: 1 };
export function updateWind(t, strength = 1, speed = 1) {
  _wind.time = t;
  _wind.strength = strength;
  _wind.speed = speed;
}

/**
 * 共享的风摆顶点着色器补丁。
 * 所有植被（树冠 / 灌木 / 草 / 布料）都用同一份实现，源码一致才能共享 program。
 */
const WIND_PATCH = {
  cached: null,
  get() { if (!this.cached) this.cached = `${this.strength}|${this.speed}|${this.height}|${this.twist}|${this.gust}`; return this.cached; },
  reset() { this.cached = null; },
  strength: 0.06, speed: 0.8, height: 8, twist: 0.4, gust: 0.45,
  attach(material) {
    const cfg = this;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uWindTime = { value: 0 };
      shader.uniforms.uWindDir = { value: new THREE.Vector2(_wind.x, _wind.z) };
      shader.uniforms.uWindParams = { value: new THREE.Vector4(cfg.strength, cfg.speed, cfg.height, cfg.twist) };
      shader.uniforms.uWindGust = { value: cfg.gust };
      material.userData.shader = shader;
      shader.vertexShader = 'uniform float uWindTime;\nuniform vec2 uWindDir;\nuniform vec4 uWindParams;\nuniform float uWindGust;\n' +
        shader.vertexShader.replace('#include <begin_vertex>', `
        #include <begin_vertex>
        {
          vec4 wp = vec4( transformed, 1.0 );
          #ifdef USE_INSTANCING
            wp = instanceMatrix * wp;
          #endif
          float h = clamp( ( modelMatrix * wp ).y / uWindParams.z, 0.0, 1.0 );
          float ph = ( modelMatrix * wp ).x * 0.21 + ( modelMatrix * wp ).z * 0.17;
          float s = sin( uWindTime * uWindParams.y + ph ) * 0.62
                  + sin( uWindTime * uWindParams.y * 2.17 + ph * 1.7 ) * 0.26
                  + sin( uWindTime * uWindParams.y * 0.43 + ph * 0.5 ) * 0.30;
          float amp = uWindParams.x * h * h * ( 0.55 + uWindGust * s );
          transformed.x += uWindDir.x * amp;
          transformed.z += uWindDir.y * amp * 0.7;
          transformed.x += uWindDir.y * amp * uWindParams.w * 0.4;
        }
        `);
    };
    material.customProgramCacheKey = () => cfg.get();
    material.userData.windCfg = cfg;
    return material;
  },
};
export function windMaterial(mat, opts = {}) {
  const cfg = Object.create(WIND_PATCH);
  Object.assign(cfg, opts);
  return cfg.attach(mat);
}
export function tickWind(materials, t) {
  for (const m of materials) {
    const s = m.userData.shader;
    if (!s) continue;
    s.uniforms.uWindTime.value = t;
    const cfg = m.userData.windCfg;
    s.uniforms.uWindGust.value = (cfg ? cfg.gust : WIND_PATCH.gust) * (0.55 + _wind.strength * 0.45);
  }
}
