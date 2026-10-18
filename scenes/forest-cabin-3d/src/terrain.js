/**
 * terrain.js — 地形 / 踩踏小径 / 池塘水面 / 岸边细节
 * ---------------------------------------------------------------------------
 * 所有权：forest-builder（task-2）。只允许 import 'three' 与 './core.js'。
 *
 * 设计要点
 *  1. 地面 = PlaneGeometry 逐顶点 terrainHeight()（高 1m 网格），颜色完全由
 *     sampleTerrain() + 高度网格的坡度/局部低洼度驱动（湿绿 / 枯黄 / 踩踏土 / 泥岸）。
 *  2. 小径沿 PATH.points 生成带状 mesh，逐顶点 alpha 向草地渐隐（USE_COLOR_ALPHA），
 *     路中央踩实更亮，附加几何踏步石。
 *  3. 水面是自定义 ShaderMaterial：两层滚动法线双采样 + 菲涅尔天空反射 +
 *     Blinn-Phong 太阳/月亮高光 + 深度着色 + 手写 FogExp2 融合；不使用 transmission。
 *     着色器末尾内联 tonemapping/colorspace chunk，因此「有/无后处理」都色彩正确。
 *  4. 水面轮廓按每个角度二分搜索真实岸线（terrainHeight 与 POND.level 的交点），
 *     并用 aFade 顶点属性在边缘淡出，避免硬边。
 *  5. 所有 InstancedMesh 都自行 computeBoundingSphere()，避免整批被视锥误剔除。
 */
import * as THREE from 'three';
import {
  WORLD, CLEARING, POND, PATH, DOOR, PALETTE,
  clamp, lerp, smoothstep, TAU, makeRng, fbm,
  terrainHeight, sampleTerrain,
  getTexture, getNormal, repeatOf, makeInstanced, mergeGeometriesSimple,
  applyWindSway, sunDirection, damp,
} from './core.js';

/* =========================================================================
 * 0. 小工具
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

const colOf = (hex) => new THREE.Color(hex);

/** #rrggbb → sRGB 分量 0~255。画布像素是 sRGB 数据，不能用 THREE.Color 的
 *  **线性**分量直接写画布（会被二次伽马压暗）；这里统一在 sRGB 空间操作。 */
