/**
 * particles.js — 氛围粒子（尘埃 / 花粉 / 落叶 / 萤火虫 / 星空 / 飞鸟 / 地面薄雾）
 * ---------------------------------------------------------------------------
 * 设计要点：
 *   1. 所有粒子都在「相机周围」循环复用（离开盒子就从对侧回收），任何镜头都有氛围；
 *   2. 每一类都按 state.particles.* 做 material.opacity 平滑淡入淡出，量为 0 时 visible=false 省 draw call；
 *   3. 每帧不 new 任何对象 / 材质：临时向量、颜色、矩阵在实例内复用；
 *   4. 总粒子上限 ≤ 3500（尘埃 900 + 花粉 350 + 萤火虫 90 + 星空 1600，按画质微调）。
 *
 * 对外契约：
 *   createParticles(opt) -> { group, update(t, dt, camera, state), setState(state, t, dt), stats }
 */
import * as THREE from 'three';
import {
  getPreset, clamp, damp, smoothstep, makeRng, sunDirection, terrainHeight, fbm, TAU,
  CLEARING, POND, PATH, PALETTE, getTexture,
} from './core.js';

const SEED = 20251018;

/* 风向（水平），6 套预设只改强度/速度，不改方向 */
const WIND_X = 0.88, WIND_Z = 0.47;

/* 复用的临时对象 */
const _m4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _v3 = new THREE.Vector3();
const _s3 = new THREE.Vector3();
const _col = new THREE.Color();
const _camDir = new THREE.Vector3();
const _fallbackCam = new THREE.Vector3(CLEARING.center.x, CLEARING.height + 1.6, CLEARING.center.z);
const DUST_WARM = new THREE.Color(PALETTE.dust);
const WHITE = new THREE.Color('#ffffff');

/** 环相机回收：把 v 折回 [c-half, c+half) */
function wrapAxis(v, c, half) {
  const d = v - c;
  if (d >= half || d < -half) {
    const span = half * 2;
    return c + ((((d + half) % span) + span) % span) - half;
  }
  return v;
}

/**
 * 地面薄雾专用贴图：fbm 密度 × 强径向衰减。
 * core 的 smoke 精灵中心过实、放大到 10m 会像一块板子，这里保证「中心也很软、边缘必为 0」。
 */
function makeHazeTexture(size, seed) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  const img = g.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
      const rad = Math.sqrt(dx * dx + dy * dy);
      const n = fbm(u * 3.6 + seed, v * 3.6 - seed, 4, 2.0, 0.55) * 0.5 + 0.5;
      const falloff = Math.pow(clamp(1 - rad, 0, 1), 1.9);
      const a = clamp(falloff * (0.3 + n * 0.7) * 0.6, 0, 1);
      const i = (y * size + x) * 4;
      d[i] = 255; d[i + 1] = 252; d[i + 2] = 246;
      d[i + 3] = (a * 255) | 0;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/* 星空：加法混合 + 每颗独立相位/尺寸/色温（GPU 闪烁，CPU 零开销） */
const STAR_VERT = /* glsl */`
  attribute float aSize;
  attribute float aPhase;
  attribute float aBright;
  attribute float aTint;
  uniform float uTime;
  uniform float uPixelRatio;
  varying float vBright;
  varying float vTint;
  void main() {
    float tw = 0.5 + 0.5 * sin( uTime * ( 0.45 + aPhase * 1.35 ) + aPhase * 43.7 );
    vBright = ( 0.42 + 0.58 * tw * tw ) * aBright;
    vTint = aTint;
    vec4 mv = modelViewMatrix * vec4( position, 1.0 );
    gl_Position = projectionMatrix * mv;
    gl_PointSize = max( 1.0, aSize * uPixelRatio );
  }
`;

const STAR_FRAG = /* glsl */`
  uniform sampler2D uMap;
  uniform float uOpacity;
  uniform vec3 uColor;
  uniform vec3 uWarm;
  varying float vBright;
  varying float vTint;
  void main() {
    vec4 t = texture2D( uMap, gl_PointCoord );
    float a = t.a * t.a;
    vec3 c = mix( uColor, uWarm, vTint ) * ( vBright * uOpacity );
    gl_FragColor = vec4( c * a, 1.0 );   // 加法混合按 SRC_ALPHA 预乘，这里直接给预乘结果
  }
`;

