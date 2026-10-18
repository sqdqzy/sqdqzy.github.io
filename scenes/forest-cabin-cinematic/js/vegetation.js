/* Forest Cabin - trees, bushes, ferns, grass, flowers, deadfall */
(function (global) {
  'use strict';
  var FC = global.FC;
  var THREE = global.THREE;
  var U = FC.util, G = FC.geo, lerp = U.lerp, clamp = U.clamp;
  var TAU = U.TAU;

  var uTime = { value: 0 };
  var env = { fogColor: new THREE.Color(0x8fa0a8), fogDensity: 0.015, night: 0 };

  /* wind sway + fade away from the lens, injected into any material */
  function patchWind(mat, amount, freq, near0, near1) {
    near0 = near0 === undefined ? 0.45 : near0;
    near1 = near1 === undefined ? 1.4 : near1;
    mat.onBeforeCompile = function (sh) {
      sh.uniforms.uTime = uTime;
      sh.uniforms.uSway = { value: amount };
      sh.uniforms.uFreq = { value: freq };
      sh.uniforms.uNear = { value: new THREE.Vector2(near0, near1) };
      sh.vertexShader = 'uniform float uTime;\nuniform float uSway;\nuniform float uFreq;\nuniform vec2 uNear;\n' + sh.vertexShader;
      sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>',
        '#include <begin_vertex>\n' +
        '#ifdef USE_INSTANCING\n' +
        '  vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);\n' +
        '  vec4 cpos = modelViewMatrix * (instanceMatrix * vec4(transformed, 1.0));\n' +
        '#else\n' +
        '  vec3 ip = vec3(0.0);\n' +
        '  vec4 cpos = modelViewMatrix * vec4(transformed, 1.0);\n' +
        '#endif\n' +
        'float wph = ip.x * 0.63 + ip.z * 0.47 + ip.y * 0.23;\n' +
        'float ws = sin(uTime * uFreq + wph) * 0.62 + sin(uTime * uFreq * 2.31 + wph * 1.7) * 0.26 + sin(uTime * uFreq * 4.7 + wph * 0.6) * 0.12;\n' +
        'float wh = max(transformed.y, 0.0);\n' +
        'transformed.x += ws * uSway * wh * wh;\n' +
        'transformed.z += ws * uSway * 0.55 * wh * wh;\n' +
        'transformed *= smoothstep(uNear.x, uNear.y, length(cpos.xyz));'
      );
    };
    return mat;
  }

  /* ---------- geometry factories ---------- */
  function coniferParts(rng, h, tiers, sparse) {
    var trunks = [], fol = [];
    var rBot = 0.15 + h * 0.013, rTop = rBot * 0.32;
    var tr = G.cyl(rTop, rBot, h * 0.98, 6);
    G.xf(tr, 0, h * 0.49, 0);
    trunks.push(G.paintJitter(tr, 0x6b5540, 0.12, rng));
    var flare = G.cyl(rTop * 0.9, rBot * 2.0, h * 0.045, 6);
    G.xf(flare, 0, h * 0.022, 0);
    trunks.push(G.paintJitter(flare, 0x5a4634, 0.1, rng));
    var i, t, y, r, ch;
    if (sparse) {
      /* bare dead tree */
      for (i = 0; i < 7; i++) {
        t = i / 7;
        y = h * (0.42 + t * 0.56);
        var bl = h * (0.30 - t * 0.22);
        var br = G.cyl(0.035, 0.075, bl, 5);
        var ang = rng.angle(), tilt = 0.85 - t * 0.45;
        G.xf(br, Math.cos(ang) * bl * 0.4, y + bl * 0.25, Math.sin(ang) * bl * 0.4, Math.cos(ang) * tilt, 0, -Math.sin(ang) * tilt);
        trunks.push(G.paintJitter(br, 0x7d7263, 0.14, rng));
      }
    } else {
      for (i = 0; i < tiers; i++) {
        t = i / (tiers - 1);
        y = lerp(h * 0.12, h * 0.93, Math.pow(t, 0.92));
        r = lerp(h * 0.34, h * 0.065, Math.pow(t, 0.9)) * (0.88 + rng.f() * 0.24);
        ch = h * (0.30 - t * 0.08) * (0.92 + rng.f() * 0.18);
        var cone = G.cone(r, ch, 7);
        G.lumpy(cone, 0.11, 2.6, rng);
        G.xf(cone, (rng.f() - 0.5) * 0.2, y + ch * 0.5, (rng.f() - 0.5) * 0.2);
        fol.push(cone);
      }
      /* leader spike */
      var spike = G.cone(h * 0.035, h * 0.12, 6);
      G.xf(spike, 0, h * 0.99, 0);
      fol.push(spike);
    }
    var folGeo = null;
    if (fol.length) {
      folGeo = G.merge(fol);
      var cDark = new THREE.Color(0x1c2c16), cMid = new THREE.Color(0x2a3d1e), cTip = new THREE.Color(0x44592c);
      G.paintFn(folGeo, function (c, x, y, z) {
        var t2 = clamp((y / h) * 1.05, 0, 1);
        if (t2 < 0.55) c.lerpColors(cDark, cMid, t2 / 0.55);
        else c.lerpColors(cMid, cTip, (t2 - 0.55) / 0.45);
        var j = 0.92 + 0.16 * Math.abs(Math.sin(x * 7.3 + z * 5.1 + y * 3.7));
        c.multiplyScalar(j);
      });
    }
    return { trunk: G.merge(trunks), foliage: folGeo, height: h };
  }

  function distantFirParts(rng, h) {
    var trunks = [], fol = [];
    var tr = G.cyl(h * 0.012, h * 0.03, h * 0.6, 5);
    G.xf(tr, 0, h * 0.3, 0);
    trunks.push(tr);
    for (var i = 0; i < 3; i++) {
      var t = i / 3;
      var cone = G.cone(lerp(h * 0.22, h * 0.07, t) * (0.9 + rng.f() * 0.2), h * (0.42 - t * 0.08), 6);
      G.xf(cone, 0, h * (0.24 + t * 0.28), 0);
      fol.push(cone);
    }
    var fg = G.merge(fol);
    G.paintFn(fg, function (c, x, y, z) { c.setHex(0x2b3d24).multiplyScalar(0.9 + 0.35 * clamp(y / h, 0, 1)); });
    return { trunk: G.merge(trunks), foliage: fg, height: h };
  }

  function birchParts(rng, h) {
    var parts = [];
    var lean = (rng.f() - 0.5) * 0.09;
    var rB = 0.14 + h * 0.011, rT = rB * 0.55;
    var seg = 4, i;
    for (i = 0; i < seg; i++) {
      var t0 = i / seg, t1 = (i + 1) / seg;
      var y0 = h * t0, y1 = h * t1;
      var p0x = lean * h * t0 * t0, p0z = lean * h * 0.4 * t0 * t0;
      var p1x = lean * h * t1 * t1, p1z = lean * h * 0.4 * t1 * t1;
      var seg_ = G.cyl(lerp(rT, rB, t1), lerp(rT, rB, t0), y1 - y0, 7);
      var ang = Math.atan2(p1z - p0z, p1x - p0x);
      var dx = p1x - p0x, dz = p1z - p0z;
      var tilt = Math.atan2(Math.sqrt(dx * dx + dz * dz), y1 - y0);
      G.xf(seg_, (p0x + p1x) / 2, (y0 + y1) / 2, (p0z + p1z) / 2, 0, -ang, 0);
      if (tilt > 0.001) { /* approximate lean, good enough at this scale */ }
      parts.push(seg_);
    }
    /* branches */
    var nb = 4 + Math.floor(rng.f() * 3);
    for (i = 0; i < nb; i++) {
      var t = 0.55 + rng.f() * 0.4;
      var a = rng.angle();
      var bl = h * (0.30 - (t - 0.55) * 0.35);
      var br = G.cyl(0.025, 0.06, bl, 5);
      G.xf(br, Math.cos(a) * bl * 0.42, h * t + bl * 0.3, Math.sin(a) * bl * 0.42,
        0, -a, -0.75);
      parts.push(br);
    }
    var geo = G.merge(parts);
    G.paintFn(geo, function (c, x, y, z) {
      var t = clamp(y / h, 0, 1);
      c.setRGB(1, 1, 1).multiplyScalar(lerp(0.82, 1.05, t));
      var ring = Math.abs(Math.sin(y * 9.0));
      c.multiplyScalar(1 - ring * 0.06);
    });
    return { trunk: geo, height: h };
  }

  function crossQuad(w, h, planes) {
    var parts = [];
    for (var i = 0; i < (planes || 3); i++) {
      var p = G.plane(w, h);
      G.xf(p, 0, h / 2, 0, 0, i * Math.PI / (planes || 3), 0);
      parts.push(p);
    }
    return G.merge(parts);
  }

  function bladeGeo(len, wid, bend) {
    var seg = 3, verts = [], norms = [], uvs = [], idx = [];
    for (var i = 0; i <= seg; i++) {
      var t = i / seg;
      var w = wid * (1 - t * 0.93);
      var y = len * t * (1 - t * 0.12);
      var z = bend * t * t;
      verts.push(-w, y, z, w, y, z);
      norms.push(-0.2, 0.35, 0.9, 0.2, 0.35, 0.9);
      uvs.push(0, t, 1, t);
    }
    for (i = 0; i < seg; i++) {
      var a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    return g;
  }

  function grassClump(rng) {
    var parts = [], n = 5 + Math.floor(rng.f() * 4);
    for (var i = 0; i < n; i++) {
      var a = rng.angle(), len = 0.28 + rng.f() * 0.34;
      var b = G.xf(bladeGeo(len, 0.016 + rng.f() * 0.008, 0.12 + rng.f() * 0.18),
        0, 0, 0, 0, a, 0);
      parts.push(G.xf(b, Math.cos(a) * 0.05, 0, Math.sin(a) * 0.05));
    }
    var g = G.merge(parts);
    G.paintFn(g, function (c, x, y, z) {
      var t = clamp(y / 0.6, 0, 1);
      c.setRGB(lerp(0.11, 0.27, t), lerp(0.19, 0.40, t), lerp(0.07, 0.15, t));
    });
    return g;
  }

  function bushGeo(rng) {
    var parts = [];
    var n = 3 + Math.floor(rng.f() * 3);
    for (var i = 0; i < n; i++) {
      var r = 0.26 + rng.f() * 0.3;
      var s = new THREE.IcosahedronGeometry(r, 1);
      G.lumpy(s, 0.22, 3.0, rng);
      G.xf(s, (rng.f() - 0.5) * 0.55, r * 0.75 + rng.f() * 0.22, (rng.f() - 0.5) * 0.55);
      parts.push(s);
    }
    var g = G.merge(parts);
    G.paintFn(g, function (c, x, y, z) {
      var t = clamp(y / 0.9, 0, 1);
      c.setRGB(lerp(0.16, 0.34, t), lerp(0.26, 0.50, t), lerp(0.10, 0.19, t));
    });
    return g;
  }

  function mushroomGeo(rng) {
    var parts = [];
    var n = 2 + Math.floor(rng.f() * 3);
    for (var i = 0; i < n; i++) {
      var h = 0.06 + rng.f() * 0.09;
      var stem = G.cyl(h * 0.32, h * 0.42, h, 5);
      G.xf(stem, (rng.f() - 0.5) * 0.22, h / 2, (rng.f() - 0.5) * 0.22);
      G.paint(stem, 0xd8cdb4);
      parts.push(stem);
      var cap = new THREE.SphereGeometry(h * 0.62, 7, 4, 0, TAU, 0, Math.PI * 0.55);
      G.xf(cap, (rng.f() - 0.5) * 0.22, h * 0.92, (rng.f() - 0.5) * 0.22);
      G.paint(cap, rng.chance(0.5) ? 0xa8483a : 0xb07048);
      parts.push(cap);
    }
    return G.merge(parts);
  }

  /* ---------- placement ---------- */
  function makeScatter(rng) {
    var grid = {}, cell = 4;
    return function (count, opts, out) {
      var tries = count * 16, t = 0;
      out = out || [];
      for (; t < tries && out.length < count; t++) {
        var a = rng.angle();
        var rr = Math.sqrt(lerp(opts.rMin * opts.rMin, opts.rMax * opts.rMax, rng.f()));
        var x = Math.cos(a) * rr + (opts.cx || 0);
        var z = Math.sin(a) * rr + (opts.cz || 0);
        if (opts.test && !opts.test(x, z, rr)) continue;
        var gx = Math.floor(x / cell), gz = Math.floor(z / cell);
        var ok = true, md = opts.minDist || 2;
        for (var dx = -1; dx <= 1 && ok; dx++) {
          for (var dz = -1; dz <= 1 && ok; dz++) {
            var arr = grid[(gx + dx) + '_' + (gz + dz)];
            if (!arr) continue;
            for (var i = 0; i < arr.length; i++) {
              var ddx = arr[i][0] - x, ddz = arr[i][1] - z;
              if (ddx * ddx + ddz * ddz < md * md) { ok = false; break; }
            }
          }
        }
        if (!ok) continue;
        var key = gx + '_' + gz;
        (grid[key] || (grid[key] = [])).push([x, z]);
        out.push([x, z, rr]);
      }
      return out;
    };
  }

  function create(scene, tex, terrain, quality) {
    var rng = new U.Rng(987654);
    var scatter = makeScatter(rng);
    var H = terrain.heightAt, TD = terrain.trailDist, P = FC.World.POND;
    var group = new THREE.Group();
    group.name = 'vegetation';
    scene.add(group);

    var nGlade = new U.Noise(9182);
    function gladeOpen(x, z) { return nGlade.fbm(x * 0.021 + 3, z * 0.021 - 7, 3); }

    /* the forest opens into a meadow on the camera side so the cabin is always readable */
    var FRONT_X = 0.42, FRONT_Z = 0.91;
    function clearRadius(x, z) {
      var d = Math.sqrt(x * x + z * z) || 1e-5;
      var f = (x / d) * FRONT_X + (z / d) * FRONT_Z;
      var front = f > 0 ? f : 0;
      return 12.0 + 24.0 * Math.pow(front, 1.5);
    }

    function treeTest(x, z, r) {
      if (TD(x, z) < (r < 30 ? 3.4 : 2.6)) return false;
      var dx = x - P.x, dz = z - P.z;
      if (dx * dx + dz * dz < (P.r + 4.5) * (P.r + 4.5)) return false;
      var rad = Math.sqrt(x * x + z * z);
      if (rad < clearRadius(x, z)) return false;
      var gate = r < 32 ? 0.47 : 0.34;
      return gladeOpen(x, z) > gate;
    }

    /* ---------- conifers ---------- */
    var coniferSpots = [];
    scatter(quality.conifers, { rMin: 12.5, rMax: 78, minDist: 4.0, test: treeTest }, coniferSpots);

    /* hand placed hero trees for composition */
    var HERO = [
      [-13.5, -5.5, 1.25], [11.0, -9.5, 1.15], [-9.5, 6.5, 0.95], [14.5, 10.5, 1.1],
      [-17.0, 13.0, 1.3], [6.0, -15.5, 1.0], [-22.0, -2.0, 1.35], [19.0, 3.0, 1.2],
      [-6.0, 25.0, 1.1], [24.0, 18.0, 1.25], [-25.0, 24.0, 1.2], [3.0, 22.0, 0.85]
    ];
    for (var hi = 0; hi < HERO.length; hi++) {
      var hx = HERO[hi][0], hz = HERO[hi][1];
      coniferSpots.push([hx, hz, Math.sqrt(hx * hx + hz * hz)]);
    }

    var coniferGeo = coniferParts(rng, 8.0, 8, false);
    var deadGeo = coniferParts(rng, 8.0, 0, true);
    var farGeo = distantFirParts(rng, 9);

    var matTrunk = new THREE.MeshStandardMaterial({
      map: tex.bark, normalMap: tex.barkNormal, normalScale: new THREE.Vector2(1.1, 1.1),
      roughness: 0.95, metalness: 0, color: 0xa89880, envMapIntensity: 0.45
    });
    var matFoliage = patchWind(new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.88, metalness: 0, side: THREE.DoubleSide,
      envMapIntensity: 0.55, flatShading: true
    }), 0.006, 1.15);
    var matFar = patchWind(new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.95, metalness: 0, envMapIntensity: 0.4
    }), 0.004, 1.0);
    var matDead = new THREE.MeshStandardMaterial({
      map: tex.bark, normalMap: tex.barkNormal, color: 0x6b6154, roughness: 0.97, envMapIntensity: 0.3
    });

    function buildInst(geo, mat, items, colorize, opts) {
      if (!items.length || !geo) return null;
      opts = opts || {};
      var mesh = new THREE.InstancedMesh(geo, mat, items.length);
      var m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
      var v = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color();
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        e.set(it.tilt || 0, it.rot || 0, it.tilt || 0);
        q.setFromEuler(e);
        v.set(it.x, it.y, it.z);
        s.set(it.s, it.s * (it.sq || 1), it.s);
        m.compose(v, q, s);
        mesh.setMatrixAt(i, m);
        if (colorize) {
          col.setRGB(1, 1, 1).offsetHSL(it.hue || 0, it.sat || 0, it.lum || 0);
          mesh.setColorAt(i, col);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = opts.cast !== false;
      mesh.receiveShadow = opts.recv !== false;
      mesh.frustumCulled = false;
      group.add(mesh);
      return mesh;
    }

    /* split the forest into a detailed inner band, a far band and deadfall */
    var buckets = { main: [], dead: [], far: [] };
    for (var ci = 0; ci < coniferSpots.length; ci++) {
      var sp = coniferSpots[ci], rr = sp[2];
      var h = 7.5 + rng.f() * 6.5;
      var bucket = rr > 63 ? 'far' : (rng.chance(0.022) ? 'dead' : 'main');
      buckets[bucket].push({
        x: sp[0], z: sp[1], y: H(sp[0], sp[1]) - 0.25, s: h / 8,
        sq: 0.9 + rng.f() * 0.22, rot: rng.angle(), tilt: (rng.f() - 0.5) * 0.06,
        lum: (rng.f() - 0.5) * 0.13, hue: (rng.f() - 0.5) * 0.03, sat: (rng.f() - 0.5) * 0.14
      });
    }
    buildInst(coniferGeo.trunk, matTrunk, buckets.main, false);
    buildInst(coniferGeo.foliage, matFoliage, buckets.main, true);
    buildInst(farGeo.trunk, matTrunk, buckets.far, false, { cast: false, recv: false });
    buildInst(farGeo.foliage, matFar, buckets.far, true, { cast: false, recv: false });
    buildInst(deadGeo.trunk, matDead, buckets.dead, false, { recv: false });

    /* an outer wall of cheap firs so the forest keeps going */
    var farItems = [];
    var farSpots = [];
    scatter(quality.farTrees, {
      rMin: 66, rMax: 110, minDist: 4.5,
      test: function (x, z) { return TD(x, z) > 3; }
    }, farSpots);
    for (var fi = 0; fi < farSpots.length; fi++) {
      var fh = 9 + rng.f() * 8;
      farItems.push({
        x: farSpots[fi][0], z: farSpots[fi][1], y: H(farSpots[fi][0], farSpots[fi][1]) - 0.3, s: fh / 9,
        sq: 0.92 + rng.f() * 0.2, rot: rng.angle(), tilt: (rng.f() - 0.5) * 0.05,
        lum: (rng.f() - 0.5) * 0.16
      });
    }
    buildInst(farGeo.trunk, matTrunk, farItems, false, { cast: false, recv: false });
    buildInst(farGeo.foliage, matFar, farItems, true, { cast: false, recv: false });

    /* ---------- birch grove ---------- */
    var birchSpots = [];
    scatter(quality.birch, {
      rMin: 13, rMax: 62, minDist: 3.2,
      test: function (x, z, r) {
        if (TD(x, z) < 2.8) return false;
        var dx = x - P.x, dz = z - P.z;
        if (dx * dx + dz * dz < (P.r + 3) * (P.r + 3)) return false;
        if (Math.sqrt(x * x + z * z) < clearRadius(x, z) - 3) return false;
        return gladeOpen(x, z) > 0.4;
      }
    }, birchSpots);
    /* birches along the meadow edge, good silhouettes for the wide shots */
    [[-15.5, 6.5], [-17.5, 11.0], [16.5, 3.5], [18.5, -3.0], [-13.0, 16.5], [13.0, -13.0],
    [-21.0, 15.0], [22.0, 8.0], [-18.0, -6.0], [9.0, 19.0], [-9.0, -14.0], [24.0, -12.0]]
      .forEach(function (p) { birchSpots.push([p[0], p[1], Math.sqrt(p[0] * p[0] + p[1] * p[1])]); });

    var birchGeo = birchParts(rng, 9).trunk;
    var matBirch = new THREE.MeshStandardMaterial({
      map: tex.birch, normalMap: tex.birchNormal, roughness: 0.82, metalness: 0,
      color: 0xffffff, envMapIntensity: 0.55, vertexColors: true
    });
    var birchMesh = new THREE.InstancedMesh(birchGeo, matBirch, birchSpots.length);
    var birchData = [];
    {
      var m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
      var v = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color();
      for (var i = 0; i < birchSpots.length; i++) {
        var sp = birchSpots[i];
        var h = 7.5 + rng.f() * 4.5;
        var sc = h / 9;
        e.set((rng.f() - 0.5) * 0.05, rng.angle(), (rng.f() - 0.5) * 0.05);
        q.setFromEuler(e);
        v.set(sp[0], H(sp[0], sp[1]) - 0.2, sp[1]);
        s.set(sc, sc, sc);
        m.compose(v, q, s);
        birchMesh.setMatrixAt(i, m);
        col.setRGB(1, 1, 1).offsetHSL(0, 0, (rng.f() - 0.5) * 0.12);
        birchMesh.setColorAt(i, col);
        birchData.push({ x: sp[0], z: sp[1], y: H(sp[0], sp[1]), h: h, sc: sc, rot: e.y });
      }
      birchMesh.instanceMatrix.needsUpdate = true;
      if (birchMesh.instanceColor) birchMesh.instanceColor.needsUpdate = true;
      birchMesh.castShadow = true; birchMesh.receiveShadow = false;
      group.add(birchMesh);
    }

    /* ---------- leaf cards (birch canopy + shrub tops) ---------- */
    var leafGeo = crossQuad(1.9, 1.7, 2);
    var matLeaf = patchWind(new THREE.MeshStandardMaterial({
      map: tex.leaf, alphaMap: tex.leafA, alphaTest: 0.42, transparent: false, side: THREE.DoubleSide,
      roughness: 0.9, metalness: 0, envMapIntensity: 0.5, vertexColors: true
    }), 0.05, 1.6, 1.6, 5.0);
    var leafSpots = [];
    for (var bi = 0; bi < birchData.length; bi++) {
      var b = birchData[bi];
      var cards = 12;
      for (var k = 0; k < cards; k++) {
        var a = rng.angle(), rr = rng.f() * b.sc * 1.9;
        var yy = b.y + b.h * (0.58 + rng.f() * 0.4);
        leafSpots.push({
          x: b.x + Math.cos(a) * rr * 1.15, y: yy, z: b.z + Math.sin(a) * rr,
          s: (1.7 + rng.f() * 1.0) * b.sc * 1.15, rot: rng.angle(), tint: rng.f() * 0.5
        });
      }
    }
    /* shrub leaf cards */
    var bushSpots = [];
    scatter(quality.bushes, {
      rMin: 7, rMax: 46, minDist: 1.5,
      test: function (x, z) {
        if (TD(x, z) < 1.1) return false;
        var dx = x - P.x, dz = z - P.z;
        if (dx * dx + dz * dz < (P.r - 0.5) * (P.r - 0.5)) return false;
        if (x * x + z * z < 7 * 7) return false;
        return true;
      }
    }, bushSpots);
    /* shrubs keep their lumpy body only; leaf cards are reserved for tree canopies */
    for (var si = 0; si < bushSpots.length; si++) {
      var bs = bushSpots[si];
      var by = H(bs[0], bs[1]);
      var bscale = 0.7 + rng.f() * 0.9;
      bs.push({ y: by, s: bscale });
    }
    var leafMesh = new THREE.InstancedMesh(leafGeo, matLeaf, leafSpots.length);
    {
      var m2 = new THREE.Matrix4(), q2 = new THREE.Quaternion(), e2 = new THREE.Euler();
      var v2 = new THREE.Vector3(), s2 = new THREE.Vector3(), c2 = new THREE.Color();
      for (var i2 = 0; i2 < leafSpots.length; i2++) {
        var L = leafSpots[i2];
        e2.set((rng.f() - 0.5) * 0.4, L.rot, (rng.f() - 0.5) * 0.4);
        q2.setFromEuler(e2);
        v2.set(L.x, L.y, L.z);
        s2.set(L.s, L.s, L.s);
        m2.compose(v2, q2, s2);
        leafMesh.setMatrixAt(i2, m2);
        c2.setRGB(1, 1, 1).offsetHSL((rng.f() - 0.5) * 0.05, (rng.f() - 0.5) * 0.25, (rng.f() - 0.5) * 0.3 + L.tint * 0.06);
        leafMesh.setColorAt(i2, c2);
      }
      leafMesh.instanceMatrix.needsUpdate = true;
      if (leafMesh.instanceColor) leafMesh.instanceColor.needsUpdate = true;
      leafMesh.castShadow = true;
      leafMesh.receiveShadow = false;
      group.add(leafMesh);
    }

    /* ---------- shrubs (solid blobs under the cards) ---------- */
    var bushGeo1 = bushGeo(rng);
    var matBush = patchWind(new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.92, metalness: 0, flatShading: true, envMapIntensity: 0.45
    }), 0.02, 1.4, 1.2, 3.6);
    var bushMesh = new THREE.InstancedMesh(bushGeo1, matBush, bushSpots.length);
    {
      var m3 = new THREE.Matrix4(), q3 = new THREE.Quaternion(), e3 = new THREE.Euler();
      var v3 = new THREE.Vector3(), s3 = new THREE.Vector3(), c3 = new THREE.Color();
      for (var i3 = 0; i3 < bushSpots.length; i3++) {
        var B = bushSpots[i3];
        e3.set(0, rng.angle(), 0);
        q3.setFromEuler(e3);
        v3.set(B[0], B[2] !== undefined ? B[2] : H(B[0], B[1]), B[1]);
        var sc = B[3] ? B[3].s : (0.7 + rng.f() * 0.9);
        s3.set(sc, sc * (0.85 + rng.f() * 0.3), sc);
        m3.compose(v3, q3, s3);
        bushMesh.setMatrixAt(i3, m3);
        c3.setRGB(1, 1, 1).offsetHSL((rng.f() - 0.5) * 0.05, (rng.f() - 0.5) * 0.16, (rng.f() - 0.5) * 0.14);
        bushMesh.setColorAt(i3, c3);
      }
      bushMesh.instanceMatrix.needsUpdate = true;
      if (bushMesh.instanceColor) bushMesh.instanceColor.needsUpdate = true;
      bushMesh.castShadow = true; bushMesh.receiveShadow = false;
      group.add(bushMesh);
    }

    /* ---------- ferns ---------- */
    var fernGeo = crossQuad(0.85, 0.7, 3);
    var matFern = patchWind(new THREE.MeshStandardMaterial({
      map: tex.fern, alphaMap: tex.fernA, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.9,
      envMapIntensity: 1.1, vertexColors: true
    }), 0.09, 1.3, 0.5, 1.6);
    var fernSpots = [];
    scatter(quality.ferns, {
      rMin: 5.5, rMax: 44, minDist: 0.55,
      test: function (x, z) {
        if (TD(x, z) < 1.0) return false;
        var dx = x - P.x, dz = z - P.z;
        if (dx * dx + dz * dz < (P.r - 0.3) * (P.r - 0.3)) return false;
        return true;
      }
    }, fernSpots);
    var fernMesh = new THREE.InstancedMesh(fernGeo, matFern, fernSpots.length);
    {
      var m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), e4 = new THREE.Euler();
      var v4 = new THREE.Vector3(), s4 = new THREE.Vector3(), c4 = new THREE.Color();
      for (var i4 = 0; i4 < fernSpots.length; i4++) {
        var F = fernSpots[i4];
        var sc = 0.7 + rng.f() * 0.85;
        e4.set((rng.f() - 0.5) * 0.25, rng.angle(), (rng.f() - 0.5) * 0.25);
        q4.setFromEuler(e4);
        v4.set(F[0], H(F[0], F[1]) - 0.05, F[1]);
        s4.set(sc, sc * (0.85 + rng.f() * 0.4), sc);
        m4.compose(v4, q4, s4);
        fernMesh.setMatrixAt(i4, m4);
        c4.setRGB(1, 1, 1).offsetHSL((rng.f() - 0.5) * 0.05, (rng.f() - 0.5) * 0.3, (rng.f() - 0.5) * 0.22);
        fernMesh.setColorAt(i4, c4);
      }
      fernMesh.instanceMatrix.needsUpdate = true;
      if (fernMesh.instanceColor) fernMesh.instanceColor.needsUpdate = true;
      fernMesh.castShadow = false; fernMesh.receiveShadow = false;
      group.add(fernMesh);
    }

    /* ---------- grass tufts ---------- */
    var tuftGeo = crossQuad(0.55, 0.42, 3);
    var matTuft = patchWind(new THREE.MeshStandardMaterial({
      map: tex.tuft, alphaMap: tex.tuftA, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.9,
      envMapIntensity: 1.15, vertexColors: true
    }), 0.11, 1.9, 0.4, 1.2);
    var tuftSpots = [];
    scatter(quality.tufts, {
      rMin: 3.2, rMax: 62, minDist: 0.42,
      test: function (x, z) {
        if (TD(x, z) < 0.55) return false;
        if (x * x + z * z < 30) return false;
        var dx = x - P.x, dz = z - P.z;
        if (dx * dx + dz * dz < (P.r - 0.2) * (P.r - 0.2)) return false;
        return true;
      }
    }, tuftSpots);
    var tuftMesh = new THREE.InstancedMesh(tuftGeo, matTuft, tuftSpots.length);
    {
      var m5 = new THREE.Matrix4(), q5 = new THREE.Quaternion(), e5 = new THREE.Euler();
      var v5 = new THREE.Vector3(), s5 = new THREE.Vector3(), c5 = new THREE.Color();
      for (var i5 = 0; i5 < tuftSpots.length; i5++) {
        var T2 = tuftSpots[i5];
        var sc = 0.65 + rng.f() * 0.9;
        e5.set(0, rng.angle(), 0);
        q5.setFromEuler(e5);
        v5.set(T2[0], H(T2[0], T2[1]) - 0.04, T2[1]);
        s5.set(sc, sc * (0.75 + rng.f() * 0.4), sc);
        m5.compose(v5, q5, s5);
        tuftMesh.setMatrixAt(i5, m5);
        c5.setRGB(1, 1, 1).offsetHSL((rng.f() - 0.5) * 0.06, (rng.f() - 0.5) * 0.35, (rng.f() - 0.5) * 0.28);
        tuftMesh.setColorAt(i5, c5);
      }
      tuftMesh.instanceMatrix.needsUpdate = true;
      if (tuftMesh.instanceColor) tuftMesh.instanceColor.needsUpdate = true;
      tuftMesh.castShadow = false; tuftMesh.receiveShadow = false;
      group.add(tuftMesh);
    }

    /* ---------- 3d grass clumps near camera range ---------- */
    var clumpGeo = grassClump(rng);
    var matClump = patchWind(new THREE.MeshStandardMaterial({
      vertexColors: true, side: THREE.DoubleSide, roughness: 0.85, envMapIntensity: 1.2
    }), 0.16, 2.1, 0.4, 1.2);
    var clumpSpots = [];
    scatter(quality.clumps, {
      rMin: 3.5, rMax: 24, minDist: 0.3,
      test: function (x, z) {
        if (TD(x, z) < 0.4) return false;
        var dx = x - P.x, dz = z - P.z;
        if (dx * dx + dz * dz < (P.r - 0.2) * (P.r - 0.2)) return false;
        return true;
      }
    }, clumpSpots);
    var clumpMesh = new THREE.InstancedMesh(clumpGeo, matClump, clumpSpots.length);
    {
      var m6 = new THREE.Matrix4(), q6 = new THREE.Quaternion(), e6 = new THREE.Euler();
      var v6 = new THREE.Vector3(), s6 = new THREE.Vector3(), c6 = new THREE.Color();
      for (var i6 = 0; i6 < clumpSpots.length; i6++) {
        var C = clumpSpots[i6];
        var sc = 0.7 + rng.f() * 0.9;
        e6.set(0, rng.angle(), 0);
        q6.setFromEuler(e6);
        v6.set(C[0], H(C[0], C[1]) - 0.03, C[1]);
        s6.set(sc, sc * (0.85 + rng.f() * 0.5), sc);
        m6.compose(v6, q6, s6);
        clumpMesh.setMatrixAt(i6, m6);
        c6.setRGB(1, 1, 1).offsetHSL(0, (rng.f() - 0.5) * 0.2, (rng.f() - 0.5) * 0.3);
        clumpMesh.setColorAt(i6, c6);
      }
      clumpMesh.instanceMatrix.needsUpdate = true;
      if (clumpMesh.instanceColor) clumpMesh.instanceColor.needsUpdate = true;
      clumpMesh.castShadow = false; clumpMesh.receiveShadow = false;
      group.add(clumpMesh);
    }

    /* ---------- flowers ---------- */
    var flowerGeo = crossQuad(0.34, 0.34, 2);
    var matFlower = patchWind(new THREE.MeshStandardMaterial({
      map: tex.flower, alphaMap: tex.flowerA, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.8,
      envMapIntensity: 0.6, vertexColors: true
    }), 0.12, 2.2, 0.4, 1.2);
    var flowerSpots = [];
    scatter(quality.flowers, {
      rMin: 4, rMax: 34, minDist: 0.3,
      test: function (x, z) {
        if (x * x + z * z < 49) return false;
        var d = TD(x, z);
        return d > 0.7 && d < 6.5;
      }
    }, flowerSpots);
    var flowerMesh = new THREE.InstancedMesh(flowerGeo, matFlower, flowerSpots.length);
    {
      var m7 = new THREE.Matrix4(), q7 = new THREE.Quaternion(), e7 = new THREE.Euler();
      var v7 = new THREE.Vector3(), s7 = new THREE.Vector3(), c7 = new THREE.Color();
      for (var i7 = 0; i7 < flowerSpots.length; i7++) {
        var F2 = flowerSpots[i7];
        var sc = 0.8 + rng.f() * 0.8;
        e7.set(0, rng.angle(), 0);
        q7.setFromEuler(e7);
        v7.set(F2[0], H(F2[0], F2[1]) + 0.06, F2[1]);
        s7.set(sc, sc, sc);
        m7.compose(v7, q7, s7);
        flowerMesh.setMatrixAt(i7, m7);
        c7.setRGB(1, 1, 1).multiplyScalar(0.9 + rng.f() * 0.35);
        flowerMesh.setColorAt(i7, c7);
      }
      flowerMesh.instanceMatrix.needsUpdate = true;
      if (flowerMesh.instanceColor) flowerMesh.instanceColor.needsUpdate = true;
      flowerMesh.castShadow = false; flowerMesh.receiveShadow = false;
      group.add(flowerMesh);
    }

    /* ---------- mushrooms ---------- */
    var mushGeo = mushroomGeo(rng);
    var matMush = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, envMapIntensity: 0.5 });
    var mushSpots = [];
    scatter(Math.round(quality.tufts * 0.025), {
      rMin: 10, rMax: 42, minDist: 1.6,
      test: function (x, z) { return TD(x, z) > 3; }
    }, mushSpots);
    var mushMesh = new THREE.InstancedMesh(mushGeo, matMush, mushSpots.length);
    {
      var m8 = new THREE.Matrix4(), q8 = new THREE.Quaternion(), e8 = new THREE.Euler();
      var v8 = new THREE.Vector3(), s8 = new THREE.Vector3(), c8 = new THREE.Color();
      for (var i8 = 0; i8 < mushSpots.length; i8++) {
        var M = mushSpots[i8];
        var sc = 0.8 + rng.f() * 1.0;
        e8.set((rng.f() - 0.5) * 0.2, rng.angle(), (rng.f() - 0.5) * 0.2);
        q8.setFromEuler(e8);
        v8.set(M[0], H(M[0], M[1]) - 0.02, M[1]);
        s8.set(sc, sc, sc);
        m8.compose(v8, q8, s8);
        mushMesh.setMatrixAt(i8, m8);
        c8.setRGB(1, 1, 1).multiplyScalar(0.85 + rng.f() * 0.4);
        mushMesh.setColorAt(i8, c8);
      }
      mushMesh.instanceMatrix.needsUpdate = true;
      if (mushMesh.instanceColor) mushMesh.instanceColor.needsUpdate = true;
      mushMesh.castShadow = false; mushMesh.receiveShadow = false;
      group.add(mushMesh);
    }

    /* trunk footprints near the cabin, so the cinematic camera never sits inside a tree */
    var trunkList = [];
    function addTrunk(x, z, r, canopy, height) {
      if (x * x + z * z < 2400) trunkList.push([x, z, r, canopy || r, height || 12]);
    }
    var ti;
    for (ti = 0; ti < buckets.main.length; ti++) addTrunk(buckets.main[ti].x, buckets.main[ti].z, 0.3 * buckets.main[ti].s, 2.3 * buckets.main[ti].s, 8.6 * buckets.main[ti].s);
    for (ti = 0; ti < buckets.far.length; ti++) addTrunk(buckets.far[ti].x, buckets.far[ti].z, 0.3 * buckets.far[ti].s, 1.8 * buckets.far[ti].s, 8 * buckets.far[ti].s);
    for (ti = 0; ti < farItems.length; ti++) addTrunk(farItems[ti].x, farItems[ti].z, 0.3 * farItems[ti].s, 1.8 * farItems[ti].s, 9 * farItems[ti].s);
    for (ti = 0; ti < birchData.length; ti++) addTrunk(birchData[ti].x, birchData[ti].z, 0.26 * birchData[ti].sc, 1.9 * birchData[ti].sc, birchData[ti].h);

    return {
      group: group,
      trunks: trunkList,
      materials: [matFoliage, matFar, matLeaf, matBush, matFern, matTuft, matClump, matFlower],
      update: function (t) { uTime.value = t; }
    };
  }

  FC.Vegetation = { create: create, patchWind: patchWind, uTime: uTime };

})(window);