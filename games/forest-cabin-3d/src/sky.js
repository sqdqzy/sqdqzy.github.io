/**
 * sky.js — 大气光照状态机（atmosphere）
 * ---------------------------------------------------------------------------
 * 唯一职责：把 core.js 的 TIME_PRESETS 推进成「每帧可消费」的 state：
 *   · 天穹（addons Sky，物理散射，HDR 光源感的来源）
 *   · 太阳 / 月亮 DirectionalLight（投影，阴影正交相机钉在院子里）
 *   · HemisphereLight（state.ambient × state.hemisphere）+ 反向补光 DirectionalLight(state.fill)
 *   · 两层大尺度云（半球云壳 + canvas fbm 密度贴图 + 坡度受光，覆盖率由 state.cloud.coverage 控制）
 *   · 日轮 / 月轮辉光（加性 sprite，喂给 postfx 的 bloom 与屏幕空间光束）
 *   · sunDirection / sunScreen（postfx 依赖的运行时字段）
 *
 * 对外契约（main.js 依赖）：
 *   createAtmosphere(opt) -> { group, state, update(t, dt, camera), setPreset(name, instant),
 *                             resize(w, h), sunLight, sunScreen }
 *
 * 结构说明（重要）：
 *   main.js 只把 `group` 加进 scene，所以「天穹随相机移动」由内部子节点 skyDome 承担，
 *   group 本身留在世界原点 —— 这样太阳光与阴影包围盒才能钉在院子中心，而不是跟着相机跑。
 *
 * 性能约定：所有临时向量 / 颜色在模块或实例内复用，每帧工作量 O(1)（无每帧 new）。
 */
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import {
  TIME_PRESETS, getPreset, sunDirection,
  clamp, smoothstep, fbm, DEG, CLEARING, getTexture,
} from './core.js';

/* =========================================================================
 * 常量
 * ========================================================================= */

const TRANSITION_DUR = 1.8;   // 预设过渡时长（秒），缓入缓出
const SHADOW_EXTENT = 36;     // 阴影正交相机半宽：木屋 + 院子 + 近处林缘（约 ±34m，留一点余量）
const SHADOW_FAR = 260;       // 阴影相机远平面（≥200，保证斜射时树影完整）
/** 光照换算（Lead 要求明确写出，避免两个 0.x 系数相乘塌到 1/3）：
 *    hemiLight.intensity = ambient.intensity × hemisphere.intensity × HEMI_GAIN   （HEMI_GAIN=1.0 → 系数直接相乘，不再缩水）
 *    fillLight.intensity = fill.intensity × FILL_GAIN × (1 − 0.3 × nightFactor)
 *  代入当前 core：dawn 1.82 / morning 2.18 / golden 1.96 / overcast 3.24 / dusk 1.56 / night 0.95。
 *  半球光是 irradiance（radiance ≈ I·albedo/π），配合 exposure 1.2~1.5，
 *  地面落点约 sRGB 0.31(受光) / 0.22(阴影)，正好落在 Lead 给的均值 0.28~0.40 区间。 */
const HEMI_GAIN = 1.0;
const HEMI_MIN = 0.08;
const HEMI_MAX = 3.0;
const FILL_GAIN = 1.35;       // 反向补光：让背光面能读出材质细节，又不至于把画面压平
const FILL_NIGHT_KEEP = 0.7;  // 夜里补光衰减，避免月夜被补成"白天"

/** 云层：半球云壳 + 方向投影 UV（uv = dir.xz / dir.y × uScale），
 *  uScale = 云层高度 / tile（tile = 一张贴图覆盖的水平米数）——
 *  用「壳」而不是水平大平面，是为了不被 camera.far（260~480）裁掉：
 *  y=112m 的水平面要覆盖到 8° 仰角就需要 ±800m，早就飞出远平面了。 */
