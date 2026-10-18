/**
 * forest.js — 森林：针叶 / 白桦 / 阔叶 / 枯木 + 地被
 * ---------------------------------------------------------------
 * 两条硬性经验（都是踩过坑之后写进注释的）：
 *
 * 1) 「浅色细节贴图 × 白色材质 = 骨白色森林」。
 *    针叶贴图若画成浅色，反射率必须由 material.color 补回来，否则整片林子发白。
 *    本文件的针叶贴图本身是暗绿，材质色保持白色，两者只能有一个承担颜色。
 *
 * 2) 逆光透射不能只看「视线是否朝向太阳」——同一帧里全屏所有叶片的该项几乎相同，
 *    结果是树冠被刷成一块均匀奶油色。必须再乘上「这片叶子自己法线背对太阳的程度」，
 *    才有逐叶的斑驳感；强度也要压低，否则顺光面直接过曝。
 */
import * as THREE from 'three';
import {
  WORLD, CLEARING, POND, PATH, PALETTE,
  TAU, clamp, lerp, smoothstep, makeRng, fbm,
  terrainHeight, sampleTerrain, placement,
  texture, repeated, normalTex, instanced, mergeGeos, place, countTris,
  windMaterial,
} from './core.js';

/* ---------------------------------------------------- 逆光透射（共享） */
const _sunDir = { value: new THREE.Vector3(0.4, 0.3, 0.8) };
const _transAmt = { value: 0.16 };

function translucent(mat, hex = 0xffd2a0, { power = 2.4, wrap = 0.3, gain = 1 } = {}) {
  const col = new THREE.Color(hex);
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    shader.uniforms.uTrColor = { value: col };
    shader.uniforms.uTrAmt = _transAmt;
    shader.uniforms.uTrSun = _sunDir;
    shader.uniforms.uTrPow = { value: power };
    shader.uniforms.uTrWrap = { value: wrap };
    shader.uniforms.uTrGain = { value: gain };
    shader.vertexShader = 'varying vec3 vTwPos;\nvarying vec3 vTwNrm;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       {
         vec4 wp = vec4( transformed, 1.0 );
         #ifdef USE_INSTANCING
           wp = instanceMatrix * wp;
         #endif
         vTwPos = ( modelMatrix * wp ).xyz;
         #ifdef USE_INSTANCING
           vTwNrm = normalize( mat3( modelMatrix ) * mat3( instanceMatrix ) * objectNormal );
         #else
           vTwNrm = normalize( mat3( modelMatrix ) * objectNormal );
         #endif
       }`,
    );
    shader.fragmentShader = 'uniform vec3 uTrColor;\nuniform float uTrAmt;\nuniform vec3 uTrSun;\nuniform float uTrPow;\nuniform float uTrWrap;\nuniform float uTrGain;\nvarying vec3 vTwPos;\nvarying vec3 vTwNrm;\n'
      + shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           vec3 toFrag = normalize( vTwPos - cameraPosition );
           float w = dot( toFrag, uTrSun );
           float viewK = mix( pow( max( w, 0.0 ), uTrPow ), clamp( ( w + 0.5 ) / 1.5, 0.0, 1.0 ), uTrWrap );
           float leafK = clamp( -dot( normalize( vTwNrm ), uTrSun ) * 0.5 + 0.5, 0.0, 1.0 );
           leafK = leafK * leafK * ( 3.0 - 2.0 * leafK );
           totalEmissiveRadiance += uTrColor * ( viewK * leafK * uTrAmt * uTrGain );
         }`,
      );
  };
  return mat;
}

/* ------------------------------------------------------------ 几何构造 */

