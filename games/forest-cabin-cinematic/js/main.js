/* Forest Cabin - bootstrap, quality management, ui wiring, main loop */
(function () {
  'use strict';
  var FC = window.FC, THREE = window.THREE;
  var U = FC.util, clamp = U.clamp, lerp = U.lerp, damp = U.damp;

  function $(s) { return document.querySelector(s); }
  function showError(msg) {
    $('#error').classList.remove('hidden');
    $('#error-msg').textContent = msg;
    $('#loader').classList.add('gone');
  }
  window.addEventListener('error', function (e) {
    if (!$('#error').classList.contains('hidden')) return;
    showError((e.message || 'unknown') + '\n' + (e.filename || '') + ':' + (e.lineno || ''));
  });

  if (!THREE) {
    showError('无法加载 three.js。\n请检查 vendor/three.min.js 是否存在，或联网后重试。');
    return;
  }
  if (THREE.ColorManagement) THREE.ColorManagement.legacyMode = false;

  /* ---------------- quality ---------------- */
  var PRESETS = {
    low: { pr: 0.7, msaa: 0, terrainSeg: 110, shadow: 1024, conifers: 160, birch: 40, bushes: 90, tufts: 2400, ferns: 90, clumps: 260, flowers: 110, fireflies: 110, motes: 140, smoke: 30, embers: 22, shafts: 5, mist: 4, birds: 4, farTrees: 70 },
    medium: { pr: 1.0, msaa: 0, terrainSeg: 150, shadow: 1536, conifers: 290, birch: 75, bushes: 170, tufts: 6000, ferns: 220, clumps: 650, flowers: 200, fireflies: 200, motes: 240, smoke: 46, embers: 34, shafts: 8, mist: 6, birds: 6, farTrees: 110 },
    high: { pr: 1.3, msaa: 4, terrainSeg: 190, shadow: 2048, conifers: 450, birch: 115, bushes: 260, tufts: 11000, ferns: 280, clumps: 1150, flowers: 300, fireflies: 320, motes: 360, smoke: 60, embers: 50, shafts: 11, mist: 8, birds: 8, farTrees: 160 },
    ultra: { pr: 1.8, msaa: 4, terrainSeg: 240, shadow: 4096, conifers: 640, birch: 165, bushes: 380, tufts: 11000, ferns: 520, clumps: 1750, flowers: 400, fireflies: 440, motes: 500, smoke: 78, embers: 66, shafts: 15, mist: 10, birds: 10, farTrees: 210 }
  };

  var canvas = $('#view');
  var renderer, scene, camera, sky, lighting, terrain, veg, cabin, props, atmos, post, controls, audio;
  var tex, Q = PRESETS.high, qualityName = 'high', autoQuality = true, forcedQuality = null;
  try { forcedQuality = sessionStorage.getItem('fcQuality'); } catch (e) { }
  var hour = 18.3, targetHour = 18.3, nightK = 0.5;
  var userExposure = 1.0, bloomBase = 1.0, fogUser = 1.0, shaftUser = 1.0;
  var userBloom = 0.55;
  var renderScale = 1, paused = false, uiHidden = false, barsTarget = 0.055;
  var time = 0, last = 0, fpsAcc = 0, fpsCount = 0, fpsShown = 0, frameSamples = [];
  var envDirty = false, lastEnv = 0, lastHourApplied = -1;
  var firstFrameDone = false;

  /* ---------------- boot ---------------- */
  var steps = [
    ['唤醒显卡 · 创建渲染器', function () {
      renderer = new THREE.WebGLRenderer({
        canvas: canvas, antialias: false, stencil: false, alpha: false,
        powerPreference: 'high-performance'
      });
      renderer.outputEncoding = THREE.LinearEncoding;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.setClearColor(0x0a0c0e, 1);
      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.08, 2400);
      camera.position.set(14.5, 4.6, 21.0);
      detectQuality();
      applyResolution();
    }],
    ['编织树皮、木纹与苔痕', function () { tex = FC.tex.get(); }],
    ['堆起山坡、溪潭与林径', function () { terrain = FC.Terrain.create(scene, tex, Q); }],
    ['种下松林、白桦与野草', function () { veg = FC.Vegetation.create(scene, tex, terrain, Q); }],
    ['搭建原木小屋与门廊', function () { cabin = FC.Cabin.create(scene, tex, terrain, Q); }],
    ['摆放木柴、菜园与篝火', function () { props = FC.Props.create(scene, tex, terrain, Q); }],
    ['点亮炊烟、流萤与光束', function () { atmos = FC.Atmosphere.create(scene, tex, terrain, cabin, props, Q); }],
    ['调校天光、星空与雾气', function () {
      sky = FC.Sky.create();
      scene.add(sky.mesh);
      lighting = FC.Lighting.create(scene);
      lighting.sun.shadow.mapSize.set(shadowSize, shadowSize);
      lighting.shaftColor = new THREE.Color(0xffe2b0);
      lighting.shaftStrength = 1;
      lighting.mistAmount = 0;
      setHour(hour, true);
      refreshEnv();
    }],
    ['架设电影镜头与调色台', function () {
      post = FC.Post.create(renderer, Q);
      post.setSize(renderer.domElement.width, renderer.domElement.height);
      controls = FC.Controls.create(camera, canvas, terrain, {
        onFade: function (f) { post.uniforms.uFade.value = f; },
        onShot: function (s) {
          $('#shotname').textContent = s.name;
          $('#v-shot').textContent = s.name;
        },
        onMode: function (m) {
          var names = { cinematic: '电影运镜', orbit: '自由环绕', walk: '林间漫步' };
          $('#modename').textContent = names[m];
          Array.prototype.forEach.call(document.querySelectorAll('#c-mode button'), function (b) {
            b.classList.toggle('on', b.dataset.mode === m);
          });
          barsTarget = m === 'cinematic' ? 0.055 : 0;
        }
      });
      audio = FC.Audio.create();
      controls.setTrunks(veg.trunks);
    }],
    ['预热着色器', function () {
      setHour(hour, true);
      refreshEnv();
      renderer.compile(scene, camera);
      resize();
    }]
  ];

  function detectQuality() {
    var name = 'high';
    try {
      var gl = renderer.getContext();
      var dbg = gl.getExtension('WEBGL_debug_renderer_info');
      var r = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
      if (/swiftshader|llvmpipe|software|basic\s*render|microsoft basic/i.test(r)) name = 'low';
      else if (/intel|uhd graphics (5|6)\d\d|hd graphics \d{3}/i.test(r)) name = 'medium';
      else if (/apple|nvidia|radeon|geforce|rtx|gtx|arc/i.test(r)) name = 'high';
    } catch (e) { }
    var mem = navigator.deviceMemory || (window.innerWidth * window.innerHeight > 2600000 ? 8 : 4);
    if (mem <= 2) name = 'low';
    else if (mem <= 4 && name === 'high') name = 'medium';
    var mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (mobile) name = name === 'ultra' ? 'high' : (name === 'high' ? 'medium' : name);
    if (forcedQuality && PRESETS[forcedQuality]) name = forcedQuality;
    qualityName = name;
    Q = PRESETS[name];
    shadowSize = Q.shadow;
  }

  var shadowSize = 2048;

  function applyResolution() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2) * Q.pr * renderScale;
    renderer.setPixelRatio(1);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    var w = Math.max(320, Math.floor(window.innerWidth * dpr));
    var h = Math.max(240, Math.floor(window.innerHeight * dpr));
    renderer.setSize(w, h, false);
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    if (post) post.setSize(w, h);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }

  function refreshEnv() {
    if (!sky) return;
    var t = sky.refreshEnv(renderer);
    scene.environment = t;
    envDirty = false;
    lastEnv = performance.now();
  }

  function setHour(h, force) {
    hour = ((h % 24) + 24) % 24;
    if (!force && Math.abs(hour - lastHourApplied) < 0.004) return;
    lastHourApplied = hour;
    var p = lighting.apply(hour, scene);
    var u = sky.uniforms;
    u.uSunDir.value.copy(p.sunDir);
    u.uSunColor.value.copy(p.sun);
    u.uZenith.value.copy(p.zen);
    u.uHorizon.value.copy(p.hor);
    u.uGround.value.copy(p.grd);
    u.uCloudLit.value.copy(p.cl);
    u.uCloudDark.value.copy(p.cd);
    u.uMoonDir.value.copy(p.moonDir);
    u.uSunSize.value = p.sunSize;
    u.uSunIntensity.value = 7 + p.si * 4.5;
    u.uCloud.value = p.cloud;
    u.uHaze.value = p.haze;
    u.uStar.value = p.star;
    u.uMoon.value = p.moon;
    u.uNight.value = p.star;
    scene.fog.color.copy(p.fog);
    scene.fog.density = p.fd * fogUser;
    nightK = p.win;
    cabin.setNight(p.win);
    bloomBase = p.bloom;
    lighting.shaftStrength = clamp(1 - Math.abs(p.sunEl - 0.24) / 0.5, 0, 1) * shaftUser * (1 - p.star);
    lighting.shaftColor.copy(p.sun).lerp(new THREE.Color(0xffffff), 0.35);
    lighting.mistAmount = clamp(1 - Math.abs(p.sunEl - 0.08) / 0.42, 0, 1) * (1 - p.star * 0.6);
    atmos.setShafts(shaftUser);
    envDirty = true;
    var hh = Math.floor(hour), mm = Math.floor((hour - hh) * 60);
    $('#v-hour').textContent = (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
  }

  /* ---------------- ui ---------------- */
  function bindUI() {
    $('#c-hour').addEventListener('input', function () {
      targetHour = parseFloat(this.value);
      hour = targetHour;
      setHour(hour, true);
    });

    Array.prototype.forEach.call(document.querySelectorAll('#c-mode button'), function (b) {
      b.addEventListener('click', function () { controls.setMode(b.dataset.mode); });
    });
    $('#c-shot').addEventListener('click', function () { controls.nextShot(); });

    Array.prototype.forEach.call(document.querySelectorAll('#c-quality button'), function (b) {
      b.addEventListener('click', function () {
        autoQuality = false;
        rebuildQuality(b.dataset.q);
        Array.prototype.forEach.call(document.querySelectorAll('#c-quality button'), function (x) {
          x.classList.toggle('on', x === b);
        });
        $('#v-quality').textContent = { low: '低', medium: '中', high: '高', ultra: '极致' }[b.dataset.q];
      });
    });

    function slider(id, label, fn, fmt) {
      var el = $(id), out = $(label);
      el.addEventListener('input', function () {
        var v = parseFloat(this.value);
        fn(v);
        out.textContent = fmt ? fmt(v) : v.toFixed(2);
      });
      return el;
    }
    slider('#c-exposure', '#v-exposure', function (v) { userExposure = v; });
    slider('#c-bloom', '#v-bloom', function (v) { userBloom = v; });
    slider('#c-grain', '#v-grain', function (v) { post.uniforms.uGrain.value = v; });
    slider('#c-vig', '#v-vig', function (v) { post.uniforms.uVignette.value = v; });
    slider('#c-fog', '#v-fog', function (v) { fogUser = v; setHour(hour, true); });
    slider('#c-shafts', '#v-shafts', function (v) { shaftUser = v; setHour(hour, true); });
    slider('#c-sat', '#v-sat', function (v) { post.uniforms.uSat.value = v; });
    slider('#c-vol', '#v-vol', function (v) {
      audio.setVolume(v);
      $('#v-vol').textContent = Math.round(v * 100) + '%';
    });

    $('#c-sound').addEventListener('click', function () {
      if (audio.isOn()) { audio.stop(); this.classList.remove('on'); this.innerHTML = '开启声音 &nbsp;·&nbsp; 浏览器需要点击授权'; }
      else { audio.start(); this.classList.add('on'); this.innerHTML = '关闭环境音'; $('#soundhint').classList.add('hidden'); }
    });

    $('#panel-toggle').addEventListener('click', function () {
      $('#panel').classList.toggle('collapsed');
    });

    canvas.addEventListener('click', function () {
      if (!audio.isOn()) {
        audio.start();
        $('#c-sound').classList.add('on');
        $('#c-sound').innerHTML = '关闭环境音';
        $('#soundhint').classList.add('hidden');
      }
    });

    window.addEventListener('keydown', function (e) {
      var k = e.key.toLowerCase();
      if (k === 'h') { uiHidden = !uiHidden; $('#hud').classList.toggle('ui-hidden', uiHidden); }
      if (k === 'f') {
        if (!document.fullscreenElement) document.documentElement.requestFullscreen();
        else document.exitFullscreen();
      }
      if (k === ' ') { paused = !paused; e.preventDefault(); }
      if (k === 'n') controls.nextShot();
      if (k === '[') { targetHour = hour - 0.35; setHour(hour - 0.35, true); }
      if (k === ']') { targetHour = hour + 0.35; setHour(hour + 0.35, true); }
    });

    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) paused = true;
    });
  }

  

  function resize() { applyResolution(); }

  function rebuildQuality(name) {
    if (!PRESETS[name]) return;
    try { sessionStorage.setItem('fcQuality', name); } catch (e) { }
    location.reload();
  }

  /* ---------------- loop ---------------- */
  function frame(now) {
    requestAnimationFrame(frame);
    var dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
    last = now;
    if (document.hidden) return;
    if (paused) dt = 0;
    time += dt;

    /* adaptive resolution */
    if (autoQuality && dt > 0) {
      frameSamples.push(dt);
      if (frameSamples.length > 90) {
        var sum = 0;
        for (var i = 0; i < frameSamples.length; i++) sum += frameSamples[i];
        var avg = sum / frameSamples.length;
        frameSamples.length = 0;
        if (avg > 0.028 && renderScale > 0.55) { renderScale = Math.max(0.55, renderScale - 0.12); applyResolution(); }
        else if (avg < 0.0155 && renderScale < 1) { renderScale = Math.min(1, renderScale + 0.08); applyResolution(); }
      }
    }

    if (envDirty && performance.now() - lastEnv > 320) refreshEnv();

    controls.update(dt);
    veg.update(time);
    var st = lighting.state();
    var fireK = 0.35 + nightK * 0.65;
    props.update(time, dt, nightK);
    atmos.update(dt, camera, lighting, nightK, fireK);
    terrain.waterTime.value = time;
    sky.uniforms.uTime.value = time;

    /* post uniforms that follow the light */
    post.uniforms.uExposure.value = userExposure * st.exp;
    post.uniforms.uBloom.value = userBloom * bloomBase;
    post.uniforms.uBars.value = damp(post.uniforms.uBars.value, barsTarget, 4, dt);
    post.uniforms.uContrast.value = lerp(1.02, 1.09, nightK);

    /* fire audio proximity */
    var fd = camera.position.distanceTo(props.firepit);
    var fireNear = clamp(1 - (fd - 2) / 9, 0, 1) * (0.35 + fireK * 0.65);
    audio.update(dt, nightK, fireNear);

    post.render(scene, camera, dt);

    /* stats */
    fpsAcc += dt; fpsCount++;
    if (fpsAcc > 0.5) {
      fpsShown = Math.round(fpsCount / fpsAcc);
      $('#fps').textContent = fpsShown + ' fps';
      $('#stats').innerHTML =
        '画质 ' + qualityName + ' · 缩放 ' + (Q.pr * renderScale).toFixed(2) + 'x<br>' +
        'draw ' + renderer.info.render.calls + ' · 三角 ' + (renderer.info.render.triangles / 1000).toFixed(0) + 'k' +
        ' · 贴图 ' + renderer.info.memory.textures;
      fpsAcc = 0; fpsCount = 0;
    }

    if (!firstFrameDone) {
      firstFrameDone = true;
      setTimeout(function () {
        $('#loader').classList.add('gone');
        $('#soundhint').classList.remove('hidden');
        setTimeout(function () { $('#soundhint').classList.add('hidden'); }, 9000);
      }, 420);
    }
  }

  /* ---------------- go ---------------- */
  function frameBreak() { return new Promise(function (r) { requestAnimationFrame(function () { setTimeout(r, 0); }); }); }

  (async function boot() {
    try {
      for (var i = 0; i < steps.length; i++) {
        $('#l-status').textContent = steps[i][0];
        $('#l-fill').style.width = Math.round((i / steps.length) * 100) + '%';
        await frameBreak();
        steps[i][1]();
      }
      $('#l-fill').style.width = '100%';
      bindUI();
      $('#v-quality').textContent = (autoQuality ? '自动 · ' : '') + { low: '低', medium: '中', high: '高', ultra: '极致' }[qualityName];
      Array.prototype.forEach.call(document.querySelectorAll('#c-quality button'), function (x) {
        x.classList.toggle('on', !autoQuality && x.dataset.q === qualityName);
      });
      requestAnimationFrame(frame);

      /* small debug handle, handy from the console */
      window.FCDEBUG = {
        scene: scene, camera: camera, renderer: renderer,
        post: post, controls: controls, lighting: lighting, sky: sky,
        terrain: terrain, cabin: cabin, props: props, veg: veg, atmos: atmos,
        setHour: setHour, setMode: function (m) { controls.setMode(m); },
        setView: function (a) { controls.setView.apply(null, a); },
        setUi: function (on) { $('#hud').classList.toggle('ui-hidden', !on); }
      };
    } catch (e) {
      showError('初始化失败：\n' + (e && e.stack ? e.stack : e));
    }
  })();

})();