/* Forest Cabin - procedural Canvas2D textures (no external assets) */
(function (global) {
  'use strict';
  var FC = global.FC;
  var U = FC.util, makeCanvas = U.makeCanvas, Noise = U.Noise, Rng = U.Rng, clamp = U.clamp, lerp = U.lerp;

  var noiseA = new Noise(11);
  var noiseB = new Noise(97);
  var rngTex = new Rng(20240613);

  /* tileable fbm: every octave uses an integer number of lattice cells */
  function tfbm(x, y, period, oct, gain) {
    oct = oct || 4; gain = gain === undefined ? 0.5 : gain;
    var amp = 1, p = period, sum = 0, norm = 0;
    for (var i = 0; i < oct; i++) {
      sum += amp * noiseA.n(x * p, y * p);
      norm += amp; amp *= gain; p *= 2;
    }
    return sum / norm;
  }
  function tfbm2(x, y, period, oct, gain) {
    oct = oct || 4; gain = gain === undefined ? 0.5 : gain;
    var amp = 1, p = period, sum = 0, norm = 0;
    for (var i = 0; i < oct; i++) {
      sum += amp * noiseB.n(x * p, y * p);
      norm += amp; amp *= gain; p *= 2;
    }
    return sum / norm;
  }

  /* fill a canvas per pixel: fn(u, v, out) writes r,g,b,a in 0..255 */
  function pixels(size, fn) {
    var c = makeCanvas(size, size);
    var ctx = c.getContext('2d');
    var img = ctx.createImageData(size, size);
    var d = img.data;
    var out = [0, 0, 0, 255];
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        out[3] = 255;
        fn(x / size, y / size, out, x, y);
        var i = (y * size + x) * 4;
        d[i] = out[0]; d[i + 1] = out[1]; d[i + 2] = out[2]; d[i + 3] = out[3];
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /* sobel a luminance canvas into a tangent-space normal map */
  function normalFromCanvas(src, strength) {
    var size = src.width;
    var sctx = src.getContext('2d');
    var data = sctx.getImageData(0, 0, size, size).data;
    var lum = new Float32Array(size * size);
    for (var i = 0, p = 0; i < lum.length; i++, p += 4) {
      lum[i] = (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114) / 255;
    }
    strength = strength === undefined ? 2.0 : strength;
    return pixels(size, function (u, v, out) {
      var x = Math.round(u * size) % size, y = Math.round(v * size) % size;
      var xm = (x - 1 + size) % size, xp = (x + 1) % size;
      var ym = (y - 1 + size) % size, yp = (y + 1) % size;
      var dx = (lum[y * size + xp] - lum[y * size + xm]) * strength;
      var dy = (lum[yp * size + x] - lum[ym * size + x]) * strength;
      var len = Math.sqrt(dx * dx + dy * dy + 1);
      out[0] = (-dx / len * 0.5 + 0.5) * 255;
      out[1] = (dy / len * 0.5 + 0.5) * 255;
      out[2] = (1 / len * 0.5 + 0.5) * 255;
    });
  }

  function toTex(canvas, repeat, srgb) {
    var t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if (repeat) t.repeat.set(repeat, repeat);
    t.encoding = srgb === false ? THREE.LinearEncoding : THREE.sRGBEncoding;
    t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
  }

  function texPair(size, drawFn, normalStrength, repeat, srgb) {
    var c = pixels(size, drawFn);
    var map = toTex(c, repeat, srgb);
    var nrm = null;
    if (normalStrength) nrm = toTex(normalFromCanvas(c, normalStrength), repeat, false);
    return { canvas: c, map: map, normalMap: nrm };
  }

  /* ---------------- bark ---------------- */
  function barkCanvas() {
    /* bark ridges run along the trunk: stretch noise along v (trunk length) */
    return pixels(256, function (u, v, out) {
      var groove = tfbm(u, v * 0.3, 14, 4, 0.55);
      var ridge = 1 - Math.abs(tfbm2(u, v * 0.22, 9, 3) * 2 - 1);
      var fiber = tfbm(u * 6, v * 0.2, 48, 2, 0.5);
      var k = groove * 0.55 + ridge * 0.3 + fiber * 0.15;
      var deep = U.smoothstep(0.62, 0.28, ridge);           // dark fissures
      var base = [78, 58, 42];
      var hi = [138, 116, 88];
      var t = clamp(k * 1.25 - 0.1, 0, 1);
      var r = lerp(base[0], hi[0], t) * (1 - deep * 0.72);
      var g = lerp(base[1], hi[1], t) * (1 - deep * 0.7);
      var b = lerp(base[2], hi[2], t) * (1 - deep * 0.66);
      var mossy = clamp(tfbm2(u, v, 4, 3) * 1.6 - 0.75, 0, 1) * clamp(1 - v * 0.6, 0, 1);
      out[0] = lerp(r, 74, mossy * 0.8);
      out[1] = lerp(g, 92, mossy * 0.8);
      out[2] = lerp(b, 48, mossy * 0.8);
    });
  }

  /* ---------------- sawn log / timber wall ---------------- */
  function woodCanvas(seedTint) {
    /* sawn timber: growth rings run along v (the length of the log) */
    return pixels(512, function (u, v, out) {
      var warp = tfbm2(u, v * 0.3, 3, 3) * 0.06;
      var rings = tfbm(u + warp, v * 0.14 + warp, 14, 3, 0.55);
      var grain = tfbm(u * 7, v * 0.25, 40, 3, 0.5);
      var knot = 0;
      var kx = 0.72, ky = 0.34, kd = Math.sqrt((u - kx) * (u - kx) * 3.4 + (v - ky) * (v - ky));
      knot = U.smoothstep(0.14, 0.02, kd);
      var t = clamp(rings * 0.75 + grain * 0.25, 0, 1);
      var dark = [92, 60, 38], light = [186, 138, 92];
      var r = lerp(dark[0], light[0], t), g = lerp(dark[1], light[1], t), b = lerp(dark[2], light[2], t);
      r = lerp(r, 58, knot * 0.85); g = lerp(g, 38, knot * 0.85); b = lerp(b, 24, knot * 0.85);
      /* chinking shadow at the very edges of the log */
      var edge = U.smoothstep(0.0, 0.06, u) * U.smoothstep(1.0, 0.94, u);
      var k2 = 1 - 0.45 * (1 - edge);
      out[0] = clamp(r * k2 * seedTint, 0, 255);
      out[1] = clamp(g * k2, 0, 255);
      out[2] = clamp(b * k2, 0, 255);
    });
  }

  /* ---------------- weathered deck planks ---------------- */
  function deckCanvas() {
    var c = makeCanvas(512, 512);
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#3b3227'; ctx.fillRect(0, 0, 512, 512);
    var rng = new Rng(4242);
    var rows = 6, h = 512 / rows;
    for (var r = 0; r < rows; r++) {
      var y = r * h;
      for (var seg = 0; seg < 2; seg++) {
        var x0 = seg === 0 ? 0 : 180, w = seg === 0 ? 180 : 332;
        var tone = 0.72 + rng.f() * 0.4;
        var base = [Math.floor(118 * tone), Math.floor(97 * tone), Math.floor(75 * tone)];
        ctx.fillStyle = 'rgb(' + base[0] + ',' + base[1] + ',' + base[2] + ')';
        ctx.fillRect(x0 + 1.5, y + 1.5, w - 3, h - 3);
        /* grain streaks */
        for (var s = 0; s < 26; s++) {
          var yy = y + 3 + rng.f() * (h - 6);
          ctx.strokeStyle = 'rgba(60,44,30,' + (0.05 + rng.f() * 0.12) + ')';
          ctx.lineWidth = 0.6 + rng.f() * 1.4;
          ctx.beginPath();
          ctx.moveTo(x0 + 3, yy);
          var steps = 6;
          for (var i = 0; i <= steps; i++) {
            ctx.lineTo(x0 + 3 + (w - 6) * i / steps, yy + Math.sin(i * 1.7 + r) * 1.6);
          }
          ctx.stroke();
        }
        /* nail heads */
        ctx.fillStyle = 'rgba(40,34,28,0.75)';
        ctx.beginPath(); ctx.arc(x0 + 12, y + h * 0.5, 2.1, 0, 6.3); ctx.fill();
        ctx.beginPath(); ctx.arc(x0 + w - 12, y + h * 0.5, 2.1, 0, 6.3); ctx.fill();
      }
    }
    /* weathering + dirt overlay */
    var img = ctx.getImageData(0, 0, 512, 512), d = img.data;
    for (var y2 = 0; y2 < 512; y2++) {
      for (var x2 = 0; x2 < 512; x2++) {
        var i2 = (y2 * 512 + x2) * 4;
        var u = x2 / 512, v = y2 / 512;
        var w2 = tfbm(u, v, 5, 4) * 0.5 + 0.75;
        d[i2] = clamp(d[i2] * w2 - 12, 0, 255);
        d[i2 + 1] = clamp(d[i2 + 1] * w2 - 10, 0, 255);
        d[i2 + 2] = clamp(d[i2 + 2] * w2 - 6, 0, 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /* ---------------- cedar shingle roof ---------------- */
  function shingleCanvas() {
    var c = makeCanvas(512, 512);
    var ctx = c.getContext('2d');
    var rng = new Rng(777);
    ctx.fillStyle = '#241c15'; ctx.fillRect(0, 0, 512, 512);
    var rows = 8, rh = 512 / rows, cols = 10, cw = 512 / cols;
    for (var r = 0; r < rows; r++) {
      var off = (r % 2) * cw * 0.5;
      for (var cix = -1; cix < cols + 1; cix++) {
        var x = cix * cw + off, y = r * rh;
        var tone = 0.66 + rng.f() * 0.5;
        var rr = Math.floor(96 * tone), gg = Math.floor(84 * tone), bb = Math.floor(72 * tone);
        ctx.fillStyle = 'rgb(' + rr + ',' + gg + ',' + bb + ')';
        ctx.fillRect(x + 1, y + 1, cw - 2, rh * 1.5 - 2);
        /* vertical split lines inside the shingle */
        for (var s = 0; s < 4; s++) {
          ctx.strokeStyle = 'rgba(30,22,16,' + (0.08 + rng.f() * 0.12) + ')';
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.moveTo(x + 4 + rng.f() * (cw - 8), y + 3);
          ctx.lineTo(x + 4 + rng.f() * (cw - 8), y + rh * 1.5 - 4);
          ctx.stroke();
        }
        /* shadow under the course above */
        var grd = ctx.createLinearGradient(0, y + rh * 0.9, 0, y + rh * 1.5);
        grd.addColorStop(0, 'rgba(0,0,0,0)');
        grd.addColorStop(1, 'rgba(0,0,0,0.55)');
        ctx.fillStyle = grd;
        ctx.fillRect(x + 1, y + rh * 0.9, cw - 2, rh * 0.6);
        /* top highlight */
        ctx.fillStyle = 'rgba(255,240,215,0.07)';
        ctx.fillRect(x + 1, y + 1, cw - 2, 2);
      }
    }
    /* moss patches */
    var img = ctx.getImageData(0, 0, 512, 512), d = img.data;
    for (var y3 = 0; y3 < 512; y3++) {
      for (var x3 = 0; x3 < 512; x3++) {
        var i3 = (y3 * 512 + x3) * 4;
        var u = x3 / 512, v = y3 / 512;
        var moss = clamp(tfbm2(u, v, 4, 4) * 1.9 - 0.95, 0, 1) * 0.85;
        var wear = tfbm(u, v, 8, 3) * 0.25 + 0.88;
        d[i3] = clamp(lerp(d[i3] * wear, 78, moss), 0, 255);
        d[i3 + 1] = clamp(lerp(d[i3 + 1] * wear, 96, moss), 0, 255);
        d[i3 + 2] = clamp(lerp(d[i3 + 2] * wear, 62, moss), 0, 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /* ---------------- field stone ---------------- */
  function stoneCanvas() {
    var c = makeCanvas(512, 512);
    var ctx = c.getContext('2d');
    var rng = new Rng(31337);
    ctx.fillStyle = '#3a352f'; ctx.fillRect(0, 0, 512, 512);
    for (var i = 0; i < 150; i++) {
      var x = rng.f() * 512, y = rng.f() * 512;
      var w = 26 + rng.f() * 54, h = 20 + rng.f() * 40;
      var tone = 0.55 + rng.f() * 0.55;
      var v = Math.floor(118 * tone);
      ctx.save();
      ctx.translate(x, y); ctx.rotate(rng.angle());
      ctx.fillStyle = 'rgb(' + v + ',' + Math.floor(v * 0.97) + ',' + Math.floor(v * 0.9) + ')';
      ctx.beginPath();
      var pts = 7;
      for (var p = 0; p < pts; p++) {
        var a = p / pts * Math.PI * 2;
        var rx = w * (0.6 + rng.f() * 0.5), ry = h * (0.6 + rng.f() * 0.5);
        var px = Math.cos(a) * rx, py = Math.sin(a) * ry;
        if (p === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(28,24,20,0.55)'; ctx.lineWidth = 2.2; ctx.stroke();
      ctx.restore();
    }
    var img = ctx.getImageData(0, 0, 512, 512), d = img.data;
    for (var y4 = 0; y4 < 512; y4++) {
      for (var x4 = 0; x4 < 512; x4++) {
        var i4 = (y4 * 512 + x4) * 4;
        var u = x4 / 512, v = y4 / 512;
        var m = clamp(tfbm2(u, v, 6, 3) * 1.7 - 0.95, 0, 1);
        var gr = tfbm(u, v, 12, 3) * 0.3 + 0.85;
        d[i4] = clamp(lerp(d[i4] * gr, 86, m * 0.6), 0, 255);
        d[i4 + 1] = clamp(lerp(d[i4 + 1] * gr, 104, m * 0.6), 0, 255);
        d[i4 + 2] = clamp(lerp(d[i4 + 2] * gr, 72, m * 0.6), 0, 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /* ---------------- forest floor ---------------- */
  function groundCanvas() {
    var c = pixels(512, function (u, v, out) {
      var big = tfbm(u, v, 5, 4);
      var fine = tfbm2(u, v, 28, 3);
      var dirt = [72, 56, 40], moss = [58, 78, 40], dry = [104, 96, 56];
      var m = clamp(big * 1.7 - 0.42, 0, 1);
      var d = clamp(tfbm2(u, v, 4, 3) * 1.5 - 0.35, 0, 1);
      var k = fine * 0.25 + 0.85;
      var r = lerp(lerp(dirt[0], moss[0], m), dry[0], d) * k;
      var g = lerp(lerp(dirt[1], moss[1], m), dry[1], d) * k;
      var b = lerp(lerp(dirt[2], moss[2], m), dry[2], d) * k;
      out[0] = clamp(r, 0, 255); out[1] = clamp(g, 0, 255); out[2] = clamp(b, 0, 255);
    });
    /* leaf litter + pebbles */
    var ctx = c.getContext('2d'), rng = new Rng(9090);
    for (var i = 0; i < 420; i++) {
      var x = rng.f() * 512, y = rng.f() * 512;
      var a = rng.angle(), l = 3 + rng.f() * 7;
      var tone = rng.f();
      ctx.save(); ctx.translate(x, y); ctx.rotate(a);
      ctx.fillStyle = tone > 0.6
        ? 'rgba(' + Math.floor(120 + rng.f() * 40) + ',' + Math.floor(80 + rng.f() * 30) + ',40,0.5)'
        : 'rgba(' + Math.floor(90 + rng.f() * 30) + ',' + Math.floor(70 + rng.f() * 25) + ',' + Math.floor(30 + rng.f() * 20) + ',0.42)';
      ctx.beginPath(); ctx.ellipse(0, 0, l, l * 0.42, 0, 0, 6.3); ctx.fill();
      ctx.restore();
    }
    for (var p = 0; p < 260; p++) {
      var px = rng.f() * 512, py = rng.f() * 512, pr = 0.8 + rng.f() * 2.2;
      var g2 = Math.floor(90 + rng.f() * 70);
      ctx.fillStyle = 'rgba(' + g2 + ',' + g2 + ',' + Math.floor(g2 * 0.95) + ',0.75)';
      ctx.beginPath(); ctx.arc(px, py, pr, 0, 6.3); ctx.fill();
    }
    return c;
  }

  /* ---------------- trodden path ---------------- */
  function pathCanvas() {
    var c = pixels(256, function (u, v, out) {
      var n = tfbm(u, v, 8, 4) * 0.6 + tfbm2(u, v, 24, 3) * 0.4;
      var k = n * 0.55 + 0.72;
      var r = 118 * k, g = 104 * k, b = 84 * k;
      var grass = clamp(tfbm2(u, v, 5, 3) * 1.8 - 0.95, 0, 1);
      out[0] = clamp(lerp(r, 70, grass), 0, 255);
      out[1] = clamp(lerp(g, 86, grass), 0, 255);
      out[2] = clamp(lerp(b, 48, grass), 0, 255);
    });
    var ctx = c.getContext('2d'), rng = new Rng(5150);
    for (var i = 0; i < 700; i++) {
      var x = rng.f() * 256, y = rng.f() * 256, r = 0.7 + rng.f() * 2.4;
      var t = 70 + rng.f() * 90;
      ctx.fillStyle = 'rgba(' + Math.floor(t) + ',' + Math.floor(t * 0.95) + ',' + Math.floor(t * 0.86) + ',0.8)';
      ctx.beginPath(); ctx.arc(x, y, r, 0, 6.3); ctx.fill();
    }
    return c;
  }

/* =====================================================================
     Alpha tested cards need a separate colour map and mask map.
     A canvas stores premultiplied colour, so transparent pixels are black;
     if they shared the mip chain with the foliage the whole card darkens as
     it shrinks on screen. So we draw every shape twice: once in colour on a
     filled background (colour map) and once in white on black (mask map).
     ===================================================================== */
  function shapePair(size, bg, drawFn) {
    var c = makeCanvas(size, size), ctx = c.getContext('2d');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, size, size);
    drawFn(ctx, size, false);
    var a = makeCanvas(size, size), ax = a.getContext('2d');
    ax.fillStyle = '#000000'; ax.fillRect(0, 0, size, size);
    drawFn(ax, size, true);
    return { color: c, mask: a };
  }

  /* ---------------- leaf cluster (canopy cards) ---------------- */
  function drawLeaves(ctx, size, mono) {
    var W = size, rng = new Rng(2468);
    function leaf(x, y, len, wid, ang, col, alpha) {
      ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
      ctx.fillStyle = mono ? '#ffffff' : col; ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(wid, len * 0.32, 0, len);
      ctx.quadraticCurveTo(-wid, len * 0.32, 0, 0);
      ctx.fill();
      ctx.globalAlpha = alpha * 0.5;
      ctx.strokeStyle = mono ? '#ffffff' : 'rgba(30,42,18,0.75)'; ctx.lineWidth = 0.9;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, len); ctx.stroke();
      ctx.restore();
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = mono ? '#ffffff' : '#4a3a28'; ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.moveTo(W / 2, W - 6); ctx.lineTo(W / 2, W * 0.59); ctx.stroke();
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(W / 2, W * 0.78); ctx.lineTo(W * 0.29, W * 0.59);
    ctx.moveTo(W / 2, W * 0.73); ctx.lineTo(W * 0.72, W * 0.54); ctx.stroke();
    for (var i = 0; i < 360; i++) {
      var x = W * 0.07 + rng.f() * W * 0.86;
      var y = W * 0.05 + rng.f() * W * 0.84;
      var nx = (x - W / 2) / (W * 0.44), ny = (y - W * 0.46) / (W * 0.4);
      var rad = Math.sqrt(nx * nx + ny * ny);
      if (rad > 1.06) continue;
      var edge = Math.max(0, 1 - rad * rad);
      var len = W * 0.06 + rng.f() * W * 0.1;
      var warm = rng.f();
      var g = (96 + rng.f() * 80) * (0.6 + 0.5 * edge);
      var rr2 = (40 + rng.f() * 28 + warm * 28) * (0.65 + 0.45 * edge);
      var bb = (32 + rng.f() * 24) * (0.65 + 0.45 * edge);
      var col = 'rgb(' + Math.floor(rr2) + ',' + Math.floor(g) + ',' + Math.floor(bb) + ')';
      leaf(x, y, len, len * 0.33, rng.angle(), col, 0.6 + 0.4 * edge);
    }
  }

  /* ---------------- grass / fern tuft card ---------------- */
  function drawTufts(ctx, size, mono, fern) {
    var W = size, rng = new Rng(fern ? 6161 : 3131);
    var n = fern ? 6 : 64;
    for (var i = 0; i < n; i++) {
      var x0 = W / 2 + (rng.f() - 0.5) * (fern ? 0.2 : 0.88) * W;
      var len = (fern ? 0.52 + rng.f() * 0.33 : 0.5 + rng.f() * 0.46) * W;
      var lean = (x0 - W / 2) / (W / 2) * (fern ? 0.95 : 0.55) + (rng.f() - 0.5) * 0.25;
      var g = 82 + rng.f() * 62;
      var col = mono ? '#ffffff' : 'rgb(' + Math.floor(40 + rng.f() * 28) + ',' + Math.floor(g) + ',' + Math.floor(36 + rng.f() * 26) + ')';
      ctx.strokeStyle = col; ctx.lineCap = 'round';
      if (fern) {
        ctx.lineWidth = W * 0.046;
        ctx.beginPath(); ctx.moveTo(x0, W);
        ctx.quadraticCurveTo(x0 + lean * 22, W - len * 0.6, x0 + lean * 52, W - len);
        ctx.stroke();
        var steps = 11;
        for (var s = 0; s <= steps; s++) {
          var t = s / steps;
          var px = x0 + lean * 52 * t * t, py = W - len * t;
          var pl = W * 0.2 * (1 - t * 0.55) + 4;
          ctx.lineWidth = W * 0.038;
          ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px - pl, py - pl * 0.42); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + pl, py - pl * 0.42); ctx.stroke();
        }
      } else {
        ctx.lineWidth = W * 0.016 + rng.f() * W * 0.012;
        ctx.beginPath(); ctx.moveTo(x0, W);
        ctx.quadraticCurveTo(x0 + lean * 14, W - len * 0.55, x0 + lean * 34, W - len);
        ctx.stroke();
      }
    }
  }

  /* ---------------- small flower card ---------------- */
  function drawFlowers(ctx, size, mono) {
    var W = size, rng = new Rng(88);
    var palettes = ['#f6eaa8', '#f0bccc', '#cfdcf2', '#f4f4e8', '#eec07a'];
    ctx.strokeStyle = mono ? '#ffffff' : '#4e7a3a'; ctx.lineWidth = W * 0.022;
    for (var s = 0; s < 5; s++) {
      var sx = W * 0.2 + rng.f() * W * 0.6;
      ctx.beginPath(); ctx.moveTo(sx, W);
      ctx.quadraticCurveTo(sx + (rng.f() - 0.5) * 8, W * 0.7, sx + (rng.f() - 0.5) * 12, W * 0.5 + rng.f() * 10);
      ctx.stroke();
    }
    for (var i = 0; i < 7; i++) {
      var x = W * 0.16 + rng.f() * W * 0.68, y = W * 0.1 + rng.f() * W * 0.55;
      var r = W * 0.04 + rng.f() * W * 0.045;
      ctx.fillStyle = mono ? '#ffffff' : rng.pick(palettes);
      for (var p = 0; p < 5; p++) {
        var a = p / 5 * Math.PI * 2;
        ctx.beginPath();
        ctx.ellipse(x + Math.cos(a) * r * 0.7, y + Math.sin(a) * r * 0.7, r * 0.55, r * 0.4, a, 0, 6.3);
        ctx.fill();
      }
      ctx.fillStyle = mono ? '#ffffff' : 'rgba(236,198,96,0.95)';
      ctx.beginPath(); ctx.arc(x, y, r * 0.4, 0, 6.3); ctx.fill();
    }
  }

  /* ---------------- sprites ---------------- */
  function glowCanvas(size, inner, outer, power) {
    var c = makeCanvas(size, size), ctx = c.getContext('2d');
    var g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    var steps = 8;
    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      var a = Math.pow(1 - t, power || 2.4);
      g.addColorStop(t, 'rgba(255,255,255,' + (a * (1 - t * 0.0)).toFixed(4) + ')');
    }
    ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
    if (inner) { /* warm core */ }
    return c;
  }
  function warmGlowCanvas(size) {
    var c = makeCanvas(size, size), ctx = c.getContext('2d');
    var g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,247,224,1)');
    g.addColorStop(0.18, 'rgba(255,214,148,0.85)');
    g.addColorStop(0.45, 'rgba(255,166,80,0.30)');
    g.addColorStop(1, 'rgba(255,140,60,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
    return c;
  }
  function smokeCanvas() {
    var c = makeCanvas(128, 128), ctx = c.getContext('2d');
    var rng = new Rng(1212);
    ctx.clearRect(0, 0, 128, 128);
    for (var i = 0; i < 26; i++) {
      var x = 64 + (rng.f() - 0.5) * 44, y = 64 + (rng.f() - 0.5) * 44;
      var r = 14 + rng.f() * 26;
      var g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,0.30)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.3); ctx.fill();
    }
    /* fade the border so particles never show a hard square */
    var vg = ctx.createRadialGradient(64, 64, 40, 64, 64, 64);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = vg; ctx.fillRect(0, 0, 128, 128);
    ctx.globalCompositeOperation = 'source-over';
    return c;
  }
  function windowGlowCanvas() {
    var c = makeCanvas(128, 128), ctx = c.getContext('2d');
    var g = ctx.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, 'rgba(255,196,110,0.0)');
    g.addColorStop(0.28, 'rgba(255,196,110,0.55)');
    g.addColorStop(0.75, 'rgba(255,170,80,0.35)');
    g.addColorStop(1, 'rgba(255,150,60,0.0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
    var s = ctx.createLinearGradient(0, 0, 128, 0);
    s.addColorStop(0, 'rgba(0,0,0,1)');
    s.addColorStop(0.18, 'rgba(0,0,0,0)');
    s.addColorStop(0.82, 'rgba(0,0,0,0)');
    s.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = s; ctx.fillRect(0, 0, 128, 128);
    return c;
  }

  /* window pane: soft gradient so the glass is not a flat card */
  function glassCanvas() {
    var c = makeCanvas(64, 64), ctx = c.getContext('2d');
    var g = ctx.createLinearGradient(0, 0, 0, 64);
    g.addColorStop(0, '#6f6a62');
    g.addColorStop(0.35, '#b9a88c');
    g.addColorStop(0.78, '#e8d3ac');
    g.addColorStop(1, '#f7e6c6');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
    /* curtain folds */
    var rng = new Rng(717);
    ctx.globalAlpha = 0.28;
    for (var i = 0; i < 9; i++) {
      var x = rng.f() * 64;
      ctx.fillStyle = rng.chance(0.5) ? '#2a2620' : '#fff2d8';
      ctx.fillRect(x, 0, 1 + rng.f() * 3.5, 64);
    }
    ctx.globalAlpha = 1;
    /* corner falloff */
    var v = ctx.createRadialGradient(32, 34, 6, 32, 32, 46);
    v.addColorStop(0, 'rgba(255,255,255,0)');
    v.addColorStop(1, 'rgba(40,32,24,0.55)');
    ctx.fillStyle = v; ctx.fillRect(0, 0, 64, 64);
    return c;
  }

  /* ---------------- water normal (two layers scrolling) ---------------- */
  function waterNormalCanvas() {
    var c = pixels(256, function (u, v, out) {
      var h = tfbm(u, v * 2.2, 6, 4) * 0.7 + tfbm2(u * 1.3, v * 2.6, 14, 3) * 0.3;
      var t = clamp(h * 1.2, 0, 1);
      out[0] = clamp(lerp(0.42, 0.58, t) * 255, 0, 255);
      out[1] = clamp(lerp(0.52, 0.44, t) * 255, 0, 255);
      out[2] = 235;
    });
    return normalFromCanvas(c, 1.1);
  }

  /* ---------------- fabric ---------------- */
  function fabricCanvas() {
    return pixels(128, function (u, v, out) {
      var weave = (Math.sin(u * 128 * Math.PI) * 0.5 + 0.5) * 0.35 + (Math.sin(v * 128 * Math.PI) * 0.5 + 0.5) * 0.35;
      var n = tfbm(u, v, 8, 3) * 0.4;
      var k = 0.78 + weave * 0.12 + n * 0.3;
      out[0] = clamp(232 * k, 0, 255); out[1] = clamp(226 * k, 0, 255); out[2] = clamp(214 * k, 0, 255);
    });
  }

  /* ---------------- birch bark ---------------- */
  function birchCanvas() {
    return pixels(256, function (u, v, out) {
      var n = tfbm(u, v, 8, 4);
      var k = 0.86 + n * 0.24;
      var r = 226 * k, g = 220 * k, b = 206 * k;
      /* dark lenticel dashes */
      var row = Math.floor(v * 11);
      var f = U.fract(v * 11);
      if (f < 0.42) {
        var h = tfbm2(u + row * 0.37, v * 0.4, 6, 2);
        if (h > 0.62) {
          var w = (h - 0.62) * 3.4;
          if (Math.abs(U.fract(u * 9 + h * 3) - 0.5) < w) {
            var d = 0.42 * U.smoothstep(0.42, 0.0, f);
            r = lerp(r, 42, d); g = lerp(g, 38, d); b = lerp(b, 34, d);
          }
        }
      }
      /* peeling curls */
      var peel = clamp(tfbm2(u, v, 3, 3) * 1.8 - 0.95, 0, 1);
      r = lerp(r, 196, peel); g = lerp(g, 168, peel); b = lerp(b, 140, peel);
      out[0] = clamp(r, 0, 255); out[1] = clamp(g, 0, 255); out[2] = clamp(b, 0, 255);
    });
  }

  /* =====================================================================
     build + cache every texture once
     ===================================================================== */
  var T = {};
  function build() {
    if (T.ready) return T;

    var bark = barkCanvas();
    T.bark = toTex(bark, 1);
    T.barkNormal = toTex(normalFromCanvas(bark, 2.4), 1, false);

    var wood = woodCanvas(1);
    T.wood = toTex(wood, 1);
    T.woodNormal = toTex(normalFromCanvas(wood, 1.6), 1, false);

    var deck = deckCanvas();
    T.deck = toTex(deck, 1);
    T.deckNormal = toTex(normalFromCanvas(deck, 1.2), 1, false);

    var shingle = shingleCanvas();
    T.shingle = toTex(shingle, 1);
    T.shingleNormal = toTex(normalFromCanvas(shingle, 2.6), 1, false);

    var stone = stoneCanvas();
    T.stone = toTex(stone, 1);
    T.stoneNormal = toTex(normalFromCanvas(stone, 2.2), 1, false);

    var ground = groundCanvas();
    T.ground = toTex(ground, 1);
    T.groundNormal = toTex(normalFromCanvas(ground, 1.5), 1, false);

    var path = pathCanvas();
    T.path = toTex(path, 1);
    T.pathNormal = toTex(normalFromCanvas(path, 1.8), 1, false);

    var birch = birchCanvas();
    T.birch = toTex(birch, 1);
    T.birchNormal = toTex(normalFromCanvas(birch, 1.2), 1, false);

    var leaves = shapePair(256, '#4a5a2c', drawLeaves);
    T.leaf = toTex(leaves.color, 1);
    T.leaf.wrapS = T.leaf.wrapT = THREE.ClampToEdgeWrapping;
    T.leafA = toTex(leaves.mask, 1, false);
    T.leafA.wrapS = T.leafA.wrapT = THREE.ClampToEdgeWrapping;

    var tufts = shapePair(128, '#586a30', function (ctx, s, m) { drawTufts(ctx, s, m, false); });
    T.tuft = toTex(tufts.color, 1);
    T.tuft.wrapS = T.tuft.wrapT = THREE.ClampToEdgeWrapping;
    T.tuftA = toTex(tufts.mask, 1, false);
    T.tuftA.wrapS = T.tuftA.wrapT = THREE.ClampToEdgeWrapping;

    var ferns = shapePair(128, '#5d6c31', function (ctx, s, m) { drawTufts(ctx, s, m, true); });
    T.fern = toTex(ferns.color, 1);
    T.fern.wrapS = T.fern.wrapT = THREE.ClampToEdgeWrapping;
    T.fernA = toTex(ferns.mask, 1, false);
    T.fernA.wrapS = T.fernA.wrapT = THREE.ClampToEdgeWrapping;

    var flowers = shapePair(64, '#58682f', drawFlowers);
    T.flower = toTex(flowers.color, 1);
    T.flower.wrapS = T.flower.wrapT = THREE.ClampToEdgeWrapping;
    T.flowerA = toTex(flowers.mask, 1, false);
    T.flowerA.wrapS = T.flowerA.wrapT = THREE.ClampToEdgeWrapping;
    T.fabric = toTex(fabricCanvas(), 1);

    T.glow = toTex(glowCanvas(128), 1);
    T.glow.wrapS = T.glow.wrapT = THREE.ClampToEdgeWrapping;
    T.warmGlow = toTex(warmGlowCanvas(128), 1);
    T.warmGlow.wrapS = T.warmGlow.wrapT = THREE.ClampToEdgeWrapping;
    T.smoke = toTex(smokeCanvas(), 1);
    T.smoke.wrapS = T.smoke.wrapT = THREE.ClampToEdgeWrapping;
    T.windowGlow = toTex(windowGlowCanvas(), 1);
    T.windowGlow.wrapS = T.windowGlow.wrapT = THREE.ClampToEdgeWrapping;
    T.glass = toTex(glassCanvas(), 1);
    T.glass.wrapS = T.glass.wrapT = THREE.ClampToEdgeWrapping;
    T.waterNormal = toTex(waterNormalCanvas(), 1, false);

    T.ready = true;
    return T;
  }

  FC.tex = {
    get: function () { return build(); },
    toTex: toTex,
    pixels: pixels,
    normalFromCanvas: normalFromCanvas,
    Noise: Noise
  };

})(window);
