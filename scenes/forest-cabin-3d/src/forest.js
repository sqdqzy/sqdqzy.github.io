/**
 * forest.js — 森林植被：五类树 / 远景树墙 / 地被（草、灌木、蕨、苔、野花、蘑菇）/ 岩石 / 倒木 / 树桩
 * ---------------------------------------------------------------------------
 * 所有权：forest-builder（task-2）。只允许 import 'three' 与 './core.js'。
 *
 * 设计要点
 *  1. 一切放置都走 core 的 placement()（院子/小径/水面/陡坡自动排除）与
 *     sampleTerrain()/terrainHeight()（绝不自己重写高度函数）。
 *  2. 每个 InstancedMesh 都给它正确的 boundingSphere（computeBoundingSphere），
 *     否则 1500 株树的默认整体包围球会让视锥剔除失效或整批被误剔除。
 *  3. 树冠材质 roughness 0.9 / flatShading false；用 onBeforeCompile 注入
 *     「逆光透射」假象：相机→片元方向与太阳方向对齐时树叶发光（电影感核心）。
 *  4. LOD：<60m 高模（枝干细节 + 白桦树皮），60m 外低模（树干并入树冠、更少分段），
 *     94~111m 一圈树墙封地平线；update() 按相机距离切换远近两层 visible。
 *  5. 草簇数量由「剩余三角面额度」动态决定，保证 ultra 不超过 120 万面。
 */
import * as THREE from 'three';
import {
  WORLD, CLEARING, POND, PATH, DEG, TAU,
  clamp, smoothstep, makeRng, fbm, warpedFbm,
  terrainHeight, sampleTerrain, placement, canPlantTree,
  getTexture, getNormal, repeatOf, makeInstanced, mergeGeometriesSimple,
  applyWindSway, damp, normalFromCanvas,
} from './core.js';

const TRI_BUDGET = 1200000;
const TREE_TARGET = 1300;      // treeDensity = 1.0 时（ultra ×1.22 ≈ 1586 株）
const WALL_TARGET = 460;

/* =========================================================================
 * 0. 工具
 * ========================================================================= */

function canvas2d(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { c, g: c.getContext('2d') };
}

function toTexture(canvas, { srgb = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return t;
}

/** 把几何体 UV 映射到图集的某个子区域（用于树桩年轮 / 蘑菇图集） */
function remapUV(geo, u0, v0, du, dv) {
  const uv = geo.attributes.uv;
  if (!uv) return geo;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * du, v0 + uv.getY(i) * dv);
  uv.needsUpdate = true;
  return geo;
}

/** 就地摆放（旋转/缩放/平移） */
function place(geo, o = {}) {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(o.rx || 0, o.ry || 0, o.rz || 0));
  geo.applyMatrix4(new THREE.Matrix4().compose(
    new THREE.Vector3(o.x || 0, o.y || 0, o.z || 0),
    q,
    new THREE.Vector3(o.sx ?? o.s ?? 1, o.sy ?? o.s ?? 1, o.sz ?? o.s ?? 1)
  ));
  return geo;
}

const merge = (parts) => mergeGeometriesSimple(parts.filter(Boolean));
const colOf = (hex) => new THREE.Color(hex);

function instanced(geo, mat, list, { shadows = true, receive = true, name = '', pad = 0.8 } = {}) {
  if (!list.length) return null;
  const mesh = makeInstanced(geo, mat, list, { shadows, receive, name });
  let any = false;
  for (let i = 0; i < list.length; i++) {
    if (list[i].color) { mesh.setColorAt(i, list[i].color); any = true; }
  }
  if (any && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  if (mesh.boundingSphere) {
    if (!isFinite(mesh.boundingSphere.radius)) mesh.boundingSphere.radius = WORLD.size;
    else mesh.boundingSphere.radius += pad;
  }
  return mesh;
}

function statsOf(root) {
  let triangles = 0, calls = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    calls++;
    const g = o.geometry;
    const n = g.index ? g.index.count / 3 : (g.attributes.position ? g.attributes.position.count / 3 : 0);
    triangles += n * (o.isInstancedMesh ? o.count : 1);
  });
  return { triangles: Math.round(triangles), calls };
}

/** 逐实例乘子色（均值 1.0）：亮度 ±dl / 冷暖 ±dh / 饱和 ±ds。
 *  three 中 diffuse = material.color × map × vertexColor × instanceColor，
 *  所以逐实例色必须是「接近白色」的乘子，不能当 albedo 用，否则整片树林会二次变暗。 */
function tint(rng, dl = 0.12, dh = 0.02, ds = 0.06) {
  const m = 1 + (rng() - 0.5) * 2 * dl;
  const h = (rng() - 0.5) * 2 * dh + (rng() - 0.5) * 2 * ds;
  return new THREE.Color(
    clamp(m * (1 + h * 3), 0.3, 1.8),
    clamp(m, 0.3, 1.8),
    clamp(m * (1 - h * 3), 0.3, 1.8)
  );
}

/** #rrggbb → sRGB 分量 0~255。
 *  画布像素是 sRGB 数据，不能用 THREE.Color 的**线性**分量直接写画布
 *  （那样颜色会被 2~4 倍伽马压暗，是「贴图比预期暗得多」的根因）。 */
function hexRGB(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** 在 sRGB 空间做明暗 / 向白提亮，返回 rgba() 字符串 */
function srgbRgba(hex, mul = 1, toWhite = 0, a = 1) {
  const [r, g, b] = hexRGB(hex);
  const f = (v) => Math.round(Math.min(255, Math.max(0, v * mul * (1 - toWhite) + 255 * toWhite)));
  return `rgba(${f(r)},${f(g)},${f(b)},${a})`;
}



function rockGeometryLocal(detail, seed, squash) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    const d = 1
      + fbm(v.x * 2.3 + seed * 7.3, v.z * 2.3 - seed * 3.1, 3) * 0.3
      + fbm(v.y * 4.1 + seed * 1.7, v.x * 4.1 - seed * 2.3, 2) * 0.16;
    p.setXYZ(i, v.x * d, v.y * d * squash, v.z * d);
  }
  g.computeVertexNormals();
  return g;
}

/* =========================================================================
 * 1. 逆光透射（树叶「透光」假象）：共享 uniform，一次更新全部材质
 * ========================================================================= */
const _sunDirU = { value: new THREE.Vector3(0.4, 0.3, 0.8).normalize() };
const _transU = { value: 0.17 };

/** 在 emissivemap chunk 之后叠加背光透射项；必须在 applyWindSway 之前调用
 *
 *  关键：透射量不能只看「视线是否朝向太阳」—— 那一项在同一帧里对全屏所有叶片几乎相同，
 *  结果是整片树冠被刷成一块均匀的奶油色（看上去像撕破的纸）。
 *  必须再乘上「这片叶子自己的法线背对太阳的程度」，才有逐叶的斑驳感。
 */
