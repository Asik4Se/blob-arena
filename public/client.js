// ブロブアリーナ クライアント（描画・HUD・操作）
(function () {
  'use strict';
  const { Game, SKILLS, SKILL_IDS, cleanSkills, radius, drawScale } = window.BlobCore;
  const $ = (id) => document.getElementById(id);
  const cv = $('cv'), ctx = cv.getContext('2d');
  const mini = $('mini'), mctx = mini.getContext('2d');

  const hasNet = !window.BLOB_SOLO_ONLY && /^https?:$/.test(location.protocol);
  let socket = null;
  let mode = null; // 'online' | 'solo'
  let myId = null;
  let room = null;
  let snap = null;
  let solo = null;
  let resultData = null;
  let W = 0, H = 0, dpr = 1;

  // ---------- 画面切替 ----------
  function show(id) {
    for (const s of ['title', 'lobby', 'result']) $(s).hidden = s !== id;
    $('hud').hidden = id !== 'game' && id !== 'result';
    // スキル選びはタイトルとロビーで同じものを使う
    if (id === 'lobby') $('lobbySkillSlot').appendChild($('skillPick'));
    if (id === 'title') $('titleSkillSlot').appendChild($('skillPick'));
  }
  function storage(get, val) {
    try { if (get) return localStorage.getItem('blob-name') || ''; localStorage.setItem('blob-name', val); } catch (e) { return ''; }
  }
  $('nameInput').value = storage(true);
  const myName = () => { const n = $('nameInput').value.trim() || 'プレイヤー'; storage(false, n); return n; };

  if (!hasNet) { $('onlineBox').hidden = true; $('offlineNote').hidden = false; }

  // ---------- スキル選び（2つ。1つめが Q、2つめが E） ----------
  let mySkills = (() => { try { return cleanSkills(JSON.parse(localStorage.getItem('blob-skills') || '[]')); } catch (e) { return cleanSkills([]); } })();
  let focusSkill = mySkills[0];
  function renderPicker() {
    $('skillGrid').innerHTML = SKILL_IDS.map((k) => {
      const slot = mySkills.indexOf(k);
      return `<button type="button" class="skill-opt${slot >= 0 ? ' on' : ''}" data-k="${k}" aria-pressed="${slot >= 0}">` +
        `${SKILLS[k].name}${slot >= 0 ? `<span class="slot">${slot ? 'E' : 'Q'}</span>` : ''}</button>`;
    }).join('');
    const d = SKILLS[focusSkill];
    $('skillDesc').textContent = d ? `${d.name}：${d.desc}（再使用まで${d.cd}秒）` : '';
  }
  $('skillGrid').addEventListener('click', (e) => {
    const b = e.target.closest('.skill-opt');
    if (!b) return;
    const k = b.dataset.k;
    focusSkill = k;
    if (mySkills.includes(k)) {
      // 選択中をもう一度押すと Q と E を入れ替える
      mySkills = [mySkills[1], mySkills[0]];
    } else {
      // 新しく選ぶと、古いほう（Q）が外れて E が Q に繰り上がる
      mySkills = [mySkills[1], k];
    }
    try { localStorage.setItem('blob-skills', JSON.stringify(mySkills)); } catch (err) { /* 保存できなくても遊べる */ }
    renderPicker();
    if (socket && mode === 'online') socket.emit('skills', mySkills);
  });
  $('skillGrid').addEventListener('pointerover', (e) => {
    const b = e.target.closest('.skill-opt');
    if (b && b.dataset.k !== focusSkill) { focusSkill = b.dataset.k; renderPicker(); }
  });
  renderPicker();

  // ---------- オンライン（WebSocket） ----------
  // 送信前に接続が終わっていなくても、開いた時点でまとめて送る
  function connect() {
    if (socket) return socket;
    const handlers = {};
    const queue = [];
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    const raw = new WebSocket(url);
    socket = {
      raw,
      on(t, fn) { handlers[t] = fn; },
      emit(t, d) {
        const msg = JSON.stringify({ t, d });
        if (raw.readyState === 1) raw.send(msg); else if (raw.readyState === 0) queue.push(msg);
      },
    };
    raw.onopen = () => { while (queue.length) raw.send(queue.shift()); };
    raw.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch (err) { return; }
      if (handlers[m.t]) handlers[m.t](m.d);
    };
    raw.onclose = () => {
      socket = null;
      if (mode === 'online') { mode = null; room = null; show('title'); $('joinError').textContent = 'サーバーとの接続が切れました'; }
    };
    socket.on('hello', (d) => { myId = d.id; });
    socket.on('room', (r) => {
      const prev = room;
      room = r;
      $('joinError').textContent = '';
      if (r.state === 'lobby') { renderLobby(); show('lobby'); snap = null; }
      else if (r.state === 'playing') {
        if (!prev || prev.state !== 'playing') { resultData = null; resetView(); show('game'); sendViewport(); }
      } else if (r.state === 'result') {
        if (resultData) renderResult();
      }
      if (r.state !== 'lobby' && $('lobby').hidden === false) show('game');
    });
    socket.on('joinError', (msg) => { $('joinError').textContent = msg; mode = null; });
    socket.on('snap', (s) => { snap = s; });
    socket.on('result', (res) => { resultData = res; renderResult(); });
    return socket;
  }
  $('btnCreate').onclick = () => { mode = 'online'; connect().emit('create', { name: myName(), skills: mySkills }); };
  $('btnJoin').onclick = () => {
    const code = $('codeInput').value.trim();
    if (!/^\d{4}$/.test(code)) { $('joinError').textContent = '4桁の部屋コードを入力してください'; return; }
    mode = 'online';
    connect().emit('join', { name: myName(), code, skills: mySkills });
  };
  $('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnJoin').click(); });

  function renderLobby() {
    $('roomCode').textContent = room.code;
    const isHost = room.hostId === myId;
    $('memberList').innerHTML = room.members.map((m) =>
      `<li><span>${esc(m.name)}${m.id === myId ? '（あなた）' : ''}<span class="mskills">${(m.skills || []).map((k) => SKILLS[k] ? SKILLS[k].name : '').join('・')}</span></span>` +
      `${m.id === room.hostId ? '<span class="tag">ホスト</span>' : ''}</li>`).join('');
    $('hostBox').hidden = !isHost;
    $('waitText').hidden = isHost;
    $('timeSelect').value = String(room.matchTime);
  }
  $('timeSelect').onchange = () => socket && socket.emit('settings', { matchTime: Number($('timeSelect').value) });
  $('btnStart').onclick = () => socket && socket.emit('start');
  $('btnLeave').onclick = () => { if (socket) socket.emit('leave'); mode = null; room = null; show('title'); };

  // ---------- ひとり練習 ----------
  function startSolo() {
    mode = 'solo';
    resultData = null;
    solo = new Game({ matchTime: 300 });
    solo.addPlayer('me', myName(), mySkills);
    myId = 'me';
    resetView();
    show('game');
  }
  $('btnSolo').onclick = startSolo;

  // ---------- リザルト ----------
  function renderResult() {
    if (!resultData) return;
    const me = resultData.find((r) => r.id === myId);
    $('resultMe').textContent = me ? `あなたは ${me.rank}位（スコア ${me.score}）` : '';
    $('resultList').innerHTML = resultData.map((r) =>
      `<li class="${r.id === myId ? 'me' : ''}"><span>${r.rank}位</span><span class="n">${esc(r.name)}</span><span class="s">${r.score}</span></li>`).join('');
    const host = mode === 'solo' || (room && room.hostId === myId);
    $('resultHost').hidden = !host;
    $('resultWait').hidden = host;
    $('btnToLobby').textContent = mode === 'solo' ? 'タイトルへ' : 'ロビーへ';
    show('result');
  }
  $('btnAgain').onclick = () => {
    if (mode === 'solo') startSolo();
    else if (socket) { resultData = null; socket.emit('start'); }
  };
  $('btnToLobby').onclick = () => {
    resultData = null;
    if (mode === 'solo') { mode = null; solo = null; show('title'); }
    else if (socket) socket.emit('toLobby');
  };
  $('btnQuit').onclick = () => {
    if (mode === 'solo') { mode = null; solo = null; show('title'); return; }
    if (socket) socket.emit('leave');
    mode = null; room = null; show('title');
  };

  // ---------- 入力 ----------
  const mouse = { x: 0, y: 0, moved: false };
  const stick = { active: false, id: null, ox: 0, oy: 0, nx: 0, ny: 0 };
  let ejectHeld = false;
  let lastSent = 0, lastDx = 0, lastDy = 0;

  addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; mouse.moved = true; });
  addEventListener('keydown', (e) => {
    if (!inGame() || e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) doSplit(); }
    if (e.code === 'KeyW' && !ejectHeld) setEject(true);
    if (e.code === 'KeyQ' && !e.repeat) useSkill(0);
    if (e.code === 'KeyE' && !e.repeat) useSkill(1);
  });
  addEventListener('keyup', (e) => { if (e.code === 'KeyW') setEject(false); });
  addEventListener('blur', () => setEject(false));

  function inGame() { return mode && !$('hud').hidden && $('result').hidden; }
  function currentDir() {
    if (stick.active) return { dx: stick.nx * 420, dy: stick.ny * 420 };
    if (document.body.classList.contains('touch') && !stick.active) return { dx: 0, dy: 0 };
    const s = drawScale(view.zoom, W, H);
    return { dx: (mouse.x - W / 2) / s, dy: (mouse.y - H / 2) / s };
  }
  function sendInput(force) {
    const { dx, dy } = currentDir();
    if (mode === 'solo' && solo) { solo.setInput('me', dx, dy); return; }
    if (mode !== 'online' || !socket) return;
    const now = performance.now();
    if (force || (now - lastSent > 50 && (Math.abs(dx - lastDx) > 2 || Math.abs(dy - lastDy) > 2))) {
      socket.emit('input', { dx: Math.round(dx), dy: Math.round(dy) });
      lastSent = now; lastDx = dx; lastDy = dy;
    }
  }
  function doSplit() {
    sendInput(true);
    if (mode === 'solo' && solo) solo.split('me');
    else if (socket) socket.emit('split');
  }
  function useSkill(slot) {
    sendInput(true); // ワープ・トラップは今の向きを使う
    if (mode === 'solo' && solo) solo.useSkill('me', slot);
    else if (socket && mode === 'online') socket.emit('skill', slot);
  }
  function setEject(on) {
    if (ejectHeld === on) return;
    ejectHeld = on;
    sendInput(true);
    if (mode === 'solo' && solo) solo.setEject('me', on);
    else if (socket && mode === 'online') socket.emit('eject', on);
  }

  // タッチ操作
  addEventListener('touchstart', () => document.body.classList.add('touch'), { once: true, passive: true });
  const zone = $('stickZone'), base = $('stickBase'), knob = $('stickKnob');
  zone.addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0];
    stick.active = true; stick.id = t.identifier; stick.ox = t.clientX; stick.oy = t.clientY;
    base.style.left = (t.clientX - 60) + 'px'; base.style.top = (t.clientY - 60) + 'px'; base.style.bottom = 'auto';
    e.preventDefault();
  }, { passive: false });
  zone.addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) if (t.identifier === stick.id) {
      let dx = t.clientX - stick.ox, dy = t.clientY - stick.oy;
      const d = Math.hypot(dx, dy), max = 50;
      if (d > max) { dx = dx / d * max; dy = dy / d * max; }
      stick.nx = dx / max; stick.ny = dy / max;
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
    }
    e.preventDefault();
  }, { passive: false });
  const endStick = (e) => {
    for (const t of e.changedTouches) if (t.identifier === stick.id) {
      stick.active = false; stick.nx = stick.ny = 0; knob.style.transform = '';
    }
  };
  zone.addEventListener('touchend', endStick); zone.addEventListener('touchcancel', endStick);
  $('btnSplit').addEventListener('touchstart', (e) => { e.preventDefault(); doSplit(); }, { passive: false });
  $('btnEject').addEventListener('touchstart', (e) => { e.preventDefault(); setEject(true); }, { passive: false });
  $('btnEject').addEventListener('touchend', (e) => { e.preventDefault(); setEject(false); }, { passive: false });
  for (const slot of [0, 1]) {
    const b = $('sk' + slot);
    b.addEventListener('touchstart', (e) => { e.preventDefault(); useSkill(slot); }, { passive: false });
    b.addEventListener('click', () => { useSkill(slot); b.blur(); });
  }

  // ---------- 表示 ----------
  const view = { x: 2000, y: 2000, zoom: 1, init: false };
  const disp = new Map();
  let seenNotices = new Set();
  const burstSeen = new Map();
  function resetView() { view.init = false; disp.clear(); seenNotices = new Set(); burstSeen.clear(); snap = null; $('toasts').innerHTML = ''; }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    sendViewport();
  }
  function sendViewport() { if (socket && mode === 'online') socket.emit('viewport', { w: W, h: H }); }
  addEventListener('resize', resize);
  resize();

  function smooth(id, x, y, r, k) {
    let d = disp.get(id);
    if (!d) { d = { x, y, r }; disp.set(id, d); }
    else { d.x += (x - d.x) * k; d.y += (y - d.y) * k; d.r += (r - d.r) * k; }
    d.seen = frame;
    return d;
  }

  let last = performance.now(), acc = 0, frame = 0, hudAt = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now; frame++;

    if (mode === 'solo' && solo) {
      sendInput(false);
      acc += dt;
      let n = 0;
      while (acc >= 1 / 30 && n < 4) { solo.step(1 / 30); acc -= 1 / 30; n++; }
      if (!solo.ended || !snap || !snap.ended) snap = solo.view('me', W, H);
      if (solo.ended && !resultData) { resultData = solo.result; renderResult(); }
    } else if (mode === 'online') {
      sendInput(false);
    }

    if (!snap || !mode) { drawIdle(now); return; }
    const k = mode === 'solo' ? 1 : 1 - Math.exp(-dt * 16);

    if (!view.init) { view.x = snap.cam.x; view.y = snap.cam.y; view.zoom = snap.cam.zoom; view.init = true; }
    const ck = 1 - Math.exp(-dt * 10);
    view.x += (snap.cam.x - view.x) * ck; view.y += (snap.cam.y - view.y) * ck;
    view.zoom += (snap.cam.zoom - view.zoom) * (1 - Math.exp(-dt * 3));
    draw(snap, k, now);
    if (now - hudAt > 100) { hudAt = now; updateHud(snap); }
  }

  function drawIdle(now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a0f1f'; ctx.fillRect(0, 0, W, H);
    const t = now / 1000;
    for (let i = 0; i < 14; i++) {
      const x = (Math.sin(t * 0.13 + i * 1.7) * 0.5 + 0.5) * W, y = (Math.cos(t * 0.11 + i * 2.3) * 0.5 + 0.5) * H;
      const r = 18 + (i % 5) * 16;
      ctx.fillStyle = `hsla(${(i * 47) % 360},70%,55%,0.18)`;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
  }

  function draw(s, k, now) {
    const sc = drawScale(view.zoom, W, H);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a0f1f'; ctx.fillRect(0, 0, W, H);
    ctx.setTransform(dpr * sc, 0, 0, dpr * sc, dpr * (W / 2 - view.x * sc), dpr * (H / 2 - view.y * sc));
    const x0 = view.x - W / 2 / sc, x1 = view.x + W / 2 / sc, y0 = view.y - H / 2 / sc, y1 = view.y + H / 2 / sc;

    // 背景グリッド
    const step = sc * 50 < 10 ? 250 : 50;
    ctx.strokeStyle = 'rgba(120,150,230,0.09)'; ctx.lineWidth = 1 / sc;
    ctx.beginPath();
    for (let gx = Math.max(0, Math.floor(x0 / step) * step); gx <= Math.min(s.size, x1); gx += step) { ctx.moveTo(gx, Math.max(0, y0)); ctx.lineTo(gx, Math.min(s.size, y1)); }
    for (let gy = Math.max(0, Math.floor(y0 / step) * step); gy <= Math.min(s.size, y1); gy += step) { ctx.moveTo(Math.max(0, x0), gy); ctx.lineTo(Math.min(s.size, x1), gy); }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,90,106,0.6)'; ctx.lineWidth = 6 / sc;
    ctx.strokeRect(0, 0, s.size, s.size);

    // エサ
    const pl = s.pellets;
    for (let i = 0; i < pl.length; i += 3) {
      ctx.fillStyle = `hsl(${pl[i + 2]},85%,64%)`;
      ctx.beginPath(); ctx.arc(pl[i], pl[i + 1], 5, 0, Math.PI * 2); ctx.fill();
    }
    // ゴールデンエサ
    const pulse = 1 + Math.sin(now / 160) * 0.15;
    for (const g of s.golden) {
      const grd = ctx.createRadialGradient(g.x, g.y, 2, g.x, g.y, 44 * pulse);
      grd.addColorStop(0, 'rgba(255,220,100,0.9)'); grd.addColorStop(1, 'rgba(255,200,60,0)');
      ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(g.x, g.y, 44 * pulse, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffd257'; ctx.beginPath(); ctx.arc(g.x, g.y, 16, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff6cf'; ctx.lineWidth = 3; ctx.stroke();
    }
    // 射出物
    for (const e of s.ejected) {
      const d = smooth('e' + e.i, e.x, e.y, radius(12), k);
      ctx.fillStyle = `hsl(${e.h},70%,58%)`;
      ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); ctx.fill();
    }

    // セル（小さい順）
    const cells = s.cells.slice().sort((a, b) => a.m - b.m);
    for (const c of cells) {
      const d = smooth('c' + c.i, c.x, c.y, radius(c.m), k);
      drawCell(c, d, now);
    }

    // ウイルス（セルより上：隠れ蓑になる）
    for (const v of s.viruses) {
      const d = smooth('v' + v.i, v.x, v.y, radius(v.m), k);
      drawVirus(d.x, d.y, d.r, now, v.t);
    }

    // 隕石
    for (const m of s.meteors) {
      if (m.t > 0) {
        const p = Math.max(0, Math.min(1, 1 - m.t / 1.2));
        ctx.strokeStyle = 'rgba(255,110,60,0.9)'; ctx.lineWidth = 5; ctx.setLineDash([16, 12]);
        ctx.beginPath(); ctx.arc(m.x, m.y, 90, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = `rgba(255,90,40,${0.15 + p * 0.35})`;
        ctx.beginPath(); ctx.arc(m.x, m.y, 90 * p, 0, Math.PI * 2); ctx.fill();
      } else {
        const a = Math.max(0, 1 + m.t / 0.5);
        ctx.fillStyle = `rgba(255,240,200,${a * 0.8})`;
        ctx.beginPath(); ctx.arc(m.x, m.y, 90 + (1 - a) * 60, 0, Math.PI * 2); ctx.fill();
      }
    }

    // 衝撃波（広がる輪）と合体（縮む輪）
    for (const bu of s.bursts || []) {
      if (!burstSeen.has(bu.i)) burstSeen.set(bu.i, { at: now, b: bu });
    }
    for (const [key, e] of burstSeen) {
      const t = (now - e.at) / 450;
      if (t >= 1) { burstSeen.delete(key); continue; }
      const bu = e.b;
      ctx.save();
      if (bu.k === 1) {
        const rr = bu.r + bu.reach * t;
        ctx.strokeStyle = `rgba(170, 200, 255, ${0.8 * (1 - t)})`; ctx.lineWidth = 10 * (1 - t) + 2;
        ctx.beginPath(); ctx.arc(bu.x, bu.y, rr, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = `rgba(170, 200, 255, ${0.12 * (1 - t)})`; ctx.fill();
      } else {
        const rr = bu.r * (1 + 1.2 * (1 - t));
        ctx.strokeStyle = `rgba(92, 242, 197, ${0.85 * (1 - t)})`; ctx.lineWidth = 6;
        ctx.beginPath(); ctx.arc(bu.x, bu.y, rr, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
    }

    for (const [id, d] of disp) if (d.seen !== frame) disp.delete(id);
    drawMini(s);
  }

  function drawSkillFx(c, d, now) {
    const r = d.r, f = c.f || 0;
    if (f & 4) {
      // マグネット：吸い寄せる範囲を回る点線で
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 210, 87, 0.45)'; ctx.lineWidth = 3; ctx.setLineDash([10, 14]);
      ctx.lineDashOffset = -now / 25;
      ctx.beginPath(); ctx.arc(d.x, d.y, r + 260, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
    if (f & 2) {
      // ダッシュ：外側にブレた輪
      for (let i = 1; i <= 3; i++) {
        ctx.strokeStyle = `rgba(120, 220, 255, ${0.35 - i * 0.09})`; ctx.lineWidth = Math.max(2, r * 0.05);
        ctx.beginPath(); ctx.arc(d.x, d.y, r * (1 + i * 0.09), 0, Math.PI * 2); ctx.stroke();
      }
    }
    if (c.w) {
      // ワープ直後の光
      ctx.fillStyle = 'rgba(200, 170, 255, 0.35)';
      ctx.beginPath(); ctx.arc(d.x, d.y, r * 1.5, 0, Math.PI * 2); ctx.fill();
    }
  }
  function drawShield(c, d, now) {
    const r = d.r + Math.max(6, d.r * 0.12);
    const n = 6, rot = now / 900;
    ctx.save();
    ctx.strokeStyle = 'rgba(140, 240, 255, 0.95)'; ctx.fillStyle = 'rgba(140, 240, 255, 0.12)';
    ctx.lineWidth = Math.max(3, d.r * 0.06);
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = rot + (i / n) * Math.PI * 2;
      const x = d.x + Math.cos(a) * r, y = d.y + Math.sin(a) * r;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  function drawCell(c, d, now) {
    const r = d.r;
    if (c.f) drawSkillFx(c, d, now);
    // ステルス中の自分は半透明（ほかの人には見えていない）
    ctx.globalAlpha = c.g ? 0.45 + Math.sin(now / 90) * 0.1 : (c.f & 8) ? 0.38 : 1;
    if (c.k === 'G') {
      // ヌシ：暗い赤にトゲ
      ctx.fillStyle = '#5a1328'; ctx.strokeStyle = '#ff4d6d'; ctx.lineWidth = Math.max(4, r * 0.04);
      ctx.beginPath();
      const n = 28;
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2 + now / 4000;
        const rr = r * (i % 2 ? 0.96 : 1.03);
        const x = d.x + Math.cos(a) * rr, y = d.y + Math.sin(a) * rr;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.fill(); ctx.stroke();
      // 目
      ctx.fillStyle = '#ffd6de';
      for (const sx of [-1, 1]) { ctx.beginPath(); ctx.ellipse(d.x + sx * r * 0.28, d.y - r * 0.12, r * 0.1, r * 0.14, 0, 0, Math.PI * 2); ctx.fill(); }
      ctx.fillStyle = '#1a0008';
      for (const sx of [-1, 1]) { ctx.beginPath(); ctx.arc(d.x + sx * r * 0.28, d.y - r * 0.08, r * 0.055, 0, Math.PI * 2); ctx.fill(); }
      label('ヌシ', d.x, d.y + r * 0.4, r * 0.22, '#ffb3c1');
    } else {
      const npc = c.k !== 'P';
      const sat = npc ? 45 : 75, lig = npc ? 50 : 56;
      ctx.fillStyle = `hsl(${c.h},${sat}%,${lig}%)`;
      ctx.strokeStyle = `hsl(${c.h},${sat}%,${lig - 16}%)`;
      ctx.lineWidth = Math.max(2.5, r * 0.07);
      ctx.beginPath(); ctx.arc(d.x, d.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (npc && r > 18) {
        ctx.strokeStyle = `hsla(${c.h},${sat}%,${lig + 18}%,0.5)`; ctx.lineWidth = Math.max(1.5, r * 0.04);
        ctx.beginPath(); ctx.arc(d.x, d.y, r * 0.62, 0, Math.PI * 2); ctx.stroke();
      }
      if (!npc) {
        if (c.me) { ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = Math.max(2, r * 0.03); ctx.beginPath(); ctx.arc(d.x, d.y, r + ctx.lineWidth * 1.5, 0, Math.PI * 2); ctx.stroke(); }
        if (r > 14) {
          label(c.n, d.x, d.y - r * 0.06, Math.max(10, r * 0.34), '#fff');
          label(String(c.m), d.x, d.y + r * 0.34, Math.max(9, r * 0.2), 'rgba(255,255,255,0.85)');
        }
        if (c.b) drawCrown(d.x, d.y - r - Math.max(14, r * 0.2), Math.max(18, r * 0.35));
      }
    }
    ctx.globalAlpha = 1;
    if (c.f & 1) drawShield(c, d, now);
  }

  function label(text, x, y, size, color) {
    ctx.font = `800 ${size}px 'M PLUS Rounded 1c', sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = size * 0.16; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.strokeText(text, x, y);
    ctx.fillStyle = color; ctx.fillText(text, x, y);
  }

  function drawCrown(x, y, s) {
    ctx.fillStyle = '#ffd257'; ctx.strokeStyle = '#7a5200'; ctx.lineWidth = s * 0.08;
    ctx.beginPath();
    ctx.moveTo(x - s * 0.6, y + s * 0.3); ctx.lineTo(x - s * 0.6, y - s * 0.25); ctx.lineTo(x - s * 0.3, y + s * 0.02);
    ctx.lineTo(x, y - s * 0.4); ctx.lineTo(x + s * 0.3, y + s * 0.02); ctx.lineTo(x + s * 0.6, y - s * 0.25); ctx.lineTo(x + s * 0.6, y + s * 0.3);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }

  function drawVirus(x, y, r, now, trapLeft) {
    const n = 22;
    // トラップで置いたウイルスは黄緑に、残り秒数を表示
    ctx.fillStyle = trapLeft ? 'rgba(190, 240, 60, 0.85)' : 'rgba(70, 230, 110, 0.85)';
    ctx.strokeStyle = trapLeft ? '#7f9e1f' : '#1f9e47'; ctx.lineWidth = 4;
    ctx.beginPath();
    for (let i = 0; i <= n * 2; i++) {
      const a = (i / (n * 2)) * Math.PI * 2 + now / 3000;
      const rr = i % 2 ? r * 0.9 : r * 1.06;
      const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.fill(); ctx.stroke();
    if (trapLeft) label(String(trapLeft), x, y, r * 0.36, '#24300a');
  }

  function drawMini(s) {
    const w = mini.width, h = mini.height, f = w / s.size;
    mctx.clearRect(0, 0, w, h);
    mctx.strokeStyle = 'rgba(140,170,255,0.18)'; mctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) { mctx.beginPath(); mctx.moveTo(i * w / 4, 0); mctx.lineTo(i * w / 4, h); mctx.moveTo(0, i * h / 4); mctx.lineTo(w, i * h / 4); mctx.stroke(); }
    // 視界
    const sc = drawScale(view.zoom, W, H);
    mctx.strokeStyle = 'rgba(255,255,255,0.35)';
    mctx.strokeRect((view.x - W / 2 / sc) * f, (view.y - H / 2 / sc) * f, W / sc * f, H / sc * f);
    if (s.giant) { mctx.fillStyle = '#ff4d6d'; mctx.beginPath(); mctx.arc(s.giant[0] * f, s.giant[1] * f, 11, 0, Math.PI * 2); mctx.fill(); }
    for (const p of s.players) {
      const [x, y, me, b] = p;
      mctx.fillStyle = me ? '#ffffff' : b ? '#ffd257' : '#5cf2c5';
      mctx.beginPath(); mctx.arc(x * f, y * f, me ? 9 : b ? 10 : 7, 0, Math.PI * 2); mctx.fill();
    }
  }

  // ---------- HUD ----------
  function updateHud(s) {
    const left = Math.ceil(s.left);
    const t = $('timer');
    t.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    t.classList.toggle('hurry', left <= 60);
    $('badges').innerHTML = (s.fever ? '<span class="badge fever">ラストフィーバー</span>' : '') + (s.meteor ? '<span class="badge meteor">流星群</span>' : '');
    if (s.me) $('mystat').innerHTML = `スコア <b>${s.me.score}</b>　${s.me.rank ? s.me.rank + '位' : ''}${s.me.bounty ? '　<span style="color:var(--gold)">賞金首</span>' : ''}`;
    let html = s.ranking.map((r, i) =>
      `<li class="${r.me ? 'me' : ''}"><span>${i + 1}</span><span class="n">${r.b ? '<span class="crown">♛</span>' : ''}${esc(r.n)}</span><span class="s">${r.s}</span></li>`).join('');
    if (s.myRow) html += `<li class="me sep"><span>${s.myRow.rank}</span><span class="n">${esc(s.myRow.n)}</span><span class="s">${s.myRow.s}</span></li>`;
    $('rankList').innerHTML = html;
    for (const n of s.notices) {
      if (seenNotices.has(n.i)) continue;
      seenNotices.add(n.i);
      const el = document.createElement('div');
      el.className = 'toast ' + n.k; el.textContent = n.text;
      $('toasts').appendChild(el);
      setTimeout(() => el.remove(), 3500);
      while ($('toasts').children.length > 3) $('toasts').firstChild.remove();
    }
    if (s.me && s.me.skills) {
      s.me.skills.forEach((sk, i) => {
        const b = $('sk' + i);
        if (!b) return;
        const name = SKILLS[sk.id] ? SKILLS[sk.id].name : '';
        const nm = b.querySelector('.sk-name');
        if (nm.textContent !== name) nm.textContent = name;
        b.classList.toggle('active', sk.act > 0);
        b.classList.toggle('ready', sk.cd <= 0 && sk.use !== 0);
        b.querySelector('.sk-cd').textContent = sk.act > 0 ? `${Math.ceil(sk.act)}` : sk.cd > 0 ? `${Math.ceil(sk.cd)}` : '';
        b.setAttribute('aria-label', `${name}（${i ? 'E' : 'Q'}）${sk.cd > 0 && !(sk.act > 0) ? ` あと${Math.ceil(sk.cd)}秒` : ''}`);
      });
    }
    const dead = s.me && !s.me.alive && !s.ended;
    $('death').hidden = !dead;
    if (dead) {
      $('deathBy').textContent = s.me.killedBy ? `${s.me.killedBy} に食べられた…　スコアは0に` : 'スコアは0に戻りました';
      $('deathCount').textContent = Math.ceil(s.me.respawnIn);
    }
  }

  function esc(t) { return String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // 動作確認用（URLに ?debug を付けたときだけ）
  if (/[?&]debug/.test(location.search)) window.__blob = { get solo() { return solo; }, start: startSolo };

  show('title');
  requestAnimationFrame(loop);
})();
