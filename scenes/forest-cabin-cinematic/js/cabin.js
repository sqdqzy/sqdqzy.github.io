/* Forest Cabin - the log cabin, porch, windows and warm interior light */
(function (global) {
  'use strict';
  var FC = global.FC;
  var THREE = global.THREE;
  var U = FC.util, G = FC.geo, lerp = U.lerp, clamp = U.clamp;
  var TAU = U.TAU;

  var C = {
    BASE: 0.55, HW: 3.5, HD: 2.6,
    LOG_D: 0.29, COURSES: 10,
    RIDGE: 5.85,
    FRONT_EAVE_Z: 2.78, BACK_EAVE_Z: -3.30,
    PORCH_Z1: 5.5, PORCH_HX: 2.62,
    CH_X: -4.05, CH_Z: -0.55, CH_TOP: 6.35
  };
  C.WALL_TOP = C.BASE + C.LOG_D * C.COURSES;                 /* 3.45 */
  C.RISE = C.RIDGE - C.WALL_TOP;                              /* 2.40 */
  C.FRONT_EAVE_Y = C.RIDGE - (C.FRONT_EAVE_Z / C.HD) * C.RISE;
  C.BACK_EAVE_Y = C.RIDGE - (Math.abs(C.BACK_EAVE_Z) / C.HD) * C.RISE;

  /* openings: hole = {x0,x1,c0,c1} (x = along the wall) */
  var FRONT_HOLES = [
    { x0: -0.60, x1: 0.60, c0: 0, c1: 6 },        /* door */
    { x0: -2.78, x1: -1.52, c0: 4, c1: 6 },      /* left window */
    { x0: 1.52, x1: 2.78, c0: 4, c1: 6 }         /* right window */
  ];
  var EAST_HOLES = [{ z0: -1.35, z1: 0.05, c0: 4, c1: 6 }];

  function scaleUV(geo, sx, sy) {
    if (sy === undefined) sy = sx;
    if (!sx || !sy) return geo;
    var uv = geo.attributes.uv;
    if (!uv) return geo;
    for (var i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) * sx, uv.getY(i) * sy);
    }
    uv.needsUpdate = true;
    return geo;
  }

  /* build a slab lying on a slope between two points along z */
  function slab(width, thick, z0, y0, z1, y1, x, uvx, uvy) {
    var dy = y1 - y0, dz = z1 - z0;
    var len = Math.sqrt(dy * dy + dz * dz);
    var g = new THREE.BoxGeometry(width, thick, len);
    g.rotateX(Math.atan2(-dy, dz));
    g.translate(x, (y0 + y1) / 2, (z0 + z1) / 2);
    scaleUV(g, uvx || 1, uvy || 1);
    return g;
  }

  /* complement of the openings along one course */
  function spans(min, max, holes, course, key0, key1) {
    var cuts = [], i;
    for (i = 0; i < holes.length; i++) {
      var h = holes[i];
      if (course > h.c1 || course < h.c0) continue;
      var a = Math.max(min, h[key0]), b = Math.min(max, h[key1]);
      if (b > a) cuts.push([a, b]);
    }
    cuts.sort(function (p, q) { return p[0] - q[0]; });
    var merged = [], out = [], cur = min;
    for (i = 0; i < cuts.length; i++) {
      if (cuts[i][0] > cur) { out.push([cur, cuts[i][0]]); cur = cuts[i][1]; }
      else cur = Math.max(cur, cuts[i][1]);
    }
    if (cur < max) out.push([cur, max]);
    return out;
  }

  function create(scene, tex, terrain, quality) {
    var rng = new U.Rng(31415);
    var group = new THREE.Group();
    group.name = 'cabin';
    scene.add(group);

    /* ---------------- materials ---------------- */
    var matLog = new THREE.MeshStandardMaterial({
      map: tex.wood, normalMap: tex.woodNormal, normalScale: new THREE.Vector2(0.9, 0.9),
      vertexColors: true, roughness: 0.86, metalness: 0, envMapIntensity: 0.5
    });
    var matPlank = new THREE.MeshStandardMaterial({
      map: tex.deck, normalMap: tex.deckNormal, normalScale: new THREE.Vector2(0.7, 0.7),
      vertexColors: true, roughness: 0.88, metalness: 0, envMapIntensity: 0.45
    });
    var matShingle = new THREE.MeshStandardMaterial({
      map: tex.shingle, normalMap: tex.shingleNormal, normalScale: new THREE.Vector2(1.1, 1.1),
      vertexColors: true, roughness: 0.93, metalness: 0, envMapIntensity: 0.4
    });
    var matStone = new THREE.MeshStandardMaterial({
      map: tex.stone, normalMap: tex.stoneNormal, normalScale: new THREE.Vector2(1.0, 1.0),
      vertexColors: true, roughness: 0.94, metalness: 0, envMapIntensity: 0.45
    });
    var matPaint = new THREE.MeshStandardMaterial({
      normalMap: tex.woodNormal, normalScale: new THREE.Vector2(0.45, 0.45),
      vertexColors: true, roughness: 0.52, metalness: 0.02, envMapIntensity: 0.7
    });
    var matMetal = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.42, metalness: 0.75, envMapIntensity: 1.0
    });
    var matFabric = new THREE.MeshStandardMaterial({
      map: tex.fabric, normalMap: tex.fabric, vertexColors: true,
      roughness: 0.95, metalness: 0, side: THREE.DoubleSide, envMapIntensity: 0.4
    });

    var wood = [], planks = [], shingles = [], stone = [], paint = [], metal = [], fabric = [];

    var LOG_DARK = new THREE.Color(0x8f7a62), LOG_MID = new THREE.Color(0xb9a184), LOG_WARM = new THREE.Color(0xcdb08c);
    function logTint() {
      var r = rng.f();
      var c = new THREE.Color();
      if (r < 0.45) c.copy(LOG_MID);
      else if (r < 0.8) c.copy(LOG_WARM);
      else c.copy(LOG_DARK);
      c.offsetHSL(0, (rng.f() - 0.5) * 0.06, (rng.f() - 0.5) * 0.09);
      return c;
    }

    /* ---------------- foundation ---------------- */
    stone.push(G.paintJitter(scaleUV(G.box(C.HW * 2 + 0.7, 0.72, C.HD * 2 + 0.7), 3.2, 0.9), 0xffffff, 0.05, rng)
      .translate(0, C.BASE - 0.36, 0));
    /* footing stones around the base */
    for (var fi = 0; fi < 30; fi++) {
      var t2 = fi / 30 * 4;
      var sx, sz;
      if (t2 < 1) { sx = -C.HW + t2 * C.HW * 2; sz = C.HD + 0.35; }
      else if (t2 < 2) { sx = C.HW + 0.35; sz = C.HD - (t2 - 1) * C.HD * 2; }
      else if (t2 < 3) { sx = C.HW - (t2 - 2) * C.HW * 2; sz = -C.HD - 0.35; }
      else { sx = -C.HW - 0.35; sz = -C.HD + (t2 - 3) * C.HD * 2; }
      sx += (rng.f() - 0.5) * 0.3; sz += (rng.f() - 0.5) * 0.3;
      var s = 0.2 + rng.f() * 0.2;
      stone.push(G.paintJitter(G.xf(G.lumpy(new THREE.IcosahedronGeometry(s, 0), 0.25, 3, rng),
        sx, C.BASE - 0.42 + rng.f() * 0.2, sz, rng.angle(), rng.angle(), rng.angle(),
        1, 0.7, 1), 0xb9b4a8, 0.1, rng));
    }

    /* ---------------- log walls ---------------- */
    /* axis 'x': logs run along x on the +/-z walls ; axis 'z': along z on the +/-x walls */
    function logWallAt(axis, holes, isEnd, fixed) {
      var r = C.LOG_D * 0.5, i;
      for (i = 0; i < C.COURSES; i++) {
        var cy = C.BASE + (i + 0.5) * C.LOG_D;
        var rr = r * (0.95 + rng.f() * 0.1);
        var lo = axis === 'x' ? -(C.HW + (isEnd ? 0.26 : 0)) : -C.HD;
        var hi = axis === 'x' ? (C.HW + (isEnd ? 0.26 : 0)) : C.HD;
        var sp = spans(lo, hi, holes || [], i, axis === 'x' ? 'x0' : 'z0', axis === 'x' ? 'x1' : 'z1');
        for (var k = 0; k < sp.length; k++) {
          var len = sp[k][1] - sp[k][0];
          if (len < 0.06) continue;
          var g = G.cyl(rr * 0.97, rr, len, 8);
          if (axis === 'x') {
            g.rotateZ(Math.PI / 2);
            g.translate((sp[k][0] + sp[k][1]) / 2, cy + (rng.f() - 0.5) * 0.012, fixed);
          } else {
            g.rotateX(Math.PI / 2);
            g.translate(fixed, cy + (rng.f() - 0.5) * 0.012, (sp[k][0] + sp[k][1]) / 2);
          }
          scaleUV(g, axis === 'x' ? 1 : 1, Math.max(0.4, len / 2.3));
          wood.push(G.paintJitter(g, logTint(), 0.045, rng));
        }
      }
    }
    logWallAt('x', FRONT_HOLES, true, C.HD);
    logWallAt('x', null, true, -C.HD);
    logWallAt('z', EAST_HOLES, false, C.HW);
    logWallAt('z', null, false, -C.HW);

    /* corner notches: vertical trim boards hiding the log ends */
    for (var cx = -1; cx <= 1; cx += 2) {
      for (var cz = -1; cz <= 1; cz += 2) {
        var post = G.box(0.3, C.LOG_D * C.COURSES + 0.12, 0.3);
        post.translate(cx * (C.HW + 0.02), C.BASE + C.LOG_D * C.COURSES / 2, cz * (C.HD + 0.02));
        paint.push(G.paintJitter(post, 0x6f5a45, 0.06, rng));
      }
    }

    /* ---------------- gables ---------------- */
    function gable(xPos, thick) {
      var sh = new THREE.Shape();
      sh.moveTo(-C.HD, C.WALL_TOP - 0.05);
      sh.lineTo(C.HD, C.WALL_TOP - 0.05);
      sh.lineTo(0, C.RIDGE - 0.12);
      sh.closePath();
      var g = new THREE.ExtrudeGeometry(sh, { depth: thick, bevelEnabled: false });
      g.rotateY(Math.PI / 2);
      scaleUV(g, 2.4, 1.2);
      g.translate(xPos, 0, 0);
      var gg = G.merge([g]);
      G.paintFn(gg, function (c, px, py, pz) {
        c.copy(LOG_MID).offsetHSL(0, 0, (py > C.WALL_TOP ? 0.03 : 0) + Math.sin(py * 3.1) * 0.012);
      });
      return gg;
    }
    wood.push(gable(-C.HW - 0.13, 0.13));
    wood.push(gable(C.HW + 0.005, 0.13));
    /* gable trim boards along the rake */
    for (var sg = -1; sg <= 1; sg += 2) {
      for (var sz2 = -1; sz2 <= 1; sz2 += 2) {
        var rakeLen = Math.sqrt(C.HD * C.HD + C.RISE * C.RISE);
        var rg = G.box(0.2, 0.14, rakeLen + 0.1);
        rg.rotateX(sz2 * Math.atan2(C.RISE, C.HD) * (sz2 > 0 ? 1 : 1) * (sz2 > 0 ? -1 : -1));
        rg.translate(sg * (C.HW + 0.16), (C.WALL_TOP + C.RIDGE) / 2, 0);
        paint.push(G.paintJitter(rg, 0x8a6f4f, 0.05, rng));
      }
    }

    /* ---------------- roof ---------------- */
    var roofW = C.HW * 2 + 0.55;
    shingles.push(slab(roofW, 0.16, 0, C.RIDGE, C.FRONT_EAVE_Z, C.FRONT_EAVE_Y, 0, 2.7, 1.55));
    shingles.push(slab(roofW, 0.16, 0, C.RIDGE, C.BACK_EAVE_Z, C.BACK_EAVE_Y, 0, 2.7, 2.1));
    /* under the roof: rafter tails visible from the eave */
    for (var rr2 = -1; rr2 <= 1; rr2 += 2) {
      var rafterLen = Math.sqrt(2.6 * 2.6 + 2.4 * 2.4);
      var midZ = rr2 * 1.45;
      var roofY = C.RIDGE - (Math.abs(midZ) / C.HD) * C.RISE;
      for (var i2 = 0; i2 < 13; i2++) {
        var px = -C.HW + 0.15 + i2 * ((roofW - 0.3) / 12);
        var rf = G.box(0.11, 0.14, rafterLen);
        rf.rotateX(rr2 * Math.atan2(C.RISE, C.HD));
        rf.translate(px, roofY - 0.19, midZ);
        paint.push(G.paintJitter(rf, 0x7a6248, 0.07, rng));
      }
      /* fascia along the eave */
      var fasLen = roofW;
      var fascia = G.box(fasLen, 0.22, 0.09);
      fascia.translate(0, roofY - 0.16, rr2 * (Math.abs(C.FRONT_EAVE_Z) - 0.04) * (rr2 > 0 ? 1 : Math.abs(C.BACK_EAVE_Z) / C.FRONT_EAVE_Z));
      paint.push(G.paintJitter(fascia, 0x6b5742, 0.05, rng));
    }
    /* ridge cap */
    var cap = G.box(roofW + 0.1, 0.14, 0.5);
    cap.rotateX(-Math.PI / 4);
    cap.translate(0, C.RIDGE + 0.1, 0);
    paint.push(G.paintJitter(cap, 0x6d5942, 0.05, rng));
    shingles.push(G.paintJitter(slab(roofW + 0.05, 0.1, 0, C.RIDGE + 0.16, 0.42, C.RIDGE - 0.2, 0, 3, 0.4), 0xffffff, 0.05, rng));
    /* fascia boards on the side gables */
    for (var sx2 = -1; sx2 <= 1; sx2 += 2) {
      var fas = G.box(0.1, 0.2, 0.66);
      fas.translate(sx2 * (C.HW + 0.28), C.FRONT_EAVE_Y - 0.02, C.FRONT_EAVE_Z - 0.3);
      paint.push(G.paintJitter(fas, 0x6b5742, 0.05, rng));
      var fas2 = G.box(0.1, 0.2, 0.72);
      fas2.translate(sx2 * (C.HW + 0.3), C.BACK_EAVE_Y - 0.02, C.BACK_EAVE_Z + 0.34);
      paint.push(G.paintJitter(fas2, 0x6b5742, 0.05, rng));
    }

    /* ---------------- chimney ---------------- */
    stone.push(G.paintJitter(scaleUV(G.box(0.92, C.CH_TOP + 0.6, 0.92), 2, 5), 0xffffff, 0.05, rng)
      .translate(C.CH_X, (C.CH_TOP - 0.6) / 2, C.CH_Z));
    stone.push(G.paintJitter(scaleUV(G.box(1.08, 0.18, 1.08), 2, 0.4), 0xe8e4dc, 0.04, rng).translate(C.CH_X, C.CH_TOP - 0.09, C.CH_Z));
    stone.push(G.paintJitter(scaleUV(G.box(0.72, 0.3, 0.72), 2, 0.5), 0xe0dcd4, 0.04, rng).translate(C.CH_X, C.CH_TOP + 0.13, C.CH_Z));
    /* clay flue pipe */
    var pipe = G.cyl(0.15, 0.17, 0.5, 10);
    pipe.translate(C.CH_X, C.CH_TOP + 0.45, C.CH_Z);
    paint.push(G.paintJitter(pipe, 0x8a4a34, 0.05, rng));
    var pipeRim = G.cyl(0.19, 0.19, 0.07, 10);
    pipeRim.translate(C.CH_X, C.CH_TOP + 0.68, C.CH_Z);
    paint.push(G.paintJitter(pipeRim, 0x7a4028, 0.05, rng));

    /* ---------------- windows ---------------- */
    var windows = [];
    /* a framed window; face '+z' sits in the XY plane, face '+x' is rotated onto the side wall */
    function windowUnit(cx, cy, cz, w, h, face) {
      var fr = 0.075, parts = [];
      parts.push(G.box(w + fr * 2, fr, 0.16).translate(0, h / 2 + fr / 2, 0));
      parts.push(G.box(w + fr * 2, fr, 0.16).translate(0, -h / 2 - fr / 2, 0));
      parts.push(G.box(fr, h, 0.16).translate(-w / 2 - fr / 2, 0, 0));
      parts.push(G.box(fr, h, 0.16).translate(w / 2 + fr / 2, 0, 0));
      parts.push(G.box(0.045, h, 0.1));
      parts.push(G.box(w, 0.045, 0.1));
      parts.push(G.box(w + 0.36, 0.07, 0.32).translate(0, -h / 2 - 0.1, 0.09));
      parts.push(G.box(w + 0.22, 0.08, 0.14).translate(0, -h / 2 - 0.21, 0.06));
      var rot = face === '+x' ? Math.PI / 2 : 0;
      for (var i = 0; i < parts.length; i++) {
        if (rot) parts[i].rotateY(rot);
        parts[i].translate(cx, cy, cz);
        paint.push(G.paintJitter(parts[i], 0xbcb6a6, 0.03, rng));
      }
      var gm = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex.glass, color: 0xffcf8a, fog: true }));
      gm.position.set(cx + (rot ? 0.005 : 0), cy, cz + (rot ? 0 : 0.005));
      gm.rotation.y = rot;
      group.add(gm);
      var spill = new THREE.Mesh(
        new THREE.PlaneGeometry(w * 3.4, h * 3.2),
        new THREE.MeshBasicMaterial({
          map: tex.windowGlow, transparent: true, blending: THREE.AdditiveBlending,
          depthWrite: false, opacity: 0.85, fog: true
        })
      );
      spill.position.set(cx + (rot ? 0.13 : 0), cy, cz + (rot ? 0 : 0.13));
      spill.rotation.y = rot;
      group.add(spill);
      windows.push({ glass: gm.material, spill: spill.material, base: new THREE.Vector3(cx, cy, cz) });
    }

    /* front windows + east wall window */
    windowUnit(-2.15, 2.15, C.HD + 0.1, 1.26, 0.88, '+z');
    windowUnit(2.15, 2.15, C.HD + 0.1, 1.26, 0.88, '+z');
    windowUnit(C.HW + 0.1, 2.15, -0.65, 1.4, 0.88, '+x');

    /* round gable window on the east gable */
    (function () {
      var cx = C.HW + 0.16, cy = 4.35, r = 0.42;
      var ring = new THREE.TorusGeometry(r, 0.07, 8, 20);
      ring.rotateY(Math.PI / 2);
      ring.translate(cx, cy, 0);
      paint.push(G.paintJitter(ring, 0xbcb6a6, 0.03, rng));
      for (var i = 0; i < 4; i++) {
        var bar = G.box(0.07, r * 2, 0.05);
        bar.rotateX(i * Math.PI / 4);
        bar.rotateY(Math.PI / 2);
        bar.translate(cx, cy, 0);
        paint.push(G.paintJitter(bar, 0xbcb6a6, 0.03, rng));
      }
      var disc = new THREE.Mesh(new THREE.CircleGeometry(r, 24), new THREE.MeshBasicMaterial({ map: tex.glass, color: 0xffc477, fog: true }));
      disc.rotation.y = Math.PI / 2;
      disc.position.set(cx - 0.01, cy, 0);
      group.add(disc);
      var spill = new THREE.Mesh(
        new THREE.PlaneGeometry(2.6, 2.6),
        new THREE.MeshBasicMaterial({ map: tex.windowGlow, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.5, fog: true })
      );
      spill.rotation.y = Math.PI / 2;
      spill.position.set(cx + 0.1, cy, 0);
      group.add(spill);
      windows.push({ glass: disc.material, spill: spill.material, base: new THREE.Vector3(cx, cy, 0) });
    })();

    /* curtains behind the front windows */
    [[-2.15, 2.15], [2.15, 2.15]].forEach(function (p) {
      for (var s = -1; s <= 1; s += 2) {
        var cur = G.box(0.42, 0.95, 0.04);
        cur.translate(p[0] + s * 0.46, p[1] + 0.02, C.HD - 0.16);
        fabric.push(G.paintJitter(cur, s < 0 ? 0xd8cdb4 : 0xc8b9a0, 0.06, rng));
      }
    });

    /* ---------------- door ---------------- */
    (function () {
      var dx = 0, dz = C.HD + 0.06;
      /* frame */
      paint.push(G.paintJitter(G.box(0.12, 2.2, 0.2).translate(dx - 0.66, C.BASE + 1.08, dz), 0xc4bdae, 0.03, rng));
      paint.push(G.paintJitter(G.box(0.12, 2.2, 0.2).translate(dx + 0.66, C.BASE + 1.08, dz), 0xc4bdae, 0.03, rng));
      paint.push(G.paintJitter(G.box(1.44, 0.14, 0.2).translate(dx, C.BASE + 2.2, dz), 0xc4bdae, 0.03, rng));
      /* slab: vertical planks */
      for (var i = 0; i < 5; i++) {
        var pw = 0.225;
        var pk = G.box(pw, 2.05, 0.09);
        pk.translate(dx - 0.45 + i * 0.235, C.BASE + 1.03, dz + 0.02);
        paint.push(G.paintJitter(pk, i % 2 ? 0x3d5346 : 0x374c40, 0.05, rng));
      }
      /* ledges + hinges */
      paint.push(G.paintJitter(G.box(1.12, 0.12, 0.04).translate(dx, C.BASE + 1.9, dz + 0.08), 0x2f4238, 0.04, rng));
      paint.push(G.paintJitter(G.box(1.12, 0.12, 0.04).translate(dx, C.BASE + 0.28, dz + 0.08), 0x2f4238, 0.04, rng));
      metal.push(G.paintJitter(G.box(0.2, 0.05, 0.03).translate(dx - 0.5, C.BASE + 1.86, dz + 0.09), 0x2a2a2c, 0.05, rng));
      metal.push(G.paintJitter(G.box(0.2, 0.05, 0.03).translate(dx - 0.5, C.BASE + 0.32, dz + 0.09), 0x2a2a2c, 0.05, rng));
      metal.push(G.paintJitter(G.sph(0.06, 8, 6).translate(dx + 0.42, C.BASE + 1.05, dz + 0.1), 0xb08d4a, 0.05, rng));
      /* little door light */
      var dg = new THREE.Mesh(new THREE.CircleGeometry(0.14, 14), new THREE.MeshBasicMaterial({ map: tex.glass, color: 0xffcf8a, fog: true }));
      dg.position.set(dx, C.BASE + 1.62, dz + 0.075);
      group.add(dg);
      windows.push({ glass: dg.material, spill: null, base: new THREE.Vector3(dx, C.BASE + 1.62, dz) });
    })();

    /* ---------------- porch ---------------- */
    (function () {
      var z0 = C.HD, z1 = C.PORCH_Z1, hx = C.PORCH_HX, top = C.BASE;
      /* deck boards running left to right */
      var nb = 13;
      for (var i = 0; i < nb; i++) {
        var zz = z0 + (i + 0.5) * ((z1 - z0) / nb);
        var b = G.box(hx * 2, 0.07, (z1 - z0) / nb - 0.025);
        scaleUV(b, 2.2, 0.4);
        b.translate((rng.f() - 0.5) * 0.05, top - 0.035, zz);
        planks.push(G.paintJitter(b, 0xffffff, 0.08, rng));
      }
      /* joists + skirt */
      planks.push(G.paintJitter(G.box(hx * 2, 0.16, 0.14).translate(0, top - 0.16, z1 - 0.12), 0x8a7a66, 0.05, rng));
      for (var i2 = 0; i2 < 5; i2++) {
        var jx = -hx + 0.3 + i2 * ((hx * 2 - 0.6) / 4);
        planks.push(G.paintJitter(G.box(0.12, 0.28, z1 - z0).translate(jx, top - 0.2, (z0 + z1) / 2), 0x7a6a56, 0.05, rng));
      }
      /* posts */
      var postY0 = top, postY1 = 2.66;
      [[-hx + 0.22, z1 - 0.22], [hx - 0.22, z1 - 0.22], [-hx + 0.22, z0 + 0.35], [hx - 0.22, z0 + 0.35]].forEach(function (p, idx) {
        var pg = G.box(0.17, postY1 - postY0, 0.17);
        pg.translate(p[0], (postY0 + postY1) / 2, p[1]);
        paint.push(G.paintJitter(pg, 0xa8a294, 0.035, rng));
        /* post base block + cap */
        paint.push(G.paintJitter(G.box(0.26, 0.12, 0.26).translate(p[0], postY0 + 0.06, p[1]), 0x9c8f7c, 0.04, rng));
        if (idx < 2) {
          paint.push(G.paintJitter(G.box(0.26, 0.1, 0.26).translate(p[0], postY1 - 0.05, p[1]), 0x9c8f7c, 0.04, rng));
        }
      });
      /* railing between the outer posts */
      for (var s = -1; s <= 1; s += 2) {
        var rz = z1 - 0.22, rx = s * (hx - 0.22);
        paint.push(G.paintJitter(G.box(0.09, 0.09, 0.09).translate(rx, C.BASE + 0.92, rz), 0xa29c8e, 0.03, rng));
        paint.push(G.paintJitter(G.box(0.12, 0.07, (z1 - z0) - 0.7).translate(s * (hx - 0.22), C.BASE + 0.92, (z0 + z1) / 2 + 0.1), 0xa8a294, 0.03, rng));
        paint.push(G.paintJitter(G.box(0.1, 0.06, (z1 - z0) - 0.7).translate(s * (hx - 0.22), C.BASE + 0.45, (z0 + z1) / 2 + 0.1), 0xa29c8e, 0.03, rng));
        for (var b2 = 0; b2 < 5; b2++) {
          var bz = z0 + 0.55 + b2 * ((z1 - z0 - 0.9) / 4);
          var bal = G.box(0.05, 0.44, 0.05);
          bal.translate(s * (hx - 0.22), C.BASE + 0.69, bz);
          paint.push(G.paintJitter(bal, 0xa8a294, 0.03, rng));
        }
      }
      /* porch roof */
      var pz0 = C.FRONT_EAVE_Z, py0 = C.FRONT_EAVE_Y, pz1 = C.PORCH_Z1 + 0.22, py1 = py0 - (pz1 - pz0) * 0.255;
      shingles.push(slab(hx * 2 + 0.5, 0.13, pz0, py0, pz1, py1, 0, 2.4, 0.9));
      /* beam + brackets */
      paint.push(G.paintJitter(G.box(hx * 2 + 0.3, 0.16, 0.12).translate(0, py1 + 0.12, pz1 - 0.08), 0xa8a294, 0.03, rng));
      [-1, 1].forEach(function (s2) {
        var br = G.box(0.1, 0.45, 0.1);
        br.rotateX(-0.7);
        br.translate(s2 * (hx - 0.22), py1 - 0.06, pz1 - 0.3);
        paint.push(G.paintJitter(br, 0xa8a294, 0.03, rng));
      });
      /* steps */
      for (var st = 0; st < 3; st++) {
        var sy = C.BASE - (st + 1) * 0.175;
        var sz2 = z1 + 0.1 + st * 0.3;
        var step = G.box(1.9, 0.17, 0.32);
        scaleUV(step, 1.4, 0.3);
        step.translate(0, sy + 0.085, sz2);
        planks.push(G.paintJitter(step, 0xf0eae0, 0.05, rng));
      }
      paint.push(G.paintJitter(G.box(0.12, 0.9, 0.12).translate(-1.02, C.BASE - 0.35, z1 + 0.42), 0xa8a294, 0.03, rng));
      paint.push(G.paintJitter(G.box(0.12, 0.9, 0.12).translate(1.02, C.BASE - 0.35, z1 + 0.42), 0xa8a294, 0.03, rng));
      /* doormat */
      var mat = G.box(1.0, 0.03, 0.6);
      mat.translate(0, C.BASE + 0.02, C.HD + 0.5);
      fabric.push(G.paintJitter(mat, 0x8a6a45, 0.06, rng));
    })();

    /* ---------------- porch furniture ---------------- */
    var lanternLight = null;
    (function () {
      var top = C.BASE;
      /* rocking chair */
      (function () {
        var cx = -1.75, cz = 4.3;
        var parts = [];
        parts.push(G.box(0.52, 0.05, 0.5).translate(cx, top + 0.42, cz));
        parts.push(G.box(0.5, 0.56, 0.05).rotateX(-0.16).translate(cx, top + 0.72, cz - 0.22));
        for (var s = -1; s <= 1; s += 2) {
          parts.push(G.box(0.05, 0.42, 0.05).translate(cx + s * 0.23, top + 0.21, cz + 0.2));
          parts.push(G.box(0.05, 0.42, 0.05).translate(cx + s * 0.23, top + 0.21, cz - 0.2));
          parts.push(G.box(0.04, 0.04, 0.46).translate(cx + s * 0.26, top + 0.62, cz));
          parts.push(G.box(0.05, 0.05, 0.5).translate(cx + s * 0.26, top + 0.62, cz));
          /* rockers */
          var rk = G.box(0.05, 0.05, 0.72);
          rk.translate(cx + s * 0.26, top + 0.04, cz);
          parts.push(rk);
        }
        for (var i = 0; i < parts.length; i++) paint.push(G.paintJitter(parts[i], 0x8a6f52, 0.06, rng));
      })();
      /* bench / crate */
      (function () {
        var cx = 1.85, cz = 4.4;
        paint.push(G.paintJitter(G.box(1.0, 0.08, 0.42).translate(cx, top + 0.42, cz), 0x9a7c58, 0.05, rng));
        paint.push(G.paintJitter(G.box(0.08, 0.42, 0.08).translate(cx - 0.4, top + 0.21, cz), 0x8a6f52, 0.05, rng));
        paint.push(G.paintJitter(G.box(0.08, 0.42, 0.08).translate(cx + 0.4, top + 0.21, cz), 0x8a6f52, 0.05, rng));
        /* crate */
        var cr = [];
        for (var i = 0; i < 4; i++) {
          cr.push(G.box(0.46, 0.07, 0.03).translate(2.1, top + 0.06 + i * 0.11, 3.6));
          cr.push(G.box(0.03, 0.07, 0.46).translate(1.9 + i * 0.14, top + 0.06 + 0.2, 3.6));
        }
        for (var j = 0; j < cr.length; j++) planks.push(G.paintJitter(cr[j], 0xa88a62, 0.06, rng));
      })();
      /* hanging lantern */
      (function () {
        var lx = 0, lz = C.PORCH_Z1 - 0.15, ly = 2.4;
        metal.push(G.paintJitter(G.cyl(0.02, 0.02, 0.3, 6).translate(lx, ly + 0.2, lz), 0x2a2a2c, 0.05, rng));
        metal.push(G.paintJitter(G.box(0.16, 0.03, 0.16).translate(lx, ly + 0.05, lz), 0x2a2a2c, 0.05, rng));
        var bulb = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffd79a, fog: true }));
        bulb.position.set(lx, ly, lz);
        group.add(bulb);
        windows.push({ glass: bulb.material, spill: null, base: new THREE.Vector3(lx, ly, lz) });
        var halo = new THREE.Sprite(new THREE.SpriteMaterial({
          map: tex.warmGlow, color: 0xffb060, transparent: true, blending: THREE.AdditiveBlending,
          depthWrite: false, opacity: 0.8, fog: true
        }));
        halo.scale.set(1.1, 1.1, 1);
        halo.position.set(lx, ly, lz);
        group.add(halo);
        windows[windows.length - 1].halo = halo;
        lanternLight = new THREE.PointLight(0xffb877, 2.2, 8, 1.7);
        lanternLight.position.set(lx, ly, lz);
        group.add(lanternLight);
      })();
      /* fairy lights along the beam */
      (function () {
        var n = 14, i;
        var pts = [];
        for (i = 0; i <= n; i++) {
          var t = i / n;
          var x = -C.PORCH_HX + 0.3 + t * (C.PORCH_HX * 2 - 0.6);
          var sag = Math.sin(t * Math.PI) * 0.16;
          pts.push(new THREE.Vector3(x, 2.52 - sag, C.PORCH_Z1 - 0.12));
        }
        var curve = new THREE.CatmullRomCurve3(pts);
        var tube = new THREE.TubeGeometry(curve, 24, 0.012, 4, false);
        metal.push(G.paintJitter(tube, 0x1e1e20, 0.02, rng));
        for (i = 0; i < n; i++) {
          var p = curve.getPoint(i / n);
          var s2 = new THREE.Mesh(new THREE.SphereGeometry(0.032, 6, 5), new THREE.MeshBasicMaterial({ color: 0xffca7a, fog: true }));
          s2.position.copy(p);
          group.add(s2);
          windows.push({ glass: s2.material, spill: null, base: p.clone() });
        }
      })();
      /* hanging potted ferns by the door */
      (function () {
        for (var s3 = -1; s3 <= 1; s3 += 2) {
          var px = s3 * 1.05, py = 2.28, pz = C.HD + 0.28;
          metal.push(G.paintJitter(G.cyl(0.02, 0.02, 0.42, 5).translate(px, py + 0.2, pz), 0x2a2a2c, 0.04, rng));
          var pot = G.cyl(0.11, 0.08, 0.16, 8);
          pot.translate(px, py - 0.02, pz);
          paint.push(G.paintJitter(pot, 0x9a6a4a, 0.05, rng));
        }
      })();
      /* boots by the door */
      (function () {
        for (var s4 = -1; s4 <= 1; s4 += 2) {
          var bx = 0.35 + s4 * 0.14, bz = C.HD + 0.75;
          var boot = G.box(0.11, 0.26, 0.24);
          boot.translate(bx, C.BASE + 0.13, bz);
          fabric.push(G.paintJitter(boot, 0x4a3a2c, 0.05, rng));
        }
      })();
    })();

    /* ---------------- merge + add ---------------- */
    function addMerged(list, mat, name, shadow) {
      if (!list.length) return null;
      var g = G.merge(list);
      var m = new THREE.Mesh(g, mat);
      m.castShadow = shadow !== false;
      m.receiveShadow = true;
      m.name = name;
      group.add(m);
      return m;
    }
    addMerged(wood, matLog, 'logs');
    addMerged(planks, matPlank, 'planks');
    addMerged(shingles, matShingle, 'roof');
    addMerged(stone, matStone, 'stone');
    addMerged(paint, matPaint, 'paint');
    addMerged(metal, matMetal, 'metal');
    addMerged(fabric, matFabric, 'fabric');

    /* ---------------- interior + porch lights ---------------- */
    var interior = new THREE.PointLight(0xffb066, 3.0, 15, 1.6);
    interior.position.set(0, C.BASE + 1.5, 0.2);
    group.add(interior);

    var hearth = new THREE.PointLight(0xff8a3a, 1.6, 7, 1.8);
    hearth.position.set(0, C.BASE + 0.4, -1.4);
    group.add(hearth);

    /* light pooling on the ground in front of the porch at dusk */
    var pool = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 7),
      new THREE.MeshBasicMaterial({
        map: tex.warmGlow, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, opacity: 0.0, fog: true
      })
    );
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(0.6, terrain.heightAt(0.6, 6.5) + 0.03, 6.5);
    group.add(pool);

    return {
      group: group,
      constants: C,
      windows: windows,
      lights: { interior: interior, hearth: hearth, lantern: lanternLight },
      pool: pool,
      chimneyTop: new THREE.Vector3(C.CH_X, C.CH_TOP + 0.72, C.CH_Z),
      setNight: function (k) {
        interior.intensity = 0.6 + k * 3.4;
        hearth.intensity = 0.5 + k * 2.2;
        if (lanternLight) lanternLight.intensity = 0.35 + k * 2.6;
        pool.material.opacity = k * 0.42;
        for (var i = 0; i < windows.length; i++) {
          var w = windows[i];
          var base = w.base.z > C.HD ? 1.0 : 0.55;
          var v = clamp(base * (0.06 + k * 1.0), 0.06, 1.4);
          w.glass.color.setRGB(0.88 * v + 0.03, 0.64 * v + 0.02, 0.36 * v + 0.01);
          if (w.spill) w.spill.opacity = clamp(k * 0.95, 0, 1) * (w.base.z > C.HD ? 0.85 : 0.6);
          if (w.halo) w.halo.material.opacity = clamp(k * 1.1, 0, 1);
        }
      }
    };
  }

  FC.Cabin = { create: create, C: C };

})(window);