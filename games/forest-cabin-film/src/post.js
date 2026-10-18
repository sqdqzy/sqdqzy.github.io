/**
 * post.js — 后处理：屏幕空间光束 → 泛光 → ACES 输出 → SMAA → 调色
 * ---------------------------------------------------------------
 * 顺序不可调换，且 tone mapping 只能发生一次（在 OutputPass 里）。
 * three r185 只有在 currentRenderTarget === null 时才给材质注入 tone mapping，
 * 所以渲染进 composer 的 HDR 缓冲时是干净的线性值，调色放在最后一步最合适。
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { clamp, damp, lerp } from './core.js';

const FULLSCREEN_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }
`;

/* ------------------------------------------------------------ 光束 */
const GodRaysShader = {
  name: 'GodRays',
  uniforms: {
    tDiffuse: { value: null },
    uSun: { value: new THREE.Vector2(0.5, 0.5) },
    uAspect: { value: 1.777 },
    uStrength: { value: 0 },
    uSamples: { value: 24 },
    uThreshold: { value: 1.1 },
    uDensity: { value: 0.72 },
    uDecay: { value: 0.955 },
  },
  vertexShader: FULLSCREEN_VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uSun;
    uniform float uAspect, uStrength, uSamples, uThreshold, uDensity, uDecay;
    varying vec2 vUv;
    float hash( vec2 p ){ vec3 q = fract( vec3( p.xyx ) * 0.1031 ); q += dot( q, q.yzx + 33.33 ); return fract( ( q.x + q.y ) * q.z ); }
    void main() {
      vec3 base = texture2D( tDiffuse, vUv ).rgb;
      if ( uStrength < 0.002 ) { gl_FragColor = vec4( base, 1.0 ); return; }
      float lum = dot( base, vec3( 0.2126, 0.7152, 0.0722 ) );
      // 已经亮的像素不再加光，否则整片亮区互相加亮 = 均匀泛白
      float dark = 1.0 - 0.9 * smoothstep( 0.12, 1.3, lum );
      vec2 toSun = uSun - vUv;
      float dist = length( toSun * vec2( uAspect, 1.0 ) );
      float gate = smoothstep( 1.1, 0.04, dist );
      if ( gate < 0.002 ) { gl_FragColor = vec4( base, 1.0 ); return; }
      vec2 step = toSun * ( uDensity / uSamples );
      vec2 uv = vUv;
      float jitter = hash( gl_FragCoord.xy );
      uv -= step * jitter;
      float illum = 1.0;
      vec3 acc = vec3( 0.0 );
      for ( int i = 0; i < 32; i++ ) {
        if ( float( i ) >= uSamples ) break;
        uv -= step;
        vec3 s = texture2D( tDiffuse, uv ).rgb;
        float l = dot( s, vec3( 0.2126, 0.7152, 0.0722 ) );
        s *= smoothstep( uThreshold, uThreshold + 0.9, l );
        acc += s * illum * uDecay;
        illum *= uDecay;
      }
      // 柔性高光压缩 + 总量上限：光柱打在暗处，不能把画面糊成一片奶白
      acc = acc / float( uSamples );
      acc = acc / ( 1.0 + acc * 0.55 );
      gl_FragColor = vec4( base + acc * uStrength * dark * gate, 1.0 );
    }
  `,
};

/* ------------------------------------------------------------ 调色 */
const GradeShader = {
  name: 'Grade',
  uniforms: {
    tDiffuse: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uTemperature: { value: 0 },
    uContrast: { value: 1.05 },
    uSaturation: { value: 0.9 },
    uLift: { value: 0.012 },
    uVignette: { value: 0.3 },
    uGrain: { value: 0.03 },
    uSharpen: { value: 0.25 },
    uTime: { value: 0 },
  },
  vertexShader: FULLSCREEN_VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    uniform float uTemperature, uContrast, uSaturation, uLift, uVignette, uGrain, uSharpen, uTime;
    varying vec2 vUv;
    float hash( vec2 p ){ return fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ); }
    void main() {
      vec3 c = texture2D( tDiffuse, vUv ).rgb;

      // 锐化：轻微 unsharp mask，让木纹与草叶在高像素屏上不糊
      if ( uSharpen > 0.001 ) {
        vec3 blur = texture2D( tDiffuse, vUv + vec2( uTexel.x, 0.0 ) ).rgb
                   + texture2D( tDiffuse, vUv - vec2( uTexel.x, 0.0 ) ).rgb
                   + texture2D( tDiffuse, vUv + vec2( 0.0, uTexel.y ) ).rgb
                   + texture2D( tDiffuse, vUv - vec2( 0.0, uTexel.y ) ).rgb;
        c += ( c - blur * 0.25 ) * uSharpen;
      }

      // 色温：暖 = 抬红压蓝
      c.r *= 1.0 + uTemperature * 0.16;
      c.b *= 1.0 - uTemperature * 0.14;

      float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
      c = mix( vec3( l ), c, uSaturation );
      c = ( c - 0.5 ) * uContrast + 0.5;
      c += uLift * ( 1.0 - smoothstep( 0.0, 0.5, l ) );   // 暗部提亮只作用在暗处

      // 暗角
      vec2 d = vUv - 0.5;
      float vig = 1.0 - smoothstep( 0.34, 0.82, length( d ) * 1.28 ) * uVignette;
      c *= vig;

      // 胶片颗粒：随亮度衰减（亮部几乎无颗粒，暗部才有胶片感）
      float g = hash( vUv * 1024.0 + fract( uTime ) * 91.7 ) - 0.5;
      c += g * uGrain * ( 1.0 - smoothstep( 0.15, 0.85, l ) );

      gl_FragColor = vec4( max( c, 0.0 ), 1.0 );
    }
  `,
};

