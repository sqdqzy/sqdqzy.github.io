/* Forest Cabin - yard props: woodpile, barrel, fence, garden, fire pit, carts, rocks */
(function (global) {
  'use strict';
  var FC = global.FC;
  var THREE = global.THREE;
  var U = FC.util, G = FC.geo, lerp = U.lerp, clamp = U.clamp;

  function scaleUV(geo, sx, sy) {
    var uv = geo.attributes.uv;
    if (!uv) return geo;
    for (var i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * sx, uv.getY(i) * sy);
    uv.needsUpdate = true;
    return geo;
  }

  /* a split log with pale cut ends */
  function firewoodGeo(len, r) {
    var g = new THREE.CylinderGeometry(r * 0.92, r, len, 7);
    g.rotateZ(Math.PI / 2);
    var g2 = G.paintFn(g, function (c, x, y, z) {
      var cap = Math.abs(x) > len / 2 - 0.02;
      if (cap) c.setHex(0xd8b98a).offsetHSL(0, 0, (Math.sin(y * 20 + z * 17) * 0.03));
      else c.setHex(0x6d5842).offsetHSL(0, 0, Math.sin(x * 30 + y * 12) * 0.04);
    });
    return g2;
  }

  function create(scene, tex, terrain, quality) {
    var rng = new U.Rng(24680);
    var H = terrain.heightAt, TD = terrain.trailDist;
    var CB = FC.Cabin.C;
    var group = new THREE.Group();
    group.name = 'props';
    scene.add(group);

    var wood = [], planks = [], stone = [], paint = [], metal = [], fabric = [], leaves = [];
    var wn = new THREE.Color(0xffffff);

    /* ---------------- materials ---------------- */
    var matWood = new THREE.MeshStandardMaterial({
      map: tex.bark, normalMap: tex.barkNormal, normalScale: new THREE.Vector2(0.9, 0.9),
      vertexColors: true, roughness: 0.92, metalness: 0, envMapIntensity: 0.45
    });
    var matPlank = new THREE.MeshStandardMaterial({
      map: tex.deck, normalMap: tex.deckNormal, vertexColors: true,
      roughness: 0.9, metalness: 0, envMapIntensity: 0.4
    });
    var matStone = new THREE.MeshStandardMaterial({
      map: tex.stone, normalMap: tex.stoneNormal, vertexColors: true,
      roughness: 0.94, metalness: 0, envMapIntensity: 0.45
    });
    var matPaint = new THREE.MeshStandardMaterial({
      normalMap: tex.woodNormal, normalScale: new THREE.Vector2(0.4, 0.4),
      vertexColors: true, roughness: 0.55, metalness: 0.02, envMapIntensity: 0.6
    });
    var matMetal = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.45, metalness: 0.7, envMapIntensity: 1.0
    });
    var matFabric = new THREE.MeshStandardMaterial({
      map: tex.fabric, vertexColors: true, roughness: 0.95, metalness: 0,
      side: THREE.DoubleSide, envMapIntensity: 0.4
    });
    var matLeaf = FC.Vegetation.patchWind(new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.9, flatShading: true, envMapIntensity: 0.45
    }), 0.05, 1.6);

    /* ---------------- woodpile against the east wall ---------------- */
    (function () {
      var x0 = CB.HW + 0.62, y0 = H(CB.HW + 0.62, 0) - 0.05;
      var rows = 5, per = 9;
      for (var r = 0; r < rows; r++) {
        var along = r % 2 === 0;
        for (var i = 0; i < per; i++) {
          var rr = 0.065 + rng.f() * 0.035;
          var len = along ? 0.66 : 0.66;
          var g = firewoodGeo(len, rr);
          if (along) {
            var z = -1.5 + i * 0.34 + (r % 4) * 0.04;
            var yy = y0 + 0.1 + r * 0.17;
            g.rotateY(rng.f() * 0.2 - 0.1);
            g.translate(x0 + (rng.f() - 0.5) * 0.05, yy, z);
          } else {
            var yz = y0 + 0.1 + r * 0.17;
            g.rotateY(Math.PI / 2);
            g.translate(x0 - 0.28 + i * 0.09, yz, -1.55 + 0.33 + (r % 4) * 0.03);
          }
          wood.push(g);
        }
      }
      /* uprights holding the stack */
      [-1.9, 1.9].forEach(function (z) {
        var p = G.box(0.1, 1.1, 0.1);
        p.translate(x0 + 0.36, y0 + 0.55, z);
        planks.push(G.paintJitter(p, 0x9c8460, 0.05, rng));
      });
      /* axe leaning on the pile */
      var handle = G.cyl(0.022, 0.028, 0.72, 6);
      handle.rotateZ(0.35); handle.rotateX(0.1);
      handle.translate(x0 + 0.2, y0 + 0.36, 1.6);
      planks.push(G.paintJitter(handle, 0xb08a58, 0.05, rng));
      metal.push(G.paintJitter(G.box(0.06, 0.16, 0.09).translate(x0 + 0.33, y0 + 0.66, 1.6), 0x8a8a90, 0.05, rng));
    })();

    /* ---------------- rain barrel + bucket ---------------- */
    (function () {
      var bx = -2.9, bz = 3.3, by = H(bx, bz);
      var bar = G.cyl(0.3, 0.34, 0.78, 12);
      bar.translate(bx, by + 0.39, bz);
      planks.push(G.paintJitter(scaleUV(bar, 3, 1.2), 0x8a6f4e, 0.06, rng));
      [0.16, 0.62].forEach(function (t) {
        var hoop = new THREE.TorusGeometry(0.335, 0.025, 6, 14);
        hoop.rotateX(Math.PI / 2);
        hoop.translate(bx, by + 0.39 + (t - 0.5) * 0.78, bz);
        metal.push(G.paintJitter(hoop, 0x3a3a3c, 0.05, rng));
      });
      var lid = G.cyl(0.31, 0.31, 0.05, 12);
      lid.translate(bx, by + 0.79, bz);
      planks.push(G.paintJitter(lid, 0x7a6244, 0.05, rng));
      /* bucket */
      var kx = -2.35, kz = 3.7, ky = H(kx, kz);
      var bkt = G.cyl(0.14, 0.11, 0.24, 10);
      bkt.translate(kx, ky + 0.12, kz);
      planks.push(G.paintJitter(bkt, 0x9a7d54, 0.05, rng));
      var handle = new THREE.TorusGeometry(0.13, 0.012, 5, 12, Math.PI);
      handle.rotateY(Math.PI / 2);
      handle.translate(kx, ky + 0.24, kz);
      metal.push(G.paintJitter(handle, 0x3a3a3c, 0.05, rng));
    })();

    /* ---------------- wheelbarrow ---------------- */
    (function () {
      var x = 5.6, z = 2.4, y = H(x, z);
      var g = new THREE.Group();
      g.position.set(x, y, z);
      g.rotation.y = -0.6;
      var tray = G.box(0.62, 0.26, 0.9);
      tray.translate(0, 0.42, 0);
      g.add(new THREE.Mesh(G.merge([G.paintJitter(tray, 0x8f7350, 0.05, rng)]), matPlank));
      var hs = [];
      hs.push(G.cyl(0.03, 0.03, 1.5, 6).rotateX(Math.PI / 2).translate(0.26, 0.35, 0.5));
      hs.push(G.cyl(0.03, 0.03, 1.5, 6).rotateX(Math.PI / 2).translate(-0.26, 0.35, 0.5));
      hs.push(G.box(0.04, 0.3, 0.04).translate(0.26, 0.15, -0.3));
      hs.push(G.box(0.04, 0.3, 0.04).translate(-0.26, 0.15, -0.3));
      var hg = G.merge(hs);
      G.paintJitter(hg, 0x9c7f58, 0.05, rng);
      g.add(new THREE.Mesh(hg, matPlank));
      var wheel = new THREE.TorusGeometry(0.17, 0.055, 7, 14);
      wheel.rotateY(Math.PI / 2);
      wheel.translate(0, 0.18, -0.62);
      var wg = G.paintJitter(wheel, 0x2e2e30, 0.04, rng);
      g.add(new THREE.Mesh(wg, matMetal));
      group.add(g);
    })();

    /* ---------------- fire pit ---------------- */
    var firepitPos = new THREE.Vector3(7.9, 0, 6.6);
    firepitPos.y = H(firepitPos.x, firepitPos.z);
    var fireLight = null;
    (function () {
      var cx = firepitPos.x, cz = firepitPos.z, cy = firepitPos.y;
      /* ring of stones */
      for (var i = 0; i < 11; i++) {
        var a = i / 11 * Math.PI * 2;
        var s = 0.16 + rng.f() * 0.1;
        var g = G.xf(G.lumpy(new THREE.IcosahedronGeometry(s, 0), 0.3, 3, rng),
          cx + Math.cos(a) * 0.78, cy + 0.06, cz + Math.sin(a) * 0.78,
          rng.angle(), rng.angle(), rng.angle(), 1, 0.75, 1);
        stone.push(G.paintJitter(g, 0x9a958a, 0.12, rng));
      }
      /* ash bed */
      var ash = G.cyl(0.62, 0.68, 0.06, 14);
      ash.translate(cx, cy + 0.02, cz);
      stone.push(G.paintJitter(ash, 0x4a453f, 0.1, rng));
      /* burning logs */
      for (var j = 0; j < 4; j++) {
        var a2 = j / 4 * Math.PI * 2 + 0.3;
        var lg = firewoodGeo(1.1, 0.075);
        lg.rotateY(a2);
        lg.translate(cx + Math.cos(a2) * 0.16, cy + 0.1 + (j % 2) * 0.09, cz + Math.sin(a2) * 0.16);
        G.paintFn(lg, function (c, x, y, z) {
          c.setHex(0x241c16).offsetHSL(0, 0, Math.sin(x * 9) * 0.03);
        });
        wood.push(lg);
      }
      /* log seats */
      for (var k = 0; k < 3; k++) {
        var a3 = k / 3 * Math.PI * 2 + 0.9;
        var sx = cx + Math.cos(a3) * 1.75, sz = cz + Math.sin(a3) * 1.75;
        var sy = H(sx, sz);
        var seat = G.cyl(0.21, 0.21, 1.25, 8);
        seat.rotateZ(Math.PI / 2);
        seat.rotateY(-a3 + 0.2);
        seat.translate(sx, sy + 0.2, sz);
        wood.push(G.paintJitter(seat, 0xffffff, 0.07, rng));
        for (var s2 = -1; s2 <= 1; s2 += 2) {
          var st = firewoodGeo(0.3, 0.1);
          st.translate(sx + Math.cos(a3 + Math.PI / 2) * s2 * 0.4, sy + 0.06, sz + Math.sin(a3 + Math.PI / 2) * s2 * 0.4);
          wood.push(st);
        }
      }
      fireLight = new THREE.PointLight(0xff7a2a, 2.0, 9, 1.8);
      fireLight.position.set(cx, cy + 0.35, cz);
      group.add(fireLight);
    })();

    /* ---------------- split rail fence + garden ---------------- */
    (function () {
      var ax = -13.5, az = 9.5, bx = -5.2, bz = 10.8;
      var n = 7;
      for (var i = 0; i <= n; i++) {
        var t = i / n;
        var px = lerp(ax, bx, t), pz = lerp(az, bz, t) + Math.sin(t * 2.4) * 0.4;
        var py = H(px, pz);
        var post = G.box(0.11, 1.25, 0.11);
        post.translate(px, py + 0.55, pz);
        planks.push(G.paintJitter(post, 0x9c8460, 0.07, rng));
        if (i < n) {
          var t2 = (i + 1) / n;
          var qx = lerp(ax, bx, t2), qz = lerp(az, bz, t2) + Math.sin(t2 * 2.4) * 0.4;
          var qy = H(qx, qz);
          for (var r = 0; r < 2; r++) {
            var mx = (px + qx) / 2, mz = (pz + qz) / 2, my = (py + qy) / 2 + 0.45 + r * 0.42;
            var len = Math.sqrt((qx - px) * (qx - px) + (qz - pz) * (qz - pz));
            var rail = G.box(0.07, 0.1, len);
            rail.rotateY(Math.atan2(qx - px, qz - pz));
            rail.translate(mx, my, mz);
            planks.push(G.paintJitter(rail, 0xa88e68, 0.07, rng));
          }
        }
      }
      /* vegetable rows */
      var vegGeo = (function () {
        var parts = [];
        for (var i = 0; i < 4; i++) {
          var s = G.lumpy(new THREE.IcosahedronGeometry(0.17, 0), 0.3, 3.2, rng);
          G.xf(s, (rng.f() - 0.5) * 0.22, 0.14 + rng.f() * 0.1, (rng.f() - 0.5) * 0.22);
          parts.push(s);
        }
        var g = G.merge(parts);
        G.paintFn(g, function (c, x, y, z) {
          var t = clamp(y / 0.35, 0, 1);
          c.setRGB(lerp(0.12, 0.26, t), lerp(0.2, 0.4, t), lerp(0.07, 0.14, t));
        });
        return g;
      })();
      var vegItems = [];
      for (var row = 0; row < 4; row++) {
        for (var c = 0; c < 6; c++) {
          var vx = ax + 1.2 + c * 0.85 + row * 0.3;
          var vz = az - 0.9 - row * 0.8;
          vegItems.push([vx, vz, 0.85 + rng.f() * 0.5]);
        }
      }
      var vegMesh = new THREE.InstancedMesh(vegGeo, matLeaf, vegItems.length);
      var m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
      var v = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color();
      for (var vi = 0; vi < vegItems.length; vi++) {
        var it = vegItems[vi];
        e.set(0, rng.angle(), 0); q.setFromEuler(e);
        v.set(it[0], H(it[0], it[1]) - 0.04, it[1]);
        s.set(it[2], it[2] * 0.9, it[2]);
        m.compose(v, q, s);
        vegMesh.setMatrixAt(vi, m);
        col.setRGB(1, 1, 1).offsetHSL(0, (rng.f() - 0.5) * 0.2, (rng.f() - 0.5) * 0.2);
        vegMesh.setColorAt(vi, col);
      }
      vegMesh.instanceMatrix.needsUpdate = true;
      if (vegMesh.instanceColor) vegMesh.instanceColor.needsUpdate = true;
      vegMesh.castShadow = true; vegMesh.receiveShadow = true;
      group.add(vegMesh);
      /* tomato stakes */
      for (var s3 = 0; s3 < 5; s3++) {
        var tx = ax + 1.6 + s3 * 1.3, tz = az - 0.5;
        var st2 = G.cyl(0.02, 0.025, 1.1, 5);
        st2.translate(tx, H(tx, tz) + 0.55, tz);
        planks.push(G.paintJitter(st2, 0xa89070, 0.06, rng));
      }
      /* scarecrow */
      (function () {
        var sx = -9.4, sz = 7.4, sy = H(sx, sz);
        var pole = G.cyl(0.045, 0.05, 1.9, 6);
        pole.translate(sx, sy + 0.95, sz);
        planks.push(G.paintJitter(pole, 0x9c8460, 0.05, rng));
        var cross = G.box(1.25, 0.06, 0.06);
        cross.translate(sx, sy + 1.45, sz);
        planks.push(G.paintJitter(cross, 0x9c8460, 0.05, rng));
        var shirt = G.box(0.6, 0.62, 0.28);
        shirt.translate(sx, sy + 1.2, sz);
        fabric.push(G.paintJitter(shirt, 0x8a6a4a, 0.06, rng));
        var head = G.sph(0.19, 9, 7);
        head.translate(sx, sy + 1.68, sz);
        fabric.push(G.paintJitter(head, 0xc9a06a, 0.05, rng));
        var hat = G.cyl(0.3, 0.3, 0.03, 12);
        hat.translate(sx, sy + 1.82, sz);
        fabric.push(G.paintJitter(hat, 0xb08a4a, 0.05, rng));
        var hatTop = G.cyl(0.13, 0.15, 0.16, 10);
        hatTop.translate(sx, sy + 1.9, sz);
        fabric.push(G.paintJitter(hatTop, 0xb08a4a, 0.05, rng));
      })();
      /* bird house */
      (function () {
        var bx2 = -5.0, bz2 = 6.2, by2 = H(bx2, bz2);
        var p2 = G.cyl(0.04, 0.045, 2.2, 6);
        p2.translate(bx2, by2 + 1.1, bz2);
        planks.push(G.paintJitter(p2, 0xa89070, 0.05, rng));
        var house = G.box(0.3, 0.3, 0.3);
        house.translate(bx2, by2 + 2.25, bz2);
        planks.push(G.paintJitter(house, 0x8f7350, 0.05, rng));
        var roof2 = G.cone(0.28, 0.22, 4);
        roof2.rotateY(Math.PI / 4);
        roof2.translate(bx2, by2 + 2.46, bz2);
        planks.push(G.paintJitter(roof2, 0x6d5942, 0.05, rng));
        var hole = G.cyl(0.06, 0.06, 0.1, 8);
        hole.rotateX(Math.PI / 2);
        hole.translate(bx2, by2 + 2.25, bz2 + 0.15);
        metal.push(G.paintJitter(hole, 0x1a1a1c, 0.04, rng));
      })();
    })();

    /* ---------------- clothes line ---------------- */
    var cloths = [];
    (function () {
      var a = new THREE.Vector3(-CB.PORCH_HX + 0.2, 2.3, CB.PORCH_Z1 - 0.3);
      var bx = -7.6, bz = 9.4, by = H(bx, bz);
      var b = new THREE.Vector3(bx, by + 1.9, bz);
      var pole = G.cyl(0.05, 0.06, 2.0, 6);
      pole.translate(bx, by + 0.9, bz);
      planks.push(G.paintJitter(pole, 0xa89070, 0.05, rng));
      var arm = G.box(0.06, 0.06, 0.5);
      arm.translate(bx, by + 1.86, bz - 0.2);
      planks.push(G.paintJitter(arm, 0xa89070, 0.05, rng));
      var pts = [];
      for (var i = 0; i <= 10; i++) {
        var t = i / 10;
        var p = a.clone().lerp(b, t);
        p.y -= Math.sin(t * Math.PI) * 0.22;
        pts.push(p);
      }
      var curve = new THREE.CatmullRomCurve3(pts);
      var line = new THREE.TubeGeometry(curve, 20, 0.012, 4, false);
      metal.push(G.paintJitter(line, 0x3a3a3c, 0.02, rng));
      for (var k = 0; k < 4; k++) {
        var t2 = 0.2 + k * 0.18;
        var p2 = curve.getPoint(t2);
        var cw = 0.42 + rng.f() * 0.2, ch2 = 0.55 + rng.f() * 0.35;
        var cg = G.box(cw, ch2, 0.02);
        cg.translate(p2.x, p2.y - ch2 / 2 - 0.03, p2.z);
        var mesh = new THREE.Mesh(G.paintJitter(cg, [0xd8cdb4, 0xb8c8d0, 0xc9a8b8, 0xe0d8c0][k], 0.06, rng), matFabric);
        mesh.castShadow = true;
        group.add(mesh);
        cloths.push({ mesh: mesh, phase: rng.angle() * 6 });
      }
    })();

    /* ---------------- path stones ---------------- */
    (function () {
      var pathPts = [
        [0.4, 6.6], [1.0, 7.8], [1.9, 9.3], [2.8, 11.0], [3.9, 12.8], [5.2, 15.0],
        [7.0, 17.6], [9.2, 20.6], [11.6, 23.8], [14.6, 27.6], [18.0, 31.8], [22.0, 37.0]
      ];
      for (var i = 0; i < pathPts.length; i++) {
        var px = pathPts[i][0], pz = pathPts[i][1];
        for (var k = 0; k < 4; k++) {
          var ox = px + (rng.f() - 0.5) * 1.5, oz = pz + (rng.f() - 0.5) * 1.5;
          var s = 0.22 + rng.f() * 0.3;
          var g = G.xf(G.lumpy(new THREE.IcosahedronGeometry(s, 0), 0.28, 3.4, rng),
            ox, H(ox, oz) + s * 0.18, oz, rng.angle(), rng.angle(), rng.angle(),
            1.2, 0.42, 1.0);
          stone.push(G.paintJitter(g, 0xb0aca2, 0.12, rng));
        }
      }
    })();

    /* ---------------- boulders + fallen log + stump ---------------- */
    (function () {
      var rocks = [
        [12.5, 1.5, 1.5], [-16.0, -8.0, 1.8], [3.0, -12.0, 1.2], [-11.0, 22.0, 1.1],
        [16.5, 14.0, 1.3], [-21.0, 12.0, 1.6], [8.0, -18.0, 1.4], [-6.0, -14.0, 1.0]
      ];
      rocks.forEach(function (r) {
        var g = G.lumpy(new THREE.IcosahedronGeometry(r[2], 1), 0.3, 2.2, rng);
        g.scale(1.2, 0.75, 1.0);
        g.translate(r[0], H(r[0], r[1]) + r[2] * 0.28, r[1]);
        G.paintFn(g, function (c, x, y, z) {
          var t = clamp((y - H(r[0], r[1])) / (r[2] * 1.2), 0, 1);
          c.setRGB(lerp(0.62, 1.05, t), lerp(0.6, 1.02, t), lerp(0.56, 0.96, t));
        });
        stone.push(g);
        /* moss cap */
        var mg = new THREE.SphereGeometry(r[2] * 0.78, 9, 6, 0, Math.PI * 2, 0, Math.PI * 0.42);
        mg.scale(1.2, 0.5, 1.0);
        mg.translate(r[0], H(r[0], r[1]) + r[2] * 0.38, r[1]);
        var mMesh = new THREE.Mesh(G.paintJitter(mg, 0x5c7a44, 0.14, rng), matLeaf);
        mMesh.castShadow = true; mMesh.receiveShadow = true;
        group.add(mMesh);
      });
      /* fallen log with moss */
      (function () {
        var x0 = -13.0, z0 = -2.0, x1 = -5.5, z1 = -5.5;
        var y0 = H(x0, z0), y1 = H(x1, z1);
        var len = Math.sqrt((x1 - x0) * (x1 - x0) + (z1 - z0) * (z1 - z0));
        var g = G.cyl(0.34, 0.42, len, 9);
        g.rotateZ(Math.PI / 2);
        g.rotateY(-Math.atan2(z1 - z0, x1 - x0));
        g.translate((x0 + x1) / 2, (y0 + y1) / 2 + 0.32, (z0 + z1) / 2);
        wood.push(G.paintJitter(g, 0xffffff, 0.07, rng));
        for (var i = 0; i < 5; i++) {
          var t = 0.2 + i * 0.16;
          var mx = lerp(x0, x1, t), mz = lerp(z0, z1, t);
          var mg2 = G.cyl(0.3, 0.34, len * 0.14, 8);
          mg2.rotateZ(Math.PI / 2);
          mg2.rotateY(-Math.atan2(z1 - z0, x1 - x0));
          mg2.translate(mx, lerp(y0, y1, t) + 0.5, mz);
          G.paintJitter(mg2, 0x5a7a42, 0.16, rng);
          wood.push(mg2);
        }
      })();
      /* stumps */
      [[5.6, -6.4, 0.8], [-8.5, -9.5, 0.62], [13.0, 8.0, 0.7]].forEach(function (s2) {
        var g = G.cyl(s2[2] * 0.8, s2[2], 0.6, 9);
        g.translate(s2[0], H(s2[0], s2[1]) + 0.28, s2[1]);
        G.paintFn(g, function (c, x, y, z) {
          if (y > H(s2[0], s2[1]) + 0.55) c.setHex(0xd6b88c).offsetHSL(0, 0, Math.sin(x * 18) * 0.05);
          else c.setHex(0x6a5540).offsetHSL(0, 0, Math.sin(y * 20) * 0.04);
        });
        wood.push(g);
      });
    })();

    /* ---------------- trail sign ---------------- */
    (function () {
      var sx = 3.6, sz = 12.0, sy = H(sx, sz);
      var post = G.box(0.1, 1.5, 0.1);
      post.translate(sx, sy + 0.75, sz);
      planks.push(G.paintJitter(post, 0x9c8460, 0.06, rng));
      var board = G.box(0.72, 0.26, 0.05);
      board.rotateY(0.35);
      board.translate(sx + 0.28, sy + 1.25, sz);
      planks.push(G.paintJitter(board, 0xc0a478, 0.06, rng));
      var arrow = G.cone(0.14, 0.2, 3);
      arrow.rotateX(Math.PI / 2);
      arrow.rotateY(0.35);
      arrow.translate(sx + 0.68, sy + 1.25, sz);
      planks.push(G.paintJitter(arrow, 0xc0a478, 0.06, rng));
    })();

    /* ---------------- merge ---------------- */
    function addMerged(list, mat, name, shadow) {
      if (!list.length) return null;
      var m2 = new THREE.Mesh(G.merge(list), mat);
      m2.castShadow = shadow !== false;
      m2.receiveShadow = true;
      m2.name = name;
      group.add(m2);
      return m2;
    }
    addMerged(wood, matWood, 'p-wood');
    addMerged(planks, matPlank, 'p-planks');
    addMerged(stone, matStone, 'p-stone');
    addMerged(paint, matPaint, 'p-paint');
    addMerged(metal, matMetal, 'p-metal');
    addMerged(fabric, matFabric, 'p-fabric');

    var t = 0;
    return {
      group: group,
      firepit: firepitPos,
      fireLight: fireLight,
      update: function (time, dt, nightFactor) {
        t = time;
        /* cloth sway */
        for (var i = 0; i < cloths.length; i++) {
          var c = cloths[i];
          c.mesh.rotation.z = Math.sin(time * 1.4 + c.phase) * 0.09;
          c.mesh.rotation.x = Math.sin(time * 1.1 + c.phase * 1.3) * 0.06;
        }
        /* fire flicker */
        if (fireLight) {
          var f = 0.75 + Math.sin(time * 11.3) * 0.12 + Math.sin(time * 7.1) * 0.1 + Math.sin(time * 19.7) * 0.06;
          fireLight.intensity = (0.35 + nightFactor * 2.6) * f;
        }
      }
    };
  }

  FC.Props = { create: create };

})(window);