function applyTranslucency(material, hex = 0xffcf94, { power = 3.4, wrap = 0.55, gain = 1 } = {}) {
  const col = new THREE.Color(hex);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTransColor = { value: col };
    shader.uniforms.uTransStrength = _transU;
    shader.uniforms.uSunDirW = _sunDirU;
    // power / wrap / gain 都走 uniform（不写进 shader 源码），这样注入后的源码完全一致，
    // 可以让 applyWindSway 的 customProgramCacheKey 安全共享 program。
    shader.uniforms.uTransPower = { value: power };
    shader.uniforms.uTransWrap = { value: wrap };
    shader.uniforms.uTransGain = { value: gain };
    shader.vertexShader = 'varying vec3 vTransWorld;\nvarying vec3 vTransNrm;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      /* glsl */`
      #include <begin_vertex>
      {
        vec4 twP = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          twP = instanceMatrix * twP;
        #endif
        vTransWorld = ( modelMatrix * twP ).xyz;
        #ifdef USE_INSTANCING
          vTransNrm = normalize( mat3( modelMatrix ) * mat3( instanceMatrix ) * objectNormal );
        #else
          vTransNrm = normalize( mat3( modelMatrix ) * objectNormal );
        #endif
      }
      `
    );
    shader.fragmentShader = 'uniform vec3 uTransColor;\nuniform float uTransStrength;\nuniform vec3 uSunDirW;\nuniform float uTransPower;\nuniform float uTransWrap;\nuniform float uTransGain;\nvarying vec3 vTransWorld;\nvarying vec3 vTransNrm;\n' + shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      /* glsl */`
      #include <emissivemap_fragment>
      {
        vec3 toFrag = normalize( vTransWorld - cameraPosition );
        float w = dot( toFrag, uSunDirW );
        float back = max( w, 0.0 );
        // ① 视线朝向太阳的权重（wrap 让斜掠时也留一点，避免纯黑碎片）
        float viewK = mix( pow( back, uTransPower ), clamp( ( w + 0.5 ) / 1.5, 0.0, 1.0 ), uTransWrap );
        // ② 逐叶权重：只有「法线背对太阳」的叶片才透光 —— 这是斑驳感的来源
        float leafK = clamp( -dot( normalize( vTransNrm ), uSunDirW ) * 0.5 + 0.5, 0.0, 1.0 );
        leafK = leafK * leafK * ( 3.0 - 2.0 * leafK );
        totalEmissiveRadiance += uTransColor * ( viewK * leafK * uTransStrength * uTransGain );
      }
      `
    );
  };
  material.userData.translucent = true;
  return material;
}

/* =========================================================================
 * 2. 程序化贴图
 * ========================================================================= */

/** 针叶：**浅色细节层**（最终暗绿由 needleMat.color = 0x3c5236 决定，
 *  这样 material.color × instanceColor 的亮度 ≤0.30，符合 P1 要求）。 */
function makeNeedleCanvas(size = 256, seed = 31) {
  const { c, g } = canvas2d(size);
  const rng = makeRng(seed);
  g.fillStyle = srgbRgba('#2f4230', 1, 0);
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 5200; i++) {
    const x = rng() * size, y = rng() * size;
    const len = 3 + rng() * 9;
    const ang = -Math.PI / 2 + (rng() - 0.5) * 1.9;
    const base = rng() < 0.3 ? '#4c6b3f' : (rng() < 0.5 ? '#22301f' : '#3a5232');
    g.strokeStyle = srgbRgba(base, 0.86 + rng() * 0.38, 0, 0.35 + rng() * 0.5);
    g.lineWidth = 0.6 + rng() * 1.1;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    g.stroke();
  }
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(${rng() < 0.5 ? '0,0,0' : '255,255,255'},${0.02 + rng() * 0.035})`;
    g.beginPath();
    g.arc(rng() * size, rng() * size, 8 + rng() * 40, 0, TAU);
    g.fill();
  }
  return c;
}

/** 蕨类羽状叶（基座在画布底边） */
function makeFernCanvas(size = 256, seed = 515) {
  const { c, g } = canvas2d(size);
  g.clearRect(0, 0, size, size);
  const rng = makeRng(seed);
  for (let f = 0; f < 5; f++) {
    const bx = size * (0.5 + (rng() - 0.5) * 0.5);
    const h = size * (0.55 + rng() * 0.42);
    const bend = (rng() - 0.5) * size * 0.4;
    const fbase = rng() < 0.3 ? '#5c7038' : '#3f5a2c';
    const fmul = 0.7 + rng() * 0.6;
    g.strokeStyle = srgbRgba(fbase, fmul, 0, 0.95);
    g.lineWidth = Math.max(1.2, size * 0.009);
    g.beginPath();
    g.moveTo(bx, size);
    g.quadraticCurveTo(bx + bend * 0.4, size - h * 0.55, bx + bend, size - h);
    g.stroke();
    const pinnae = 11;
    for (let i = 1; i <= pinnae; i++) {
      const t = i / (pinnae + 1);
      const px = bx + bend * t * t;
      const py = size - h * t;
      const pl = size * 0.1 * (1 - t * 0.72) + size * 0.014;
      for (const dir of [-1, 1]) {
        g.fillStyle = srgbRgba(fbase, fmul, 0, 0.72 + rng() * 0.28);
        g.beginPath();
        g.ellipse(px + dir * pl * 0.5, py - pl * 0.12, pl * 0.55, pl * 0.2, dir * -0.5, 0, TAU);
        g.fill();
      }
    }
  }
  return c;
}

/** 苔藓斑块 */
function makeMossCanvas(size = 128, seed = 909) {
  const { c, g } = canvas2d(size);
  g.clearRect(0, 0, size, size);
  const rng = makeRng(seed);
  for (let i = 0; i < 260; i++) {
    const a = rng() * TAU;
    const r = Math.pow(rng(), 0.6) * size * 0.44;
    const x = size * 0.5 + Math.cos(a) * r;
    const y = size * 0.5 + Math.sin(a) * r * 0.9;
    const mbase = rng() < 0.3 ? '#4e6034' : (rng() < 0.5 ? '#3a4a26' : '#61703c');
    const rad = size * (0.02 + rng() * 0.06);
    g.fillStyle = srgbRgba(mbase, 0.8 + rng() * 0.5, 0, 0.5 + rng() * 0.5);
    g.beginPath();
    g.arc(x, y, rad, 0, TAU);
    g.fill();
  }
  return c;
}

/** 小野花（颜色靠 instanceColor 区分） */
function makeFlowerCanvas(size = 64, seed = 1717) {
  const { c, g } = canvas2d(size);
  g.clearRect(0, 0, size, size);
  const rng = makeRng(seed);
  const cx = size * 0.5;
  for (let i = 0; i < 5; i++) {
    const bx = cx + (rng() - 0.5) * size * 0.4;
    const h = size * (0.5 + rng() * 0.4);
    g.strokeStyle = 'rgba(110,132,72,0.95)';
    g.lineWidth = Math.max(1, size * 0.02);
    g.beginPath();
    g.moveTo(bx, size);
    g.quadraticCurveTo(bx + (rng() - 0.5) * 6, size - h * 0.55, bx + (rng() - 0.5) * 8, size - h);
    g.stroke();
    const px = bx + (rng() - 0.5) * 8, py = size - h;
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * TAU;
      g.fillStyle = 'rgba(255,255,246,0.95)';
      g.beginPath();
      g.ellipse(px + Math.cos(a) * size * 0.05, py + Math.sin(a) * size * 0.05, size * 0.045, size * 0.032, a, 0, TAU);
      g.fill();
    }
    g.fillStyle = 'rgba(240,205,110,0.98)';
    g.beginPath();
    g.arc(px, py, size * 0.026, 0, TAU);
    g.fill();
  }
  return c;
}

/** 毒蝇伞图集：上半 = 红伞白点，左下 1/4 = 菌柄 */
function makeMushroomAtlas(size = 256, seed = 2024) {
  const { c, g } = canvas2d(size);
  const rng = makeRng(seed);
  const half = size * 0.5;
  const grd = g.createLinearGradient(0, 0, 0, half);
  grd.addColorStop(0, '#c9452f');
  grd.addColorStop(0.7, '#a8301f');
  grd.addColorStop(1, '#7d2417');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, half);
  for (let i = 0; i < 46; i++) {
    const x = rng() * size, y = rng() * half;
    const r = size * (0.018 + rng() * 0.045);
    g.fillStyle = `rgba(246,242,232,${0.75 + rng() * 0.25})`;
    g.beginPath();
    g.ellipse(x, y, r, r * (0.7 + rng() * 0.5), rng() * TAU, 0, TAU);
    g.fill();
  }
  g.fillStyle = '#d8cdb4';
  g.fillRect(0, half, half, half);
  for (let i = 0; i < 120; i++) {
    g.fillStyle = `rgba(140,125,100,${0.1 + rng() * 0.25})`;
    g.fillRect(rng() * half, half + rng() * half, 2 + rng() * 12, 1 + rng() * 3);
  }
  return c;
}

/** 树桩 / 倒木图集：左半 = 树皮，右上 1/4 = 年轮端面 */
function makeWoodAtlas(size = 512) {
  const { c, g } = canvas2d(size);
  const half = size * 0.5;
  const rng = makeRng(6060);
  const bark = getTexture('bark', { size: 256 }).image;
  g.drawImage(bark, 0, 0, half, size);
  // 右上 1/4：年轮（中心 0.75, 0.75）
  g.fillStyle = '#a8845a';
  g.fillRect(half, 0, half, half);
  const cx = size * 0.75, cy = size * 0.75;
  for (let r = 4; r < half * 0.46; r += 3 + rng() * 6) {
    const t = 0.55 + rng() * 0.45;
    g.strokeStyle = srgbRgba(rng() < 0.5 ? '#7d5c39' : '#c09a68', t, 0, 0.35 + rng() * 0.5);
    g.lineWidth = 0.8 + rng() * 2.4;
    g.beginPath();
    g.ellipse(cx, cy, r, r * (0.9 + rng() * 0.12), 0, 0, TAU);
    g.stroke();
  }
  for (let i = 0; i < 14; i++) {
    const a = rng() * TAU;
    g.strokeStyle = 'rgba(70,50,30,0.5)';
    g.lineWidth = 1 + rng() * 2;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.cos(a) * half * 0.46, cy + Math.sin(a) * half * 0.46);
    g.stroke();
  }
  // 右下 1/4 也填成树皮，避免倒木端面 UV 越界时采到空白
  g.drawImage(bark, half, half, half, half);
  return c;
}

