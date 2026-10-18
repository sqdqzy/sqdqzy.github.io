/* Forest Cabin - HDR post pipeline: bright pass, dual level bloom, filmic grade, grain */
(function (global) {
  'use strict';
  var FC = global.FC;
  var THREE = global.THREE;
  var U = FC.util, clamp = U.clamp;

  var QUAD_VERT = [
    'varying vec2 vUv;',
    'void main(){',
    '  vUv = uv;',
    '  gl_Position = vec4(position.xy, 0.0, 1.0);',
    '}'
  ].join('\n');

  var BRIGHT_FRAG = [
    'uniform sampler2D tDiffuse;',
    'uniform float uThreshold, uKnee;',
    'varying vec2 vUv;',
    'void main(){',
    '  vec3 c = texture2D(tDiffuse, vUv).rgb;',
    '  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));',
    '  float s = smoothstep(uThreshold, uThreshold + uKnee, l);',
    '  gl_FragColor = vec4(c * s, 1.0);',
    '}'
  ].join('\n');

  var BLUR_FRAG = [
    'uniform sampler2D tDiffuse;',
    'uniform vec2 uDir;',
    'varying vec2 vUv;',
    'void main(){',
    '  vec3 c = texture2D(tDiffuse, vUv).rgb * 0.2270270270;',
    '  c += texture2D(tDiffuse, vUv + uDir * 1.3846153846).rgb * 0.3162162162;',
    '  c += texture2D(tDiffuse, vUv - uDir * 1.3846153846).rgb * 0.3162162162;',
    '  c += texture2D(tDiffuse, vUv + uDir * 3.2307692308).rgb * 0.0702702703;',
    '  c += texture2D(tDiffuse, vUv - uDir * 3.2307692308).rgb * 0.0702702703;',
    '  gl_FragColor = vec4(c, 1.0);',
    '}'
  ].join('\n');

  var COMPOSITE_FRAG = [
    'uniform sampler2D tDiffuse, tBloom, tBloom2;',
    'uniform float uExposure, uBloom, uVignette, uGrain, uTime, uCA, uSat, uContrast, uFade;',
    'uniform vec3 uTint, uLift;',
    'uniform vec2 uResolution;',
    'uniform float uBars;',
    'varying vec2 vUv;',

    'float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }',
    'vec3 aces(vec3 x){',
    '  float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;',
    '  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);',
    '}',
    'vec3 toSRGB(vec3 c){',
    '  c = max(c, vec3(0.0));',
    '  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));',
    '}',

    'void main(){',
    '  vec2 uv = vUv;',
    '  if(uv.y < uBars || uv.y > 1.0 - uBars){ gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }',
    '  vec2 d = uv - 0.5;',
    '  float r2 = dot(d, d);',
    '  float ca = uCA * r2;',
    '  vec3 col;',
    '  col.r = texture2D(tDiffuse, uv + d * ca).r;',
    '  col.g = texture2D(tDiffuse, uv).g;',
    '  col.b = texture2D(tDiffuse, uv - d * ca).b;',
    '  col += texture2D(tBloom, uv).rgb * uBloom;',
    '  col += texture2D(tBloom2, uv).rgb * uBloom * 0.85;',
    '  col *= uExposure;',
    '  col = aces(col);',
    '  col = toSRGB(col);',
    /* display space grade */
    '  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));',
    '  col = mix(vec3(l), col, uSat);',
    '  col = (col - 0.5) * uContrast + 0.5;',
    '  col = col * uTint + uLift;',
    /* vignette */
    '  float vig = smoothstep(1.05, 0.18, r2 * 1.9);',
    '  col *= mix(1.0, vig, uVignette);',
    '  col *= uFade;',
    /* film grain, strongest in the shadows */
    '  float n = hash(uv * uResolution + vec2(uTime * 91.7, uTime * 47.3));',
    '  float n2 = hash(uv * uResolution * 0.37 - vec2(uTime * 31.1, uTime * 13.7));',
    '  float g = mix(n, n2, 0.5);',
    '  col += (g - 0.5) * uGrain * (1.25 - l * 0.75);',
    '  gl_FragColor = vec4(max(col, 0.0), 1.0);',
    '}'
  ].join('\n');

  function makeRT(w, h, samples) {
    var o = {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: THREE.HalfFloatType,
      depthBuffer: true, stencilBuffer: false,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping
    };
    if (samples) o.samples = samples;
    return new THREE.WebGLRenderTarget(Math.max(2, w | 0), Math.max(2, h | 0), o);
  }

  function create(renderer, quality) {
    var quadScene = new THREE.Scene();
    var quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    var quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    quad.frustumCulled = false;
    quadScene.add(quad);

    var brightMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uThreshold: { value: 1.05 },
        uKnee: { value: 0.5 }
      },
      vertexShader: QUAD_VERT, fragmentShader: BRIGHT_FRAG, depthTest: false, depthWrite: false
    });
    var blurMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() } },
      vertexShader: QUAD_VERT, fragmentShader: BLUR_FRAG, depthTest: false, depthWrite: false
    });
    var compMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tBloom: { value: null },
        tBloom2: { value: null },
        uExposure: { value: 1.0 },
        uBloom: { value: 0.7 },
        uVignette: { value: 0.85 },
        uGrain: { value: 0.05 },
        uTime: { value: 0 },
        uCA: { value: 0.0022 },
        uSat: { value: 1.06 },
        uContrast: { value: 1.05 },
        uFade: { value: 1 },
        uTint: { value: new THREE.Vector3(1, 1, 1) },
        uLift: { value: new THREE.Vector3(0, 0, 0) },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uBars: { value: 0 }
      },
      vertexShader: QUAD_VERT, fragmentShader: COMPOSITE_FRAG, depthTest: false, depthWrite: false
    });

    var size = new THREE.Vector2(1, 1);
    var rtScene = null, rtA = null, rtB = null, rtC = null, rtD = null;

    function alloc(w, h) {
      dispose();
      size.set(w, h);
      var samples = quality.msaa;
      try {
        rtScene = makeRT(w, h, samples);
      } catch (e) {
        rtScene = makeRT(w, h, 0);
      }
      var hw = Math.max(2, w >> 1), hh = Math.max(2, h >> 1);
      var qw = Math.max(2, w >> 2), qh = Math.max(2, h >> 2);
      rtA = makeRT(hw, hh, 0);
      rtB = makeRT(hw, hh, 0);
      rtC = makeRT(qw, qh, 0);
      rtD = makeRT(qw, qh, 0);
      compMat.uniforms.uResolution.value.set(w, h);
    }
    function dispose() {
      [rtScene, rtA, rtB, rtC, rtD].forEach(function (r) { if (r) r.dispose(); });
      rtScene = rtA = rtB = rtC = rtD = null;
    }

    function draw(mat, target) {
      quad.material = mat;
      renderer.setRenderTarget(target);
      renderer.clear(true, true, false);
      renderer.render(quadScene, quadCam);
    }

    function blur(src, dst, dirX, dirY) {
      blurMat.uniforms.tDiffuse.value = src.texture;
      blurMat.uniforms.uDir.value.set(dirX / src.width, dirY / src.height);
      draw(blurMat, dst);
    }

    var time = 0;
    return {
      uniforms: compMat.uniforms,
      brightUniforms: brightMat.uniforms,
      setSize: alloc,
      getSize: function () { return size; },
      sceneRT: function () { return rtScene; },
      readScene: function (x, y, w, h) {
        var buf = new Uint16Array(w * h * 4);
        renderer.readRenderTargetPixels(rtScene, x, y, w, h, buf);
        return Array.prototype.slice.call(buf);
      },
      render: function (scene, camera, dt) {
        time += dt;
        /* 1. scene -> HDR target */
        renderer.setRenderTarget(rtScene);
        renderer.clear();
        renderer.render(scene, camera);
        /* 2. bright pass */
        brightMat.uniforms.tDiffuse.value = rtScene.texture;
        draw(brightMat, rtA);
        /* 3. blur at half res */
        blur(rtA, rtB, 1, 0);
        blur(rtB, rtA, 0, 1);
        blur(rtA, rtB, 1.7, 0);
        blur(rtB, rtA, 0, 1.7);
        /* 4. quarter res for the wide halo */
        blur(rtA, rtC, 2.4, 0);
        blur(rtC, rtD, 0, 2.4);
        blur(rtD, rtC, 4.1, 0);
        blur(rtC, rtD, 0, 4.1);
        /* 5. composite */
        compMat.uniforms.tDiffuse.value = rtScene.texture;
        compMat.uniforms.tBloom.value = rtA.texture;
        compMat.uniforms.tBloom2.value = rtD.texture;
        compMat.uniforms.uTime.value = time;
        quad.material = compMat;
        renderer.setRenderTarget(null);
        renderer.render(quadScene, quadCam);
      },
      dispose: dispose
    };
  }

  FC.Post = { create: create };

})(window);