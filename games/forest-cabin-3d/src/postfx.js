/**
 * postfx.js — 电影级后处理管线（HDR 空间 bloom + 屏幕空间体积光束 + ACES 输出 + SMAA + 一次性调色）
 * ---------------------------------------------------------------------------
 * 管线顺序（不可调换，且 tone mapping 只应用一次）：
 *
 *   1. EffectComposer                       —— HDR 缓冲（HalfFloatType）
 *   2. RenderPass(scene, camera)            —— 场景以线性 HDR 渲染进 RT
 *      （three r185 只在 currentRenderTarget === null 时给材质注入 tone mapping，
 *        所以渲染进 RT 时没有 tone mapping，这一步是干净的场景参考线性值）
 *   3. GodRaysPass   (自写 ShaderPass)       —— 屏幕空间径向散射（丁达尔光束）
 *   4. UnrealBloomPass                      —— HDR 空间泛光（必须在 tone mapping 之前）
 *   5. OutputPass()                         —— ACES tone mapping + sRGB 编码
 *   6. SMAAPass()                           —— 显示空间抗锯齿
 *   7. GradePass     (自写 ShaderPass)       —— 色温/对比/S 曲线/饱和/lift/gamma/暗角/颗粒/色差/锐化
 *
 * 已从 vendor 源码确认的 r185 构造签名：
 *   new EffectComposer(renderer[, renderTarget])            —— renderTarget 省略时默认 HalfFloatType
 *   new RenderPass(scene, camera[, overrideMaterial, clearColor, clearAlpha])
 *   new UnrealBloomPass(resolution: Vector2, strength, radius, threshold)   ← 注意是 (strength, radius, threshold)
 *   new OutputPass()                                        —— 无参
 *   new SMAAPass()                                          —— 无参；尺寸靠 addPass()/setSize(w,h) 注入
 *   new ShaderPass(shader | ShaderMaterial[, textureID='tDiffuse'])
 *   composer.setPixelRatio(pr) / composer.setSize(w, h)     —— setSize 收逻辑像素，内部乘 pixelRatio 并把
 *                                                               effective 尺寸广播给所有 pass（含 bloom / SMAA）
 *
 * 设计要点：
 *   - 光束强度 = 软饱和映射(state.volumetric.strength) × quality.volumetric × 太阳入画系数，黄金时刻 ≈ 0.18~0.26；
 *     三重防"泛白"：① 距离门在 ~1.05 画面半径外严格归零（无常数项/背景项）② 已经亮的像素（天空/日轮）
 *     用 litMask 不再加光，光柱只"打在暗处" ③ 逐 tap 高光柔性压缩 + **叠加量硬上限 0.15（线性空间）**。
 *   - 只在 state.sunScreen.visible && strength > 0.05 时工作，否则 uStrength=0 且跳过整个 pass。
 *   - state.sunScreen 的 x/y 自动识别 NDC / uv / 像素三种约定（本项目 sky.js 给的是 NDC）。
 *   - bloom 在 tone mapping 之前的 HDR 缓冲上取值，只吃真正的高光（阈值跟随 state.bloom.threshold）；
 *     日轮入画（visible && strength > 0.6）时自动把 strength 压到 ~50% 并抬高阈值。
 *   - 所有 uniform 用 core.damp 平滑跟随，切换预设不会硬跳。
 *   - 任何一环构造/渲染失败都优雅降级（含构建期裸 GL 自检），绝不整站黑屏。
 *   - 返回对象带 gradeActive（main.js 用它决定是否关闭 CSS 兜底暗角）。
 *   - 本模块**不写** renderer.toneMappingExposure，只读 state.exposure（用于把 HDR 亮度折算成显示亮度）。
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { QUALITY_PRESETS, clamp, damp, smoothstep, sunDirection } from './core.js';

/* =========================================================================
 * 可调常量（想改观感先动这里）
 * ========================================================================= */

/** 光束最大 tap 数（GLSL 循环上界）。实际 tap = samples × 档位系数，封顶到这里 */
const MAX_TAPS = 20;
/**
 * 光束强度的上限（软饱和映射的渐近值，不是硬夹断）。
 * 软饱和的好处：core.js 把 volumetric.strength 校准成 0.2 还是 1.2，光束都不会消失或失控。
 * 当前 core.js（0.22~0.36）× 1.6 的软饱和 → 黄金时刻 ≈ 0.19~0.26，正是"隐约成束"的区间。
 */
const RAY_MAX_STRENGTH = 0.45;
/**
 * 光束单帧叠加的硬上限（HDR 线性空间，tone map 之前）。
 * Lead 实测"太阳入画时整帧 0.626 均值过曝"，所以这个值必须很小：
 * 0.15 在暗树冠上已经能看出成束光，但对整帧均值的影响可以忽略。
 */
const RAY_MAX_ADD = 0.15;
/** uniform 跟随速度（lambda，越大越快） */
const L_GRADE = 3.2;
const L_BLOOM = 3.0;
const L_RAY = 2.6;
const L_SUN = 5.0;

/** 数值守卫：非法值一律退回默认，避免 NaN 传染到 uniform */
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/* =========================================================================
 * 公共顶点着色器（全屏三角/四边形）
 * ========================================================================= */
