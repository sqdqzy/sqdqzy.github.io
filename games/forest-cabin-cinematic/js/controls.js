/* Forest Cabin - camera: cinematic shot list, orbit, first person walk */
(function (global) {
  'use strict';
  var FC = global.FC;
  var THREE = global.THREE;
  var U = FC.util, lerp = U.lerp, clamp = U.clamp, damp = U.damp;

  /* every shot is a framed composition, not a random orbit */
  var SHOTS = [
    { p: [14.5, 4.6, 21.0], t: [0.0, 2.3, 3.4], fov: 32, dur: 17, drift: [-1.6, -0.5, -2.6], shake: 1.0, name: 'establishing' },
    { p: [5.6, 1.85, 10.4], t: [0.0, 1.9, 4.6], fov: 30, dur: 13, drift: [-1.4, 0.05, -1.8], shake: 0.7, name: 'porch' },
    { p: [-27.0, 14.0, 25.0], t: [-0.5, 2.6, 2.0], fov: 46, dur: 15, drift: [3.0, -1.6, -3.0], shake: 1.2, name: 'wide grove' },
    { p: [-9.5, 1.25, 12.6], t: [0.6, 2.9, 1.6], fov: 34, dur: 12, drift: [2.2, 0.35, -1.6], shake: 0.9, name: 'low hero' },
    { p: [-1.0, 1.7, 19.5], t: [0.2, 2.2, 3.0], fov: 27, dur: 14, drift: [-0.6, 0.1, -2.4], shake: 0.8, name: 'across the pond' },
    { p: [12.4, 1.7, 11.2], t: [7.6, 1.0, 6.6], fov: 33, dur: 11, drift: [-1.8, 0.25, -1.5], shake: 0.6, name: 'fire pit' },
    { p: [27.0, 17.0, 31.0], t: [0.0, 3.0, 1.0], fov: 44, dur: 14, drift: [-5.0, -3.5, -5.0], shake: 1.4, name: 'crane' },
    { p: [-6.5, 2.2, -13.5], t: [-0.5, 2.8, 1.0], fov: 33, dur: 12, drift: [1.8, 0.1, 2.0], shake: 0.7, name: 'from the woods' },
    { p: [1.8, 1.55, 7.2], t: [-0.6, 1.75, 3.0], fov: 28, dur: 10, drift: [-0.9, 0.12, -1.1], shake: 0.5, name: 'doorway' },
    { p: [19.0, 6.2, -13.0], t: [1.0, 3.4, -1.0], fov: 40, dur: 13, drift: [-3.0, -1.0, 3.0], shake: 1.1, name: 'back corner' }
  ];

  function create(camera, dom, terrain, hooks) {
    hooks = hooks || {};
    var mode = 'cinematic';
    var t = 0, shotIndex = 0, shotT = 0, fade = 1, fadeTarget = 1;
    var cur = { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 35 };
    var goal = { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 35 };

    /* orbit state */
    var orbit = {
      target: new THREE.Vector3(0, 2.3, 3.0),
      radius: 22, theta: 0.6, phi: 1.18,
      gRadius: 22, gTheta: 0.6, gPhi: 1.18,
      gTarget: new THREE.Vector3(0, 2.3, 3.0)
    };
    /* walk state */
    var walk = {
      pos: new THREE.Vector3(6.5, 0, 12.0),
      yaw: -2.4, pitch: -0.05,
      gYaw: -2.4, gPitch: -0.05,
      vel: new THREE.Vector3(), bob: 0
    };
    var keys = {};
    var dragging = false, lastX = 0, lastY = 0, dragBtn = 0;
    var touchPrev = null;
    var trunks = [];          /* nearby trunk positions, keeps the lens out of the trees */

    function avoidTrees(p, pad) {
      for (var i = 0; i < trunks.length; i++) {
        var tr = trunks[i];
        if (p.y > tr[4] + 0.6) continue;                 /* camera is above the crown */
        var dx = p.x - tr[0], dz = p.z - tr[1];
        var d = Math.sqrt(dx * dx + dz * dz);
        var need = Math.max(tr[2] + pad, (tr[3] || tr[2]) + pad * 0.8);
        if (d < need) {
          if (d < 0.0001) { dx = 1; dz = 0; d = 1; }
          p.x = tr[0] + (dx / d) * need;
          p.z = tr[1] + (dz / d) * need;
        }
      }
    }

    var POND = FC.World.POND;

    function blocked(x, z) {
      if (x * x + z * z < 100) return true;                       /* cabin footprint */
      var dx = x - POND.x, dz = z - POND.z;
      if (dx * dx + dz * dz < (POND.r - 0.6) * (POND.r - 0.6)) return true;  /* no swimming */
      return false;
    }

    function setMode(m) {
      if (m === mode) return;
      if (mode === 'walk' && document.pointerLockElement) document.exitPointerLock();
      mode = m;
      if (m === 'orbit') {
        /* start the orbit where the cinematic camera left off */
        var d = new THREE.Vector3().subVectors(camera.position, orbit.gTarget);
        orbit.radius = orbit.gRadius = clamp(d.length(), 4, 90);
        orbit.theta = orbit.gTheta = Math.atan2(d.x, d.z);
        orbit.phi = orbit.gPhi = clamp(Math.acos(clamp(d.y / Math.max(0.001, d.length()), -1, 1)), 0.12, Math.PI - 0.12);
      }
      if (m === 'walk') {
        walk.pos.copy(camera.position);
        walk.pos.y = terrain.heightAt(walk.pos.x, walk.pos.z) + 1.66;
        var dir = new THREE.Vector3();
        camera.getWorldDirection(dir);
        walk.gYaw = Math.atan2(-dir.x, -dir.z);
        walk.gPitch = clamp(Math.asin(clamp(dir.y, -1, 1)), -1.1, 0.9);
        walk.yaw = walk.gYaw; walk.pitch = walk.gPitch;
      }
      if (hooks.onMode) hooks.onMode(m);
    }

    /* ---------------- input ---------------- */
    function onDown(e) {
      dragging = true;
      dragBtn = e.button || 0;
      lastX = e.clientX; lastY = e.clientY;
      if (mode === 'walk' && !document.pointerLockElement && dom.requestPointerLock) {
        dom.requestPointerLock();
      }
      dom.setPointerCapture && e.pointerId !== undefined && dom.setPointerCapture(e.pointerId);
    }
    function onMove(e) {
      if (mode === 'walk' && document.pointerLockElement === dom) {
        walk.gYaw -= e.movementX * 0.0022;
        walk.gPitch = clamp(walk.gPitch - e.movementY * 0.0022, -1.15, 0.95);
        return;
      }
      if (!dragging) return;
      var dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      if (mode === 'orbit') {
        if (dragBtn === 2 || e.shiftKey) {
          var right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
          var up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
          var k = orbit.radius * 0.0016;
          orbit.gTarget.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
        } else {
          orbit.gTheta -= dx * 0.005;
          orbit.gPhi = clamp(orbit.gPhi - dy * 0.005, 0.1, Math.PI - 0.1);
        }
      } else if (mode === 'cinematic') {
        /* let the viewer nudge the shot a little */
        shotT = Math.min(shotT, SHOTS[shotIndex].dur * 0.5);
      }
    }
    function onUp(e) {
      dragging = false;
      try { dom.releasePointerCapture(e.pointerId); } catch (err) { }
    }
    function onWheel(e) {
      if (mode !== 'orbit') return;
      e.preventDefault();
      orbit.gRadius = clamp(orbit.gRadius * (1 + Math.sign(e.deltaY) * 0.12), 3.5, 95);
    }
    function onTouch(e) {
      if (e.touches.length === 1) {
        touchPrev = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      } else if (e.touches.length === 2) {
        var dx = e.touches[0].clientX - e.touches[1].clientX;
        var dy = e.touches[0].clientY - e.touches[1].clientY;
        touchPrev = { x: 0, y: 0, dist: Math.sqrt(dx * dx + dy * dy) };
      }
    }
    function onTouchMove(e) {
      if (!touchPrev || mode !== 'orbit') return;
      if (e.touches.length === 1) {
        var dx = e.touches[0].clientX - touchPrev.x;
        var dy = e.touches[0].clientY - touchPrev.y;
        orbit.gTheta -= dx * 0.006;
        orbit.gPhi = clamp(orbit.gPhi - dy * 0.006, 0.1, Math.PI - 0.1);
        touchPrev.x = e.touches[0].clientX; touchPrev.y = e.touches[0].clientY;
      } else if (e.touches.length === 2) {
        var ax = e.touches[0].clientX - e.touches[1].clientX;
        var ay = e.touches[0].clientY - e.touches[1].clientY;
        var dist = Math.sqrt(ax * ax + ay * ay);
        if (touchPrev.dist) orbit.gRadius = clamp(orbit.gRadius * (touchPrev.dist / dist), 3.5, 95);
        touchPrev.dist = dist;
      }
      e.preventDefault();
    }
    function onKey(e, down) {
      var k = e.key.toLowerCase();
      keys[k] = down;
      if (!down) return;
      if (k === '1') setMode('cinematic');
      if (k === '2') setMode('orbit');
      if (k === '3') setMode('walk');
    }

    dom.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    dom.addEventListener('wheel', onWheel, { passive: false });
    dom.addEventListener('touchstart', onTouch, { passive: true });
    dom.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('keydown', function (e) { onKey(e, true); });
    window.addEventListener('keyup', function (e) { onKey(e, false); });
    dom.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    /* ---------------- cinematic ---------------- */
    function loadShot(i, instant) {
      shotIndex = i % SHOTS.length;
      var s = SHOTS[shotIndex];
      goal.pos.set(s.p[0], s.p[1], s.p[2]);
      goal.target.set(s.t[0], s.t[1], s.t[2]);
      goal.fov = s.fov;
      shotT = instant ? s.dur : 0;
      if (instant) {
        cur.pos.copy(goal.pos); cur.target.copy(goal.target); cur.fov = s.fov;
        shotT = 0;
      }
      if (hooks.onShot) hooks.onShot(s);
    }
    loadShot(0, true);

    function updateCinematic(dt) {
      var s = SHOTS[shotIndex];
      shotT += dt;
      var k = clamp(shotT / s.dur, 0, 1);
      var e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;   /* ease in out */
      cur.pos.set(
        s.p[0] + s.drift[0] * e,
        s.p[1] + s.drift[1] * e,
        s.p[2] + s.drift[2] * e
      );
      cur.target.set(s.t[0], s.t[1], s.t[2]);
      cur.fov = s.fov;
      /* handheld noise */
      var sh = (s.shake || 1) * 0.055;
      var tt = t;
      cur.pos.x += Math.sin(tt * 0.83) * sh + Math.sin(tt * 1.97) * sh * 0.4;
      cur.pos.y += Math.sin(tt * 1.31 + 1.7) * sh * 0.7 + Math.sin(tt * 2.6) * sh * 0.25;
      cur.pos.z += Math.sin(tt * 0.61 + 3.1) * sh;
      cur.target.x += Math.sin(tt * 0.47 + 2.2) * sh * 0.6;
      cur.target.y += Math.sin(tt * 0.71) * sh * 0.5;
      /* keep the lens above the ground and clear of the trunks */
      avoidTrees(cur.pos, 0.85);
      var gy = terrain.heightAt(cur.pos.x, cur.pos.z) + 1.15;
      if (cur.pos.y < gy) cur.pos.y = gy;
      camera.position.copy(cur.pos);
      camera.lookAt(cur.target);
      if (Math.abs(camera.fov - cur.fov) > 0.01) {
        camera.fov = damp(camera.fov, cur.fov, 2, dt);
        camera.updateProjectionMatrix();
      }
      /* cut to the next shot with a quick dip to black */
      if (shotT > s.dur) {
        if (fade > 0.55) {
          fadeTarget = 0;
          setTimeout(function () { loadShot(pickNext()); fadeTarget = 1; }, 260);
          shotT = -0.55;
        }
      }
    }
    function pickNext() {
      var i = shotIndex;
      while (i === shotIndex) i = Math.floor(Math.random() * SHOTS.length);
      return i;
    }

    /* ---------------- orbit ---------------- */
    function updateOrbit(dt) {
      orbit.theta = damp(orbit.theta, orbit.gTheta, 7, dt);
      orbit.phi = damp(orbit.phi, orbit.gPhi, 7, dt);
      orbit.radius = damp(orbit.radius, orbit.gRadius, 7, dt);
      orbit.target.lerp(orbit.gTarget, 1 - Math.exp(-7 * dt));
      var sp = Math.sin(orbit.phi);
      camera.position.set(
        orbit.target.x + orbit.radius * sp * Math.sin(orbit.theta),
        orbit.target.y + orbit.radius * Math.cos(orbit.phi),
        orbit.target.z + orbit.radius * sp * Math.cos(orbit.theta)
      );
      /* never dip under the ground */
      var minY = terrain.heightAt(camera.position.x, camera.position.z) + 0.6;
      if (camera.position.y < minY) camera.position.y = minY;
      avoidTrees(camera.position, 0.7);
      camera.lookAt(orbit.target);
      if (Math.abs(camera.fov - 40) > 0.01) {
        camera.fov = damp(camera.fov, 40, 4, dt);
        camera.updateProjectionMatrix();
      }
    }

    /* ---------------- walk ---------------- */
    function updateWalk(dt) {
      var speed = keys['shift'] ? 4.6 : 2.1;
      var f = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), walk.yaw);
      var r = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), walk.yaw);
      var move = new THREE.Vector3();
      if (keys['w'] || keys['arrowup']) move.add(f);
      if (keys['s'] || keys['arrowdown']) move.sub(f);
      if (keys['a'] || keys['arrowleft']) move.sub(r);
      if (keys['d'] || keys['arrowright']) move.add(r);
      if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed);
      walk.vel.lerp(move, 1 - Math.exp(-9 * dt));
      var nx = walk.pos.x + walk.vel.x * dt;
      var nz = walk.pos.z + walk.vel.z * dt;
      if (!blocked(nx, walk.pos.z)) walk.pos.x = nx; else walk.vel.x = 0;
      if (!blocked(walk.pos.x, nz)) walk.pos.z = nz; else walk.vel.z = 0;
      var rad = Math.sqrt(walk.pos.x * walk.pos.x + walk.pos.z * walk.pos.z);
      if (rad > 86) { walk.pos.x *= 86 / rad; walk.pos.z *= 86 / rad; }
      walk.yaw = damp(walk.yaw, walk.gYaw, 16, dt);
      walk.pitch = damp(walk.pitch, walk.gPitch, 16, dt);
      var moving = walk.vel.length();
      walk.bob += dt * moving * 3.1;
      var ground = terrain.heightAt(walk.pos.x, walk.pos.z);
      walk.pos.y = damp(walk.pos.y, ground + 1.66 + Math.sin(walk.bob) * 0.035 * moving * 0.2, 12, dt);
      camera.position.copy(walk.pos);
      var look = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(walk.pitch, walk.yaw, 0, 'YXZ'));
      camera.lookAt(new THREE.Vector3().copy(camera.position).add(look));
      if (Math.abs(camera.fov - 58) > 0.01) {
        camera.fov = damp(camera.fov, 58, 4, dt);
        camera.updateProjectionMatrix();
      }
    }

    return {
      setMode: setMode,
      getMode: function () { return mode; },
      setTrunks: function (list) { trunks = list; },
      setView: function (ex, ey, ez, tx, ty, tz, fov) {
        setMode('orbit');
        var dx = ex - tx, dy = ey - ty, dz = ez - tz;
        var r = Math.sqrt(dx * dx + dy * dy + dz * dz);
        orbit.gTarget.set(tx, ty, tz); orbit.target.set(tx, ty, tz);
        orbit.gRadius = orbit.radius = r;
        orbit.gTheta = orbit.theta = Math.atan2(dx, dz);
        orbit.gPhi = orbit.phi = clamp(Math.acos(clamp(dy / Math.max(0.001, r), -1, 1)), 0.08, Math.PI - 0.08);
        if (fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
      },
      nextShot: function () { loadShot(pickNext()); },
      update: function (dt) {
        t += dt;
        fade = damp(fade, fadeTarget, 9, dt);
        if (hooks.onFade) hooks.onFade(fade);
        if (mode === 'cinematic') updateCinematic(dt);
        else if (mode === 'orbit') updateOrbit(dt);
        else updateWalk(dt);
      },
      shots: SHOTS
    };
  }

  FC.Controls = { create: create, SHOTS: SHOTS };

})(window);