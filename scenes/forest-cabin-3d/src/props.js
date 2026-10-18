/**
 * props.js — 院落生活道具
 * ---------------------------------------------------------------------------
 * 契约（core.js）：
 *   createProps({ scene, renderer, camera, quality, qualityKey, preset })
 *   → { group, update(t,dt,state), setState(state,t,dt), lanterns, stats }
 *
 * 布局：所有道具位置用「木屋局部坐标」定义（lx,lz），再经 yard() 转世界，
 *       高度一律取 terrainHeight → 精确落地，不悬空不穿模。
 *       院子范围的物件都躲开木屋（四壁外 0.8m 起）与正门小径。
 *
 * 只 import 'three' 与 './core.js'。
 */
import * as THREE from 'three';
import {
  CABIN, PALETTE, getTexture, getNormal, makeRng, applyWindSway,
  lerp, smoothstep, terrainHeight, sampleTerrain, pathNearest, getQuality, TAU,
} from './core.js';

/* =========================================================================
 * 0. 私有几何工具（与 cabin.js 同构，模块间不互相 import）
 * ========================================================================= */
const _white = new THREE.Color(1, 1, 1);

function setGeoColor(geo, color) {
  const c = color instanceof THREE.Color ? color : new THREE.Color(color);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

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
function swapUV(geo) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) { const x = uv.getX(i), y = uv.getY(i); uv.setXY(i, y, x); }
  return geo;
}
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

