/**
 * sky.js — 大气与光照：这是场景里「光从哪来、什么颜色、雾多重」的唯一真相源。
 * ---------------------------------------------------------------
 * 其它模块只读取 state，不写 state。每帧由 main.js 广播给地形 / 植被 / 木屋 / 后处理。
 */
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import {
  TAU, DEG, clamp, lerp, smoothstep, fbm, CLEARING,
} from './core.js';

const COURTYARD = new THREE.Vector3(0, CLEARING.height + 1.2, 0);

/**
 * 六套时段。每套都是完整状态：太阳角度与颜色、环境光、天空散射参数、
 * 雾、曝光、辉光、体积光、粒子配额、夜光强度、风。
 * 数值取向：黄金时刻以暖冷对比为骨架（暖高光 / 青灰暗部），而不是把画面刷亮。
 */
export const TIME_PRESETS = {
  dawn: {
    key: 'dawn', label: '破晓', hint: '06:10 · 冷雾与第一缕暖光',
    sun: { azimuth: 96, elevation: 6, color: '#ffb782', intensity: 3.4, angular: 2.0 },
    ambient: { sky: '#9db4d2', ground: '#57503e', intensity: 1.05 },
    fill: { color: '#8aa6cd', intensity: 0.6, azimuth: 268, elevation: 32 },
    sky: { top: '#2f5280', horizon: '#ffc9a0', ground: '#39424c', turbidity: 6.5, rayleigh: 2.6, mie: 0.006, mieG: 0.82 },
    fog: { color: '#a8b8c8', density: 0.0072 },
    exposure: 1.85,
    bloom: { strength: 0.26, threshold: 1.15, radius: 0.66 },
    volumetric: 0.30,
    grade: { temperature: 0.08, contrast: 1.03, saturation: 0.9, lift: 0.016, vignette: 0.34 },
    night: 0.42,
    wind: 0.5,
  },
  morning: {
    key: 'morning', label: '清晨', hint: '09:00 · 明亮通透',
    sun: { azimuth: 128, elevation: 31, color: '#fff0d4', intensity: 5.0, angular: 1.1 },
    ambient: { sky: '#aecbe8', ground: '#655c48', intensity: 1.0 },
    fill: { color: '#9db8d8', intensity: 0.6, azimuth: 300, elevation: 40 },
    sky: { top: '#3f7ec0', horizon: '#d9e8f4', ground: '#70705f', turbidity: 3.2, rayleigh: 1.4, mie: 0.004, mieG: 0.8 },
    fog: { color: '#c2d4e4', density: 0.0042 },
    exposure: 1.6,
    bloom: { strength: 0.18, threshold: 1.4, radius: 0.58 },
    volumetric: 0.2,
    grade: { temperature: 0.02, contrast: 1.02, saturation: 0.95, lift: 0.012, vignette: 0.26 },
    night: 0.06,
    wind: 0.75,
  },
  golden: {
    key: 'golden', label: '黄金时刻', hint: '17:40 · 低角度暖光斜切林间',
    sun: { azimuth: 38, elevation: 21, color: '#ffd0a2', intensity: 6.4, angular: 1.8 },
    ambient: { sky: '#9fb4cb', ground: '#8a7a5e', intensity: 1.2 },
    fill: { color: '#93abc4', intensity: 1.05, azimuth: 218, elevation: 40 },
    sky: { top: '#3a6d9f', horizon: '#ffd2a0', ground: '#5c4e3c', turbidity: 4.8, rayleigh: 2.4, mie: 0.009, mieG: 0.84 },
    fog: { color: '#c0a382', density: 0.0040 },
    exposure: 2.1,
    bloom: { strength: 0.3, threshold: 1.45, radius: 0.66 },
    volumetric: 0.34,
    grade: { temperature: 0.06, contrast: 1.05, saturation: 0.86, lift: 0.014, vignette: 0.28 },
    night: 0.24,
    wind: 0.6,
  },
  dusk: {
    key: 'dusk', label: '黄昏', hint: '19:05 · 蓝调与暖窗光',
    sun: { azimuth: 274, elevation: 2.6, color: '#ffa276', intensity: 3.6, angular: 2.2 },
    ambient: { sky: '#7a8fbb', ground: '#484338', intensity: 0.9 },
    fill: { color: '#7b96c8', intensity: 0.55, azimuth: 92, elevation: 28 },
    sky: { top: '#22376a', horizon: '#ffb184', ground: '#33343d', turbidity: 9, rayleigh: 3.0, mie: 0.02, mieG: 0.88 },
    fog: { color: '#8c88a0', density: 0.0052 },
    exposure: 2.0,
    bloom: { strength: 0.34, threshold: 1.25, radius: 0.72 },
    volumetric: 0.36,
    grade: { temperature: 0.04, contrast: 1.06, saturation: 0.92, lift: 0.016, vignette: 0.36 },
    night: 0.7,
    wind: 0.45,
  },
  night: {
    key: 'night', label: '月夜', hint: '22:30 · 月光、星空与萤火',
    sun: { azimuth: 300, elevation: 40, color: '#aecaff', intensity: 1.5, angular: 1.4 },
    ambient: { sky: '#4a5c82', ground: '#1c2026', intensity: 0.62 },
    fill: { color: '#48608e', intensity: 0.3, azimuth: 120, elevation: 42 },
    sky: { top: '#050912', horizon: '#16253e', ground: '#0a0e16', turbidity: 2.0, rayleigh: 0.35, mie: 0.002, mieG: 0.8 },
    fog: { color: '#101a2c', density: 0.0062 },
    exposure: 2.7,
    bloom: { strength: 0.5, threshold: 0.95, radius: 0.8 },
    volumetric: 0.3,
    grade: { temperature: -0.12, contrast: 1.08, saturation: 0.9, lift: 0.03, vignette: 0.46 },
    night: 1.0,
    wind: 0.3,
  },
};