/** 草簇卡片（基座在底边） */
function grassCardCanvas(size = 256, seed = 77) {
  const { c, g } = canvas2d(size);
  g.clearRect(0, 0, size, size);
  const rng = makeRng(seed);
  const cx = size * 0.5;
  for (let i = 0; i < 34; i++) {
    const bx = cx + (rng() - 0.5) * size * 0.8;
    const h = size * (0.4 + rng() * 0.58);
    const bend = (bx - cx) * 0.55 + (rng() - 0.5) * size * 0.4;
    const w = size * (0.01 + rng() * 0.02);
    const dry = rng() < 0.3;
    const base = dry ? '#9a9558' : (rng() < 0.45 ? '#5f7136' : '#4e6230');
    g.fillStyle = srgbRgba(base, 0.62 + rng() * 0.72, 0, 0.72 + rng() * 0.28);
    g.beginPath();
    g.moveTo(bx - w, size);
    g.quadraticCurveTo(bx - w * 0.4 + bend * 0.4, size - h * 0.55, bx + bend, size - h);
    g.quadraticCurveTo(bx + w * 0.6 + bend * 0.4, size - h * 0.5, bx + w, size);
    g.closePath();
    g.fill();
  }
  return c;
}

/* =========================================================================
 * 3. 树几何构造器（每种树 → { trunk, foliage, height }）
 * ========================================================================= */

/** 云杉：细高分层圆锥（层间内凹） */
/** 给锥台/圆锥层做「不规则 + 下坠」：半径用 warpedFbm 沿角向抖动（轮廓不再是完美圆），
 *  底缘按角向波上下起伏并在层底略微往下坠——逆光剪影才像枝条梢而不是锥面（P2）。 */
function organicLayer(geo, rng, { radiusJitter = 0.13, droop = 0.2, waves = 3 } = {}) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const y0 = bb.min.y;
  const span = Math.max(1e-4, bb.max.y - y0);
  const phase = rng() * TAU;
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const r = Math.hypot(x, z);
    if (r < 1e-5) continue;
    const th = Math.atan2(z, x);
    const n = warpedFbm(Math.cos(th) * 1.6 + phase, Math.sin(th) * 1.6 - phase, 2);
    const k = 1 + n * radiusJitter;
    p.setX(i, x * k);
    p.setZ(i, z * k);
    const lift = clamp((y - y0) / span, 0, 1);
    const wave = 0.5 + 0.5 * Math.cos(waves * th + phase * 2 + n * 1.7);
    p.setY(i, y - droop * span * (1 - lift) * (0.35 + 0.65 * wave));
  }
  p.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

function buildSpruce(variant, near) {
  const rng = makeRng(1013 + variant * 977);
  const H = near ? (14.5 + rng() * 2.4) : (12.5 + rng() * 2);
  const seg = near ? 15 : 6;
  const trunkR = H * (near ? 0.0135 : 0.015);
  const tp = [place(new THREE.CylinderGeometry(trunkR * 0.4, trunkR, H * 0.98, near ? 8 : 5, 1), { y: H * 0.49 })];
  tp.push(place(new THREE.CylinderGeometry(trunkR * 1.5, trunkR * 2.6, H * 0.06, near ? 8 : 5, 1, true), { y: H * 0.03 }));
  if (near) {
    for (let i = 0; i < 5; i++) {
      const a = rng() * TAU;
      const len = H * (0.06 + rng() * 0.06);
      tp.push(place(new THREE.CylinderGeometry(0.012, 0.045, len, 4, 1, true), {
        x: Math.cos(a) * len * 0.45, y: H * (0.14 + rng() * 0.3), z: Math.sin(a) * len * 0.45,
        rz: -Math.cos(a) * 1.15, rx: Math.sin(a) * 1.15,
      }));
    }
  }
  const layers = [];
  const n = near ? 10 : 5;
  const baseY = H * 0.11;
  const span = H * (near ? 0.82 : 0.8);
  const spacing = span / n;
  const baseR = H * (near ? 0.2 : 0.215);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    // 逐层随机半径 / 高度 / 偏移：整齐的等距圆锥叠起来就是"纸板圣诞树"，
    // 轮廓线上必须要有抖动，逆光剪影才像真树。
    const R = baseR * Math.pow(1 - t, 1.22) * (0.86 + rng() * 0.3) + H * 0.014;
    const lh = spacing * (1.42 + rng() * 0.58);
    const layerGeo = new THREE.CylinderGeometry(R * (0.34 + rng() * 0.24), R, lh, seg, 1, true);
    organicLayer(layerGeo, rng, { radiusJitter: near ? 0.15 : 0.1, droop: near ? 0.22 : 0.13, waves: near ? 3 : 2 });
    layers.push(place(layerGeo, {
      y: baseY + i * spacing + lh * 0.5, ry: rng() * TAU,
      rz: (rng() - 0.5) * 0.07, rx: (rng() - 0.5) * 0.05,
      x: (rng() - 0.5) * 0.17, z: (rng() - 0.5) * 0.17,
    }));
  }
  layers.push(place(new THREE.ConeGeometry(baseR * 0.2 + H * 0.01, span * 0.24, seg, 1, true), { y: H * 0.96 }));
  return { trunk: merge(tp), foliage: merge(layers), height: H };
}

/** 松树：长裸干 + 顶部伞状层 */
function buildPine(variant, near) {
  const rng = makeRng(2207 + variant * 733);
  const H = near ? (13 + rng() * 2.6) : (11.5 + rng() * 2);
  const seg = near ? 13 : 6;
  const trunkR = H * (near ? 0.017 : 0.018);
  const bare = H * (near ? 0.62 : 0.6);
  const tp = [place(new THREE.CylinderGeometry(trunkR * 0.62, trunkR * 1.25, bare + H * 0.1, near ? 9 : 5, near ? 2 : 1), { y: (bare + H * 0.1) * 0.5 })];
  tp.push(place(new THREE.CylinderGeometry(trunkR * 0.3, trunkR * 0.62, H * 0.42, near ? 7 : 4, 1), { y: bare + H * 0.3 }));
  if (near) {
    for (let i = 0; i < 4; i++) {
      const a = rng() * TAU;
      const len = H * (0.1 + rng() * 0.08);
      tp.push(place(new THREE.CylinderGeometry(0.02, 0.06, len, 4, 1, true), {
        x: Math.cos(a) * len * 0.45, y: bare - H * (0.03 + rng() * 0.16), z: Math.sin(a) * len * 0.45,
        rz: -Math.cos(a) * 1.05, rx: Math.sin(a) * 1.05,
      }));
    }
  }
  const crown = [];
  const R = H * (near ? 0.25 : 0.26);
  const tiers = [
    { r: R, y: bare + H * 0.02, h: H * 0.11 },
    { r: R * 0.78, y: bare + H * 0.11, h: H * 0.1 },
    { r: R * 0.55, y: bare + H * 0.2, h: H * 0.095 },
    { r: R * 0.3, y: bare + H * 0.29, h: H * 0.09 },
  ];
  for (const t of tiers) {
    const tierGeo = new THREE.ConeGeometry(t.r, t.h, seg, 1, true);
    organicLayer(tierGeo, rng, { radiusJitter: near ? 0.16 : 0.11, droop: near ? 0.3 : 0.2, waves: 4 });
    crown.push(place(tierGeo, { y: t.y + t.h * 0.5, ry: rng() * TAU, rx: (rng() - 0.5) * 0.08 }));
    if (near) {
      const skirt = new THREE.CylinderGeometry(t.r * 0.97, t.r * 0.62, t.h * 0.34, seg, 1, true);
      organicLayer(skirt, rng, { radiusJitter: 0.13, droop: 0.24, waves: 4 });
      crown.push(place(skirt, { y: t.y + t.h * 0.16 }));
    }
  }
  return { trunk: merge(tp), foliage: merge(crown), height: H };
}

