/* Forest Cabin - fully synthesised ambience: wind, birds, crickets, fire */
(function (global) {
  'use strict';
  var FC = global.FC;

  function create() {
    var ctx = null, master = null, started = false;
    var nodes = {};
    var enabled = false, volume = 0.6;
    var nextBird = 0, nextCricket = 0, nextCrackle = 0, nextGust = 0;
    var time = 0;

    function noiseBuffer(seconds) {
      var len = Math.floor(ctx.sampleRate * seconds);
      var buf = ctx.createBuffer(1, len, ctx.sampleRate);
      var d = buf.getChannelData(0);
      var b0 = 0, b1 = 0, b2 = 0;
      for (var i = 0; i < len; i++) {
        var w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.0990460;
        b1 = 0.96300 * b1 + w * 0.2965164;
        b2 = 0.57000 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
      }
      return buf;
    }

    function start() {
      if (started) return;
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0;
      master.connect(ctx.destination);
      var nb = noiseBuffer(6);

      /* wind through the canopy */
      var windSrc = ctx.createBufferSource();
      windSrc.buffer = nb; windSrc.loop = true;
      var windFilt = ctx.createBiquadFilter();
      windFilt.type = 'bandpass'; windFilt.frequency.value = 420; windFilt.Q.value = 0.6;
      var windGain = ctx.createGain(); windGain.gain.value = 0.10;
      windSrc.connect(windFilt); windFilt.connect(windGain); windGain.connect(master);
      windSrc.start();
      nodes.windSrc = windSrc; nodes.windFilt = windFilt; nodes.windGain = windGain;

      /* high rustle of leaves */
      var leafSrc = ctx.createBufferSource();
      leafSrc.buffer = nb; leafSrc.loop = true; leafSrc.playbackRate.value = 1.7;
      var leafFilt = ctx.createBiquadFilter();
      leafFilt.type = 'highpass'; leafFilt.frequency.value = 2600;
      var leafGain = ctx.createGain(); leafGain.gain.value = 0.045;
      leafSrc.connect(leafFilt); leafFilt.connect(leafGain); leafGain.connect(master);
      leafSrc.start();
      nodes.leafFilt = leafFilt; nodes.leafGain = leafGain;

      /* low forest hum */
      var humOsc = ctx.createOscillator();
      humOsc.type = 'sine'; humOsc.frequency.value = 68;
      var humGain = ctx.createGain(); humGain.gain.value = 0.012;
      humOsc.connect(humGain); humGain.connect(master);
      humOsc.start();
      nodes.humGain = humGain;

      started = true;
      nextBird = time + 1;
      nextCricket = time + 2;
      nextCrackle = time + 1;
    }

    function env(node, t0, a, peak, d) {
      node.gain.setValueAtTime(0.0001, t0);
      node.gain.linearRampToValueAtTime(peak, t0 + a);
      node.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
    }

    function chirp(t0, f0, f1, dur, peak, pan) {
      var o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f0, t0);
      o.frequency.exponentialRampToValueAtTime(Math.max(60, f1), t0 + dur);
      var g = ctx.createGain();
      var p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      env(g, t0, dur * 0.22, peak, dur * 0.9);
      o.connect(g);
      if (p) { p.pan.value = pan; g.connect(p); p.connect(master); }
      else g.connect(master);
      o.start(t0); o.stop(t0 + dur * 1.3);
    }

    function birdCall(nightK) {
      var t0 = ctx.currentTime + 0.02;
      var pan = Math.random() * 1.6 - 0.8;
      var base = 1700 + Math.random() * 1900;
      var kind = Math.floor(Math.random() * 3);
      var notes = kind === 0 ? 3 + Math.floor(Math.random() * 3) : 2;
      for (var i = 0; i < notes; i++) {
        var t = t0 + i * (0.07 + Math.random() * 0.07);
        if (kind === 0) chirp(t, base * (0.8 + Math.random() * 0.1), base * (1.25 + Math.random() * 0.25), 0.07, 0.045 * (1 - nightK * 0.7), pan);
        else if (kind === 1) chirp(t, base * 1.1, base * 0.65, 0.16, 0.035 * (1 - nightK * 0.7), pan);
        else chirp(t, base * 0.9, base * 1.5, 0.05, 0.05 * (1 - nightK * 0.7), pan);
      }
    }

    function cricket() {
      var t0 = ctx.currentTime + 0.02;
      var pan = Math.random() * 1.8 - 0.9;
      var f = 4200 + Math.random() * 900;
      var p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      var g = ctx.createGain();
      g.gain.value = 0.0001;
      g.connect(master);
      if (p) { p.pan.value = pan; g.disconnect(); g.connect(p); p.connect(master); }
      var o = ctx.createOscillator();
      o.type = 'square'; o.frequency.value = f;
      var filt = ctx.createBiquadFilter();
      filt.type = 'bandpass'; filt.frequency.value = f; filt.Q.value = 14;
      o.connect(filt); filt.connect(g);
      var pulses = 4 + Math.floor(Math.random() * 4);
      for (var i = 0; i < pulses; i++) {
        var t = t0 + i * 0.055;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.012, t + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
      }
      o.start(t0); o.stop(t0 + pulses * 0.06 + 0.1);
    }

    function crackle(peak) {
      var t0 = ctx.currentTime + Math.random() * 0.1;
      var o = ctx.createBufferSource();
      o.buffer = nodes.windSrc.buffer;
      o.loop = false;
      var f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 900 + Math.random() * 2600; f.Q.value = 3;
      var g = ctx.createGain();
      env(g, t0, 0.004, 0.09 * peak, 0.09 + Math.random() * 0.2);
      o.connect(f); f.connect(g); g.connect(master);
      o.start(t0, Math.random() * 4, 0.4);
    }

    return {
      start: function () {
        start();
        if (ctx && ctx.state === 'suspended') ctx.resume();
        enabled = true;
        if (master) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.6);
      },
      stop: function () {
        enabled = false;
        if (master) master.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
      },
      setVolume: function (v) {
        volume = v;
        if (master && enabled) master.gain.setTargetAtTime(v, ctx.currentTime, 0.2);
      },
      isOn: function () { return enabled; },
      update: function (dt, nightK, fireNear) {
        if (!started || !enabled) { time += dt; return; }
        time += dt;
        var now = ctx.currentTime;
        /* wind breathing */
        var w = 0.5 + 0.5 * Math.sin(time * 0.11) * Math.sin(time * 0.037 + 1.3);
        nodes.windGain.gain.setTargetAtTime(0.055 + w * 0.085, now, 0.4);
        nodes.windFilt.frequency.setTargetAtTime(320 + w * 520, now, 0.6);
        nodes.leafGain.gain.setTargetAtTime(0.02 + w * 0.05, now, 0.5);
        nodes.humGain.gain.setTargetAtTime(0.008 + nightK * 0.01, now, 1.0);

        if (time > nextBird) {
          birdCall(nightK);
          nextBird = time + 0.7 + Math.random() * (nightK > 0.6 ? 9 : 3.2);
        }
        if (time > nextCricket && nightK > 0.25) {
          cricket();
          nextCricket = time + 0.8 + Math.random() * 2.4;
        }
        if (time > nextCrackle && fireNear > 0.02) {
          crackle(fireNear);
          nextCrackle = time + 0.12 + Math.random() * 0.9 / Math.max(0.15, fireNear);
        }
      }
    };
  }

  FC.Audio = { create: create };

})(window);