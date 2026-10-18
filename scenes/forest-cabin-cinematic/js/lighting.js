/* Forest Cabin - time of day system: sun position, colour grading keys, fog */
(function (global) {
  'use strict';
  var FC = global.FC;
  var THREE = global.THREE;
  var U = FC.util, lerp = U.lerp, clamp = U.clamp;

  var SUNRISE = 5.7, SUNSET = 19.3;

  /* every key is [hour, values] */
  var KEYS = [
    { h: 0.0, sun: 0x6f86c4, si: 0.10, zen: 0x060a16, hor: 0x121a2e, grd: 0x05070c, cl: 0x2a3352, cd: 0x0b1020, sunSize: 0.99955, cloud: 0.45, haze: 0.35, star: 1.0, moon: 1.0, hemiS: 0x1b2742, hemiG: 0x0b0d10, hi: 0.22, fog: 0x0a0f1c, fd: 0.017, win: 1.0, exp: 1.5, bloom: 1.25, fly: 1.0, sunEl: -0.30 },
    { h: 4.4, sun: 0x8a7ea8, si: 0.16, zen: 0x0d1430, hor: 0x27304d, grd: 0x0a0c12, cl: 0x4a4e6a, cd: 0x14182a, sunSize: 0.9995, cloud: 0.5, haze: 0.5, star: 0.75, moon: 0.9, hemiS: 0x2b3554, hemiG: 0x14161c, hi: 0.3, fog: 0x18203a, fd: 0.022, win: 1.0, exp: 1.45, bloom: 1.2, fly: 0.7, sunEl: -0.05 },
    { h: 6.2, sun: 0xff9a52, si: 1.05, zen: 0x1d3f77, hor: 0xe58a5c, grd: 0x2a2018, cl: 0xffb787, cd: 0x5b5570, sunSize: 0.99945, cloud: 0.56, haze: 1.5, star: 0.12, moon: 0.3, hemiS: 0x6a7fae, hemiG: 0x2c2620, hi: 0.55, fog: 0x9a8a92, fd: 0.026, win: 0.85, exp: 1.25, bloom: 1.15, fly: 0.15, sunEl: 0.06 },
    { h: 8.0, sun: 0xffd0a0, si: 2.35, zen: 0x2a63ae, hor: 0xd5dee4, grd: 0x33302a, cl: 0xfff6ea, cd: 0x9aa6bd, sunSize: 0.9995, cloud: 0.48, haze: 1.0, star: 0, moon: 0, hemiS: 0x9fc0e8, hemiG: 0x3b382c, hi: 0.8, fog: 0xc3cdd4, fd: 0.016, win: 0.25, exp: 1.05, bloom: 0.85, fly: 0, sunEl: 0.30 },
    { h: 12.0, sun: 0xfff3e0, si: 3.15, zen: 0x1f63bd, hor: 0xbfd8ea, grd: 0x3c3a33, cl: 0xffffff, cd: 0xa9b6cc, sunSize: 0.9996, cloud: 0.42, haze: 0.7, star: 0, moon: 0, hemiS: 0xbcd9f5, hemiG: 0x47442f, hi: 1.0, fog: 0xbacbd6, fd: 0.0125, win: 0.05, exp: 0.92, bloom: 0.6, fly: 0, sunEl: 0.82 },
    { h: 16.0, sun: 0xffe0b0, si: 2.6, zen: 0x2a63b0, hor: 0xd7dcd8, grd: 0x38352d, cl: 0xfff3e2, cd: 0x9fa9be, sunSize: 0.99955, cloud: 0.46, haze: 0.9, star: 0, moon: 0, hemiS: 0xaec8e8, hemiG: 0x45422f, hi: 0.92, fog: 0xbcc3c0, fd: 0.0115, win: 0.12, exp: 1.0, bloom: 0.7, fly: 0, sunEl: 0.42 },
    { h: 18.6, sun: 0xffb894, si: 1.8, zen: 0x2c4a86, hor: 0xec9c66, grd: 0x2e2419, cl: 0xffc08a, cd: 0x6b5a72, sunSize: 0.9994, cloud: 0.58, haze: 1.5, star: 0, moon: 0, hemiS: 0x93a6cc, hemiG: 0x5a5446, hi: 1.05, fog: 0xc99a80, fd: 0.0115, win: 0.5, exp: 1.1, bloom: 1.05, fly: 0.05, sunEl: 0.12 },
    { h: 19.9, sun: 0xd4552a, si: 0.72, zen: 0x1b2a55, hor: 0xa3552f, grd: 0x181410, cl: 0xc07a5a, cd: 0x3c3a50, sunSize: 0.9993, cloud: 0.6, haze: 1.9, star: 0.35, moon: 0.55, hemiS: 0x4d5c8a, hemiG: 0x201c18, hi: 0.5, fog: 0x6a4a42, fd: 0.019, win: 0.9, exp: 1.35, bloom: 1.25, fly: 0.6, sunEl: 0.01 },
    { h: 21.4, sun: 0x7b86bd, si: 0.14, zen: 0x080e22, hor: 0x1a2440, grd: 0x06080d, cl: 0x33395a, cd: 0x0d1222, sunSize: 0.99955, cloud: 0.5, haze: 0.45, star: 0.92, moon: 1.0, hemiS: 0x22304e, hemiG: 0x0d0f12, hi: 0.26, fog: 0x0d1428, fd: 0.019, win: 1.0, exp: 1.48, bloom: 1.25, fly: 1.0, sunEl: -0.18 },
    { h: 24.0, sun: 0x6f86c4, si: 0.10, zen: 0x060a16, hor: 0x121a2e, grd: 0x05070c, cl: 0x2a3352, cd: 0x0b1020, sunSize: 0.99955, cloud: 0.45, haze: 0.35, star: 1.0, moon: 1.0, hemiS: 0x1b2742, hemiG: 0x0b0d10, hi: 0.22, fog: 0x0a0f1c, fd: 0.017, win: 1.0, exp: 1.5, bloom: 1.25, fly: 1.0, sunEl: -0.30 }
  ];

  var CKEYS = ['sun', 'zen', 'hor', 'grd', 'cl', 'cd', 'hemiS', 'hemiG', 'fog'];
  var NKEYS = ['si', 'sunSize', 'cloud', 'haze', 'star', 'moon', 'hi', 'fd', 'win', 'exp', 'bloom', 'fly', 'sunEl'];

  var tmpA = new THREE.Color(), tmpB = new THREE.Color();

  function sample(hour) {
    hour = ((hour % 24) + 24) % 24;
    var i = 0;
    while (i < KEYS.length - 2 && KEYS[i + 1].h <= hour) i++;
    var a = KEYS[i], b = KEYS[i + 1];
    var t = clamp((hour - a.h) / (b.h - a.h), 0, 1);
    t = t * t * (3 - 2 * t);
    var out = { hour: hour, blend: t };
    for (var c = 0; c < CKEYS.length; c++) {
      var k = CKEYS[c];
      tmpA.setHex(a[k]); tmpB.setHex(b[k]);
      out[k] = tmpA.clone().lerp(tmpB, t);
    }
    for (var n = 0; n < NKEYS.length; n++) {
      var kn = NKEYS[n];
      out[kn] = lerp(a[kn], b[kn], t);
    }
    /* sun direction from the hour */
    var dayT = clamp((hour - SUNRISE) / (SUNSET - SUNRISE), -0.12, 1.12);
    var az = lerp(-2.02, 0.62, clamp(dayT, 0, 1));
    var elMax = 1.02;
    var el;
    if (dayT < 0) el = out.sunEl * (0.6 + dayT * 2.0);
    else if (dayT > 1) el = out.sunEl * (0.6 - (dayT - 1) * 2.4);
    else el = Math.sin(Math.PI * dayT) * elMax;
    var ce = Math.cos(el);
    out.sunDir = new THREE.Vector3(Math.sin(az) * ce, Math.sin(el), Math.cos(az) * ce).normalize();
    /* moon sits opposite the sun and a bit higher */
    var maz = az + Math.PI, mel = clamp(0.55 - out.sunEl * 0.7, -0.2, 1.2);
    var mce = Math.cos(mel);
    out.moonDir = new THREE.Vector3(Math.sin(maz) * mce, Math.sin(mel), Math.cos(maz) * mce).normalize();
    return out;
  }

  function create(scene) {
    var sun = new THREE.DirectionalLight(0xffffff, 3);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    var S = 40;
    sun.shadow.camera.left = -S; sun.shadow.camera.right = S;
    sun.shadow.camera.top = S; sun.shadow.camera.bottom = -S;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 220;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.035;
    sun.target.position.set(0, 0.6, 2);
    scene.add(sun);
    scene.add(sun.target);

    var hemi = new THREE.HemisphereLight(0xffffff, 0x404030, 1);
    scene.add(hemi);

    /* cool fill from the opposite side so shadow sides never go black */
    var fill = new THREE.DirectionalLight(0x9fc0ff, 0.35);
    fill.position.set(-40, 22, -30);
    scene.add(fill);

    var state = sample(17.4);

    function apply(hour, scene2) {
      var p = sample(hour);
      state = p;
      sun.color.copy(p.sun);
      sun.intensity = p.si;
      sun.position.copy(p.sunDir).multiplyScalar(90).add(new THREE.Vector3(0, 0, 2));
      hemi.color.copy(p.hemiS);
      hemi.groundColor.copy(p.hemiG);
      hemi.intensity = p.hi;
      fill.color.copy(p.hemiS);
      fill.intensity = 0.12 + p.hi * 0.25;
      fill.position.copy(p.sunDir).multiplyScalar(-60).setY(30);
      if (scene2) {
        if (!scene2.fog) scene2.fog = new THREE.FogExp2(p.fog.getHex(), p.fd);
        else { scene2.fog.color.copy(p.fog); scene2.fog.density = p.fd; }
      }
      return p;
    }

    return { sun: sun, hemi: hemi, fill: fill, apply: apply, state: function () { return state; } };
  }

  FC.Lighting = { create: create, sample: sample };

})(window);