export function createPost({ renderer, scene, camera, quality }) {
  const composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const godrays = new ShaderPass(GodRaysShader);
  composer.addPass(godrays);

  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.3, 0.66, 1.45);
  composer.addPass(bloom);

  const output = new OutputPass();
  composer.addPass(output);

  /**
   * 阈值取样：UnrealBloomPass 的 threshold 直接作用在 HDR 线性值上，
   * 而 HDR 缓冲里的日光亮度是曝光**之前**的值，可以到 5~20。
   * 用固定阈值（1.4 左右）时，逆光镜头里整片天空都会超过阈值被卷进去 ——
   * 实测均值 0.61、四周全是奶白雾，关掉 bloom 才回到 0.30。
   * 所以这里把阈值锚到一个「安全的高位」，只让真正的光源（日轮精灵、
   * 窗口灯）参与泛光。
   */
  let bloomFloor = 6.0;

  // 抗锯齿：场景是渲染进 RT 的，MSAA 对它无效，只能放在 tone mapping 之后
  let smaa = null;
  try {
    smaa = new SMAAPass();
    composer.addPass(smaa);
  } catch (e) {
    console.warn('[post] SMAA 创建失败，边缘会有锯齿', e);
  }

  let grade = null;
  try {
    grade = new ShaderPass(GradeShader);
    composer.addPass(grade);
  } catch (e) {
    console.warn('[post] 调色 pass 创建失败，降级为直出', e);
  }

  const state = { grade: { temperature: 0, contrast: 1.05, saturation: 0.9, lift: 0.012, vignette: 0.3, grain: 0.03, sharpen: 0.25 } };
  let pr = 1;
  const sun = { x: 0.5, y: 0.5, strength: 0 };
  let time = 0;

  function setSize(w, h, pixelRatio) {
    pr = pixelRatio;
    composer.setPixelRatio(pixelRatio);
    composer.setSize(w, h);
    godrays.uniforms.uAspect.value = w / h;
    if (grade) grade.uniforms.uTexel.value.set(1 / (w * pixelRatio), 1 / (h * pixelRatio));
  }

  function setState(s, t, dt) {
    time = t;
    // 注意：dt 必须有下限。暂停时 dt = 0，damp(cur, target, λ, 0) = cur ——
    // uniform 永远停在旧值。后果是"截图模式下调 bloom 阈值"这种操作看起来
    // 完全没反应，而真正的原因是阻尼根本没跑。
    const d = clamp(dt > 0 ? dt : 0.016, 0.008, 0.1);
    const g = s.grade || {};
    const gu = grade && grade.uniforms;
    if (gu) {
      gu.uTemperature.value = damp(gu.uTemperature.value, g.temperature ?? 0, 3.0, d);
      gu.uContrast.value = damp(gu.uContrast.value, g.contrast ?? 1.05, 3.0, d);
      gu.uSaturation.value = damp(gu.uSaturation.value, g.saturation ?? 0.9, 3.0, d);
      gu.uLift.value = damp(gu.uLift.value, g.lift ?? 0.012, 3.0, d);
      gu.uVignette.value = damp(gu.uVignette.value, g.vignette ?? 0.3, 3.0, d);
      gu.uGrain.value = damp(gu.uGrain.value, g.grain ?? 0.03, 3.0, d);
      gu.uSharpen.value = damp(gu.uSharpen.value, g.sharpen ?? 0.25, 3.0, d);
      gu.uTime.value = t;
    }
    // 日轮进画时自动压 bloom 并抬阈值
    const inFrame = s.sunScreen && s.sunScreen.visible ? clamp((s.sunScreen.strength - 0.55) / 0.4, 0, 1) : 0;
    const bs = s.bloom || {};
    // 日轮进画时不仅降强度，还要抬阈值，避免整个天空被卷进泛光
    bloom.strength = damp(bloom.strength, (bs.strength ?? 0.3) * (1 - 0.5 * inFrame), 3.0, d);
    const thr = Math.max((bs.threshold ?? 1.45) * 2.2 + inFrame * 2.0, bloomFloor);
    bloom.threshold = damp(bloom.threshold, thr, 3.0, d);
    bloom.radius = damp(bloom.radius, bs.radius ?? 0.66, 3.0, d);

    const ru = godrays.uniforms;
    const vis = s.sunScreen && s.sunScreen.visible ? s.sunScreen.strength : 0;
    // 日轮在画面里时光束要额外收一档：此时天空本身就是最亮的像素，
    // 光束叠上去极易把整块天空推成纯白（实测直幅机位 mean 0.72 / 过曝 32%）。
    ru.uStrength.value = damp(ru.uStrength.value,
      vis * (s.volumetric ?? 0.3) * (quality.volumetric ?? 1) * (vis > 0.5 ? 0.1 : 0.26), 4.0, d);
    if (s.sunScreen) {
      sun.x = damp(sun.x, s.sunScreen.x, 6.0, d);
      sun.y = damp(sun.y, s.sunScreen.y, 6.0, d);
      ru.uSun.value.set(sun.x * 0.5 + 0.5, sun.y * 0.5 + 0.5);
    }
    ru.uSamples.value = 24;
  }

  return {
    composer, setSize, setState, gradePass: grade,
    render: (dt, t) => composer.render(dt),
    passes: () => composer.passes.map((p) => p.constructor.name),
  };
}
