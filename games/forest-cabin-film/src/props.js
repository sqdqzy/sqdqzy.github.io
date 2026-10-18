/**
 * props.js — 院落生活道具
 * ---------------------------------------------------------------
 * 这些东西不增加任何「 wow 」，但少了它们院子就是空的：
 * 分叉木栅栏、水井、柴垛与斧头、雨水桶、菜畦、稻草人、晾衣绳、信箱、树桩。
 */
import * as THREE from 'three';
import {
  CABIN, CLEARING, PALETTE, TAU, clamp, lerp, makeRng, fbm, asMultiplier,
  sampleTerrain, terrainHeight, texture, repeated, normalTex,
  mergeGeos, place, instanced,
} from './core.js';

export function createProps(opt = {}) {
  const group = new THREE.Group();
  group.name = 'props';
  const rng = makeRng(31337);
  const W = CABIN.width, D = CABIN.depth;
  const ground = (x, z) => terrainHeight(x, z);

  const M = {
    wood: new THREE.MeshStandardMaterial({
      map: repeated(texture('logs', { size: 512, seed: 9 }), 1, 1.6),
      normalMap: normalTex('logs', 1.1, { size: 512, seed: 9 }),
      normalScale: new THREE.Vector2(0.8, 0.8),
      color: 0xffffff,            // 贴图已带木色，材质色不再乘一遍 albedo
      roughness: 0.94, metalness: 0, vertexColors: true,
    }),
    plank: new THREE.MeshStandardMaterial({
      map: repeated(texture('planks', { size: 512, seed: 5, boards: 10 }), 1, 1),
      color: 0xffffff, roughness: 0.9, metalness: 0, vertexColors: true,
    }),
    metal: new THREE.MeshStandardMaterial({ color: '#5f5b56', roughness: 0.45, metalness: 0.8 }),
    stone: new THREE.MeshStandardMaterial({
      map: repeated(texture('stone', { size: 256, seed: 47 }), 1.2, 1.2),
      color: 0xffffff, roughness: 0.94, metalness: 0, vertexColors: true,
    }),
    fabric: new THREE.MeshStandardMaterial({
      color: '#d8cdb6', roughness: 0.95, metalness: 0, side: THREE.DoubleSide, vertexColors: true,
    }),
    dark: new THREE.MeshStandardMaterial({ color: '#2b1d10', roughness: 0.9, metalness: 0 }),
  };
  const NEEDS_COLOR = { wood: true, plank: true, stone: true, fabric: true };
  const bucket = { wood: [], plank: [], metal: [], stone: [], fabric: [], dark: [] };
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
  /** 顶点色一律写成乘子（基准 1.0），只保留色相倾向与明度微差 */
  const colored = (geo, hex, mul = 1) => {
    const n = geo.attributes.position.count;
    const c = asMultiplier(hex, mul, 0.3);
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return geo;
  };
  const box = (w, h, d, o = {}, hex = null, mul = 1) => {
    const g = place(new THREE.BoxGeometry(w, h, d), o);
    return hex ? colored(g, hex, mul) : g;
  };

  /* ------------------------------------------------------- 分叉木栅栏 */
  {
    const R = 15.2;
    const n = 74;
    const postList = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      // 正面（+Z，门所在的方向）留一个口子
      const da = Math.abs(((a - 0.66 + Math.PI * 3) % TAU) - Math.PI);
      if (da > 0.2) continue;
      const x = Math.cos(a) * R, z = Math.sin(a) * R;
      const y = ground(x, z);
      const h = 1.15 + rng() * 0.28;
      const lean = (rng() - 0.5) * 0.16;
      // 桩
      push('wood', colored(place(new THREE.CylinderGeometry(0.055, 0.075, h, 6), {
        x, y: y + h / 2 - 0.08, z, rx: lean, rz: (rng() - 0.5) * 0.14,
      }), PALETTE.log, 0.85 + rng() * 0.3));
      // 分叉的两根尖枝
      for (const s of [1, -1]) {
        push('wood', colored(place(new THREE.CylinderGeometry(0.022, 0.04, 0.42, 5), {
          x: x + (rng() - 0.5) * 0.06, y: y + h - 0.16, z,
          rx: lean + s * (0.25 + rng() * 0.2), rz: (rng() - 0.5) * 0.4,
        }), PALETTE.logDark, 0.9 + rng() * 0.3));
      }
      // 两道横枝
      for (const hgt of [0.42, 0.78]) {
        const nx = Math.cos(a + TAU / n) * R, nz = Math.sin(a + TAU / n) * R;
        const len = Math.hypot(nx - x, nz - z);
        const ang = Math.atan2(nz - z, nx - x);
        const mx = (x + nx) / 2, mz = (z + nz) / 2, my = (ground(x, z) + ground(nx, nz)) / 2;
        push('wood', colored(place(new THREE.CylinderGeometry(0.032, 0.038, len * 1.06, 5), {
          x: mx, y: my + hgt, z: mz, rz: Math.PI / 2, ry: -ang,
        }), PALETTE.logDark, 0.85 + rng() * 0.35));
      }
      postList.push(1);
    }
  }

  /* ------------------------------------------------------------- 水井 */
  {
    const wx = -6.4, wz = 7.2;
    const y = ground(wx, wz);
    for (let k = 0; k < 4; k++) {
      const ry = k * 0.4;
      for (let i = 0; i < 13; i++) {
        const a = (i / 13) * TAU;
        push('stone', box(0.32, 0.22, 0.46, {
          x: wx + Math.cos(a) * 0.92, y: y + 0.11 + k * 0.21, z: wz + Math.sin(a) * 0.92, ry: -a + Math.PI / 2,
        }, PALETTE.stone, 0.78 + rng() * 0.4));
      }
    }
    // 井口木架与滑轮
    for (const s of [-1, 1]) {
      push('wood', colored(place(new THREE.CylinderGeometry(0.07, 0.08, 2.0, 7), { x: wx + s * 0.95, y: y + 1.0, z: wz }), PALETTE.logDark));
    }
    push('wood', colored(place(new THREE.CylinderGeometry(0.055, 0.055, 2.1, 8), { x: wx, y: y + 1.92, z: wz, rz: Math.PI / 2 }), PALETTE.log));
    push('dark', place(new THREE.CylinderGeometry(0.004, 0.004, 1.3, 4), { x: wx, y: y + 1.3, z: wz }));
    push('wood', colored(place(new THREE.CylinderGeometry(0.11, 0.11, 0.34, 10), { x: wx, y: y + 1.86, z: wz, rz: Math.PI / 2 }), PALETTE.logDark));
    // 桶
    push('wood', colored(place(new THREE.CylinderGeometry(0.19, 0.16, 0.36, 12), { x: wx + 0.1, y: y + 0.2, z: wz + 0.7 }), PALETTE.log, 0.95));
    for (const yy of [y + 0.08, y + 0.32]) {
      push('metal', place(new THREE.TorusGeometry(0.18, 0.012, 5, 14), { x: wx + 0.1, y: yy, z: wz + 0.7, rx: Math.PI / 2 }));
    }
  }

  /* --------------------------------------------------------- 柴垛与斧头 */
  {
    const cx = W / 2 + 2.6, cz = 2.2;
    for (let row = 0; row < 4; row++) {
      for (let i = 0; i < 6 - row; i++) {
        const x = cx + (i - (5 - row) / 2) * 0.3 + (rng() - 0.5) * 0.04;
        const z = cz + (rng() - 0.5) * 0.5;
        const y = ground(cx, cz) + 0.15 + row * 0.28;
        push('wood', colored(place(new THREE.CylinderGeometry(0.135, 0.145, 1.5, 9), {
          x, y, z, rx: Math.PI / 2 + (rng() - 0.5) * 0.08, ry: (rng() - 0.5) * 0.16,
        }), PALETTE.log, 0.72 + rng() * 0.45));
      }
    }
    // 斧头
    push('metal', box(0.05, 0.16, 0.1, { x: cx + 1.0, y: ground(cx, cz) + 0.62, z: cz + 0.3 }));
    push('metal', place(new THREE.BoxGeometry(0.06, 0.26, 0.18), { x: cx + 1.05, y: ground(cx, cz) + 0.74, z: cz + 0.42, rz: 0.2 }));
  }

  /* ----------------------------------------------------------- 雨水桶 */
  {
    const bx = -W / 2 - 1.3, bz = 4.6;
    const y = ground(bx, bz);
    push('wood', colored(place(new THREE.CylinderGeometry(0.42, 0.38, 0.95, 14), { x: bx, y: y + 0.47, z: bz }), PALETTE.logDark, 1.0));
    for (const yy of [y + 0.16, y + 0.5, y + 0.84]) {
      push('metal', place(new THREE.TorusGeometry(0.41, 0.018, 5, 16), { x: bx, y: yy, z: bz, rx: Math.PI / 2 }));
    }
    // 檐沟与落水管
    push('dark', place(new THREE.CylinderGeometry(0.05, 0.05, 1.0, 8), { x: bx, y: y + 1.3, z: bz + 0.55 }));
    push('dark', place(new THREE.CylinderGeometry(0.05, 0.05, 0.8, 8), { x: bx, y: y + 1.9, z: bz + 0.2, rx: 0.7 }));
  }

  /* ------------------------------------------------------------- 菜畦 */
  {
    const gx = W / 2 + 3.4, gz = -2.6;
    for (let r = 0; r < 3; r++) {
      const z = gz + r * 1.15;
      for (let i = 0; i < 2; i++) {
        const x = gx + i * 1.3;
        const y = ground(x, z);
        push('dark', box(2.2, 0.1, 0.95, { x, y: y + 0.05, z }));
        // 菜苗：几片交叉的小面片
        for (let k = 0; k < 7; k++) {
          const px = x + (rng() - 0.5) * 1.9, pz = z + (rng() - 0.5) * 0.75;
          const py = ground(px, pz) + 0.1;
          const s = 0.16 + rng() * 0.16;
          push('fabric', colored(place(new THREE.PlaneGeometry(s * 1.6, s), {
            x: px, y: py + s * 0.5, z: pz, ry: rng() * TAU, rx: -0.3,
          }), '#6f8a3c', 0.8 + rng() * 0.5));
        }
      }
    }
  }

  /* ----------------------------------------------------------- 稻草人 */
  {
    const sx = -W / 2 - 3.0, sz = -1.2;
    const y = ground(sx, sz);
    push('wood', colored(place(new THREE.CylinderGeometry(0.055, 0.07, 2.0, 6), { x: sx, y: y + 1.0, z: sz, rz: 0.06 }), PALETTE.logDark));
    push('wood', colored(place(new THREE.CylinderGeometry(0.04, 0.04, 1.5, 5), { x: sx, y: y + 1.55, z: sz, rz: Math.PI / 2 + 0.1 }), PALETTE.logDark));
    push('fabric', colored(place(new THREE.CapsuleGeometry(0.22, 0.5, 4, 8), { x: sx, y: y + 1.55, z: sz }), '#a98a53'));
    push('fabric', colored(place(new THREE.SphereGeometry(0.24, 10, 8), { x: sx, y: y + 2.1, z: sz }), '#c4a468'));
    push('dark', place(new THREE.ConeGeometry(0.34, 0.16, 10), { x: sx, y: y + 2.28, z: sz }));
  }

  /* ----------------------------------------------------------- 晾衣绳 */
  {
    const ax = -3.2, az = 6.6, bx = 1.4, bz = 7.4;
    const ay = ground(ax, az) + 1.7, by = ground(bx, bz) + 1.7;
    push('wood', colored(place(new THREE.CylinderGeometry(0.05, 0.06, 1.8, 6), { x: ax, y: ground(ax, az) + 0.9, z: az }), PALETTE.logDark));
    push('wood', colored(place(new THREE.CylinderGeometry(0.05, 0.06, 1.8, 6), { x: bx, y: ground(bx, bz) + 0.9, z: bz }), PALETTE.logDark));
    const len = Math.hypot(bx - ax, bz - az);
    const sag = 0.16;
    push('dark', place(new THREE.CylinderGeometry(0.008, 0.008, len, 4), {
      x: (ax + bx) / 2, y: (ay + by) / 2 - sag, z: (az + bz) / 2,
      rz: Math.PI / 2, ry: -Math.atan2(bz - az, bx - ax),
    }));
    // 挂几件衣服
    const cloth = ['#cfc6b2', '#9fb0bd', '#b98f6d'];
    for (let i = 0; i < 3; i++) {
      const t = 0.28 + i * 0.22;
      const cx = lerp(ax, bx, t), cz = lerp(az, bz, t);
      const cy = lerp(ay, by, t) - sag * Math.sin(t * Math.PI);
      push('fabric', colored(place(new THREE.PlaneGeometry(0.62, 0.85), {
        x: cx, y: cy - 0.44, z: cz, ry: Math.atan2(bz - az, bx - ax) + Math.PI / 2,
      }), cloth[i], 0.9 + rng() * 0.2));
    }
  }

  /* ------------------------------------------------------------- 信箱 */
  {
    const mx = -W / 2 - 2.2, mz = D / 2 + 5.4;
    const y = ground(mx, mz);
    push('wood', colored(place(new THREE.BoxGeometry(0.09, 1.1, 0.09), { x: mx - 0.18, y: y + 0.55, z: mz }), PALETTE.logDark));
    push('wood', colored(place(new THREE.BoxGeometry(0.09, 1.1, 0.09), { x: mx + 0.18, y: y + 0.55, z: mz }), PALETTE.logDark));
    push('plank', colored(place(new THREE.BoxGeometry(0.52, 0.34, 0.42), { x: mx, y: y + 1.22, z: mz, rz: -0.04 }), PALETTE.logDark, 1.1));
    push('metal', place(new THREE.BoxGeometry(0.3, 0.03, 0.06), { x: mx, y: y + 1.42, z: mz + 0.16 }));
  }

  /* ------------------------------------------------------------- 树桩 */
  {
    const stumps = [[7.5, -5.5], [-8.2, -3.0], [5.0, 8.4], [-9.5, 5.0]];
    for (const [x, z] of stumps) {
      const y = ground(x, z);
      const h = 0.5 + rng() * 0.55;
      push('wood', colored(place(new THREE.CylinderGeometry(h * 0.95, h * 1.1, h, 10), { x, y: y + h / 2 - 0.06, z }), PALETTE.logDark, 0.8 + rng() * 0.4));
      push('wood', colored(place(new THREE.CylinderGeometry(h * 0.8, h * 0.9, 0.08, 10), { x, y: y + h - 0.02, z }), '#c8b184', 0.9));
    }
  }

  /* ---------------------------------------------------------- 合批输出 */
  for (const k of Object.keys(bucket)) {
    if (!bucket[k].length) continue;
    const mesh = new THREE.Mesh(mergeGeos(bucket[k]), M[k]);
    mesh.name = 'props:' + k;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  return { group };
}
