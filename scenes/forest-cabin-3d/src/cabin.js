/**
 * cabin.js — 手工原木农舍（log cabin）
 * ---------------------------------------------------------------------------
 * 契约（core.js）：
 *   createCabin({ scene, renderer, camera, quality, qualityKey, preset })
 *   → { group, update(t,dt,state), setState(state,t,dt), lights, windows, smoke, stats }
 *
 * 竖向基准（group 局部坐标，y=0 为院落地坪）：
 *   0          地坪
 *   0.42       石砌地基顶面 = 室内地面 = 门廊平台面（CABIN.foundation）
 *   0.42~3.47  叠木墙体（CABIN.wallHeight = 3.05）
 *   3.47~5.72  双坡屋顶（CABIN.roofRise = 2.25），屋脊在 z=0
 *   檐口        3.47 − roofRise/HD*roofOverhang ≈ 2.73（出檐 0.95 → 檐下阴影很重）
 *
 * 只 import 'three' 与 './core.js'。所有贴图来自 core 的 getTexture/getNormal。
 */
import * as THREE from 'three';
import {
  CABIN, PALETTE, getTexture, getNormal, repeatOf, makeRng,
  clamp, lerp, smoothstep, terrainHeight, getQuality, TAU, DEG,
} from './core.js';

/* =========================================================================
 * 0. 本模块私有几何工具
 * ========================================================================= */

const _white = new THREE.Color(1, 1, 1);

/** 写入统一顶点色（逐构件色差，替代 instanceColor） */
function setGeoColor(geo, color) {
  const c = color instanceof THREE.Color ? color : new THREE.Color(color);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** 合并（position / normal / uv / color），缺 color 补白 */
function mergeGeoms(list) {
  const geos = list.map((g) => (g.index ? g.toNonIndexed() : g));
  let total = 0;
  for (const g of geos) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const col = new Float32Array(total * 3);
  let o = 0;
  for (const g of geos) {
    const p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv, c = g.attributes.color;
    for (let i = 0; i < p.count; i++) {
      const k = o + i;
      pos[k * 3] = p.getX(i); pos[k * 3 + 1] = p.getY(i); pos[k * 3 + 2] = p.getZ(i);
      if (n) { nor[k * 3] = n.getX(i); nor[k * 3 + 1] = n.getY(i); nor[k * 3 + 2] = n.getZ(i); }
      if (u) { uv[k * 2] = u.getX(i); uv[k * 2 + 1] = u.getY(i); }
      if (c) { col[k * 3] = c.getX(i); col[k * 3 + 1] = c.getY(i); col[k * 3 + 2] = c.getZ(i); }
      else { col[k * 3] = 1; col[k * 3 + 1] = 1; col[k * 3 + 2] = 1; }
    }
    o += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

function scaleUV(geo, sx, sy = sx) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * sx, uv.getY(i) * sy);
  return geo;
}

/** 交换 u/v —— 让木纹主方向（贴图 U）落在圆柱轴线上 */
function swapUV(geo) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) { const x = uv.getX(i), y = uv.getY(i); uv.setXY(i, y, x); }
  return geo;
}

/** 盒体贴图按世界尺寸归一（六面各自缩放，避免长板拉伸） */
function scaleBoxUV(geo, w, h, d, tX, tY = tX, tZ = tX) {
  const uv = geo.attributes.uv;
  const dims = [
    [d / tZ, h / tY], [d / tZ, h / tY],
    [w / tX, d / tZ], [w / tX, d / tZ],
    [w / tX, h / tY], [w / tX, h / tY],
  ];
  for (let f = 0; f < 6; f++) {
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      if (i >= uv.count) break;
      uv.setXY(i, uv.getX(i) * dims[f][0], uv.getY(i) * dims[f][1]);
    }
  }
  return geo;
}

function scaleCylUV(geo, radius, height, tile) {
  return scaleUV(geo, (TAU * radius) / tile, height / tile);
}

/* ---- 构件累加器：按材质键收集几何，最后每种材质合并为一个 mesh ---- */
function newBin() { return new Map(); }
function binPush(bin, key, geo) {
  let a = bin.get(key);
  if (!a) { a = []; bin.set(key, a); }
  a.push(geo);
}

/** 变换顺序：先绕自身 Z 转，再 Y，再 X（便于「先面内旋转、后倾斜」的贴花） */
function place(bin, key, geo, color, o = {}) {
  const { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0 } = o;
  if (rz) geo.rotateZ(rz);
  if (ry) geo.rotateY(ry);
  if (rx) geo.rotateX(rx);
  if (x || y || z) geo.translate(x, y, z);
  setGeoColor(geo, color ?? _white);
  binPush(bin, key, geo);
  return geo;
}

function boxAt(bin, key, color, o) {
  const { w = 1, h = 1, d = 1, tile = null, tX = tile, tY = tile, tZ = tile } = o;
  const g = new THREE.BoxGeometry(w, h, d);
  if (tX || tY || tZ) scaleBoxUV(g, w, h, d, tX || 1, tY || 1, tZ || 1);
  return place(bin, key, g, color, o);
}

function planeAt(bin, key, color, o) {
  const { w = 1, h = 1, tile = null, tU = tile, tV = tile } = o;
  const g = new THREE.PlaneGeometry(w, h);
  if (tU || tV) scaleUV(g, tU || 1, tV || 1);
  return place(bin, key, g, color, o);
}

function cylAt(bin, key, color, o) {
  const { r = 0.1, r2 = null, h = 1, seg = 10, open = false, tile = null } = o;
  const g = new THREE.CylinderGeometry(r2 === null ? r : r2, r, h, seg, 1, open);
  if (tile) scaleCylUV(g, (r + (r2 === null ? r : r2)) * 0.5, h, tile);
  return place(bin, key, g, color, o);
}

/**
 * binToGroup：每种材质一个 draw call。
 * overrides 可按材质键单独覆盖阴影设置（例如屋顶不吃自身阴影，避免掠射角阴影痤疮）。
 * 任何用到的 key 若在 materials 里缺失会明确报警，不会静默丢构件。
 */
function binToGroup(bin, name, materials, { cast = false, receive = false, overrides = {} } = {}) {
  const g = new THREE.Group();
  g.name = name;
  for (const [key, list] of bin) {
    if (!list.length) continue;
    const mat = materials[key];
    if (!mat) {
      console.warn(`[cabin] binToGroup: 缺少材质 key "${key}"（${name}），该组 ${list.length} 个构件被跳过`);
      continue;
    }
    const m = new THREE.Mesh(mergeGeoms(list), mat);
    const ov = overrides[key] || {};
    m.name = `${name}:${key}`;
    m.castShadow = ov.cast ?? cast;
    m.receiveShadow = ov.receive ?? receive;
    g.add(m);
  }
  return g;
}

/** 任意三点的三角面（山墙补板用）；expected 为期望外法线方向 */
function triangleGeo(a, b, c, expected, tile = 1.4) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), C = new THREE.Vector3(...c);
  const n = new THREE.Vector3().subVectors(B, A).cross(new THREE.Vector3().subVectors(C, A));
  if (n.lengthSq() < 1e-9) return null;
  n.normalize();
  let p1 = B, p2 = C;
  if (expected && n.dot(new THREE.Vector3(...expected)) < 0) {
    p1 = C; p2 = B;
    n.negate();
  }
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array([A.x, A.y, A.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z]);
  const nor = new Float32Array(9);
  for (let i = 0; i < 3; i++) { nor[i * 3] = n.x; nor[i * 3 + 1] = n.y; nor[i * 3 + 2] = n.z; }
  // uv 用 (axis-u, y) 投影：山墙在 YZ 平面 → u 取 z
  const uv = new Float32Array(6);
  const set = (i, v) => { uv[i * 2] = v.z / tile; uv[i * 2 + 1] = v.y / tile; };
  set(0, A); set(1, p1); set(2, p2);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/** 略微外凸的平面（窗内暖光面） */
