/* Forest Cabin - terrain heightfield, forest floor, trail, pond, distant ridges */
(function (global) {
  'use strict';
  var FC = global.FC;
  var THREE = global.THREE;
  var U = FC.util, lerp = U.lerp, clamp = U.clamp, smoothstep = U.smoothstep;

  var SIZE = 300, SEG = 190, HALF = SIZE / 2;

  var W = FC.World = {
    CABIN: { x: 0, z: 0 },
    PAD_Y: 0.30,
    POND: { x: -8.5, z: 16.5, r: 5.4, bottom: -1.95, water: -0.50 },
    POND_R: 5.4,
    TREE_INNER: 12.5,
    TREE_OUTER: 78,
    RIDGE_IN: 82,
    RIDGE_OUT: 118
  };

  var nA = new U.Noise(101), nB = new U.Noise(202), nC = new U.Noise(303), nD = new U.Noise(404);

  function pathPoints() {
    return [
      new THREE.Vector2(30, 52), new THREE.Vector2(22, 40), new THREE.Vector2(15.5, 31),
      new THREE.Vector2(10.5, 24.5), new THREE.Vector2(6.4, 18.5), new THREE.Vector2(3.4, 13.4),
      new THREE.Vector2(1.4, 9.6), new THREE.Vector2(0.2, 6.9), new THREE.Vector2(0.0, 5.5)
    ];
  }

  /* ---------- base landform (no trail) ---------- */
  function baseH(x, z) {
    var h = 0;
    h += (nA.fbm(x * 0.0115 + 13.7, z * 0.0115 - 4.2, 4) - 0.5) * 11.0;
    h += (nB.fbm(x * 0.034, z * 0.034, 3) - 0.5) * 2.4;
    h += (nC.fbm(x * 0.11, z * 0.11, 2) - 0.5) * 0.42;
    /* cabin terrace */
    var dc = Math.sqrt(x * x + z * z);
    var pad = smoothstep(16.5, 7.2, dc);
    h = lerp(h, W.PAD_Y, pad);
    /* pond basin: the water plane meets the bank exactly at r, no floating edge */
    var dx = x - W.POND.x, dz = z - W.POND.z;
    var dp = Math.sqrt(dx * dx + dz * dz);
    var shore = smoothstep(W.POND_R + 3.6, W.POND_R + 0.6, dp);
    if (shore > 0) {
      var inner = smoothstep(W.POND_R + 0.6, 1.2, dp);
      h = lerp(h, lerp(-0.42, W.POND.bottom, inner), shore);
    }
    return h;
  }

  /* ---------- trail distance field ---------- */
  var FIELD_N = 150, fieldDist = null, fieldY = null;
  function buildTrailField() {
    var pts = pathPoints();
    var curve = new THREE.SplineCurve(pts);
    var nodes = curve.getPoints(120);
    var ny = [];
    var i;
    for (i = 0; i < nodes.length; i++) ny.push(baseH(nodes[i].x, nodes[i].y));
    fieldDist = new Float32Array(FIELD_N * FIELD_N);
    fieldY = new Float32Array(FIELD_N * FIELD_N);
    for (var gy = 0; gy < FIELD_N; gy++) {
      var z = (gy / (FIELD_N - 1) - 0.5) * SIZE;
      for (var gx = 0; gx < FIELD_N; gx++) {
        var x = (gx / (FIELD_N - 1) - 0.5) * SIZE;
        var best = 1e9, bestY = 0;
        for (i = 0; i < nodes.length; i++) {
          var dx = x - nodes[i].x, dz = z - nodes[i].y;
          var d2 = dx * dx + dz * dz;
          if (d2 < best) { best = d2; bestY = ny[i]; }
        }
        var k = gy * FIELD_N + gx;
        fieldDist[k] = Math.sqrt(best);
        fieldY[k] = bestY;
      }
    }
  }
  function sampleField(arr, x, z) {
    var fx = clamp((x / SIZE + 0.5) * (FIELD_N - 1), 0, FIELD_N - 1.001);
    var fz = clamp((z / SIZE + 0.5) * (FIELD_N - 1), 0, FIELD_N - 1.001);
    var x0 = Math.floor(fx), z0 = Math.floor(fz);
    var tx = fx - x0, tz = fz - z0;
    var a = arr[z0 * FIELD_N + x0], b = arr[z0 * FIELD_N + x0 + 1];
    var c = arr[(z0 + 1) * FIELD_N + x0], d = arr[(z0 + 1) * FIELD_N + x0 + 1];
    return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
  }

  function heightAt(x, z) {
    var h = baseH(x, z);
    var d = sampleField(fieldDist, x, z);
    var w = smoothstep(3.1, 0.5, d);
    if (w > 0) {
      var ty = sampleField(fieldY, x, z) - 0.13;
      h = lerp(h, ty, w * 0.9);
    }
    return h;
  }

  function trailDist(x, z) { return sampleField(fieldDist, x, z); }

  function pondDepthInfo(x, z) {
    var dx = x - W.POND.x, dz = z - W.POND.z;
    var dp = Math.sqrt(dx * dx + dz * dz);
    return { d: dp, inside: smoothstep(W.POND_R - 0.1, W.POND_R - 1.4, dp) };
  }

  /* ---------- materials ---------- */
  function groundColor(x, z, h, slope, out) {
    var n = nD.fbm(x * 0.08, z * 0.08, 3);
    var n2 = nA.fbm(x * 0.021 + 5, z * 0.021, 3);
    var lush = clamp(n * 0.7 + n2 * 0.5 - 0.2, 0, 1);
    /* base grass tint */
    out.setRGB(
      lerp(1.02, 0.82, lush),
      lerp(1.0, 1.06, lush),
      lerp(0.86, 0.7, lush)
    );
    /* dry patches on high ground */
    var dry = clamp((h - 1.6) * 0.10 + (n2 - 0.55) * 0.7, 0, 1);
    out.r = lerp(out.r, 1.18, dry * 0.6); out.g = lerp(out.g, 1.02, dry * 0.6); out.b = lerp(out.b, 0.72, dry * 0.6);
    /* rock on steep faces */
    var rock = smoothstep(0.45, 0.85, slope);
    out.r = lerp(out.r, 1.05, rock); out.g = lerp(out.g, 0.99, rock); out.b = lerp(out.b, 0.94, rock);
    /* worn trail */
    var td = trailDist(x, z);
    var tw = smoothstep(2.5, 0.4, td);
    out.r = lerp(out.r, 1.30, tw * 0.85); out.g = lerp(out.g, 1.14, tw * 0.85); out.b = lerp(out.b, 0.92, tw * 0.85);
    /* wet dark shore */
    var pd = pondDepthInfo(x, z);
    var wet = smoothstep(W.POND_R + 1.8, W.POND_R - 0.2, pd.d);
    out.r = lerp(out.r, 0.52, wet); out.g = lerp(out.g, 0.52, wet); out.b = lerp(out.b, 0.5, wet);
    /* trodden yard in front of the cabin */
    var yard = smoothstep(9.5, 3.0, Math.sqrt(x * x + z * z));
    out.r = lerp(out.r, 1.22, yard * 0.5); out.g = lerp(out.g, 1.08, yard * 0.5); out.b = lerp(out.b, 0.9, yard * 0.5);
    return out;
  }

  /* radial disc with rings, used for the pond surface */
  function discGeometry(r, rings, seg) {
    var verts = [], norms = [], uvs = [], idx = [];
    var i, j;
    for (i = 0; i <= rings; i++) {
      var rr = (i / rings) * r;
      for (j = 0; j <= seg; j++) {
        var a = (j / seg) * Math.PI * 2;
        verts.push(Math.cos(a) * rr, 0, Math.sin(a) * rr);
        norms.push(0, 1, 0);
        uvs.push(i / rings, j / seg);
      }
    }
    for (i = 0; i < rings; i++) {
      for (j = 0; j < seg; j++) {
        var a0 = i * (seg + 1) + j, b0 = a0 + 1, c0 = a0 + seg + 1, d0 = c0 + 1;
        idx.push(a0, c0, b0, b0, c0, d0);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    return g;
  }

  function create(scene, tex, quality) {
    buildTrailField();

    var seg = quality.terrainSeg;
    var g = new THREE.PlaneGeometry(SIZE, SIZE, seg, seg);
    g.rotateX(-Math.PI / 2);
    var pos = g.attributes.position;
    var colors = new Float32Array(pos.count * 3);
    var c = new THREE.Color();
    var i, x, z;

    for (i = 0; i < pos.count; i++) {
      x = pos.getX(i); z = pos.getZ(i);
      pos.setY(i, heightAt(x, z));
    }
    /* slopes + vertex colours */
    for (i = 0; i < pos.count; i++) {
      x = pos.getX(i); z = pos.getZ(i); var y = pos.getY(i);
      var hx = heightAt(x + 0.8, z) - heightAt(x - 0.8, z);
      var hz = heightAt(x, z + 0.8) - heightAt(x, z - 0.8);
      var slope = clamp(Math.sqrt(hx * hx + hz * hz) / 1.6, 0, 1);
      groundColor(x, z, y, slope, c);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.computeVertexNormals();

    var gm = tex.ground.clone();
    gm.needsUpdate = true;
    gm.wrapS = gm.wrapT = THREE.RepeatWrapping;
    gm.repeat.set(46, 46);
    var gn = tex.groundNormal.clone();
    gn.needsUpdate = true;
    gn.wrapS = gn.wrapT = THREE.RepeatWrapping;
    gn.repeat.set(46, 46);

    var groundMat = new THREE.MeshStandardMaterial({
      map: gm, normalMap: gn, normalScale: new THREE.Vector2(0.8, 0.8),
      vertexColors: true, roughness: 0.97, metalness: 0.0, envMapIntensity: 0.5
    });
    var ground = new THREE.Mesh(g, groundMat);
    ground.receiveShadow = true;
    ground.name = 'ground';
    scene.add(ground);

    /* far skirt so the world never ends in mid air */
    var skirt = new THREE.Mesh(
      new THREE.RingGeometry(HALF * 0.98, 420, 64, 1),
      new THREE.MeshBasicMaterial({ color: 0x2c3326, fog: true })
    );
    skirt.rotateX(-Math.PI / 2);
    skirt.position.y = -0.2;
    scene.add(skirt);

    /* ---------- pond ---------- */
    var wg = discGeometry(W.POND_R + 0.25, 14, 56);
    var wc = new Float32Array(wg.attributes.position.count * 3);
    for (i = 0; i < wg.attributes.position.count; i++) {
      var rp = Math.sqrt(wg.attributes.position.getX(i) * wg.attributes.position.getX(i) + wg.attributes.position.getZ(i) * wg.attributes.position.getZ(i)) / (W.POND_R + 0.25);
      c.setRGB(lerp(0.55, 1.0, Math.pow(rp, 2.4)), lerp(0.72, 1.0, Math.pow(rp, 2.4)), lerp(0.78, 1.0, Math.pow(rp, 2.4)));
      wc[i * 3] = c.r; wc[i * 3 + 1] = c.g; wc[i * 3 + 2] = c.b;
    }
    wg.setAttribute('color', new THREE.BufferAttribute(wc, 3));
    var wn = tex.waterNormal.clone();
    wn.needsUpdate = true;
    wn.wrapS = wn.wrapT = THREE.RepeatWrapping;
    wn.repeat.set(4, 4);
    var waterMat = new THREE.MeshStandardMaterial({
      color: 0x1a3230, roughness: 0.10, metalness: 0.02,
      normalMap: wn, normalScale: new THREE.Vector2(0.5, 0.5),
      vertexColors: true, transparent: true, opacity: 0.94,
      envMapIntensity: 1.0
    });
    /* gentle ripple displacement */
    var waterUni = { value: 0 };
    waterMat.onBeforeCompile = function (sh) {
      sh.uniforms.uTime = waterUni;
      sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n transformed.y += sin(position.x*1.7 + uTime*1.1)*0.012 + sin(position.z*2.3 - uTime*0.8)*0.010;'
      );
    };
    var water = new THREE.Mesh(wg, waterMat);
    water.position.set(W.POND.x, W.POND.water, W.POND.z);
    water.name = 'water';
    scene.add(water);

    /* ---------- distant ridges ---------- */
    var ridgeGroup = new THREE.Group();
    var nE = new U.Noise(55);
    function ridge(rIn, rOut, hScale, color, seedOff, opacity) {
      var seg2 = 128, verts = [], cols = [], idx = [];
      for (var i2 = 0; i2 <= seg2; i2++) {
        var a = (i2 / seg2) * Math.PI * 2;
        var rr = nE.ridged(Math.cos(a) * 2.4 + seedOff, Math.sin(a) * 2.4 + seedOff, 4);
        var hgt = (0.25 + rr * 0.9) * hScale;
        var ca = Math.cos(a), sa = Math.sin(a);
        verts.push(ca * rIn, -2, sa * rIn);
        verts.push(ca * (rIn + (rOut - rIn) * 0.35), hgt, sa * (rIn + (rOut - rIn) * 0.35));
        verts.push(ca * rOut, hgt * 0.35, sa * rOut);
        for (var k = 0; k < 3; k++) cols.push(color.r, color.g, color.b);
      }
      for (var i3 = 0; i3 < seg2; i3++) {
        var a0 = i3 * 3, b0 = a0 + 3;
        idx.push(a0, a0 + 1, b0 + 1, a0, b0 + 1, b0);
        idx.push(a0 + 1, a0 + 2, b0 + 2, a0 + 1, b0 + 2, b0 + 1);
      }
      var rg = new THREE.BufferGeometry();
      rg.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      rg.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
      rg.setIndex(idx);
      var rm = new THREE.MeshBasicMaterial({
        color: 0xffffff, vertexColors: true, fog: true,
        transparent: opacity < 1, opacity: opacity, side: THREE.DoubleSide
      });
      var mesh = new THREE.Mesh(rg, rm);
      mesh.renderOrder = -900;
      return mesh;
    }
    ridgeGroup.add(ridge(W.RIDGE_IN + 16, W.RIDGE_OUT + 26, 26, new THREE.Color(0x2f4a46), 1.7, 1));
    ridgeGroup.add(ridge(W.RIDGE_IN + 4, W.RIDGE_IN + 30, 17, new THREE.Color(0x2a4038), 5.3, 1));
    ridgeGroup.position.y = -1.0;
    ridgeGroup.renderOrder = -900;
    scene.add(ridgeGroup);

    return {
      ground: ground,
      water: water,
      waterMat: waterMat,
      waterTime: waterUni,
      ridgeGroup: ridgeGroup,
      heightAt: heightAt,
      trailDist: trailDist,
      size: SIZE
    };
  }

  FC.Terrain = { create: create, heightAt: heightAt, SIZE: SIZE, HALF: HALF, discGeometry: discGeometry };

})(window);