function hexRGB(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function srgbRgba(hex, mul = 1, toWhite = 0, a = 1) {
  const [r, g, b] = hexRGB(hex);
  const f = (v) => Math.round(Math.min(255, Math.max(0, v * mul * (1 - toWhite) + 255 * toWhite)));
  return `rgba(${f(r)},${f(g)},${f(b)},${a})`;
}

/** 逐实例乘子色（均值 1.0）：亮度 ±dl / 冷暖 ±dh / 饱和 ±ds。
 *  注意 three 里 diffuse = color × map × vertexColor × instanceColor，
 *  所以逐实例色必须是「接近白色」的乘子，不能当 albedo 用，否则会二次变暗。 */
function tint(rng, dl = 0.12, dh = 0.02, ds = 0.06) {
  const m = 1 + (rng() - 0.5) * 2 * dl;
  const h = (rng() - 0.5) * 2 * dh + (rng() - 0.5) * 2 * ds;
  return new THREE.Color(
    clamp(m * (1 + h * 3), 0.3, 1.8),
    clamp(m, 0.3, 1.8),
    clamp(m * (1 - h * 3), 0.3, 1.8)
  );
}

/** 线性亮度钳制，保证 albedo 落在「0.12~0.75 观感」区间内 */
function clampLuma(color, lo = 0.02, hi = 0.46) {
  const l = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
  if (l < 1e-6) return color;
  return color.multiplyScalar(clamp(l, lo, hi) / l);
}

/** InstancedMesh + 逐实例颜色 + 自算包围球 */
function instanced(geo, mat, list, { shadows = true, receive = true, name = '', pad = 0.5 } = {}) {
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

/** 不规则石块：位移是「归一化方向」的纯函数，非索引几何不会撕裂 */
function rockGeometry(detail = 0, seed = 1, squash = 0.72) {
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
 * 1. 水面法线贴图：整数波矢正弦叠加 → 天然无缝、可无限平铺
 * ========================================================================= */
function makeWaterNormalCanvas(size = 128) {
  const { c, g } = canvas2d(size);
  const rng = makeRng(9182736);
  const dirs = [
    [1, 0], [0, 1], [1, 1], [1, -1], [2, 1], [1, 2], [3, 1], [1, 3],
    [2, 3], [3, 2], [4, 1], [1, 4], [3, -2], [2, -3], [5, 2], [2, -5], [6, 1], [1, -6],
  ];
  const waves = dirs.map(([kx, ky]) => {
    const len = Math.hypot(kx, ky);
    return { kx, ky, a: (0.5 + rng() * 0.95) / (len * len * 0.55 + 0.6), ph: rng() * TAU };
  });
  const img = g.createImageData(size, size);
  const strength = 1.3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * TAU, v = (y / size) * TAU;
      let dhdu = 0, dhdv = 0;
      for (let i = 0; i < waves.length; i++) {
        const w = waves[i];
        const cs = Math.cos(w.kx * u + w.ky * v + w.ph) * w.a;
        dhdu += w.kx * cs;
        dhdv += w.ky * cs;
      }
      let nx = -dhdu * strength, ny = -dhdv * strength, nz = 1;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      const i = (y * size + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

/* =========================================================================
 * 2. 芦苇 / 香蒲卡片（基座在画布底边，与 core 的 grassCard 约定一致）
 * ========================================================================= */
function makeReedCanvas(size = 256, seed = 4242) {
  const { c, g } = canvas2d(size);
  g.clearRect(0, 0, size, size);
  const rng = makeRng(seed);
  const cx = size * 0.5;
  for (let i = 0; i < 20; i++) {
    const bx = cx + (rng() - 0.5) * size * 0.62;
    const h = size * (0.5 + rng() * 0.5);
    const bend = (bx - cx) * 0.5 + (rng() - 0.5) * size * 0.34;
    const w = size * (0.008 + rng() * 0.014);
    const base = rng() < 0.32 ? '#8b8c4c' : (rng() < 0.5 ? '#5f7040' : '#4e6136');
    g.fillStyle = srgbRgba(base, 0.62 + rng() * 0.7, 0, 0.7 + rng() * 0.3);
    g.beginPath();
    g.moveTo(bx - w, size);
    g.quadraticCurveTo(bx - w * 0.3 + bend * 0.45, size - h * 0.6, bx + bend, size - h);
    g.quadraticCurveTo(bx + w * 0.5 + bend * 0.45, size - h * 0.55, bx + w, size);
    g.closePath();
    g.fill();
  }
  for (let i = 0; i < 4; i++) {
    const bx = cx + (rng() - 0.5) * size * 0.5;
    const top = size * (0.04 + rng() * 0.1);
    const headY = top + size * (0.1 + rng() * 0.16);
    const col = new THREE.Color('#6d6b3c').multiplyScalar(0.7 + rng() * 0.5);
    g.strokeStyle = srgbRgba('#6d6b3c', 0.7 + rng() * 0.5, 0, 0.95);
    g.lineWidth = Math.max(1.2, size * 0.007);
    g.beginPath();
    g.moveTo(bx, size);
    g.quadraticCurveTo(bx + (rng() - 0.5) * 8, headY + size * 0.2, bx + (rng() - 0.5) * 12, headY);
    g.stroke();
    const hw = size * (0.019 + rng() * 0.012), hh = size * (0.075 + rng() * 0.045);
    const hc = new THREE.Color('#6b4a2c').multiplyScalar(0.75 + rng() * 0.5);
    g.save();
    g.translate(bx + (rng() - 0.5) * 10, headY);
    g.fillStyle = srgbRgba('#6b4a2c', 0.75 + rng() * 0.5, 0, 0.98);
    g.beginPath();
    g.ellipse(0, 0, hw, hh, 0, 0, TAU);
    g.fill();
    for (let k = 0; k < 40; k++) {
      g.fillStyle = srgbRgba('#6b4a2c', 0.75 + rng() * 0.5, 0, 0.16 + rng() * 0.2);
      g.fillRect((rng() - 0.5) * hw * 2, (rng() - 0.5) * hh * 2, 1.4, 1.4);
    }
    g.restore();
  }
  return c;
}

/* =========================================================================
 * 3. 浮萍 / 睡莲小叶
 * ========================================================================= */
function makePadCanvas(size = 128, seed = 7788) {
  const { c, g } = canvas2d(size);
  g.clearRect(0, 0, size, size);
  const rng = makeRng(seed);
  for (let i = 0; i < 7; i++) {
    const r = size * (0.1 + rng() * 0.17);
    const px = size * 0.5 + (rng() - 0.5) * (size * 0.62 - r * 2);
    const py = size * 0.5 + (rng() - 0.5) * (size * 0.62 - r * 2);
    const base = rng() < 0.25 ? '#6f7a3a' : (rng() < 0.5 ? '#4b6231' : '#3d5329');
    g.save();
    g.translate(px, py);
    g.rotate(rng() * TAU);
    g.fillStyle = srgbRgba(base, 0.8 + rng() * 0.5, 0, 0.95);
    g.beginPath();
    g.ellipse(0, 0, r, r * (0.78 + rng() * 0.3), 0, 0.34, TAU + 0.06);
    g.closePath();
    g.fill();
    g.strokeStyle = srgbRgba('#2c3a1c', 1, 0, 0.5);
    g.lineWidth = Math.max(1, size * 0.006);
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(r * 0.85, -r * 0.22);
    g.stroke();
    g.restore();
  }
  return c;
}

/* =========================================================================
 * 4. 水深贴图：把 terrainHeight 烘进一张 R8 贴图供着色器取样
 * ========================================================================= */
function makePondDepthTexture(res = 96, halfExtent = 16) {
  const data = new Uint8Array(res * res);
  const x0 = POND.center.x - halfExtent, z0 = POND.center.z - halfExtent;
  const step = (halfExtent * 2) / (res - 1);
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const d = (POND.level - terrainHeight(x0 + i * step, z0 + j * step)) / POND.depth;
      data[j * res + i] = clamp(Math.round(d * 255), 0, 255);
    }
  }
  const t = new THREE.DataTexture(data, res, res, THREE.RedFormat, THREE.UnsignedByteType);
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return { tex: t, x0, z0, span: halfExtent * 2 };
}

/* =========================================================================
 * 5. 水面着色器
 * ========================================================================= */
const WATER_VERT = /* glsl */`
uniform float uTime;
uniform float uSway;
attribute float aFade;
varying vec3 vWorld;
varying float vFogDepth;
varying float vFade;
void main() {
  vec3 p = position;
  float b = sin( p.x * 0.41 + uTime * 0.83 ) * 0.40
          + sin( p.z * 0.30 - uTime * 0.61 ) * 0.32
          + sin( ( p.x + p.z ) * 0.16 + uTime * 0.44 ) * 0.46;
  p.y += b * uSway;
  vec4 wp = modelMatrix * vec4( p, 1.0 );
  vWorld = wp.xyz;
  vFade = aFade;
  vec4 mv = viewMatrix * wp;
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const WATER_FRAG = /* glsl */`
uniform sampler2D uNormalMap;
uniform sampler2D uDepthMap;
uniform vec2  uMapMin;
uniform vec2  uMapSpan;
uniform float uMaxDepth;
uniform vec3  uTopColor;
uniform vec3  uHorizonColor;
uniform vec3  uShallowColor;
uniform vec3  uDeepColor;
uniform vec3  uMudColor;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform float uSunIntensity;
uniform vec3  uFogColor;
uniform float uFogDensity;
uniform float uTime;
uniform float uFlow;
uniform float uNight;
uniform float uAlpha;
varying vec3 vWorld;
varying float vFogDepth;
varying float vFade;

void main() {
  vec2 muv = clamp( ( vWorld.xz - uMapMin ) / uMapSpan, 0.0, 1.0 );
  float depth = clamp( texture2D( uDepthMap, muv ).r * uMaxDepth, 0.0, uMaxDepth );
  float dN = clamp( depth / uMaxDepth, 0.0, 1.0 );

  vec3 V = normalize( cameraPosition - vWorld );

  // 近岸 / 边缘水更平，避免碎波糊在泥岸上
  float calm = mix( 0.42, 1.0, smoothstep( 0.0, 0.5, dN ) ) * mix( 0.55, 1.0, smoothstep( 0.0, 0.45, vFade ) );

  // 两层反向滚动的法线，UV 偏移双采样
  vec2 flowA = vec2(  0.0205,  0.0132 ) * uTime * uFlow;
  vec2 flowB = vec2( -0.0126,  0.0187 ) * uTime * uFlow * 0.83;
  vec3 nA = texture2D( uNormalMap, vWorld.xz * 0.118 + flowA ).xyz * 2.0 - 1.0;
  vec3 nB = texture2D( uNormalMap, vWorld.xz * 0.066 + flowB ).xyz * 2.0 - 1.0;
  vec3 N = normalize( vec3( ( nA.x + nB.x * 1.12 ) * 0.92 * calm, 1.0, ( nA.y + nB.y * 1.12 ) * 0.92 * calm ) );

  // 菲涅尔：视线越平越反射天空
  float fres = 0.02 + 0.98 * pow( 1.0 - clamp( dot( N, V ), 0.0, 1.0 ), 5.0 );
  vec3 R = reflect( -V, N );
  vec3 skyCol = mix( uHorizonColor, uTopColor, pow( clamp( R.y, 0.0, 1.0 ), 0.62 ) );
  skyCol *= mix( 1.0, 0.40, uNight );

  // 体色：岸边浅褐 → 中心深墨绿，最外圈偏泥
  vec3 body = mix( uShallowColor, uDeepColor, smoothstep( 0.0, 0.78, dN ) );
  body = mix( body, uMudColor, ( 1.0 - smoothstep( 0.0, 0.15, dN ) ) * 0.8 );
  body *= mix( 1.0, 0.30, uNight );

  vec3 col = mix( body, skyCol, clamp( fres * 1.06, 0.0, 1.0 ) );

  // 太阳 / 月亮高光（Blinn-Phong）：黄金时刻拉一道长反光
  vec3 H = normalize( uSunDir + V );
  float ndh = max( dot( N, H ), 0.0 );
  float spec  = pow( ndh, 170.0 ) * 0.62;
  float glint = pow( ndh, 22.0 ) * 0.10;
  col += uSunColor * uSunIntensity * ( spec + glint ) * mix( 0.35, 1.0, dN ) * mix( 0.25, 1.0, vFade );
  col += uSunColor * uSunIntensity * 0.012 * clamp( R.y, 0.0, 1.0 );

  float alpha = uAlpha * mix( 0.04, 0.95, smoothstep( 0.0, 0.22, dN ) );
  alpha = clamp( alpha + fres * 0.42, 0.0, 1.0 );
  alpha *= smoothstep( 0.0, 0.85, vFade ) * vFade;

  float f = 1.0 - exp( -uFogDensity * uFogDensity * vFogDepth * vFogDepth );
  col = mix( col, uFogColor, clamp( f, 0.0, 1.0 ) );

  gl_FragColor = vec4( col, alpha );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* =========================================================================
 * 6. 主入口
 * ========================================================================= */
export function createTerrain(opt = {}) {
  const quality = opt.quality || {};
  const aniso = quality.anisotropy || 8;
  const rng = makeRng(20251018);
  const group = new THREE.Group();
  group.name = 'terrain';

  /* ------------------------------------------------ 6.1 地面网格 + 顶点色 */
  const SEG = WORLD.segments;
  const N = SEG + 1;
  const cell = WORLD.size / SEG;
  const groundGeo = new THREE.PlaneGeometry(WORLD.size, WORLD.size, SEG, SEG);
  groundGeo.rotateX(-Math.PI / 2);
  const gpos = groundGeo.attributes.position;
  const H = new Float32Array(N * N);

  for (let iy = 0; iy < N; iy++) {
    for (let ix = 0; ix < N; ix++) {
      const i = iy * N + ix;
      const h = terrainHeight(gpos.getX(i), gpos.getZ(i));
      H[i] = h;
      gpos.setY(i, h);
    }
  }
  gpos.needsUpdate = true;

  // 可分离盒式模糊 → 局部平均高度：低于周边 = 更湿
  const Hb = new Float32Array(N * N);
  const Hbz = new Float32Array(N * N);
  const R = 5;
  for (let iy = 0; iy < N; iy++) {
    let acc = 0;
    for (let k = -R; k <= R; k++) acc += H[iy * N + clamp(k, 0, N - 1)];
    for (let ix = 0; ix < N; ix++) {
      Hb[iy * N + ix] = acc / (R * 2 + 1);
      acc += H[iy * N + clamp(ix + R + 1, 0, N - 1)] - H[iy * N + clamp(ix - R, 0, N - 1)];
    }
  }
  for (let ix = 0; ix < N; ix++) {
    let acc = 0;
    for (let k = -R; k <= R; k++) acc += Hb[clamp(k, 0, N - 1) * N + ix];
    for (let iy = 0; iy < N; iy++) {
      Hbz[iy * N + ix] = acc / (R * 2 + 1);
      acc += Hb[clamp(iy + R + 1, 0, N - 1) * N + ix] - Hb[clamp(iy - R, 0, N - 1) * N + ix];
    }
  }

  const grassBase = colOf(PALETTE.grass);
  const wetCol = colOf('#38432a');       // 偏暖的湿绿（原 #33452a 发青）
  const dryCol = colOf(PALETTE.grassDry);
  const soilCol = colOf('#7d6a52');      // 院子踩踏：暖褐泥土（原来是冷灰，像水泥）
  const mudCol = colOf('#463a29');
  const rockCol = colOf('#6a6459');
  const colors = new Float32Array(gpos.count * 3);
  const cTmp = new THREE.Color();

  for (let iy = 0; iy < N; iy++) {
    for (let ix = 0; ix < N; ix++) {
      const i = iy * N + ix;
      const x = gpos.getX(i), z = gpos.getZ(i);
      const s = sampleTerrain(x, z);          // 契约：顶点色由 sampleTerrain 驱动
      const h = H[i];

      const hL = H[iy * N + clamp(ix - 1, 0, N - 1)], hR = H[iy * N + clamp(ix + 1, 0, N - 1)];
      const hD = H[clamp(iy - 1, 0, N - 1) * N + ix], hU = H[clamp(iy + 1, 0, N - 1) * N + ix];
      const gx = (hR - hL) / (2 * cell), gz = (hU - hD) / (2 * cell);
      const slope = 1 - 1 / Math.sqrt(1 + gx * gx + gz * gz);

      const wet = smoothstep(0.05, 2.4, Hbz[i] - h);                 // 低洼积水/苔湿
      const dry = smoothstep(0.12, 0.52, slope);                      // 陡坡枯草露土
      // 院子「被踩过」的暖褐泥土：强度封顶 ~0.52（保住残草/碎石），
      // 并用噪声把权重打散，避免形成规整椭圆的水泥地边界。
      const trod = Math.pow(clamp(s.clearing, 0, 1), 1.15);
      const trodN = fbm(x * 0.31 + 2.7, z * 0.31 + 8.4, 3) * 0.5 + 0.5;
      const trodMix = clamp(trod * (0.3 + trodN * 1.3), 0, 1) * 0.52;
      const pack = 1 - smoothstep(PATH.halfWidth * 1.15, PATH.halfWidth * 4.0, s.pathDist);
      const mud = 1 - smoothstep(POND.radius * 0.5, POND.radius * 1.75, s.pondDist);

      cTmp.copy(grassBase);
      cTmp.lerp(wetCol, wet * 0.6);
      cTmp.lerp(dryCol, dry * 0.4);
      cTmp.lerp(soilCol, Math.max(trodMix, pack * 0.42));
      cTmp.lerp(mudCol, mud * 0.78);
      cTmp.lerp(rockCol, smoothstep(16, 30, h) * 0.22 * (0.4 + dry * 0.8));
      // 宏观变化压到 ±16%，细节交给高频噪声与贴图（再压就成「迷彩」大色块）
      const nz = fbm(x * 0.085 + 3.1, z * 0.085 - 1.7, 3) * 0.5 + 0.5;
      const fine = fbm(x * 0.62 + 9.3, z * 0.62 - 4.1, 2) * 0.5 + 0.5;
      cTmp.multiplyScalar(0.84 + nz * 0.3 + fine * 0.14);
      clampLuma(cTmp);
      // 地面贴图本身已经带 PALETTE.grass 级别的 albedo，顶点色输出「乘子」而非 albedo。
      // 绿色偏置：草要偏橄榄绿，B 通道压一点（青绿/teal 就是 B 偏高造成的，Lead P1）。
      colors[i * 3] = clamp((cTmp.r / grassBase.r) * 0.97, 0.26, 1.8);
      colors[i * 3 + 1] = clamp((cTmp.g / grassBase.g) * 1.14, 0.26, 1.8);
      colors[i * 3 + 2] = clamp((cTmp.b / grassBase.b) * 0.86, 0.26, 1.8);
    }
  }
  groundGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  groundGeo.computeVertexNormals();
  groundGeo.computeBoundingSphere();

  // 贴图 repeat 提到 110（≈2.2m 一格）：把 ground 贴图内部的大色斑压成高频噪声，
  // 避免近景出现「迷彩/发霉」的大块低频斑。宏观变化交给顶点色。
  const groundMat = new THREE.MeshStandardMaterial({
    map: repeatOf(getTexture('ground'), 110, 110),
    normalMap: repeatOf(getNormal('ground', 1.4), 110, 110),
    normalScale: new THREE.Vector2(0.85, 0.85),
    vertexColors: true,
    roughness: 0.97,
    metalness: 0,
    dithering: true,
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.name = 'terrain-ground';
  ground.castShadow = false;
  ground.receiveShadow = true;
  group.add(ground);

  /* ------------------------------------------------ 6.2 小径 */
  const pathMesh = buildPath();
  group.add(pathMesh);

  /* ------------------------------------------------ 6.3 门口踏步石 */
  const stepStones = buildStepStones();
  if (stepStones) group.add(stepStones);

  /* ------------------------------------------------ 6.4 水面 */
  const depthMap = makePondDepthTexture(96, 16);
  const water = buildWater(depthMap);
  const wu = water.material.uniforms;
  group.add(water);

  /* ------------------------------------------------ 6.5 岸边细节 */
  const shore = buildShore();
  for (const m of shore.meshes) group.add(m);

  const stats = statsOf(group);

  /* ------------------------------------------------ 6.6 状态 / 每帧 */
  const sunDir = new THREE.Vector3(0.4, 0.35, 0.8).normalize();
  const fogColor = new THREE.Color(0xe5c299);
  const topColor = new THREE.Color(0x38699c);
  const horizonColor = new THREE.Color(0xffd6a2);
  const sunColU = new THREE.Color(0xffb267);
  let fogDensity = 0.0105;
  let sunIntensity = 4.2;
  let night = 0.26;
  let flow = 0.6;
  const _c = new THREE.Color();

  function setState(state, t, dt) {
    if (!state) return;
    const d = Math.max(1e-4, dt || 0.016);
    const k = 1 - Math.exp(-3.5 * d);
    if (state.sky) {
      if (state.sky.top) topColor.lerp(_c.set(state.sky.top), k);
      if (state.sky.horizon) horizonColor.lerp(_c.set(state.sky.horizon), k);
      wu.uTopColor.value.copy(topColor);
      wu.uHorizonColor.value.copy(horizonColor);
    }
    if (state.fog) {
      if (state.fog.color) fogColor.lerp(_c.set(state.fog.color), k);
      if (typeof state.fog.density === 'number') fogDensity = damp(fogDensity, state.fog.density, 3.5, d);
      wu.uFogColor.value.copy(fogColor);
      wu.uFogDensity.value = fogDensity;
    }
    if (state.sunDirection && state.sunDirection.isVector3) sunDir.copy(state.sunDirection).normalize();
    else if (state.sun) sunDirection(state.sun.azimuth === undefined ? 248 : state.sun.azimuth, state.sun.elevation === undefined ? 8.5 : state.sun.elevation, sunDir);
    wu.uSunDir.value.copy(sunDir);
    if (state.sun && state.sun.color) sunColU.lerp(_c.set(state.sun.color), k);
    if (state.sun && typeof state.sun.intensity === 'number') sunIntensity = damp(sunIntensity, state.sun.intensity, 3.5, d);
    wu.uSunColor.value.copy(sunColU);
    wu.uSunIntensity.value = sunIntensity;
    if (typeof state.nightFactor === 'number') night = damp(night, state.nightFactor, 3.5, d);
    wu.uNight.value = night;
    if (state.wind && typeof state.wind.speed === 'number') flow = damp(flow, 0.35 + state.wind.speed * 0.75, 2.5, d);
    wu.uFlow.value = flow;
  }

  const pads = shore.pads;
  const padBase = shore.padBase;
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _v = new THREE.Vector3();

  function update(t) {
    wu.uTime.value = t;
    // 浮萍缓慢漂移 + 自转（≤320 个实例，直接更新矩阵）
    if (pads && padBase.length) {
      for (let i = 0; i < padBase.length; i++) {
        const p = padBase[i];
        const dx = Math.sin(t * 0.11 + p.ph) * 0.5 + Math.sin(t * 0.043 + p.ph * 2.1) * 0.85;
        const dz = Math.cos(t * 0.087 + p.ph * 1.4) * 0.45 + Math.cos(t * 0.037 + p.ph * 3.3) * 0.75;
        _e.set(0, p.ry + t * 0.05, 0);
        _q.setFromEuler(_e);
        _v.set(p.x + dx, POND.level + 0.012, p.z + dz);
        _m.compose(_v, _q, p.s);
        pads.setMatrixAt(i, _m);
      }
      pads.instanceMatrix.needsUpdate = true;
    }
  }

  return {
    group, update, setState, water, stats,
    level: POND.level,
    depthMap,
  };

  /* =======================================================================
   * 内部构造器
   * ===================================================================== */

  function buildPath() {
    const pts = PATH.points;
    const segs = [];
    let total = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.max(2, Math.ceil(len / 0.45));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        segs.push({ x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t), d: total + len * t, s: (i + t) / (pts.length - 1) });
      }
      total += len;
    }
    const last = pts[pts.length - 1];
    segs.push({ x: last.x, z: last.z, d: total, s: 1 });

    const ACROSS = [-1, -0.62, -0.22, 0.22, 0.62, 1];
    const nA = ACROSS.length;
    const verts = [], cols = [], uvs = [], idx = [];

    for (let i = 0; i < segs.length; i++) {
      const p = segs[i];
      const prev = segs[Math.max(0, i - 1)];
      const next = segs[Math.min(segs.length - 1, i + 1)];
      let tx = next.x - prev.x, tz = next.z - prev.z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const nx = -tz, nz = tx;
      const wob = 1 + 0.16 * Math.sin(p.s * 21.3 + 1.2) + 0.1 * Math.sin(p.s * 7.7 - 0.6) + 0.07 * Math.sin(p.d * 0.31);
      const hw = PATH.halfWidth * clamp(wob, 0.72, 1.3);
      for (let j = 0; j < nA; j++) {
        const a = ACROSS[j];
        const x = p.x + nx * hw * a, z = p.z + nz * hw * a;
        verts.push(x, terrainHeight(x, z) + 0.05, z);
        uvs.push(p.d / 1.9, (a * 0.5 + 0.5) * 1.3);
        const edge = Math.abs(a);
        const tread = 1 - smoothstep(0.18, 0.95, edge);
        const grain = fbm(x * 0.5, z * 0.5, 2) * 0.5 + 0.5;
        // gravel 贴图已带 albedo，这里输出乘子：路中央踩实更亮，两侧压暗
        const m = 0.66 + tread * 0.72 + (grain - 0.5) * 0.34;
        const alpha = (1 - smoothstep(0.55, 1.0, edge)) * (0.82 + grain * 0.18);
        cols.push(clamp(m * 1.03, 0.3, 2.0), clamp(m * 0.99, 0.3, 2.0), clamp(m * 0.93, 0.3, 2.0), alpha);
      }
    }
    for (let i = 0; i < segs.length - 1; i++) {
      for (let j = 0; j < nA - 1; j++) {
        const a = i * nA + j, b = a + 1, d = (i + 1) * nA + j, e = d + 1;
        idx.push(a, b, d, b, e, d);     // 法线朝上
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 4));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const mat = new THREE.MeshStandardMaterial({
      map: repeatOf(getTexture('gravel'), 1, 1),
      normalMap: repeatOf(getNormal('gravel', 1.1), 1, 1),
      normalScale: new THREE.Vector2(0.7, 0.7),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      roughness: 0.99,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -1.5,
      polygonOffsetUnits: -2,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'terrain-path';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    return mesh;
  }

  function buildStepStones() {
    const geo = rockGeometry(0, 3.7, 0.34);
    const mat = new THREE.MeshStandardMaterial({
      map: repeatOf(getTexture('stone', { size: 512 }), 1, 1),
      normalMap: repeatOf(getNormal('stone', 1.2, { size: 512 }), 1, 1),
      normalScale: new THREE.Vector2(0.8, 0.8),
      roughness: 0.95, metalness: 0, color: 0xffffff,
    });
    const end = PATH.points[PATH.points.length - 1];
    const list = [];
    for (let i = 0; i < 4; i++) {
      const t = (i + 1) / 5;
      const x = lerp(end.x, DOOR.x, t) + (rng() - 0.5) * 0.5;
      const z = lerp(end.z, DOOR.z, t) + (rng() - 0.5) * 0.5;
      const s = 0.42 + rng() * 0.16;
      list.push({
        x, y: terrainHeight(x, z) + 0.02 - s * 0.18, z,
        ry: rng() * TAU, rx: (rng() - 0.5) * 0.16, rz: (rng() - 0.5) * 0.16,
        sx: s * (0.9 + rng() * 0.35), sy: s * (0.66 + rng() * 0.2), sz: s * (0.95 + rng() * 0.4),
        color: tint(rng, 0.1, 0.02, 0.04),
      });
    }
    for (let i = 0; i < 4; i++) {
      const fi = (0.86 + i * 0.033) * (PATH.points.length - 1);
      const i0 = Math.min(PATH.points.length - 2, Math.floor(fi));
      const f = fi - i0;
      const a = PATH.points[i0], b = PATH.points[i0 + 1];
      const x = lerp(a.x, b.x, f) + (rng() - 0.5) * 0.9;
      const z = lerp(a.z, b.z, f) + (rng() - 0.5) * 0.9;
      const s = 0.34 + rng() * 0.14;
      list.push({
        x, y: terrainHeight(x, z) + 0.02 - s * 0.2, z,
        ry: rng() * TAU, rx: (rng() - 0.5) * 0.2, rz: (rng() - 0.5) * 0.2,
        sx: s * (0.9 + rng() * 0.3), sy: s * (0.6 + rng() * 0.2), sz: s * (0.95 + rng() * 0.35),
        color: tint(rng, 0.1, 0.02, 0.04),
      });
    }
    return instanced(geo, mat, list, { name: 'terrain-stepstones' });
  }

  function buildWater(depth) {
    const SEGS = 128, RINGS = 15;
    const MAXR = POND.radius * 1.22;

    const shores = new Float32Array(SEGS + 1);
    for (let i = 0; i <= SEGS; i++) {
      const a = (i / SEGS) * TAU;
      const dx = Math.cos(a), dz = Math.sin(a);
      let lo = 0.35, hi = 30;
      const outside = terrainHeight(POND.center.x + dx * hi, POND.center.z + dz * hi) >= POND.level;
      if (outside) {
        for (let k = 0; k < 22; k++) {
          const mid = (lo + hi) * 0.5;
          if (terrainHeight(POND.center.x + dx * mid, POND.center.z + dz * mid) < POND.level) lo = mid;
          else hi = mid;
        }
      } else lo = 30;
      shores[i] = Math.min(lo, MAXR);
    }
    const sm = new Float32Array(SEGS + 1);
    for (let i = 0; i <= SEGS; i++) {
      let acc = 0, w = 0;
      for (let k = -3; k <= 3; k++) {
        const ww = 1 - Math.abs(k) / 4;
        acc += shores[clamp(i + k, 0, SEGS)] * ww;
        w += ww;
      }
      sm[i] = acc / w;
    }

    const pos = [], fade = [], index = [];
    for (let j = 0; j <= RINGS; j++) {
      const tt = 1 - Math.pow(1 - j / RINGS, 1.45);
      for (let i = 0; i <= SEGS; i++) {
        const a = (i / SEGS) * TAU;
        const r = sm[i] * tt;
        pos.push(POND.center.x + Math.cos(a) * r, 0, POND.center.z + Math.sin(a) * r);
        fade.push(clamp(1 - smoothstep(0.72, 1.0, tt), 0, 1));
      }
    }
    const row = SEGS + 1;
    for (let j = 0; j < RINGS; j++) {
      for (let i = 0; i < SEGS; i++) {
        const a = j * row + i, b = a + 1, c2 = (j + 1) * row + i, d = c2 + 1;
        index.push(a, b, c2, b, d, c2);   // 法线朝上
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aFade', new THREE.Float32BufferAttribute(fade, 1));
    geo.setIndex(index);
    geo.computeBoundingSphere();

    const normalTex = toTexture(makeWaterNormalCanvas(128), { srgb: false, aniso: Math.min(8, aniso) });

    const uniforms = {
      uTime: { value: 0 },
      uSway: { value: 0.015 },
      uNormalMap: { value: normalTex },
      uDepthMap: { value: depth.tex },
      uMapMin: { value: new THREE.Vector2(depth.x0, depth.z0) },
      uMapSpan: { value: new THREE.Vector2(depth.span, depth.span) },
      uMaxDepth: { value: POND.depth },
      uTopColor: { value: new THREE.Color(0x38699c) },
      uHorizonColor: { value: new THREE.Color(0xffd6a2) },
      uShallowColor: { value: new THREE.Color(0x59503a) },
      uDeepColor: { value: new THREE.Color(0x16261c) },
      uMudColor: { value: new THREE.Color(0x403524) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.3, 0.8).normalize() },
      uSunColor: { value: new THREE.Color(0xffb267) },
      uSunIntensity: { value: 4.2 },
      uFogColor: { value: new THREE.Color(0xe5c299) },
      uFogDensity: { value: 0.0105 },
      uFlow: { value: 0.6 },
      uNight: { value: 0.26 },
      uAlpha: { value: 0.9 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      transparent: true,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'terrain-water';
    mesh.position.y = POND.level;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 2;
    return mesh;
  }

  function buildShore() {
    const meshes = [];
    const wetList = [];
    const shallowList = [];
    for (let i = 0; i < 9000; i++) {
      const a = rng() * TAU;
      const r = 2 + Math.sqrt(rng()) * 16;
      const x = POND.center.x + Math.cos(a) * r;
      const z = POND.center.z + Math.sin(a) * r;
      const s = sampleTerrain(x, z);
      if (s.pondDepth > -0.95 && s.pondDepth < 0.55 && rng() < 0.6) wetList.push({ x, z, y: s.y, pd: s.pondDepth });
      if (s.pondDepth > 0.22 && rng() < 0.5) shallowList.push({ x, z, pd: s.pondDepth });
      if (wetList.length > 620 && shallowList.length > 340) break;
    }

    /* --- 芦苇 / 香蒲（交叉 alpha 卡片） --- */
    const cardW = 1.5, cardH = 2.1;
    const cards = [];
    for (let k = 0; k < 3; k++) {
      const p = new THREE.PlaneGeometry(cardW, cardH);
      p.translate(0, cardH * 0.5 - 0.07, 0);
      p.rotateY((k / 3) * Math.PI);
      cards.push(p);
    }
    const reedGeo = mergeGeometriesSimple(cards);
    const reedMat = new THREE.MeshStandardMaterial({
      map: toTexture(makeReedCanvas(256), { aniso }),
      alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.9, metalness: 0, color: 0xffffff,
    });
    applyWindSway(reedMat, { strength: 0.075, speed: 1.05, height: cardH, twist: 0.42, gust: 0.45 });

    const stemGeo = new THREE.CylinderGeometry(0.022, 0.038, 2.4, 5, 1, true);
    stemGeo.translate(0, 1.2, 0);
    const stemMat = new THREE.MeshStandardMaterial({
      color: 0x8a8a55, roughness: 0.95, metalness: 0,
    });
    applyWindSway(stemMat, { strength: 0.06, speed: 1.05, height: 2.4, twist: 0.42, gust: 0.45 });

    const reedList = [], stemList = [];
    for (let i = 0; i < wetList.length; i++) {
      const p = wetList[i];
      if (rng() > 0.66) continue;
      const submerge = clamp(p.pd + 0.3, 0, 0.45);
      const sc = 0.62 + rng() * 0.75;
      const col = tint(rng, 0.2, 0.03, 0.09);
      const y = p.y - 0.1 - submerge * 0.12;
      reedList.push({ x: p.x, y, z: p.z, ry: rng() * TAU, rz: (rng() - 0.5) * 0.12, s: sc, color: col });
      if (rng() < 0.5) {
        stemList.push({
          x: p.x + (rng() - 0.5) * 0.5, y, z: p.z + (rng() - 0.5) * 0.5,
          ry: rng() * TAU, rx: (rng() - 0.5) * 0.14, rz: (rng() - 0.5) * 0.14,
          s: sc * (0.75 + rng() * 0.5),
          color: tint(rng, 0.16, 0.02, 0.06),
        });
      }
    }
    const reeds = instanced(reedGeo, reedMat, reedList, { name: 'terrain-reeds', shadows: false });
    if (reeds) meshes.push(reeds);
    const stems = instanced(stemGeo, stemMat, stemList, { name: 'terrain-reedstems', shadows: false });
    if (stems) meshes.push(stems);

    /* --- 半浸石块 --- */
    const rockList = [];
    for (const p of wetList) {
      if (rng() > 0.32) continue;
      const sc = 0.3 + rng() * 1.1;
      rockList.push({
        x: p.x, y: p.y - sc * 0.28, z: p.z,
        ry: rng() * TAU, rx: (rng() - 0.5) * 0.5, rz: (rng() - 0.5) * 0.5,
        sx: sc * (0.85 + rng() * 0.4), sy: sc * (0.7 + rng() * 0.35), sz: sc * (0.9 + rng() * 0.45),
        color: tint(rng, 0.18, 0.02, 0.05),
      });
    }
    const rockGeo = rockGeometry(1, 1.3, 0.62);
    const rockMat = new THREE.MeshStandardMaterial({
      map: repeatOf(getTexture('stone', { size: 512 }), 1, 1),
      normalMap: repeatOf(getNormal('stone', 1.25, { size: 512 }), 1, 1),
      normalScale: new THREE.Vector2(0.9, 0.9), roughness: 0.94, metalness: 0, color: 0xffffff,
    });
    const rocks = instanced(rockGeo, rockMat, rockList, { name: 'terrain-shorerocks' });
    if (rocks) meshes.push(rocks);

    /* --- 浮萍 / 睡莲叶 --- */
    const padGeo = new THREE.PlaneGeometry(0.62, 0.62);
    padGeo.rotateX(-Math.PI / 2);
    const padMat = new THREE.MeshStandardMaterial({
      map: toTexture(makePadCanvas(128), { aniso }),
      alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.72, metalness: 0, color: 0xffffff,
    });
    const padList = [], padBase = [];
    const pts = shallowList.slice(0, 320);
    for (const p of pts) {
      const sc = 0.6 + rng() * 1.5;
      const ry = rng() * TAU;
      const scale = new THREE.Vector3(sc * (0.8 + rng() * 0.5), 1, sc * (0.8 + rng() * 0.5));
      padList.push({
        x: p.x, y: POND.level + 0.012, z: p.z, ry,
        sx: scale.x, sy: 1, sz: scale.z,
        color: tint(rng, 0.18, 0.025, 0.08),
      });
      padBase.push({ x: p.x, z: p.z, ry, ph: rng() * TAU, s: scale });
    }
    const pads = instanced(padGeo, padMat, padList, { name: 'terrain-duckweed', shadows: false, pad: 3 });
    if (pads) meshes.push(pads);

    return { meshes, pads, padBase };
  }
}
