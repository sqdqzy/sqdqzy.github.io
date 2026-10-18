/**
 * cabin.js — 原木农舍本体
 * ---------------------------------------------------------------
 * 结构：石基 → 叠砌原木墙（转角交错咬合）→ 山墙板 → 木瓦屋顶（露椽头 + 封檐板）
 *      → 门 + 窗 + 门槛石 → 门廊（平台 / 立柱 / 车削栏杆 / 台阶）→ 石砌烟囱
 * 所有部件按材质合并，整栋房子只有 6 个 draw call。
 */
import * as THREE from 'three';
import {
  CABIN, CLEARING, PALETTE, TAU, clamp, lerp, makeRng, asMultiplier,
  texture, repeated, normalTex, mergeGeos, place,
} from './core.js';

const W = CABIN.width, D = CABIN.depth, H = CABIN.wallH;
const RISE = CABIN.roofPitch * (D / 2);
const EAVE = 0.34;              // 檐口比墙低一点点（滴水）
const OVER_Z = 0.72, OVER_X = 0.5;

export function createCabin(opt = {}) {
  const group = new THREE.Group();
  group.name = 'cabin';
  group.position.set(CABIN.center.x, CLEARING.height, CABIN.center.z);
  const rng = makeRng(9081);

  /* ------------------------------------------------------------- 材质 */
  const M = {
    log: new THREE.MeshStandardMaterial({
      // 每根原木单独取一段贴图，UV 沿长度方向只铺一次。
      // 之前 repeat(1, 2.4) 会让同一根木头上出现 2~3 条一模一样的"假板缝"，
      // 远看整面墙像贴了瓷砖。
      map: repeated(texture('logs', { size: 512, seed: 9 }), 1, 1),
      normalMap: normalTex('logs', 1.0, { size: 512, seed: 9 }),
      normalScale: new THREE.Vector2(0.55, 0.55),
      color: 0xffffff,            // 贴图本身已经是原木色，材质色不能再乘一遍 albedo
      roughness: 0.93, metalness: 0,
    }),
    plank: new THREE.MeshStandardMaterial({
      map: repeated(texture('planks', { size: 512, seed: 5, boards: 12 }), 1, 1),
      normalMap: normalTex('planks', 1.1, { size: 512, seed: 5, boards: 12 }),
      normalScale: new THREE.Vector2(0.7, 0.7),
      color: 0xffffff, roughness: 0.9, metalness: 0, vertexColors: true,
    }),
    shingle: new THREE.MeshStandardMaterial({
      map: repeated(texture('shingle', { size: 512, seed: 31 }), 5, 3.2),
      normalMap: repeated(normalTex('shingle', 1.4, { size: 512, seed: 31 }), 5, 3.2),
      normalScale: new THREE.Vector2(1.0, 1.0),
      color: 0xc9bcaf,
      roughness: 0.95, metalness: 0,
    }),
    stone: new THREE.MeshStandardMaterial({
      map: repeated(texture('stone', { size: 512, seed: 47 }), 1.4, 1.4),
      normalMap: repeated(normalTex('stone', 1.5, { size: 512, seed: 47 }), 1.4, 1.4),
      normalScale: new THREE.Vector2(1.1, 1.1),
      color: 0xffffff,
      roughness: 0.95, metalness: 0, vertexColors: true,
    }),
    glass: new THREE.MeshStandardMaterial({
      color: new THREE.Color('#20303a'),
      emissive: new THREE.Color(PALETTE.windowGlow),
      emissiveIntensity: 0.03,
      roughness: 0.18, metalness: 0.1,
      transparent: true, opacity: 0.92,
    }),
    dark: new THREE.MeshStandardMaterial({
      color: new THREE.Color('#241608'), roughness: 0.8, metalness: 0,
    }),
    metal: new THREE.MeshStandardMaterial({
      color: new THREE.Color('#6b6660'), roughness: 0.45, metalness: 0.75,
    }),
  };

  const bucket = { log: [], plank: [], shingle: [], stone: [], glass: [], dark: [], metal: [] };
  // 开了 vertexColors 的材质，几何体必须带 color 属性，否则着色器取不到会整块发黑
  const NEEDS_COLOR = { plank: true, stone: true };
  const push = (k, geo, fallback) => {
    if (!geo) return;
    if (NEEDS_COLOR[k] && !geo.attributes.color) {
      const n = geo.attributes.position.count;
      const arr = new Float32Array(n * 3);
      const c = fallback ? asMultiplier(fallback, 1, 0.3) : new THREE.Color(1, 1, 1);
      for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
      geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    }
    bucket[k].push(geo);
  };
  const tintCol = (hex, mul) => asMultiplier(hex, mul);
  /** 带顶点色的盒子。顶点色一律写成「乘子」——直接写 albedo 会把颜色乘两遍、整体压黑 */
  const box = (w, h, d, o = {}, col = null) => {
    const g = new THREE.BoxGeometry(w, h, d);
    if (col) {
      const n = g.attributes.position.count;
      const arr = new Float32Array(n * 3);
      const c = asMultiplier(col, 1, 0.3);
      for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    }
    return place(g, o);
  };

  /* ------------------------------------------------------------ 石基 */
  const baseH = 0.55;
  {
    // 干砌条石：一圈大小不一的石块，比一个光滑的盒子有信息量得多
    const courses = 3;
    for (let k = 0; k < courses; k++) {
      const y = 0.1 + k * (baseH / courses);
      for (const [len, cx, cz, ry] of [
        [W + 0.34, 0, D / 2 + 0.02, 0],
        [W + 0.34, 0, -D / 2 - 0.02, 0],
        [D + 0.34, W / 2 + 0.02, 0, Math.PI / 2],
        [D + 0.34, -W / 2 - 0.02, 0, Math.PI / 2],
      ]) {
        const n = Math.max(3, Math.round(len / 0.72));
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) / n - 0.5;
          const sw = (len / n) * (0.82 + rng() * 0.26);
          const g = new THREE.BoxGeometry(sw, (baseH / courses) * (0.82 + rng() * 0.2), 0.42 + rng() * 0.12);
          const px = cx + Math.cos(ry) * t * len, pz = cz + Math.sin(ry) * t * len;
          place(g, { x: px, y: y + (rng() - 0.5) * 0.03, z: pz, ry, rz: (rng() - 0.5) * 0.05 });
          const sh = 0.8 + rng() * 0.36;
          const n2 = g.attributes.position.count;
          const arr = new Float32Array(n2 * 3);
          for (let q = 0; q < n2; q++) { arr[q * 3] = sh; arr[q * 3 + 1] = sh; arr[q * 3 + 2] = sh; }
          g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
          push('stone', g);
        }
      }
    }
  }

  /* -------------------------------------------------------- 原木墙体 */
  const logR = 0.155;
  const logH = logR * 1.92;
  const rows = Math.floor((H - baseH) / logH);
  const y0 = baseH + logH * 0.5;
  const chimneyX = W / 2 + 0.12;   // 烟囱在 +X 山墙
  for (let i = 0; i < rows; i++) {
    const y = y0 + i * logH;
    const bulge = 1 + Math.sin(i * 2.3) * 0.012;
    const r = logR * (1 + (rng() - 0.5) * 0.07) * bulge;
    // 每根原木沿自身长度方向偏移 UV 的 v，让相邻木头不会用同一段纹理
    const uvShift = (geo, v) => {
      const uv = geo.attributes.uv;
      for (let k = 0; k < uv.count; k++) uv.setY(k, uv.getY(k) + v);
      uv.needsUpdate = true;
      return geo;
    };
    // 前后长墙
    for (const zs of [1, -1]) {
      push('log', uvShift(place(new THREE.CylinderGeometry(r, r * 0.97, W + 0.46, 10, 1), {
        x: 0, y, z: zs * (D / 2 - r * 0.35), rz: Math.PI / 2, rx: (rng() - 0.5) * 0.012,
      }), i * 0.37 + rng() * 0.2));
    }
    // 侧墙：逐层左右交替外伸，做出转角咬合
    const out = i % 2 === 0 ? 0.3 : 0.06;
    for (const xs of [1, -1]) {
      push('log', uvShift(place(new THREE.CylinderGeometry(r * 0.99, r, D - r * 0.4 + out, 9, 1), {
        x: xs * (W / 2 - r * 0.3), y, z: 0, rx: Math.PI / 2, rz: (rng() - 0.5) * 0.012,
      }), i * 0.61 + rng() * 0.25));
    }
  }
  const wallTop = y0 + (rows - 1) * logH + logR;

  /* ------------------------------------------------------------ 山墙 */
  // 屋脊沿 X，两端（x = ±W/2）是三角山墙，用竖向木板拼
  const gableRise = RISE;
  for (const xs of [1, -1]) {
    const n = 16;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const y = lerp(wallTop, wallTop + gableRise, t);
      const halfW = lerp(D / 2, 0.04, t);
      const g = new THREE.BoxGeometry(0.13, gableRise / n * 1.12, halfW * 2);
      place(g, { x: xs * (W / 2 - 0.06), y, z: 0 });
      const c = asMultiplier(PALETTE.logDark, 0.9 + rng() * 0.3, 0.3);
      const cnt = g.attributes.position.count;
      const arr = new Float32Array(cnt * 3);
      for (let q = 0; q < cnt; q++) { arr[q * 3] = c.r; arr[q * 3 + 1] = c.g; arr[q * 3 + 2] = c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      push('plank', g);
    }
    // 山墙封边（斜檐）
    for (const zs of [1, -1]) {
      const len = Math.hypot(gableRise, D / 2);
      push('plank', box(0.2, 0.16, len, {
        x: xs * (W / 2 + 0.02), y: wallTop + gableRise / 2, z: zs * D / 4,
        rx: zs * Math.atan2(gableRise, D / 2),
      }, new THREE.Color(PALETTE.logLight).multiplyScalar(0.8)));
    }
  }

  /* ------------------------------------------------------------ 屋顶 */
  const slopeLen = Math.hypot(D / 2 + OVER_Z, gableRise + EAVE);
  const pitch = Math.atan2(gableRise + EAVE, D / 2 + OVER_Z);
  for (const zs of [1, -1]) {
    push('shingle', place(new THREE.BoxGeometry(W + OVER_X * 2, 0.13, slopeLen), {
      y: wallTop - EAVE / 2 + gableRise / 2,
      z: zs * (slopeLen / 2) * Math.cos(pitch),
      rx: zs * pitch,
    }));
    // 封檐板
    push('plank', box(W + OVER_X * 2, 0.2, 0.09, {
      y: wallTop - EAVE, z: zs * (D / 2 + OVER_Z), rx: 0,
    }, new THREE.Color(PALETTE.logDark)));
    // 椽头
    const nR = 11;
    for (let i = 0; i <= nR; i++) {
      const x = lerp(-W / 2 - OVER_X * 0.7, W / 2 + OVER_X * 0.7, i / nR);
      push('dark', box(0.09, 0.11, 0.3, {
        x, y: wallTop - EAVE - 0.03, z: zs * (D / 2 + OVER_Z - 0.14),
      }));
    }
  }
  // 屋脊压条
  push('shingle', place(new THREE.BoxGeometry(W + OVER_X * 2.1, 0.2, 0.34), { y: wallTop + gableRise + 0.02 }));
  push('dark', box(W + OVER_X * 2.2, 0.07, 0.46, { y: wallTop + gableRise + 0.14 }));

  /* ---------------------------------------------------------- 门与窗 */
  const frontZ = D / 2 + logR * 0.3;
  const doorW = 1.12, doorH = 2.16;
  const doorX = -1.55;
  // 门套
  push('plank', box(doorW + 0.34, 0.16, 0.3, { x: doorX, y: baseH + doorH + 0.1, z: frontZ }, new THREE.Color(PALETTE.logLight)));
  for (const xs of [1, -1]) {
    push('plank', box(0.16, doorH + 0.2, 0.3, { x: doorX + xs * (doorW / 2 + 0.09), y: baseH + doorH / 2 + 0.1, z: frontZ }, new THREE.Color(PALETTE.logLight)));
  }
  // 门扇（竖板 + 横撑 + 铁铰链）
  for (let i = 0; i < 5; i++) {
    const w = doorW / 5;
    push('plank', box(w * 0.96, doorH, 0.09, { x: doorX - doorW / 2 + w * (i + 0.5), y: baseH + doorH / 2, z: frontZ + 0.06 },
      new THREE.Color(PALETTE.log).multiplyScalar(0.88 + rng() * 0.22)));
  }
  for (const y of [baseH + 0.42, baseH + doorH - 0.42]) {
    push('dark', box(doorW - 0.06, 0.13, 0.06, { x: doorX, y, z: frontZ + 0.12 }));
  }
  for (const y of [baseH + 0.5, baseH + doorH - 0.5]) {
    push('metal', box(0.3, 0.08, 0.035, { x: doorX - doorW / 2 + 0.16, y, z: frontZ + 0.13 }));
  }
  push('metal', place(new THREE.SphereGeometry(0.055, 10, 8), { x: doorX + doorW / 2 - 0.16, y: baseH + 1.06, z: frontZ + 0.14 }));
  // 门槛石
  push('stone', box(doorW + 0.5, 0.16, 0.7, { x: doorX, y: baseH - 0.06, z: frontZ + 0.35 },
    new THREE.Color(0.8).multiplyScalar(0.9)));

  const windows = [];
  const addWindow = (x, y, z, w, h, ry = 0) => {
    const t = 0.1;
    // 框
    push('plank', box(w + 0.26, 0.14, t + 0.06, { x, y: y + h / 2 + 0.06, z, ry }, new THREE.Color(PALETTE.logLight).multiplyScalar(0.92)));
    push('plank', box(w + 0.26, 0.14, t + 0.06, { x, y: y - h / 2 - 0.06, z, ry }, new THREE.Color(PALETTE.logLight).multiplyScalar(0.92)));
    for (const xs of [1, -1]) {
      push('plank', box(0.14, h + 0.24, t + 0.06, {
        x: x + Math.cos(ry) * xs * (w / 2 + 0.07),
        y, z: z + Math.sin(ry) * xs * (w / 2 + 0.07), ry,
      }, new THREE.Color(PALETTE.logLight).multiplyScalar(0.92)));
    }
    // 玻璃 + 窗棂
    push('glass', box(w, h, 0.04, { x, y, z, ry }));
    push('dark', box(0.05, h, 0.07, { x, y, z: z + 0.02, ry }));
    push('dark', box(w, 0.05, 0.07, { x, y, z: z + 0.02, ry }));
    windows.push({ x, y, z });
  };
  addWindow(1.25, baseH + 1.55, frontZ, 1.0, 1.0);
  addWindow(-W / 2 + 0.02, baseH + 1.5, 0.4, 1.15, 1.05, Math.PI / 2);
  addWindow(-W / 2 + 0.02, baseH + 1.5, -1.6, 1.15, 1.05, Math.PI / 2);

  /* ------------------------------------------------------------ 门廊 */
  const porchZ0 = frontZ + 0.1, porchZ1 = frontZ + 2.35;
  const porchX0 = doorX - 2.3, porchX1 = doorX + 2.6;
  const deckY = baseH - 0.06;
  // 平台：面板 + 龙骨
  {
    const n = 16;
    for (let i = 0; i < n; i++) {
      const w = (porchX1 - porchX0) / n;
      push('plank', box(w * 0.94, 0.07, porchZ1 - porchZ0, {
        x: lerp(porchX0, porchX1, (i + 0.5) / n), y: deckY, z: (porchZ0 + porchZ1) / 2,
      }, new THREE.Color(PALETTE.logLight).multiplyScalar(0.78 + rng() * 0.3)));
    }
    for (let i = 0; i < 5; i++) {
      const z = lerp(porchZ0 + 0.2, porchZ1 - 0.2, i / 4);
      push('dark', box(porchX1 - porchX0, 0.12, 0.1, { x: (porchX0 + porchX1) / 2, y: deckY - 0.09, z }));
    }
    push('dark', box(0.12, 0.45, porchZ1 - porchZ0, { x: porchX0 + 0.1, y: deckY - 0.3, z: (porchZ0 + porchZ1) / 2 }));
    push('dark', box(0.12, 0.45, porchZ1 - porchZ0, { x: porchX1 - 0.1, y: deckY - 0.3, z: (porchZ0 + porchZ1) / 2 }));
  }
  // 立柱
  const postH = 2.5;
  for (const [px, pz] of [[porchX0 + 0.22, porchZ1 - 0.22], [porchX1 - 0.22, porchZ1 - 0.22], [porchX1 - 0.22, porchZ0 + 0.3]]) {
    push('plank', place(new THREE.CylinderGeometry(0.1, 0.12, postH, 10), { x: px, y: deckY + postH / 2, z: pz },
    ));
    // 柱础与柱头
    push('stone', box(0.3, 0.16, 0.3, { x: px, y: deckY + 0.06, z: pz }, new THREE.Color(0.78)));
    push('dark', box(0.3, 0.12, 0.3, { x: px, y: deckY + postH - 0.06, z: pz }));
  }
  // 栏杆（车削立柱 + 上下横档）
  {
    const railY = deckY + 0.86;
    push('plank', box(porchX1 - porchX0, 0.1, 0.16, { x: (porchX0 + porchX1) / 2, y: railY, z: porchZ1 - 0.22 }, new THREE.Color(PALETTE.logLight).multiplyScalar(0.9)));
    push('plank', box(porchX1 - porchX0, 0.1, 0.16, { x: (porchX0 + porchX1) / 2, y: deckY + 0.14, z: porchZ1 - 0.22 }, new THREE.Color(PALETTE.logDark).multiplyScalar(1.1)));
    const n = 26;
    for (let i = 0; i <= n; i++) {
      const x = lerp(porchX0 + 0.2, porchX1 - 0.2, i / n);
      push('plank', place(new THREE.CylinderGeometry(0.028, 0.038, 0.7, 6), { x, y: deckY + 0.5, z: porchZ1 - 0.22 },
      ));
      push('plank', place(new THREE.SphereGeometry(0.055, 8, 6), { x, y: deckY + 0.85, z: porchZ1 - 0.22 }));
    }
    push('plank', box(0.16, 0.1, porchZ1 - porchZ0 - 0.1, { x: porchX1 - 0.22, y: railY, z: (porchZ0 + porchZ1) / 2 }, new THREE.Color(PALETTE.logLight).multiplyScalar(0.9)));
    push('plank', box(0.16, 0.1, porchZ1 - porchZ0 - 0.1, { x: porchX1 - 0.22, y: deckY + 0.14, z: (porchZ0 + porchZ1) / 2 }, new THREE.Color(PALETTE.logDark).multiplyScalar(1.1)));
    for (let i = 0; i <= 8; i++) {
      const z = lerp(porchZ0 + 0.45, porchZ1 - 0.3, i / 8);
      push('plank', place(new THREE.CylinderGeometry(0.028, 0.038, 0.7, 6), { x: porchX1 - 0.22, y: deckY + 0.5, z }));
    }
  }
  // 台阶
  for (let i = 0; i < 3; i++) {
    push('stone', box(1.7 - i * 0.14, 0.15, 0.36, {
      x: doorX, y: deckY - 0.1 - i * 0.16, z: porchZ1 + 0.2 + i * 0.34,
    }, new THREE.Color(0.85 - i * 0.06)));
  }
  // 廊檐
  push('shingle', place(new THREE.BoxGeometry(porchX1 - porchX0 + 0.5, 0.1, porchZ1 - porchZ0 + 0.5), {
    x: (porchX0 + porchX1) / 2, y: deckY + postH + 0.28, z: (porchZ0 + porchZ1) / 2,
    rx: -0.22,
  }));

  /* ------------------------------------------------------------ 烟囱 */
  const chimneyTop = wallTop + gableRise + 1.25;
  {
    const cw = 1.05, cd = 0.95;
    const levels = Math.round((chimneyTop - baseH) / 0.28);
    for (let i = 0; i < levels; i++) {
      const y = baseH + 0.14 + i * 0.28;
      const sh = 0.86 + rng() * 0.26;
      for (const [w, d, x, z] of [[cw, cd, 0, 0], [cw * 0.82, cd * 0.82, 0.02, 0.01]]) {
        const g = new THREE.BoxGeometry(w, 0.3, d);
        place(g, { x: chimneyX + x, y, z });
        const n = g.attributes.position.count;
        const arr = new Float32Array(n * 3);
        for (let q = 0; q < n; q++) { arr[q * 3] = sh; arr[q * 3 + 1] = sh; arr[q * 3 + 2] = sh; }
        g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
        push('stone', g);
      }
    }
    // 帽石
    push('stone', box(cw + 0.3, 0.16, cd + 0.3, { x: chimneyX, y: chimneyTop + 0.08 }, new THREE.Color(0.7)));
    push('dark', box(cw - 0.18, 0.3, cd - 0.18, { x: chimneyX, y: chimneyTop + 0.16 }));
  }

  /* --------------------------------------------------------- 合批输出 */
  const meshes = {};
  for (const k of Object.keys(bucket)) {
    if (!bucket[k].length) continue;
    const mesh = new THREE.Mesh(mergeGeos(bucket[k]), M[k]);
    mesh.name = 'cabin:' + k;
    mesh.castShadow = k !== 'glass';
    mesh.receiveShadow = true;
    group.add(mesh);
    meshes[k] = mesh;
  }

  /* ----------------------------------------------------------- 挂灯 */
  const lantern = new THREE.Group();
  {
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.17, 0.24, 0.17),
      new THREE.MeshStandardMaterial({
        color: '#3a2a16', emissive: new THREE.Color(PALETTE.lampGlow),
        emissiveIntensity: 0.05, roughness: 0.5, metalness: 0.2,
        transparent: true, opacity: 0.85,
      }),
    );
    const capTop = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.1, 4), new THREE.MeshStandardMaterial({ color: '#2a2a2c', roughness: 0.6, metalness: 0.5 }));
    capTop.position.y = 0.17;
    capTop.rotation.y = Math.PI / 4;
    const hook = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.012, 6, 10), new THREE.MeshStandardMaterial({ color: '#2a2a2c', metalness: 0.7, roughness: 0.5 }));
    hook.position.y = 0.26;
    lantern.add(body, capTop, hook);
  }
  lantern.position.set(doorX + 1.02, deckY + 1.86, porchZ1 - 0.34);
  group.add(lantern);
  const lampLight = new THREE.PointLight(new THREE.Color(PALETTE.lampGlow), 0, 7, 2);
  lampLight.position.copy(lantern.position);
  group.add(lampLight);

  /* ----------------------------------------------------------- 更新 */
  const winMat = M.glass;
  const lampMat = lantern.children[0].material;
  let flick = 0;

  function update(t, dt, state) {
    const n = clamp(state.night, 0, 1);
    // 灯焰轻微抖动：亮度随时间小幅摆动，比恒定发光像真的
    flick = 0.82 + Math.sin(t * 7.3) * 0.09 + Math.sin(t * 17.1) * 0.05 + Math.sin(t * 3.1) * 0.04;
    const lit = Math.pow(n, 1.3) * flick;
    winMat.emissiveIntensity = lerp(0.02, 2.4, Math.pow(n, 1.2));
    lampMat.emissiveIntensity = lerp(0.04, 3.2, lit);
    lampLight.intensity = lerp(0, 5.5, lit);
    lampLight.distance = 8;
  }

  return {
    group, update, meshes,
    chimneyTop: new THREE.Vector3(CABIN.center.x + chimneyX, CLEARING.height + chimneyTop + 0.2, CABIN.center.z),
    porch: { x: doorX, z: porchZ1, y: deckY },
    door: { x: doorX, z: frontZ },
  };
}