/** 白桦：白色带黑斑树干 + 稀疏浅色树冠（成小丛） */
function buildBirch(variant, near) {
  const rng = makeRng(3301 + variant * 541);
  const H = near ? (12 + rng() * 3) : (10.5 + rng() * 2.4);
  const trunkR = H * (near ? 0.0105 : 0.011);
  const seg = near ? 8 : 5;
  const tp = [];
  tp.push(place(new THREE.CylinderGeometry(trunkR * 0.82, trunkR * 1.35, H * 0.55, seg, 1), { y: H * 0.275 }));
  tp.push(place(new THREE.CylinderGeometry(trunkR * 0.5, trunkR * 0.84, H * 0.5, seg, 1), { x: H * 0.018, z: -H * 0.012, y: H * 0.75, rz: -0.05, rx: 0.035 }));
  if (near) {
    for (let i = 0; i < 5; i++) {
      const a = rng() * TAU;
      const len = H * (0.1 + rng() * 0.1);
      tp.push(place(new THREE.CylinderGeometry(0.008, 0.028, len, 4, 1, true), {
        x: Math.cos(a) * len * 0.5, y: H * (0.5 + rng() * 0.36), z: Math.sin(a) * len * 0.5,
        rz: -Math.cos(a) * 1.1, rx: Math.sin(a) * 1.1,
      }));
    }
  }
  // 树冠：分层球壳分布（底部略空、中上部密），卡片小而多 —— 这是"有细节"与
  // "几张大叶子贴片"的分界线。远景也要保持一定密度，否则逆光时树冠会散架。
  const cards = [];
  const count = near ? 44 : 11;
  const cw = H * (near ? 0.112 : 0.165);
  const cy = H * (near ? 0.79 : 0.77);
  const spread = H * (near ? 0.215 : 0.225);
  for (let i = 0; i < count; i++) {
    const t = i / count;
    const a = i * 2.399963 + rng() * 0.6;                 // 黄金角螺旋：分布均匀不结块
    const shell = near ? 1 : 0.55;
    const r = Math.pow(rng(), 0.62) * spread * (near ? 1 : 0.8);
    const yOff = (Math.pow(rng(), 0.8) - 0.34) * H * (near ? 0.26 : 0.22);
    cards.push(place(new THREE.PlaneGeometry(cw * shell * (0.78 + rng() * 0.5), cw * shell * (0.7 + rng() * 0.55)), {
      x: Math.cos(a) * r, y: cy + yOff, z: Math.sin(a) * r,
      rx: (rng() - 0.5) * 1.15, ry: rng() * TAU, rz: (rng() - 0.5) * 1.15,
    }));
  }
  if (near) {
    for (let i = 0; i < 7; i++) {
      const a = rng() * TAU;
      cards.push(place(new THREE.CylinderGeometry(0.006, 0.018, H * 0.15, 3, 1, true), {
        x: Math.cos(a) * spread * 0.55, y: cy + H * 0.06, z: Math.sin(a) * spread * 0.55,
        rz: -Math.cos(a) * 0.7, rx: Math.sin(a) * 0.7,
      }));
    }
  }
  return { trunk: merge(tp), foliage: merge(cards), height: H };
}

/** 阔叶（枫/橡）：圆润树冠，交叉面片做体积感 */
function buildBroadleaf(variant, near) {
  const rng = makeRng(4409 + variant * 811);
  const H = near ? (9 + rng() * 3.2) : (8 + rng() * 2.6);
  const seg = near ? 9 : 5;
  const trunkR = H * (near ? 0.03 : 0.032);
  const tp = [place(new THREE.CylinderGeometry(trunkR * 0.62, trunkR * 1.2, H * 0.52, seg, 1), { y: H * 0.26 })];
  const forks = near ? 4 : 2;
  for (let i = 0; i < forks; i++) {
    const a = (i / forks) * TAU + rng() * 0.8;
    const len = H * (near ? 0.4 : 0.36) * (0.85 + rng() * 0.3);
    const tilt = near ? 0.62 : 0.55;
    tp.push(place(new THREE.CylinderGeometry(trunkR * 0.24, trunkR * 0.66, len, seg, 1), {
      x: Math.cos(a) * len * 0.34 * tilt, y: H * 0.5 + len * 0.42, z: Math.sin(a) * len * 0.34 * tilt,
      rz: -Math.cos(a) * tilt, rx: Math.sin(a) * tilt,
    }));
  }
  // 圆顶树冠：外层球壳（剪影）+ 内层球壳（体积），卡片小而密
  const cards = [];
  const count = near ? 64 : 16;
  const base = H * (near ? 0.63 : 0.62);
  const rr = H * (near ? 0.34 : 0.35);
  const cw = H * (near ? 0.155 : 0.21);
  for (let i = 0; i < count; i++) {
    const shell = i % 2 === 0 ? 1 : 0.66;                  // 内外两层交替，半径错开
    const a = i * 2.399963 + rng() * 0.5;
    const el = Math.acos(1 - 1.35 * rng());               // 上半球，顶部更密
    const r = Math.pow(rng(), 0.5) * rr * shell;
    cards.push(place(new THREE.PlaneGeometry(cw * shell * (0.8 + rng() * 0.5), cw * shell * (0.72 + rng() * 0.5)), {
      x: Math.cos(a) * Math.sin(el) * r,
      y: base + Math.cos(el) * r * 0.92,
      z: Math.sin(a) * Math.sin(el) * r,
      rx: (rng() - 0.5) * 1.2, ry: rng() * TAU, rz: (rng() - 0.5) * 1.2,
    }));
  }
  return { trunk: merge(tp), foliage: merge(cards), height: H };
}

/** 枯木：无叶枯枝（前景叙事） */
function buildDead(variant, near) {
  const rng = makeRng(5501 + variant * 617);
  const H = 7 + rng() * 4;
  const seg = near ? 7 : 4;
  const trunkR = H * 0.038;
  const tp = [place(new THREE.CylinderGeometry(trunkR * 0.5, trunkR * 1.5, H, seg, 1), { y: H * 0.5, rz: 0.1, rx: -0.05 })];
  for (let i = 0; i < 6; i++) {
    const a = rng() * TAU;
    const len = H * (0.14 + rng() * 0.2);
    tp.push(place(new THREE.CylinderGeometry(0.008, trunkR * 0.5, len, 3, 1, true), {
      x: Math.cos(a) * len * 0.45, y: H * (0.3 + rng() * 0.6), z: Math.sin(a) * len * 0.45,
      rz: -Math.cos(a) * (0.8 + rng() * 0.7), rx: Math.sin(a) * (0.8 + rng() * 0.7),
    }));
  }
  return { trunk: merge(tp), foliage: null, height: H };
}

/** 远景树墙：极低模（树干 + 锥体树冠合并，单材质）。
 *  刻意压到 9~15m：树墙站在环山（那圈地面已经 y≈24~30m）上，
 *  太高会挡住高空俯瞰机位，所以只做「林线」轮廓。 */
function buildWallTree(variant) {
  const rng = makeRng(6607 + variant * 331);
  const H = 8 + rng() * 5;
  const parts = [place(new THREE.CylinderGeometry(H * 0.008, H * 0.014, H, 5, 1), { y: H * 0.5 })];
  for (let i = 0; i < 3; i++) {
    const t = i / 3;
    const R = H * 0.19 * Math.pow(1 - t, 1.15) + H * 0.01;
    parts.push(place(new THREE.ConeGeometry(R, H * 0.36, 5, 1, true), { y: H * (0.22 + t * 0.28) + H * 0.18, ry: rng() * TAU }));
  }
  return merge(parts);
}

/* =========================================================================
 * 4. 主入口
 * ========================================================================= */