/** 云杉：分层的圆锥裙摆。逐层半径/高度/偏移都要抖，否则就是「纸板圣诞树」 */
function spruceGeo(rng, near) {
  const H = near ? 13.5 + rng() * 3.4 : 11 + rng() * 2.6;
  const seg = near ? 12 : 6;
  const trunkR = H * 0.016;
  const trunk = new THREE.CylinderGeometry(trunkR * 0.45, trunkR, H * 0.98, near ? 8 : 5, 1);
  place(trunk, { y: H * 0.49 });
  const parts = [];
  const layers = near ? 11 : 6;
  const baseY = H * 0.1;
  const span = H * 0.84;
  const spacing = span / layers;
  const baseR = H * (near ? 0.2 : 0.215);
  for (let i = 0; i < layers; i++) {
    const t = i / (layers - 1);
    const R = baseR * Math.pow(1 - t, 1.24) * (0.84 + rng() * 0.34) + H * 0.013;
    const lh = spacing * (1.45 + rng() * 0.6);
    // 每一层是「几簇下垂的针叶枝」而不是一整个圆锥裙摆。
    // 做法：3~5 个细长的锥体围成一圈，半径各不相同、略微下垂。
    // 单个圆锥一层 = 层叠蛋糕；一圈参差的细锥 = 有枝杈层次的针叶树。
    const fronds = near ? 5 : 3;
    for (let f = 0; f < fronds; f++) {
      const fa = (f / fronds) * TAU + rng() * 0.7;
      const fr = R * (0.62 + rng() * 0.42);
      const fh = lh * (0.8 + rng() * 0.5);
      const frond = new THREE.ConeGeometry(fr * (0.3 + rng() * 0.2), fh, near ? 5 : 3, 1, true);
      const pa = frond.attributes.position;
      for (let v = 0; v < pa.count; v++) {
        const py = pa.getY(v);
        // 底缘径向抖动 + 沿枝条下垂，轮廓才不是一条光滑的圆弧
        if (Math.abs(py) < fh * 0.5 - 1e-4) continue;
        const k = 1 + (rng() - 0.5) * (near ? 0.36 : 0.22);
        pa.setX(v, pa.getX(v) * k);
        pa.setZ(v, pa.getZ(v) * k);
      }
      frond.computeVertexNormals();
      place(frond, {
        x: Math.cos(fa) * fr * 0.72,
        y: baseY + i * spacing + fh * 0.42,
        z: Math.sin(fa) * fr * 0.72,
        rx: Math.sin(fa) * 0.26 + (rng() - 0.5) * 0.12,
        rz: -Math.cos(fa) * 0.26 + (rng() - 0.5) * 0.12,
        ry: rng() * TAU,
      });
      parts.push(frond);
    }
  }
  const tip = new THREE.ConeGeometry(baseR * 0.22, span * 0.26, seg, 1, true);
  place(tip, { y: H * 0.96 });
  parts.push(tip);
  return { trunk, foliage: mergeGeos(parts), h: H };
}

/** 松树：长裸干 + 顶部伞状层 */
function pineGeo(rng, near) {
  const H = near ? 12.5 + rng() * 3 : 10.5 + rng() * 2.4;
  const seg = near ? 12 : 6;
  const trunkR = H * 0.018;
  const bare = H * 0.58;
  const trunk = new THREE.CylinderGeometry(trunkR * 0.55, trunkR * 1.3, bare + H * 0.12, near ? 9 : 5, 1);
  place(trunk, { y: (bare + H * 0.12) / 2 });
  const top = new THREE.CylinderGeometry(trunkR * 0.26, trunkR * 0.6, H * 0.42, near ? 7 : 4, 1);
  place(top, { y: bare + H * 0.3 });
  const parts = [];
  const R = H * 0.25;
  const tiers = [[R, 0.0, 0.11], [R * 0.8, 0.095, 0.1], [R * 0.56, 0.19, 0.095], [R * 0.3, 0.275, 0.085]];
  for (const [r, y, h] of tiers) {
    const cone = new THREE.ConeGeometry(r * (0.92 + rng() * 0.16), H * h, seg, 1, true);
    place(cone, { y: bare + H * y + H * h * 0.5, ry: rng() * TAU, rx: (rng() - 0.5) * 0.08 });
    parts.push(cone);
  }
  return { trunk: mergeGeos([trunk, top]), foliage: mergeGeos(parts), h: H };
}

