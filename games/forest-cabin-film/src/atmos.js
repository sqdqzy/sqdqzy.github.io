/**
 * atmos.js — 炊烟 / 浮尘 / 萤火
 * ---------------------------------------------------------------
 * 三种粒子都在相机周围循环复用，永远不会「用完」。
 * 浮尘只在逆光时明显（顺着太阳方向看过去），所以强度乘一个视线-太阳的权重。
 */
import * as THREE from 'three';
import { TAU, clamp, lerp, makeRng, texture } from './core.js';

const SMOKE_VERT = /* glsl */`
  attribute float aSize;
  attribute float aSeed;
  attribute float aLife;
  uniform float uProj;
  varying float vLife;
  void main() {
    vLife = aLife;
    vec4 mv = modelViewMatrix * vec4( position, 1.0 );
    // aSize 是「世界直径（米）」，乘投影系数才是屏幕像素。
    // 用固定的经验系数会随相机远近失控 —— 近处一颗浮尘能糊满整屏。
    gl_PointSize = clamp( aSize * uProj / max( -mv.z, 0.1 ), 1.0, 420.0 );
    gl_Position = projectionMatrix * mv;
  }
`;
const SMOKE_FRAG = /* glsl */`
  uniform sampler2D uTex;
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vLife;
  void main() {
    vec4 t = texture2D( uTex, gl_PointCoord );
    // 生灭各有一段淡入淡出，避免粒子「啪」地出现
    float env = smoothstep( 0.0, 0.14, vLife ) * smoothstep( 1.0, 0.62, vLife );
    float a = t.a * env * uOpacity;
    if ( a < 0.004 ) discard;
    gl_FragColor = vec4( uColor, a );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function createAtmos(opt = {}) {
  const group = new THREE.Group();
  group.name = 'atmos';
  const quality = opt.quality || {};
  const rng = makeRng(7717);
  const chimney = opt.chimney || new THREE.Vector3(0, 6, 0);

  const tex = texture;
  const scale = quality.particleScale ?? 1;

  /* ------------------------------------------------------------- 炊烟 */
  const SMOKE_N = Math.round(90 * scale);
  const smokeGeo = new THREE.BufferGeometry();
  {
    const pos = new Float32Array(SMOKE_N * 3);
    const size = new Float32Array(SMOKE_N);
    const seed = new Float32Array(SMOKE_N);
    const life = new Float32Array(SMOKE_N);
    for (let i = 0; i < SMOKE_N; i++) {
      // 世界直径：刚出烟囱 ~0.8m，一路飘散到 3m
      size[i] = 0.8 + rng() * 1.6;
      seed[i] = rng();
      life[i] = rng();
    }
    smokeGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    smokeGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    smokeGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    smokeGeo.setAttribute('aLife', new THREE.BufferAttribute(life, 1));
  }
  const smokeMat = new THREE.ShaderMaterial({
    uniforms: {
      uTex: { value: tex('smoke', { size: 128 }) },
      uColor: { value: new THREE.Color('#ded9cf') },
      uOpacity: { value: 0.34 },
      uProj: { value: 800 },
    },
    vertexShader: SMOKE_VERT,
    fragmentShader: SMOKE_FRAG,
    transparent: true,
    depthWrite: false,
  });
  const smoke = new THREE.Points(smokeGeo, smokeMat);
  smoke.frustumCulled = false;
  group.add(smoke);

  /* ------------------------------------------------------------- 浮尘 */
  const DUST_N = Math.round(620 * scale);
  const dustGeo = new THREE.BufferGeometry();
  const dustSeed = new Float32Array(DUST_N);
  {
    const pos = new Float32Array(DUST_N * 3);
    for (let i = 0; i < DUST_N; i++) {
      pos[i * 3] = (rng() - 0.5) * 34;
      pos[i * 3 + 1] = rng() * 9;
      pos[i * 3 + 2] = (rng() - 0.5) * 34;
      dustSeed[i] = rng();
    }
    dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    dustGeo.setAttribute('aSeed', new THREE.BufferAttribute(dustSeed, 1));
  }
  const dustMat = new THREE.ShaderMaterial({
    uniforms: {
      uTex: { value: tex('dust', { size: 64 }) },
      uOpacity: { value: 1 },
      uTime: { value: 0 },
      uProj: { value: 800 },
      uColor: { value: new THREE.Color('#ffe6bc') },
    },
    vertexShader: /* glsl */`
      attribute float aSeed;
      uniform float uTime;
      uniform float uOpacity;
      uniform float uProj;
      varying float vA;
      void main() {
        vec3 p = position;
        p.x += sin( uTime * 0.31 + aSeed * 31.0 ) * 0.5;
        p.y += sin( uTime * 0.22 + aSeed * 17.0 ) * 0.35;
        p.z += cos( uTime * 0.27 + aSeed * 23.0 ) * 0.5;
        vec4 mv = modelViewMatrix * vec4( p, 1.0 );
        // 浮尘只有 2~4cm，大了就不是尘埃而是雪
        gl_PointSize = clamp( ( 0.018 + aSeed * 0.03 ) * uProj / max( -mv.z, 0.1 ), 1.0, 9.0 );
        vA = ( 0.25 + aSeed * 0.75 ) * uOpacity;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uTex;
      uniform vec3 uColor;
      varying float vA;
      void main() {
        float a = texture2D( uTex, gl_PointCoord ).a * vA;
        if ( a < 0.004 ) discard;
        gl_FragColor = vec4( uColor, a );
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const dust = new THREE.Points(dustGeo, dustMat);
  dust.frustumCulled = false;
  group.add(dust);

  /* ----------------------------------------------------------- 萤火虫 */
  const FLY_N = Math.round(200 * scale);
  const flyGeo = new THREE.BufferGeometry();
  const flyHome = new Float32Array(FLY_N * 3);
  const flySeed = new Float32Array(FLY_N);
  {
    const pos = new Float32Array(FLY_N * 3);
    for (let i = 0; i < FLY_N; i++) {
      const a = rng() * TAU, r = 6 + Math.sqrt(rng()) * 34;
      flyHome[i * 3] = Math.cos(a) * r;
      flyHome[i * 3 + 1] = 0.4 + rng() * 2.6;
      flyHome[i * 3 + 2] = Math.sin(a) * r;
      pos.set(flyHome.subarray(i * 3, i * 3 + 3), i * 3);
      flySeed[i] = rng();
    }
    flyGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    flyGeo.setAttribute('aSeed', new THREE.BufferAttribute(flySeed, 1));
  }
  const flyMat = new THREE.ShaderMaterial({
    uniforms: { uTex: { value: tex('firefly', { size: 64 }) }, uOpacity: { value: 0 }, uTime: { value: 0 }, uProj: { value: 800 } },
    vertexShader: /* glsl */`
      attribute float aSeed;
      uniform float uTime;
      uniform float uProj;
      uniform float uOpacity;
      varying float vA;
      void main() {
        vec3 p = position;
        p.x += sin( uTime * 0.7 + aSeed * 41.0 ) * 1.1;
        p.y += sin( uTime * 0.9 + aSeed * 27.0 ) * 0.45;
        p.z += cos( uTime * 0.63 + aSeed * 33.0 ) * 1.1;
        vec4 mv = modelViewMatrix * vec4( p, 1.0 );
        gl_PointSize = clamp( ( 0.05 + aSeed * 0.07 ) * uProj / max( -mv.z, 0.1 ), 1.0, 26.0 );
        // 每只萤火虫有各自的闪烁节奏
        vA = pow( max( sin( uTime * ( 0.9 + aSeed * 1.6 ) + aSeed * 60.0 ), 0.0 ), 6.0 ) * uOpacity;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uTex;
      varying float vA;
      void main() {
        float a = texture2D( uTex, gl_PointCoord ).a * vA;
        if ( a < 0.004 ) discard;
        gl_FragColor = vec4( 0.85, 1.0, 0.55, a );
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const flies = new THREE.Points(flyGeo, flyMat);
  flies.frustumCulled = false;
  group.add(flies);

  /* ------------------------------------------------------------- 更新 */
  const _camDir = new THREE.Vector3();
  let time = 0;

  function update(t, dt, camera, state) {
    time = t;
    const night = clamp(state.night, 0, 1);
    // 投影系数 = 视口高的一半 / tan(fov/2)：所有粒子用它把「世界尺寸」换算成像素
    if (camera) {
      const proj = (camera.projectionMatrix.elements[5] || 1);
      const h = (opt.height || innerHeight) * (camera.zoom || 1);
      const v = (h * 0.5 * proj) || 800;
      smokeMat.uniforms.uProj.value = v;
      dustMat.uniforms.uProj.value = v;
      flyMat.uniforms.uProj.value = v;
    }

    // 炊烟：风越大切得越斜
    const wind = state.wind;
    const sp = smokeGeo.attributes.position;
    const life = smokeGeo.attributes.aLife;
    for (let i = 0; i < SMOKE_N; i++) {
      const l = (life.array[i] + t * (0.055 + wind * 0.03)) % 1;
      life.array[i] = l;
      const rise = l * 7.5;
      const spread = l * l * 2.6;
      const a = smokeGeo.attributes.aSeed.array[i] * TAU;
      sp.setXYZ(
        i,
        chimney.x + Math.cos(a + t * 0.2) * spread * 0.5 + wind * rise * 0.42,
        chimney.y + rise,
        chimney.z + Math.sin(a + t * 0.2) * spread * 0.5 + rise * 0.14,
      );
    }
    sp.needsUpdate = true;
    life.needsUpdate = true;
    smokeMat.uniforms.uOpacity.value = 0.3 * (1 - night * 0.55);

    // 浮尘：只在「朝着太阳看」时明显
    if (camera) {
      camera.getWorldDirection(_camDir);
      const back = clamp(_camDir.dot(state.sunDirection), 0, 1);
      dustMat.uniforms.uOpacity.value = clamp(0.25 + back * 0.95, 0, 1.2) * (1 - night * 0.85);
    }
    dustMat.uniforms.uTime.value = t;

    // 萤火虫跟着相机走，避免走出视野
    flyMat.uniforms.uOpacity.value = Math.pow(clamp(night - 0.45, 0, 1), 1.4) * 1.5;
    if (camera) {
      const fp = flyGeo.attributes.position;
      for (let i = 0; i < FLY_N; i++) {
        fp.setXYZ(i,
          flyHome[i * 3] + Math.round(camera.position.x / 34) * 34,
          flyHome[i * 3 + 1],
          flyHome[i * 3 + 2] + Math.round(camera.position.z / 34) * 34);
      }
      fp.needsUpdate = true;
    }
    flyMat.uniforms.uTime.value = t;
  }

  return { group, update };
}