const CLOUD_LAYERS = [
  { name: 'cloudLow', radiusK: 0.80, altitude: 112, tile: 420, covGain: 1.0, opacity: 0.95,
    speedK: 1.0, dir: [0.93, 0.37], seed: 17, texSize: 256, octaves: 5, order: 3 },
  { name: 'cloudHigh', radiusK: 0.92, altitude: 206, tile: 1400, covGain: 0.62, opacity: 0.42,
    speedK: 1.45, dir: [0.52, -0.85], seed: 41, texSize: 192, octaves: 4, order: 2 },
];

const COURTYARD = new THREE.Vector3(CLEARING.center.x, CLEARING.height + 1.15, CLEARING.center.z);
const HALO_RED = new THREE.Color('#ff5c1f');

/* 复用的临时对象（严禁每帧 new） */
const _cA = new THREE.Color();
const _cB = new THREE.Color();
const _shade = new THREE.Color();
const _sunlit = new THREE.Color();
const _cloudAmb = new THREE.Color();
const _ground = new THREE.Color();
const _dirV = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _ndc = new THREE.Vector3();

/* =========================================================================
 * state 工具：与 TIME_PRESETS 严格同构的深层复制 / 原地逐字段插值
 * ========================================================================= */

const SKIP_RUNTIME = { sunDirection: 1, sunScreen: 1 };

function copyPreset(src, dst, skipRuntime = false) {
  for (const k in src) {
    if (skipRuntime && SKIP_RUNTIME[k]) continue;
    const v = src[k];
    if (typeof v === 'number' || typeof v === 'string') dst[k] = v;
    else if (v && typeof v === 'object') copyPreset(v, dst[k] || (dst[k] = {}), skipRuntime);
  }
  return dst;
}

/** 逐字段插值：数字 lerp，颜色字符串在 linear 空间插值，key/label/hint 取近端 */
function lerpInto(a, b, t, out) {
  for (const k in b) {
    const bv = b[k];
    if (k === 'key' || k === 'label' || k === 'hint') { out[k] = t < 0.5 ? a[k] : bv; continue; }
    if (typeof bv === 'number') {
      const av = a[k];
      out[k] = typeof av === 'number' ? av + (bv - av) * t : bv;
    } else if (typeof bv === 'string') {
      _cA.set(a[k]); _cB.set(bv);
      out[k] = '#' + _cA.lerp(_cB, t).getHexString();
    } else if (bv && typeof bv === 'object') {
      lerpInto(a[k] || {}, bv, t, out[k] || (out[k] = {}));
    } else {
      out[k] = bv;
    }
  }
}

const ease = (x) => { const c = clamp(x, 0, 1); return c * c * (3 - 2 * c); };

/** 亮度归一化的色彩倾向（用于把 state.sky.top/horizon 变成天穹染色，不动整体亮度） */
function tintInto(dst, hex, amount) {
  _cA.set(hex);
  const lum = Math.max(0.2126 * _cA.r + 0.7152 * _cA.g + 0.0722 * _cA.b, 0.004);
  const k = 1 / lum;
  _cB.setRGB(
    clamp(_cA.r * k, 0, 3),
    clamp(_cA.g * k, 0, 3),
    clamp(_cA.b * k, 0, 3)
  );
  dst.setRGB(
    1 + (_cB.r - 1) * amount,
    1 + (_cB.g - 1) * amount,
    1 + (_cB.b - 1) * amount
  );
  return dst;
}

/* =========================================================================
 * 云贴图：可无缝平铺的 fbm 密度图（四角混合法保证 wrap 无缝）
 * ========================================================================= */

