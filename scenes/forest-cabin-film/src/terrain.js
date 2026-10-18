/**
 * terrain.js — 地形网格、小径、池塘水面
 * ---------------------------------------------------------------
 * 高度只从 core.terrainHeight 取；顶点色负责大尺度色斑（草皮 / 枯草 / 踩实泥土），
 * 贴图负责高频细节。两者相乘，颜色层次才不会出现「迷彩大色块」。
 */
import * as THREE from 'three';
import {
  WORLD, CLEARING, POND, PATH, CABIN,
  clamp, lerp, smoothstep, fbm, makeRng, TAU,
  terrainHeight, sampleTerrain, placement,
  texture, repeated, normalTex, instanced, place, mergeGeos,
} from './core.js';

const WATER_VERT = /* glsl */`
  varying vec3 vW;
  varying vec2 vUv;
  uniform float uTime;
  void main() {
    vUv = uv;
    vec3 p = position;
    // 轻微起伏，避免水面像一块玻璃板
    p.y += sin( p.x * 0.9 + uTime * 0.9 ) * 0.012 + sin( p.z * 1.3 - uTime * 0.7 ) * 0.010;
    vec4 wp = modelMatrix * vec4( p, 1.0 );
    vW = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const WATER_FRAG = /* glsl */`
  uniform vec3 uShallow, uDeep, uSky, uSunColor, uFogColor;
  uniform vec3 uSunDir, uCamPos;
  uniform float uTime, uFogDensity, uSunPower, uOpacity;
  varying vec3 vW;
  varying vec2 vUv;

  vec2 hash2( vec2 p ){
    p = vec2( dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)) );
    return -1.0 + 2.0 * fract( sin(p) * 43758.5453 );
  }
  float gnoise( vec2 p ){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix( mix( dot( hash2(i + vec2(0.0,0.0)), f - vec2(0.0,0.0)),
                     dot( hash2(i + vec2(1.0,0.0)), f - vec2(1.0,0.0)), u.x),
                 mix( dot( hash2(i + vec2(0.0,1.0)), f - vec2(0.0,1.0)),
                     dot( hash2(i + vec2(1.0,1.0)), f - vec2(1.0,1.0)), u.x), u.y);
  }
  // 三层错频滚动 = 看起来有风的波纹，而不是一张会动的噪点图
  float wave( vec2 p ){
    float s = 0.0;
    s += gnoise( p * 1.7 + vec2( uTime * 0.16, uTime * 0.09 ) ) * 0.55;
    s += gnoise( p * 3.9 - vec2( uTime * 0.23, uTime * 0.15 ) ) * 0.30;
    s += gnoise( p * 8.3 + vec2( uTime * 0.31, -uTime * 0.27 ) ) * 0.15;
    return s;
  }

  void main() {
    vec2 p = vW.xz;
    // 注意法线的比例：x/z 分量必须远小于 y 分量。之前把 (h-hx)*1.9 直接
    // 当水平分量、y 只有 0.077，结果法线几乎是横躺的 —— 菲涅尔在每个像素
    // 剧烈跳变，水面看起来像一块迷彩布而不是水。
    const float e = 0.42;
    float h  = wave( p );
    float hx = wave( p + vec2( e, 0.0 ) );
    float hz = wave( p + vec2( 0.0, e ) );
    vec3 n = normalize( vec3( -( h - hx ) * 0.11, e * 0.5, -( h - hz ) * 0.11 ) );

    vec3 V = normalize( uCamPos - vW );
    float fres = pow( 1.0 - clamp( dot( n, V ), 0.0, 1.0 ), 4.0 );
    fres = mix( 0.02, 0.75, fres );          // 反射上限压住，避免俯视时整片天光

    vec3 H = normalize( uSunDir + V );
    float spec = pow( max( dot( n, H ), 0.0 ), 340.0 ) * uSunPower;
    float sheen = pow( max( dot( n, H ), 0.0 ), 40.0 ) * 0.06 * uSunPower;

    // 岸边变浅：靠近圆边的地方水浅、颜色偏暖
    float shore = smoothstep( 0.0, 1.0, 1.0 - length( vUv - 0.5 ) * 2.0 );
    vec3 body = mix( uShallow, uDeep, smoothstep( 0.0, 0.75, shore ) );

    vec3 col = mix( body, uSky, fres * 0.7 );
    col += uSunColor * ( spec + sheen );

    float d = length( uCamPos - vW );
    float fog = 1.0 - exp( - uFogDensity * uFogDensity * d * d );
    col = mix( col, uFogColor, clamp( fog, 0.0, 1.0 ) );

    gl_FragColor = vec4( col, uOpacity );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function createTerrain(opt = {}) {
  const group = new THREE.Group();
  group.name = 'terrain';
  const quality = opt.quality || {};

  /* ---------------------------------------------------------- 地面网格 */
  const N = quality.segments || WORLD.segments;
  const SIZE = WORLD.size;
  const cell = SIZE / (N - 1);
  const half = SIZE / 2;

  const pos = new Float32Array(N * N * 3);
  const col = new Float32Array(N * N * 3);
  const H = new Float32Array(N * N);

  for (let iy = 0; iy < N; iy++) {
    for (let ix = 0; ix < N; ix++) {
      const i = iy * N + ix;
      const x = -half + ix * cell;
      const z = -half + iy * cell;
      const h = terrainHeight(x, z);
      H[i] = h;
      pos[i * 3] = x; pos[i * 3 + 1] = h; pos[i * 3 + 2] = z;
    }
  }

  const grass = new THREE.Color('#5c6a38');
  const wet = new THREE.Color('#414d2a');
  const dry = new THREE.Color('#96905a');
  const soil = new THREE.Color('#7d6a4f');   // 踩实的暖褐裸土，比草地亮才不会像铺了块地毯
  const mud = new THREE.Color('#4a3e26');
  const c = new THREE.Color();

  for (let iy = 0; iy < N; iy++) {
    for (let ix = 0; ix < N; ix++) {
      const i = iy * N + ix;
      const x = pos[i * 3], z = pos[i * 3 + 2], h = H[i];
      const s = sampleTerrain(x, z);
      const e = cell;
      const gx = (H[iy * N + Math.min(ix + 1, N - 1)] - H[iy * N + Math.max(ix - 1, 0)]) / (2 * e);
      const gz = (H[Math.min(iy + 1, N - 1) * N + ix] - H[Math.max(iy - 1, 0) * N + ix]) / (2 * e);
      const slope = 1 - 1 / Math.sqrt(1 + gx * gx + gz * gz);

      const wetK = smoothstep(0.03, 1.6, h - POND.level);       // 离水越近越湿
      const dryK = smoothstep(0.1, 0.46, slope);                // 陡坡露土
      // 院子是被踩出来的：中央踩实成裸土，边缘过渡到草。
      // 之前整块院子都是均匀的暗绿，和周围明亮的草地脱节，像铺了一块地毯。
      const inYard = s.cabinDist < CLEARING.radius + CLEARING.feather
        ? clamp((CLEARING.radius + CLEARING.feather - s.cabinDist) / CLEARING.feather, 0, 1)
        : 0;
      const trod = Math.pow(inYard, 1.5) * (0.35 + fbm(x * 0.26 + 2.7, z * 0.26 + 8.4, 3) * 1.1);
      const pack = 1 - smoothstep(PATH.halfWidth * 1.1, PATH.halfWidth * 3.6, s.pathDist);
      const mudK = 1 - smoothstep(POND.radius * 0.6, POND.radius * 1.7, s.pondDist);

      c.copy(grass);
      c.lerp(wet, clamp(1 - wetK, 0, 1) * 0.8);
      c.lerp(dry, dryK * 0.55);
      c.lerp(soil, Math.min(trod * 0.75, 0.72));
      c.lerp(soil, pack * 0.7);
      c.lerp(mud, mudK * 0.75);

      // 大尺度斑块：林子里草色本来就有深有浅。压得太平会变成「高尔夫果岭」，
      // 拉得太狠又会变成迷彩 —— 这里用两个频率叠出自然的不均匀。
      const n1 = fbm(x * 0.021 + 3.1, z * 0.021 - 1.7, 3) * 0.5 + 0.5;
      const n2 = fbm(x * 0.085 + 9.3, z * 0.085 - 4.1, 2) * 0.5 + 0.5;
      const n3 = fbm(x * 0.42 + 1.7, z * 0.42 + 5.5, 2) * 0.5 + 0.5;
      const shade = 0.62 + n1 * 0.54 + n2 * 0.18 + n3 * 0.07;
      // 亮斑偏暖黄、暗斑偏冷青，拉开色相而不只是明度
      c.offsetHSL((n1 - 0.5) * 0.05, (n2 - 0.5) * 0.16, 0);
      c.multiplyScalar(shade);

      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
  }
  // 顶点色写成「相对基准草色的乘子」而不是 albedo 本身：
  // 直接写 albedo 会再乘一遍贴图的颜色，整片草地会被压成黑绿。
  const invR = 1 / grass.r, invG = 1 / grass.g, invB = 1 / grass.b;
  for (let i = 0; i < N * N; i++) {
    col[i * 3] = clamp(col[i * 3] * invR, 0.22, 2.4);
    col[i * 3 + 1] = clamp(col[i * 3 + 1] * invG, 0.22, 2.4);
    col[i * 3 + 2] = clamp(col[i * 3 + 2] * invB, 0.22, 2.4);
  }

  const idx = new Uint32Array((N - 1) * (N - 1) * 6);
  let p = 0;
  for (let iy = 0; iy < N - 1; iy++) {
    for (let ix = 0; ix < N - 1; ix++) {
      const a = iy * N + ix, b = a + 1, d2 = a + N, e2 = d2 + 1;
      idx[p++] = a; idx[p++] = d2; idx[p++] = b;
      idx[p++] = b; idx[p++] = d2; idx[p++] = e2;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const groundMat = new THREE.MeshStandardMaterial({
    map: repeated(texture('ground', { size: 1024, seed: 61 }), SIZE / 5.5, SIZE / 5.5),
    normalMap: repeated(normalTex('ground', 1.1, { size: 512, seed: 61 }), SIZE / 5.5, SIZE / 5.5),
    normalScale: new THREE.Vector2(0.65, 0.65),
    vertexColors: true,
    roughness: 0.97,
    metalness: 0,
  });
  const ground = new THREE.Mesh(geo, groundMat);
  ground.name = 'ground';
  ground.receiveShadow = true;
  group.add(ground);

  /* ------------------------------------------------------------- 池水 */
  const wGeo = new THREE.CircleGeometry(POND.radius * 1.06, 72);
  wGeo.rotateX(-Math.PI / 2);
  const wMat = new THREE.ShaderMaterial({
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uShallow: { value: new THREE.Color('#4a5a42') },
      uDeep: { value: new THREE.Color('#1d2a2a') },
      uSky: { value: new THREE.Color('#8fb3d8') },
      uSunColor: { value: new THREE.Color('#ffd0a2') },
      uFogColor: { value: new THREE.Color('#c0a382') },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uCamPos: { value: new THREE.Vector3() },
      uFogDensity: { value: 0.004 },
      uSunPower: { value: 1 },
      uOpacity: { value: 0.94 },
    },
    transparent: true,
    depthWrite: false,
  });
  const water = new THREE.Mesh(wGeo, wMat);
  water.name = 'water';
  water.position.set(POND.center.x, POND.level, POND.center.z);
  water.renderOrder = 1;
  group.add(water);

  /* ------------------------------------------------------- 岸边与踏步 */
  const stoneGeo = new THREE.DodecahedronGeometry(1, 0);
  const rng = makeRng(4242);
  const stoneMat = new THREE.MeshStandardMaterial({
    map: repeated(texture('stone', { size: 256, seed: 47 }), 1, 1),
    normalMap: normalTex('stone', 1.3, { size: 256, seed: 47 }),
    normalScale: new THREE.Vector2(0.9, 0.9),
    color: 0x9a9488, roughness: 0.92, metalness: 0, vertexColors: true,
  });
  const stones = [];
  for (let i = 0; i < 320; i++) {
    const a = rng() * TAU;
    const r = POND.radius * (1.0 + Math.pow(rng(), 2) * 1.5);
    const x = POND.center.x + Math.cos(a) * r, z = POND.center.z + Math.sin(a) * r;
    const s = sampleTerrain(x, z);
    if (s.y < POND.level - 0.5) continue;
    if (s.y > POND.level + 2.2) continue;
    const sc = 0.16 + rng() * 0.5;
    stones.push({
      x, y: s.y - sc * 0.22, z,
      ry: rng() * TAU, rx: (rng() - 0.5) * 0.5, rz: (rng() - 0.5) * 0.5,
      s: sc, sy: sc * (0.5 + rng() * 0.4), sz: sc * (0.8 + rng() * 0.5),
      color: new THREE.Color().setScalar(0.72 + rng() * 0.5),
    });
  }
  // 小径踏步石
  for (let i = 0; i < 90; i++) {
    const t = i / 89;
    const x = lerp(PATH.from.x, PATH.to.x, t) + Math.sin(t * 5.2) * 3.0;
    const z = lerp(PATH.from.y, PATH.to.y, t) + Math.sin(t * 3.7) * 2.0;
    const s = sampleTerrain(x, z);
    stones.push({
      x, y: s.y + 0.02, z,
      ry: rng() * TAU, rx: (rng() - 0.5) * 0.2, rz: (rng() - 0.5) * 0.2,
      s: 0.3 + rng() * 0.28, sy: 0.1, sz: 0.26 + rng() * 0.24,
      color: new THREE.Color().setScalar(0.8 + rng() * 0.35),
    });
  }
  const stoneMesh = instanced(stoneGeo, stoneMat, stones, { shadows: false, receive: true, name: 'terrain-stones' });
  group.add(stoneMesh);

  /* --------------------------------------------------------------- 更新 */
  let time = 0;
  const camPos = new THREE.Vector3();

  function update(t, dt, state, camera) {
    time = t;
    const u = wMat.uniforms;
    u.uTime.value = t;
    u.uFogDensity.value = state.fog.density;
    u.uFogColor.value.set(state.fog.color);
    u.uSky.value.set(state.sky.horizon).lerp(new THREE.Color(state.sky.top), 0.45);
    u.uSunColor.value.set(state.sun.color);
    u.uSunDir.value.copy(state.sunDirection);
    u.uSunPower.value = clamp(state.sun.intensity / 5, 0.15, 1.6) * (1 - state.night * 0.75);
    if (camera) { camera.getWorldPosition(camPos); u.uCamPos.value.copy(camPos); }
  }

  return { group, update, water, ground };
}