function bulgePlane(w, h, seg, amount) {
  const g = new THREE.PlaneGeometry(w, h, seg, seg);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const u = p.getX(i) / (w * 0.5), v = p.getY(i) / (h * 0.5);
    const f = Math.max(0, 1 - u * u) * Math.max(0, 1 - v * v);
    p.setZ(i, f * amount);
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/** 软边贴花贴图（苔藓 / 雨渍）——本模块自产 canvas，无外部素材 */
function makeDecalTexture(kind, seed = 7) {
  const size = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, size, size);
  const rng = makeRng(seed);
  if (kind === 'blob') {
    for (let i = 0; i < 26; i++) {
      const a = rng() * TAU, rr = Math.pow(rng(), 0.7) * size * 0.34;
      const x = size / 2 + Math.cos(a) * rr, y = size / 2 + Math.sin(a) * rr;
      const rad = size * rng.range(0.07, 0.20);
      const rg = g.createRadialGradient(x, y, 1, x, y, rad);
      const v = 0.55 + rng() * 0.45;
      rg.addColorStop(0, `rgba(255,255,255,${0.34 * v})`);
      rg.addColorStop(0.55, `rgba(255,255,255,${0.16 * v})`);
      rg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = rg;
      g.beginPath(); g.arc(x, y, rad, 0, TAU); g.fill();
    }
  } else {
    for (let i = 0; i < 16; i++) {
      const x = rng() * size;
      const w = size * rng.range(0.02, 0.09);
      const top = rng() * size * 0.3;
      const grad = g.createLinearGradient(0, top, 0, size);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.35, `rgba(255,255,255,${0.18 + rng() * 0.24})`);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(x, top, w, size - top);
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.name = 'cabin-decal-' + kind;
  return t;
}

/** 窗内暖光梯度贴图：底部（油灯/火塘）最亮、向上转暗、边缘收暗
 *  —— 用作 emissiveMap + map，让窗光是有层次的"屋里一盏灯"而不是均匀 LED 板 */
function makeWindowGlowTexture(seed = 11) {
  const size = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const rng = makeRng(seed);
  const grad = g.createLinearGradient(0, size, 0, 0);
  grad.addColorStop(0, 'rgba(255,240,216,1.00)');
  grad.addColorStop(0.34, 'rgba(255,198,134,0.80)');
  grad.addColorStop(0.70, 'rgba(198,134,80,0.46)');
  grad.addColorStop(1, 'rgba(124,88,56,0.30)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  // 灯/火高光斑（偏下偏左）
  const rg = g.createRadialGradient(size * 0.46, size * 0.74, 1, size * 0.46, size * 0.74, size * 0.44);
  rg.addColorStop(0, 'rgba(255,248,228,1)');
  rg.addColorStop(0.35, 'rgba(255,208,142,0.72)');
  rg.addColorStop(1, 'rgba(255,170,90,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, size, size);
  // 边缘收暗（窗洞内壁阴影）
  const vg = g.createRadialGradient(size / 2, size / 2, size * 0.20, size / 2, size / 2, size * 0.63);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.58)');
  g.fillStyle = vg;
  g.fillRect(0, 0, size, size);
  // 细噪声，消除渐变色带
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(${rng() < 0.5 ? 255 : 40},${rng() < 0.5 ? 220 : 60},${rng() < 0.5 ? 180 : 40},${0.02 + rng() * 0.03})`;
    g.fillRect(rng() * size, rng() * size, 1 + rng() * 3, 1 + rng() * 3);
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.name = 'cabin-window-glow';
  return t;
}

/* =========================================================================
 * 1. createCabin
 * ========================================================================= */

export function createCabin(opt = {}) {
  const quality = opt.quality || getQuality('high');
  const qKey = quality.key || opt.qualityKey || 'high';
  const isUltra = qKey === 'ultra';
  const isHigh = isUltra || qKey === 'high';
  const rng = makeRng(20251018);

  const group = new THREE.Group();
  group.name = 'cabin';

  /* ---- 1.0 关键尺寸 ---- */
  const W = CABIN.width, D = CABIN.depth, WH = CABIN.wallHeight, LR = CABIN.logRadius;
  const HW = W / 2, HD = D / 2;
  const FND = CABIN.foundation;
  const OVH = CABIN.roofOverhang;
  const RISE = CABIN.roofRise;
  const PITCH = RISE / HD;
  const SLOPE = Math.atan(PITCH);
  const WALL_Y0 = FND, WALL_Y1 = FND + WH;
  const RIDGE_Y = WALL_Y1 + RISE;
  const roofY = (z) => WALL_Y1 + RISE * (1 - Math.abs(z) / HD);
  const TILE = 1.5;

  const cosR = Math.cos(CABIN.rotation), sinR = Math.sin(CABIN.rotation);
  const toWorld = (lx, lz) => ({
    x: CABIN.center.x + lx * cosR + lz * sinR,
    z: CABIN.center.z - lx * sinR + lz * cosR,
  });

  /* ---- 地形对齐：基底取院落最高点（地基埋深 ≥0.4，绝不露缝） ---- */
  let baseY = -Infinity;
  for (let ix = -4; ix <= 4; ix++) {
    for (let iz = -4; iz <= 5; iz++) {
      const p = toWorld(ix * 1.15, iz * 1.22);
      baseY = Math.max(baseY, terrainHeight(p.x, p.z));
    }
  }
  const groundAtSteps = terrainHeight(toWorld(0, 5.9).x, toWorld(0, 5.9).z);
  group.position.set(CABIN.center.x, baseY, CABIN.center.z);
  group.rotation.y = CABIN.rotation;

  /* ---- 1.1 圆木层（每层 4 根：2 根 X 向 + 2 根 Z 向，同高交错咬合） ---- */
  const courseGap = LR * 2 * 0.94;
  const nCourse = Math.max(6, Math.round(WH / courseGap));
  const gap = (WH - LR) / (nCourse - 0.5);
  const courseY = [];
  for (let i = 0; i < nCourse; i++) courseY.push(WALL_Y0 + (i + 0.5) * gap);

  /* 开口：先给定「视觉开口」，再看哪些圆木层被切断 → 得到真实洞口 */
  const doorCutX = 0.49;
  const winX = 2.30, winCutX = 0.52;
  const gWinCutZ = 0.36;
  const frontHoles = [
    { a: -doorCutX, b: doorCutX, y0: 0.44, y1: 2.32 },
    { a: winX - winCutX, b: winX + winCutX, y0: 1.14, y1: 2.30 },
    { a: -winX - winCutX, b: -winX + winCutX, y0: 1.14, y1: 2.30 },
  ];
  const sideHoles = [{ a: -gWinCutZ, b: gWinCutZ, y0: 1.44, y1: 2.16 }];

  function subtract(a0, a1, holes) {
    let segs = [[a0, a1]];
    for (const h of holes) {
      const next = [];
      for (const [a, b] of segs) {
        if (h.b <= a || h.a >= b) { next.push([a, b]); continue; }
        if (h.a > a + 0.02) next.push([a, h.a]);
        if (h.b < b - 0.02) next.push([h.b, b]);
      }
      segs = next;
    }
    return segs.filter(([a, b]) => b - a > 0.1);
  }
  /** 该开口实际切掉了哪些圆木层（洞口比视觉尺寸更大，木框据此做内衬） */
  function cutSpan(y0, y1) {
    let a = Infinity, b = -Infinity;
    for (const yc of courseY) {
      if (yc + LR > y0 + 0.05 && yc - LR < y1 - 0.05) { a = Math.min(a, yc - LR); b = Math.max(b, yc + LR); }
    }
    if (!isFinite(a)) { a = y0; b = y1; }
    return [a, b];
  }

  /* ---- 1.2 材质库 ---- */
  const woodOpts = { base: PALETTE.log, dark: PALETTE.logDark, light: PALETTE.logLight, rings: 54 };
  const plankOpts = { base: PALETTE.logLight, dark: PALETTE.logDark, light: '#c8a672', boards: 8 };
  const plankFineOpts = { base: PALETTE.log, dark: PALETTE.logDark, light: PALETTE.logLight, boards: 16 };
  // 木瓦：PALETTE.roof(#42352f) 在逆光下会压成黑板，这里用偏灰棕的亮基色，
  // 保证 20m 外仍能看清木瓦行列（色相仍在暖灰棕范围，后期统一调色）
  const shingleOpts = { base: '#6b5643', moss: '#72805a' };
  const stoneOpts = { base: PALETTE.stone, dark: PALETTE.stoneDark };

  const texWood = getTexture('wood', woodOpts);
  const texPlanks = getTexture('planks', plankOpts);
  const texPlanksFine = getTexture('planks', plankFineOpts);
  const texShingle = getTexture('shingle', shingleOpts);
  const texStone = getTexture('stone', stoneOpts);
  const texMetal = getTexture('metal');
  const texFabric = getTexture('fabric');
  const texLeaf = getTexture('leafCard', { color: PALETTE.pine, count: 62, leafScale: 0.9 });
  const texGlow = getTexture('glow');
  const texSmoke = getTexture('smoke');

  const NV = (x) => new THREE.Vector2(x, x);
  const materials = {
    log: new THREE.MeshStandardMaterial({
      map: texWood, normalMap: getNormal('wood', 1.5, woodOpts), normalScale: NV(0.6),
      vertexColors: true, roughness: 0.88, metalness: 0.0,
    }),
    plank: new THREE.MeshStandardMaterial({
      map: texPlanks, normalMap: getNormal('planks', 1.3, plankOpts), normalScale: NV(0.45),
      vertexColors: true, roughness: 0.8, metalness: 0.0,
    }),
    plankFine: new THREE.MeshStandardMaterial({
      map: texPlanksFine, normalMap: getNormal('planks', 1.3, plankFineOpts), normalScale: NV(0.4),
      vertexColors: true, roughness: 0.84, metalness: 0.0,
    }),
    shingle: new THREE.MeshStandardMaterial({
      // 木瓦贴图行间明暗对比很硬，法线强度必须收着用，否则掠射光下整片翻黑、失去层次
      map: texShingle, normalMap: getNormal('shingle', 0.75, shingleOpts), normalScale: NV(0.45),
      vertexColors: true, roughness: 0.88, metalness: 0.0,
    }),
    stone: new THREE.MeshStandardMaterial({
      map: texStone, normalMap: getNormal('stone', 1.4, stoneOpts), normalScale: NV(0.5),
      vertexColors: true, roughness: 0.94, metalness: 0.02,
    }),
    metal: new THREE.MeshStandardMaterial({
      map: texMetal, normalMap: getNormal('metal', 0.9), normalScale: NV(0.4),
      vertexColors: true, roughness: 0.45, metalness: 0.85,
    }),
    fabric: new THREE.MeshStandardMaterial({
      map: texFabric, vertexColors: true, roughness: 0.93, metalness: 0.0, side: THREE.DoubleSide,
    }),
    moss: new THREE.MeshStandardMaterial({
      map: makeDecalTexture('blob', 21), transparent: true, depthWrite: false,
      roughness: 0.95, metalness: 0.0, vertexColors: true, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2,
    }),
    stain: new THREE.MeshStandardMaterial({
      map: makeDecalTexture('streak', 43), transparent: true, depthWrite: false,
      roughness: 1.0, metalness: 0.0, vertexColors: true, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2,
    }),
    leaf: new THREE.MeshStandardMaterial({
      map: texLeaf, transparent: true, alphaTest: 0.42, side: THREE.DoubleSide,
      roughness: 0.78, metalness: 0.0, vertexColors: true,
    }),
    interior: new THREE.MeshStandardMaterial({
      map: texPlanksFine, vertexColors: true, roughness: 0.95, metalness: 0.0, color: 0x9c8a74,
    }),
    glass: new THREE.MeshStandardMaterial({
      // 老木屋的手工玻璃：深色、低粗糙度、带极轻微波动法线（反射被"打碎"）
      color: new THREE.Color('#16222b'),
      normalMap: repeatOf(getNormal('metal', 0.9), 2.0, 3.0), normalScale: NV(0.07),
      roughness: 0.06, metalness: 0.06,
      transparent: true, opacity: 0.46, side: THREE.DoubleSide, envMapIntensity: 1.7,
    }),
  };

  const bMain = newBin();      // 主体：投影 + 接收
  const bTrim = newBin();      // 细节：只接收
  const bInner = newBin();     // 室内：不参与阴影
  const bDecal = newBin();     // 贴花

  /* =====================================================================
   * 1.3 石砌地基（外扩 0.15 / 顶面出檐 / 底部埋入地下）
   * ===================================================================== */
  const fw = W + 0.30, fd = D + 0.30;
  boxAt(bMain, 'stone', new THREE.Color(PALETTE.stone).multiplyScalar(0.86), {
    w: fw, h: FND + 0.60, d: fd, y: (FND - 0.60) / 2, tile: 0.62,
  });
  boxAt(bMain, 'stone', new THREE.Color(PALETTE.stone).multiplyScalar(0.98), {
    w: fw + 0.16, h: 0.07, d: fd + 0.16, y: FND - 0.035, tile: 0.62,
  });
  boxAt(bMain, 'stone', new THREE.Color(PALETTE.stoneDark).multiplyScalar(1.06), {
    w: fw + 0.05, h: 0.11, d: fd + 0.05, y: 0.055, tile: 0.5,
  });

  /* =====================================================================
   * 1.4 叠木墙体 + 山墙
   * ===================================================================== */
  const logGeos = [];
  const logBase = new THREE.Color(PALETTE.log);

  /**
   * 一根圆木（可被开口切成多段）
   * axis：'x' | 'z'；y 为轴线高度；from/to 为轴向区间；fixed 为另一轴坐标
   */
  function pushLog(axis, y, from, to, fixed, r, color, twist, notchAxis = null) {
    const len = to - from;
    if (len < 0.12) return;
    const g = new THREE.CylinderGeometry(r * rng.range(0.985, 1.01), r * rng.range(0.99, 1.015), len, 10, 1, false);
    swapUV(g);
    scaleUV(g, len / 1.7, (TAU * r) / 0.55);
    // 端头与咬合处略暗（锯口 + 凹口阴影）
    {
      const p = g.attributes.position;
      const col = new Float32Array(p.count * 3);
      const c = color;
      for (let i = 0; i < p.count; i++) {
        const t = p.getY(i) / len;                 // −0.5..0.5，旋转前为轴向
        const dEnd = Math.min(Math.abs(t + 0.5), Math.abs(t - 0.5)) * len;
        let k = 1 - 0.20 * smoothstep(0.42, 0.02, dEnd);
        if (notchAxis !== null) {
          const a = Math.abs((from + to) / 2 + t * len - notchAxis);
          k *= 1 - 0.16 * smoothstep(0.30, 0.05, a);
        }
        col[i * 3] = c.r * k; col[i * 3 + 1] = c.g * k; col[i * 3 + 2] = c.b * k;
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    g.rotateY(twist);
    if (axis === 'x') g.rotateZ(Math.PI / 2); else g.rotateX(Math.PI / 2);
    const mid = (from + to) / 2;
    if (axis === 'x') g.translate(mid, y, fixed); else g.translate(fixed, y, mid);
    logGeos.push(g);
  }

  for (let i = 0; i < nCourse; i++) {
    const y = courseY[i];
    const tint = 0.9 + (i / nCourse) * 0.15;                 // 墙脚更湿更暗
    const col = logBase.clone().multiplyScalar(tint * rng.range(0.96, 1.04));
    col.offsetHSL((rng() - 0.5) * 0.012, (rng() - 0.5) * 0.05, 0);
    const twist = rng.range(-1.5, 1.5) * DEG;
    const r = LR * rng.range(0.99, 1.01);
    // X 向：前 / 后墙（正面 +Z 有开口）
    for (const side of [1, -1]) {
      const z = side * HD;
      const oA = rng.range(0.35, 0.5), oB = rng.range(0.35, 0.5);
      for (const [s, e] of subtract(-HW - oA, HW + oB, side > 0 ? frontHoles : [])) {
        pushLog('x', y, s, e, z, r, col, twist, HW);
      }
    }
    // Z 向：左 / 右墙（两侧各有山墙小窗开口）
    for (const side of [1, -1]) {
      const x = side * HW;
      const oA = rng.range(0.35, 0.5), oB = rng.range(0.35, 0.5);
      for (const [s, e] of subtract(-HD - oA, HD + oB, sideHoles)) {
        pushLog('z', y, s, e, x, r, col, twist, HD);
      }
    }
  }
  // 山墙：圆木逐层收细收短，把三角填满、顶部自然被屋脊压条盖住
  {
    let yc = WALL_Y1 + gap * 0.55;
    let r = LR;
    for (let j = 0; j < 10; j++) {
      const halfT = HD * (1 - (yc + r - WALL_Y1) / RISE);
      if (halfT < 0.11) break;
      const half = Math.max(0.12, halfT);
      const col = logBase.clone().multiplyScalar(1.03 * rng.range(0.96, 1.05));
      const twist = rng.range(-1.5, 1.5) * DEG;
      for (const side of [1, -1]) pushLog('z', yc, -half, half, side * HW, r, col, twist);
      yc += gap * 0.94;
      r *= 0.87;
    }
  }
  {
    const wallMesh = new THREE.Mesh(mergeGeoms(logGeos), materials.log);
    wallMesh.name = 'cabin:walls';
    wallMesh.castShadow = true;
    wallMesh.receiveShadow = true;
    group.add(wallMesh);
  }

  /* =====================================================================
   * 1.5 室内壳（封闭暗盒）＋ 室内剪影
   * ===================================================================== */
  const inX = HW - 0.24, inZ = HD - 0.24;
  const inY0 = FND + 0.02, inY1 = WALL_Y1 - 0.12;
  const dark = (k) => new THREE.Color('#6f5e4c').multiplyScalar(k);
  const inMid = (inY0 + inY1) / 2, inH = inY1 - inY0;
  planeAt(bInner, 'interior', dark(0.78), { w: inX * 2, h: inZ * 2, y: inY0, rx: -Math.PI / 2, tile: 1.2 });
  planeAt(bInner, 'interior', dark(0.58), { w: inX * 2, h: inZ * 2, y: inY1, rx: Math.PI / 2, tile: 1.2 });
  planeAt(bInner, 'interior', dark(0.85), { w: inX * 2, h: inH, y: inMid, z: -inZ, tile: 1.2 });
  planeAt(bInner, 'interior', dark(0.66), { w: inX * 2, h: inH, y: inMid, z: inZ, ry: Math.PI, tile: 1.2 });
  planeAt(bInner, 'interior', dark(0.72), { w: inZ * 2, h: inH, x: inX, y: inMid, ry: -Math.PI / 2, tile: 1.2 });
  planeAt(bInner, 'interior', dark(0.72), { w: inZ * 2, h: inH, x: -inX, y: inMid, ry: Math.PI / 2, tile: 1.2 });

  /* =====================================================================
   * 1.6 屋顶
   * ===================================================================== */
  const roofHalf = HD + OVH;
  const slopeLen = roofHalf / Math.cos(SLOPE);      // 从屋脊线到檐口，两块板在屋脊正好相接（不重叠）
  const slabT = 0.15;
  const roofTint = new THREE.Color(1.20, 1.16, 1.10);   // 屋面受光偏亮（褪色木瓦）
  // 屋脊/檐口压条：低饱和灰棕，靠受光提亮（不用高饱和暖色，避免"塑料亮条"）
  const ridgeCol = new THREE.Color('#74604a');
  const fasciaCol = new THREE.Color('#6e5c48');
  const rakeCol = new THREE.Color('#6a5844');
  const roofNorm = (side) => new THREE.Vector3(0, Math.cos(SLOPE), Math.sin(SLOPE) * side);
  for (const side of [1, -1]) {
    const zc = side * roofHalf / 2;
    const yc = roofY(zc);
    const n = roofNorm(side);
    // 木瓦坡面（uv 沿坡向重复：一格 ≈ 4.8m 坡长 / 16 行木瓦 → 行距 ~0.30m）
    boxAt(bMain, 'shingle', roofTint, {
      w: W + OVH * 2 + 0.06, h: slabT, d: slopeLen, rx: side * SLOPE,
      x: 0, y: yc - n.y * slabT * 0.5, z: zc - n.z * slabT * 0.5,
      tX: 3.96, tY: 1.0, tZ: 4.80,
    });
    // 檐下阴影层（第二层几何，让屋檐下明显发暗）
    boxAt(bTrim, 'plankFine', new THREE.Color('#382c21').multiplyScalar(0.6), {
      w: W + OVH * 2 + 0.04, h: 0.05, d: slopeLen - 0.06, rx: side * SLOPE,
      x: 0, y: yc - n.y * (slabT + 0.045), z: zc - n.z * (slabT + 0.045),
      tX: 1.2, tZ: 1.2,
    });
    // 屋脊压条（受光 → 屋顶轮廓有亮边）
    boxAt(bTrim, 'plank', ridgeCol, {
      w: W + OVH * 2 + 0.10, h: 0.11, d: 0.38, rx: side * SLOPE,
      x: 0, y: roofY(0.18) + 0.085, z: side * 0.18, tile: 1.0,
    });
    // 封檐板（竖直板，贴在椽头外，受光形成明确亮边）
    boxAt(bTrim, 'plank', fasciaCol, {
      w: W + OVH * 2 + 0.10, h: 0.16, d: 0.05,
      x: 0, y: roofY(roofHalf) - 0.05, z: side * (roofHalf + 0.03), tile: 0.9,
    });
    // 山墙披水板（沿坡向）
    for (const sx of [1, -1]) {
      boxAt(bTrim, 'plank', rakeCol, {
        w: 0.07, h: 0.16, d: slopeLen, rx: side * SLOPE,
        x: sx * (HW + OVH + 0.02), y: roofY(zc) + 0.03, z: zc, tile: 0.9,
      });
    }
  }
  // 山墙三角补板：把圆木阶梯与屋面之间的锯齿缝填实，山墙轮廓不露缝
  for (const sx of [1, -1]) {
    const tri = triangleGeo(
      [sx * (HW - 0.06), WALL_Y1 - 0.30, -(HD - 0.10)],
      [sx * (HW - 0.06), WALL_Y1 - 0.30, (HD - 0.10)],
      [sx * (HW - 0.06), RIDGE_Y - 0.12, 0],
      [sx, 0, 0], 1.3,
    );
    if (tri) place(bTrim, 'plankFine', tri, new THREE.Color('#3d3025').multiplyScalar(0.9), {});
  }
  // 露出的椽头
  {
    const rafGeo = new THREE.BoxGeometry(0.085, 0.13, 0.95);
    scaleBoxUV(rafGeo, 0.085, 0.13, 0.95, 0.7, 0.7, 0.7);
    setGeoColor(rafGeo, _white);
    const tf = [];
    const spanW = W + OVH * 2 - 0.5;
    const n = Math.floor(spanW / 0.44);
    for (let i = 0; i <= n; i++) {
      const x = -spanW / 2 + i * (spanW / n);
      for (const side of [1, -1]) {
        const zc = side * (roofHalf - 0.44);
        tf.push({ x, y: roofY(zc) - 0.17, z: zc, rx: side * SLOPE, ry: rng.range(-0.02, 0.02), s: rng.range(0.94, 1.06) });
      }
    }
    const mesh = new THREE.InstancedMesh(rafGeo, materials.plank, tf.length);
    const mm = new THREE.Matrix4(), qq = new THREE.Quaternion(), ee = new THREE.Euler(), ss = new THREE.Vector3(1, 1, 1);
    const cc = new THREE.Color();
    tf.forEach((t, i) => {
      ee.set(t.rx, t.ry, 0); qq.setFromEuler(ee);
      ss.set(t.s, 1, t.s);
      mm.compose(new THREE.Vector3(t.x, t.y, t.z), qq, ss);
      mesh.setMatrixAt(i, mm);
      mesh.setColorAt(i, cc.set(PALETTE.logDark).multiplyScalar(rng.range(0.88, 1.14)));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'cabin:rafters';
    group.add(mesh);
  }

  /* =====================================================================
   * 1.7 烟囱 + 炊烟
   * ===================================================================== */
  const chX = CABIN.chimney.x, chZ = CABIN.chimney.z, chR = CABIN.chimney.radius, chTop = CABIN.chimney.height;
  {
    const H2 = chTop + 0.60;
    const g = new THREE.CylinderGeometry(chR * 0.94, chR, H2, 12, 6, false);
    scaleCylUV(g, chR, H2, 0.55);
    const pos = g.attributes.position;
    const col = new Float32Array(pos.count * 3);
    const base = new THREE.Color(PALETTE.stone);
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) + H2 / 2;                                    // 0..H2（0 = 埋地）
      const soot = smoothstep(chTop * 0.42, chTop * 0.98, y)
        * (0.70 + 0.30 * Math.abs(Math.sin(y * 7.3 + pos.getX(i) * 9.0)));
      const c = base.clone().multiplyScalar(lerp(0.95, 0.28, soot));
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.translate(chX, (chTop - 0.60) / 2, chZ);
    binPush(bMain, 'stone', g);
    // 烟囱帽
    boxAt(bTrim, 'stone', new THREE.Color(PALETTE.stoneDark).multiplyScalar(1.15), {
      w: chR * 2.4, h: 0.09, d: chR * 2.4, x: chX, y: chTop + 0.05, z: chZ, tile: 0.5,
    });
    for (const sx of [1, -1]) {
      for (const sz of [1, -1]) {
        boxAt(bTrim, 'stone', new THREE.Color(PALETTE.stone).multiplyScalar(0.78), {
          w: 0.10, h: 0.19, d: 0.10, x: chX + sx * chR * 0.70, y: chTop + 0.20, z: chZ + sz * chR * 0.70, tile: 0.4,
        });
      }
    }
    boxAt(bTrim, 'stone', new THREE.Color(PALETTE.stoneDark).multiplyScalar(0.95), {
      w: chR * 2.9, h: 0.10, d: chR * 2.9, x: chX, y: chTop + 0.345, z: chZ, tile: 0.5,
    });
    // 烟熏贴花
    planeAt(bDecal, 'stain', new THREE.Color('#1e1814'), {
      w: 0.95, h: 1.3, x: chX + chR * 0.97, y: chTop - 1.05, z: chZ, ry: Math.PI / 2,
    });
    planeAt(bDecal, 'stain', new THREE.Color('#1e1814'), {
      w: 0.8, h: 1.1, x: chX - 0.16, y: chTop - 1.0, z: chZ + chR * 0.98,
    });
  }

  /* =====================================================================
   * 1.8 门窗：木框内衬 + 玻璃 + 内部暖光面
   * ===================================================================== */
  const windows = [];
  const lights = [];
  const glowTargets = [];
  const winGlowTex = makeWindowGlowTexture(11);
  // 窗内暖光面：渐变贴图同时作为 albedo 与 emissiveMap → 有层次、有明暗渐变
  const glowMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#241608'),
    map: winGlowTex, emissiveMap: winGlowTex,
    emissive: new THREE.Color(PALETTE.windowGlow), emissiveIntensity: 0.02,
    roughness: 0.55, metalness: 0.0,
    transparent: true, opacity: 0.96, depthWrite: false, side: THREE.DoubleSide,
  });
  // 灯泡 / 火塘 / 提灯芯：均匀自发光（不吃渐变）
  const glowFlatMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#2a1a0c'), emissive: new THREE.Color(PALETTE.windowGlow),
    emissiveIntensity: 0.02, roughness: 0.5, metalness: 0.0,
  });
  // 上限按"辐亮度 ≈0.5–0.8"标定：比受光木料（≈0.28）明显亮，但不会把渐变糊成死白
  glowTargets.push({ mat: glowMat, min: 0.02, max: 2.2 });
  glowTargets.push({ mat: glowFlatMat, min: 0.02, max: 2.6 });

  const frameCol = () => new THREE.Color(PALETTE.logLight).multiplyScalar(0.9);

  /**
   * 造窗。face='z'（前后墙，u 沿 X）/ 'x'（山墙，u 沿 Z）
   * wallSign：outward 法线方向；uC：开口横向中心；holeY0/holeY1：真实洞口高度
   */
  function buildWindow(face, wallSign, uC, holeA, holeB, holeY0, holeY1, opts = {}) {
    const { light = false, plant = false } = opts;
    const wallC = face === 'z' ? HD : HW;
    const fr = 0.095;                                   // 木框宽度
    const jamD = LR * 2 + 0.06;
    const u0 = holeA + fr, u1 = holeB - fr;
    const y0 = holeY0 + fr, y1 = holeY1 - fr;
    const uc = (u0 + u1) / 2, yc = (y0 + y1) / 2;
    const wIn = u1 - u0, hIn = y1 - y0;
    const at = (uo, yo, zo) => (face === 'z'
      ? { x: uC + uo, y: yo, z: wallSign * (wallC + zo) }
      : { x: wallSign * (wallC + zo), y: yo, z: uC + uo });

    // 洞口内衬：四块板围成一圈（从真实洞口收到玻璃开口）
    const ringU = (holeA + holeB) / 2;
    const ringY = (holeY0 + holeY1) / 2;
    const outerW = holeB - holeA, outerH = holeY1 - holeY0;
    const boardTop = { off: (holeY1 + y1) / 2, size: holeY1 - y1, along: outerW };
    const boardBot = { off: (holeY0 + y0) / 2, size: y0 - holeY0, along: outerW };
    for (const b of [boardTop, boardBot]) {
      if (b.size < 0.005) continue;
      const p2 = at((ringU - uC), b.off, 0.012);
      if (face === 'z') boxAt(bTrim, 'plank', frameCol(), { w: b.along, h: b.size, d: jamD, x: p2.x, y: b.off, z: p2.z, tile: 0.55 });
      else boxAt(bTrim, 'plank', frameCol(), { w: jamD, h: b.size, d: b.along, x: p2.x, y: b.off, z: p2.z, tile: 0.55 });
    }
    for (const sgn of [1, -1]) {
      const uo = sgn * (outerW / 2);
      const p = at(uo, ringY, 0.012);
      const size = holeY1 - holeY0;
      if (face === 'z') boxAt(bTrim, 'plank', frameCol(), { w: fr, h: size, d: jamD, x: p.x, y: ringY, z: p.z, tile: 0.55 });
      else boxAt(bTrim, 'plank', frameCol(), { w: jamD, h: size, d: fr, x: p.x, y: ringY, z: p.z, tile: 0.55 });
    }
    // 侧向夹板（洞口左右两侧的木框，从洞口边收到玻璃边）
    for (const sgn of [1, -1]) {
      const uo = sgn * ((outerW / 2 + wIn / 2) / 2);
      const sizeU = outerW / 2 - wIn / 2;
      if (sizeU < 0.005) continue;
      const p = at(uo, ringY, 0.012);
      if (face === 'z') boxAt(bTrim, 'plank', frameCol(), { w: sizeU, h: holeY1 - holeY0, d: jamD, x: p.x, y: ringY, z: p.z, tile: 0.55 });
      else boxAt(bTrim, 'plank', frameCol(), { w: jamD, h: holeY1 - holeY0, d: sizeU, x: p.x, y: ringY, z: p.z, tile: 0.55 });
    }

    // 玻璃
    const gm = new THREE.Mesh(new THREE.PlaneGeometry(wIn, hIn), materials.glass);
    const gp = at(uc - uC, yc, -0.03);
    gm.position.set(gp.x, gp.y, gp.z);
    gm.rotation.y = face === 'z' ? (wallSign > 0 ? 0 : Math.PI) : (wallSign > 0 ? Math.PI / 2 : -Math.PI / 2);
    gm.name = 'cabin:glass';
    group.add(gm);

    // 十字窗棂：外侧（受光木棂）+ 内侧（逆光暗线，让窗"分格"）
    const bw = 0.036;
    for (const horiz of [true, false]) {
      const p = at(uc - uC, yc, 0.062);
      if (face === 'z') {
        boxAt(bTrim, 'plank', frameCol(), horiz
          ? { w: wIn, h: bw, d: 0.026, x: p.x, y: p.y, z: p.z, tile: 0.4 }
          : { w: bw, h: hIn, d: 0.026, x: p.x, y: p.y, z: p.z, tile: 0.4 });
      } else {
        boxAt(bTrim, 'plank', frameCol(), horiz
          ? { w: 0.026, h: bw, d: wIn, x: p.x, y: p.y, z: p.z, tile: 0.4 }
          : { w: 0.026, h: hIn, d: bw, x: p.x, y: p.y, z: p.z, tile: 0.4 });
      }
    }
    // 内侧窗棂（位于玻璃与暖光面之间 → 在窗光上投出暗色分格线）
    {
      const iw = 0.052;
      const p = at(uc - uC, yc, -0.075);
      const darkBar = new THREE.Color('#3a2413');
      if (face === 'z') {
        boxAt(bTrim, 'plank', darkBar, { w: wIn + 0.02, h: iw, d: 0.022, x: p.x, y: p.y, z: p.z, tile: 0.4 });
        boxAt(bTrim, 'plank', darkBar, { w: iw, h: hIn + 0.02, d: 0.022, x: p.x, y: p.y, z: p.z, tile: 0.4 });
      } else {
        boxAt(bTrim, 'plank', darkBar, { w: 0.022, h: iw, d: wIn + 0.02, x: p.x, y: p.y, z: p.z, tile: 0.4 });
        boxAt(bTrim, 'plank', darkBar, { w: 0.022, h: hIn + 0.02, d: iw, x: p.x, y: p.y, z: p.z, tile: 0.4 });
      }
    }

    // 内部暖光面（略微外凸）
    const gl = new THREE.Mesh(bulgePlane(wIn * 1.04, hIn * 1.04, 6, 0.04), glowMat);
    const glp = at(uc - uC, yc, -0.115);
    gl.position.set(glp.x, glp.y, glp.z);
    gl.rotation.y = gm.rotation.y;
    gl.name = 'cabin:winGlow';
    group.add(gl);

    // 窗台（外挑）
    const sp = at(uc - uC, y0 - fr / 2 - 0.02, 0.14);
    const sillCol = new THREE.Color(PALETTE.log).multiplyScalar(1.06);
    if (face === 'z') boxAt(bTrim, 'plank', sillCol, { w: wIn + 0.36, h: 0.065, d: 0.30, x: sp.x, y: sp.y, z: sp.z, tile: 0.5 });
    else boxAt(bTrim, 'plank', sillCol, { w: 0.30, h: 0.065, d: wIn + 0.36, x: sp.x, y: sp.y, z: sp.z, tile: 0.5 });

    let lightObj = null;
    if (light) {
      lightObj = new THREE.PointLight(PALETTE.windowGlow, 0, 8, 2);
      const lp = at(uc - uC, yc, 0.5);
      lightObj.position.set(lp.x, lp.y, lp.z);
      lightObj.castShadow = false;
      lightObj.name = 'cabin:winLight';
      group.add(lightObj);
      lights.push(lightObj);
    }

    // 窗台小盆栽
    if (plant) {
      const pp = at(uc - uC - wIn * 0.22, y0 - fr / 2 - 0.02 + 0.033, 0.16);
      cylAt(bTrim, 'fabric', new THREE.Color('#9c6d50'), {
        r: 0.085, r2: 0.10, h: 0.16, seg: 10, x: pp.x, y: pp.y + 0.08, z: pp.z, tile: 0.4,
      });
      for (let i = 0; i < 3; i++) {
        const lf = new THREE.PlaneGeometry(0.30, 0.30);
        place(bTrim, 'leaf', lf, new THREE.Color(1, 1, 1).multiplyScalar(rng.range(0.8, 1.1)), {
          x: pp.x, y: pp.y + 0.25, z: pp.z,
          ry: (i / 3) * Math.PI + rng.range(-0.2, 0.2), rx: rng.range(-0.2, 0.2),
        });
      }
    }

    windows.push({ mesh: gm, light: lightObj, glow: gl });
  }

  // 正面两扇窗（真实洞口由圆木层切出）
  for (const cx of [winX, -winX]) {
    const [hy0, hy1] = cutSpan(1.14, 2.30);
    buildWindow('z', 1, cx, cx - winCutX, cx + winCutX, hy0, hy1, { light: true, plant: cx > 0 });
  }
  // 山墙两扇小窗
  for (const sx of [1, -1]) {
    const [hy0, hy1] = cutSpan(1.44, 2.16);
    buildWindow('x', sx, 0, -gWinCutZ, gWinCutZ, hy0, hy1, { light: false, plant: false });
  }

  /* =====================================================================
   * 1.9 门（竖条拼板 + 铁铰链 + 把手 + 门槛石 + 雨棚 + 门垫）
   * ===================================================================== */
  {
    const [dhy0, dhy1] = cutSpan(0.44, 2.32);
    const fr = 0.105;
    const jamD = LR * 2 + 0.06;
    const du0 = -doorCutX + fr, du1 = doorCutX - fr;
    const dy0 = dhy0 + fr, dy1 = dhy1 - fr;
    const dc = (dy0 + dy1) / 2, dh = dy1 - dy0, dw = du1 - du0;
    const zBase = HD + 0.012;
    const doorZ = HD - 0.02;
    // 内衬（上下 + 左右）
    boxAt(bTrim, 'plank', frameCol(), { w: doorCutX * 2, h: dhy1 - dy1, d: jamD, x: 0, y: (dhy1 + dy1) / 2, z: zBase, tile: 0.55 });
    boxAt(bTrim, 'plank', frameCol(), { w: doorCutX * 2, h: dy0 - dhy0, d: jamD, x: 0, y: (dhy0 + dy0) / 2, z: zBase, tile: 0.55 });
    for (const sgn of [1, -1]) {
      const size = doorCutX - du1;
      boxAt(bTrim, 'plank', frameCol(), { w: size, h: dhy1 - dhy0, d: jamD, x: sgn * (doorCutX + du1) / 2, y: (dhy0 + dhy1) / 2, z: zBase, tile: 0.55 });
    }
    // 门后暗衬（防透光）
    boxAt(bInner, 'plankFine', new THREE.Color('#221a13'), { w: dw + 0.05, h: dh + 0.05, d: 0.03, x: 0, y: dc, z: doorZ - 0.055, tile: 1 });
    // 竖条拼板
    const nPl = 5, pw = dw / nPl;
    for (let i = 0; i < nPl; i++) {
      const x = du0 + pw * (i + 0.5);
      const t = rng.range(0.94, 1.08);
      boxAt(bTrim, 'plank', new THREE.Color(PALETTE.log).multiplyScalar(t), {
        w: pw - 0.014, h: dh, d: 0.05, x, y: dc, z: doorZ, tX: 1.2, tY: 0.5, tZ: 0.5,
      });
    }
    // 横撑
    for (const y of [dy0 + dh * 0.22, dy1 - dh * 0.20]) {
      boxAt(bTrim, 'plank', new THREE.Color(PALETTE.logDark).multiplyScalar(1.28), {
        w: dw - 0.05, h: 0.13, d: 0.035, x: 0, y, z: doorZ + 0.048, tile: 0.7,
      });
    }
    // 铁铰链
    for (const y of [dy0 + dh * 0.22, dy1 - dh * 0.20]) {
      boxAt(bTrim, 'metal', _white, { w: 0.42, h: 0.055, d: 0.022, x: du0 + 0.26, y, z: doorZ + 0.078, tile: 0.35 });
      cylAt(bTrim, 'metal', _white, { r: 0.022, h: 0.17, seg: 8, x: du0 + 0.055, y, z: doorZ + 0.078, tile: 0.3 });
    }
    // 门把手 / 锁板
    cylAt(bTrim, 'metal', _white, { r: 0.017, h: 0.13, seg: 8, x: du1 - 0.14, y: dc - 0.02, z: doorZ + 0.10, rx: Math.PI / 2, tile: 0.3 });
    boxAt(bTrim, 'metal', _white, { w: 0.09, h: 0.16, d: 0.03, x: du1 - 0.12, y: dc - 0.24, z: doorZ + 0.05, tile: 0.3 });
    cylAt(bTrim, 'metal', _white, { r: 0.012, h: 0.10, seg: 6, x: du1 - 0.12, y: dc - 0.32, z: doorZ + 0.06, tile: 0.3 });
    // 门槛石
    boxAt(bMain, 'stone', new THREE.Color(PALETTE.stoneDark).multiplyScalar(1.18), {
      w: doorCutX * 2 + 0.3, h: 0.10, d: 0.42, x: 0, y: FND + 0.045, z: HD + 0.12, tile: 0.45,
    });
    // 门垫
    boxAt(bTrim, 'fabric', new THREE.Color(PALETTE.fabric).multiplyScalar(0.7), {
      w: dw + 0.16, h: 0.020, d: 0.42, x: 0, y: FND + 0.021, z: HD + 0.66, tile: 0.5,
    });
    // 小雨棚（门廊披檐之下的挑檐）
    const hz0 = HD + 0.10, hz1 = HD + 0.55, hy0 = 2.68, hy1 = 2.58;
    const hang = Math.atan2(hy0 - hy1, hz1 - hz0);
    boxAt(bTrim, 'shingle', _white, {
      w: 1.56, h: 0.05, d: Math.hypot(hz1 - hz0, hy0 - hy1) + 0.05, rx: hang,
      x: 0, y: (hy0 + hy1) / 2, z: (hz0 + hz1) / 2, tX: 1.4, tZ: 1.2,
    });
    for (const sx of [1, -1]) {
      boxAt(bTrim, 'plank', new THREE.Color(PALETTE.logDark).multiplyScalar(0.95), {
        w: 0.06, h: 0.17, d: 0.46, rx: hang, x: sx * 0.68, y: hy0 - 0.15, z: HD + 0.30, tile: 0.6,
      });
    }
    boxAt(bTrim, 'plank', new THREE.Color(PALETTE.logDark).multiplyScalar(1.1), {
      w: 1.60, h: 0.08, d: 0.05, x: 0, y: hy1 - 0.06, z: HD + 0.58, tile: 0.7,
    });
    // 干香草束
    for (let i = 0; i < 5; i++) {
      cylAt(bTrim, 'plank', new THREE.Color('#6f5a3a').multiplyScalar(rng.range(0.85, 1.1)), {
        r: 0.012, h: rng.range(0.24, 0.34), seg: 5,
        x: 0.30 + (rng() - 0.5) * 0.10, y: dy1 - 0.20, z: HD + LR + 0.05,
        rx: rng.range(-0.12, 0.12), rz: rng.range(-0.18, 0.18), tile: 0.3,
      });
    }
  }

  /* =====================================================================
   * 1.10 门廊：木平台 + 立柱斜撑 + 木栏 + 三级石阶 + 提灯
   * ===================================================================== */
  const deckY = FND;
  const deckW = W + 0.70;
  const deckZ0 = HD - 0.05, deckZ1 = HD + CABIN.porchDepth - 0.05;
  const postX = deckW / 2 - 0.35;
  const postZ = deckZ1 - 0.30;
  const porchInnerZ = HD + 0.02, porchInnerY = 2.90;
  const porchPitch = 0.45;
  const porchRoofY = (z) => porchInnerY - porchPitch * (z - porchInnerZ);
  const headerY = porchRoofY(postZ) - 0.10;
  {
    const dz = deckZ1 - deckZ0;
    boxAt(bMain, 'plank', _white, {
      w: deckW, h: 0.12, d: dz, y: deckY - 0.06, z: (deckZ0 + deckZ1) / 2, tX: 0.55, tY: 1, tZ: 0.55,
    });
    const nb = Math.max(3, Math.floor(dz / 0.34));
    for (let i = 1; i < nb; i++) {
      const z = deckZ0 + (dz * i) / nb;
      boxAt(bTrim, 'plankFine', new THREE.Color(PALETTE.logDark).multiplyScalar(1.35), {
        w: deckW - 0.03, h: 0.012, d: 0.02, y: deckY + 0.004, z, tile: 0.5,
      });
    }
    boxAt(bTrim, 'plank', new THREE.Color(PALETTE.logDark), { w: deckW, h: 0.10, d: 0.06, y: deckY - 0.03, z: deckZ1 + 0.03, tile: 0.6 });
    boxAt(bMain, 'stone', new THREE.Color(PALETTE.stone).multiplyScalar(0.88), {
      w: deckW - 0.12, h: deckY, d: dz - 0.12, y: deckY / 2 - 0.05, z: (deckZ0 + deckZ1) / 2 - 0.02, tile: 0.6,
    });
  }
  for (const sx of [1, -1]) {
    cylAt(bMain, 'plank', new THREE.Color(PALETTE.log).multiplyScalar(0.84), {
      r: 0.12, r2: 0.105, h: headerY + 0.10 - deckY, seg: 8,
      x: sx * postX, y: (deckY + headerY + 0.10) / 2, z: postZ, tile: 1.0,
    });
    boxAt(bMain, 'stone', new THREE.Color(PALETTE.stoneDark).multiplyScalar(1.05), {
      w: 0.32, h: 0.15, d: 0.32, x: sx * postX, y: deckY + 0.07, z: postZ, tile: 0.4,
    });
    for (const dz of [-1, 1]) {
      boxAt(bTrim, 'plank', new THREE.Color(PALETTE.logDark).multiplyScalar(1.05), {
        w: 0.075, h: 0.075, d: 0.78, rx: dz * 0.70, x: sx * postX, y: headerY - 0.28, z: postZ + dz * 0.22, tile: 0.6,
      });
    }
  }
  for (const zz of [postZ, porchInnerZ + 0.08]) {
    boxAt(bTrim, 'plank', new THREE.Color(PALETTE.logDark).multiplyScalar(1.02), {
      w: deckW, h: 0.16, d: 0.13, x: 0, y: zz === postZ ? headerY : porchRoofY(porchInnerZ) - 0.18, z: zz, tX: 0.7, tZ: 0.7,
    });
  }
  {
    // 披檐：压在正檐之下（檐口 2.73），不与之相交
    const w0 = porchInnerZ, w1 = deckZ1 + 0.10;
    const y0 = porchRoofY(w0), y1 = porchRoofY(w1);
    const len = Math.hypot(w1 - w0, y1 - y0);
    const ang = Math.atan2(y0 - y1, w1 - w0);
    boxAt(bTrim, 'shingle', _white, {
      w: deckW + 0.14, h: 0.09, d: len + 0.06, rx: ang,
      x: 0, y: (y0 + y1) / 2, z: (w0 + w1) / 2, tX: 2.4, tY: 1, tZ: 2.6,
    });
    boxAt(bTrim, 'plankFine', new THREE.Color('#382c21').multiplyScalar(0.62), {
      w: deckW + 0.10, h: 0.035, d: len, rx: ang, x: 0, y: (y0 + y1) / 2 - 0.06, z: (w0 + w1) / 2, tX: 0.8, tZ: 0.8,
    });
    boxAt(bTrim, 'plank', new THREE.Color(PALETTE.logDark).multiplyScalar(1.12), {
      w: deckW + 0.16, h: 0.14, d: 0.05, x: 0, y: y1 - 0.10, z: w1 + 0.03, tile: 0.7,
    });
    for (const sx of [1, -1]) {
      boxAt(bTrim, 'plank', new THREE.Color(PALETTE.logDark).multiplyScalar(1.05), {
        w: 0.05, h: 0.13, d: len, rx: ang, x: sx * (deckW / 2 + 0.06), y: (y0 + y1) / 2, z: (w0 + w1) / 2, tile: 0.7,
      });
    }
    // 靠墙泛水板（封住披檐与木墙之间的缝）
    boxAt(bTrim, 'plank', new THREE.Color(PALETTE.logDark).multiplyScalar(1.2), {
      w: deckW + 0.14, h: 0.16, d: 0.05, x: 0, y: porchInnerY + 0.02, z: HD + LR + 0.04, tile: 0.7,
    });
  }
  // 木栏（横杆 + 车削立柱），台阶处开口
  {
    const railZ = deckZ1 - 0.10;
    const railY = deckY + 0.88, railY2 = deckY + 0.34;
    const gapH = 1.0;
    const halfW = deckW / 2 - 0.16;
    const baluster = new THREE.LatheGeometry([
      new THREE.Vector2(0.052, 0), new THREE.Vector2(0.052, 0.05), new THREE.Vector2(0.047, 0.08),
      new THREE.Vector2(0.030, 0.115), new THREE.Vector2(0.028, 0.20), new THREE.Vector2(0.045, 0.255),
      new THREE.Vector2(0.048, 0.285), new THREE.Vector2(0.030, 0.325), new THREE.Vector2(0.026, 0.40),
      new THREE.Vector2(0.040, 0.44), new THREE.Vector2(0.040, 0.50),
    ], 8);
    scaleUV(baluster, 0.8, 1.0);
    setGeoColor(baluster, _white);
    const tf = [];
    for (const seg of [[-halfW, -gapH], [gapH, halfW]]) {
      const len = seg[1] - seg[0];
      // 栏杆压到 logDark 一档：视觉焦点留给门与窗
      boxAt(bTrim, 'plank', new THREE.Color(PALETTE.logDark).multiplyScalar(1.02), {
        w: len, h: 0.075, d: 0.075, x: (seg[0] + seg[1]) / 2, y: railY, z: railZ, tX: 0.5, tZ: 0.5,
      });
      boxAt(bTrim, 'plank', new THREE.Color(PALETTE.logDark).multiplyScalar(0.92), {
        w: len, h: 0.055, d: 0.055, x: (seg[0] + seg[1]) / 2, y: railY2, z: railZ, tX: 0.5, tZ: 0.5,
      });
      for (const e of [0, 1]) {
        boxAt(bTrim, 'plank', new THREE.Color(PALETTE.logDark).multiplyScalar(1.05), {
          w: 0.10, h: railY - deckY + 0.04, d: 0.10, x: seg[e], y: (deckY + railY) / 2, z: railZ, tile: 0.5,
        });
      }
      const n = Math.max(2, Math.round(len / 0.19));
      for (let i = 0; i <= n; i++) tf.push({ x: seg[0] + (len * i) / n, y: deckY + 0.02, z: railZ, ry: rng.range(-0.03, 0.03), s: rng.range(0.96, 1.04) });
    }
    // 两端转角短栏（连到立柱）
    for (const sx of [1, -1]) {
      const z0 = railZ, z1 = postZ;
      const n = Math.max(2, Math.round(Math.abs(z1 - z0) / 0.19));
      boxAt(bTrim, 'plank', new THREE.Color(PALETTE.logDark).multiplyScalar(1.0), {
        w: 0.075, h: 0.075, d: Math.abs(z1 - z0), x: sx * halfW, y: railY, z: (z0 + z1) / 2, tX: 0.5, tZ: 0.5,
      });
      boxAt(bTrim, 'plank', new THREE.Color(PALETTE.logDark).multiplyScalar(0.9), {
        w: 0.055, h: 0.055, d: Math.abs(z1 - z0), x: sx * halfW, y: railY2, z: (z0 + z1) / 2, tX: 0.5, tZ: 0.5,
      });
      for (let i = 0; i <= n; i++) tf.push({ x: sx * halfW, y: deckY + 0.02, z: z0 + ((z1 - z0) * i) / n, ry: rng.range(-0.03, 0.03), s: rng.range(0.96, 1.04) });
    }
    const railMesh = new THREE.InstancedMesh(baluster, materials.plank, tf.length);
    const mm = new THREE.Matrix4(), qq = new THREE.Quaternion(), ee = new THREE.Euler(), ss = new THREE.Vector3(1, 1, 1);
    const cc = new THREE.Color();
    tf.forEach((t, i) => {
      ee.set(0, t.ry, 0); qq.setFromEuler(ee);
      const s = rng.range(0.97, 1.03);
      ss.set(s, s, s);
      mm.compose(new THREE.Vector3(t.x, t.y, t.z), qq, ss);
      railMesh.setMatrixAt(i, mm);
      railMesh.setColorAt(i, cc.set(PALETTE.logDark).multiplyScalar(rng.range(0.9, 1.08)));
    });
    railMesh.instanceMatrix.needsUpdate = true;
    if (railMesh.instanceColor) railMesh.instanceColor.needsUpdate = true;
    railMesh.receiveShadow = true;
    railMesh.name = 'cabin:balusters';
    group.add(railMesh);
  }
  // 三级石阶
  {
    const total = deckY - (groundAtSteps - baseY);
    const rise = total / 3;
    for (let i = 0; i < 3; i++) {
      const topY = deckY - rise * (i + 1);
      const z0 = deckZ1 + i * 0.44, z1 = z0 + 0.48;
      const w = 1.98 - i * 0.12;
      const hh = topY + 0.34;
      boxAt(bMain, 'stone', new THREE.Color(PALETTE.stone).multiplyScalar(0.9 + i * 0.03), {
        w, h: hh, d: z1 - z0, x: 0, y: topY - hh / 2, z: (z0 + z1) / 2, tile: 0.5,
      });
    }
  }
  // 栏杆提灯
  const swingNodes = [];
  {
    const px = deckW / 2 - 0.26, pz = deckZ1 - 0.10;
    const pivot = new THREE.Group();
    pivot.name = 'cabin:lanternPivot';
    pivot.position.set(px, headerY + 0.02, pz);
    group.add(pivot);
    cylAt(bTrim, 'metal', _white, { r: 0.012, h: 0.17, seg: 6, y: -0.085, tile: 0.3 });
    const lampY = -0.34;
    cylAt(bTrim, 'metal', _white, { r: 0.052, h: 0.03, seg: 8, y: lampY + 0.175, tile: 0.3 });
    cylAt(bTrim, 'metal', _white, { r: 0.082, h: 0.026, seg: 8, y: lampY - 0.16, tile: 0.3 });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + Math.PI / 4;
      cylAt(bTrim, 'metal', _white, { r: 0.011, h: 0.32, seg: 5, x: Math.cos(a) * 0.068, y: lampY, z: Math.sin(a) * 0.068, tile: 0.3 });
    }
    const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.060, 0.082, 0.30, 8, 1, true), materials.glass);
    shade.position.set(0, lampY, 0);
    shade.name = 'cabin:lanternGlass';
    pivot.add(shade);
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.044, 0.17, 8), glowFlatMat);
    core.position.set(0, lampY, 0);
    pivot.add(core);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texGlow, color: PALETTE.lampGlow, blending: THREE.AdditiveBlending,
      transparent: true, depthWrite: false, opacity: 0.4, fog: true,
    }));
    halo.scale.set(1.6, 1.6, 1.6);
    halo.position.set(0, lampY, 0);
    pivot.add(halo);
    const lamp = new THREE.PointLight(PALETTE.lampGlow, 0, 12, 2);
    lamp.position.set(0, lampY, 0);
    lamp.castShadow = false;
    lamp.name = 'cabin:porchLamp';
    pivot.add(lamp);
    lights.push(lamp);
    swingNodes.push({ node: pivot, amp: 0.038, speed: 1.35, phase: rng() * TAU, halo, lamp });
  }

  /* =====================================================================
   * 1.11 岁月痕迹：苔藓 / 雨渍 / 修补板 / 旧工具
   * ===================================================================== */
  for (let i = 0; i < 12; i++) {
    const x = rng.range(-(HW + OVH * 0.7), HW + OVH * 0.7);
    const side = rng.sign();
    const zc = clamp(Math.abs(rng.gauss(0, 1.3)) * side + side * 0.12, -roofHalf * 0.9, roofHalf * 0.9);
    const y = roofY(zc);
    const s = rng.range(0.5, 1.6);
    const sgn = Math.sign(zc || 1);
    const nz = Math.sin(SLOPE) * sgn, ny = Math.cos(SLOPE);
    planeAt(bDecal, 'moss', new THREE.Color(PALETTE.roofMoss).multiplyScalar(rng.range(0.8, 1.15)), {
      w: s * 0.95, h: s * 0.62, x, y: y + ny * 0.035, z: zc + nz * 0.035,
      rz: rng.range(-0.6, 0.6), rx: -Math.PI / 2 + sgn * SLOPE,
    });
  }
  for (let i = 0; i < 6; i++) {
    const onZ = rng() < 0.66;
    const sgn = rng.sign();
    const col = new THREE.Color('#2b2119').multiplyScalar(rng.range(0.9, 1.2));
    if (onZ) {
      planeAt(bDecal, 'stain', col, {
        w: rng.range(0.4, 1.1), h: rng.range(0.26, 0.42),
        x: rng.range(-HW + 0.7, HW - 0.7), y: FND - 0.19, z: sgn * (fd / 2 + 0.014),
        ry: sgn > 0 ? 0 : Math.PI,
      });
    } else {
      planeAt(bDecal, 'stain', col, {
        w: rng.range(0.4, 1.0), h: rng.range(0.26, 0.42),
        y: FND - 0.19, x: sgn * (fw / 2 + 0.014), z: rng.range(-HD + 0.7, HD - 0.7),
        ry: sgn > 0 ? Math.PI / 2 : -Math.PI / 2,
      });
    }
  }
  {
    // 修补用的新木板（明显色差 + 端头木楔）
    const zFace = HD + LR + 0.04;
    boxAt(bTrim, 'plank', new THREE.Color(PALETTE.logLight).multiplyScalar(1.16), {
      w: 1.45, h: 0.25, d: 0.04, x: -0.62, y: 2.78, z: zFace, rz: rng.range(-0.05, 0.05), tX: 0.8, tY: 0.8, tZ: 0.8,
    });
    for (const e of [-1, 1]) {
      boxAt(bTrim, 'plank', new THREE.Color(PALETTE.logDark).multiplyScalar(1.12), {
        w: 0.08, h: 0.30, d: 0.07, x: -0.62 + e * 0.62, y: 2.78, z: zFace - 0.03, tile: 0.5,
      });
    }
    const xFace = -(HW + LR + 0.04);
    boxAt(bTrim, 'plank', new THREE.Color(PALETTE.logLight).multiplyScalar(1.1), {
      w: 0.04, h: 0.23, d: 1.25, x: xFace, y: 2.66, z: 1.05, rx: rng.range(-0.05, 0.05), tX: 0.8, tY: 0.8, tZ: 0.8,
    });
    for (const e of [-1, 1]) {
      boxAt(bTrim, 'plank', new THREE.Color(PALETTE.logDark).multiplyScalar(1.12), {
        w: 0.07, h: 0.28, d: 0.08, x: xFace + 0.03, y: 2.66, z: 1.05 + e * 0.54, tile: 0.5,
      });
    }
  }
  {
    // 墙上挂的旧工具：木钉 + 手锯 + 木槌
    const zf = HD + LR + 0.02;
    for (const px of [-1.08, -0.80]) cylAt(bTrim, 'plank', new THREE.Color(PALETTE.logDark), { r: 0.018, h: 0.11, seg: 6, x: px, y: 2.62, z: zf - 0.02, rx: Math.PI / 2, tile: 0.3 });
    boxAt(bTrim, 'metal', new THREE.Color(PALETTE.metal).multiplyScalar(0.72), {
      w: 0.46, h: 0.11, d: 0.012, x: -0.94, y: 2.44, z: zf, rz: -0.12, tile: 0.35,
    });
    boxAt(bTrim, 'plank', new THREE.Color(PALETTE.logDark).multiplyScalar(1.25), {
      w: 0.17, h: 0.06, d: 0.04, x: -0.68, y: 2.49, z: zf, rz: 0.18, tile: 0.4,
    });
    cylAt(bTrim, 'plank', new THREE.Color(PALETTE.logLight).multiplyScalar(0.92), {
      r: 0.028, h: 0.34, seg: 8, x: 1.18, y: 2.36, z: zf + 0.03, rz: 0.08, tile: 0.4,
    });
    cylAt(bTrim, 'plank', new THREE.Color(PALETTE.logDark).multiplyScalar(1.18), {
      r: 0.062, h: 0.19, seg: 9, x: 1.18, y: 2.54, z: zf + 0.03, rz: Math.PI / 2, tile: 0.4,
    });
  }

  /* =====================================================================
   * 1.12 室内剪影（high / ultra）
   * ===================================================================== */
  if (isHigh) {
    const fCol = (k) => new THREE.Color('#5c4c3c').multiplyScalar(k);
    const tx = -1.05, tz = 0.30, ty = FND + 0.76;
    boxAt(bInner, 'plankFine', fCol(1.0), { w: 1.4, h: 0.06, d: 0.88, x: tx, y: ty, z: tz, tile: 0.8 });
    for (const sx of [1, -1]) {
      for (const sz of [1, -1]) {
        boxAt(bInner, 'plankFine', fCol(0.85), { w: 0.07, h: 0.74, d: 0.07, x: tx + sx * 0.6, y: ty - 0.40, z: tz + sz * 0.35, tile: 0.6 });
      }
    }
    for (const [cx2, cz2, ry2] of [[tx + 0.12, tz - 0.98, 0.12], [tx - 0.08, tz + 0.98, Math.PI - 0.1]]) {
      boxAt(bInner, 'plankFine', fCol(0.9), { w: 0.44, h: 0.05, d: 0.42, x: cx2, y: FND + 0.47, z: cz2, ry: ry2, tile: 0.6 });
      for (const sx of [1, -1]) {
        for (const sz of [1, -1]) {
          boxAt(bInner, 'plankFine', fCol(0.78), { w: 0.05, h: 0.47, d: 0.05, x: cx2 + sx * 0.18, y: FND + 0.235, z: cz2 + sz * 0.17, ry: ry2, tile: 0.5 });
        }
      }
      boxAt(bInner, 'plankFine', fCol(0.86), { w: 0.44, h: 0.44, d: 0.045, x: cx2 - Math.sin(ry2) * 0.20, y: FND + 0.72, z: cz2 - Math.cos(ry2) * 0.20, ry: ry2, tile: 0.6 });
    }
    // 吊灯
    cylAt(bInner, 'metal', new THREE.Color('#3a3630'), { r: 0.012, h: 0.66, seg: 6, x: tx, y: inY1 - 0.33, z: tz, tile: 0.4 });
    const shadeGeo = new THREE.CylinderGeometry(0.10, 0.21, 0.20, 10, 1, true);
    const shadeMesh = new THREE.Mesh(shadeGeo, materials.plank);
    setGeoColor(shadeGeo, new THREE.Color('#4c3c2c'));
    shadeMesh.position.set(tx, inY1 - 0.72, tz);
    group.add(shadeMesh);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), glowFlatMat);
    bulb.position.set(tx, inY1 - 0.80, tz);
    group.add(bulb);
    // 壁炉火塘微光
    const fire = new THREE.Mesh(new THREE.PlaneGeometry(0.66, 0.36), glowFlatMat);
    fire.position.set(chX - 0.10, FND + 0.42, chZ + chR + 0.02);
    group.add(fire);
    // 长凳 + 木箱
    boxAt(bInner, 'plankFine', fCol(0.88), { w: 1.15, h: 0.06, d: 0.32, x: -2.2, y: FND + 0.44, z: -1.9, tile: 0.7 });
    for (const sx of [1, -1]) boxAt(bInner, 'plankFine', fCol(0.8), { w: 0.06, h: 0.42, d: 0.28, x: -2.2 + sx * 0.5, y: FND + 0.21, z: -1.9, tile: 0.5 });
    boxAt(bInner, 'plankFine', fCol(0.75), { w: 0.52, h: 0.44, d: 0.42, x: 2.55, y: FND + 0.22, z: 1.7, ry: 0.3, tile: 0.6 });
  }

  /* =====================================================================
   * 1.13 组装
   * ===================================================================== */
  // 屋面不吃自身阴影：低太阳掠射角下阴影贴图会在最大表面上产生痤疮（发黑斑块）
  group.add(binToGroup(bInner, 'cabin:interior', materials, {}));
  group.add(binToGroup(bMain, 'cabin:shell', materials, {
    cast: true, receive: true,
    overrides: { shingle: { receive: false }, metal: { receive: false } },
  }));
  group.add(binToGroup(bTrim, 'cabin:trim', materials, {
    cast: false, receive: true,
    overrides: { shingle: { receive: false } },
  }));
  group.add(binToGroup(bDecal, 'cabin:weathered', materials, { cast: false, receive: false }));

  /* =====================================================================
   * 1.14 炊烟
   * ===================================================================== */
  const smokeCount = isUltra ? 92 : qKey === 'high' ? 74 : qKey === 'medium' ? 56 : 42;
  const smokeGeo = new THREE.BufferGeometry();
  const smokePos = new Float32Array(smokeCount * 3);
  const smokeSize = new Float32Array(smokeCount);
  const smokeAlpha = new Float32Array(smokeCount);
  const smokeSeed = [];
  const smokeMouth = new THREE.Vector3(chX, chTop + 0.42, chZ);
  for (let i = 0; i < smokeCount; i++) {
    smokeSeed.push({
      p0: rng(), speed: rng.range(0.045, 0.09), rad: rng.range(0.03, 0.32),
      ang: rng() * TAU, size: rng.range(0.7, 1.45),
    });
    smokePos[i * 3] = smokeMouth.x;
    smokePos[i * 3 + 1] = smokeMouth.y;
    smokePos[i * 3 + 2] = smokeMouth.z;
    smokeSize[i] = 1;
    smokeAlpha[i] = 0;
  }
  smokeGeo.setAttribute('position', new THREE.BufferAttribute(smokePos, 3));
  smokeGeo.setAttribute('aSize', new THREE.BufferAttribute(smokeSize, 1));
  smokeGeo.setAttribute('aAlpha', new THREE.BufferAttribute(smokeAlpha, 1));
  const smokeMat = new THREE.PointsMaterial({
    size: 1.0, sizeAttenuation: true, map: texSmoke, color: PALETTE.smoke,
    transparent: true, depthWrite: false, opacity: 1.0, blending: THREE.NormalBlending,
  });
  smokeMat.onBeforeCompile = (shader) => {
    shader.vertexShader = 'attribute float aSize;\nattribute float aAlpha;\nvarying float vAlpha;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('gl_PointSize = size;', 'gl_PointSize = size * aSize;');
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvAlpha = aAlpha;');
    shader.fragmentShader = 'varying float vAlpha;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n\tdiffuseColor.a *= vAlpha;');
  };
  smokeMat.customProgramCacheKey = () => 'cabinSmoke';
  const smoke = new THREE.Points(smokeGeo, smokeMat);
  smoke.name = 'cabin:smoke';
  smoke.frustumCulled = false;
  group.add(smoke);
  // 世界风向 → 木屋局部（rotation.y = CABIN.rotation）
  const windLocal = new THREE.Vector3(
    0.87 * cosR + 0.49 * (-sinR), 0, 0.87 * sinR + 0.49 * cosR,
  ).normalize();

  /* =====================================================================
   * 1.15 状态与每帧更新
   * ===================================================================== */
  let nightFactor = 0.26;
  let windStrength = 0.6;
  let windSpeed = 0.6;
  // 窗光/灯火随 nightFactor 的上升曲线：白天基本熄灯，黄金时刻已点亮（核心提亮后
  // 太阳很亮，灯光必须早点"开灯"才不会被日照木料盖过去），深夜满亮。
  const ember = () => smoothstep(0.05, 0.35, nightFactor);

  function setState(state) {
    if (!state) return;
    if (typeof state.nightFactor === 'number') nightFactor = state.nightFactor;
    if (state.wind) {
      if (typeof state.wind.strength === 'number') windStrength = state.wind.strength;
      if (typeof state.wind.speed === 'number') windSpeed = state.wind.speed;
    }
    const e = ember();
    for (const t of glowTargets) t.mat.emissiveIntensity = lerp(t.min, t.max, e);
    for (const w of windows) if (w.light) w.light.intensity = e * 7.5;
    for (const s of swingNodes) {
      s.halo.material.opacity = 0.04 + e * 0.9;
      s.lamp.intensity = e * 13;
    }
  }

  function update(t, dt, state) {
    if (state) setState(state);
    const e = ember();

    // 炊烟：升起 → 随 wind 侧移 → 变大变淡 → 循环
    const sm = smokeGeo.attributes.position.array;
    const ss = smokeGeo.attributes.aSize.array;
    const sa = smokeGeo.attributes.aAlpha.array;
    const rise = 6.4;
    const drift = 3.2 * (0.3 + windStrength * 0.9);
    for (let i = 0; i < smokeCount; i++) {
      const s = smokeSeed[i];
      let p = (s.p0 + t * s.speed * (0.55 + windSpeed * 0.7)) % 1;
      if (p < 0) p += 1;
      const puff = Math.pow(p, 0.82);
      const spread = s.rad * (1 + p * 5.5);
      sm[i * 3] = smokeMouth.x + windLocal.x * drift * puff
        + Math.cos(s.ang) * spread + Math.sin(t * 0.55 + s.ang) * 0.22 * (0.4 + p);
      sm[i * 3 + 1] = smokeMouth.y + puff * rise + Math.sin(t * 0.9 + s.ang * 2.1) * 0.10;
      sm[i * 3 + 2] = smokeMouth.z + windLocal.z * drift * puff
        + Math.sin(s.ang) * spread + Math.cos(t * 0.41 + s.ang * 1.7) * 0.20 * (0.4 + p);
      ss[i] = (0.55 + p * 3.2) * s.size;
      sa[i] = smoothstep(0, 0.13, p) * Math.pow(1 - p, 1.35) * (0.26 + 0.46 * e) * (0.75 + 0.25 * s.size);
    }
    smokeGeo.attributes.position.needsUpdate = true;
    smokeGeo.attributes.aSize.needsUpdate = true;
    smokeGeo.attributes.aAlpha.needsUpdate = true;

    // 提灯微摆 + 灯火呼吸
    const w = 0.35 + windStrength * 1.15;
    for (const s of swingNodes) {
      s.node.rotation.z = Math.sin(t * s.speed * (0.6 + windSpeed) + s.phase) * s.amp * w;
      s.node.rotation.x = Math.cos(t * s.speed * 0.83 + s.phase * 1.3) * s.amp * 0.6 * w;
      s.halo.material.opacity = (0.05 + e * 0.9) * (0.88 + Math.sin(t * 3.7 + s.phase) * 0.07);
      s.lamp.intensity = e * 13 * (1 + Math.sin(t * 5.1 + s.phase) * 0.06);
    }
    const breathe = 1 + Math.sin(t * 1.7) * 0.022 + Math.sin(t * 4.3 + 1.2) * 0.012;
    for (const win of windows) if (win.light) win.light.intensity = e * 7.5 * breathe;

    void dt;
  }

  let tris = 0, meshCount = 0;
  group.traverse((o) => {
    if (!o.isMesh && !o.isPoints) return;
    meshCount++;
    if (o.isPoints) return;
    const g = o.geometry;
    const n = g.index ? g.index.count / 3 : (g.attributes.position?.count || 0) / 3;
    tris += n * (o.isInstancedMesh ? o.count : 1);
  });

  return {
    group,
    update,
    setState,
    lights,
    windows,
    smoke,
    stats: { triangles: Math.round(tris), meshes: meshCount, lights: lights.length },
  };
}

export default createCabin;