function makeCloudTexture(size, octaves, seed) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  const img = g.createImageData(size, size);
  const d = img.data;
  const sx = 3.1 + (seed % 5) * 0.41;
  const sy = 2.7 + (seed % 3) * 0.57;
  const ox = seed * 13.7, oy = seed * 7.3;
  const F = (u, v) => fbm(u * sx + ox, v * sy + oy, octaves, 2.0, 0.52) * 0.5 + 0.5;
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const w00 = (1 - u) * (1 - v), w10 = u * (1 - v), w01 = (1 - u) * v, w11 = u * v;
      const n = F(u, v) * w00 + F(u - 1, v) * w10 + F(u, v - 1) * w01 + F(u - 1, v - 1) * w11;
      // 拉开直方图（饱和度更高）→ coverage 阈值切出来的是「成团的云」而不是一层薄纱
      const a = clamp(0.5 + (n - 0.5) * 3.0, 0, 1);
      const i = (y * size + x) * 4;
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
      d[i + 3] = (a * 255) | 0;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;   // 当密度数据处理，不做色彩转换
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * 日轮外光晕专用贴图：比 core 的 glow 衰减陡得多。
 * Lead 反馈「光晕大面积高亮度铺开，把木屋剪影抬到 0.83」→ 这里让亮度集中在中心 12% 内，
 * 60% 半径处几乎为 0，只有靠近日核的一小圈被点亮。
 */
