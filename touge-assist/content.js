/* 部長と峠 操作アシスト
   キー・ゲームパッド・マウスの入力を、ゲームが受け付ける「指のなぞり」に変換する。
   ゲームの仕様：横にずらした量＝ハンドルの切れ角（画面幅の17%で全開）、
   下にずらした量＝ブレーキの強さ（画面高さの9%で全開）。 */
(() => {
  'use strict';
  if (!/^\/touge\/?$/.test(location.pathname)) return;

  const DEFAULTS = {
    kbOn: true,
    kbRise: 0.35,       // キーを押し続けて全開になるまでの秒数
    kbFall: 0.12,       // キーを離してまっすぐに戻る秒数
    kbFine: 0.45,       // Shift を押している間の最大の切れ角
    kbBrakeRise: 0.3,   // ブレーキが全開になるまでの秒数
    padOn: true,
    padDead: 0.12,
    padCurve: 1.6,      // 大きいほど、スティックの中央付近が細かく効く
    mouseOn: false,
    mouseRange: 0.22,   // 画面幅の何割ぶんマウスを動かすと全開か
    steerGain: 1,       // ハンドル全体の感度（小さいほど鈍く・細かく）
    brakeGain: 1,       // ブレーキ全体の強さ
    practiceOn: false,  // 自分で走るときの練習スロー（使うと記録は残らない）
    hudOn: true,
    warnKmh: 0,         // 0＝鳴らさない
  };
  let cfg = { ...DEFAULTS };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const $ = (id) => document.getElementById(id);

  try {
    chrome.storage.sync.get(DEFAULTS, (v) => { cfg = { ...DEFAULTS, ...v }; });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'sync') return;
      for (const k in ch) cfg[k] = ch[k].newValue;
    });
  } catch (_) {}

  /* ---------- 入力の取り込み ---------- */
  const keys = { L: false, R: false, D: false, shift: false };
  const KEYMAP = { ArrowLeft: 'L', ArrowRight: 'R', ArrowDown: 'D', KeyA: 'L', KeyD: 'R', KeyS: 'D' };
  const isTyping = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

  function onKey(e) {
    const down = e.type === 'keydown';
    if (e.key === 'Shift') keys.shift = down;
    if (isTyping(e.target)) return;
    if (slowAvailable() && down && onWatchKey(e)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (!cfg.kbOn) return;
    const k = KEYMAP[e.code];
    if (!k) return;
    keys[k] = down;
    e.preventDefault();
    e.stopImmediatePropagation(); // ゲーム本来の「全開か0か」の処理に渡さない
  }
  addEventListener('keydown', onKey, true);
  addEventListener('keyup', onKey, true);
  addEventListener('blur', () => { keys.L = keys.R = keys.D = keys.shift = false; mouse.btn = false; });

  const mouse = { x: 0.5, inside: false, btn: false, moved: 0 };
  function onPointer(e) {
    if (e.isTrusted && e.pointerType === 'mouse' && cfg.mouseOn && e.target && e.target.id === 'touch') {
      mouse.x = e.clientX / innerWidth;
      mouse.inside = true;
      mouse.moved = performance.now();
      if (e.type === 'pointerdown') mouse.btn = true;
      if (e.type === 'pointerup' || e.type === 'pointercancel') mouse.btn = false;
      e.stopImmediatePropagation(); // 本物のマウスは、ゲームの「指」としては使わない
    }
  }
  ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'].forEach((t) => addEventListener(t, onPointer, true));
  document.addEventListener('mouseleave', () => { mouse.inside = false; mouse.btn = false; });

  /* ---------- 段階的に効かせる（キーボード） ---------- */
  const kb = { steer: 0, brake: 0 };
  function stepKeyboard(dt, padL, padR) {
    const L = keys.L || padL, R = keys.R || padR;
    const dir = (R ? 1 : 0) - (L ? 1 : 0);
    const cap = keys.shift ? cfg.kbFine : 1;
    if (dir !== 0) {
      const flip = Math.sign(kb.steer) === -dir ? 3 : 1; // 逆に切り返すときは素早く
      kb.steer += (dir * dt * flip) / Math.max(0.05, cfg.kbRise);
    } else {
      const d = dt / Math.max(0.03, cfg.kbFall);
      kb.steer = Math.abs(kb.steer) <= d ? 0 : kb.steer - Math.sign(kb.steer) * d;
    }
    kb.steer = clamp(kb.steer, -cap, cap);
    if (keys.D) kb.brake = Math.min(cap, kb.brake + dt / Math.max(0.05, cfg.kbBrakeRise));
    else kb.brake = Math.max(0, kb.brake - dt / 0.1);
  }

  function readPad() {
    const out = { steer: 0, brake: 0, L: false, R: false, on: false };
    if (!cfg.padOn || !navigator.getGamepads) return out;
    for (const gp of navigator.getGamepads()) {
      if (!gp || !gp.connected) continue;
      const dz = clamp(cfg.padDead, 0, 0.6);
      const sh = (v) => { const a = Math.abs(v); return a <= dz ? 0 : Math.sign(v) * Math.pow((a - dz) / (1 - dz), cfg.padCurve); };
      const b = (i) => (gp.buttons[i] ? gp.buttons[i].value : 0);
      const y = gp.axes[1] || 0;
      out.steer = sh(gp.axes[0] || 0);
      out.brake = Math.max(b(6), b(7), y > dz ? (y - dz) / (1 - dz) : 0);
      out.L = !!(gp.buttons[14] && gp.buttons[14].pressed);
      out.R = !!(gp.buttons[15] && gp.buttons[15].pressed);
      out.on = true;
      break;
    }
    return out;
  }

  /* ---------- 指の代わりにゲームへ渡す ---------- */
  const PID = 4242;
  let down = false, idleT = 0;
  function fire(type, x, y) {
    const el = $('touch');
    if (!el) return;
    el.dispatchEvent(new PointerEvent(type, {
      pointerId: PID, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true,
      clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1,
    }));
  }
  function feed(steer, brake, dt) {
    const active = Math.abs(steer) > 0.004 || brake > 0.004;
    idleT = active ? 0 : idleT + dt;
    const cx = innerWidth / 2, cy = innerHeight * 0.4;
    if (active && !down) { down = true; fire('pointerdown', cx, cy); }
    if (!down) return;
    if (!active && idleT > 0.15) { fire('pointerup', cx, cy); down = false; return; }
    fire('pointermove', cx + steer * innerWidth * 0.17, cy + 18 + brake * innerHeight * 0.09);
  }

  /* ---------- 表示 ---------- */
  let hud = null, hSteer, hBrake, hSrc, hSpeed, lastBeep = 0, audioCtx = null;
  function buildHud() {
    if (hud || !document.body) return;
    hud = document.createElement('div');
    hud.style.cssText = 'position:fixed;left:14px;bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:50;pointer-events:none;font:700 12px/1.2 sans-serif;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.6);display:flex;flex-direction:column;align-items:flex-start;gap:5px';
    hud.innerHTML =
      '<div data-k="speed" style="font:900 34px/1 sans-serif;letter-spacing:.02em">0<small style="font-size:13px;margin-left:3px">km/h</small></div>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
      '<div style="position:relative;width:150px;height:8px;background:rgba(0,0,0,.45);border-radius:4px"><i data-k="steer" style="position:absolute;top:0;height:8px;background:#ffd24a;border-radius:4px"></i><i style="position:absolute;left:50%;top:-2px;width:2px;height:12px;background:#fff8"></i></div>' +
      '<div style="position:relative;width:8px;height:34px;background:rgba(0,0,0,.45);border-radius:4px"><i data-k="brake" style="position:absolute;left:0;top:0;width:8px;background:#ff5a4a;border-radius:4px"></i></div>' +
      '<span data-k="src" style="min-width:44px"></span></div>';
    document.body.appendChild(hud);
    hSteer = hud.querySelector('[data-k=steer]');
    hBrake = hud.querySelector('[data-k=brake]');
    hSrc = hud.querySelector('[data-k=src]');
    hSpeed = hud.querySelector('[data-k=speed]');
  }
  function drawHud(steer, brake, src) {
    if (!cfg.hudOn) { if (hud) hud.style.display = 'none'; return; }
    buildHud();
    if (!hud) return;
    hud.style.display = 'flex';
    const w = Math.abs(steer) * 75;
    hSteer.style.left = (steer < 0 ? 75 - w : 75) + 'px';
    hSteer.style.width = w + 'px';
    hBrake.style.height = brake * 34 + 'px';
    hSrc.textContent = src;
    const kmh = parseFloat(($('kmh') || {}).textContent) || 0;
    const warn = cfg.warnKmh > 0 && kmh >= cfg.warnKmh;
    hSpeed.firstChild.nodeValue = Math.round(kmh);
    hSpeed.style.color = warn ? '#ff5a4a' : kmh >= 100 ? '#ffd24a' : '#fff';
    if (warn) beep();
  }
  function beep() {
    const now = performance.now();
    if (now - lastBeep < 900) return;
    lastBeep = now;
    try {
      audioCtx = audioCtx || new AudioContext();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = 880; g.gain.value = 0.06;
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.08);
    } catch (_) {}
  }

  /* ---------- 練習スローを使ったあとの表示 ---------- */
  addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__tg !== 'practiceUsed' || !document.body) return;
    const b = document.createElement('div');
    b.textContent = '練習モード：このタイムは記録されません（ページを開き直すと解除）';
    b.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:50;pointer-events:none;padding:5px 12px;border-radius:14px;background:rgba(216,68,47,.9);color:#fff;font:700 12px sans-serif';
    document.body.appendChild(b);
  });

  /* ---------- 走りを見るときの再生コントロール ---------- */
  const SPEEDS = [1, 0.75, 0.5, 0.25, 0.1];
  let spdIdx = 0, paused = false, panel = null, panelLabel = null;
  const watchActive = () => {
    const bar = $('wBar'), exit = $('wExit');
    return !!(bar && bar.classList.contains('on') && exit && !exit.hidden);
  };
  const slowAvailable = () => watchActive() || cfg.practiceOn;
  function applyScale() {
    const v = paused ? 0 : SPEEDS[spdIdx];
    window.postMessage({ __tg: 'scale', v }, '*');
    if (panelLabel) panelLabel.textContent = paused ? '一時停止' : '×' + SPEEDS[spdIdx];
  }
  function onWatchKey(e) {
    if (e.code === 'Space') { paused = !paused; applyScale(); return true; }
    if (e.key === ',' || e.key === '<') { spdIdx = Math.min(SPEEDS.length - 1, spdIdx + 1); paused = false; applyScale(); return true; }
    if (e.key === '.' || e.key === '>') { spdIdx = Math.max(0, spdIdx - 1); paused = false; applyScale(); return true; }
    return false;
  }
  function buildPanel() {
    if (panel || !document.body) return;
    panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;right:10px;bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:50;display:flex;gap:6px;align-items:center;font:700 12px sans-serif;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.6)';
    const mk = (t, f) => { const b = document.createElement('button'); b.textContent = t; b.type = 'button';
      b.style.cssText = 'padding:6px 10px;border-radius:14px;border:0;background:rgba(0,0,0,.55);color:#fff;font:700 12px sans-serif;cursor:pointer';
      b.addEventListener('click', (ev) => { ev.stopPropagation(); f(); applyScale(); }); return b; };
    panelLabel = document.createElement('span');
    panel.append(
      mk('⏯', () => { paused = !paused; }),
      mk('遅く', () => { spdIdx = Math.min(SPEEDS.length - 1, spdIdx + 1); paused = false; }),
      mk('速く', () => { spdIdx = Math.max(0, spdIdx - 1); paused = false; }),
      panelLabel);
    document.body.appendChild(panel);
    applyScale();
  }

  /* ---------- メインループ ---------- */
  let prev = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = clamp((now - prev) / 1000, 0, 0.1);
    prev = now;

    const pad = readPad();
    stepKeyboard(dt, pad.L, pad.R);

    let steer = 0, src = '';
    const kbHeld = keys.L || keys.R || pad.L || pad.R;
    const mouseOn = cfg.mouseOn && mouse.inside && performance.now() - mouse.moved < 5000;
    if (pad.on && Math.abs(pad.steer) > 0 && !kbHeld) { steer = pad.steer; src = '🎮'; }
    else if (cfg.kbOn && kb.steer !== 0 || kbHeld) { steer = kb.steer; src = '⌨'; }
    else if (mouseOn) {
      const v = clamp((mouse.x - 0.5) / Math.max(0.05, cfg.mouseRange), -1, 1);
      steer = Math.abs(v) < 0.04 ? 0 : v; src = steer ? '🖱' : '';
    }

    let brake = Math.max(pad.brake, cfg.kbOn ? kb.brake : 0);
    if (mouseOn && mouse.btn) { mouseBrake = Math.min(1, mouseBrake + dt / Math.max(0.05, cfg.kbBrakeRise)); }
    else mouseBrake = Math.max(0, mouseBrake - dt / 0.1);
    brake = Math.max(brake, mouseBrake);

    steer = clamp(steer * cfg.steerGain, -1, 1);
    brake = clamp(brake * cfg.brakeGain, 0, 1);
    feed(steer, brake, dt);
    drawHud(steer, brake, src);

    if (sentPractice !== !!cfg.practiceOn) { sentPractice = !!cfg.practiceOn; window.postMessage({ __tg: 'practice', on: sentPractice }, '*'); }
    if (slowAvailable()) buildPanel();
    else if (panel) { panel.remove(); panel = panelLabel = null; paused = false; spdIdx = 0; window.postMessage({ __tg: 'scale', v: 1 }, '*'); }
  }
  let mouseBrake = 0, sentPractice = null;
  requestAnimationFrame(frame);
})();