export function createForest(opt = {}) {
  const quality = opt.quality || {};
  const camera = opt.camera || null;
  const density = quality.treeDensity || 1;
  const grassDensity = quality.grassDensity || 1;
  const grassDistance = quality.grassDistance || 68;
  const aniso = quality.anisotropy || 8;
  const rng = makeRng(20251018);

  const group = new THREE.Group();
  group.name = 'forest';
  const CLEAR = CLEARING.center;

  /* ------------------------------------------------ 4.1 材质 */
  const needleMat = new THREE.MeshStandardMaterial({
    map: repeatOf(toTexture(makeNeedleCanvas(256, 31), { aniso }), 2.4, 2.2),
    normalMap: repeatOf(getNormal('bark', 0.7, { size: 256 }), 2.4, 2.2),
    normalScale: new THREE.Vector2(0.35, 0.35),
    // makeNeedleCanvas 现在自己就是深绿反照率（#2f4230 底 + 暗绿针叶笔触），
    // 所以 material.color 必须保持白色；再乘暗色就是「暗 × 暗」近乎全黑。
    color: 0xffffff, roughness: 0.9, metalness: 0, side: THREE.DoubleSide, flatShading: false,
  });
  applyTranslucency(needleMat, 0xffd7a0, { power: 2.6, wrap: 0.3 });
  applyWindSway(needleMat, { strength: 0.05, speed: 0.55, height: 15, twist: 0.45, gust: 0.4 });

  const barkMat = new THREE.MeshStandardMaterial({
    map: repeatOf(getTexture('bark', { size: 512 }), 1.4, 2.6),
    normalMap: repeatOf(getNormal('bark', 1.3, { size: 512 }), 1.4, 2.6),
    normalScale: new THREE.Vector2(0.9, 0.9),
    color: 0xffffff, roughness: 0.95, metalness: 0,
  });
  // 树干也给一点点透射：逆光时树干是暖色轮廓而不是纯黑剪影，层次立刻出来
  applyTranslucency(barkMat, 0xffc189, { power: 1.9, wrap: 0.45, gain: 0.30 });
  const birchMat = new THREE.MeshStandardMaterial({
    map: repeatOf(getTexture('birch', { size: 512 }), 1.3, 2.4),
    normalMap: repeatOf(getNormal('birch', 0.8, { size: 512 }), 1.3, 2.4),
    normalScale: new THREE.Vector2(0.55, 0.55),
    color: 0xffffff, roughness: 0.82, metalness: 0,
  });
  applyTranslucency(birchMat, 0xffe2b4, { power: 1.9, wrap: 0.45, gain: 0.34 });
  const leafBroadMat = new THREE.MeshStandardMaterial({
    map: getTexture('leafCard', { color: '#41602c', count: 210, spread: 0.95, leafScale: 1.0, seed: 8123 }),
    alphaTest: 0.34, side: THREE.DoubleSide, roughness: 0.9, metalness: 0, color: 0xffffff,
  });
  applyTranslucency(leafBroadMat, 0xffcf8e, { power: 2.4, wrap: 0.3 });
  applyWindSway(leafBroadMat, { strength: 0.07, speed: 0.62, height: 6.5, twist: 0.5, gust: 0.45 });

  const leafBirchMat = new THREE.MeshStandardMaterial({
    map: getTexture('leafCard', { color: '#55682f', count: 150, spread: 0.9, leafScale: 0.92, seed: 3391 }),
    alphaTest: 0.32, side: THREE.DoubleSide, roughness: 0.9, metalness: 0, color: 0xffffff,
  });
  applyTranslucency(leafBirchMat, 0xffe0a8, { power: 2.2, wrap: 0.32 });
  applyWindSway(leafBirchMat, { strength: 0.075, speed: 0.7, height: 9, twist: 0.5, gust: 0.5 });

  const leafBases = [needleMat, leafBroadMat, leafBirchMat].map((m) => ({ m, base: m.color.clone() }));

  /* ------------------------------------------------ 4.2 树木放置 */
  const TYPES = [
    { key: 'spruce', variants: 2, build: buildSpruce, trunkStyle: 'bark' },
    { key: 'pine', variants: 1, build: buildPine, trunkStyle: 'bark' },
    { key: 'birch', variants: 1, build: buildBirch, trunkStyle: 'birch' },
    { key: 'broad', variants: 2, build: buildBroadleaf, trunkStyle: 'bark' },
    { key: 'dead', variants: 1, build: buildDead, trunkStyle: 'bark' },
  ];
  const typeRoll = [];
  for (const [t, w] of [[TYPES[0], 42], [TYPES[1], 13], [TYPES[2], 17], [TYPES[3], 26], [TYPES[4], 2]]) {
    for (let i = 0; i < w; i++) typeRoll.push(t);
  }

  const geoCache = new Map();
  function treeGeo(typeKey, variant, near) {
    const type = TYPES.find((t) => t.key === typeKey);
    const k = `${typeKey}|${variant}|${near ? 'n' : 'f'}`;
    let g = geoCache.get(k);
    if (!g) {
      g = type.build(variant, near);
      // 远模：树干并入树冠几何（单 draw call）。白桦例外，白色树干是识别特征。
      if (!near && type.trunkStyle !== 'birch' && g.foliage) {
        g = { trunk: null, foliage: merge([g.trunk, g.foliage]), height: g.height };
      }
      geoCache.set(k, g);
    }
    return g;
  }

  const treeSlots = new Map();
  const slot = (k) => {
    let a = treeSlots.get(k);
    if (!a) { a = []; treeSlots.set(k, a); }
    return a;
  };
  const treePositions = [];
  let treeCount = 0;

  function densityAt(x, z, s) {
    const clump = fbm(x * 0.0155 + 11.3, z * 0.0155 - 4.2, 3) * 0.5 + 0.5;
    let d = clamp(0.16 + clump * 1.18, 0, 1);
    d *= 1 - 0.45 * (1 - smoothstep(2.4, 8.5, s.pathDist));            // 小径视觉走廊
    if (s.cabinDist < 78) {                                            // 建立镜头方向留白
      const ang = Math.atan2(x - CLEAR.x, z - CLEAR.z);
      const dA = Math.abs(((ang - 0.62 + Math.PI * 3) % TAU) - Math.PI);
      d *= 1 - 0.6 * (1 - smoothstep(0.18, 0.7, dA));
    }
    d *= 1 - 0.35 * (1 - smoothstep(POND.radius, POND.radius * 2.1, s.pondDist));
    return clamp(d, 0.02, 1);
  }

  function placeTree(x, z, type, near, extraScale = 1, terrain = null) {
    const s = terrain || sampleTerrain(x, z);
    const variant = type.variants > 1 ? rng.int(0, type.variants - 1) : 0;
    const sc = (0.75 + rng() * 0.6) * extraScale;
    const geo = treeGeo(type.key, variant, near);
    const t = {
      x, y: s.y - 0.12 * sc, z,
      ry: rng() * TAU, rx: (rng() - 0.5) * 8 * DEG, rz: (rng() - 0.5) * 8 * DEG,
      sx: sc * (0.94 + rng() * 0.12), sy: sc * (0.9 + rng() * 0.22), sz: sc * (0.94 + rng() * 0.12),
    };
    const lod = near ? 'n' : 'f';
    slot(`${type.key}|${variant}|${lod}|foliage`).push({
      ...t,
      // 针叶的色相/饱和扰动给大一点：整片森林同一种绿会立刻显得很「游戏」
      color: tint(rng, 0.15, type.key === 'broad' || type.key === 'birch' ? 0.03 : 0.055, type.key === 'broad' || type.key === 'birch' ? 0.07 : 0.11),
    });
    if (near || type.trunkStyle === 'birch') {
      slot(`${type.key}|${variant}|${lod}|trunk`).push({
        ...t,
        color: tint(rng, 0.1, 0.018, 0.05),
      });
    }
    treePositions.push({ x, z, y: s.y });
    treeCount++;
    return t;
  }

  const target = Math.round(TREE_TARGET * density);
  const targetNear = Math.round(target * 0.34);
  const targetFar = target - targetNear;
  let nearPlaced = 0, farPlaced = 0, attempts = 0;
  const maxAttempts = target * 45;
  while ((nearPlaced < targetNear || farPlaced < targetFar) && attempts < maxAttempts) {
    attempts++;
    const r = 21 + Math.sqrt(rng()) * 79;
    const a = rng() * TAU;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const p = canPlantTree(x, z, 1.5);     // 乔木：额外排除朝阳缺口 SUN_GAP
    if (p.blocked) continue;
    const near = p.cabinDist < 60;
    if (near && nearPlaced >= targetNear) continue;
    if (!near && farPlaced >= targetFar) continue;
    if (rng() > densityAt(x, z, p) * 0.92) continue;
    const type = typeRoll[Math.floor(rng() * typeRoll.length)];
    if (type.key === 'dead' && (!near || treeCount > target * 0.2)) continue;
    placeTree(x, z, type, near, 1, p);
    if (near) nearPlaced++; else farPlaced++;
  }

  /* --- 白桦小丛：向阳坡 3~5 株簇生 --- */
  let clusters = 0;
  const birchType = TYPES[2];
  for (let tries = 0; tries < 1200 && clusters < 7; tries++) {
    const r = 24 + Math.sqrt(rng()) * 56;
    const a = rng() * TAU;
    const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
    const p = canPlantTree(cx, cz, 3.2);
    if (p.blocked || p.slope < 0.035) continue;
    const up = Math.cos(248 * DEG), vp = Math.sin(248 * DEG);
    const gx = (terrainHeight(cx + 1.5, cz) - terrainHeight(cx - 1.5, cz)) / 3;
    const gz = (terrainHeight(cx, cz + 1.5) - terrainHeight(cx, cz - 1.5)) / 3;
    if (-(gx * up + gz * vp) < 0.05) continue;
    let ok = 0;
    for (let i = 0; i < rng.int(3, 5); i++) {
      const ang = rng() * TAU, rr = 1.4 + rng() * 3.4;
      const bx = cx + Math.cos(ang) * rr, bz = cz + Math.sin(ang) * rr;
      const bp = canPlantTree(bx, bz, 1.0);
      if (bp.blocked) continue;
      placeTree(bx, bz, birchType, bp.cabinDist < 60, 1.05, bp);
      if (bp.cabinDist < 60) nearPlaced++; else farPlaced++;
      ok++;
    }
    if (ok >= 3) clusters++;
  }

  /* --- 枯木：前景叙事，固定 2~3 株（偏好小径附近） --- */
  let deadPlaced = 0;
  for (let tries = 0; tries < 5000 && deadPlaced < 3; tries++) {
    const r = 22 + Math.sqrt(rng()) * 26;
    const a = rng() * TAU;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const p = canPlantTree(x, z, 2.2);
    if (p.blocked) continue;
    if (p.pathDist > 14 && rng() < 0.6) continue;
    placeTree(x, z, TYPES[4], true, 0.95 + rng() * 0.35, p);
    nearPlaced++;
    deadPlaced++;
  }

  /* --- 远景树墙：内侧退到 104m 之后，压低矮化，只做「林线」不做实心锥墙 --- */
  const wallTransforms = [];
  const wallCount = Math.round(WALL_TARGET * density);
  for (let i = 0; i < wallCount; i++) {
    const ang = (i / wallCount) * TAU;
    // 低频疏密：有的方位密集成林、有的稀疏露出山体，避免「等距栅栏」
    const dense = fbm(Math.cos(ang) * 2.2 + 5.1, Math.sin(ang) * 2.2 - 3.7, 2) * 0.5 + 0.5;
    if (rng() > 0.28 + dense * 1.05) continue;
    const rows = rng() < 0.4 ? 2 : 1;                 // 前后两排制造纵深
    for (let row = 0; row < rows; row++) {
      const a = ang + (rng() - 0.5) * 0.06;
      const r = 103.5 + rng() * 8 + row * 3.2;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const p = canPlantTree(x, z, 1.2);
      if (p.blocked) continue;
      // 高度 0.55~1.45、冠幅 0.8~1.5：错落而不是一排复制品
      wallTransforms.push({
        x, y: p.y - 0.3, z, ry: rng() * TAU,
        rx: (rng() - 0.5) * 7 * DEG, rz: (rng() - 0.5) * 7 * DEG,
        sx: 0.8 + rng() * 0.7, sy: 0.55 + rng() * 0.9, sz: 0.8 + rng() * 0.7,
        color: tint(rng, 0.3, 0.04, 0.1),
      });
      treePositions.push({ x, z, y: p.y });
      treeCount++;
      break;
    }
  }

  /* --- 实例化：近模 = 树干 + 树冠两个 mesh，远模尽量单 mesh --- */
  const nearMeshes = [];
  for (const [key, list] of treeSlots) {
    const [typeKey, variantS, lod, part] = key.split('|');
    const near = lod === 'n';
    const geo = treeGeo(typeKey, variantS | 0, near);
    const g = part === 'trunk' ? geo.trunk : geo.foliage;
    if (!g) continue;
    const type = TYPES.find((t) => t.key === typeKey);
    let mat;
    if (part === 'trunk') mat = type.trunkStyle === 'birch' ? birchMat : barkMat;
    else mat = (typeKey === 'spruce' || typeKey === 'pine') ? needleMat : (typeKey === 'birch' ? leafBirchMat : leafBroadMat);
    const mesh = instanced(g, mat, list, {
      name: `forest-${key}`,
      shadows: part === 'foliage' && near,   // 树干投影意义不大，省 shadow pass
      receive: true,
    });
    if (mesh) {
      group.add(mesh);
      if (near) nearMeshes.push(mesh);
    }
  }
  const wallMesh = instanced(buildWallTree(0), needleMat, wallTransforms, { name: 'forest-treewall', shadows: false });
  if (wallMesh) group.add(wallMesh);

  /* ------------------------------------------------ 4.3 地被 */
  const add = (m) => { if (m) { group.add(m); return m; } return null; };

  /* --- 灌木 --- */
  const shrubMat = new THREE.MeshStandardMaterial({
    map: repeatOf(getTexture('leafCard', { color: '#3a5226', count: 150, spread: 0.98, leafScale: 1.5 }), 1.3, 1.1),
    alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.92, metalness: 0, color: 0xffffff,
  });
  applyTranslucency(shrubMat, 0xffd9a2, { power: 3.4 });
  applyWindSway(shrubMat, { strength: 0.06, speed: 0.9, height: 1.05, twist: 0.5, gust: 0.5 });
  const shrubGeo = merge([
    place(new THREE.PlaneGeometry(1.35, 1.0), { y: 0.5 }),
    place(new THREE.PlaneGeometry(1.35, 1.0), { y: 0.5, ry: Math.PI / 3 }),
    place(new THREE.PlaneGeometry(1.35, 1.0), { y: 0.5, ry: -Math.PI / 3, rx: 0.16 }),
  ]);
  const shrubList = [];
  for (let tries = 0; tries < 26000 && shrubList.length < 900; tries++) {
    const r = 19 + Math.sqrt(rng()) * 88;
    const a = rng() * TAU;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const p = placement(x, z, 0.7);
    if (p.blocked) continue;
    const clump = fbm(x * 0.05 + 21.1, z * 0.05 - 8.8, 2) * 0.5 + 0.5;
    if (rng() > 0.25 + clump * 0.95) continue;
    const sc = 0.5 + rng() * 1.0;
    shrubList.push({
      x, y: p.y - 0.06, z, ry: rng() * TAU, rx: (rng() - 0.5) * 0.16, rz: (rng() - 0.5) * 0.16,
      s: sc, sy: sc * (0.75 + rng() * 0.4),
      color: tint(rng, 0.16, 0.03, 0.08),
    });
  }
  add(instanced(shrubGeo, shrubMat, shrubList, { name: 'forest-shrubs', shadows: false }));

  /* --- 蕨类 --- */
  const fernMat = new THREE.MeshStandardMaterial({
    map: toTexture(makeFernCanvas(256), { aniso }),
    alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.93, metalness: 0, color: 0xffffff,
  });
  applyTranslucency(fernMat, 0xffd9a0, { power: 3.2 });
  applyWindSway(fernMat, { strength: 0.05, speed: 0.85, height: 0.75, twist: 0.45, gust: 0.5 });
  const fernGeo = merge([
    place(new THREE.PlaneGeometry(1.5, 0.75), { y: 0.36 }),
    place(new THREE.PlaneGeometry(1.5, 0.75), { y: 0.36, ry: Math.PI / 2 }),
  ]);
  const fernList = [];
  for (let tries = 0; tries < 22000 && fernList.length < 620; tries++) {
    const r = 20 + Math.sqrt(rng()) * 80;
    const a = rng() * TAU;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const p = placement(x, z, 0.6);
    if (p.blocked) continue;
    if (rng() > 0.2 + (1 - smoothstep(0.05, 0.5, p.slope)) * 0.85) continue;
    const sc = 0.6 + rng() * 0.9;
    fernList.push({
      x, y: p.y - 0.04, z, ry: rng() * TAU, rz: (rng() - 0.5) * 0.12,
      s: sc, sy: sc * (0.85 + rng() * 0.3),
      color: tint(rng, 0.14, 0.025, 0.08),
    });
  }
  add(instanced(fernGeo, fernMat, fernList, { name: 'forest-ferns', shadows: false }));

  /* --- 苔藓斑 --- */
  const mossMat = new THREE.MeshStandardMaterial({
    map: toTexture(makeMossCanvas(128), { aniso }),
    alphaTest: 0.35, side: THREE.DoubleSide, roughness: 1.0, metalness: 0, color: 0xffffff,
  });
  const mossGeo = new THREE.PlaneGeometry(1, 1);
  mossGeo.rotateX(-Math.PI / 2);
  const mossList = [];
  for (let tries = 0; tries < 26000 && mossList.length < 1500; tries++) {
    const r = 18 + Math.sqrt(rng()) * 90;
    const a = rng() * TAU;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const p = placement(x, z, 0.5);
    if (p.blocked) continue;
    if (rng() > 0.2 + (1 - smoothstep(0.0, 1.6, p.slope)) * 0.9) continue;
    const sc = 0.7 + rng() * 1.5;
    mossList.push({
      x, y: p.y + 0.03, z, ry: rng() * TAU,
      sx: sc, sy: 1, sz: sc * (0.8 + rng() * 0.5),
      color: tint(rng, 0.18, 0.03, 0.1),
    });
  }
  add(instanced(mossGeo, mossMat, mossList, { name: 'forest-moss', shadows: false }));

  /* --- 小野花 --- */
  const flowerMat = new THREE.MeshStandardMaterial({
    map: toTexture(makeFlowerCanvas(64), { aniso }),
    alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.85, metalness: 0, color: 0xffffff,
  });
  applyWindSway(flowerMat, { strength: 0.04, speed: 1.1, height: 0.3, twist: 0.4, gust: 0.5 });
  const flowerGeo = merge([
    place(new THREE.PlaneGeometry(0.3, 0.3), { y: 0.15 }),
    place(new THREE.PlaneGeometry(0.3, 0.3), { y: 0.15, ry: Math.PI / 2 }),
  ]);
  const flowerColors = [0xf2f0e2, 0xf0d878, 0xbea6d8, 0xf0e6c0, 0xd8a8c8];
  const flowerList = [];
  for (let tries = 0; tries < 30000 && flowerList.length < 1100; tries++) {
    const r = 20 + Math.sqrt(rng()) * 72;
    const a = rng() * TAU;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const p = placement(x, z, 0.3);
    if (p.blocked) continue;
    const patch = fbm(x * 0.08 - 5.5, z * 0.08 + 2.2, 2) * 0.5 + 0.5;
    if (rng() > patch * patch * 1.1) continue;
    const sc = 0.7 + rng() * 0.9;
    flowerList.push({
      x, y: p.y - 0.02, z, ry: rng() * TAU, rz: (rng() - 0.5) * 0.2,
      s: sc, sy: sc * (0.8 + rng() * 0.5),
      color: tint(rng, 0.12, 0.03, 0.06).multiply(colOf(flowerColors[Math.floor(rng() * flowerColors.length)])),
    });
  }
  add(instanced(flowerGeo, flowerMat, flowerList, { name: 'forest-flowers', shadows: false }));

  /* --- 蘑菇（毒蝇伞成小簇，长在树旁） --- */
  const mushroomMat = new THREE.MeshStandardMaterial({
    map: toTexture(makeMushroomAtlas(256), { aniso }),
    roughness: 0.72, metalness: 0, color: 0xffffff,
  });
  const capGeo = place(remapUV(new THREE.SphereGeometry(0.5, 10, 6, 0, TAU, 0, Math.PI * 0.5), 0.02, 0.52, 0.96, 0.46), { sy: 0.62, y: 0.34 });
  const stemGeo = place(remapUV(new THREE.CylinderGeometry(0.09, 0.14, 0.42, 7, 1), 0.04, 0.04, 0.42, 0.42), { y: 0.21 });
  const mushroomGeo = merge([capGeo, stemGeo]);
  const mushroomList = [];
  for (let tries = 0; tries < 12000 && mushroomList.length < 130; tries++) {
    const r = 20 + Math.sqrt(rng()) * 62;
    const a = rng() * TAU;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const p = placement(x, z, 0.3);
    if (p.blocked) continue;
    // 55% 只出现在树根附近，其余在林下随机
    if (rng() < 0.55) {
      const tree = treePositions[Math.floor(rng() * treePositions.length)];
      if (!tree || Math.hypot(tree.x - x, tree.z - z) > 3.4) continue;
    }
    for (let i = 0; i < rng.int(2, 5) && mushroomList.length < 130; i++) {
      const ang = rng() * TAU, rr = rng() * 0.9;
      const mx = x + Math.cos(ang) * rr, mz = z + Math.sin(ang) * rr;
      const mp = placement(mx, mz, 0.2);
      if (mp.blocked) continue;
      const sc = 0.5 + rng() * 0.85;
      mushroomList.push({
        x: mx, y: mp.y - 0.04, z: mz, ry: rng() * TAU,
        rx: (rng() - 0.5) * 0.22, rz: (rng() - 0.5) * 0.22,
        sx: sc * (0.85 + rng() * 0.3), sy: sc * (0.85 + rng() * 0.4), sz: sc * (0.85 + rng() * 0.3),
        color: tint(rng, 0.12, 0.02, 0.05),
      });
    }
  }
  add(instanced(mushroomGeo, mushroomMat, mushroomList, { name: 'forest-mushrooms', shadows: false }));

  /* --- 岩石 --- */
  const rockMat = new THREE.MeshStandardMaterial({
    map: repeatOf(getTexture('stone', { size: 512 }), 1.6, 1.6),
    normalMap: repeatOf(getNormal('stone', 1.2, { size: 512 }), 1.6, 1.6),
    normalScale: new THREE.Vector2(0.9, 0.9), roughness: 0.95, metalness: 0, color: 0xffffff,
  });
  const rockListA = [], rockListB = [];
  for (let tries = 0; tries < 22000 && rockListA.length + rockListB.length < 360; tries++) {
    const r = 19 + Math.sqrt(rng()) * 88;
    const a = rng() * TAU;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const p = placement(x, z, 0.9);
    if (p.blocked) continue;
    const nearWater = 1 - smoothstep(POND.radius * 0.8, POND.radius * 2.6, p.pondDist);
    const slopeW = smoothstep(0.08, 0.4, p.slope);
    if (rng() > 0.16 + nearWater * 0.75 + slopeW * 0.6) continue;
    const sc = 0.28 + Math.pow(rng(), 1.6) * 2.0;
    const t = {
      x, y: p.y - sc * 0.3, z, ry: rng() * TAU,
      rx: (rng() - 0.5) * 0.7, rz: (rng() - 0.5) * 0.7,
      sx: sc * (0.85 + rng() * 0.45), sy: sc * (0.62 + rng() * 0.4), sz: sc * (0.9 + rng() * 0.5),
      color: tint(rng, 0.2, 0.02, 0.07),
    };
    (rng() < 0.62 ? rockListA : rockListB).push(t);
    if (sc > 1.1) {
      for (let i = 0; i < 2; i++) {
        const ang = rng() * TAU, rr = sc * (0.9 + rng() * 0.8);
        const sx2 = x + Math.cos(ang) * rr, sz2 = z + Math.sin(ang) * rr;
        const sp = placement(sx2, sz2, 0.3);
        if (sp.blocked) continue;
        const s2 = sc * (0.12 + rng() * 0.2);
        rockListB.push({
          x: sx2, y: sp.y - s2 * 0.35, z: sz2, ry: rng() * TAU,
          rx: (rng() - 0.5) * 0.9, rz: (rng() - 0.5) * 0.9,
          sx: s2 * (0.8 + rng() * 0.5), sy: s2 * (0.6 + rng() * 0.4), sz: s2 * (0.9 + rng() * 0.5),
          color: tint(rng, 0.22, 0.02, 0.07),
        });
      }
    }
  }
  add(instanced(rockGeometryLocal(1, 2.1, 0.72), rockMat, rockListA, { name: 'forest-rocks-a' }));
  add(instanced(rockGeometryLocal(1, 7.7, 0.55), rockMat, rockListB, { name: 'forest-rocks-b', shadows: false }));

  /* --- 倒木 / 树桩（年轮端面可见） --- */
  const woodMat = new THREE.MeshStandardMaterial({
    map: toTexture(makeWoodAtlas(512), { aniso }),
    roughness: 0.96, metalness: 0, color: 0xffffff,
  });
  const logGeo = merge([
    place(remapUV(new THREE.CylinderGeometry(0.34, 0.42, 1, 9, 1), 0.01, 0.02, 0.48, 0.96), { rz: Math.PI / 2 }),
    place(remapUV(new THREE.CircleGeometry(0.42, 9), 0.52, 0.52, 0.46, 0.46), { x: 0.5, ry: Math.PI / 2 }),
    place(remapUV(new THREE.CircleGeometry(0.42, 9), 0.52, 0.52, 0.46, 0.46), { x: -0.5, ry: -Math.PI / 2 }),
  ]);
  const stumpGeo = merge([
    place(remapUV(new THREE.CylinderGeometry(0.4, 0.52, 1, 10, 1, true), 0.01, 0.02, 0.48, 0.96), { y: 0.5 }),
    place(remapUV(new THREE.CircleGeometry(0.4, 10), 0.52, 0.52, 0.46, 0.46), { y: 1.0 }),
  ]);
  const logList = [], stumpList = [];
  for (let tries = 0; tries < 12000 && logList.length < 9; tries++) {
    const r = 24 + Math.sqrt(rng()) * 62;
    const a = rng() * TAU;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const p = canPlantTree(x, z, 3.2);
    if (p.blocked) continue;
    logList.push({
      x, y: p.y + 0.22 + rng() * 0.16, z, ry: rng() * TAU,
      rz: Math.PI / 2 + (rng() - 0.5) * 0.06, rx: (rng() - 0.5) * 0.05,
      sx: 3.2 + rng() * 5.4, sy: 0.65 + rng() * 0.75, sz: 0.65 + rng() * 0.75,
      color: tint(rng, 0.16, 0.02, 0.06),
    });
  }
  for (let tries = 0; tries < 14000 && stumpList.length < 22; tries++) {
    const r = 20 + Math.sqrt(rng()) * 76;
    const a = rng() * TAU;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const p = placement(x, z, 0.8);
    if (p.blocked) continue;
    stumpList.push({
      x, y: p.y - 0.1, z, ry: rng() * TAU,
      rx: (rng() - 0.5) * 0.1, rz: (rng() - 0.5) * 0.1,
      sx: 0.8 + rng() * 1.5, sy: 0.45 + rng() * 0.85, sz: 0.8 + rng() * 1.5,
      color: tint(rng, 0.16, 0.02, 0.06),
    });
  }
  add(instanced(logGeo, woodMat, logList, { name: 'forest-logs' }));
  add(instanced(stumpGeo, woodMat, stumpList, { name: 'forest-stumps', shadows: false }));

  /* --- 草簇：最后生成，用剩余三角面额度决定数量 --- */
  const grassMat = new THREE.MeshStandardMaterial({
    map: toTexture(grassCardCanvas(256, 77), { aniso }),
    alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.9, metalness: 0, color: 0xffffff,
  });
  applyWindSway(grassMat, { strength: 0.05, speed: 0.9, height: 0.55, twist: 0.4, gust: 0.5 });
  const GW = 0.66, GH = 0.62;
  const grassGeo = merge([
    place(new THREE.PlaneGeometry(GW * 1.35, GH), { y: GH * 0.5 }),
    place(new THREE.PlaneGeometry(GW * 1.35, GH), { y: GH * 0.5, ry: Math.PI / 2 }),
  ]);
  const grassTris = grassGeo.attributes.position.count / 3;
  const used = statsOf(group).triangles;
  const grassBudget = Math.max(0, Math.floor((TRI_BUDGET - used) * 0.86 / grassTris));
  const grassTarget = Math.min(Math.round(56000 * grassDensity), grassBudget);
  const grassList = [];
  // 半径分布：把草集中到相机真正看得见的 12~46m。摊到 68m 的话同样的实例数
  // 每平米只有 2~3 根，远看就是「高尔夫果岭 + 几点碎草」。
  for (let tries = 0; tries < grassTarget * 3.4 && grassList.length < grassTarget; tries++) {
    const r = 12 + Math.sqrt(rng()) * 34;
    const a = rng() * TAU;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const p = placement(x, z, 0.35);
    if (p.blocked) continue;
    const w = 1 - 0.68 * smoothstep(grassDistance * 0.3, grassDistance, r);
    const clump = fbm(x * 0.11 + 41.5, z * 0.11 - 17.3, 2) * 0.5 + 0.5;
    if (rng() > w * (0.22 + clump * 1.05)) continue;
    const sc = 0.7 + rng() * 0.95;
    grassList.push({
      x, y: p.y - 0.03, z, ry: rng() * TAU, rz: (rng() - 0.5) * 0.2,
      s: sc, sy: sc * (0.85 + rng() * 0.55),
      color: tint(rng, 0.24, 0.035, 0.1),
    });
  }
  // 院子边缘的近景草：placement() 会把整个 clearing 排除掉，导致正面机位
  //（相机离木屋 ~23m）整片前景没有一根草叶。这里用 sampleTerrain 单独补一层
  //「稀疏、矮、成丛」的院子草，只避开木屋脚印、小径与水面，院子里依然留白。
  const yardTarget = Math.round(5200 * clamp(grassDensity, 0.4, 1.4));
  for (let tries = 0; tries < yardTarget * 12 && grassList.length < grassTarget + yardTarget; tries++) {
    const a = rng() * TAU;
    const r = 5.4 + Math.sqrt(rng()) * 17.6;          // 离木屋中心 5.4~23m（正面机位前景）
    const x = CLEAR.x + Math.cos(a) * r, z = CLEAR.z + Math.sin(a) * r;
    const s = sampleTerrain(x, z);
    if (s.pathDist < PATH.halfWidth + 0.75) continue;  // 别长到小径上
    if (s.pondDist < POND.radius * 2.4) continue;      // 别长到池塘盆地里
    if (s.slope > 0.4) continue;
    const patch = fbm(x * 0.29 + 7.7, z * 0.29 - 2.4, 2) * 0.5 + 0.5;   // ~3m 成丛
    if (rng() > patch * patch * 1.15) continue;
    const sc = 0.55 + rng() * 0.72;
    grassList.push({
      x, y: s.y - 0.02, z, ry: rng() * TAU, rz: (rng() - 0.5) * 0.22,
      s: sc, sy: sc * (0.8 + rng() * 0.5),
      color: tint(rng, 0.24, 0.035, 0.1),
    });
  }
  add(instanced(grassGeo, grassMat, grassList, { name: 'forest-grass', shadows: false, pad: 2 }));

  const stats = statsOf(group);

  /* ------------------------------------------------ 4.4 状态 / 每帧 */
  let nearVisible = true;
  let night = 0;
  const _sun = new THREE.Vector3(0.4, 0.3, 0.8);

  function setState(state, t, dt) {
    if (!state) return;
    const d = Math.max(1e-4, dt || 0.016);
    if (state.sunDirection && state.sunDirection.isVector3) _sun.copy(state.sunDirection).normalize();
    else if (state.sun) {
      const az = (state.sun.azimuth === undefined ? 248 : state.sun.azimuth) * DEG;
      const el = (state.sun.elevation === undefined ? 8.5 : state.sun.elevation) * DEG;
      _sun.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
    }
    _sunDirU.value.copy(_sun);
    if (typeof state.nightFactor === 'number') night = damp(night, state.nightFactor, 2.5, d);
    const wind = state.wind ? clamp(state.wind.strength || 0.6, 0.2, 1.4) : 0.8;
    _transU.value = (0.1 + (1 - night) * 0.46) * wind;      // 夜里几乎没有背光透射
    const dark = 1 - night * 0.45;                          // 夜间树叶 albedo 压暗
    for (const it of leafBases) it.m.color.copy(it.base).multiplyScalar(dark);
  }

  function update(t, dt) {
    if (!camera) return;
    const d = Math.hypot(camera.position.x - CLEAR.x, camera.position.z - CLEAR.z);
    if (nearVisible && d > 84) {
      nearVisible = false;
      for (const m of nearMeshes) m.visible = false;
    } else if (!nearVisible && d < 76) {
      nearVisible = true;
      for (const m of nearMeshes) m.visible = true;
    }
  }

  return { group, update, setState, treeCount, stats, clusters, grassCount: grassList.length };
}