export function createParticles(opt = {}) {
  const quality = opt.quality || {};
  const qKey = opt.qualityKey || quality.key || 'high';
  const dens = qKey === 'low' ? 0.6 : qKey === 'medium' ? 0.82 : qKey === 'ultra' ? 1.15 : 1.0;

  const N_DUST = Math.round(900 * dens);
  const N_POLLEN = Math.round(350 * dens);
  const N_LEAF = Math.round(60 * Math.min(dens, 1.1));
  const N_FLY = Math.round(90 * Math.min(dens, 1.1));
  const N_STAR = Math.round(1600 * dens);
  const N_BIRD = 10;
  const N_HAZE = 10;

  const rng = makeRng(SEED);
  const cam0 = (opt.camera && opt.camera.position) || _fallbackCam;

  const group = new THREE.Group();
  group.name = 'particles';

  /* =====================================================================
   * 1. 尘埃（光柱里的浮尘）：相机周围 ±27m × ±9m(偏上)，极慢漂移 + 微湍流
   * ===================================================================== */
  const DUST_HALF = 27, DUST_HALF_Y = 9, DUST_CY_OFF = 3;
  const dustPos = new Float32Array(N_DUST * 3);
  const dustCol = new Float32Array(N_DUST * 3);
  const dustVel = new Float32Array(N_DUST * 3);
  const dustPhase = new Float32Array(N_DUST);
  for (let i = 0, j = 0; i < N_DUST; i++, j += 3) {
    dustPos[j] = cam0.x + rng.gauss(0, 13);
    dustPos[j + 1] = cam0.y + rng.gauss(2.5, 5);
    dustPos[j + 2] = cam0.z + rng.gauss(0, 13);
    dustVel[j] = rng.gauss(0, 0.085);
    dustVel[j + 1] = rng.gauss(0.012, 0.03);
    dustVel[j + 2] = rng.gauss(0, 0.085);
    dustPhase[i] = rng() * TAU;
    const b = 0.35 + rng() * 0.8;
    dustCol[j] = b; dustCol[j + 1] = b * 0.94; dustCol[j + 2] = b * 0.8;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3).setUsage(THREE.DynamicDrawUsage));
  dustGeo.setAttribute('color', new THREE.BufferAttribute(dustCol, 3));
  const dustMat = new THREE.PointsMaterial({
    map: getTexture('dust'), size: 0.058, sizeAttenuation: true, vertexColors: true,
    transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  });
  const dustPts = new THREE.Points(dustGeo, dustMat);
  dustPts.name = 'dust';
  dustPts.frustumCulled = false;
  dustPts.renderOrder = 5;
  dustPts.visible = false;
  group.add(dustPts);

  /* =====================================================================
   * 2. 花粉 / 孢子：更大更亮、漂得更慢，白天明显
   * ===================================================================== */
  const POLLEN_HALF = 24, POLLEN_HALF_Y = 7;
  const polPos = new Float32Array(N_POLLEN * 3);
  const polCol = new Float32Array(N_POLLEN * 3);
  const polVel = new Float32Array(N_POLLEN * 3);
  const polPhase = new Float32Array(N_POLLEN);
  for (let i = 0, j = 0; i < N_POLLEN; i++, j += 3) {
    polPos[j] = cam0.x + rng.gauss(0, 11);
    polPos[j + 1] = cam0.y + rng.gauss(1.8, 4);
    polPos[j + 2] = cam0.z + rng.gauss(0, 11);
    polVel[j] = rng.gauss(0, 0.05);
    polVel[j + 1] = rng.gauss(0.02, 0.025);
    polVel[j + 2] = rng.gauss(0, 0.05);
    polPhase[i] = rng() * TAU;
    const b = 0.45 + rng() * 0.7;
    polCol[j] = b; polCol[j + 1] = b * 0.95; polCol[j + 2] = b * 0.72;
  }
  const polGeo = new THREE.BufferGeometry();
  polGeo.setAttribute('position', new THREE.BufferAttribute(polPos, 3).setUsage(THREE.DynamicDrawUsage));
  polGeo.setAttribute('color', new THREE.BufferAttribute(polCol, 3));
  const polMat = new THREE.PointsMaterial({
    map: getTexture('glow'), size: 0.15, sizeAttenuation: true, vertexColors: true,
    transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  });
  const polPts = new THREE.Points(polGeo, polMat);
  polPts.name = 'pollen';
  polPts.frustumCulled = false;
  polPts.renderOrder = 5;
  polPts.visible = false;
  group.add(polPts);

  /* =====================================================================
   * 3. 落叶：InstancedMesh（可各自翻滚），落地淡出后回收
   * ===================================================================== */
  // 一张卡片 = 1~3 片叶子（不是一坨叶簇），尺寸按真实落叶 ≈ 8cm
  const leafTex = getTexture('leafCard', { color: '#cfc7b4', count: 3, spread: 0.3, leafScale: 3.0 });
  const leafGeo = new THREE.PlaneGeometry(0.24, 0.30);
  // 用 Lambert（而不是 Basic）：落叶会随日光/阴影变化，夜里自然变暗，不会像"亮纸片"
  const leafMat = new THREE.MeshLambertMaterial({
    map: leafTex, transparent: true, alphaTest: 0.34, depthWrite: true,
    side: THREE.DoubleSide, fog: true, opacity: 1,
  });
  const leavesMesh = new THREE.InstancedMesh(leafGeo, leafMat, N_LEAF);
  leavesMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  leavesMesh.frustumCulled = false;
  leavesMesh.renderOrder = 0;
  leavesMesh.visible = false;
  leavesMesh.name = 'leaves';
  group.add(leavesMesh);

  const leaves = [];
  for (let i = 0; i < N_LEAF; i++) {
    leaves.push({
      x: cam0.x, y: cam0.y + 10, z: cam0.z,
      rx: rng() * TAU, ry: rng() * TAU, rz: rng() * TAU,
      sx: rng.range(-2.6, 2.6), sy: rng.range(-2.2, 2.2), sz: rng.range(-2.6, 2.6),
      fall: rng.range(0.55, 1.2), sway: rng.range(0.3, 1.0), ph: rng() * TAU,
      gx: 0, gz: 0, gy: 0, landed: 0, scale: 1,
    });
  }
  // 去饱和的枯叶色（#8a6a3a 一带），只做轻微冷暖/明暗分布
  for (let i = 0; i < N_LEAF; i++) {
    _col.setHSL(0.068 + rng() * 0.05, 0.2 + rng() * 0.18, 0.3 + rng() * 0.15);
    leavesMesh.setColorAt(i, _col);
  }
  if (leavesMesh.instanceColor) leavesMesh.instanceColor.needsUpdate = true;

  const LEAF_FADE = 1.1;
  function spawnLeaf(L, cam, high) {
    L.x = cam.x + rng.range(-20, 20);
    L.z = cam.z + rng.range(-20, 20);
    L.y = cam.y + (high ? rng.range(9, 16) : rng.range(2, 12));
    L.gx = L.x; L.gz = L.z;
    L.gy = terrainHeight(L.x, L.z);
    L.rx = rng() * TAU; L.ry = rng() * TAU; L.rz = rng() * TAU;
    L.landed = 0; L.scale = 1;
  }
  for (let i = 0; i < N_LEAF; i++) spawnLeaf(leaves[i], cam0, false);

  /* =====================================================================
   * 4. 萤火虫：贴地 0.35~2.1m，各自相位正弦闪烁
   * ===================================================================== */
  const FLY_HALF = 15;
  const flyPos = new Float32Array(N_FLY * 3);
  const flyCol = new Float32Array(N_FLY * 3);
  const flyVel = new Float32Array(N_FLY * 2);
  const flyPhase = new Float32Array(N_FLY);
  const flyRate = new Float32Array(N_FLY);
  const flyInt = new Float32Array(N_FLY);

  function groundAt(x, z) {
    let gy = terrainHeight(x, z);
    const pd = Math.hypot(x - POND.center.x, z - POND.center.z);
    if (pd < POND.radius * 1.06) gy = Math.max(gy, POND.level + 0.12);   // 池塘上空也留萤火
    return gy;
  }
  function seedFirefly(i, cam) {
    let x = cam.x + rng.range(-FLY_HALF, FLY_HALF);
    let z = cam.z + rng.range(-FLY_HALF, FLY_HALF);
    if (Math.hypot(x - CLEARING.center.x, z - CLEARING.center.z) < 5.4) {   // 别落在木屋里
      x += rng.sign() * 6;
      z += rng.sign() * 6;
    }
    flyVel[i * 2] = rng.gauss(0, 0.16);
    flyVel[i * 2 + 1] = rng.gauss(0, 0.16);
    flyPhase[i] = rng() * TAU;
    flyRate[i] = rng.range(0.55, 1.7);
    flyInt[i] = rng.range(0.55, 1.35);
    const j = i * 3;
    flyPos[j] = x;
    flyPos[j + 1] = groundAt(x, z) + 1.2;
    flyPos[j + 2] = z;
    flyCol[j] = 0; flyCol[j + 1] = 0; flyCol[j + 2] = 0;
  }
  for (let i = 0; i < N_FLY; i++) seedFirefly(i, cam0);

  const flyGeo = new THREE.BufferGeometry();
  flyGeo.setAttribute('position', new THREE.BufferAttribute(flyPos, 3).setUsage(THREE.DynamicDrawUsage));
  flyGeo.setAttribute('color', new THREE.BufferAttribute(flyCol, 3).setUsage(THREE.DynamicDrawUsage));
  const flyMat = new THREE.PointsMaterial({
    map: getTexture('firefly'), size: 0.42, sizeAttenuation: true, vertexColors: true,
    transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  });
  const flyPts = new THREE.Points(flyGeo, flyMat);
  flyPts.name = 'fireflies';
  flyPts.frustumCulled = false;
  flyPts.renderOrder = 5;
  flyPts.visible = false;
  group.add(flyPts);

  /* =====================================================================
   * 5. 星空：半径 ~300 球壳（跟随相机），银河带疏密不均，加法闪烁
   * ===================================================================== */
  const starRadius = Math.min(300, (quality.far || 320) * 0.86);
  const starPos = new Float32Array(N_STAR * 3);
  const starSize = new Float32Array(N_STAR);
  const starPhase = new Float32Array(N_STAR);
  const starBright = new Float32Array(N_STAR);
  const starTint = new Float32Array(N_STAR);
  const bandN = new THREE.Vector3(0.38, 0.66, -0.65).normalize();
  const bandU = new THREE.Vector3(1, 0, 0).addScaledVector(bandN, -bandN.x).normalize();
  const bandV = new THREE.Vector3().crossVectors(bandN, bandU).normalize();
  const clumpA = new Float32Array(7);
  for (let i = 0; i < clumpA.length; i++) clumpA[i] = rng() * TAU;
  for (let i = 0, j = 0; i < N_STAR; i++, j += 3) {
    let dx, dy, dz;
    if (rng() < 0.46) {
      // 银河带：沿大圆分布 + 局部星团，疏密不均
      const clump = rng() < 0.55;
      const a = clump ? clumpA[rng.int(0, clumpA.length - 1)] + rng.gauss(0, 0.24) : rng() * TAU;
      const lat = rng.gauss(0, clump ? 0.05 : 0.115);
      const ca = Math.cos(a), sa = Math.sin(a), cl = Math.cos(lat), sl = Math.sin(lat);
      dx = (bandU.x * ca + bandV.x * sa) * cl + bandN.x * sl;
      dy = (bandU.y * ca + bandV.y * sa) * cl + bandN.y * sl;
      dz = (bandU.z * ca + bandV.z * sa) * cl + bandN.z * sl;
    } else {
      const z = rng() * 2 - 1, a = rng() * TAU, rr = Math.sqrt(Math.max(0, 1 - z * z));
      dx = rr * Math.cos(a); dy = z; dz = rr * Math.sin(a);
    }
    const inv = 1 / (Math.hypot(dx, dy, dz) || 1);
    starPos[j] = dx * inv * starRadius;
    starPos[j + 1] = dy * inv * starRadius;
    starPos[j + 2] = dz * inv * starRadius;
    starSize[i] = 1.1 + 3.0 * Math.pow(rng(), 3.2);
    starPhase[i] = rng();
    starBright[i] = 0.22 + 3.9 * Math.pow(rng(), 7);
    starTint[i] = rng() * rng();
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  starGeo.setAttribute('aSize', new THREE.BufferAttribute(starSize, 1));
  starGeo.setAttribute('aPhase', new THREE.BufferAttribute(starPhase, 1));
  starGeo.setAttribute('aBright', new THREE.BufferAttribute(starBright, 1));
  starGeo.setAttribute('aTint', new THREE.BufferAttribute(starTint, 1));
  const starMat = new THREE.ShaderMaterial({
    name: 'stars',
    uniforms: {
      uMap: { value: getTexture('star') },
      uTime: { value: 0 },
      uOpacity: { value: 0 },
      uPixelRatio: { value: 1 },
      uColor: { value: new THREE.Color(0.62, 0.74, 1.0) },
      uWarm: { value: new THREE.Color(1.0, 0.86, 0.68) },
    },
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });
  const starPts = new THREE.Points(starGeo, starMat);
  starPts.name = 'stars';
  starPts.frustumCulled = false;
  starPts.renderOrder = 0;
  starPts.visible = false;
  group.add(starPts);

  /* =====================================================================
   * 6. 飞鸟：2 群 10 只，单 mesh 逐帧顶点扇翅（6 顶点 / 只）
   * ===================================================================== */
  const BIRD_VERTS = 6;
  const birdArr = new Float32Array(N_BIRD * BIRD_VERTS * 3);
  const birdGeo = new THREE.BufferGeometry();
  birdGeo.setAttribute('position', new THREE.BufferAttribute(birdArr, 3).setUsage(THREE.DynamicDrawUsage));
  birdGeo.setDrawRange(0, N_BIRD * BIRD_VERTS);
  const birdMat = new THREE.MeshBasicMaterial({
    color: 0x2b2f36, side: THREE.DoubleSide, transparent: true, opacity: 0, fog: true, depthWrite: true,
  });
  const birdMesh = new THREE.Mesh(birdGeo, birdMat);
  birdMesh.name = 'birds';
  birdMesh.frustumCulled = false;
  birdMesh.renderOrder = 0;
  birdMesh.visible = false;
  group.add(birdMesh);

  const birdCfg = [];
  for (let i = 0; i < N_BIRD; i++) {
    const g = i < 5 ? 0 : 1;
    birdCfg.push({
      cx: CLEARING.center.x + rng.range(-16, 16),
      cz: CLEARING.center.z + rng.range(-16, 16),
      r: g === 0 ? rng.range(70, 88) : rng.range(102, 124),
      h: g === 0 ? rng.range(34, 44) : rng.range(46, 58),
      a0: rng() * TAU,
      w: (g === 0 ? 0.055 : 0.042) * rng.range(0.85, 1.15) * (i % 2 ? 1 : -1),
      span: g === 0 ? rng.range(0.85, 1.05) : rng.range(1.05, 1.3),
      flap: rng.range(4.0, 5.8),
      ph: rng() * TAU,
      bob: rng.range(1.2, 2.8),
    });
  }
  const _bF = new THREE.Vector3();
  const _bR = new THREE.Vector3();

  /* =====================================================================
   * 7. 地面薄雾：8~10 片 6~12m 软边 sprite（billboard），绕院子外围 / 池塘 / 林缘
   *    —— 尺寸小、贴地、离相机近了就淡出，绝不出现"一块雾板"
   * ===================================================================== */
  const hazeTex = makeHazeTexture(192, 73);
  const hazeGroup = new THREE.Group();
  hazeGroup.name = 'haze';
  hazeGroup.visible = false;
  group.add(hazeGroup);

  const hazeBase = [];
  const hazeRing = 6;
  for (let i = 0; i < hazeRing; i++) {
    const a = (i / hazeRing) * TAU + rng.range(-0.3, 0.3);
    const r = rng.range(18, 28);
    hazeBase.push({ x: CLEARING.center.x + Math.cos(a) * r, z: CLEARING.center.z + Math.sin(a) * r });
  }
  hazeBase.push({ x: POND.center.x + rng.range(-7, 7), z: POND.center.z + rng.range(4, 10) });
  hazeBase.push({ x: POND.center.x + rng.range(-9, 3), z: POND.center.z - rng.range(3, 9) });
  hazeBase.push({ x: PATH.points[3].x + rng.range(-4, 4), z: PATH.points[3].z + rng.range(-4, 4) });
  hazeBase.push({ x: PATH.points[5].x + rng.range(-4, 4), z: PATH.points[5].z + rng.range(-4, 4) });

  const hazeItems = [];
  for (let i = 0; i < N_HAZE; i++) {
    const b = hazeBase[i % hazeBase.length];
    const w = rng.range(6, 12);
    const h = w * rng.range(0.38, 0.54);
    const mat = new THREE.SpriteMaterial({
      map: hazeTex, transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.NormalBlending, fog: true, opacity: 0,
    });
    mat.color.copy(DUST_WARM);
    const sp = new THREE.Sprite(mat);
    sp.name = `haze${i}`;
    sp.renderOrder = 4;
    sp.center.set(0.5, 0.26);          // 锚点靠近底部 → 贴地雾带，上半部分才露在地面之上
    sp.frustumCulled = true;
    hazeGroup.add(sp);
    hazeItems.push({
      sp, mat, base: b,
      y: groundAt(b.x, b.z) + rng.range(0.22, 0.62),
      w, h,
      ph: rng() * TAU,
      driftX: rng.range(0.5, 1.4) * (rng() < 0.5 ? -1 : 1),
      driftZ: rng.range(0.5, 1.4) * (rng() < 0.5 ? -1 : 1),
      alpha: rng.range(0.2, 0.36),
    });
  }

  /* =====================================================================
   * 每帧更新
   * ===================================================================== */
  let _state = getPreset(opt.preset || 'golden');
  const _fallbackSun = sunDirection(getPreset('golden').sun.azimuth, getPreset('golden').sun.elevation, new THREE.Vector3());

  /* 平滑后的各类不透明度（material.opacity 插值，绝不硬切） */
  const op = { dust: 0, pollen: 0, leaves: 0, fireflies: 0, stars: 0, birds: 0, haze: 0 };

  function update(t, dt, camera, state) {
    if (state) _state = state;
    const st = _state;
    const step = clamp(dt > 0 ? dt : 0, 0, 0.1);
    const cam = (camera && camera.position) || _fallbackCam;
    const pl = st.particles || getPreset('golden').particles;
    const wind = st.wind || getPreset('golden').wind;
    const night = clamp(st.nightFactor != null ? st.nightFactor : 0, 0, 1);
    const sunDir = st.sunDirection || _fallbackSun;

    /* 逆光程度：镜头朝向太阳时浮尘被前向散射点亮 */
    if (camera) camera.getWorldDirection(_camDir);
    else _camDir.set(0, 0, -1);
    const backlight = clamp(_camDir.dot(sunDir), 0, 1);

    /* ---- 目标不透明度 ---- */
    const dustT = clamp(pl.dust * (0.42 + 0.85 * backlight) * (1 - 0.6 * night), 0, 1.25);
    const polT = clamp(pl.pollen * (0.5 + 0.5 * backlight) * (1 - 0.85 * night), 0, 1.25);
    const leafT = clamp(pl.leaves * (1 - 0.4 * night), 0, 1);
    const flyT = clamp(pl.fireflies, 0, 1);
    const starT = clamp(pl.stars, 0, 1);
    const birdT = clamp(pl.birds, 0, 1);
    const hazeT = clamp(pl.haze, 0, 1.3);
    const L = 3.1;
    op.dust = damp(op.dust, dustT, L, step);
    op.pollen = damp(op.pollen, polT, L, step);
    op.leaves = damp(op.leaves, leafT, L, step);
    op.fireflies = damp(op.fireflies, flyT, L, step);
    op.stars = damp(op.stars, starT, L, step);
    op.birds = damp(op.birds, birdT, L, step);
    op.haze = damp(op.haze, hazeT, L, step);

    /* ---- 风 ---- */
    const windSpeed = 0.6 + wind.strength * 1.7 * (0.6 + wind.speed * 0.5);
    const windX = WIND_X * windSpeed;
    const windZ = WIND_Z * windSpeed;

    /* ---- 1. 尘埃 ---- */
    dustPts.visible = op.dust > 0.012;
    if (dustPts.visible) {
      dustMat.opacity = clamp(op.dust, 0, 1);
      _col.set(st.sun.color || '#ffffff');
      dustMat.color.copy(_col).lerp(DUST_WARM, 0.3);
      const cY = cam.y + DUST_CY_OFF;
      const turb = 0.11 + wind.strength * 0.06;
      const dWindK = 0.35 + wind.strength * 0.45;
      for (let i = 0, j = 0; i < N_DUST; i++, j += 3) {
        const ph = dustPhase[i];
        let px = dustPos[j] + (dustVel[j] + windX * dWindK * 0.25 + Math.sin(t * 0.61 + ph) * turb) * step;
        let py = dustPos[j + 1] + (dustVel[j + 1] + Math.sin(t * 0.44 + ph * 1.7) * turb * 0.7) * step;
        let pz = dustPos[j + 2] + (dustVel[j + 2] + windZ * dWindK * 0.25 + Math.cos(t * 0.53 + ph * 2.3) * turb) * step;
        px = wrapAxis(px, cam.x, DUST_HALF);
        py = wrapAxis(py, cY, DUST_HALF_Y);
        pz = wrapAxis(pz, cam.z, DUST_HALF);
        dustPos[j] = px; dustPos[j + 1] = py; dustPos[j + 2] = pz;
      }
      dustGeo.attributes.position.needsUpdate = true;
    }

    /* ---- 2. 花粉 ---- */
    polPts.visible = op.pollen > 0.012;
    if (polPts.visible) {
      polMat.opacity = clamp(op.pollen, 0, 1);
      _col.set(st.sun.color || '#ffffff');
      polMat.color.copy(_col).lerp(WHITE, 0.35).multiplyScalar(1.1);
      const cY = cam.y + 2;
      for (let i = 0, j = 0; i < N_POLLEN; i++, j += 3) {
        const ph = polPhase[i];
        let px = polPos[j] + (polVel[j] + windX * 0.2 + Math.sin(t * 0.37 + ph) * 0.06) * step;
        let py = polPos[j + 1] + (polVel[j + 1] + Math.sin(t * 0.29 + ph * 1.9) * 0.05) * step;
        let pz = polPos[j + 2] + (polVel[j + 2] + windZ * 0.2 + Math.cos(t * 0.33 + ph * 2.7) * 0.06) * step;
        px = wrapAxis(px, cam.x, POLLEN_HALF);
        py = wrapAxis(py, cY, POLLEN_HALF_Y);
        pz = wrapAxis(pz, cam.z, POLLEN_HALF);
        polPos[j] = px; polPos[j + 1] = py; polPos[j + 2] = pz;
      }
      polGeo.attributes.position.needsUpdate = true;
    }

    /* ---- 3. 落叶 ---- */
    leavesMesh.visible = op.leaves > 0.03;
    if (leavesMesh.visible) {
      leafMat.opacity = clamp(op.leaves * 1.35, 0, 1);
      for (let i = 0; i < N_LEAF; i++) {
        const lf = leaves[i];
        if (lf.landed > 0) {
          lf.landed -= step;
          if (lf.landed <= 0) spawnLeaf(lf, cam, true);
          else lf.scale = clamp(lf.landed / LEAF_FADE, 0, 1);
        } else {
          lf.scale = 1;
          lf.x += (windX * 0.85 + Math.sin(t * 1.35 + lf.ph) * lf.sway * 0.5) * step;
          lf.z += (windZ * 0.85 + Math.cos(t * 1.15 + lf.ph * 1.7) * lf.sway * 0.5) * step;
          lf.y -= lf.fall * (0.72 + 0.45 * (0.5 + 0.5 * Math.sin(t * 0.8 + lf.ph))) * step;
          lf.rx += lf.sx * step; lf.ry += lf.sy * step; lf.rz += lf.sz * step;
          // 飘出采样点 3.5m 就重取地面高度（否则会浮空 / 埋进坡里）
          if (Math.abs(lf.x - lf.gx) > 3.5 || Math.abs(lf.z - lf.gz) > 3.5) {
            lf.gx = lf.x; lf.gz = lf.z;
            lf.gy = terrainHeight(lf.x, lf.z);
          }
          if (lf.y <= lf.gy + 0.05) { lf.y = lf.gy + 0.04; lf.landed = LEAF_FADE; }
        }
        // 相机走远 / 落叶飞出范围 → 一律对侧回收（落地淡出期间也保证不留在原地）
        if (Math.hypot(lf.x - cam.x, lf.z - cam.z) > 46) spawnLeaf(lf, cam, true);
        _euler.set(lf.rx, lf.ry, lf.rz);
        _quat.setFromEuler(_euler);
        _v3.set(lf.x, lf.y, lf.z);
        _s3.set(lf.scale, lf.scale, lf.scale);
        _m4.compose(_v3, _quat, _s3);
        leavesMesh.setMatrixAt(i, _m4);
      }
      leavesMesh.instanceMatrix.needsUpdate = true;
    }

    /* ---- 4. 萤火虫 ---- */
    flyPts.visible = op.fireflies > 0.012;
    if (flyPts.visible) {
      flyMat.opacity = clamp(op.fireflies, 0, 1);
      for (let i = 0; i < N_FLY; i++) {
        const ph = flyPhase[i];
        const j = i * 3;
        let px = flyPos[j] + (flyVel[i * 2] + Math.sin(t * 0.31 + ph) * 0.22 + windX * 0.06) * step;
        let pz = flyPos[j + 2] + (flyVel[i * 2 + 1] + Math.cos(t * 0.27 + ph * 1.6) * 0.22 + windZ * 0.06) * step;
        const wx = wrapAxis(px, cam.x, FLY_HALF);
        const wz = wrapAxis(pz, cam.z, FLY_HALF);
        if (wx !== px || wz !== pz) {
          // 水平回收 → 换到对侧，并避开木屋占地
          if (Math.hypot(wx - CLEARING.center.x, wz - CLEARING.center.z) < 5.4) {
            px = wx + (wx > CLEARING.center.x ? 6 : -6);
            pz = wz + (wz > CLEARING.center.z ? 6 : -6);
          } else {
            px = wx; pz = wz;
          }
        }
        // 每帧取当地地面高度：90 个萤火虫的 terrainHeight 采样成本可忽略，换来精确贴地
        flyPos[j] = px;
        flyPos[j + 1] = groundAt(px, pz) + 0.35 + 1.75 * (0.5 + 0.5 * Math.sin(t * 0.42 + ph * 1.3));
        flyPos[j + 2] = pz;
        // 各自相位的正弦闪烁（不是同步呼吸）
        const blink = 0.05 + 0.95 * Math.pow(0.5 + 0.5 * Math.sin(t * flyRate[i] + ph * 7.3), 4);
        const g = flyInt[i] * blink;
        flyCol[j] = 0.9 * g; flyCol[j + 1] = g; flyCol[j + 2] = 0.42 * g;
      }
      flyGeo.attributes.position.needsUpdate = true;
      flyGeo.attributes.color.needsUpdate = true;
    }

    /* ---- 5. 星空（跟随相机，GPU 闪烁） ---- */
    starPts.visible = op.stars > 0.012;
    if (starPts.visible) {
      starPts.position.copy(cam);
      starPts.rotation.y = t * 0.0035;
      starMat.uniforms.uTime.value = t;
      starMat.uniforms.uOpacity.value = clamp(op.stars, 0, 1);
      const pr = (opt.renderer && opt.renderer.getPixelRatio) ? opt.renderer.getPixelRatio() : 1;
      starMat.uniforms.uPixelRatio.value = pr;
    }

    /* ---- 6. 飞鸟 ---- */
    birdMesh.visible = op.birds > 0.02;
    if (birdMesh.visible) {
      birdMat.opacity = clamp(op.birds, 0, 1);
      _col.set(st.fog ? st.fog.color : '#8ba0b8');
      birdMat.color.copy(_col).multiplyScalar(0.32);
      for (let i = 0; i < N_BIRD; i++) {
        const b = birdCfg[i];
        const ang = b.a0 + t * b.w * (1 + 0.16 * Math.sin(t * 0.21 + b.ph));
        const rr = b.r * (1 + 0.06 * Math.sin(t * 0.17 + b.ph * 1.7));
        const cx = b.cx + Math.cos(ang) * rr;
        const cz = b.cz + Math.sin(ang) * rr;
        const cy = CLEARING.height + b.h + Math.sin(t * 0.44 + b.ph) * b.bob + Math.sin(t * 1.1 + b.ph * 2.1) * 0.45;
        // 航向 = 切线
        _bF.set(-Math.sin(ang) * (b.w > 0 ? 1 : -1), 0, Math.cos(ang) * (b.w > 0 ? 1 : -1)).normalize();
        _bR.set(_bF.z, 0, -_bF.x);
        const tipY = Math.sin(t * b.flap + b.ph) * 0.42 * b.span;
        const hw = b.span * 0.5;
        const o = i * 18;
        // 右翼（机体前 → 右翼尖 → 机体后）
        birdArr[o] = cx + _bF.x * 0.16; birdArr[o + 1] = cy; birdArr[o + 2] = cz + _bF.z * 0.16;
        birdArr[o + 3] = cx + _bR.x * hw + _bF.x * 0.02;
        birdArr[o + 4] = cy + tipY;
        birdArr[o + 5] = cz + _bR.z * hw + _bF.z * 0.02;
        birdArr[o + 6] = cx - _bF.x * 0.2; birdArr[o + 7] = cy; birdArr[o + 8] = cz - _bF.z * 0.2;
        // 左翼
        birdArr[o + 9] = birdArr[o]; birdArr[o + 10] = birdArr[o + 1]; birdArr[o + 11] = birdArr[o + 2];
        birdArr[o + 12] = cx - _bR.x * hw + _bF.x * 0.02;
        birdArr[o + 13] = cy + tipY;
        birdArr[o + 14] = cz - _bR.z * hw + _bF.z * 0.02;
        birdArr[o + 15] = birdArr[o + 6]; birdArr[o + 16] = birdArr[o + 7]; birdArr[o + 17] = birdArr[o + 8];
      }
      birdGeo.attributes.position.needsUpdate = true;
    }

    /* ---- 7. 地面薄雾 ---- */
    hazeGroup.visible = op.haze > 0.012;
    if (hazeGroup.visible) {
      _col.set(st.fog ? st.fog.color : '#b9c3cd');
      for (let i = 0; i < hazeItems.length; i++) {
        const it = hazeItems[i];
        const breath = 0.9 + 0.12 * Math.sin(t * 0.115 + it.ph * 1.9);
        const px = it.base.x + Math.sin(t * 0.07 * it.driftX + it.ph) * 3.4;
        const py = it.y + Math.sin(t * 0.09 + it.ph * 1.3) * 0.14;
        const pz = it.base.z + Math.cos(t * 0.06 * it.driftZ + it.ph) * 3.4;
        // 距离淡出：18m 以内完全消失，任何机位都不会出现"雾板"横穿画面或参与托底亮度
        const ddx = px - cam.x, ddy = py - cam.y, ddz = pz - cam.z;
        const dist = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
        const near = smoothstep(18, 30, dist);
        const a = op.haze * it.alpha * (0.72 + 0.28 * Math.sin(t * 0.09 + it.ph * 2.3)) * near;
        it.sp.visible = a > 0.004;
        if (!it.sp.visible) continue;
        it.mat.color.copy(_col);
        it.mat.opacity = clamp(a, 0, 1);
        it.sp.position.set(px, py, pz);
        it.sp.scale.set(it.w * breath, it.h * breath, 1);
      }
    }
  }

  /** main.js 的广播路径：只缓存 state（时间轴由 update 的 elapsed 负责，不能混用两套时钟） */
  function setState(state) {
    if (state) _state = state;
  }

  const stats = {
    points: N_DUST + N_POLLEN + N_FLY + N_STAR,
    dust: N_DUST, pollen: N_POLLEN, leaves: N_LEAF,
    fireflies: N_FLY, stars: N_STAR, birds: N_BIRD, haze: N_HAZE,
  };

  console.log(`[particles] ready · points=${stats.points} (dust ${N_DUST} / pollen ${N_POLLEN} / fly ${N_FLY} / stars ${N_STAR}) · leaves ${N_LEAF} · birds ${N_BIRD} · haze ${N_HAZE}`);

  return { group, update, setState, stats };
}
