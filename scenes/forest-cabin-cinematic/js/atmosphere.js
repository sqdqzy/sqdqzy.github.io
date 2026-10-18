/* Forest Cabin - fireflies, dust, chimney smoke, campfire, light shafts, birds, mist */
(function (global) {
  'use strict';
  var FC = global.FC;
  var THREE = global.THREE;
  var U = FC.util, lerp = U.lerp, clamp = U.clamp;

  /* ---------- shared GPU animated point sprites ---------- */
  var WANDER_VERT = [
    'attribute float aPhase;',
    'attribute float aSpeed;',
    'attribute float aSize;',
    'attribute float aRank;',
    'uniform float uTime, uAmount, uScale;',
    'varying float vAlpha;',
    'void main(){',
    '  vec3 p = position;',
    '  float t = uTime * aSpeed + aPhase;',
    '  p.x += sin(t * 0.61) * uScale + sin(t * 0.23) * uScale * 1.6;',
    '  p.z += cos(t * 0.47) * uScale * 0.9 + cos(t * 0.31) * uScale * 1.3;',
    '  p.y += sin(t * 0.85) * uScale * 0.45;',
    '  float blink = sin(uTime * 2.1 + aPhase * 9.0) * 0.5 + 0.5;',
    '  blink = pow(blink, 7.0);',
    '  vAlpha = blink * smoothstep(aRank, aRank - 0.12, uAmount);',
    '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
    '  gl_PointSize = aSize * 420.0 / max(0.001, -mv.z);',
    '  gl_Position = projectionMatrix * mv;',
    '}'
  ].join('\n');

  var WANDER_FRAG = [
    'uniform vec3 uColor;',
    'uniform float uIntensity;',
    'varying float vAlpha;',
    'void main(){',
    '  vec2 c = gl_PointCoord - 0.5;',
    '  float d = length(c);',
    '  if(d > 0.5) discard;',
    '  float a = pow(smoothstep(0.5, 0.0, d), 2.2);',
    '  gl_FragColor = vec4(uColor * uIntensity * (0.4 + vAlpha), a * vAlpha);',
    '  #include <encodings_fragment>',
    '}'
  ].join('\n');

  function wanderPoints(count, region, tex, color, size, opts) {
    opts = opts || {};
    var pos = new Float32Array(count * 3);
    var phase = new Float32Array(count);
    var speed = new Float32Array(count);
    var sizes = new Float32Array(count);
    var rank = new Float32Array(count);
    for (var i = 0; i < count; i++) {
      pos[i * 3] = lerp(region.x0, region.x1, Math.random());
      pos[i * 3 + 1] = lerp(region.y0, region.y1, Math.random());
      pos[i * 3 + 2] = lerp(region.z0, region.z1, Math.random());
      phase[i] = Math.random() * 100;
      speed[i] = 0.4 + Math.random() * 0.8;
      sizes[i] = size * (0.5 + Math.random());
      rank[i] = (i / count) * 0.95 + Math.random() * 0.05;
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    g.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    g.setAttribute('aRank', new THREE.BufferAttribute(rank, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 200);
    var uniforms = {
      uTime: { value: 0 },
      uAmount: { value: opts.amount === undefined ? 1 : opts.amount },
      uScale: { value: opts.scale || 1.4 },
      uColor: { value: new THREE.Color(color) },
      uIntensity: { value: opts.intensity === undefined ? 2.2 : opts.intensity }
    };
    var mat = new THREE.ShaderMaterial({
      uniforms: uniforms,
      vertexShader: WANDER_VERT,
      fragmentShader: WANDER_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false
    });
    var pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    return { points: pts, uniforms: uniforms };
  }

  /* ---------- cpu simulated smoke ---------- */
  var SMOKE_VERT = [
    'attribute float aSize;',
    'attribute float aAlpha;',
    'varying float vAlpha;',
    'void main(){',
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    '  gl_PointSize = aSize * 420.0 / max(0.001, -mv.z);',
    '  gl_Position = projectionMatrix * mv;',
    '  vAlpha = aAlpha;',
    '}'
  ].join('\n');
  var SMOKE_FRAG = [
    'uniform sampler2D map;',
    'uniform vec3 uColor;',
    'uniform float uOpacity;',
    'varying float vAlpha;',
    'void main(){',
    '  vec4 t = texture2D(map, gl_PointCoord);',
    '  gl_FragColor = vec4(uColor, t.a * vAlpha * uOpacity);',
    '  #include <encodings_fragment>',
    '}'
  ].join('\n');

  function create(scene, tex, terrain, cabin, props, quality) {
    var group = new THREE.Group();
    group.name = 'atmosphere';
    scene.add(group);
    var time = 0;

    /* ---------- fireflies ---------- */
    var flies = wanderPoints(quality.fireflies,
      { x0: -26, x1: 26, y0: 0.5, y1: 4.2, z0: -12, z1: 30 },
      tex, 0xffd27a, 0.055, { amount: 0, scale: 1.8, intensity: 2.6 });
    group.add(flies.points);

    /* ---------- dust motes in the air ---------- */
    var motes = wanderPoints(quality.motes,
      { x0: -18, x1: 18, y0: 0.4, y1: 6.5, z0: -6, z1: 20 },
      tex, 0xfff0d0, 0.03, { amount: 0.55, scale: 1.1, intensity: 1.1 });
    group.add(motes.points);

    /* ---------- chimney smoke ---------- */
    var smoke = (function () {
      var N = quality.smoke;
      var pos = new Float32Array(N * 3);
      var size = new Float32Array(N);
      var alpha = new Float32Array(N);
      var vel = new Float32Array(N * 3);
      var life = new Float32Array(N);
      var maxLife = new Float32Array(N);
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      g.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(-4, 8, 0), 60);
      var uniforms = {
        map: { value: tex.smoke },
        uColor: { value: new THREE.Color(0xb9bcbe) },
        uOpacity: { value: 0.5 }
      };
      var mat = new THREE.ShaderMaterial({
        uniforms: uniforms, vertexShader: SMOKE_VERT, fragmentShader: SMOKE_FRAG,
        transparent: true, depthWrite: false, fog: false
      });
      var pts = new THREE.Points(g, mat);
      pts.frustumCulled = false;
      group.add(pts);
      var top = cabin.chimneyTop;
      function spawn(i) {
        pos[i * 3] = top.x + (Math.random() - 0.5) * 0.12;
        pos[i * 3 + 1] = top.y;
        pos[i * 3 + 2] = top.z + (Math.random() - 0.5) * 0.12;
        vel[i * 3] = 0.25 + Math.random() * 0.35;
        vel[i * 3 + 1] = 0.85 + Math.random() * 0.6;
        vel[i * 3 + 2] = (Math.random() - 0.5) * 0.25;
        maxLife[i] = 5.5 + Math.random() * 4;
        life[i] = maxLife[i] * Math.random();
      }
      for (var i = 0; i < N; i++) spawn(i);
      return {
        pts: pts, uniforms: uniforms, N: N,
        update: function (dt, wind, hearthK) {
          for (var i = 0; i < N; i++) {
            life[i] -= dt;
            if (life[i] <= 0) spawn(i);
            var t = 1 - life[i] / maxLife[i];
            vel[i * 3] += (wind.x - vel[i * 3]) * dt * 0.35;
            vel[i * 3 + 1] += (wind.y - vel[i * 3 + 1]) * dt * 0.2;
            vel[i * 3 + 2] += (wind.z - vel[i * 3 + 2]) * dt * 0.35;
            pos[i * 3] += vel[i * 3] * dt;
            pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
            pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
            size[i] = lerp(0.5, 3.4, Math.pow(t, 0.7)) * (0.6 + hearthK * 0.7);
            alpha[i] = Math.sin(Math.min(1, t * 3.4) * Math.PI * 0.5) * (1 - t) * (1 - t) * 0.55;
          }
          g.attributes.position.needsUpdate = true;
          g.attributes.aSize.needsUpdate = true;
          g.attributes.aAlpha.needsUpdate = true;
        }
      };
    })();

    /* ---------- campfire flames + embers ---------- */
    var fire = (function () {
      var p = props.firepit;
      var g = new THREE.Group();
      g.position.copy(p);
      group.add(g);
      var flameMat = new THREE.MeshBasicMaterial({
        map: tex.warmGlow, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, opacity: 0.9, color: 0xffb050, fog: true
      });
      var planes = [];
      for (var i = 0; i < 3; i++) {
        var pl = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 1.4), flameMat);
        pl.rotation.y = i * Math.PI / 3;
        pl.position.y = 0.5;
        g.add(pl);
        planes.push(pl);
      }
      var core = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.7), flameMat.clone());
      core.material.color.setHex(0xfff0c0);
      core.position.set(0, 0.34, 0);
      g.add(core);
      /* embers */
      var N = quality.embers;
      var pos = new Float32Array(N * 3), vel = new Float32Array(N * 3);
      var size = new Float32Array(N), alpha = new Float32Array(N), life = new Float32Array(N);
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
      geo.boundingSphere = new THREE.Sphere(p.clone(), 12);
      var eUni = { map: { value: tex.glow }, uColor: { value: new THREE.Color(0xff9a40) }, uOpacity: { value: 1 } };
      var eMat = new THREE.ShaderMaterial({
        uniforms: eUni, vertexShader: SMOKE_VERT, fragmentShader: SMOKE_FRAG,
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false
      });
      var embers = new THREE.Points(geo, eMat);
      embers.frustumCulled = false;
      group.add(embers);
      function respawn(i) {
        pos[i * 3] = (Math.random() - 0.5) * 0.5;
        pos[i * 3 + 1] = 0.15 + Math.random() * 0.2;
        pos[i * 3 + 2] = (Math.random() - 0.5) * 0.5;
        vel[i * 3] = (Math.random() - 0.5) * 0.5;
        vel[i * 3 + 1] = 1.1 + Math.random() * 1.6;
        vel[i * 3 + 2] = (Math.random() - 0.5) * 0.5;
        life[i] = 1.4 + Math.random() * 1.8;
        size[i] = 0.018 + Math.random() * 0.03;
      }
      for (var i2 = 0; i2 < N; i2++) respawn(i2);
      return {
        group: g,
        update: function (dt, t, nightK, fireK) {
          var s = 0.85 + Math.sin(t * 9.1) * 0.12 + Math.sin(t * 13.7) * 0.08;
          for (var k = 0; k < planes.length; k++) {
            planes[k].scale.set(s * (0.8 + k * 0.12), s * (1.0 + Math.sin(t * 7 + k) * 0.18), 1);
            planes[k].position.y = 0.42 * s;
          }
          core.scale.set(s * 0.9, s * 0.85, 1);
          planes[0].material.opacity = 0.55 + 0.4 * (0.3 + fireK * 0.7);
          eUni.uOpacity.value = 0.6 + nightK * 0.4;
          for (var i = 0; i < N; i++) {
            life[i] -= dt;
            if (life[i] <= 0) respawn(i);
            vel[i * 3 + 1] -= dt * 0.25;
            vel[i * 3] += (Math.sin(t * 2 + i) * 0.4 - vel[i * 3]) * dt;
            pos[i * 3] += vel[i * 3] * dt;
            pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
            pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
            alpha[i] = Math.sin(clamp(life[i] / 2.2, 0, 1) * Math.PI) * 0.9;
          }
          geo.attributes.position.needsUpdate = true;
          geo.attributes.aSize.needsUpdate = true;
          geo.attributes.aAlpha.needsUpdate = true;
        }
      };
    })();

    /* ---------- god rays / light shafts ---------- */
    var shafts = (function () {
      var N = quality.shafts;
      var tex2 = (function () {
        /* soft vertical gradient with faded edges */
        var c = FC.util.makeCanvas(128, 256), ctx = c.getContext('2d');
        var g1 = ctx.createLinearGradient(0, 0, 0, 256);
        g1.addColorStop(0, 'rgba(255,244,220,0.85)');
        g1.addColorStop(0.55, 'rgba(255,238,205,0.32)');
        g1.addColorStop(1, 'rgba(255,230,190,0)');
        ctx.fillStyle = g1; ctx.fillRect(0, 0, 128, 256);
        var g2 = ctx.createLinearGradient(0, 0, 128, 0);
        g2.addColorStop(0, 'rgba(0,0,0,1)');
        g2.addColorStop(0.3, 'rgba(0,0,0,0)');
        g2.addColorStop(0.7, 'rgba(0,0,0,0)');
        g2.addColorStop(1, 'rgba(0,0,0,1)');
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = g2; ctx.fillRect(0, 0, 128, 256);
        return FC.tex.toTex(c, 1);
      })();
      var group2 = new THREE.Group();
      group2.renderOrder = 10;
      group.add(group2);
      var mat = new THREE.MeshBasicMaterial({
        map: tex2, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, depthTest: true, side: THREE.DoubleSide, fog: false
      });
      var items = [];
      for (var i = 0; i < N; i++) {
        var w = 1.2 + Math.random() * 3.2;
        var h = 12 + Math.random() * 14;
        var m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat.clone());
        var a = Math.random() * Math.PI * 2;
        var rad = 4 + Math.random() * 16;
        m.position.set(Math.cos(a) * rad, terrain.heightAt(0, 0) + 5 + Math.random() * 4, Math.sin(a) * rad + 4);
        m.userData = { h: h, w: w, seed: Math.random() * 10 };
        group2.add(m);
        items.push(m);
      }
      var mat4 = new THREE.Matrix4(), vx = new THREE.Vector3(), vy = new THREE.Vector3(), vz = new THREE.Vector3();
      var toCam = new THREE.Vector3(), up = new THREE.Vector3(), side = new THREE.Vector3();
      return {
        group: group2,
        update: function (camera, sunDir, strength, color) {
          up.copy(sunDir).multiplyScalar(-1).normalize();
          group2.visible = strength > 0.01;
          if (!group2.visible) return;
          for (var i = 0; i < items.length; i++) {
            var m = items[i];
            toCam.copy(camera.position).sub(m.position).normalize();
            side.copy(up).cross(toCam);
            if (side.lengthSq() < 0.0001) side.set(1, 0, 0);
            side.normalize();
            vz.copy(side).cross(up).normalize();
            vx.copy(side); vy.copy(up);
            mat4.makeBasis(vx, vy, vz);
            m.quaternion.setFromRotationMatrix(mat4);
            var pulse = 0.75 + Math.sin(time * 0.5 + m.userData.seed) * 0.25;
            m.material.opacity = strength * 0.3 * pulse;
            m.material.color.copy(color);
          }
        }
      };
    })();

    /* ---------- mist over the pond ---------- */
    var mist = (function () {
      var group3 = new THREE.Group();
      group.add(group3);
      var mat = new THREE.MeshBasicMaterial({
        map: tex.smoke, transparent: true, depthWrite: false, opacity: 0,
        color: 0xcfd8dc, fog: true
      });
      var items = [];
      var P = FC.World.POND;
      for (var i = 0; i < quality.mist; i++) {
        var m = new THREE.Mesh(new THREE.PlaneGeometry(11 + Math.random() * 8, 11 + Math.random() * 8), mat.clone());
        m.rotation.x = -Math.PI / 2;
        m.rotation.z = Math.random() * 3;
        m.position.set(P.x + (Math.random() - 0.5) * 22, P.water + 0.12 + Math.random() * 0.35, P.z + (Math.random() - 0.5) * 16);
        m.userData.seed = Math.random() * 10;
        group3.add(m);
        items.push(m);
      }
      return {
        group: group3,
        update: function (amount, dt) {
          group3.visible = amount > 0.01;
          for (var i = 0; i < items.length; i++) {
            var m = items[i];
            m.material.opacity = amount * 0.05;
            m.position.x += Math.sin(time * 0.05 + m.userData.seed) * dt * 0.25;
            m.position.z += Math.cos(time * 0.04 + m.userData.seed) * dt * 0.2;
          }
        }
      };
    })();

    /* ---------- birds ---------- */
    var birds = (function () {
      var N = quality.birds;
      var geo = (function () {
        var v = [
          0, 0, 0.16, -0.5, 0.05, -0.08, -0.12, 0, -0.02,
          0, 0, 0.16, 0.12, 0, -0.02, 0.5, 0.05, -0.08
        ];
        var g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
        g.computeVertexNormals();
        return g;
      })();
      var mat = new THREE.MeshBasicMaterial({ color: 0x1c1f22, side: THREE.DoubleSide, fog: true });
      var mesh = new THREE.InstancedMesh(geo, mat, N);
      mesh.frustumCulled = false;
      group.add(mesh);
      var data = [];
      for (var i = 0; i < N; i++) {
        data.push({
          r: 40 + Math.random() * 55,
          y: 22 + Math.random() * 16,
          p: Math.random() * 6.28,
          sp: 0.08 + Math.random() * 0.07,
          sc: 1.4 + Math.random() * 1.2,
          cx: (Math.random() - 0.5) * 30,
          cz: (Math.random() - 0.5) * 30,
          ph: Math.random() * 10
        });
      }
      var m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
      var v = new THREE.Vector3(), s = new THREE.Vector3();
      return {
        mesh: mesh,
        update: function (dt) {
          for (var i = 0; i < N; i++) {
            var b = data[i];
            b.p += b.sp * dt;
            var x = b.cx + Math.cos(b.p) * b.r;
            var z = b.cz + Math.sin(b.p) * b.r;
            var y = b.y + Math.sin(b.p * 2 + b.ph) * 2;
            e.set(Math.sin(time * 7 + b.ph) * 0.55, -b.p + Math.PI / 2, Math.sin(time * 7 + b.ph) * 0.3);
            q.setFromEuler(e);
            v.set(x, y, z);
            s.set(b.sc, b.sc, b.sc);
            m.compose(v, q, s);
            mesh.setMatrixAt(i, m);
          }
          mesh.instanceMatrix.needsUpdate = true;
        }
      };
    })();

    return {
      group: group,
      update: function (dt, camera, lighting, nightK, fireK) {
        time += dt;
        var wind = { x: 0.28 + Math.sin(time * 0.13) * 0.18, y: 0.1, z: 0.16 + Math.cos(time * 0.11) * 0.14 };
        flies.uniforms.uTime.value = time;
        flies.uniforms.uAmount.value = nightK;
        motes.uniforms.uTime.value = time;
        smoke.update(dt, wind, 0.4 + fireK * 0.6);
        smoke.uniforms.uOpacity.value = 0.35 + fireK * 0.3;
        fire.update(dt, time, nightK, fireK);
        shafts.update(camera, lighting.state().sunDir, lighting.shaftStrength, lighting.shaftColor);
        mist.update(lighting.mistAmount, dt);
        birds.update(dt);
      },
      setShafts: function (k) { shafts.group.visible = k > 0.01; },
      wind: function () { return { x: 0.28, y: 0.1, z: 0.16 }; }
    };
  }

  FC.Atmosphere = { create: create };

})(window);