/** 白桦：白树干 + 稀疏散开的树冠（叶片卡片多而小才像叶子，少而大就是「撕破的纸」） */
function birchGeo(rng, near) {
  const H = near ? 11.5 + rng() * 3 : 9.5 + rng() * 2.6;
  const seg = near ? 8 : 5;
  const trunkR = H * 0.011;
  const parts = [];
  const t1 = new THREE.CylinderGeometry(trunkR * 0.78, trunkR * 1.4, H * 0.56, seg, 1);
  place(t1, { y: H * 0.28 });
  const t2 = new THREE.CylinderGeometry(trunkR * 0.46, trunkR * 0.84, H * 0.5, seg, 1);
  place(t2, { x: H * 0.02, z: -H * 0.012, y: H * 0.75, rz: -0.055, rx: 0.04 });
  parts.push(t1, t2);
  const cards = [];
  const n = near ? 46 : 12;
  const cw = H * (near ? 0.115 : 0.17);
  const cy = H * 0.79;
  const spread = H * 0.21;
  for (let i = 0; i < n; i++) {
    const a = i * 2.399963 + rng() * 0.6;
    const r = Math.pow(rng(), 0.62) * spread;
    const card = new THREE.PlaneGeometry(cw * (0.78 + rng() * 0.5), cw * (0.72 + rng() * 0.5));
    place(card, {
      x: Math.cos(a) * r,
      y: cy + (Math.pow(rng(), 0.8) - 0.34) * H * (near ? 0.26 : 0.22),
      z: Math.sin(a) * r,
      rx: (rng() - 0.5) * 1.15, ry: rng() * TAU, rz: (rng() - 0.5) * 1.15,
    });
    cards.push(card);
  }
  return { trunk: mergeGeos(parts), foliage: mergeGeos(cards), h: H };
}

/** 阔叶：圆顶树冠，外层剪影 + 内层体积 */
function broadleafGeo(rng, near) {
  const H = near ? 9.5 + rng() * 3.6 : 8 + rng() * 2.8;
  const seg = near ? 9 : 5;
  const trunkR = H * 0.031;
  const parts = [];
  const t = new THREE.CylinderGeometry(trunkR * 0.6, trunkR * 1.25, H * 0.54, seg, 1);
  place(t, { y: H * 0.27 });
  parts.push(t);
  const forks = near ? 4 : 2;
  for (let i = 0; i < forks; i++) {
    const a = (i / forks) * TAU + rng() * 0.8;
    const len = H * 0.4 * (0.85 + rng() * 0.3);
    const tilt = 0.6;
    const f = new THREE.CylinderGeometry(trunkR * 0.22, trunkR * 0.62, len, seg, 1);
    place(f, {
      x: Math.cos(a) * len * 0.34 * tilt, y: H * 0.5 + len * 0.42, z: Math.sin(a) * len * 0.34 * tilt,
      rz: -Math.cos(a) * tilt, rx: Math.sin(a) * tilt,
    });
    parts.push(f);
  }
  const cards = [];
  const n = near ? 64 : 17;
  const base = H * 0.63, rr = H * 0.34, cw = H * (near ? 0.155 : 0.21);
  for (let i = 0; i < n; i++) {
    const shell = i % 2 === 0 ? 1 : 0.66;
    const a = i * 2.399963 + rng() * 0.5;
    const el = Math.acos(1 - 1.35 * rng());
    const r = Math.pow(rng(), 0.5) * rr * shell;
    const card = new THREE.PlaneGeometry(cw * shell * (0.8 + rng() * 0.5), cw * shell * (0.72 + rng() * 0.5));
    place(card, {
      x: Math.cos(a) * Math.sin(el) * r,
      y: base + Math.cos(el) * r * 0.92,
      z: Math.sin(a) * Math.sin(el) * r,
      rx: (rng() - 0.5) * 1.2, ry: rng() * TAU, rz: (rng() - 0.5) * 1.2,
    });
    cards.push(card);
  }
  return { trunk: mergeGeos(parts), foliage: mergeGeos(cards), h: H };
}