function makeHaloTexture(size = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  const rg = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  rg.addColorStop(0.0, 'rgba(255,246,228,1)');
  rg.addColorStop(0.12, 'rgba(255,222,164,0.62)');
  rg.addColorStop(0.28, 'rgba(255,186,104,0.2)');
  rg.addColorStop(0.50, 'rgba(255,158,72,0.05)');
  rg.addColorStop(0.75, 'rgba(255,140,60,0.008)');
  rg.addColorStop(1.0, 'rgba(255,130,55,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const CLOUD_VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = normalize( position );
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`;

const CLOUD_FRAG = /* glsl */`
  uniform sampler2D uMap;
  uniform vec2 uDrift;
  uniform float uTexel;
  uniform float uScale;
  uniform float uCoverage;
  uniform float uOpacity;
  uniform vec3 uShade;
  uniform vec3 uSun;
  uniform vec3 uAmbient;
  uniform vec3 uSunDir;
  varying vec3 vDir;

  void main() {
    vec3 dir = normalize( vDir );
    // 地平线以下不画云（留一点过渡，让云一直铺到林线附近的低空）
    float horizon = smoothstep( -0.01, 0.10, dir.y );
    if ( horizon < 0.004 ) discard;

    // 方向 → 云层平面投影（与 addons Sky 的内建云同一套数学）
    vec2 p = dir.xz / max( dir.y, 0.045 );
    vec2 uv = p * uScale + uDrift;

    float d = texture2D( uMap, uv ).a;
    float dx = texture2D( uMap, uv + vec2( uTexel, 0.0 ) ).a - d;
    float dy = texture2D( uMap, uv + vec2( 0.0, uTexel ) ).a - d;

    float cut = mix( 0.70, 0.02, clamp( uCoverage, 0.0, 1.0 ) );
    float shape = smoothstep( cut, cut + 0.26, d ) * horizon;
    if ( shape < 0.004 ) discard;
    float core = smoothstep( cut + 0.08, cut + 0.44, d );   // 云体内部：不透明，边界软

    // 用密度梯度当假法线：朝太阳一侧的坡面被点亮 → 云有体积感，而不是贴图贴片
    vec3 n = normalize( vec3( -dx * 9.0, -dy * 9.0, 0.34 ) );
    vec3 L = normalize( vec3( uSunDir.x, -uSunDir.z, max( uSunDir.y, 0.10 ) ) );
    float lit = clamp( dot( n, L ), 0.0, 1.0 );
    lit = mix( lit, 1.0, 0.12 );

    vec3 col = mix( uShade, uSun, lit * 0.95 ) + uAmbient * ( 1.0 - lit ) * 0.25;
    col *= mix( 0.88, 1.12, core );                        // 厚的云体更亮，读得出体积
    float a = shape * uOpacity * mix( 0.45, 1.0, core );

    gl_FragColor = vec4( col, a );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/* =========================================================================
 * 主工厂
 * ========================================================================= */

export function createAtmosphere(opt = {}) {
  const q = opt.quality || {};
  const quality = {
    shadowMap: q.shadowMap || 2048,
    shadowRadius: q.shadowRadius != null ? q.shadowRadius : 2,
    shadows: q.shadows !== false,
    far: q.far || 320,
  };
  const initialName = TIME_PRESETS[opt.preset] ? opt.preset : 'golden';

  const group = new THREE.Group();
  group.name = 'sky';

  /* ---------------------------------------------------------------- 天穹 */
  const dome = new THREE.Group();
  dome.name = 'skyDome';          // 每帧对齐相机，天穹永不穿出
  group.add(dome);

  const skyMesh = new Sky();
  skyMesh.name = 'skyShell';
  skyMesh.scale.setScalar(450000);
  skyMesh.renderOrder = -1;
  const skyU = skyMesh.material.uniforms;
  skyU.up.value.set(0, 1, 0);
  skyU.showSunDisc.value = 0;       // 日/月轮改用下面的 sprite 控制，亮度与大小完全可控（夜间不会变「第二个太阳」）
  skyU.cloudCoverage.value = 0;     // 关闭 addons 内建云，改用两层独立云壳
  skyU.cloudDensity.value = 0;
  skyU.cloudSpeed.value = 0;

  // 用 state.sky.top / horizon 做一次「亮度中性」的色相倾向，让 6 套预设的夜空/晨昏差异可信
  const uTintTop = { value: new THREE.Color(1, 1, 1) };
  const uTintHorizon = { value: new THREE.Color(1, 1, 1) };
  const uTintAmount = { value: 0.25 };
  skyMesh.material.onBeforeCompile = (shader) => {
    shader.uniforms.uTintTop = uTintTop;
    shader.uniforms.uTintHorizon = uTintHorizon;
    shader.uniforms.uTintAmount = uTintAmount;
    shader.fragmentShader = 'uniform vec3 uTintTop;\nuniform vec3 uTintHorizon;\nuniform float uTintAmount;\n'
      + shader.fragmentShader.replace(
        'gl_FragColor = vec4( texColor, 1.0 );',
        `vec3 skyTint = mix( uTintHorizon, uTintTop, smoothstep( -0.02, 0.55, direction.y ) );
         texColor *= mix( vec3( 1.0 ), skyTint, uTintAmount );
         gl_FragColor = vec4( texColor, 1.0 );`
      );
  };
  dome.add(skyMesh);

  /* ---------------------------------------------------------------- 云壳（2 层） */
  const cloudLayers = [];
  for (const cfg of CLOUD_LAYERS) {
    const radius = Math.max(80, quality.far * cfg.radiusK);
    const geo = new THREE.SphereGeometry(radius, 40, 20, 0, Math.PI * 2, 0, Math.PI * 0.56);
    const tex = makeCloudTexture(cfg.texSize, cfg.octaves, cfg.seed);
    const mat = new THREE.ShaderMaterial({
      name: cfg.name,
      uniforms: {
        uMap: { value: tex },
        uDrift: { value: new THREE.Vector2(cfg.seed * 0.37, cfg.seed * 0.11) },
        uTexel: { value: 1 / cfg.texSize },
        uScale: { value: cfg.altitude / cfg.tile },
        uCoverage: { value: 0.5 },
        uOpacity: { value: cfg.opacity },
        uShade: { value: new THREE.Color(0.3, 0.32, 0.36) },
        uSun: { value: new THREE.Color(1.0, 0.8, 0.6) },
        uAmbient: { value: new THREE.Color(0.1, 0.12, 0.15) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      },
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = cfg.name;
    mesh.renderOrder = cfg.order;    // 显式次序：远层先画，避免同心球排序退化
    mesh.frustumCulled = false;
    dome.add(mesh);
    cloudLayers.push({ cfg, mesh, mat, tile: cfg.tile });
  }

  /* ---------------------------------------------------------------- 日轮 / 月轮辉光 */
  const glowDist = Math.min(quality.far * 0.82, 360);
  const glowTex = getTexture('glow');
  const haloTexture = makeHaloTexture(128);
  const starTex = getTexture('star');

  function makeGlowSprite(tex, order, depthTest) {
    const mat = new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false, depthTest,
      blending: THREE.AdditiveBlending, fog: false, toneMapped: true,
    });
    const sp = new THREE.Sprite(mat);
    sp.renderOrder = order;
    sp.frustumCulled = false;
    dome.add(sp);
    return sp;
  }
  // 光晕同样参与深度测试：被树/木屋挡住时不该继续糊在画面前面。
  // （原来是 depthTest:false + 加性混合，木屋会被一团白光整体冲淡，建筑细节全丢。）
  const sunHalo = makeGlowSprite(haloTexture, 1, true);
  const sunCore = makeGlowSprite(glowTex, 1, true);    // 过曝的日轮核心：参与深度测试 → 被树挡住的日盘更真实
  const moonDisc = makeGlowSprite(starTex, 1, true);   // 夜间换成清晰的月盘
  moonDisc.material.opacity = 0;

  /* ---------------------------------------------------------------- 太阳 / 月亮平行光 */
  const sunLight = new THREE.DirectionalLight(0xffffff, 3);
  sunLight.name = 'sunLight';
  sunLight.castShadow = quality.shadows;
  sunLight.shadow.mapSize.set(quality.shadowMap, quality.shadowMap);
  sunLight.shadow.radius = quality.shadowRadius;
  sunLight.shadow.normalBias = 0.035;
  const shadowCam = sunLight.shadow.camera;
  shadowCam.left = -SHADOW_EXTENT;
  shadowCam.right = SHADOW_EXTENT;
  shadowCam.top = SHADOW_EXTENT;
  shadowCam.bottom = -SHADOW_EXTENT;
  shadowCam.near = 12;
  shadowCam.far = SHADOW_FAR;
  shadowCam.updateProjectionMatrix();
  sunLight.target.position.copy(COURTYARD);
  group.add(sunLight);
  group.add(sunLight.target);

  /* ---------------------------------------------------------------- 环境光 / 补光 */
  const hemiLight = new THREE.HemisphereLight(0x88a0c0, 0x4a4436, 0.6);
  hemiLight.name = 'hemiLight';
  group.add(hemiLight);

  const fillLight = new THREE.DirectionalLight(0x8fa9c4, 0.4);
  fillLight.name = 'fillLight';
  fillLight.castShadow = false;
  fillLight.target.position.copy(COURTYARD);
  group.add(fillLight);
  group.add(fillLight.target);

  /* ---------------------------------------------------------------- 状态机 */
  const targetPresetOf = (name) => (TIME_PRESETS[name] ? TIME_PRESETS[name] : getPreset(name));

  const state = { sunDirection: new THREE.Vector3(0, 1, 0) };
  copyPreset(targetPresetOf(initialName), state);

  /** postfx 依赖的屏幕空间日照信息（与 state.sunScreen 同一个对象） */
  const sunScreen = { x: 0, y: 0, visible: false, strength: 0 };
  state.sunScreen = sunScreen;

  let fromState = {};
  copyPreset(state, fromState, true);
  let targetPreset = targetPresetOf(initialName);
  let presetName = initialName;
  let blend = 1;

  let lastCamera = opt.camera || null;

  /* ---------------------------------------------------------------- 每帧更新 */

  function updateSunScreen(camera) {
    if (!camera) {
      sunScreen.visible = false;
      sunScreen.strength = 0;
      return;
    }
    camera.getWorldDirection(_camDir);
    const facing = _camDir.dot(state.sunDirection);
    // 把「太阳方向上的远点」投影到 NDC
    _ndc.copy(camera.position).addScaledVector(state.sunDirection, glowDist).project(camera);
    const above = smoothstep(-3.5, 4.0, state.sun.elevation);
    const r = Math.hypot(_ndc.x, _ndc.y);
    const center = 1 - smoothstep(0.35, 1.35, r);
    sunScreen.x = _ndc.x;
    sunScreen.y = _ndc.y;
    sunScreen.visible = facing > 0.02 && above > 0.001 && _ndc.z < 1
      && Math.abs(_ndc.x) <= 1.4 && Math.abs(_ndc.y) <= 1.4;
    sunScreen.strength = clamp(smoothstep(0.0, 0.5, facing) * center * above, 0, 1);
  }

  function update(t, dt, camera) {
    if (camera) lastCamera = camera;
    const step = Math.min(dt > 0 ? dt : 0, 0.1);

    /* --- 1. 预设过渡（缓入缓出 1.8s） --- */
    if (blend < 1) {
      blend = Math.min(1, blend + step / TRANSITION_DUR);
      if (blend >= 1) copyPreset(targetPreset, state);
      else lerpInto(fromState, targetPreset, ease(blend), state);
    }

    /* --- 2. 太阳方向 --- */
    sunDirection(state.sun.azimuth, state.sun.elevation, state.sunDirection);
    const el = state.sun.elevation;
    const night = clamp(state.nightFactor, 0, 1);
    const moonK = smoothstep(0.82, 1.0, night);
    const horizonAmt = 1 - smoothstep(0, 20, el);

    /* --- 3. 天穹 uniforms --- */
    skyU.turbidity.value = state.sky.turbidity;
    skyU.rayleigh.value = state.sky.rayleigh;
    skyU.mieCoefficient.value = state.sky.mie;
    skyU.mieDirectionalG.value = state.sky.mieG;
    skyU.sunPosition.value.copy(state.sunDirection);
    const tintAmt = 0.22 + 0.24 * night;
    uTintAmount.value = tintAmt;
    tintInto(uTintTop.value, state.sky.top, tintAmt);
    tintInto(uTintHorizon.value, state.sky.horizon, tintAmt);

    /* --- 4. 太阳 / 月亮平行光 --- */
    _dirV.copy(state.sunDirection).multiplyScalar(80).add(COURTYARD);
    sunLight.position.copy(_dirV);
    sunLight.color.set(state.sun.color);
    sunLight.intensity = state.sun.intensity;
    sunLight.shadow.bias = state.sun.bias;

    /* --- 5. 环境光 + 反向补光 --- */
    hemiLight.color.set(state.ambient.sky);
    hemiLight.groundColor.set(state.ambient.ground);
    hemiLight.intensity = clamp(state.ambient.intensity * state.hemisphere.intensity * HEMI_GAIN, HEMI_MIN, HEMI_MAX);
    sunDirection(state.fill.azimuth, state.fill.elevation, _dirV);
    fillLight.position.copy(_dirV).multiplyScalar(60).add(COURTYARD);
    fillLight.color.set(state.fill.color);
    fillLight.intensity = state.fill.intensity * FILL_GAIN * (1 - (1 - FILL_NIGHT_KEEP) * clamp(state.nightFactor, 0, 1));

    /* --- 6. 云层（配色 / 覆盖率 / 漂移） --- */
    // 背光面：压暗并向地面反弹色偏移 → 逆光云块是"暗底 + 亮边"，绝不是一层薄纱
    _shade.set(state.cloud.color).multiplyScalar(0.5);
    _ground.set(state.sky.ground);
    _shade.lerp(_ground, 0.4);
    _sunlit.set(state.cloud.sunColor).multiplyScalar(2.2);        // HDR 亮边，给 bloom 抓手
    _cloudAmb.set(state.sky.ground).multiplyScalar(0.6).lerp(_cA.set(state.ambient.sky), 0.15);
    const windSpeed = state.cloud.speed * 240 + state.wind.speed * 3.2 + state.wind.strength * 4.0;
    for (let i = 0; i < cloudLayers.length; i++) {
      const L = cloudLayers[i];
      const u = L.mat.uniforms;
      u.uCoverage.value = clamp(state.cloud.coverage * L.cfg.covGain, 0, 1);
      u.uOpacity.value = L.cfg.opacity;
      u.uSunDir.value.copy(state.sunDirection);
      u.uShade.value.copy(_shade);
      u.uSun.value.copy(_sunlit);
      u.uAmbient.value.copy(_cloudAmb);
      const rate = (windSpeed * L.cfg.speedK) / L.tile;
      u.uDrift.value.x += L.cfg.dir[0] * rate * step;
      u.uDrift.value.y += L.cfg.dir[1] * rate * step;
    }

    /* --- 7. 日轮 / 月轮辉光 --- */
    _dirV.copy(state.sunDirection).multiplyScalar(glowDist);
    sunHalo.position.copy(_dirV);
    sunCore.position.copy(_dirV);
    moonDisc.position.copy(_dirV);

    const cov = clamp(state.cloud.coverage, 0, 1);
    // 视角直径：日核 ≈1.0~1.1°（屏幕高度 2~3%），外光晕 ≈3.5°，不再大面积铺开
    const coreAng = 0.9 * state.sun.angular * (1 + 1.6 * horizonAmt);
    const haloAng = coreAng * 1.6 + 0.8;
    const coreScale = glowDist * Math.tan(clamp(coreAng, 0.4, 12) * DEG);
    const haloScale = glowDist * Math.tan(clamp(haloAng, 1.0, 30) * DEG);

    _cA.set(state.sun.color);
    _cB.copy(_cA).lerp(HALO_RED, horizonAmt * 0.45).multiplyScalar(4.6);   // 只有核心接近纯白
    sunCore.scale.setScalar(coreScale * 0.62);
    sunCore.material.color.copy(_cB);
    sunCore.material.opacity = clamp((1 - moonK) * (1 - 0.85 * cov), 0, 1);

    _cB.copy(_cA).lerp(HALO_RED, horizonAmt * 0.35).multiplyScalar(0.7);   // 外光晕只做氛围绕边，不抬整体亮度
    sunHalo.scale.setScalar(haloScale);
    sunHalo.material.color.copy(_cB);
    sunHalo.material.opacity = clamp((1 - moonK) * (1 - 0.4 * cov) * 0.7 + moonK * 0.45, 0, 1);

    moonDisc.scale.setScalar(glowDist * Math.tan(clamp(coreAng * 0.5, 0.3, 6) * DEG));
    moonDisc.material.color.copy(_cA).multiplyScalar(2.2);
    moonDisc.material.opacity = moonK;
    sunHalo.visible = sunHalo.material.opacity > 0.01;
    sunCore.visible = sunCore.material.opacity > 0.01;
    moonDisc.visible = moonK > 0.01;

    /* --- 8. 天穹跟随相机 + sunScreen --- */
    if (camera) dome.position.copy(camera.position);
    updateSunScreen(camera || lastCamera);
  }

  /* ---------------------------------------------------------------- 预设切换 */
  function setPreset(name, instant = false) {
    if (!TIME_PRESETS[name]) return;
    if (name === presetName && instant === false && blend >= 1) return;   // 已经是该预设
    copyPreset(state, fromState, true);        // 从「当前实际画面」继续过渡（可打断）
    targetPreset = TIME_PRESETS[name];
    presetName = name;
    blend = instant ? 1 : 0;
    if (instant) copyPreset(targetPreset, state);
  }

  /* ---------------------------------------------------------------- 尺寸变化 */
  function resize(w, h) {
    // 相机 aspect / projection 由 main.js 负责（不在别人的对象上做副作用）。
    // 这里只同步一次 NDC 结果，保证 postfx 在下一帧之前拿到的 sunScreen 也是对的。
    updateSunScreen(lastCamera);
  }

  // 初次立即对齐一次（main.js 随后还会调用 setPreset(name, true)）
  updateSunScreen(lastCamera);

  console.log(`[sky] atmosphere ready · preset=${initialName} · shadowMap=${quality.shadowMap} · glowDist=${glowDist.toFixed(0)}`);

  return {
    group,
    state,
    sunScreen,
    update,
    setPreset,
    resize,
    sunLight,
    hemisphereLight: hemiLight,
    fillLight,
    get presetName() { return presetName; },
  };
}
