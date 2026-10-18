/* Forest Cabin - sky dome, sun, clouds, stars, moon and image based lighting */
(function (global) {
  'use strict';
  var FC = global.FC;
  var THREE = global.THREE;

  var VERT = [
    'varying vec3 vDir;',
    'void main(){',
    '  vDir = position;',
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    '  gl_Position = projectionMatrix * mv;',
    '}'
  ].join('\n');

  var FRAG = [
    'varying vec3 vDir;',
    'uniform vec3 uSunDir, uSunColor, uZenith, uHorizon, uGround, uCloudLit, uCloudDark, uMoonDir;',
    'uniform float uSunSize, uSunIntensity, uCloud, uCloudSharp, uTime, uNight, uHaze, uStar, uMoon;',

    'float hash13(vec3 p){ p = fract(p*0.1031); p += dot(p, p.yzx+33.33); return fract((p.x+p.y)*p.z); }',
    'float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }',
    'float vnoise(vec2 p){',
    '  vec2 i = floor(p), f = fract(p);',
    '  vec2 u = f*f*(3.0-2.0*f);',
    '  float a = hash12(i), b = hash12(i+vec2(1.0,0.0)), c = hash12(i+vec2(0.0,1.0)), d = hash12(i+vec2(1.0,1.0));',
    '  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);',
    '}',
    'float fbm(vec2 p){',
    '  float s = 0.0, a = 0.5;',
    '  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);',
    '  for(int i=0;i<5;i++){ s += a*vnoise(p); p = m*p; a *= 0.5; }',
    '  return s;',
    '}',

    'void main(){',
    '  vec3 dir = normalize(vDir);',
    '  float h = dir.y;',
    '  float sunAmt = max(dot(dir, uSunDir), 0.0);',

    /* base gradient */
    '  float t = pow(clamp(h, 0.0, 1.0), 0.42);',
    '  vec3 col = mix(uHorizon, uZenith, t);',
    '  col = mix(col, uGround, smoothstep(0.0, -0.22, h));',
    /* haze glow around the sun near the horizon */
    '  col += uSunColor * pow(sunAmt, 5.0) * 0.30 * uHaze;',
    '  col += uSunColor * pow(sunAmt, 1.6) * 0.10 * uHaze;',

    /* clouds */
    '  if(h > 0.002){',
    '    vec2 cp = dir.xz / (h + 0.09);',
    '    cp = cp * 0.55 + vec2(uTime*0.0035, uTime*0.0016);',
    '    float n = fbm(cp);',
    '    float n2 = fbm(cp*2.3 + 11.0);',
    '    float d = n*0.75 + n2*0.25;',
    '    float cov = smoothstep(1.02 - uCloud, 1.02 - uCloud + uCloudSharp, d);',
    '    float horizonFade = smoothstep(0.0, 0.16, h);',
    '    float lit = pow(sunAmt, 2.0)*0.85 + 0.15;',
    '    vec3 cc = mix(uCloudDark, uCloudLit, clamp(lit*cov + (1.0-cov)*0.55, 0.0, 1.0));',
    '    float silver = pow(clamp(d - (1.02-uCloud) + 0.06, 0.0, 1.0), 2.0) * pow(sunAmt, 6.0);',
    '    cc += uSunColor * silver * 0.5;',
    '    col = mix(col, cc, cov * horizonFade * 0.92);',
    '  }',

    /* stars */
    '  if(uStar > 0.001 && h > -0.05){',
    '    vec3 sp = dir * 220.0;',
    '    vec3 ip = floor(sp); vec3 fp = fract(sp) - 0.5;',
    '    float rnd = hash13(ip);',
    '    float star = step(0.9955, rnd);',
    '    float d2 = length(fp);',
    '    float tw = 0.65 + 0.35*sin(uTime*2.2 + rnd*90.0);',
    '    col += vec3(0.85,0.9,1.0) * star * pow(max(0.0, 1.0 - d2*2.6), 7.0) * tw * uStar * smoothstep(0.0,0.2,h);',
    '  }',

    /* moon */
    '  float mAmt = max(dot(dir, uMoonDir), 0.0);',
    '  float moon = smoothstep(0.99955, 0.99975, mAmt);',
    '  col += vec3(0.82,0.86,0.98) * moon * uMoon * 2.2;',
    '  col += vec3(0.30,0.36,0.5) * pow(mAmt, 180.0) * uMoon * 0.6;',

    /* sun disk */
    '  float disk = smoothstep(uSunSize, uSunSize + 0.00035, sunAmt);',
    '  col += uSunColor * disk * uSunIntensity;',
    '  col += uSunColor * pow(sunAmt, 900.0) * uSunIntensity * 0.35;',

    '  gl_FragColor = vec4(col, 1.0);',
    '  #include <encodings_fragment>',
    '}'
  ].join('\n');

  function create() {
    var uniforms = {
      uSunDir: { value: new THREE.Vector3(0.4, 0.5, 0.6).normalize() },
      uSunColor: { value: new THREE.Color(1, 0.9, 0.75) },
      uZenith: { value: new THREE.Color(0x2a5b9e) },
      uHorizon: { value: new THREE.Color(0xbcd3e6) },
      uGround: { value: new THREE.Color(0x2a2a26) },
      uCloudLit: { value: new THREE.Color(0xfff2dc) },
      uCloudDark: { value: new THREE.Color(0x6d7a92) },
      uMoonDir: { value: new THREE.Vector3(-0.4, 0.5, -0.6).normalize() },
      uSunSize: { value: 0.99955 },
      uSunIntensity: { value: 14.0 },
      uCloud: { value: 0.5 },
      uCloudSharp: { value: 0.34 },
      uTime: { value: 0 },
      uNight: { value: 0 },
      uHaze: { value: 1 },
      uStar: { value: 0 },
      uMoon: { value: 0 }
    };

    var mat = new THREE.ShaderMaterial({
      uniforms: uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false
    });

    var geo = new THREE.SphereGeometry(900, 40, 24);
    var mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1000;
    mesh.name = 'sky';

    var pmrem = null;
    var envRT = null;
    var envScene = null;

    function refreshEnv(renderer) {
      if (!pmrem) pmrem = new THREE.PMREMGenerator(renderer);
      if (!envScene) {
        envScene = new THREE.Scene();
        var dome = new THREE.Mesh(geo, mat);
        dome.frustumCulled = false;
        envScene.add(dome);
      }
      var prev = envRT;
      envRT = pmrem.fromScene(envScene, 0, 1, 3000);
      if (prev) prev.dispose();
      return envRT.texture;
    }

    return {
      mesh: mesh,
      uniforms: uniforms,
      material: mat,
      refreshEnv: refreshEnv,
      dispose: function () { if (envRT) envRT.dispose(); if (pmrem) pmrem.dispose(); }
    };
  }

  FC.Sky = { create: create };

})(window);