/** 枯木：无叶的枯枝，前景叙事用 */
function deadGeo(rng) {
  const H = 6.5 + rng() * 4;
  const parts = [];
  const trunkR = H * 0.04;
  const t = new THREE.CylinderGeometry(trunkR * 0.45, trunkR * 1.5, H, 7, 1);
  place(t, { y: H * 0.5, rz: 0.1, rx: -0.05 });
  parts.push(t);
  for (let i = 0; i < 6; i++) {
    const a = rng() * TAU;
    const len = H * (0.14 + rng() * 0.22);
    const b = new THREE.CylinderGeometry(0.008, trunkR * 0.5, len, 3, 1, true);
    place(b, {
      x: Math.cos(a) * len * 0.45, y: H * (0.28 + rng() * 0.62), z: Math.sin(a) * len * 0.45,
      rz: -Math.cos(a) * (0.8 + rng() * 0.7), rx: Math.sin(a) * (0.8 + rng() * 0.7),
    });
    parts.push(b);
  }
  return { trunk: mergeGeos(parts), foliage: null, h: H };
}

/* ================================================================ 主入口 */
export function createForest(opt = {}) {
  const quality = opt.quality || {};
  const group = new THREE.Group();
  group.name = 'forest';
  const rng = makeRng(20261018);
  const windMats = [];

  /* ------------------------------------------------------------ 材质 */
  const needleMat = new THREE.MeshStandardMaterial({
    // 针叶贴图本身是暗绿 → 材质色保持白色（颜色只能由其中一个承担）
    map: repeated(texture('needle', { size: 256, seed: 31 }), 2.4, 2.2),
    normalMap: repeated(normalTex('needle', 0.7, { size: 256, seed: 31 }), 2.4, 2.2),
    normalScale: new THREE.Vector2(0.3, 0.3),
    color: 0xffffff, roughness: 0.92, metalness: 0, side: THREE.DoubleSide,
  });
  translucent(needleMat, 0xffd2a0, { power: 2.6, wrap: 0.28 });
  windMaterial(needleMat, { strength: 0.045, speed: 0.55, height: 16, twist: 0.4, gust: 0.4 });
  windMats.push(needleMat);

  const barkMat = new THREE.MeshStandardMaterial({
    map: repeated(texture('bark', { size: 512, seed: 11 }), 1.3, 2.6),
    normalMap: repeated(normalTex('bark', 1.3, { size: 512, seed: 11 }), 1.3, 2.6),
    normalScale: new THREE.Vector2(0.9, 0.9),
    color: 0xffffff, roughness: 0.95, metalness: 0,
  });
  // 树干也给一点透射：逆光时是暖色轮廓而不是纯黑剪影
  translucent(barkMat, 0xffc189, { power: 1.9, wrap: 0.45, gain: 0.32 });

  const birchMat = new THREE.MeshStandardMaterial({
    map: repeated(texture('birch', { size: 512, seed: 23 }), 1.3, 2.4),
    normalMap: repeated(normalTex('birch', 0.8, { size: 512, seed: 23 }), 1.3, 2.4),
    normalScale: new THREE.Vector2(0.55, 0.55),
    color: 0xffffff, roughness: 0.85, metalness: 0,
  });
  translucent(birchMat, 0xffe2b4, { power: 1.9, wrap: 0.45, gain: 0.36 });

  const leafBroadMat = new THREE.MeshStandardMaterial({
    map: texture('leafCard', { size: 256, color: '#5d7434', count: 190, seed: 8123 }),
    alphaTest: 0.34, side: THREE.DoubleSide, roughness: 0.9, metalness: 0, color: 0xffffff,
  });
  translucent(leafBroadMat, 0xffcf8e, { power: 2.4, wrap: 0.3 });
  windMaterial(leafBroadMat, { strength: 0.07, speed: 0.62, height: 7, twist: 0.5, gust: 0.45 });
  windMats.push(leafBroadMat);

  const leafBirchMat = new THREE.MeshStandardMaterial({
    map: texture('leafCard', { size: 256, color: '#7d8a3c', count: 155, seed: 3391 }),
    alphaTest: 0.32, side: THREE.DoubleSide, roughness: 0.9, metalness: 0, color: 0xffffff,
  });
  translucent(leafBirchMat, 0xffe0a8, { power: 2.2, wrap: 0.32 });
  windMaterial(leafBirchMat, { strength: 0.075, speed: 0.7, height: 10, twist: 0.5, gust: 0.5 });
  windMats.push(leafBirchMat);

  /* ------------------------------------------------------------ 摆放 */
  const slots = new Map();
  const slot = (k) => { let a = slots.get(k); if (!a) { a = []; slots.set(k, a); } return a; };
  const trees = [];      // 树冠圆柱，用于视线清理

  /** 逐实例乘子色（接近白，不是 albedo）：亮度 ±dl / 冷暖 ±dh。
   *  幅度不能太大 —— 超过 ±20% 整片林子会花成迷彩。 */
  function tint(dl = 0.11, dh = 0.03, ds = 0.06) {
    const m = 1 + (rng() - 0.5) * 2 * dl;
    const h = (rng() - 0.5) * 2 * (dh + ds);
    return new THREE.Color(
      clamp(m * (1 + h * 2.5), 0.5, 1.45),
      clamp(m, 0.5, 1.45),
      clamp(m * (1 - h * 2.5), 0.5, 1.45),
    );
  }

  const TYPES = [
    { key: 'spruce', w: 40, build: spruceGeo, trunk: 'bark' },
    { key: 'pine', w: 12, build: pineGeo, trunk: 'bark' },
    { key: 'birch', w: 18, build: birchGeo, trunk: 'birch' },
    { key: 'broad', w: 26, build: broadleafGeo, trunk: 'bark' },
    { key: 'dead', w: 4, build: deadGeo, trunk: 'bark' },
  ];
  const roll = [];
  for (const t of TYPES) for (let i = 0; i < t.w; i++) roll.push(t);

  const NEAR_D = 62;
  const geoCache = new Map();
  function geoFor(type, near) {
    const k = type.key + '|' + (near ? 'n' : 'f');
    let g = geoCache.get(k);
    if (!g) {
      g = type.build(rng, near);
      // 远模把树干并进树冠，白桦例外（白色树干是它的识别特征）
      if (!near && type.trunk !== 'birch' && g.foliage) g = { trunk: null, foliage: mergeGeos([g.trunk, g.foliage]), h: g.h };
      geoCache.set(k, g);
    }
    return g;
  }

  function addTree(x, z, type, near, extra = 1) {
    const s = sampleTerrain(x, z);
    const sc = (0.74 + rng() * 0.62) * extra;
    const lod = near ? 'n' : 'f';
    const base = {
      x, y: s.y - 0.1 * sc, z,
      ry: rng() * TAU, rx: (rng() - 0.5) * 0.12, rz: (rng() - 0.5) * 0.12,
      s: sc, sy: sc * (0.9 + rng() * 0.24), sz: sc * (0.94 + rng() * 0.12),
    };
    slot(`${type.key}|${lod}|foliage`).push({ ...base, color: tint(0.15, type.key === 'spruce' || type.key === 'pine' ? 0.055 : 0.03, type.key === 'spruce' || type.key === 'pine' ? 0.11 : 0.07) });
    if (near || type.trunk === 'birch') {
      slot(`${type.key}|${lod}|trunk`).push({ ...base, color: tint(0.11, 0.02, 0.05) });
    }
    // 记一份「树冠圆柱」，供 main.js 做视线清理（镜头不能怼进树里）
    const g = geoFor(type, near);
    const crownR = (type.key === 'spruce' || type.key === 'pine' ? 0.22 : 0.36) * (g.h || 12) * sc;
    trees.push({ x, z, base: s.y, top: s.y + (g.h || 12) * sc * 0.85, r: crownR });
  }

  // 密度场：林子要有疏密，不能像均匀撒的沙子
  function densityAt(x, z, s) {
    const clump = fbm(x * 0.014 + 11.3, z * 0.014 - 4.2, 3) * 0.5 + 0.5;
    let d = clamp(0.14 + clump * 1.2, 0, 1);
    d *= 1 - 0.5 * (1 - smoothstep(2.2, 8, s.pathDist));
    d *= 1 - 0.85 * (1 - smoothstep(POND.radius * 1.2, POND.radius * 2.6, s.pondDist));
    // 木屋正前方留一块「取景空地」，否则建立镜头永远被树堵住
    const ang = Math.atan2(x, z);
    const dA = Math.abs(((ang - 0.66 + Math.PI * 3) % TAU) - Math.PI);
    d *= 1 - 0.65 * (1 - smoothstep(0.16, 0.62, dA));
    return clamp(d, 0.02, 1);
  }

  const target = Math.round(1500 * (quality.treeDensity ?? 1));
  let placed = 0, tries = 0;
  while (placed < target && tries < target * 40) {
    tries++;
    const r = 15 + Math.sqrt(rng()) * (WORLD.treeFar - 15);
    const a = rng() * TAU;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const p = placement(x, z, 1.4);
    if (p.blocked) continue;
    if (rng() > densityAt(x, z, p) * 0.95) continue;
    const type = roll[Math.floor(rng() * roll.length)];
    if (type.key === 'dead' && rng() > 0.12) continue;
    addTree(x, z, type, p.cabinDist < NEAR_D);
    placed++;
  }

  // 林线：外圈一环低模树，把地平线封住，看不到世界边界
  {
    const wallCount = Math.round(520 * (quality.treeDensity ?? 1));
    const list = [];
    for (let i = 0; i < wallCount; i++) {
      const a = (i / wallCount) * TAU + (rng() - 0.5) * 0.02;
      const r = WORLD.treeFar + 4 + rng() * 16;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const s = sampleTerrain(x, z);
      const sc = 0.7 + rng() * 0.5;
      list.push({
        x, y: s.y - 0.2, z, ry: rng() * TAU, rx: (rng() - 0.5) * 0.1, rz: (rng() - 0.5) * 0.1,
        s: sc, sy: sc * (0.9 + rng() * 0.2), sz: sc, color: tint(0.16, 0.05, 0.1),
      });
    }
    // 林线用同一套针叶几何的极低模版本
    const low = spruceGeo(rng, false);
    const merged = mergeGeos([low.trunk, low.foliage]);
    group.add(instanced(merged, needleMat, list, { shadows: false, receive: false, name: 'forest-treeline', pad: 1 }));
  }

  /* ---------------------------------------------- 生成各类树的 InstancedMesh */
  const MATS = { bark: barkMat, birch: birchMat };
  for (const [k, list] of slots) {
    const [typeKey, lod, part] = k.split('|');
    const type = TYPES.find((t) => t.key === typeKey);
    const g = geoFor(type, lod === 'n');
    const geo = part === 'foliage' ? g.foliage : g.trunk;
    if (!geo || !list.length) continue;
    const mat = part === 'foliage'
      ? (typeKey === 'birch' ? leafBirchMat : (typeKey === 'broad' ? leafBroadMat : needleMat))
      : MATS[type.trunk];
    const mesh = instanced(geo, mat, list, {
      shadows: lod === 'n',
      receive: true,
      name: `forest:${typeKey}:${lod}:${part}`,
    });
    group.add(mesh);
  }

  /* ---------------------------------------------------------- 地被层 */
  const grassMat = new THREE.MeshStandardMaterial({
    map: texture('grassCard', { size: 256, seed: 77 }),
    alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.92, metalness: 0, color: 0xffffff,
  });
  translucent(grassMat, 0xd8e08a, { power: 2.0, wrap: 0.4, gain: 0.7 });
  windMaterial(grassMat, { strength: 0.045, speed: 1.1, height: 0.7, twist: 0.35, gust: 0.55 });
  windMats.push(grassMat);

  // 一丛草 = 5 片交叉的叶面，围成一个半球。单片交叉是「十字纸片」，
  // 侧看只剩一条线；多片半包围才有蓬松的体积感。
  const GW = 0.62, GH = 0.6;
  const grassParts = [];
  for (let k = 0; k < 5; k++) {
    const ka = (k / 5) * TAU + rng() * 0.6;
    const leaf = new THREE.PlaneGeometry(GW * (0.72 + rng() * 0.4), GH * (0.6 + rng() * 0.5));
    place(leaf, {
      x: Math.cos(ka) * GW * 0.3,
      y: GH * (0.32 + rng() * 0.14),
      z: Math.sin(ka) * GW * 0.3,
      ry: ka,
      rx: (rng() - 0.5) * 0.45,
      rz: (rng() - 0.5) * 0.45,
    });
    grassParts.push(leaf);
  }
  const grassGeo = mergeGeos(grassParts);
  const grassList = [];
  const gTarget = Math.round(62000 * (quality.grassDensity ?? 1));
  // 草只铺在相机真正看得见的 9~33m。同样数量的实例摊到 50m 外，
  // 每平米只剩两三根，远看就是「绿毯上撒了几根毛」。
  for (let i = 0; i < gTarget * 3.2 && grassList.length < gTarget; i++) {
    const r = 9 + Math.sqrt(rng()) * 24;
    const a = rng() * TAU;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const p = placement(x, z, 0.3);
    if (p.blocked) continue;
    const clump = fbm(x * 0.11 + 41.5, z * 0.11 - 17.3, 2) * 0.5 + 0.5;
    if (rng() > 0.2 + clump * 0.95) continue;
    const sc = 0.65 + rng() * 1.0;
    grassList.push({
      x, y: p.y - 0.03, z, ry: rng() * TAU, rz: (rng() - 0.5) * 0.2,
      s: sc, sy: sc * (0.8 + rng() * 0.6),
      color: tint(0.2, 0.035, 0.09),
    });
  }
  // 院子里的草：placement() 会把 clearing 整个排掉，正面机位的前景就没草了。
  // 这里单独补一层，只避开门前石阶、小径与水面。
  const yardTarget = Math.round(5000 * (quality.grassDensity ?? 1));
  for (let i = 0; i < yardTarget * 10 && grassList.length < gTarget + yardTarget; i++) {
    const a = rng() * TAU;
    const r = 5.5 + Math.sqrt(rng()) * 16;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const s = sampleTerrain(x, z);
    if (s.pathDist < PATH.halfWidth + 0.7) continue;
    if (s.pondDist < POND.radius * 2.2) continue;
    if (s.slope > 0.36) continue;
    const patch = fbm(x * 0.29 + 7.7, z * 0.29 - 2.4, 2) * 0.5 + 0.5;
    if (rng() > patch * patch * 1.2) continue;
    const sc = 0.38 + rng() * 0.6;
    grassList.push({
      x, y: s.y - 0.02, z, ry: rng() * TAU, rz: (rng() - 0.5) * 0.22,
      s: sc, sy: sc * (0.75 + rng() * 0.55),
      color: tint(0.2, 0.035, 0.09),
    });
  }
  group.add(instanced(grassGeo, grassMat, grassList, { shadows: false, receive: true, name: 'forest:grass', pad: 2 }));

  /* 灌木：用同一个叶簇卡片，只是排得更矮更密 */
  const shrubMat = new THREE.MeshStandardMaterial({
    map: texture('leafCard', { size: 256, color: '#4f6630', count: 150, seed: 515 }),
    alphaTest: 0.34, side: THREE.DoubleSide, roughness: 0.92, metalness: 0, color: 0xffffff,
  });
  translucent(shrubMat, 0xd2dc80, { power: 2.2, wrap: 0.35, gain: 0.8 });
  windMaterial(shrubMat, { strength: 0.05, speed: 1.0, height: 2.2, twist: 0.4, gust: 0.5 });
  windMats.push(shrubMat);
  const shrubParts = [];
  const SW = 1.05;
  for (let i = 0; i < 7; i++) {
    const a = i * 2.399963, r = Math.pow(rng(), 0.6) * SW * 0.45;
    const card = new THREE.PlaneGeometry(SW * (0.7 + rng() * 0.5), SW * (0.62 + rng() * 0.45));
    place(card, {
      x: Math.cos(a) * r, y: SW * (0.3 + rng() * 0.4), z: Math.sin(a) * r,
      rx: (rng() - 0.5) * 0.7, ry: rng() * TAU, rz: (rng() - 0.5) * 0.7,
    });
    shrubParts.push(card);
  }
  const shrubGeo = mergeGeos(shrubParts);
  const shrubList = [];
  for (let i = 0; i < 26000 && shrubList.length < 1400; i++) {
    const r = 14 + Math.sqrt(rng()) * 58;
    const a = rng() * TAU;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const p = placement(x, z, 0.6);
    if (p.blocked) continue;
    const clump = fbm(x * 0.06 + 22.2, z * 0.06 - 5.5, 3) * 0.5 + 0.5;
    if (rng() > clump * clump * 1.35) continue;
    const sc = 0.55 + rng() * 0.95;
    shrubList.push({
      x, y: p.y - 0.08, z, ry: rng() * TAU,
      s: sc, sy: sc * (0.7 + rng() * 0.5), sz: sc,
      color: tint(0.17, 0.04, 0.09),
    });
  }
  group.add(instanced(shrubGeo, shrubMat, shrubList, { shadows: false, receive: true, name: 'forest:shrubs', pad: 1.5 }));

  /* 岩石 */
  const rockMat = new THREE.MeshStandardMaterial({
    map: repeated(texture('stone', { size: 256, seed: 47 }), 1, 1),
    normalMap: normalTex('stone', 1.4, { size: 256, seed: 47 }),
    normalScale: new THREE.Vector2(1.0, 1.0),
    color: 0x8a8579, roughness: 0.95, metalness: 0, vertexColors: true,
  });
  const rockBase = new THREE.IcosahedronGeometry(1, 1);
  {
    const p = rockBase.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).normalize();
      const d = 1 + fbm(v.x * 2.4 + v.z * 1.7, v.y * 2.1 - v.x, 3) * 0.3;
      p.setXYZ(i, v.x * d, v.y * d * 0.72, v.z * d);
    }
    rockBase.computeVertexNormals();
    const n = rockBase.attributes.position.count;
    const arr = new Float32Array(n * 3).fill(1);
    rockBase.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  }
  const rockList = [];
  for (let i = 0; i < 5200 && rockList.length < 260; i++) {
    const r = 16 + Math.sqrt(rng()) * 64;
    const a = rng() * TAU;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const p = placement(x, z, 0.5);
    if (p.blocked) continue;
    const sc = 0.22 + Math.pow(rng(), 2) * 1.5;
    const c = new THREE.Color().setScalar(0.62 + rng() * 0.55);
    rockList.push({
      x, y: p.y - sc * 0.28, z,
      ry: rng() * TAU, rx: (rng() - 0.5) * 0.5, rz: (rng() - 0.5) * 0.5,
      s: sc, sy: sc * (0.6 + rng() * 0.5), sz: sc * (0.8 + rng() * 0.5), color: c,
    });
  }
  group.add(instanced(rockBase, rockMat, rockList, { shadows: true, receive: true, name: 'forest:rocks' }));

  /* ---------------------------------------------------------- 更新 */
  let time = 0;
  function update(t, dt, state) {
    time = t;
    _sunDir.value.copy(state.sunDirection);
    _transAmt.value = 0.16 * (1 - state.night * 0.9) + state.night * 0.03;
  }

  return {
    group, update, windMats, trees,
    count: placed,
    grass: grassList.length,
    triangles: countTris(group),
  };
}