const FULLSCREEN_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

/* =========================================================================
 * GodRaysPass —— 屏幕空间体积光束（径向散射）
 * 参考 Kenny Mitchell 的 screen-space light scattering：
 *   沿「像素 → 太阳屏幕位置」方向多 tap 采样 HDR 颜色，衰减累积，只保留超过阈值的亮部。
 * ========================================================================= */
const GodRaysShader = {
  name: 'GodRaysPass',
  defines: { GODRAY_MAX_TAPS: MAX_TAPS },
  uniforms: {
    tDiffuse: { value: null },
    uSun: { value: new THREE.Vector2(0.5, 0.42) },      // 太阳屏幕位置（uv，可在画面外）
    uResolution: { value: new THREE.Vector2(1, 1) },
    uAspect: { value: 16 / 9 },
    uStrength: { value: 0.0 },                          // 有效强度（已含档位/可见性/体积光开关）
    uDensity: { value: 0.85 },                          // 采样步长占比
    uDecay: { value: 0.985 },                           // 径向衰减（接近 1 = 更接近散射积分，缝隙的光能照亮远处暗部）
    uWeight: { value: 1.0 },
    uThreshold: { value: 0.85 },                        // HDR 亮度阈值：只让明显亮部参与
    uKnee: { value: 0.55 },
    uMaxAdd: { value: RAY_MAX_ADD },
    uSamples: { value: 16 },
    uLitExposure: { value: 1.2 },                       // 只用来把 HDR 亮度折算成"显示亮度"，判断哪些像素本来就很亮
    uTime: { value: 0.0 },
  },
  vertexShader: FULLSCREEN_VERT,
  fragmentShader: /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2  uSun;
uniform vec2  uResolution;
uniform float uAspect;
uniform float uStrength;
uniform float uDensity;
uniform float uDecay;
uniform float uWeight;
uniform float uThreshold;
uniform float uKnee;
uniform float uMaxAdd;
uniform float uLitExposure;
uniform float uTime;
uniform int   uSamples;
varying vec2 vUv;

float hash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

void main() {
  vec3 base = texture2D( tDiffuse, vUv ).rgb;

  // 关闭时严格直通，绝不留下全屏亮斑
  if ( uStrength < 0.0015 ) {
    gl_FragColor = vec4( base, 1.0 );
    return;
  }

  float lumBase = dot( base, vec3( 0.2126, 0.7152, 0.0722 ) );

  // 已经在亮的像素（天空/日轮）不再加光：否则整片亮区互相加亮 = 均匀泛白。
  // 光柱只应该"打在暗处"（树冠剪影、地面暗部），这一项是去掉整帧暖雾的关键。
  // 用 uLitExposure 把 HDR 亮度折算成显示亮度，这样换曝光（golden 现在 2.45）也不用重调。
  float lumLit = lumBase * uLitExposure;
  float litMask = 1.0 - 0.85 * smoothstep( 0.15, 1.40, lumLit );

  vec2 toSun = uSun - vUv;
  float dist = length( toSun * vec2( uAspect, 1.0 ) );

  // 距离门：越靠近太阳越强，超过 ~1.05（约画面半径）严格归零 —— 没有常数项/背景项
  float gate = smoothstep( 1.05, 0.05, dist );

  if ( gate <= 0.0001 ) {
    gl_FragColor = vec4( base, 1.0 );
    return;
  }

  vec2 rayStep = toSun * ( uDensity / float( uSamples ) );

  // 逐像素抖动 + 每帧轻微变化：用较少 tap 换平滑的光柱（避免同心圆带状）
  float jitter = hash12( gl_FragCoord.xy + fract( uTime ) * 71.31 );
  vec2 coord = vUv + rayStep * jitter;

  float decay = 1.0;
  vec3 acc = vec3( 0.0 );

  for ( int i = 0; i < GODRAY_MAX_TAPS; i ++ ) {
    if ( i >= uSamples ) break;
    coord += rayStep;
    vec3 s = texture2D( tDiffuse, coord ).rgb;
    float lum = dot( s, vec3( 0.2126, 0.7152, 0.0722 ) );
    float mask = smoothstep( uThreshold, uThreshold + uKnee, lum );
    vec3 tap = s * mask;
    // 高光柔性压缩：太阳直射区域不会把叠加量推到爆
    tap = tap / ( 1.0 + lum * 0.35 );
    acc += tap * decay * uWeight;
    decay *= uDecay;
  }

  acc *= ( gate * litMask * uStrength ) / float( uSamples );
  acc = min( acc, vec3( uMaxAdd ) );

  gl_FragColor = vec4( base + acc, 1.0 );
}
`,
};

/* =========================================================================
 * GradePass —— 最后一环调色（renderToScreen）
 * 一次性完成：色温/色调 → 分裂色调 → 对比+S 曲线 → 饱和度 → lift/gamma → 暗角 → 颗粒 → 色差 → 锐化
 * ========================================================================= */
const GradeShader = {
  name: 'GradePass',
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uSun: { value: new THREE.Vector2(0.5, 0.42) },
    uAspect: { value: 16 / 9 },
    uTime: { value: 0.0 },
    uTemperature: { value: 0.30 },
    uTint: { value: 0.02 },
    uContrast: { value: 1.09 },
    uSaturation: { value: 1.10 },
    uLift: { value: 0.014 },
    uGamma: { value: 1.0 },
    uVignette: { value: 0.42 },
    uGrain: { value: 0.04 },
    uChromatic: { value: 0.0012 },
    uSharpen: { value: 0.34 },
    uSunRelief: { value: 0.0 },
  },
  vertexShader: FULLSCREEN_VERT,
  fragmentShader: /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2  uResolution;
uniform vec2  uSun;
uniform float uAspect;
uniform float uTime;
uniform float uTemperature;
uniform float uTint;
uniform float uContrast;
uniform float uSaturation;
uniform float uLift;
uniform float uGamma;
uniform float uVignette;
uniform float uGrain;
uniform float uChromatic;
uniform float uSharpen;
uniform float uSunRelief;
varying vec2 vUv;

float lumaOf( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

float hash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

void main() {
  vec2 texel = 1.0 / max( uResolution, vec2( 1.0 ) );
  vec3 c = texture2D( tDiffuse, vUv ).rgb;

  // ---------- 锐化：3×3 unsharp，权重很小，只用来找回 SMAA 之后的细节 ----------
  if ( uSharpen > 0.001 ) {
    vec3 blur = texture2D( tDiffuse, vUv + vec2( texel.x, 0.0 ) ).rgb
              + texture2D( tDiffuse, vUv - vec2( texel.x, 0.0 ) ).rgb
              + texture2D( tDiffuse, vUv + vec2( 0.0, texel.y ) ).rgb
              + texture2D( tDiffuse, vUv - vec2( 0.0, texel.y ) ).rgb;
    c += ( c - blur * 0.25 ) * ( uSharpen * 0.5 );
  }

  // ---------- 径向色差：中心为 0，边缘约 0.5~1.5px（device px，与分辨率无关）----------
  if ( uChromatic > 0.00001 ) {
    vec2 d = vUv - 0.5;
    float len = length( d );
    if ( len > 0.0001 ) {
      float r = len / 0.7071;                       // 0 = 中心, 1 = 画面角
      float amt = uChromatic * 900.0 * r * r;       // 0.0005~0.0016 → 画面角约 0.45~1.45px
      vec2 off = ( d / len ) * amt * texel;
      c.r = texture2D( tDiffuse, vUv + off ).r;
      c.b = texture2D( tDiffuse, vUv - off ).b;
    }
  }

  c = clamp( c, 0.0, 3.0 );                         // 上游若非显示空间（线性）也不出错

  // ---------- 色温 / 色调（只移色不移亮度：改完 RGB 后 100% 还原亮度）----------
  // 这样 temperature 不会抬红通道整体亮度，也就不会把绿色压成黄绿（Lead 的色相统计要求）。
  // temperature = 0 时这里严格是恒等变换，不引入任何额外暖偏。
  float lum0 = max( lumaOf( c ), 1e-4 );
  c.r *= 1.0 + uTemperature * 0.26;
  c.b *= 1.0 - uTemperature * 0.22;
  c.g *= 1.0 + uTint * 0.16;
  c.r *= 1.0 - abs( uTint ) * 0.05;
  c.b *= 1.0 - abs( uTint ) * 0.05;
  c = max( c, 0.0 );
  float lum1 = max( lumaOf( c ), 1e-4 );
  c *= clamp( lum0 / lum1, 0.5, 2.0 );      // 完全保亮度

  // ---------- 分裂色调：暖橙高光 + 青灰暗部（仅暖调预设，幅度极小）----------
  float wf = clamp( uTemperature, 0.0, 1.0 );
  if ( wf > 0.001 ) {
    float l = lumaOf( c );
    c += vec3( 0.018, 0.006, -0.022 ) * ( wf * smoothstep( 0.48, 1.0, l ) );
    c += vec3( -0.010, 0.0, 0.018 ) * ( wf * ( 1.0 - smoothstep( 0.0, 0.38, l ) ) );
  }

  // ---------- 对比度：保端点(S 曲线) + 低照度衰减 ----------
  // 注意：绝不能用「绕 0.5 的线性拉伸」——那会让 x < (0.5-0.5/k) 的所有值变成纯黑
  // （k=1.06 时黑点抬到 0.028，实测特写里 20%+ 像素就是这样死黑的）。这里只用保端点的 S 曲线。
  {
    float k = uContrast;
    vec3 x = clamp( c, 0.0, 1.0 );
    vec3 sCurve = x * x * ( 3.0 - 2.0 * x );        // 绕 0.5 中灰，0→0、1→1，绝不把低值压得更低
    vec3 flatten = x * 0.82 + 0.09;                 // k<1 时的降对比分支（预置里用不到）
    float amt = clamp( ( k - 1.0 ) * 1.2, -0.5, 0.55 );
    vec3 target = amt >= 0.0 ? sCurve : flatten;
    float w = smoothstep( 0.02, 0.22, lumaOf( x ) );   // 很暗的区域几乎不加对比，保护暗部细节
    vec3 y = mix( x, target, abs( amt ) * mix( 0.35, 1.0, w ) );
    c = clamp( y, 0.0, 1.0 );
  }

  // ---------- 饱和度（亮度加权；高光收敛，木色/肤色不发脏）----------
  {
    float l = lumaOf( c );
    float sat = mix( uSaturation, 1.0 + ( uSaturation - 1.0 ) * 0.55, smoothstep( 0.62, 1.0, l ) );
    c = mix( vec3( l ), c, sat );
    c = max( c, 0.0 );
  }

  // ---------- 暗部提亮 lift + gamma（lift 只抬「有信号」的暗部，纯黑保留）----------
  {
    float l = lumaOf( c );
    float shadowW = 1.0 - smoothstep( 0.30, 0.85, l );
    c += uLift * smoothstep( vec3( 0.0 ), vec3( 0.09 ), c ) * shadowW;
    if ( abs( uGamma - 1.0 ) > 0.0005 ) {
      c = pow( max( c, 0.0 ), vec3( 1.0 / max( uGamma, 0.05 ) ) );
    }
  }

  // ---------- 暗角：椭圆、软边、略偏上；只压四角（0.86 以内完全不动），逆光时朝太阳开口 ----------
  if ( uVignette > 0.001 ) {
    vec2 n = ( vUv - vec2( 0.5, 0.485 ) ) * 2.0;
    float d = length( vec2( n.x / 0.95, n.y / 0.82 ) );
    float v = smoothstep( 0.86, 1.62, d );
    if ( v > 0.0001 ) {
      if ( uSunRelief > 0.001 ) {
        float sd = length( ( vUv - uSun ) * vec2( uAspect, 1.0 ) );
        v *= 1.0 - 0.6 * uSunRelief * smoothstep( 0.55, 0.0, sd );
      }
      c *= 1.0 - uVignette * 0.45 * v;
    }
  }

  // ---------- 胶片颗粒：每帧变化，暗部更明显、亮部更少 ----------
  if ( uGrain > 0.0001 ) {
    float g = hash12( gl_FragCoord.xy + vec2( fract( uTime ) * 137.0, fract( uTime * 0.713 ) * 251.0 ) );
    float l = lumaOf( c );
    float gw = mix( 1.0, 0.38, smoothstep( 0.25, 0.95, l ) );
    gw *= mix( 0.5, 1.0, smoothstep( 0.0, 0.07, l ) );
    c += ( g - 0.5 ) * ( uGrain * 0.85 ) * gw;
  }

  c = max( c, 0.0 );
  // 上游若仍是线性 HDR（没有 tone map），做一次柔性上限而不是硬截断
  c = c - max( c - 1.0, 0.0 ) * 0.5;
  gl_FragColor = vec4( c, 1.0 );
}
`,
};