function newBin() { return new Map(); }
function binPush(bin, key, geo) {
  let a = bin.get(key);
  if (!a) { a = []; bin.set(key, a); }
  a.push(geo);
}
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
function latheAt(bin, key, color, pts, seg, o = {}) {
  const g = new THREE.LatheGeometry(pts, seg);
  return place(bin, key, g, color, o);
}
function binToGroup(bin, name, materials, { cast = false, receive = false, overrides = {} } = {}) {
  const g = new THREE.Group();
  g.name = name;
  for (const [key, list] of bin) {
    if (!list.length) continue;
    const mat = materials[key];
    if (!mat) {
      console.warn(`[props] binToGroup: 缺少材质 key "${key}"（${name}），该组 ${list.length} 个构件被跳过`);
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
function makeInstancedMesh(geo, mat, list, name, { cast = false, receive = true } = {}) {
  const mesh = new THREE.InstancedMesh(geo, mat, list.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const v = new THREE.Vector3(), s = new THREE.Vector3();
  const c = new THREE.Color();
  list.forEach((t, i) => {
    e.set(t.rx || 0, t.ry || 0, t.rz || 0);
    q.setFromEuler(e);
    v.set(t.x, t.y, t.z);
    s.set(t.sx ?? t.s ?? 1, t.sy ?? t.s ?? 1, t.sz ?? t.s ?? 1);
    m.compose(v, q, s);
    mesh.setMatrixAt(i, m);
    if (t.color) mesh.setColorAt(i, c.set(t.color));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  if (!list.some((t) => t.color)) mesh.instanceColor = null;
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  mesh.name = name;
  return mesh;
}

/** 半圆劈裂圆木（劈开的柴：圆弧面 + 平面劈裂面 + 两端半圆） */
function splitLogGeometry(r, len) {
  const parts = [];
  const shell = new THREE.CylinderGeometry(r, r, len, 7, 1, true, 0, Math.PI);
  swapUV(shell);
  scaleUV(shell, len / 1.6, (Math.PI * r) / 0.5);
  parts.push(shell);
  const flat = new THREE.PlaneGeometry(2 * r, len);
  swapUV(flat);
  scaleUV(flat, len / 1.6, (2 * r) / 0.5);
  flat.rotateY(-Math.PI / 2);
  parts.push(flat);
  for (const sy of [1, -1]) {
    const cap = new THREE.CircleGeometry(r, 6, -Math.PI / 2, Math.PI);
    scaleUV(cap, r / 0.22, r / 0.22);
    cap.rotateX(sy > 0 ? -Math.PI / 2 : Math.PI / 2);
    cap.translate(0, (sy * len) / 2, 0);
    parts.push(cap);
  }
  const g = mergeGeoms(parts);
  g.rotateZ(Math.PI / 2);            // 轴线转到 X 向（便于堆柴）
  return g;
}

/* =========================================================================
 * 1. createProps
 * ========================================================================= */
export function createProps(opt = {}) {
  const quality = opt.quality || getQuality('high');
  const qKey = quality.key || opt.qualityKey || 'high';
  const isUltra = qKey === 'ultra';
  const isHigh = isUltra || qKey === 'high';
  const rng = makeRng(20251018);

  const group = new THREE.Group();
  group.name = 'props';

  /* ---- 木屋局部坐标 → 世界 ---- */
  const cosR = Math.cos(CABIN.rotation), sinR = Math.sin(CABIN.rotation);
  const yard = (lx, lz) => ({
    x: CABIN.center.x + lx * cosR + lz * sinR,
    z: CABIN.center.z - lx * sinR + lz * cosR,
  });
  const yardRot = (ry) => ry + CABIN.rotation;
  const gAt = (lx, lz) => {
    const p = yard(lx, lz);
    return { ...p, y: terrainHeight(p.x, p.z) };
  };

  /* ---- 材质库 ---- */
  const woodOpts = { base: PALETTE.log, dark: PALETTE.logDark, light: PALETTE.logLight, rings: 54 };
  const plankOpts = { base: PALETTE.logLight, dark: PALETTE.logDark, light: '#c8a672', boards: 8 };
  const plankFineOpts = { base: PALETTE.log, dark: PALETTE.logDark, light: PALETTE.logLight, boards: 16 };
  const stoneOpts = { base: PALETTE.stone, dark: PALETTE.stoneDark };
  const barkOpts = { base: PALETTE.soil, light: '#8a7360' };

  const texWood = getTexture('wood', woodOpts);
  const texPlanks = getTexture('planks', plankOpts);
  const texPlanksFine = getTexture('planks', plankFineOpts);
  const texStone = getTexture('stone', stoneOpts);
  const texBark = getTexture('bark', barkOpts);
  const texMetal = getTexture('metal');
  const texFabric = getTexture('fabric');
  const texShingle = getTexture('shingle', { base: PALETTE.roof, moss: PALETTE.roofMoss });
  const texLeaf = getTexture('leafCard', { color: PALETTE.pineLight, count: 58, leafScale: 0.85 });

  const NV = (x) => new THREE.Vector2(x, x);
  const materials = {
    log: new THREE.MeshStandardMaterial({
      map: texWood, normalMap: getNormal('wood', 1.5, woodOpts), normalScale: NV(0.6),
      vertexColors: true, roughness: 0.86, metalness: 0.0,
    }),
    plank: new THREE.MeshStandardMaterial({
      map: texPlanks, normalMap: getNormal('planks', 1.3, plankOpts), normalScale: NV(0.45),
      vertexColors: true, roughness: 0.79, metalness: 0.0,
    }),
    plankFine: new THREE.MeshStandardMaterial({
      map: texPlanksFine, normalMap: getNormal('planks', 1.3, plankFineOpts), normalScale: NV(0.4),
      vertexColors: true, roughness: 0.84, metalness: 0.0,
    }),
    stone: new THREE.MeshStandardMaterial({
      map: texStone, normalMap: getNormal('stone', 1.4, stoneOpts), normalScale: NV(0.55),
      vertexColors: true, roughness: 0.93, metalness: 0.02,
    }),
    soil: new THREE.MeshStandardMaterial({
      map: texBark, normalMap: getNormal('bark', 1.1, barkOpts), normalScale: NV(0.6),
      vertexColors: true, roughness: 0.97, metalness: 0.0,
    }),
    metal: new THREE.MeshStandardMaterial({
      map: texMetal, normalMap: getNormal('metal', 0.9), normalScale: NV(0.4),
      vertexColors: true, roughness: 0.44, metalness: 0.88,
    }),
    fabric: new THREE.MeshStandardMaterial({
      map: texFabric, vertexColors: true, roughness: 0.92, metalness: 0.0, side: THREE.DoubleSide,
    }),
    shingle: new THREE.MeshStandardMaterial({
      map: texShingle, normalMap: getNormal('shingle', 0.75, { base: PALETTE.roof, moss: PALETTE.roofMoss }),
      normalScale: NV(0.45), vertexColors: true, roughness: 0.88, metalness: 0.0,
    }),
    leaf: new THREE.MeshStandardMaterial({
      map: texLeaf, transparent: true, alphaTest: 0.42, side: THREE.DoubleSide,
      roughness: 0.8, metalness: 0.0, vertexColors: true,
    }),
    water: new THREE.MeshStandardMaterial({
      color: '#1d2733', roughness: 0.07, metalness: 0.25, transparent: true, opacity: 0.92,
      side: THREE.DoubleSide,
    }),
    crop: new THREE.MeshStandardMaterial({
      map: texLeaf, vertexColors: true, roughness: 0.76, metalness: 0.0,
    }),
    dark: new THREE.MeshStandardMaterial({
      color: '#100c09', roughness: 1.0, metalness: 0.0, side: THREE.DoubleSide,
    }),
    glow: new THREE.MeshStandardMaterial({
      color: new THREE.Color('#2a1a0c'), emissive: new THREE.Color(PALETTE.lampGlow),
      emissiveIntensity: 0.02, roughness: 0.55, metalness: 0.0,
    }),
    glass: new THREE.MeshStandardMaterial({
      color: PALETTE.glass, roughness: 0.10, metalness: 0.0, transparent: true, opacity: 0.5,
      side: THREE.DoubleSide, envMapIntensity: 1.3,
    }),
    cloth: null,        // 见下（需要 applyWindSway）
  };
  materials.cloth = new THREE.MeshStandardMaterial({
    map: texFabric, vertexColors: true, roughness: 0.93, metalness: 0.0, side: THREE.DoubleSide,
  });
  applyWindSway(materials.cloth, { strength: 0.085, speed: 1.15, height: 0.42, scale: 0.11, twist: 0.7, gust: 0.55 });

  const bMain = newBin();      // 只接收阴影（水井另开投影）
  const bWell = newBin();      // 水井：投影
  const bCloth = newBin();     // 晾晒衣物（风摆）
  const bLeaf = newBin();

  /* ---- 通用小件 ---- */
  function peg(bin, x, y, z, ry, len = 0.07) {
    boxAt(bin, 'plank', new THREE.Color(PALETTE.logDark), { w: 0.018, h: len, d: 0.018, x, y, z, ry, tile: 0.2 });
  }

  /* =====================================================================
   * 1.1 水井（石砌井圈 + 木架 + 辘轳 + 木桶 + 井盖）
   * ===================================================================== */
  const wellPos = gAt(-5.7, 6.3);
  {
    const wx = wellPos.x, wz = wellPos.z, y0 = wellPos.y - 0.06;
    const ry = yardRot(0.22);
    const R = 0.78;
    const t = (o) => ({ ...o, x: wx + (o.lx || 0) * Math.cos(ry) + (o.lz || 0) * Math.sin(ry), z: wz - (o.lx || 0) * Math.sin(ry) + (o.lz || 0) * Math.cos(ry) });
    // 井圈（八边形石砌）
    cylAt(bWell, 'stone', new THREE.Color(PALETTE.stone).multiplyScalar(0.88), {
      r: R, h: 0.66, seg: 8, x: wx, y: y0 + 0.33, z: wz, ry, tile: 0.6,
    });
    cylAt(bWell, 'stone', new THREE.Color(PALETTE.stone).multiplyScalar(1.0), {
      r: R + 0.07, h: 0.09, seg: 8, x: wx, y: y0 + 0.68, z: wz, ry, tile: 0.6,
    });
    // 井口内壁与井水暗面
    cylAt(bMain, 'dark', new THREE.Color('#0d0a07'), {
      r: R - 0.14, h: 0.62, seg: 10, open: true, x: wx, y: y0 + 0.32, z: wz, ry,
    });
    cylAt(bMain, 'water', _white, { r: R - 0.16, h: 0.03, seg: 10, x: wx, y: y0 + 0.10, z: wz, ry });
    // 木架两柱 + 顶梁 + 小披檐
    const p1 = t({ lx: -0.66, lz: 0 }), p2 = t({ lx: 0.66, lz: 0 });
    for (const p of [p1, p2]) {
      boxAt(bMain, 'plank', new THREE.Color(PALETTE.log).multiplyScalar(0.95), {
        w: 0.15, h: 2.05, d: 0.15, x: p.x, y: y0 + 1.02, z: p.z, ry, tile: 0.8,
      });
      boxAt(bMain, 'stone', new THREE.Color(PALETTE.stoneDark).multiplyScalar(1.02), {
        w: 0.30, h: 0.16, d: 0.30, x: p.x, y: y0 + 0.08, z: p.z, ry, tile: 0.4,
      });
    }
    boxAt(bMain, 'plank', new THREE.Color(PALETTE.logDark).multiplyScalar(1.1), {
      w: 1.9, h: 0.15, d: 0.16, x: wx, y: y0 + 2.06, z: wz, ry, tile: 0.8,
    });
    for (const sgn of [1, -1]) {
      boxAt(bMain, 'shingle', _white, {
        w: 1.95, h: 0.05, d: 0.62, x: wx, y: y0 + 2.24, z: wz + sgn * 0.24, rx: sgn * 0.42, ry, tX: 1.0, tZ: 0.7,
      });
    }
    boxAt(bMain, 'plank', new THREE.Color(PALETTE.logDark), {
      w: 2.0, h: 0.11, d: 0.06, x: wx, y: y0 + 2.14, z: wz + 0.42, ry, tile: 0.7,
    });
    // 辘轳（卷筒 + 曲柄 + 绳）
    const drum = t({ lx: 0, lz: 0 });
    cylAt(bMain, 'plank', new THREE.Color(PALETTE.logLight).multiplyScalar(0.94), {
      r: 0.10, h: 1.46, seg: 8, x: drum.x, y: y0 + 1.62, z: drum.z, rz: Math.PI / 2, ry, tile: 0.6,
    });
    for (const sgn of [1, -1]) {
      const e = t({ lx: sgn * 0.74, lz: 0 });
      cylAt(bMain, 'plank', new THREE.Color(PALETTE.logDark), { r: 0.13, h: 0.06, seg: 8, x: e.x, y: y0 + 1.62, z: e.z, rz: Math.PI / 2, ry, tile: 0.4 });
    }
    const crank = t({ lx: 0.86, lz: 0 });
    cylAt(bMain, 'metal', _white, { r: 0.020, h: 0.28, seg: 6, x: crank.x, y: y0 + 1.62, z: crank.z, rz: Math.PI / 2, ry, tile: 0.3 });
    cylAt(bMain, 'metal', _white, { r: 0.019, h: 0.30, seg: 6, x: crank.x, y: y0 + 1.48, z: crank.z, tile: 0.3 });
    cylAt(bMain, 'plank', new THREE.Color(PALETTE.logLight), { r: 0.035, h: 0.11, seg: 6, x: crank.x, y: y0 + 1.33, z: crank.z, tile: 0.3 });
    cylAt(bMain, 'metal', _white, { r: 0.012, h: 1.02, seg: 5, x: drum.x, y: y0 + 1.10, z: drum.z, tile: 0.25 });
    // 井盖（半掩，斜靠在井圈上）
    cylAt(bMain, 'plank', new THREE.Color(PALETTE.logDark).multiplyScalar(1.05), {
      r: R - 0.10, h: 0.06, seg: 8, x: wx + 0.16, y: y0 + 0.86, z: wz - 0.28, rx: 1.05, ry, tile: 0.5,
    });
    boxAt(bMain, 'plank', new THREE.Color(PALETTE.log), {
      w: R * 1.7, h: 0.04, d: 0.09, x: wx + 0.16, y: y0 + 0.80, z: wz - 0.30, rx: 1.05, ry, tile: 0.5,
    });
    // 木桶（带铁箍，吊在绳下）
    const bk = t({ lx: 0.0, lz: 0.30 });
    const bucketPts = [
      new THREE.Vector2(0.001, 0), new THREE.Vector2(0.14, 0), new THREE.Vector2(0.155, 0.06),
      new THREE.Vector2(0.15, 0.20), new THREE.Vector2(0.165, 0.28), new THREE.Vector2(0.155, 0.30),
    ];
    latheAt(bMain, 'plank', new THREE.Color(PALETTE.log).multiplyScalar(1.02), bucketPts, 10, {
      x: bk.x, y: y0 + 0.62, z: bk.z, ry, tile: 0.35,
    });
    for (const hy of [0.68, 0.86]) {
      cylAt(bMain, 'metal', _white, { r: 0.162, h: 0.028, seg: 10, x: bk.x, y: y0 + hy, z: bk.z, ry, tile: 0.3 });
    }
    cylAt(bMain, 'metal', _white, { r: 0.008, h: 0.18, seg: 4, x: bk.x, y: y0 + 0.99, z: bk.z, rz: Math.PI / 2, ry, tile: 0.2 });
    // 井边的水渍 + 苔藓（浅，避免在院子里形成深色斑块）
    planeAt(bMain, 'soil', new THREE.Color('#6b563d').multiplyScalar(0.95), {
      w: 1.7, h: 1.7, x: wx, y: y0 + 0.012, z: wz, rx: -Math.PI / 2, tile: 0.9,
    });
  }

  /* =====================================================================
   * 1.2 柴垛 + 劈柴墩 + 斧头
   * ===================================================================== */
  {
    const base = gAt(-6.5, -5.0);
    const ry = yardRot(0.55);
    const cy = Math.cos(ry), sy2 = Math.sin(ry);
    const cx = base.x, cz = base.z, gy = base.y - 0.04;
    const splits = [];
    const layers = [
      { y: 0.00, n: 11, spread: 2.05 },
      { y: 0.17, n: 10, spread: 1.90 },
      { y: 0.33, n: 8, spread: 1.62 },
    ];
    if (isUltra) layers.push({ y: 0.48, n: 6, spread: 1.30 });
    for (const L of layers) {
      for (let i = 0; i < L.n; i++) {
        const u = (i / (L.n - 1) - 0.5) * L.spread;
        const len = rng.range(0.62, 0.80);
        const rr = rng.range(0.055, 0.085);
        const roll = rng.range(0, TAU);
        const lx = u, lz = rng.range(-0.16, 0.16);
        splits.push({
          x: cx + lx * cy + lz * sy2,
          z: cz - lx * sy2 + lz * cy,
          y: gy + L.y + rr * 0.75,
          ry: ry + rng.range(-0.09, 0.09),
          rx: roll * 0.0,
          rz: rng.range(-0.05, 0.05),
          sx: len, sy: 1, sz: 1,
          color: new THREE.Color(PALETTE.log).multiplyScalar(rng.range(0.72, 1.06)),
        });
      }
    }
    // 散落在旁的几根
    for (let i = 0; i < 4; i++) {
      const p = gAt(-6.5 + rng.range(-1.4, 1.0), -5.0 + rng.range(0.9, 1.5));
      splits.push({
        x: p.x, z: p.z, y: p.y + 0.06, ry: yardRot(rng.range(0, TAU)),
        sx: rng.range(0.5, 0.74), sy: 1, sz: 1,
        color: new THREE.Color(PALETTE.log).multiplyScalar(rng.range(0.7, 1.0)),
      });
    }
    const splitGeo = splitLogGeometry(0.075, 1);
    const splitMesh = makeInstancedMesh(splitGeo, materials.log, splits, 'props:firewood', { cast: false, receive: true });
    group.add(splitMesh);
    // 立柱（两端挡柴的木桩）
    for (const sgn of [1, -1]) {
      const p = gAt(-6.5 + sgn * 1.35 * cy, -5.0 + sgn * 1.35 * sy2);
      boxAt(bMain, 'plank', new THREE.Color(PALETTE.logDark).multiplyScalar(1.05), {
        w: 0.11, h: 1.05, d: 0.11, x: p.x, y: p.y + 0.44, z: p.z, ry, rz: sgn * 0.04, tile: 0.6,
      });
    }
    // 劈柴墩
    const blk = gAt(-5.35, -4.15);
    cylAt(bMain, 'log', new THREE.Color(PALETTE.logDark).multiplyScalar(1.1), {
      r: 0.30, r2: 0.33, h: 0.56, seg: 11, x: blk.x, y: blk.y + 0.26, z: blk.z, tile: 1.2,
    });
    cylAt(bMain, 'log', new THREE.Color('#6b4c30'), { r: 0.29, h: 0.04, seg: 11, x: blk.x, y: blk.y + 0.55, z: blk.z, tile: 0.5 });
    // 斧头（插在墩上）
    const axRy = yardRot(-0.35);
    const axTilt = 0.30;
    cylAt(bMain, 'plank', new THREE.Color('#a5814f').multiplyScalar(0.95), {
      r: 0.024, r2: 0.020, h: 0.78, seg: 7,
      x: blk.x + 0.02, y: blk.y + 0.86, z: blk.z + 0.06, rz: axTilt, ry: axRy, tile: 0.8,
    });
    {
      // 斧头（楔形：用两个错开的盒子近似 + 刃口板）
      const hx = blk.x + 0.02 - Math.sin(axTilt) * 0.36, hy = blk.y + 0.52, hz = blk.z + 0.06;
      boxAt(bMain, 'metal', new THREE.Color(PALETTE.metal).multiplyScalar(0.92), {
        w: 0.075, h: 0.20, d: 0.14, x: hx, y: hy, z: hz, rz: axTilt, ry: axRy, tile: 0.3,
      });
      boxAt(bMain, 'metal', new THREE.Color('#b9b3a6'), {
        w: 0.022, h: 0.20, d: 0.20, x: hx - 0.05, y: hy, z: hz, rz: axTilt, ry: axRy, tile: 0.3,
      });
      boxAt(bMain, 'plank', new THREE.Color(PALETTE.log), {
        w: 0.055, h: 0.13, d: 0.10, x: hx + 0.09, y: hy - 0.02, z: hz, rz: axTilt, ry: axRy, tile: 0.4,
      });
    }
    // 木屑
    for (let i = 0; i < 9; i++) {
      const p = gAt(-5.6 + rng.range(-0.7, 0.7), -4.4 + rng.range(-0.4, 0.6));
      boxAt(bMain, 'plank', new THREE.Color(PALETTE.logLight).multiplyScalar(rng.range(0.8, 1.1)), {
        w: rng.range(0.05, 0.16), h: 0.018, d: rng.range(0.03, 0.08),
        x: p.x, y: p.y + 0.012, z: p.z, ry: yardRot(rng.range(0, TAU)), tile: 0.3,
      });
    }
  }

  /* =====================================================================
   * 1.3 分叉木栅栏（小径处留开口）
   * ===================================================================== */
  {
    // 院落轮廓（木屋局部坐标）；正面在 x∈[4.2,7.0] 留门
    const runs = [
      [[-8.6, -7.6], [8.6, -7.6]],
      [[8.6, -7.6], [8.6, 8.4]],
      [[8.6, 8.4], [7.0, 8.4]],
      [[4.2, 8.4], [-8.6, 8.4]],
      [[-8.6, 8.4], [-8.6, -7.6]],
    ];
    const posts = [];
    const rails = [];
    const seen = new Set();
    const postR = 0.075, railR = 0.042;
    const railHeights = [0.50, 0.95];
    for (const [A, B] of runs) {
      const wa = yard(A[0], A[1]), wb = yard(B[0], B[1]);
      const ya = terrainHeight(wa.x, wa.z), yb = terrainHeight(wb.x, wb.z);
      const len = Math.hypot(wb.x - wa.x, wb.z - wa.z);
      const n = Math.max(1, Math.round(len / 1.85));
      const heights = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const wx = lerp(wa.x, wb.x, t), wz = lerp(wa.z, wb.z, t);
        const gy = lerp(ya, yb, t) - 0.10;
        heights.push(gy);
        const key = `${Math.round(wx * 10)},${Math.round(wz * 10)}`;
        if (!seen.has(key)) {
          seen.add(key);
          const h = rng.range(1.22, 1.40);
          posts.push({
            x: wx, y: gy + h / 2, z: wz,
            ry: rng.range(0, TAU),
            rz: rng.range(-0.055, 0.055), rx: rng.range(-0.05, 0.05),
            sx: 1, sy: h / 1.3, sz: 1,
            color: new THREE.Color(PALETTE.logDark).multiplyScalar(rng.range(0.85, 1.15)),
          });
        }
      }
      // 每跨两根横杆（分叉状：端头略交叉）
      for (let i = 0; i < n; i++) {
        const t0 = i / n, t1 = (i + 1) / n;
        for (const rh of railHeights) {
          const jitter = rng.range(-0.05, 0.05);
          const ax = lerp(wa.x, wb.x, t0), az = lerp(wa.z, wb.z, t0);
          const bx = lerp(wa.x, wb.x, t1), bz = lerp(wa.z, wb.z, t1);
          const ay = heights[i] + rh + jitter, by = heights[i + 1] + rh + jitter;
          const dx = bx - ax, dy = by - ay, dz = bz - az;
          const l = Math.hypot(dx, dy, dz) + 0.16;
          rails.push({
            x: (ax + bx) / 2, y: (ay + by) / 2, z: (az + bz) / 2,
            ry: Math.atan2(-dz, dx), rz: Math.atan2(dy, Math.hypot(dx, dz)),
            sx: l, sy: 1, sz: 1,
            color: new THREE.Color(PALETTE.log).multiplyScalar(rng.range(0.8, 1.12)),
          });
        }
      }
    }
    const postGeo = new THREE.CylinderGeometry(0.062, postR, 1.3, 8, 1, false);
    scaleCylUV(postGeo, postR, 1.3, 0.8);
    setGeoColor(postGeo, _white);
    group.add(makeInstancedMesh(postGeo, materials.plank, posts, 'props:fencePosts'));
    const railGeo = new THREE.CylinderGeometry(railR, railR * 1.12, 1, 7, 1, false);
    railGeo.rotateZ(Math.PI / 2);
    scaleCylUV(railGeo, railR, 1, 0.9);
    setGeoColor(railGeo, _white);
    group.add(makeInstancedMesh(railGeo, materials.plank, rails, 'props:fenceRails'));
    // 门柱（加粗，带小斜撑）
    for (const gx of [4.2, 7.0]) {
      const p = gAt(gx, 8.4);
      boxAt(bMain, 'plank', new THREE.Color(PALETTE.logDark).multiplyScalar(1.12), {
        w: 0.15, h: 1.5, d: 0.15, x: p.x, y: p.y + 0.65, z: p.z, ry: yardRot(rng.range(-0.1, 0.1)), tile: 0.7,
      });
      for (const sgn of [-1, 1]) {
        boxAt(bMain, 'plank', new THREE.Color(PALETTE.log), {
          w: 0.055, h: 0.055, d: 0.68, x: p.x, y: p.y + 1.06, z: p.z + sgn * 0.26,
          ry: yardRot(sgn * 0.62), rz: 0.42, tile: 0.5,
        });
      }
    }
  }

  /* =====================================================================
   * 1.4 菜园（3 垄抬高菜畦 + 稻草人）
   * ===================================================================== */
  {
    const beds = [[6.3, -1.4], [6.3, -3.4], [6.3, -5.4]];
    const bedLen = 3.30, bedW = 1.20, bedH = 0.26;
    for (let bi = 0; bi < beds.length; bi++) {
      const [lx, lz] = beds[bi];
      const p = gAt(lx, lz);
      const ry = yardRot(rng.range(-0.05, 0.05));
      const gy = p.y - 0.02;
      // 木框（四块板，端头交错）
      for (const sgn of [1, -1]) {
        boxAt(bMain, 'plank', new THREE.Color(PALETTE.log).multiplyScalar(rng.range(0.88, 1.06)), {
          w: bedLen + 0.16, h: bedH, d: 0.07, x: p.x, y: gy + bedH / 2, z: p.z + sgn * bedW / 2, ry, tile: 1.2,
        });
      }
      for (const sgn of [1, -1]) {
        boxAt(bMain, 'plank', new THREE.Color(PALETTE.log).multiplyScalar(rng.range(0.85, 1.04)), {
          w: 0.07, h: bedH, d: bedW + 0.16, x: p.x + sgn * bedLen / 2, y: gy + bedH / 2, z: p.z, ry, tile: 1.2,
        });
      }
      // 土（略低于框沿）
      boxAt(bMain, 'soil', new THREE.Color(PALETTE.soil).multiplyScalar(1.15), {
        w: bedLen - 0.04, h: bedH, d: bedW - 0.04, x: p.x, y: gy + bedH / 2 - 0.03, z: p.z, ry, tile: 0.42,
      });
      // 作物：白菜 / 小苗 / 南瓜（按画质分级密度）
      const rows = isHigh ? 2 : 1, perRow = isUltra ? 4 : 3;
      for (let r = 0; r < rows; r++) {
        for (let k = 0; k < perRow; k++) {
          const u = (k + 0.5) / perRow - 0.5, v = (r + 0.5) / rows - 0.5;
          const lx2 = u * (bedLen - 0.5), lz2 = v * (bedW - 0.42);
          const wx = p.x + lx2 * cosR - lz2 * sinR;
          const wz = p.z + lx2 * sinR + lz2 * cosR;
          const kind = rng();
          if (kind < 0.42) {
            // 白菜：压扁的低面球（叶面贴图当作菜叶）
            const s = rng.range(0.10, 0.15);
            const g = new THREE.SphereGeometry(s, 7, 5);
            g.scale(1, 0.76, 1);
            g.translate(wx, gy + bedH - 0.02 + s * 0.6, wz);
            binPush(bMain, 'crop', setGeoColor(g, new THREE.Color(PALETTE.pineLight).multiplyScalar(rng.range(0.92, 1.28))));
          } else if (kind < 0.8) {
            // 小苗：3 片交叉叶卡
            for (let i = 0; i < 3; i++) {
              const lf = new THREE.PlaneGeometry(0.26, 0.26);
              place(bLeaf, 'leaf', lf, new THREE.Color(1, 1, 1).multiplyScalar(rng.range(0.85, 1.15)), {
                x: wx, y: gy + bedH + 0.06, z: wz,
                ry: yardRot((i / 3) * Math.PI + rng.range(-0.3, 0.3)), rx: rng.range(-0.25, 0.25),
              });
            }
          } else {
            // 南瓜
            const s = rng.range(0.13, 0.18);
            const g = new THREE.SphereGeometry(s, 8, 6);
            g.scale(1, 0.72, 1);
            g.translate(wx, gy + bedH - 0.02 + s * 0.55, wz);
            binPush(bMain, 'crop', setGeoColor(g, new THREE.Color('#b06a2a').multiplyScalar(rng.range(0.9, 1.1))));
          }
        }
      }
      // 垄间杂草
      for (let i = 0; i < 5; i++) {
        const lx2 = rng.range(-bedLen / 2 - 0.3, bedLen / 2 + 0.3);
        const lz2 = rng.range(-bedW / 2 - 0.42, bedW / 2 + 0.42);
        const wx = p.x + lx2 * cosR - lz2 * sinR;
        const wz = p.z + lx2 * sinR + lz2 * cosR;
        const lf = new THREE.PlaneGeometry(0.22, 0.22);
        place(bLeaf, 'leaf', lf, new THREE.Color('#7d8a48').multiplyScalar(rng.range(0.8, 1.1)), {
          x: wx, y: terrainHeight(wx, wz) + 0.10, z: wz, ry: yardRot(rng.range(0, TAU)),
        });
      }
    }
    // 稻草人
    const sc = gAt(5.15, -2.40);
    const ry = yardRot(-0.25);
    const gy = sc.y - 0.03;
    boxAt(bMain, 'plank', new THREE.Color('#7d6a4c').multiplyScalar(0.95), {
      w: 0.09, h: 2.05, d: 0.09, x: sc.x, y: gy + 1.00, z: sc.z, ry, rz: 0.02, tile: 0.6,
    });
    boxAt(bMain, 'plank', new THREE.Color('#7d6a4c').multiplyScalar(0.9), {
      w: 1.34, h: 0.075, d: 0.075, x: sc.x, y: gy + 1.46, z: sc.z, ry, rz: -0.07, tile: 0.6,
    });
    // 布衣
    boxAt(bMain, 'fabric', new THREE.Color('#8d6a4a'), {
      w: 0.62, h: 0.66, d: 0.30, x: sc.x, y: gy + 1.16, z: sc.z, ry, rx: 0.03, tile: 0.7,
    });
    boxAt(bMain, 'fabric', new THREE.Color('#9b7853'), {
      w: 0.42, h: 0.30, d: 0.26, x: sc.x, y: gy + 1.52, z: sc.z, ry, rz: -0.06, tile: 0.6,
    });
    // 稻草（袖口 / 下摆）
    const strawN = isUltra ? 18 : isHigh ? 14 : 8;
    for (let i = 0; i < strawN; i++) {
      const a = rng() * TAU;
      const rad = rng.range(0.16, 0.32);
      const pos = rng() < 0.5
        ? { x: sc.x + Math.cos(a) * rad * 1.9, y: gy + 1.36 + rng.range(-0.06, 0.06), z: sc.z + Math.sin(a) * rad * 0.5 }
        : { x: sc.x + Math.cos(a) * rad * 0.6, y: gy + 0.86 + rng.range(-0.05, 0.05), z: sc.z + Math.sin(a) * rad * 0.5 };
      cylAt(bMain, 'plank', new THREE.Color('#c2a35c').multiplyScalar(rng.range(0.8, 1.1)), {
        r: 0.008, h: rng.range(0.16, 0.30), seg: 4,
        x: pos.x, y: pos.y, z: pos.z, rx: rng.range(-0.5, 0.5) + 1.2, rz: rng.range(-0.5, 0.5), tile: 0.2,
      });
    }
    // 麻布头 + 草帽
    const headS = new THREE.SphereGeometry(0.145, 9, 7);
    headS.scale(1, 1.08, 1);
    headS.translate(sc.x, gy + 1.86, sc.z);
    binPush(bMain, 'fabric', setGeoColor(headS, new THREE.Color('#b39a6d').multiplyScalar(0.95)));
    const hatPts = [
      new THREE.Vector2(0.001, 0), new THREE.Vector2(0.30, 0.010), new THREE.Vector2(0.295, 0.028),
      new THREE.Vector2(0.20, 0.052), new THREE.Vector2(0.135, 0.13), new THREE.Vector2(0.11, 0.20),
    ];
    latheAt(bMain, 'plank', new THREE.Color('#c9ab63').multiplyScalar(0.95), hatPts, 12, {
      x: sc.x, y: gy + 1.95, z: sc.z, ry, rx: 0.06, tile: 0.35,
    });
  }

  /* =====================================================================
   * 1.5 独轮车 / 接雨水木桶 / 牛奶罐 / 信箱 / 鸟屋立杆
   * ===================================================================== */
  {
    // 独轮车
    const p = gAt(-6.2, 3.05);
    const ry = yardRot(-0.62);
    const gy = p.y - 0.02;
    const cyy = Math.cos(ry), syy = Math.sin(ry);
    const lx = (a, b) => ({ x: p.x + a * cyy + b * syy, z: p.z - a * syy + b * cyy });
    // 车斗（两块斜板 + 两端 + 底）
    for (const sgn of [1, -1]) {
      const c = lx(0, sgn * 0.30);
      boxAt(bMain, 'plank', new THREE.Color(PALETTE.logLight).multiplyScalar(0.9), {
        w: 1.05, h: 0.33, d: 0.05, x: c.x, y: gy + 0.62, z: c.z, ry, rx: sgn * 0.16, tile: 0.7,
      });
    }
    for (const sgn of [1, -1]) {
      const c = lx(sgn * 0.52, 0);
      boxAt(bMain, 'plank', new THREE.Color(PALETTE.log).multiplyScalar(0.92), {
        w: 0.05, h: 0.36, d: 0.60, x: c.x, y: gy + 0.62, z: c.z, ry, tX: 0.5, tY: 0.5, tZ: 0.6,
      });
    }
    boxAt(bMain, 'plank', new THREE.Color(PALETTE.logDark).multiplyScalar(1.05), {
      w: 1.06, h: 0.045, d: 0.56, x: p.x, y: gy + 0.46, z: p.z, ry, tile: 0.7,
    });
    // 把手
    for (const sgn of [1, -1]) {
      const a = lx(sgn * 0.34, 0), b = lx(sgn * 0.30, 1.12);
      const dx = b.x - a.x, dz = b.z - a.z, dy = 0.16;
      cylAt(bMain, 'plank', new THREE.Color('#a5814f'), {
        r: 0.028, h: Math.hypot(dx, dz) + 0.3, seg: 7,
        x: (a.x + b.x) / 2, y: gy + 0.60, z: (a.z + b.z) / 2,
        rz: Math.PI / 2 - Math.atan2(dy, Math.hypot(dx, dz)), ry: Math.atan2(-dz, dx), tile: 0.8,
      });
    }
    for (const sgn of [1, -1]) {
      const c = lx(sgn * 0.30, 0.96);
      cylAt(bMain, 'plank', new THREE.Color('#8a6b45'), { r: 0.026, h: 0.42, seg: 6, x: c.x, y: gy + 0.21, z: c.z, rz: 0.06 * sgn, tile: 0.5 });
    }
    // 轮子
    const wc = lx(-0.42, 0);
    const wheel = new THREE.CylinderGeometry(0.24, 0.24, 0.075, 14, 1, false);
    wheel.rotateZ(Math.PI / 2);
    wheel.translate(wc.x, gy + 0.24, wc.z);
    binPush(bMain, 'plank', setGeoColor(wheel, new THREE.Color(PALETTE.logDark).multiplyScalar(1.2)));
    cylAt(bMain, 'metal', _white, { r: 0.022, h: 0.42, seg: 6, x: wc.x, y: gy + 0.24, z: wc.z, rz: Math.PI / 2, ry, tile: 0.3 });
    // 车斗里的干草
    for (let i = 0; i < 8; i++) {
      const c = lx(rng.range(-0.42, 0.42), rng.range(-0.22, 0.22));
      cylAt(bMain, 'plank', new THREE.Color('#bfa259').multiplyScalar(rng.range(0.8, 1.05)), {
        r: 0.010, h: rng.range(0.18, 0.32), seg: 4, x: c.x, y: gy + 0.72, z: c.z,
        rx: rng.range(0.6, 1.5), rz: rng.range(-0.6, 0.6), tile: 0.2,
      });
    }
  }
  {
    // 接雨水的木桶（在木屋山墙檐下）
    const p = gAt(-4.52, 0.95);
    const gy = p.y - 0.02;
    const ry = yardRot(0.1);
    const pts = [
      new THREE.Vector2(0.001, 0), new THREE.Vector2(0.28, 0), new THREE.Vector2(0.30, 0.06),
      new THREE.Vector2(0.335, 0.26), new THREE.Vector2(0.335, 0.52), new THREE.Vector2(0.30, 0.72),
      new THREE.Vector2(0.295, 0.80), new THREE.Vector2(0.001, 0.80),
    ];
    latheAt(bMain, 'plank', new THREE.Color(PALETTE.log).multiplyScalar(0.92), pts, 14, {
      x: p.x, y: gy, z: p.z, ry, tile: 0.55,
    });
    for (const hy of [0.10, 0.36, 0.66]) {
      cylAt(bMain, 'metal', new THREE.Color(PALETTE.metal).multiplyScalar(0.85), {
        r: 0.335, h: 0.035, seg: 14, x: p.x, y: gy + hy, z: p.z, ry, tile: 0.4,
      });
    }
    // 水面（略有反射）
    cylAt(bMain, 'water', _white, { r: 0.315, h: 0.02, seg: 14, x: p.x, y: gy + 0.60, z: p.z, ry });
    // 桶盖（斜靠）
    cylAt(bMain, 'plank', new THREE.Color(PALETTE.logLight).multiplyScalar(0.9), {
      r: 0.30, h: 0.045, seg: 12, x: p.x + 0.42, y: gy + 0.16, z: p.z + 0.06, rx: 1.32, ry, tile: 0.5,
    });
    // 桶边水渍（浅）
    planeAt(bMain, 'soil', new THREE.Color('#5d4c38').multiplyScalar(0.95), {
      w: 0.75, h: 0.75, x: p.x, y: gy + 0.01, z: p.z, rx: -Math.PI / 2, tile: 0.6,
    });
  }
  {
    // 牛奶罐（镀锌铁皮）
    const p = gAt(2.95, 6.45);
    const gy = p.y - 0.01;
    const pts = [
      new THREE.Vector2(0.001, 0), new THREE.Vector2(0.115, 0), new THREE.Vector2(0.118, 0.05),
      new THREE.Vector2(0.105, 0.22), new THREE.Vector2(0.085, 0.30), new THREE.Vector2(0.082, 0.36),
      new THREE.Vector2(0.062, 0.40), new THREE.Vector2(0.062, 0.44), new THREE.Vector2(0.072, 0.46),
      new THREE.Vector2(0.001, 0.47),
    ];
    latheAt(bMain, 'metal', new THREE.Color('#8f8d86').multiplyScalar(0.95), pts, 12, { x: p.x, y: gy, z: p.z, ry: yardRot(0.6), tile: 0.4 });
    for (const hy of [0.16, 0.30]) {
      cylAt(bMain, 'metal', new THREE.Color('#6f6d67'), { r: 0.11, h: 0.02, seg: 12, x: p.x, y: gy + hy, z: p.z, ry: yardRot(0.6), tile: 0.3 });
    }
  }
  {
    // 信箱（门口小径旁）
    const p = gAt(7.15, 8.95);
    const gy = p.y - 0.03;
    const ry = yardRot(-0.5);
    boxAt(bMain, 'plank', new THREE.Color(PALETTE.logDark).multiplyScalar(1.05), {
      w: 0.10, h: 1.22, d: 0.10, x: p.x, y: gy + 0.61, z: p.z, ry, tile: 0.6,
    });
    boxAt(bMain, 'metal', new THREE.Color('#7d8a72').multiplyScalar(0.9), {
      w: 0.28, h: 0.20, d: 0.42, x: p.x, y: gy + 1.28, z: p.z, ry, tile: 0.35,
    });
    {
      const roof = new THREE.CylinderGeometry(0.145, 0.145, 0.42, 8, 1, false, 0, Math.PI);
      roof.rotateZ(Math.PI / 2);
      roof.rotateY(Math.PI / 2);
      roof.translate(p.x, gy + 1.38, p.z);
      binPush(bMain, 'metal', setGeoColor(roof, new THREE.Color('#8a9782').multiplyScalar(0.9)));
    }
    boxAt(bMain, 'metal', new THREE.Color('#5f6b58'), { w: 0.035, h: 0.16, d: 0.035, x: p.x + 0.16 * cosR, y: gy + 1.44, z: p.z - 0.16 * sinR, ry, tile: 0.25 });
    boxAt(bMain, 'plank', new THREE.Color('#7d6a4c'), { w: 0.03, h: 0.20, d: 0.10, x: p.x + 0.15, y: gy + 1.34, z: p.z - 0.22, ry, tile: 0.25 });
  }
  {
    // 鸟屋立杆
    const p = gAt(-3.45, 9.30);
    const gy = p.y - 0.05;
    const ry = yardRot(0.35);
    cylAt(bMain, 'plank', new THREE.Color(PALETTE.logDark).multiplyScalar(1.02), {
      r: 0.055, r2: 0.068, h: 3.15, seg: 8, x: p.x, y: gy + 1.55, z: p.z, ry, tile: 1.0,
    });
    boxAt(bMain, 'plank', new THREE.Color(PALETTE.log), { w: 0.30, h: 0.30, d: 0.26, x: p.x, y: gy + 3.18, z: p.z, ry, tile: 0.4 });
    for (const sgn of [1, -1]) {
      boxAt(bMain, 'shingle', _white, {
        w: 0.40, h: 0.035, d: 0.30, x: p.x, y: gy + 3.40, z: p.z + sgn * 0.12, rx: sgn * 0.55, ry, tX: 0.5, tZ: 0.4,
      });
    }
    cylAt(bMain, 'dark', new THREE.Color('#0f0c0a'), { r: 0.055, h: 0.04, seg: 8, x: p.x, y: gy + 3.20, z: p.z + 0.14 * cosR, rx: Math.PI / 2, ry, tile: 0.2 });
    cylAt(bMain, 'plank', new THREE.Color(PALETTE.logLight), { r: 0.012, h: 0.14, seg: 5, x: p.x, y: gy + 3.14, z: p.z + 0.20 * cosR, rx: Math.PI / 2, ry, tile: 0.2 });
  }

  /* =====================================================================
   * 1.6 靠墙的农具（锄头 / 耙子）
   * ===================================================================== */
  {
    /**
     * 靠墙斜放的农具：底端在地、顶端搭在木屋侧墙（lx=-3.89）上。
     * 圆柱沿 Y 轴 → 先绕 Z 俯仰、再绕 Y 偏航（与 place 的变换顺序一致）。
     */
    const leaningTool = (lz, isRake) => {
      const b = yard(-4.42, lz), t2 = yard(-3.94, lz + 0.06);
      const gy = terrainHeight(b.x, b.z) - 0.02;
      const topY = gy + (isRake ? 1.66 : 1.50);
      const dx = t2.x - b.x, dy = topY - gy, dz = t2.z - b.z;
      const len = Math.hypot(dx, dy, dz);
      const horiz = Math.hypot(dx, dz);
      const rz = Math.atan2(horiz, dy);
      const ry = Math.atan2(-dz, dx);
      cylAt(bMain, 'plank', new THREE.Color('#a5814f').multiplyScalar(rng.range(0.9, 1.06)), {
        r: 0.022, r2: 0.019, h: len, seg: 6,
        x: (b.x + t2.x) / 2, y: (gy + topY) / 2, z: (b.z + t2.z) / 2, rz, ry, tile: 0.9,
      });
      if (isRake) {
        // 耙头：横杆 + 一排齿
        const headC = yard(-4.36, lz + 0.02);
        boxAt(bMain, 'metal', new THREE.Color(PALETTE.metal).multiplyScalar(0.9), {
          w: 0.38, h: 0.035, d: 0.035, x: headC.x, y: gy + 0.10, z: headC.z,
          ry: yardRot(0.06), rz: rz * 0.28, tile: 0.25,
        });
        for (let i = 0; i < 7; i++) {
          const u = (i / 6 - 0.5) * 0.34;
          const q = yard(-4.36 + 0, lz + 0.02 + u);
          cylAt(bMain, 'metal', _white, {
            r: 0.009, h: 0.11, seg: 4, x: q.x, y: gy + 0.045, z: q.z, rz: Math.PI / 2 - 0.25, ry: yardRot(0.06), tile: 0.2,
          });
        }
      } else {
        // 锄头：柄端斜插的铁板
        const hc = yard(-4.34, lz + 0.02);
        boxAt(bMain, 'metal', new THREE.Color(PALETTE.metal).multiplyScalar(0.85), {
          w: 0.24, h: 0.17, d: 0.032, x: hc.x, y: gy + 0.13, z: hc.z,
          ry: yardRot(0.1), rz: 0.35, tile: 0.25,
        });
      }
    };
    leaningTool(2.35, false);
    leaningTool(1.45, true);
  }

  /* =====================================================================
   * 1.7 石头踏步（沿小径到门口）
   * ===================================================================== */
  {
    const stones = [];
    const lx0 = 0.25, lz0 = 6.45;
    const dirx = 0.62, dirz = 0.78;
    const nStones = isUltra ? 11 : isHigh ? 10 : 8;
    for (let i = 0; i < nStones; i++) {
      const t = i * 1.02;
      const lx = lx0 + dirx * t + Math.sin(i * 1.7) * 0.16;
      const lz = lz0 + dirz * t + Math.cos(i * 1.3) * 0.12;
      const p = yard(lx, lz);
      const near = pathNearest(p.x, p.z);
      // 贴着既有小径走（不越出路面）
      const wx = near.dist < 6 ? lerp(p.x, near.x, 0.35) : p.x;
      const wz = near.dist < 6 ? lerp(p.z, near.z, 0.35) : p.z;
      // 用 sampleTerrain 排除陡坡与池塘附近，避免踏步石悬空/落水
      const info = sampleTerrain(wx, wz);
      if (info.slope > 0.55) continue;
      if (info.pondDist < 14) continue;      // 池塘（24,-22）附近不放
      if (info.pathDist > 9) continue;       // 离小径太远则不成「踏步」
      const gy = info.y;
      stones.push({
        x: wx, y: gy - 0.035, z: wz,
        ry: rng.range(0, TAU),
        sx: rng.range(0.86, 1.18), sy: rng.range(0.7, 1.25), sz: rng.range(0.86, 1.18),
        color: new THREE.Color(PALETTE.stone).multiplyScalar(rng.range(0.78, 1.1)),
      });
    }
    const geo = new THREE.CylinderGeometry(0.30, 0.34, 0.10, 9, 1, false);
    scaleCylUV(geo, 0.32, 0.10, 0.5);
    setGeoColor(geo, _white);
    group.add(makeInstancedMesh(geo, materials.stone, stones, 'props:steppingStones'));
  }

  /* =====================================================================
   * 1.8 蜂箱（屋后）
   * ===================================================================== */
  {
    for (const [lx, lz, ry0] of [[-2.45, -6.55, 0.2], [-1.15, -6.85, -0.35]]) {
      const p = gAt(lx, lz);
      const gy = p.y - 0.03;
      const ry = yardRot(ry0);
      // 台架
      for (const sgn of [1, -1]) {
        boxAt(bMain, 'plank', new THREE.Color(PALETTE.logDark).multiplyScalar(1.1), {
          w: 0.08, h: 0.26, d: 0.08, x: p.x + sgn * 0.24 * cosR, y: gy + 0.13, z: p.z - sgn * 0.24 * sinR, ry, tile: 0.4,
        });
      }
      // 三层蜂箱体（奶白色，略脏）
      for (let i = 0; i < 3; i++) {
        boxAt(bMain, 'plank', new THREE.Color('#cfc6ae').multiplyScalar(rng.range(0.86, 1.02)), {
          w: 0.50, h: 0.24, d: 0.42, x: p.x, y: gy + 0.40 + i * 0.25, z: p.z, ry, tile: 0.6,
        });
        // 巢门缝
        boxAt(bMain, 'dark', new THREE.Color('#171310'), {
          w: 0.20, h: 0.02, d: 0.02, x: p.x + 0.05 * cosR, y: gy + 0.44 + i * 0.25, z: p.z + 0.21, ry, tile: 0.2,
        });
      }
      // 顶盖（带小坡）
      boxAt(bMain, 'plank', new THREE.Color('#b9ae94').multiplyScalar(0.95), {
        w: 0.56, h: 0.06, d: 0.48, x: p.x, y: gy + 1.16, z: p.z, ry, tile: 0.6,
      });
      for (const sgn of [1, -1]) {
        boxAt(bMain, 'shingle', _white, {
          w: 0.60, h: 0.03, d: 0.28, x: p.x, y: gy + 1.22, z: p.z + sgn * 0.12, rx: sgn * 0.35, ry, tX: 0.5, tZ: 0.4,
        });
      }
      // 蜂箱边的石头
      for (let i = 0; i < 3; i++) {
        const sp = gAt(lx + rng.range(-0.55, 0.55), lz + rng.range(0.4, 0.8));
        const sg = new THREE.DodecahedronGeometry(rng.range(0.07, 0.13), 0);
        sg.scale(1, 0.7, 1);
        sg.rotateY(rng() * TAU);
        sg.translate(sp.x, sp.y + 0.03, sp.z);
        binPush(bMain, 'stone', setGeoColor(sg, new THREE.Color(PALETTE.stoneDark).multiplyScalar(rng.range(0.9, 1.15))));
      }
    }
  }

  /* =====================================================================
   * 1.9 晾衣绳（布随风轻摆，用 applyWindSway）
   * ===================================================================== */
  const clothMeshes = [];
  {
    const A = gAt(-7.90, 1.10), B = gAt(-4.90, 1.40);
    const ry = Math.atan2(-(B.z - A.z), B.x - A.x);
    const yA = A.y + 1.86, yB = B.y + 1.82;
    for (const [p, h] of [[A, 2.05], [B, 2.02]]) {
      cylAt(bMain, 'plank', new THREE.Color(PALETTE.logDark).multiplyScalar(1.02), {
        r: 0.062, r2: 0.075, h, seg: 8, x: p.x, y: p.y + h / 2 - 0.1, z: p.z,
        rz: rng.range(-0.03, 0.03), tile: 1.0,
      });
    }
    // 绳（两段带垂度）
    {
      const seg = 6;
      for (let i = 0; i < seg; i++) {
        const t0 = i / seg, t1 = (i + 1) / seg;
        const sag0 = Math.sin(Math.PI * t0) * 0.10, sag1 = Math.sin(Math.PI * t1) * 0.10;
        const ax = lerp(A.x, B.x, t0), az = lerp(A.z, B.z, t0), ay = lerp(yA, yB, t0) - sag0;
        const bx = lerp(A.x, B.x, t1), bz = lerp(A.z, B.z, t1), by = lerp(yA, yB, t1) - sag1;
        const dx = bx - ax, dz = bz - az, dy = by - ay;
        cylAt(bMain, 'plank', new THREE.Color('#6d6353'), {
          r: 0.009, h: Math.hypot(dx, dy, dz), seg: 4,
          x: (ax + bx) / 2, y: (ay + by) / 2, z: (az + bz) / 2,
          rz: Math.PI / 2 - Math.atan2(-dy, Math.hypot(dx, dz)), ry: Math.atan2(-dz, dx), tile: 0.3,
        });
      }
    }
    // 晾晒的衣物：每个单独 mesh（风摆相位依赖物体世界坐标）
    const cloths = [
      { t: 0.16, w: 0.46, h: 0.52, c: '#c9b79b' },
      { t: 0.34, w: 0.34, h: 0.62, c: '#8f9c86' },
      { t: 0.52, w: 0.40, h: 0.44, c: '#b6a68e' },
      { t: 0.70, w: 0.52, h: 0.58, c: '#cfc0a6' },
      { t: 0.88, w: 0.30, h: 0.36, c: '#a3907a' },
    ];
    for (const c of (isHigh ? cloths : cloths.slice(0, 3))) {
      const wx = lerp(A.x, B.x, c.t), wz = lerp(A.z, B.z, c.t);
      const wy = lerp(yA, yB, c.t) - Math.sin(Math.PI * c.t) * 0.10;
      const g = new THREE.PlaneGeometry(c.w, c.h, 2, 3);
      scaleUV(g, 1.4, 1.4);
      // 让布料略微起皱
      const pp = g.attributes.position;
      for (let i = 0; i < pp.count; i++) {
        pp.setZ(i, Math.sin(pp.getX(i) * 12 + pp.getY(i) * 8) * 0.012);
      }
      pp.needsUpdate = true;
      g.computeVertexNormals();
      g.translate(0, c.h / 2, 0);
      g.rotateY(ry);
      setGeoColor(g, new THREE.Color(c.c).multiplyScalar(rng.range(0.85, 1.05)));
      const mesh = new THREE.Mesh(g, materials.cloth);
      mesh.name = 'props:cloth';
      // 旋转 180°：局部 +Y 指向下方 → 风摆幅度随「离绳子的距离」增大
      mesh.rotation.x = Math.PI;
      mesh.position.set(wx, wy, wz);
      group.add(mesh);
      clothMeshes.push(mesh);
      // 衣夹
      peg(bMain, wx, wy - 0.02, wz, ry);
    }
  }

  /* =====================================================================
   * 1.10 木柱灯笼（路边 3 盏，夜间暖光）
   * ===================================================================== */
  const lanterns = [];
  const swingNodes = [];
  const haloMat = new THREE.SpriteMaterial({
    map: getTexture('glow'), color: PALETTE.lampGlow, blending: THREE.AdditiveBlending,
    transparent: true, depthWrite: false, opacity: 0.3, fog: true,
  });
  {
    const spots = [
      { lx: 6.75, lz: 9.65, ry: -0.35 },     // 栅栏门口
      { lx: -5.05, lz: 7.95, ry: 0.55 },     // 井边
      { lx: -7.35, lz: -3.05, ry: 1.1 },     // 柴垛旁
    ];
    for (let i = 0; i < spots.length; i++) {
      const sp = spots[i];
      const p = gAt(sp.lx, sp.lz);
      const gy = p.y - 0.06;
      const ry = yardRot(sp.ry);
      const H = 2.42;
      // 立柱 + 底座 + 斜撑木臂
      boxAt(bMain, 'plank', new THREE.Color(PALETTE.log).multiplyScalar(0.92), {
        w: 0.13, h: H, d: 0.13, x: p.x, y: gy + H / 2, z: p.z, ry, tile: 1.0,
      });
      cylAt(bMain, 'stone', new THREE.Color(PALETTE.stoneDark).multiplyScalar(1.05), {
        r: 0.17, h: 0.16, seg: 8, x: p.x, y: gy + 0.08, z: p.z, ry, tile: 0.4,
      });
      const armX = p.x + Math.cos(ry) * 0.42, armZ = p.z - Math.sin(ry) * 0.42;
      boxAt(bMain, 'plank', new THREE.Color(PALETTE.logDark).multiplyScalar(1.05), {
        w: 0.60, h: 0.09, d: 0.09, x: (p.x + armX) / 2, y: gy + H - 0.06, z: (p.z + armZ) / 2, ry, rz: 0.16, tile: 0.6,
      });
      boxAt(bMain, 'plank', new THREE.Color(PALETTE.logDark), {
        w: 0.07, h: 0.07, d: 0.44, x: p.x + 0.16 * Math.cos(ry), y: gy + H - 0.34, z: p.z - 0.16 * Math.sin(ry),
        ry, rx: 0.6, tile: 0.5,
      });
      // 灯笼（吊在木臂端）
      const pivot = new THREE.Group();
      pivot.name = 'props:lanternPivot';
      pivot.position.set(armX, gy + H - 0.14, armZ);
      group.add(pivot);
      const pb = newBin();
      // 吊环
      const ring = new THREE.TorusGeometry(0.032, 0.008, 4, 8);
      ring.rotateY(Math.PI / 2);
      ring.translate(0, -0.055, 0);
      binPush(pb, 'metal', setGeoColor(ring, _white));
      // 灯体：四棱玻璃罩 + 金属框
      const lampH = 0.26;
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * TAU + Math.PI / 4;
        const px = Math.cos(a) * 0.075, pz = Math.sin(a) * 0.075;
        const bar = new THREE.BoxGeometry(0.014, lampH, 0.014);
        scaleBoxUV(bar, 0.014, lampH, 0.014, 0.2, 0.2, 0.2);
        bar.translate(px, -0.22, pz);
        binPush(pb, 'metal', setGeoColor(bar, _white));
      }
      const cap = new THREE.CylinderGeometry(0.045, 0.105, 0.07, 4, 1, false);
      cap.rotateY(Math.PI / 4);
      cap.translate(0, -0.085, 0);
      binPush(pb, 'metal', setGeoColor(cap, _white));
      const base = new THREE.CylinderGeometry(0.105, 0.085, 0.05, 4, 1, false);
      base.rotateY(Math.PI / 4);
      base.translate(0, -0.375, 0);
      binPush(pb, 'metal', setGeoColor(base, _white));
      pivot.add(binToGroup(pb, 'props:lanternFrame', materials, { cast: false, receive: false }));
      const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.082, 0.098, lampH, 4, 1, true), materials.glass);
      shade.rotation.y = Math.PI / 4;
      shade.position.set(0, -0.22, 0);
      shade.name = 'props:lanternGlass';
      pivot.add(shade);
      const core = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.20, 6), materials.glow);
      core.position.set(0, -0.22, 0);
      core.name = 'props:lanternCore';
      pivot.add(core);
      const halo = new THREE.Sprite(haloMat);
      halo.scale.set(1.35, 1.35, 1.35);
      halo.position.set(0, -0.22, 0);
      pivot.add(halo);
      const light = new THREE.PointLight(PALETTE.lampGlow, 0, 9, 2);
      light.position.set(0, -0.22, 0);
      light.castShadow = false;
      light.name = 'props:lampLight';
      pivot.add(light);
      lanterns.push({ mesh: core, light, halo, index: i });
      swingNodes.push({ node: pivot, amp: 0.045, speed: 1.1 + i * 0.13, phase: rng() * TAU, light, halo });
    }
  }

  /* =====================================================================
   * 1.11 组装
   * ===================================================================== */
  group.add(binToGroup(bMain, 'props:static', materials, { cast: false, receive: true }));
  group.add(binToGroup(bWell, 'props:well', materials, { cast: true, receive: true }));
  group.add(binToGroup(bLeaf, 'props:plants', materials, { cast: false, receive: false }));

  /* =====================================================================
   * 1.12 状态与每帧
   * ===================================================================== */
  let nightFactor = 0.26;
  let windStrength = 0.6;
  let windSpeed = 0.6;
  // 与 cabin 同一条"开灯"曲线：白天熄灭，黄金时刻开始点亮，深夜满亮
  const ember = () => smoothstep(0.05, 0.35, nightFactor);

  function setState(state) {
    if (!state) return;
    if (typeof state.nightFactor === 'number') nightFactor = state.nightFactor;
    if (state.wind) {
      if (typeof state.wind.strength === 'number') windStrength = state.wind.strength;
      if (typeof state.wind.speed === 'number') windSpeed = state.wind.speed;
    }
    const e = ember();
    materials.glow.emissiveIntensity = lerp(0.02, 2.8, e);
    haloMat.opacity = 0.03 + e * 0.62;
    for (const l of lanterns) if (l.light) l.light.intensity = e * 9.5;
  }

  function update(t, dt, state) {
    if (state) setState(state);
    const e = ember();
    const w = 0.4 + windStrength * 1.1;
    for (let i = 0; i < swingNodes.length; i++) {
      const s = swingNodes[i];
      s.node.rotation.z = Math.sin(t * s.speed * (0.6 + windSpeed) + s.phase) * s.amp * w;
      s.node.rotation.x = Math.cos(t * s.speed * 0.77 + s.phase * 1.4) * s.amp * 0.7 * w;
      if (s.light) s.light.intensity = e * 9.5 * (1 + Math.sin(t * 4.6 + s.phase) * 0.07);
    }
    // 晾晒衣物由 core 的 applyWindSway 驱动，这里只做整体轻微扭转
    for (let i = 0; i < clothMeshes.length; i++) {
      const m = clothMeshes[i];
      m.rotation.z = Math.sin(t * 0.9 + i) * 0.02 * w;
    }
    void dt;
  }

  let tris = 0, meshCount = 0;
  group.traverse((o) => {
    if (!o.isMesh && !o.isPoints) return;
    meshCount++;
    const g = o.geometry;
    const n = g.index ? g.index.count / 3 : (g.attributes.position?.count || 0) / 3;
    tris += n * (o.isInstancedMesh ? o.count : 1);
  });

  return {
    group,
    update,
    setState,
    lanterns,
    stats: { triangles: Math.round(tris), meshes: meshCount },
  };
}

export default createProps;