export const PRESET_ORDER = ['dawn', 'morning', 'golden', 'dusk', 'night'];

export function sunDirection(azimuthDeg, elevationDeg, out) {
  const a = azimuthDeg * DEG, e = elevationDeg * DEG;
  const ce = Math.cos(e);
  return out.set(Math.sin(a) * ce, Math.sin(e), Math.cos(a) * ce);
}

/* --------------------------------------------------------- 预设插值 */
const SKIP = { sunDirection: 1, sunScreen: 1 };
function copyInto(src, dst) {
  for (const k in src) {
    if (SKIP[k]) continue;
    const v = src[k];
    if (typeof v === 'number' || typeof v === 'string') dst[k] = v;
    else if (v && typeof v === 'object') copyInto(v, dst[k] || (dst[k] = {}));
  }
  return dst;
}
const _ca = new THREE.Color(), _cb = new THREE.Color();
function blendInto(a, b, t, out) {
  for (const k in b) {
    const bv = b[k];
    if (k === 'key' || k === 'label' || k === 'hint') { out[k] = t < 0.5 ? a[k] : bv; continue; }
    if (typeof bv === 'number') out[k] = (a[k] ?? bv) + (bv - (a[k] ?? bv)) * t;
    else if (typeof bv === 'string') { _ca.set(a[k]); _cb.set(bv); out[k] = '#' + _ca.lerp(_cb, t).getHexString(); }
    else if (bv && typeof bv === 'object') blendInto(a[k] || {}, bv, t, out[k] || (out[k] = {}));
    else out[k] = bv;
  }
}
const ease = (x) => { const c = clamp(x, 0, 1); return c * c * (3 - 2 * c); };

