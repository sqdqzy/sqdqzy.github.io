/* Forest Cabin - shared math, noise and geometry helpers */
(function (global) {
  'use strict';
  var FC = global.FC = global.FC || {};

  var TAU = Math.PI * 2;
  var DEG = Math.PI / 180;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function invLerp(a, b, v) { return b === a ? 0 : (v - a) / (b - a); }
  function smoothstep(e0, e1, x) { var t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1); return t * t * (3 - 2 * t); }
  function damp(cur, tgt, lambda, dt) { return lerp(cur, tgt, 1 - Math.exp(-lambda * dt)); }
  function fract(x) { return x - Math.floor(x); }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function Rng(seed) {
    this._n = mulberry32((seed | 0) || 1);
  }
  Rng.prototype.f = function () { return this._n(); };
  Rng.prototype.range = function (a, b) { return a + (b - a) * this._n(); };
  Rng.prototype.int = function (a, b) { return a + Math.floor(this._n() * (b - a + 1)); };
  Rng.prototype.sign = function () { return this._n() < 0.5 ? -1 : 1; };
  Rng.prototype.chance = function (p) { return this._n() < p; };
  Rng.prototype.pick = function (arr) { return arr[Math.min(arr.length - 1, Math.floor(this._n() * arr.length))]; };
  Rng.prototype.gauss = function (mu, sigma) {
    var u = 1 - this._n(), v = this._n();
    return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
  };
  Rng.prototype.angle = function () { return this._n() * TAU; };

  /* value noise with smootherstep interpolation */
  function Noise(seed) {
    var rnd = mulberry32((seed | 0) || 7);
    var perm = new Uint8Array(256), i, j, t;
    for (i = 0; i < 256; i++) perm[i] = i;
    for (i = 255; i > 0; i--) { j = Math.floor(rnd() * (i + 1)); t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
    this.p = new Uint8Array(512);
    for (i = 0; i < 512; i++) this.p[i] = perm[i & 255];
  }
  Noise.prototype.hash = function (x, y) { return this.p[(this.p[x & 255] + (y & 255)) & 511] / 255; };
  Noise.prototype.n = function (x, y) {
    var xi = Math.floor(x), yi = Math.floor(y);
    var xf = x - xi, yf = y - yi;
    var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    var a = this.hash(xi, yi), b = this.hash(xi + 1, yi);
    var c = this.hash(xi, yi + 1), d = this.hash(xi + 1, yi + 1);
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  };
  Noise.prototype.fbm = function (x, y, oct, lac, gain) {
    oct = oct || 4; lac = lac || 2.03; gain = gain === undefined ? 0.5 : gain;
    var amp = 1, freq = 1, sum = 0, norm = 0, i;
    for (i = 0; i < oct; i++) {
      sum += amp * this.n(x * freq, y * freq);
      norm += amp; amp *= gain; freq *= lac;
    }
    return sum / norm;
  };
  Noise.prototype.ridged = function (x, y, oct) {
    oct = oct || 4;
    var amp = 1, freq = 1, sum = 0, norm = 0, i;
    for (i = 0; i < oct; i++) {
      sum += amp * (1 - Math.abs(this.n(x * freq, y * freq) * 2 - 1));
      norm += amp; amp *= 0.5; freq *= 2.07;
    }
    return sum / norm;
  };

  /* ---------- geometry helpers ---------- */
  var geo = {
    /* concatenate geometries (indexed or not) into one non-indexed buffer */
    merge: function (list) {
      var parts = [], i;
      for (i = 0; i < list.length; i++) {
        var g = list[i];
        if (!g) continue;
        if (g.index) { var ni = g.toNonIndexed(); g.dispose(); parts.push(ni); }
        else parts.push(g);
      }
      var total = 0, hasColor = false, k;
      for (k = 0; k < parts.length; k++) {
        total += parts[k].attributes.position.count;
        if (parts[k].attributes.color) hasColor = true;
      }
      var pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), uv = new Float32Array(total * 2);
      var col = hasColor ? new Float32Array(total * 3) : null;
      var o3 = 0, o2 = 0;
      for (k = 0; k < parts.length; k++) {
        var p = parts[k], pa = p.attributes.position, na = p.attributes.normal, ua = p.attributes.uv, ca = p.attributes.color;
        pos.set(pa.array.subarray(0, pa.count * 3), o3);
        if (na) nor.set(na.array.subarray(0, na.count * 3), o3);
        if (ua) uv.set(ua.array.subarray(0, ua.count * 2), o2);
        if (col) {
          if (ca) col.set(ca.array.subarray(0, pa.count * 3), o3);
          else for (var q = 0; q < pa.count; q++) { col[o3 + q * 3] = 1; col[o3 + q * 3 + 1] = 1; col[o3 + q * 3 + 2] = 1; }
        }
        o3 += pa.count * 3; o2 += pa.count * 2;
      }
      var out = new THREE.BufferGeometry();
      out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
      return out;
    },

    /* apply position / rotation / scale in one call */
    xf: function (g, x, y, z, rx, ry, rz, sx, sy, sz) {
      var m = new THREE.Matrix4();
      var q = new THREE.Quaternion();
      var e = new THREE.Euler(rx || 0, ry || 0, rz || 0, 'XYZ');
      q.setFromEuler(e);
      m.compose(
        new THREE.Vector3(x || 0, y || 0, z || 0),
        q,
        new THREE.Vector3(sx === undefined ? 1 : sx, sy === undefined ? 1 : sy, sz === undefined ? 1 : sz)
      );
      g.applyMatrix4(m);
      return g;
    },

    box: function (w, h, d) { return new THREE.BoxGeometry(w, h, d); },
    cyl: function (rt, rb, h, seg, open) { return new THREE.CylinderGeometry(rt, rb, h, seg || 8, 1, !!open); },
    sph: function (r, w, h) { return new THREE.SphereGeometry(r, w || 10, h || 7); },
    plane: function (w, h, sw, sh) { return new THREE.PlaneGeometry(w, h, sw || 1, sh || 1); },
    cone: function (r, h, seg) { return new THREE.ConeGeometry(r, h, seg || 8, 1); },

    /* per-vertex colour so one merged mesh can hold many different tones */
    paint: function (g, color) {
      var c = color instanceof THREE.Color ? color : new THREE.Color(color);
      var n = g.attributes.position.count;
      var arr = new Float32Array(n * 3);
      for (var i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      return g;
    },

    /* subtle per-vertex tone jitter, keeps merged props from looking flat */
    paintJitter: function (g, color, amount, rng) {
      var c = color instanceof THREE.Color ? color : new THREE.Color(color);
      var n = g.attributes.position.count;
      var arr = new Float32Array(n * 3);
      for (var i = 0; i < n; i++) {
        var k = 1 + (rng.f() - 0.5) * 2 * amount;
        arr[i * 3] = c.r * k; arr[i * 3 + 1] = c.g * k; arr[i * 3 + 2] = c.b * k;
      }
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      return g;
    },

    /* multiply an existing colour attribute (e.g. gradient shading) */
    paintFn: function (g, fn) {
      var p = g.attributes.position;
      var arr = new Float32Array(p.count * 3), c = new THREE.Color();
      for (var i = 0; i < p.count; i++) {
        fn(c, p.getX(i), p.getY(i), p.getZ(i), i);
        arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      return g;
    },

    /* knock a flat-shaded rock / boulder out of an icosahedron */
    lumpy: function (geo, amp, freq, rng) {
      var p = geo.attributes.position;
      var v = new THREE.Vector3(), seedA = rng.f() * 10, seedB = rng.f() * 10;
      for (var i = 0; i < p.count; i++) {
        v.set(p.getX(i), p.getY(i), p.getZ(i));
        var n1 = Math.sin(v.x * freq + seedA) * Math.cos(v.y * freq * 1.3 + seedB) * Math.sin(v.z * freq * 0.9 + seedA);
        var n2 = Math.sin(v.x * freq * 2.7 + seedB) * Math.sin(v.z * freq * 2.1 + seedA) * 0.4;
        var s = 1 + (n1 + n2) * amp;
        v.multiplyScalar(s);
        p.setXYZ(i, v.x, v.y, v.z);
      }
      p.needsUpdate = true;
      geo.computeVertexNormals();
      return geo;
    }
  };

  /* tiny canvas helper shared by the texture module */
  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  FC.TAU = TAU;
  FC.DEG = DEG;
  FC.util = {
    clamp: clamp, lerp: lerp, invLerp: invLerp, smoothstep: smoothstep,
    damp: damp, fract: fract, Rng: Rng, Noise: Noise, makeCanvas: makeCanvas
  };
  FC.geo = geo;

})(window);