/* =========================================================================
 * createPostFX
 * ========================================================================= */

export function createPostFX({ renderer, scene, camera, quality }) {
  let q = quality || QUALITY_PRESETS.high;

  const initSize = renderer.getSize(new THREE.Vector2());
  const size = {
    w: Math.max(1, initSize.x || window.innerWidth || 1280),
    h: Math.max(1, initSize.y || window.innerHeight || 720),
    pr: renderer.getPixelRatio() || 1,
  };

  /** 返回给外部的 pass 引用 */
  const passes = {};
  let composer = null;

  /**
   * 构建期 GLSL 自检（自写着色器的保险丝）：
   * three 在 shader 编译失败时只会 console.error 并把这一帧画成黑屏（不抛异常），
   * 所以这里用**裸 GL** 提前把两段着色器编译/链接一遍，失败就跳过该环节 —— 宁可少一个效果，也绝不黑屏。
   *
   * 之所以不用 renderer.compile()：那会走 three 的 program 缓存与材质生命周期，
   * 与 ShaderPass 的材质共用 cacheKey，手动 compile 完再 dispose 有可能把 program 提前删掉，
   * 触发 `GL_INVALID_VALUE: glGetProgramiv: Program object expected`。裸 GL 完全自持，不碰 three 的 program 管理。
   */
  function probeShader(shaderDef, label) {
    const gl = typeof renderer.getContext === 'function' ? renderer.getContext() : null;
    if (!gl || typeof gl.createShader !== 'function') return true;

    const defines = Object.keys(shaderDef.defines || {})
      .map((k) => `#define ${k} ${shaderDef.defines[k]}`)
      .join('\n');
    // 前缀与 three 给 ShaderMaterial 注入的一致（WebGLProgram：precision + 默认 uniform/attribute）
    const head = `precision highp float;\nprecision highp int;\n#define SHADER_NAME ${label}\n${defines}\n`;
    const vertHead = head
      + 'uniform mat4 modelMatrix;\nuniform mat4 modelViewMatrix;\nuniform mat4 projectionMatrix;\n'
      + 'uniform mat4 viewMatrix;\nuniform mat3 normalMatrix;\nuniform vec3 cameraPosition;\nuniform bool isOrthographic;\n'
      + 'attribute vec3 position;\nattribute vec3 normal;\nattribute vec2 uv;\n';
    const vertSrc = vertHead + shaderDef.vertexShader;
    const fragSrc = head + shaderDef.fragmentShader;

    const errors = [];
    let vs = null, fs = null, prog = null;
    try {
      vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, vertSrc);
      gl.compileShader(vs);
      if (gl.getShaderParameter(vs, gl.COMPILE_STATUS) !== true) {
        errors.push('vertex: ' + (gl.getShaderInfoLog(vs) || '(no log)'));
      }

      fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, fragSrc);
      gl.compileShader(fs);
      if (gl.getShaderParameter(fs, gl.COMPILE_STATUS) !== true) {
        errors.push('fragment: ' + (gl.getShaderInfoLog(fs) || '(no log)'));
      }

      if (errors.length === 0) {
        prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        if (gl.getProgramParameter(prog, gl.LINK_STATUS) !== true) {
          errors.push('link: ' + (gl.getProgramInfoLog(prog) || '(no log)'));
        }
      }
    } catch (err) {
      console.warn(`[postfx] ${label} GLSL 自检未能完成（按通过处理）`, err);
    } finally {
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      if (prog) gl.deleteProgram(prog);
    }

    if (errors.length) {
      console.error(`[postfx] ${label} 着色器编译失败，已跳过该环节以保证不黑屏：\n${errors.join('\n')}`);
      return false;
    }
    return true;
  }

  /* ---------------------------------------------------------------- 1. HDR composer */
  try {
    // 显式传入 HalfFloatType 的 RT：让 bloom / godrays 抓到真实高光（>1 的场景参考值）
    const hdrTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
    });
    hdrTarget.texture.name = 'PostFX.hdr';
    composer = new EffectComposer(renderer, hdrTarget);
  } catch (err) {
    console.error('[postfx] EffectComposer 创建失败，已降级为直接渲染', err);
  }

  /* ---------------------------------------------------------------- 2~7. 组装链路 */
  if (composer) {
    // 2. 场景（线性 HDR，无 tone mapping）
    try {
      passes.render = new RenderPass(scene, camera);
      composer.addPass(passes.render);
    } catch (err) {
      console.error('[postfx] RenderPass 创建失败', err);
    }

    // 3. 屏幕空间体积光束（先做 GLSL 自检）
    try {
      if (probeShader(GodRaysShader, 'GodRaysPass')) {
        passes.godrays = new ShaderPass(GodRaysShader);
        passes.godrays.name = 'GodRaysPass';
        composer.addPass(passes.godrays);
      }
    } catch (err) {
      console.error('[postfx] GodRaysPass 创建失败，跳过体积光', err);
    }

    // 4. HDR 空间 bloom（仅在画质允许时加入）
    if (q.bloom !== false) {
      try {
        passes.bloom = new UnrealBloomPass(
          new THREE.Vector2(size.w, size.h),
          num(q.bloomStrength, 0.85),   // strength
          0.8,                          // radius
          0.66                          // threshold
        );
        composer.addPass(passes.bloom);
      } catch (err) {
        console.error('[postfx] UnrealBloomPass 创建失败，跳过泛光', err);
      }
    }

    // 5. ACES tone mapping + sRGB（tone mapping 唯一的应用点）
    try {
      passes.output = new OutputPass();
      composer.addPass(passes.output);
    } catch (err) {
      console.error('[postfx] OutputPass 创建失败', err);
    }

    // 6. SMAA（显示空间；纹理异步就绪，未就绪时混合权重为 0 → 退化为原图）
    try {
      passes.smaa = new SMAAPass();
      composer.addPass(passes.smaa);
    } catch (err) {
      console.error('[postfx] SMAAPass 创建失败，跳过抗锯齿', err);
    }

    // 7. 调色（最后一环，renderToScreen；先做 GLSL 自检）
    try {
      if (probeShader(GradeShader, 'GradePass')) {
        passes.grade = new ShaderPass(GradeShader);
        passes.grade.name = 'GradePass';
        passes.grade.renderToScreen = true;
        composer.addPass(passes.grade);
      } else {
        // 调色挂了就让它落到上一环（输出/SMAA）直接上屏
        composer.renderToScreen = true;
      }
    } catch (err) {
      console.error('[postfx] GradePass 创建失败，跳过调色', err);
    }
  }

  /* ---------------------------------------------------------------- 运行时状态 */
  const sun = { x: 0.5, y: 0.42, visible: false, strength: 0 };   // 平滑后的太阳屏幕位置
  const sunTarget = { x: 0.5, y: 0.42, visible: false, strength: 0 };
  let volumetricQ = clamp(num(q.volumetric, 1), 0, 1);
  let rayTaps = 16;
  let rayTapsDirty = true;
  let lastSamples = 0;
  let firstState = true;
  let sunConventionLogged = false;
  let bloomMul = 1;   // 日轮进画时自动压低的 bloom 系数（缺这行会每帧抛 ReferenceError，
                      // 结果整个 setState 中断：bloom / 光束 / 调色 uniform 全部停在初值）

  const _camDir = new THREE.Vector3();
  const _sunVec = new THREE.Vector3();
  const _sunPos = new THREE.Vector3();

  /* ---------------------------------------------------------------- setSize */
  function setSize(w, h, pr) {
    size.w = Math.max(1, Math.round(w || size.w));
    size.h = Math.max(1, Math.round(h || size.h));
    size.pr = pr || renderer.getPixelRatio() || 1;
    if (!composer) return;

    try {
      // composer.setSize 收逻辑像素，内部乘 pixelRatio 并把 effective 尺寸广播给所有 pass
      composer.setPixelRatio(size.pr);
      composer.setSize(size.w, size.h);

      const dw = Math.max(1, Math.round(size.w * size.pr));
      const dh = Math.max(1, Math.round(size.h * size.pr));
      const aspect = dw / dh;

      // 显式再同步一次（幂等），保证 bloom / SMAA 一定拿到正确分辨率
      passes.bloom?.setSize?.(dw, dh);
      passes.smaa?.setSize?.(dw, dh);

      const gu = passes.godrays?.uniforms;
      if (gu) { gu.uResolution.value.set(dw, dh); gu.uAspect.value = aspect; }
      const qu = passes.grade?.uniforms;
      if (qu) {
        qu.uResolution.value.set(dw, dh);
        qu.uAspect.value = aspect;
      }
    } catch (err) {
      console.error('[postfx] setSize 失败', err);
    }
  }

  /* ---------------------------------------------------------------- 太阳屏幕位置 */
  /**
   * 自己把太阳方向投影成 NDC（几何上最可靠：沿方向上的任意点投影到屏幕都是同一个点）。
   * sky.js 的 state.sunDirection 直接可用；退化时用 state.sun 的方位角/仰角。
   */
  function sunNdcFromState(state) {
    const s = state && state.sun;
    let dir = null;
    if (state && state.sunDirection && state.sunDirection.isVector3) dir = _sunVec.copy(state.sunDirection);
    else if (state && state.sunDir && state.sunDir.isVector3) dir = _sunVec.copy(state.sunDir);
    else if (s && s.direction && s.direction.isVector3) dir = _sunVec.copy(s.direction);
    else if (s && Number.isFinite(s.azimuth)) dir = sunDirection(s.azimuth, num(s.elevation, 20), _sunVec);
    if (!dir) return null;

    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    const facing = camera.getWorldDirection(_camDir).dot(dir);
    _sunPos.copy(camera.position).addScaledVector(dir, 400).project(camera);
    return { x: _sunPos.x, y: _sunPos.y, facing, elevation: num(s && s.elevation, 20) };
  }

  /**
   * 解析太阳屏幕位置到 uv。
   * state.sunScreen = {x, y, visible, strength} —— 本项目的 sky.js 给的是 **NDC(-1..1)**，
   * 为了兼容别的写法，用「和自己算出来的 NDC 比对」自动判定 NDC / uv / 像素坐标，
   * 三种都对不上（或有刻意偏移）时以自己投影的几何结果为准。
   * visible / strength 一律尊重 sky.js（唯一权威）：visible=false 就完全不工作。
   */
  function resolveSunScreen(state) {
    const mine = sunNdcFromState(state);
    const ss = state && state.sunScreen;

    if (ss && Number.isFinite(ss.x) && Number.isFinite(ss.y)) {
      // 生产者说不可见（太阳在画面外/背面）→ 严格关闭，不做任何"自作聪明"的补救
      if (ss.visible === false) {
        sunTarget.visible = false;
        sunTarget.strength = 0;
        return;
      }
      if (mine && mine.facing <= 0.02) {
        sunTarget.visible = false;
        sunTarget.strength = 0;
        return;
      }

      const dw = Math.max(1, size.w * size.pr), dh = Math.max(1, size.h * size.pr);
      const cands = [
        { k: 'ndc', x: ss.x, y: ss.y },
        { k: 'uv', x: ss.x * 2 - 1, y: ss.y * 2 - 1 },
        { k: 'px', x: (ss.x / dw) * 2 - 1, y: (ss.y / dh) * 2 - 1 },
      ];
      let pick = cands[0];
      if (mine) {
        let bestD = Infinity;
        for (const c of cands) {
          const dd = Math.hypot(c.x - mine.x, c.y - mine.y);
          if (dd < bestD) { bestD = dd; pick = c; }
        }
        if (bestD > 0.6) { pick = { k: 'ndc', x: mine.x, y: mine.y }; }   // 都对不上 → 用几何结果
      } else if (Math.abs(ss.x) > 2.01 || Math.abs(ss.y) > 2.01) {
        pick = cands[2];                                                  // 无方向可用 → 量级启发式
      }

      if (!sunConventionLogged) {
        sunConventionLogged = true;
        console.log(`[postfx] sunScreen 坐标约定识别为「${pick.k}」→ uv (${(pick.x * 0.5 + 0.5).toFixed(3)}, ${(pick.y * 0.5 + 0.5).toFixed(3)})`);
      }

      sunTarget.x = pick.x * 0.5 + 0.5;
      sunTarget.y = pick.y * 0.5 + 0.5;
      sunTarget.visible = true;
      sunTarget.strength = clamp(num(ss.strength, 1), 0, 1.6);
      return;
    }

    // ---- 完全没有 sunScreen（例如 atmosphere 模块缺失）→ 自力更生 ----
    if (!mine) {
      sunTarget.visible = false;
      sunTarget.strength = 0;
      return;
    }
    const sx = mine.x * 0.5 + 0.5;
    const sy = mine.y * 0.5 + 0.5;
    sunTarget.x = sx;
    sunTarget.y = sy;
    sunTarget.visible = mine.facing > 0.02 && sx > -0.45 && sx < 1.45 && sy > -0.45 && sy < 1.45;
    // 太阳越低，光束越强（黄金时刻 / 黄昏）
    sunTarget.strength = clamp(1.25 - mine.elevation / 45, 0.35, 1.25);
  }

  /* ---------------------------------------------------------------- setState */
  function setState(state, t, dt) {
    if (!state) return;
    const d = (typeof dt === 'number' && dt > 0 ? dt : 1 / 60);
    if (typeof t === 'number') {
      const gradeU = passes.grade?.uniforms;
      if (gradeU) gradeU.uTime.value = t;
      const raysU = passes.godrays?.uniforms;
      if (raysU) raysU.uTime.value = t;
    }

    resolveSunScreen(state);

    /* ---- Grade：全部平滑跟随 ---- */
    const g = state.grade || {};
    const gu = passes.grade?.uniforms;
    if (gu) {
      if (firstState) {
        // 首帧直接对齐，避免从默认值慢慢飘
        gu.uTemperature.value = num(g.temperature, gu.uTemperature.value);
        gu.uTint.value = num(g.tint, gu.uTint.value);
        gu.uContrast.value = num(g.contrast, gu.uContrast.value);
        gu.uSaturation.value = num(g.saturation, gu.uSaturation.value);
        gu.uLift.value = num(g.lift, gu.uLift.value);
        gu.uGamma.value = num(g.gamma, gu.uGamma.value);
        gu.uVignette.value = num(g.vignette, gu.uVignette.value);
        gu.uGrain.value = num(g.grain, gu.uGrain.value);
        gu.uChromatic.value = num(g.chromatic, gu.uChromatic.value);
        gu.uSharpen.value = num(g.sharpen, gu.uSharpen.value);
      } else {
        gu.uTemperature.value = damp(gu.uTemperature.value, num(g.temperature, 0), L_GRADE, d);
        gu.uTint.value = damp(gu.uTint.value, num(g.tint, 0), L_GRADE, d);
        gu.uContrast.value = damp(gu.uContrast.value, num(g.contrast, 1.05), L_GRADE, d);
        gu.uSaturation.value = damp(gu.uSaturation.value, num(g.saturation, 1), L_GRADE, d);
        gu.uLift.value = damp(gu.uLift.value, num(g.lift, 0.012), L_GRADE, d);
        gu.uGamma.value = damp(gu.uGamma.value, num(g.gamma, 1), L_GRADE, d);
        gu.uVignette.value = damp(gu.uVignette.value, num(g.vignette, 0.35), L_GRADE, d);
        gu.uGrain.value = damp(gu.uGrain.value, num(g.grain, 0.03), L_GRADE, d);
        gu.uChromatic.value = damp(gu.uChromatic.value, num(g.chromatic, 0.0006), L_GRADE, d);
        gu.uSharpen.value = damp(gu.uSharpen.value, num(g.sharpen, 0.25), L_GRADE, d);
      }
    }

    /* ---- Bloom：strength / threshold / radius 平滑跟随 ----
       太阳就在画面里（visible && strength > 0.6）时自动降 strength 并抬阈值，
       否则日轮周围一大片会一起发光（Lead 实测 r4-shot1 均值 0.626 过曝）。 */
    const b = state.bloom || {};
    const bp = passes.bloom;
    if (bp) {
      const sunInFrame = sunTarget.visible ? smoothstep(0.55, 0.95, sunTarget.strength) : 0;
      bloomMul = damp(bloomMul, 1 - 0.5 * sunInFrame, 2.0, d);
      const thrBias = sunInFrame * 0.22;

      const strengthT = num(b.strength, 0.5) * bloomMul;
      const thresholdT = clamp(num(b.threshold, 0.9) + thrBias, 0.2, 2.0);
      const radiusT = num(b.radius, 0.7);

      if (firstState) {
        bp.strength = strengthT;
        bp.threshold = thresholdT;
        bp.radius = radiusT;
      } else {
        bp.strength = damp(bp.strength, strengthT, L_BLOOM, d);
        bp.threshold = damp(bp.threshold, thresholdT, L_BLOOM, d);
        bp.radius = damp(bp.radius, radiusT, L_BLOOM, d);
      }
    }

    /* ---- 体积光束 ---- */
    const v = state.volumetric || {};
    const ru = passes.godrays?.uniforms;
    if (ru) {
      const volStrength = num(v.strength, 0);
      const density = num(v.density, 1);
      const samples = num(v.samples, 24);

      // 采样数按 state.volumetric.samples 分级，再乘画质系数并封顶（性能优先）
      if (rayTapsDirty || Math.abs(samples - lastSamples) >= 6) {
        lastSamples = samples;
        rayTaps = Math.round(clamp(samples * 0.5 * (0.5 + 0.5 * volumetricQ), 6, MAX_TAPS));
        ru.uSamples.value = rayTaps;
        rayTapsDirty = false;
      }

      // 只在「太阳确实在画面里」时工作：visible && strength > 0.05，否则强度严格为 0
      const sunOn = sunTarget.visible && sunTarget.strength > 0.05 && volumetricQ > 0;
      const want = sunOn
        ? RAY_MAX_STRENGTH * (1 - Math.exp(-clamp(volStrength, 0, 4) * volumetricQ * 1.6))
          * clamp(sunTarget.strength, 0, 1.5)
        : 0;

      // 显现稍快、消失稍慢
      const lambda = want > ru.uStrength.value ? L_RAY * 0.9 : L_RAY * 1.4;
      ru.uStrength.value = damp(ru.uStrength.value, want, lambda, d);

      // HDR 亮度阈值：直接沿用 Lead 已校准的 state.bloom.threshold（"什么才算真高光"的权威定义），
      // 略微放宽到 0.85 倍，让光束能吃进稍暗一点的树冠缝隙，但仍然完全排除雾与中间调。
      const thrTarget = clamp(0.85 * num(b.threshold, 1.35), 0.9, 1.6);
      const litExpT = clamp(num(state.exposure, 1.2), 0.3, 4.0);
      if (firstState) {
        ru.uThreshold.value = thrTarget;
        ru.uLitExposure.value = litExpT;
        ru.uDensity.value = clamp(0.62 + 0.32 * (density - 0.85), 0.5, 1.05);
        ru.uDecay.value = 0.985;
        ru.uWeight.value = 1.0;
      } else {
        ru.uThreshold.value = damp(ru.uThreshold.value, thrTarget, 2.0, d);
        ru.uLitExposure.value = damp(ru.uLitExposure.value, litExpT, 2.0, d);
        ru.uDensity.value = damp(ru.uDensity.value, clamp(0.62 + 0.32 * (density - 0.85), 0.5, 1.05), 2.0, d);
      }

      // 太阳位置平滑（可见时贴近，隐藏时保持原地淡出）
      sun.x = damp(sun.x, sunTarget.x, L_SUN, d);
      sun.y = damp(sun.y, sunTarget.y, L_SUN, d);
      ru.uSun.value.set(sun.x, sun.y);

      // 强度归零后彻底跳过这一环（不给低画质留任何开销）
      const wantEnabled = volumetricQ > 0 && ru.uStrength.value > 0.002;
      if (passes.godrays.enabled !== wantEnabled) passes.godrays.enabled = wantEnabled;
    }

    /* ---- 暗角避光 / 太阳位置同步给调色 ---- */
    if (gu) {
      gu.uSun.value.set(sun.x, sun.y);
      const relief = (volumetricQ > 0 && sunTarget.visible) ? clamp(ru ? ru.uStrength.value * 2.2 : 0, 0, 1) : 0;
      gu.uSunRelief.value = damp(gu.uSunRelief.value, relief, 2.4, d);
    }

    firstState = false;
  }

  /* ---------------------------------------------------------------- setQuality */
  function setQuality(key) {
    const next = QUALITY_PRESETS[key];
    if (!next) return;
    q = next;
    volumetricQ = clamp(num(q.volumetric, 1), 0, 1);
    rayTapsDirty = true;

    if (passes.bloom) {
      passes.bloom.enabled = q.bloom !== false;
    }
    if (passes.godrays && volumetricQ <= 0) {
      passes.godrays.enabled = false;
      passes.godrays.uniforms.uStrength.value = 0;
    }
  }

  /* ---------------------------------------------------------------- render */
  let failures = 0;
  function render(dt, time) {
    if (!composer || !api.enabled) {
      renderer.render(scene, camera);
      return;
    }
    try {
      if (typeof time === 'number') {
        const gu = passes.grade?.uniforms;
        if (gu) gu.uTime.value = time;
        const ru = passes.godrays?.uniforms;
        if (ru) ru.uTime.value = time;
      }
      composer.render(typeof dt === 'number' ? dt : undefined);
      failures = 0;
    } catch (err) {
      // 连续失败才判定管线不可用；偶发失败（如上下文瞬时问题）下一帧继续尝试
      failures += 1;
      if (failures <= 3) console.error('[postfx] 渲染异常 ' + failures + '/3', err);
      try {
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
      } catch (e) {
        console.error('[postfx] 降级渲染同样失败', e);
        failures = 3;
      }
      if (failures >= 3) {
        api.enabled = false;
        console.error('[postfx] 连续 3 帧失败，已永久降级为直接渲染（不再有后处理）');
      }
    }
  }

  const api = {
    composer,
    passes,
    enabled: !!composer,
    setSize,
    render,
    setState,
    setQuality,
  };

  // P4：main.js 用它决定是否关闭 CSS 兜底暗角（避免与 GradePass 的暗角叠成黑圈）。
  // 只有 GradePass 真的在链上并启用时才为 true。
  Object.defineProperty(api, 'gradeActive', {
    enumerable: true,
    get: () => !!(passes.grade && passes.grade.enabled !== false && api.enabled),
  });

  // 保证即使外部忘记调用 setSize，尺寸也是对的
  setSize(size.w, size.h, size.pr);

  console.log(
    `[postfx] 管线就绪：${Object.keys(passes).join(' → ')}`
    + ` · HDR=HalfFloat · bloom=${!!passes.bloom} · smaa=${!!passes.smaa}`
  );

  return api;
}