/* ------------------------------------------------------------ 云密度贴图 */
function cloudTexture(size, seed) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const d = img.data;
  const sx = 3.1 + (seed % 5) * 0.41, sy = 2.7 + (seed % 3) * 0.57;
  const ox = seed * 13.7, oy = seed * 7.3;
  const F = (u, v) => fbm(u * sx + ox, v * sy + oy, 5, 2.0, 0.52) * 0.5 + 0.5;
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      // 四角混合，保证 wrap 无缝
      const n = F(u, v) * (1 - u) * (1 - v) + F(u - 1, v) * u * (1 - v)
              + F(u, v - 1) * (1 - u) * v + F(u - 1, v - 1) * u * v;
      const a = clamp(0.5 + (n - 0.5) * 2.6, 0, 1);
      const i = (y * size + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = 255;
      d[i + 3] = (a * 255) | 0;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

const CLOUD_VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize( position );
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;
const CLOUD_FRAG = `
uniform sampler2D uMap;
uniform vec2 uDrift;
uniform float uTexel, uScale, uCoverage, uOpacity;
uniform vec3 uShade, uSun, uAmbient, uSunDir;
varying vec3 vDir;
void main() {
  vec3 dir = normalize( vDir );
  float horizon = smoothstep( -0.01, 0.10, dir.y );
  if ( horizon < 0.004 ) discard;
  vec2 uv = ( dir.xz / max( dir.y, 0.045 ) ) * uScale + uDrift;
  float d = texture2D( uMap, uv ).a;
  float dx = texture2D( uMap, uv + vec2( uTexel, 0.0 ) ).a - d;
  float dy = texture2D( uMap, uv + vec2( 0.0, uTexel ) ).a - d;
  float cut = mix( 0.72, 0.06, clamp( uCoverage, 0.0, 1.0 ) );
  float shape = smoothstep( cut, cut + 0.26, d ) * horizon;
  if ( shape < 0.004 ) discard;
  float core = smoothstep( cut + 0.08, cut + 0.46, d );
  // 用密度梯度当假法线：朝太阳的坡面被点亮 → 云有体积，而不是一张贴片
  vec3 n = normalize( vec3( -dx * 9.0, -dy * 9.0, 0.34 ) );
  vec3 L = normalize( vec3( uSunDir.x, -uSunDir.z, max( uSunDir.y, 0.10 ) ) );
  float lit = mix( clamp( dot( n, L ), 0.0, 1.0 ), 1.0, 0.12 );
  vec3 col = mix( uShade, uSun, lit * 0.95 ) + uAmbient * ( 1.0 - lit ) * 0.25;
  col *= mix( 0.88, 1.12, core );
  gl_FragColor = vec4( col, shape * uOpacity * mix( 0.45, 1.0, core ) );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/* ================================================================ 工厂 */
export function createSky(opt = {}) {
  const quality = opt.quality || {};
  const group = new THREE.Group();
  group.name = 'sky';

  // 天穹跟随相机，group 留在世界原点 —— 阴影相机才能钉在院子里而不是跟着跑
  const dome = new THREE.Group();
  dome.name = 'skyDome';
  group.add(dome);

  const skyMesh = new Sky();
  skyMesh.scale.setScalar(450000);
  skyMesh.renderOrder = -1;
  const u = skyMesh.material.uniforms;
  u.showSunDisc.value = 0;    // 日/月轮交给下面的精灵，亮度与大小完全可控
  u.cloudCoverage.value = 0;  // 云用自建的云壳
  u.cloudDensity.value = 0;
  u.cloudSpeed.value = 0;

  const uTintTop = { value: new THREE.Color(1, 1, 1) };
  const uTintHorizon = { value: new THREE.Color(1, 1, 1) };
  const uTintAmt = { value: 0.22 };
  skyMesh.material.onBeforeCompile = (shader) => {
    shader.uniforms.uTintTop = uTintTop;
    shader.uniforms.uTintHorizon = uTintHorizon;
    shader.uniforms.uTintAmount = uTintAmt;
    shader.fragmentShader = 'uniform vec3 uTintTop;\nuniform vec3 uTintHorizon;\nuniform float uTintAmount;\n'
      + shader.fragmentShader.replace(
        'gl_FragColor = vec4( texColor, 1.0 );',
        `vec3 skyTint = mix( uTintHorizon, uTintTop, smoothstep( -0.02, 0.55, direction.y ) );
         texColor *= mix( vec3( 1.0 ), skyTint, uTintAmount );
         gl_FragColor = vec4( texColor, 1.0 );`,
      );
  };
  dome.add(skyMesh);

  /* 云壳（半球，用壳而不是水平面，避免被相机远平面裁掉） */
  const clouds = [];
  for (const cfg of [
    { radius: quality.far * 0.78, altitude: 118, tile: 430, speed: 1.0, dir: [0.93, 0.37], seed: 17, size: 256, opacity: 0.92 },
    { radius: quality.far * 0.9, altitude: 215, tile: 1450, speed: 1.5, dir: [0.52, -0.85], seed: 41, size: 192, opacity: 0.4 },
  ]) {
    const geo = new THREE.SphereGeometry(Math.max(90, cfg.radius), 40, 20, 0, TAU, 0, Math.PI * 0.56);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: cloudTexture(cfg.size, cfg.seed) },
        uDrift: { value: new THREE.Vector2(cfg.seed * 0.37, cfg.seed * 0.11) },
        uTexel: { value: 1 / cfg.size },
        uScale: { value: cfg.altitude / cfg.tile },
        uCoverage: { value: 0.5 },
        uOpacity: { value: cfg.opacity },
        uShade: { value: new THREE.Color(0.3, 0.32, 0.36) },
        uSun: { value: new THREE.Color(1, 0.8, 0.6) },
        uAmbient: { value: new THREE.Color(0.1, 0.12, 0.15) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      },
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    dome.add(mesh);
    clouds.push({ cfg, mesh, mat });
  }

  /* 日轮 / 月轮辉光：参与深度测试，被树或木屋挡住就不该糊在画面前面 */
  const glowTex = (opt.texture)('glow', { size: 128 });
  const glowDist = Math.min((quality.far || 400) * 0.82, 360);
  const makeSprite = (tex, colorMul) => {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, color: new THREE.Color(colorMul, colorMul, colorMul),
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.AdditiveBlending, fog: false, toneMapped: true,
    }));
    sp.renderOrder = 2;
    sp.frustumCulled = false;
    dome.add(sp);
    return sp;
  };
  const sunHalo = makeSprite(glowTex, 1);
  const sunCore = makeSprite(glowTex, 1);
  const moonDisc = makeSprite(glowTex, 1);

  /* 星空：夜间淡入 */
  const starGeo = new THREE.BufferGeometry();
  {
    const N = 900;
    const pos = new Float32Array(N * 3);
    const sz = new Float32Array(N);
    const rng = (() => { let a = 12345; return () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296); })();
    for (let i = 0; i < N; i++) {
      const uu = rng(), vv = rng() * 0.92 + 0.02;
      const th = uu * TAU, ph = Math.acos(1 - vv);
      const r = 380;
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.cos(ph);
      pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
      sz[i] = 0.6 + rng() * rng() * 3.4;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    starGeo.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
  }
  const starMat = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0 }, uTex: { value: (opt.texture)('dust', { size: 64 }) } },
    vertexShader: `
      attribute float aSize; varying float vS;
      void main(){ vS = aSize; gl_PointSize = aSize; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      uniform sampler2D uTex; uniform float uOpacity; varying float vS;
      void main(){
        vec4 t = texture2D( uTex, gl_PointCoord );
        gl_FragColor = vec4( vec3( 0.85, 0.9, 1.0 ) * ( 0.4 + vS * 0.25 ), t.a * uOpacity * ( 0.35 + vS * 0.2 ) );
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const stars = new THREE.Points(starGeo, starMat);
  stars.frustumCulled = false;
  dome.add(stars);

  /* 光 */
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.castShadow = quality.shadows !== false;
  const sm = quality.shadowMap || 2048;
  sun.shadow.mapSize.set(sm, sm);
  sun.shadow.radius = quality.shadowRadius ?? 2;
  sun.shadow.normalBias = 0.04;
  sun.shadow.bias = -0.0004;
  const EXT = 34;
  Object.assign(sun.shadow.camera, { left: -EXT, right: EXT, top: EXT, bottom: -EXT, near: 8, far: 260 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.target.position.copy(COURTYARD);
  group.add(sun, sun.target);

  const hemi = new THREE.HemisphereLight(0x8fa8c4, 0x4a4436, 0.6);
  group.add(hemi);

  const fill = new THREE.DirectionalLight(0x8fa9c4, 0.4);
  fill.target.position.copy(COURTYARD);
  group.add(fill, fill.target);

  /* 状态机 */
  const initial = TIME_PRESETS[opt.preset] ? opt.preset : 'golden';
  const state = { sunDirection: new THREE.Vector3(0, 1, 0) };
  copyInto(TIME_PRESETS[initial], state);
  const sunScreen = { x: 0, y: 0, visible: false, strength: 0 };
  state.sunScreen = sunScreen;
  const from = {};
  copyInto(state, from);
  let target = TIME_PRESETS[initial];
  let presetName = initial;
  let blend = 1;

  const _dir = new THREE.Vector3();
  const _camDir = new THREE.Vector3();
  const _ndc = new THREE.Vector3();
  const _c1 = new THREE.Color(), _c2 = new THREE.Color();
  const HALO_RED = new THREE.Color('#ff5c1f');

  /** 亮度中性的色相倾向：只改色相不改整体亮度 */
  function tint(dst, hex, amount) {
    _c1.set(hex);
    const lum = Math.max(0.2126 * _c1.r + 0.7152 * _c1.g + 0.0722 * _c1.b, 0.004);
    const k = 1 / lum;
    dst.setRGB(
      1 + (clamp(_c1.r * k, 0, 3) - 1) * amount,
      1 + (clamp(_c1.g * k, 0, 3) - 1) * amount,
      1 + (clamp(_c1.b * k, 0, 3) - 1) * amount,
    );
  }

  function updateSunScreen(camera) {
    if (!camera) { sunScreen.visible = false; sunScreen.strength = 0; return; }
    camera.getWorldDirection(_camDir);
    const facing = _camDir.dot(state.sunDirection);
    _ndc.copy(camera.position).addScaledVector(state.sunDirection, glowDist).project(camera);
    const r = Math.hypot(_ndc.x, _ndc.y);
    sunScreen.x = _ndc.x;
    sunScreen.y = _ndc.y;
    sunScreen.visible = facing > 0.02 && _ndc.z < 1 && Math.abs(_ndc.x) <= 1.4 && Math.abs(_ndc.y) <= 1.4;
    sunScreen.strength = clamp(smoothstep(0.0, 0.5, facing) * (1 - smoothstep(0.35, 1.35, r)), 0, 1);
  }

  function update(t, dt, camera) {
    const step = Math.min(dt > 0 ? dt : 0, 0.1);
    if (blend < 1) {
      blend = Math.min(1, blend + step / 1.8);
      if (blend >= 1) copyInto(target, state); else blendInto(from, target, ease(blend), state);
    }

    const night = clamp(state.night, 0, 1);
    const moon = smoothstep(0.84, 1.0, night);
    sunDirection(state.sun.azimuth, state.sun.elevation, state.sunDirection);

    // 天穹
    u.turbidity.value = state.sky.turbidity;
    u.rayleigh.value = state.sky.rayleigh;
    u.mieCoefficient.value = state.sky.mie;
    u.mieDirectionalG.value = state.sky.mieG;
    u.sunPosition.value.copy(state.sunDirection);
    const amt = 0.2 + 0.26 * night;
    uTintAmt.value = amt;
    tint(uTintTop.value, state.sky.top, amt);
    tint(uTintHorizon.value, state.sky.horizon, amt);

    // 平行光
    sun.position.copy(state.sunDirection).multiplyScalar(90).add(COURTYARD);
    sun.color.set(state.sun.color);
    sun.intensity = state.sun.intensity;
    hemi.color.set(state.ambient.sky);
    hemi.groundColor.set(state.ambient.ground);
    hemi.intensity = clamp(state.ambient.intensity * 1.9, 0.1, 3.0);
    sunDirection(state.fill.azimuth, state.fill.elevation, _dir);
    fill.position.copy(_dir).multiplyScalar(70).add(COURTYARD);
    fill.color.set(state.fill.color);
    fill.intensity = state.fill.intensity * 1.25;

    // 云
    _c1.set(state.sky.ground).multiplyScalar(0.6);
    for (let i = 0; i < clouds.length; i++) {
      const L = clouds[i], cu = L.mat.uniforms;
      cu.uCoverage.value = clamp(1 - state.fog.density * 55, 0.15, 0.92);
      cu.uOpacity.value = L.cfg.opacity;
      cu.uSunDir.value.copy(state.sunDirection);
      cu.uShade.value.copy(_c1);
      _c2.set(state.sky.horizon).lerp(HALO_RED, 0.25).multiplyScalar(0.9 + night * 0.4);
      cu.uSun.value.copy(_c2);
      cu.uAmbient.value.set(state.ambient.sky).multiplyScalar(0.18);
      const rate = (0.35 + state.wind * 2.4) * L.cfg.speed / L.cfg.tile;
      cu.uDrift.value.x += L.cfg.dir[0] * rate * step;
      cu.uDrift.value.y += L.cfg.dir[1] * rate * step;
    }

    // 日月轮
    _dir.copy(state.sunDirection).multiplyScalar(glowDist);
    sunHalo.position.copy(_dir);
    sunCore.position.copy(_dir);
    moonDisc.position.copy(_dir);
    const nearHorizon = 1 - smoothstep(0, 18, state.sun.elevation);
    const coreAng = 0.9 * state.sun.angular * (1 + 1.5 * nearHorizon);
    sunCore.scale.setScalar(glowDist * Math.tan(clamp(coreAng, 0.4, 12) * DEG) * 0.5);
    // 日轮精灵是「加性混合 + 不写深度」的。倍率给高一点点，整帧就会被一层
    // 奶白盖住，木屋直接消失 —— 逆光镜头尤其明显（日轮就在画面里）。
    sunCore.material.color.set(state.sun.color).lerp(HALO_RED, nearHorizon * 0.4).multiplyScalar(2.0);
    sunCore.material.opacity = clamp(1 - moon, 0, 1) * 0.85;
    sunHalo.scale.setScalar(glowDist * Math.tan(clamp(coreAng * 1.9 + 2.4, 1.0, 30) * DEG));
    sunHalo.material.color.set(state.sun.color).lerp(HALO_RED, nearHorizon * 0.3).multiplyScalar(0.8);
    sunHalo.material.opacity = clamp((1 - moon) * 0.7 + moon * 0.4, 0, 1);
    moonDisc.scale.setScalar(glowDist * Math.tan(clamp(coreAng * 0.45, 0.3, 6) * DEG));
    moonDisc.material.color.set('#dfe8ff').multiplyScalar(2.2);
    moonDisc.material.opacity = moon;
    sunHalo.visible = sunHalo.material.opacity > 0.01;
    sunCore.visible = sunCore.material.opacity > 0.01;
    moonDisc.visible = moon > 0.01;
    starMat.uniforms.uOpacity.value = smoothstep(0.6, 1.0, night);

    dome.position.copy(camera ? camera.position : _dir.set(0, 0, 0));
    updateSunScreen(camera);
    // 自动曝光补偿：日轮进画时天空是画面里最亮的东西，不压曝光的话整个上半幅
    // 会糊成一片白（实测过曝 14%、均值 0.63）。真实摄影里这叫「按高光测光」——
    // 逆光镜头就该暗一档。sky.js 是 state 的唯一写入者，所以系数放这里。
    state.exposureScale = 1 - 0.5 * clamp((sunScreen.strength - 0.3) / 0.7, 0, 1);
  }

  function setPreset(name, instant = false) {
    if (!TIME_PRESETS[name]) return;
    if (name === presetName && !instant && blend >= 1) return;
    copyInto(state, from);
    target = TIME_PRESETS[name];
    presetName = name;
    blend = instant ? 1 : 0;
    if (instant) copyInto(target, state);
  }

  update(0, 0, opt.camera);

  return {
    group, state, sunScreen, update, setPreset,
    get presetName() { return presetName; },
    sunLight: sun,
    hemisphereLight: hemi,
    fillLight: fill,
    nightFactor: () => state.night,
  };
}
