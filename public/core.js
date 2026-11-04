// ブロブアリーナ 共通ゲームロジック（サーバーとブラウザの両方で動く）
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BlobCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CFG = {
    baseSize: 4000,
    startMass: 20,
    eatRatio: 1.25,
    splitMin: 36,
    maxCells: 16,
    mergeTime: 30,
    ejectMin: 35,
    ejectCost: 16,
    ejectMass: 12,
    virusCount: 10,
    virusMass: 100,
    virusFeeds: 7,
    pelletCount: 600,
    decayRate: 0.002,
    decayMin: 500,
    respawnDelay: 3,
    ghostTime: 3,
    matchTime: 300,
    goldenInterval: 60,
    goldenFeverInterval: 20,
    goldenMass: 150,
    goldenLife: 30,
    feverLeft: 60,
    meteorChecks: [120, 210],
    meteorChance: 0.5,
    meteorDuration: 30,
    meteorWarn: 1.2,
    meteorRadius: 90,
    meteorPopMass: 300,
    bountyRatio: 1.5,
    bountyMinScore: 150,
    bountyBonus: 0.5,
    npcSafeDist: 900,
    playerSafeDist: 700,
    giantRatio: 1.3,
    giantMin: 800,
    giantMax: 20000,
    giantSpeedMul: 0.75,
  };

  const NPC_KINDS = {
    S: { min: 10, max: 30, cap: 40 },
    SW: { min: 15, max: 15, cap: 40 },
    M: { min: 50, max: 150, cap: 220 },
    L: { min: 200, max: 500, cap: 750 },
  };

  const radius = (m) => 6 * Math.sqrt(m);
  const speedOf = (m) => Math.max(26, 620 * Math.pow(m, -0.36));
  const rand = (a, b) => a + Math.random() * (b - a);
  const dist2 = (ax, ay, bx, by) => (ax - bx) * (ax - bx) + (ay - by) * (ay - by);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  // 画面に描くときの倍率（サーバーとクライアントで共通）
  const drawScale = (zoom, vw, vh) => zoom * Math.min(1, Math.max(vw, vh) / 1100);

  // 空間ハッシュ
  class Grid {
    constructor(size) { this.size = size; this.map = new Map(); }
    clear() { this.map.clear(); }
    key(ix, iy) { return ix * 100003 + iy; }
    add(o) {
      const ix = Math.floor(o.x / this.size), iy = Math.floor(o.y / this.size);
      const k = this.key(ix, iy);
      let b = this.map.get(k);
      if (!b) { b = []; this.map.set(k, b); }
      b.push(o);
    }
    query(x0, y0, x1, y1, fn) {
      const a = Math.floor(x0 / this.size), b = Math.floor(y0 / this.size);
      const c = Math.floor(x1 / this.size), d = Math.floor(y1 / this.size);
      for (let ix = a; ix <= c; ix++) for (let iy = b; iy <= d; iy++) {
        const bucket = this.map.get(this.key(ix, iy));
        if (bucket) for (let i = 0; i < bucket.length; i++) fn(bucket[i]);
      }
    }
  }

  const NAMES_COLORS = 360;
  let uid = 1;

  class Game {
    constructor(opts = {}) {
      this.matchTime = opts.matchTime || CFG.matchTime;
      this.time = 0;
      this.ended = false;
      this.size = CFG.baseSize;
      this.owners = new Map(); // id -> owner（プレイヤー or NPC）
      this.pellets = [];
      this.viruses = [];
      this.ejected = [];
      this.golden = [];
      this.meteors = [];
      this.notices = [];
      this.meteorUntil = 0;
      this.meteorNext = 0;
      this.meteorChecked = {};
      this.nextGolden = CFG.goldenInterval;
      this.bountyId = null;
      this.feverOn = false;
      this.swarmSeq = 1;
      this.cellGrid = new Grid(250);
      this.pelletGrid = new Grid(250);
      this.npcCheckAt = 0;
      this.ranking = [];
      for (let i = 0; i < CFG.virusCount; i++) this.spawnVirus();
      for (let i = 0; i < CFG.pelletCount; i++) this.spawnPellet();
      this.balanceNpcs(true);
    }

    // ---------- プレイヤー ----------
    addPlayer(id, name) {
      const p = {
        id, name: (name || 'プレイヤー').slice(0, 12), isNpc: false,
        hue: Math.floor(Math.random() * NAMES_COLORS), cells: [],
        tx: 0, ty: 0, alive: false, respawnAt: 0, killedBy: '', ejectHeld: false, ejectCd: 0,
      };
      this.owners.set(id, p);
      this.updateSize();
      this.respawnPlayer(p);
      return p;
    }
    removePlayer(id) {
      const p = this.owners.get(id);
      if (!p || p.isNpc) return;
      this.owners.delete(id);
      this.updateSize();
    }
    players() { const a = []; for (const o of this.owners.values()) if (!o.isNpc) a.push(o); return a; }
    npcs() { const a = []; for (const o of this.owners.values()) if (o.isNpc) a.push(o); return a; }

    updateSize() {
      const n = this.players().length;
      const area = 1 + Math.max(0, n - 10) * 0.1;
      const s = Math.round(CFG.baseSize * Math.sqrt(area));
      if (s > this.size) this.size = s; // 試合中は縮めない
    }

    respawnPlayer(p) {
      const pt = this.findSpawn(CFG.startMass, p.id);
      p.cells = [this.makeCell(p, pt.x, pt.y, CFG.startMass)];
      p.cells[0].ghostUntil = this.time + CFG.ghostTime;
      p.alive = true;
      p.tx = 0; p.ty = 0;
    }

    setInput(id, dx, dy) {
      const p = this.owners.get(id);
      if (!p || p.isNpc) return;
      if (!isFinite(dx) || !isFinite(dy)) return;
      p.tx = clamp(dx, -5000, 5000); p.ty = clamp(dy, -5000, 5000);
    }
    split(id) {
      const p = this.owners.get(id);
      if (p && p.alive) this.splitOwner(p, p.tx, p.ty, true);
    }
    setEject(id, held) {
      const p = this.owners.get(id);
      if (p) p.ejectHeld = !!held;
    }
    ejectOnce(id) {
      const p = this.owners.get(id);
      if (p && p.alive) this.ejectOwner(p);
    }

    // ---------- 生成 ----------
    makeCell(owner, x, y, mass) {
      return { id: uid++, owner, x, y, mass, vx: 0, vy: 0, mergeAt: 0, ghostUntil: 0 };
    }
    spawnPellet() {
      this.pellets.push({ x: rand(20, this.size - 20), y: rand(20, this.size - 20), hue: Math.floor(Math.random() * 360) });
    }
    spawnVirus(x, y, vx = 0, vy = 0) {
      let px = x, py = y;
      if (px === undefined) {
        for (let i = 0; i < 20; i++) {
          px = rand(200, this.size - 200); py = rand(200, this.size - 200);
          let ok = true;
          for (const o of this.owners.values()) for (const c of o.cells) {
            if (dist2(px, py, c.x, c.y) < (radius(c.mass) + 200) ** 2) { ok = false; break; }
          }
          if (ok) break;
        }
      }
      this.viruses.push({ id: uid++, x: px, y: py, vx, vy, mass: CFG.virusMass, feeds: 0 });
    }

    // 安全な出現地点を探す（自分を食べられる相手から離れた場所）
    findSpawn(mass, selfId) {
      let best = null, bestScore = -Infinity;
      const myR = radius(mass);
      for (let i = 0; i < 40; i++) {
        const x = rand(myR + 50, this.size - myR - 50), y = rand(myR + 50, this.size - myR - 50);
        let minThreat = Infinity, overlap = false;
        for (const o of this.owners.values()) {
          if (o.id === selfId) continue;
          for (const c of o.cells) {
            const d = Math.sqrt(dist2(x, y, c.x, c.y));
            const cr = radius(c.mass);
            if (d < cr + myR + 40) overlap = true;
            if (c.mass >= mass * CFG.eatRatio * 0.9) minThreat = Math.min(minThreat, d - cr);
          }
        }
        for (const v of this.viruses) if (dist2(x, y, v.x, v.y) < (myR + 80) ** 2) overlap = true;
        let score = Math.min(minThreat, 3000) - (overlap ? 5000 : 0);
        if (score > bestScore) { bestScore = score; best = { x, y }; }
        if (!overlap && minThreat > CFG.playerSafeDist) return { x, y };
      }
      return best;
    }

    // NPC用：自分より小さい（＝NPCが食べられる）プレイヤーの画面外に湧かせる
    findNpcSpawn(mass, farthest) {
      let best = null, bestScore = -Infinity;
      const myR = radius(mass);
      const tries = farthest ? 60 : 40;
      for (let i = 0; i < tries; i++) {
        const x = rand(myR + 30, this.size - myR - 30), y = rand(myR + 30, this.size - myR - 30);
        let minPrey = Infinity, overlap = false;
        for (const o of this.owners.values()) {
          for (const c of o.cells) {
            const d = Math.sqrt(dist2(x, y, c.x, c.y));
            const cr = radius(c.mass);
            if (d < cr + myR + 30) overlap = true;
            if (!o.isNpc && mass >= c.mass) minPrey = Math.min(minPrey, d - cr - myR);
          }
        }
        let score = Math.min(minPrey, 4000) - (overlap ? 6000 : 0);
        if (score > bestScore) { bestScore = score; best = { x, y }; }
        if (!farthest && !overlap && minPrey > CFG.npcSafeDist) return { x, y };
      }
      return best;
    }

    spawnNpc(kind, opts = {}) {
      const id = 'npc' + uid++;
      let mass;
      if (kind === 'G') mass = opts.mass || this.giantTarget();
      else mass = rand(NPC_KINDS[kind].min, NPC_KINDS[kind].max);
      const pt = opts.at || this.findNpcSpawn(mass, kind === 'G');
      const npc = {
        id, isNpc: true, kind, hue: kind === 'G' ? 0 : Math.floor(Math.random() * 360), cells: [],
        tx: 0, ty: 0, alive: true, thinkAt: this.time + rand(0, 0.3), wanderX: pt.x, wanderY: pt.y,
        wanderAt: 0, swarm: opts.swarm || 0, leader: opts.leader || null,
        offX: opts.offX || 0, offY: opts.offY || 0,
      };
      const c = this.makeCell(npc, pt.x, pt.y, mass);
      c.ghostUntil = this.time + CFG.ghostTime;
      npc.cells.push(c);
      this.owners.set(id, npc);
      return npc;
    }
    spawnSwarm() {
      const pt = this.findNpcSpawn(15 * 6, false);
      const sw = this.swarmSeq++;
      const leader = this.spawnNpc('SW', { at: pt, swarm: sw });
      for (let i = 1; i < 6; i++) {
        const a = (i / 5) * Math.PI * 2;
        this.spawnNpc('SW', { at: { x: pt.x + Math.cos(a) * 60, y: pt.y + Math.sin(a) * 60 }, swarm: sw, leader: leader.id, offX: Math.cos(a) * 60, offY: Math.sin(a) * 60 });
      }
    }

    npcQuota() {
      const n = this.players().length;
      const N = Math.max(10, 40 - n * 3);
      const giant = 1;
      const L = Math.max(1, Math.round(N * 0.1));
      const M = Math.max(2, Math.round(N * 0.25));
      const swarms = N >= 30 ? 2 : N >= 20 ? 1 : 0;
      const S = Math.max(2, N - giant - L - M - swarms * 6);
      return { N, G: giant, L, M, SW: swarms, S };
    }
    npcCounts() {
      const c = { G: 0, L: 0, M: 0, S: 0, SW: 0, total: 0 };
      const swarmSizes = {};
      for (const o of this.owners.values()) if (o.isNpc) {
        c.total++;
        if (o.kind === 'SW') swarmSizes[o.swarm] = (swarmSizes[o.swarm] || 0) + 1;
        else c[o.kind]++;
      }
      for (const k in swarmSizes) if (swarmSizes[k] >= 3) c.SW++;
      return c;
    }
    // 足りないサイズ帯を補充する
    balanceNpcs(initial) {
      const q = this.npcQuota();
      let c = this.npcCounts();
      let guard = 0;
      while (c.total < q.N && guard++ < 60) {
        if (c.G < q.G) this.spawnNpc('G');
        else if (c.SW < q.SW && c.total + 6 <= q.N + 5) this.spawnSwarm();
        else {
          const def = [['L', q.L - c.L], ['M', q.M - c.M], ['S', q.S - c.S]].sort((a, b) => b[1] - a[1]);
          this.spawnNpc(def[0][1] > 0 ? def[0][0] : 'S');
        }
        c = this.npcCounts();
      }
      if (c.G < q.G) this.spawnNpc('G');
    }

    giantTarget() {
      let maxP = CFG.startMass;
      for (const p of this.owners.values()) if (!p.isNpc && p.alive) maxP = Math.max(maxP, this.massOf(p));
      return clamp(maxP * CFG.giantRatio, CFG.giantMin, CFG.giantMax);
    }

    massOf(o) { let m = 0; for (const c of o.cells) m += c.mass; return m; }
    centerOf(o) {
      let x = 0, y = 0, m = 0;
      for (const c of o.cells) { x += c.x * c.mass; y += c.y * c.mass; m += c.mass; }
      return m ? { x: x / m, y: y / m } : { x: this.size / 2, y: this.size / 2 };
    }

    // ---------- 行動 ----------
    splitOwner(o, tx, ty, relative) {
      const center = this.centerOf(o);
      const gx = relative ? center.x + tx : tx, gy = relative ? center.y + ty : ty;
      const list = o.cells.slice().sort((a, b) => b.mass - a.mass);
      let count = o.cells.length;
      for (const c of list) {
        if (count >= CFG.maxCells) break;
        if (c.mass < CFG.splitMin) continue;
        let dx = gx - c.x, dy = gy - c.y;
        const d = Math.hypot(dx, dy) || 1;
        dx /= d; dy /= d;
        const half = c.mass / 2;
        c.mass = half;
        const r = radius(half);
        const n = this.makeCell(o, c.x + dx * r, c.y + dy * r, half);
        const v0 = 820 + r * 2.5;
        n.vx = dx * v0; n.vy = dy * v0;
        n.mergeAt = this.time + CFG.mergeTime;
        c.mergeAt = this.time + CFG.mergeTime;
        n.ghostUntil = c.ghostUntil;
        o.cells.push(n);
        count++;
      }
    }
    ejectOwner(o) {
      const center = this.centerOf(o);
      for (const c of o.cells) {
        if (c.mass < CFG.ejectMin) continue;
        let dx = center.x + o.tx - c.x, dy = center.y + o.ty - c.y;
        const d = Math.hypot(dx, dy) || 1;
        dx /= d; dy /= d;
        c.mass -= CFG.ejectCost;
        const r = radius(c.mass);
        const a = Math.atan2(dy, dx) + rand(-0.15, 0.15);
        this.ejected.push({
          id: uid++, x: c.x + Math.cos(a) * (r + 12), y: c.y + Math.sin(a) * (r + 12),
          vx: Math.cos(a) * 900, vy: Math.sin(a) * 900, mass: CFG.ejectMass,
          hue: o.hue, from: o.id, safeUntil: this.time + 0.3, born: this.time,
        });
      }
    }

    // セルを破裂させる（ウイルス・隕石）
    popCell(c, extra) {
      const o = c.owner;
      c.mass += extra;
      const avail = CFG.maxCells - o.cells.length;
      if (avail <= 0) return;
      const pieces = Math.min(avail, clamp(Math.floor(c.mass / 40), 2, 10));
      const keep = c.mass / 2;
      const each = (c.mass - keep) / pieces;
      c.mass = keep;
      c.mergeAt = this.time + CFG.mergeTime;
      const base = Math.random() * Math.PI * 2;
      for (let i = 0; i < pieces; i++) {
        const a = base + (i / pieces) * Math.PI * 2;
        const n = this.makeCell(o, c.x + Math.cos(a) * 10, c.y + Math.sin(a) * 10, each);
        n.vx = Math.cos(a) * 650; n.vy = Math.sin(a) * 650;
        n.mergeAt = this.time + CFG.mergeTime;
        o.cells.push(n);
      }
    }

    notice(text, kind) {
      this.notices.push({ id: uid++, text, kind: kind || 'info', t: this.time });
      if (this.notices.length > 8) this.notices.shift();
    }

    // ---------- NPC AI ----------
    think(npc) {
      if (!npc.cells.length) return;
      const center = this.centerOf(npc);
      let main = npc.cells[0];
      for (const c of npc.cells) if (c.mass > main.mass) main = c;
      const m = main.mass;
      const total = this.massOf(npc);
      const view = 550 + radius(total) * 2.2;
      const mistake = Math.random() < 0.08;
      let fx = 0, fy = 0, threat = false;
      let prey = null, preyScore = 0;
      const giant = npc.kind === 'G';

      this.cellGrid.query(center.x - view, center.y - view, center.x + view, center.y + view, (c) => {
        if (c.owner === npc) return;
        if (c.ghostUntil > this.time) return;
        const dx = c.x - center.x, dy = c.y - center.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d > view) return;
        const cr = radius(c.mass);
        if (c.mass >= m * 1.2) {
          // 脅威（ヌシは逃げない）
          if (giant) return;
          const w = 1 / Math.max(30, d - cr);
          fx -= (dx / d) * w; fy -= (dy / d) * w; threat = true;
        } else if (m >= c.mass * 1.3) {
          // ヌシはプレイヤーを優先して追う
          const bias = giant ? (c.owner.isNpc ? 0.2 : 3) : 1;
          const s = (c.mass / (d + 50)) * bias;
          if (s > preyScore) { preyScore = s; prey = c; }
        }
      });

      let tx, ty;
      if (threat && !mistake) {
        const fl = Math.hypot(fx, fy) || 1;
        tx = center.x + (fx / fl) * 500; ty = center.y + (fy / fl) * 500;
        // 小さいうちはウイルスの陰に隠れる
        if (m < 110) {
          let best = null, bd = 350 * 350;
          for (const v of this.viruses) {
            const d = dist2(v.x, v.y, center.x, center.y);
            if (d < bd) { bd = d; best = v; }
          }
          if (best) { tx = best.x; ty = best.y; }
        }
      } else if (prey) {
        tx = prey.x + prey.vx * 0.15; ty = prey.y + prey.vy * 0.15;
        const d = Math.hypot(prey.x - main.x, prey.y - main.y);
        const canSplit = !giant && m >= 200 && npc.cells.length < 4 && m / 2 >= prey.mass * 1.3;
        if (canSplit && d < radius(m / 2) * 4 + 120 && d > radius(m) * 0.8 && Math.random() < 0.35) {
          this.splitOwner(npc, tx, ty, false);
        }
      } else if (npc.kind === 'SW' && npc.leader && this.owners.has(npc.leader)) {
        const ld = this.owners.get(npc.leader);
        const lc = this.centerOf(ld);
        tx = lc.x + npc.offX; ty = lc.y + npc.offY;
      } else {
        // エサを探す、なければ徘徊
        let best = null, bd = 380 * 380;
        if (!giant) {
          this.pelletGrid.query(center.x - 380, center.y - 380, center.x + 380, center.y + 380, (p) => {
            const d = dist2(p.x, p.y, center.x, center.y);
            if (d < bd) { bd = d; best = p; }
          });
        }
        if (best && Math.random() < 0.85) { tx = best.x; ty = best.y; }
        else {
          if (this.time > npc.wanderAt || dist2(npc.wanderX, npc.wanderY, center.x, center.y) < 80 * 80) {
            if (giant) {
              // ヌシはプレイヤーの方へゆっくり寄っていく
              const ps = this.players().filter((p) => p.alive);
              if (ps.length && Math.random() < 0.6) {
                const t = this.centerOf(ps[Math.floor(Math.random() * ps.length)]);
                npc.wanderX = t.x + rand(-400, 400); npc.wanderY = t.y + rand(-400, 400);
              } else { npc.wanderX = rand(300, this.size - 300); npc.wanderY = rand(300, this.size - 300); }
            } else {
              npc.wanderX = clamp(center.x + rand(-900, 900), 100, this.size - 100);
              npc.wanderY = clamp(center.y + rand(-900, 900), 100, this.size - 100);
            }
            npc.wanderAt = this.time + rand(3, 7);
          }
          tx = npc.wanderX; ty = npc.wanderY;
        }
      }

      // 大きいNPCはウイルスを避ける
      if (m >= CFG.virusMass * 1.33) {
        let ax = 0, ay = 0;
        for (const v of this.viruses) {
          const dx = center.x - v.x, dy = center.y - v.y;
          const d = Math.hypot(dx, dy) || 1;
          const lim = radius(m) + 160;
          if (d < lim) { ax += (dx / d) * (lim - d); ay += (dy / d) * (lim - d); }
        }
        tx += ax * 3; ty += ay * 3;
      }

      npc.tx = tx - center.x; npc.ty = ty - center.y;
      npc.thinkAt = this.time + 0.1 + Math.random() * 0.3;
    }

    // ---------- 1ステップ ----------
    step(dt) {
      if (this.ended) return;
      this.time += dt;
      const T = this.time;
      const size = this.size;

      // グリッド構築
      this.cellGrid.clear();
      for (const o of this.owners.values()) for (const c of o.cells) this.cellGrid.add(c);
      this.pelletGrid.clear();
      for (const p of this.pellets) this.pelletGrid.add(p);

      // NPC思考
      for (const o of this.owners.values()) if (o.isNpc && T >= o.thinkAt) this.think(o);

      // プレイヤー：リスポーン・射出
      for (const o of this.owners.values()) {
        if (o.isNpc) continue;
        if (!o.alive && T >= o.respawnAt) this.respawnPlayer(o);
        if (o.alive && o.ejectHeld) {
          o.ejectCd -= dt;
          if (o.ejectCd <= 0) { this.ejectOwner(o); o.ejectCd = 0.1; }
        }
      }

      // 移動
      for (const o of this.owners.values()) {
        if (!o.cells.length) continue;
        const center = this.centerOf(o);
        const gx = center.x + o.tx, gy = center.y + o.ty;
        const mul = o.kind === 'G' ? CFG.giantSpeedMul : 1;
        for (const c of o.cells) {
          let dx = gx - c.x, dy = gy - c.y;
          const d = Math.hypot(dx, dy);
          if (d > 1) {
            const sp = speedOf(c.mass) * mul * Math.min(1, d / 60);
            c.x += (dx / d) * sp * dt; c.y += (dy / d) * sp * dt;
          }
          if (c.vx || c.vy) {
            c.x += c.vx * dt; c.y += c.vy * dt;
            const k = Math.exp(-3.2 * dt);
            c.vx *= k; c.vy *= k;
            if (Math.abs(c.vx) + Math.abs(c.vy) < 8) { c.vx = 0; c.vy = 0; }
          }
          const r = radius(c.mass);
          c.x = clamp(c.x, r * 0.5, size - r * 0.5);
          c.y = clamp(c.y, r * 0.5, size - r * 0.5);
        }
        // 自分のセル同士：押し合い or 合体
        const cs = o.cells;
        for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
          const a = cs[i], b = cs[j];
          if (a.mass <= 0 || b.mass <= 0) continue;
          const ra = radius(a.mass), rb = radius(b.mass);
          const dx = b.x - a.x, dy = b.y - a.y;
          const d = Math.hypot(dx, dy) || 0.01;
          const canMerge = T >= a.mergeAt && T >= b.mergeAt;
          if (canMerge) {
            if (d < Math.max(ra, rb) - Math.min(ra, rb) * 0.3) {
              const big = a.mass >= b.mass ? a : b, small = big === a ? b : a;
              big.mass += small.mass; small.mass = 0;
            }
          } else if (d < ra + rb) {
            const fast = Math.abs(a.vx) + Math.abs(a.vy) + Math.abs(b.vx) + Math.abs(b.vy) > 300;
            if (fast) continue;
            const push = (ra + rb - d) * 0.5;
            const tot = a.mass + b.mass;
            a.x -= (dx / d) * push * (b.mass / tot); a.y -= (dy / d) * push * (b.mass / tot);
            b.x += (dx / d) * push * (a.mass / tot); b.y += (dy / d) * push * (a.mass / tot);
          }
        }
        o.cells = cs.filter((c) => c.mass > 0);
      }

      // 射出物・ウイルスの移動
      for (const e of this.ejected) {
        e.x += e.vx * dt; e.y += e.vy * dt;
        const k = Math.exp(-3.2 * dt); e.vx *= k; e.vy *= k;
        e.x = clamp(e.x, 10, size - 10); e.y = clamp(e.y, 10, size - 10);
      }
      for (const v of this.viruses) {
        if (!v.vx && !v.vy) continue;
        v.x += v.vx * dt; v.y += v.vy * dt;
        const k = Math.exp(-2.5 * dt); v.vx *= k; v.vy *= k;
        if (Math.abs(v.vx) + Math.abs(v.vy) < 5) { v.vx = 0; v.vy = 0; }
        v.x = clamp(v.x, 60, size - 60); v.y = clamp(v.y, 60, size - 60);
      }

      // 射出物 → ウイルスに当たると育つ
      for (const e of this.ejected) {
        if (e.mass <= 0) continue;
        for (const v of this.viruses) {
          if (dist2(e.x, e.y, v.x, v.y) < radius(v.mass) ** 2) {
            v.feeds++; e.mass = 0;
            if (v.feeds >= CFG.virusFeeds && this.viruses.length < CFG.virusCount * 2) {
              v.feeds = 0;
              const sp = Math.hypot(e.vx, e.vy) || 1;
              const dx = e.vx / sp || Math.cos(Math.random() * 6.28), dy = e.vy / sp || Math.sin(Math.random() * 6.28);
              this.spawnVirus(v.x + dx * 80, v.y + dy * 80, dx * 900, dy * 900);
            }
            break;
          }
        }
      }

      // 再構築（移動後）
      this.cellGrid.clear();
      const allCells = [];
      for (const o of this.owners.values()) for (const c of o.cells) { this.cellGrid.add(c); allCells.push(c); }

      // 捕食：エサ
      const eatenPellets = new Set();
      for (const c of allCells) {
        const r = radius(c.mass);
        this.pelletGrid.query(c.x - r, c.y - r, c.x + r, c.y + r, (p) => {
          if (eatenPellets.has(p)) return;
          if (dist2(p.x, p.y, c.x, c.y) < r * r) { eatenPellets.add(p); c.mass += 1; }
        });
      }
      if (eatenPellets.size) this.pellets = this.pellets.filter((p) => !eatenPellets.has(p));

      // 捕食：射出物・ゴールデンエサ
      for (const c of allCells) {
        const r = radius(c.mass);
        for (const e of this.ejected) {
          if (e.mass <= 0) continue;
          if (e.from === c.owner.id && T < e.safeUntil) continue;
          if (c.mass < e.mass * CFG.eatRatio) continue;
          if (dist2(e.x, e.y, c.x, c.y) < r * r) { c.mass += e.mass; e.mass = 0; }
        }
        for (const g of this.golden) {
          if (g.taken) continue;
          if (dist2(g.x, g.y, c.x, c.y) < (r + 10) * (r + 10)) {
            g.taken = true; c.mass += CFG.goldenMass;
            if (!c.owner.isNpc) this.notice(`${c.owner.name} がゴールデンエサを獲得！`, 'gold');
          }
        }
      }
      this.ejected = this.ejected.filter((e) => e.mass > 0 && T - e.born < 60);
      this.golden = this.golden.filter((g) => !g.taken && T < g.until);

      // 捕食：セル同士
      const sorted = allCells.slice().sort((a, b) => b.mass - a.mass);
      for (const a of sorted) {
        if (a.mass <= 0) continue;
        if (a.ghostUntil > T) continue;
        const ra = radius(a.mass);
        this.cellGrid.query(a.x - ra, a.y - ra, a.x + ra, a.y + ra, (b) => {
          if (b === a || b.mass <= 0 || a.mass <= 0) return;
          if (b.owner === a.owner) return;
          if (b.ghostUntil > T) return;
          if (a.mass < b.mass * CFG.eatRatio) return;
          const rb = radius(b.mass);
          if (dist2(a.x, a.y, b.x, b.y) > (ra - rb * 0.35) ** 2) return;
          let gain = b.mass;
          if (!b.owner.isNpc && b.owner.id === this.bountyId) gain *= 1 + CFG.bountyBonus;
          a.mass += gain;
          b.mass = 0;
          if (!b.owner.isNpc) b.owner.lastHitBy = a.owner.isNpc ? (a.owner.kind === 'G' ? 'ヌシ' : 'NPC') : a.owner.name;
        });
      }

      // ウイルス：大きいセルが飲み込むと破裂
      for (const v of this.viruses) {
        if (v.dead) continue;
        const vr = radius(v.mass);
        this.cellGrid.query(v.x - 400, v.y - 400, v.x + 400, v.y + 400, (c) => {
          if (v.dead || c.mass <= 0) return;
          if (c.mass < v.mass * 1.33) return;
          const r = radius(c.mass);
          if (dist2(v.x, v.y, c.x, c.y) > (r - vr * 0.3) ** 2) return;
          v.dead = true;
          this.popCell(c, v.mass);
        });
      }
      const before = this.viruses.length;
      this.viruses = this.viruses.filter((v) => !v.dead);
      for (let i = this.viruses.length; i < Math.min(before, CFG.virusCount); i++) this.spawnVirus();
      while (this.viruses.length < CFG.virusCount) this.spawnVirus();

      // 隕石
      this.updateMeteors(dt);

      // 減衰・死亡判定
      for (const o of Array.from(this.owners.values())) {
        o.cells = o.cells.filter((c) => c.mass > 0);
        const total = this.massOf(o);
        if (o.isNpc) {
          if (o.kind !== 'G') {
            const cap = NPC_KINDS[o.kind].cap;
            if (total > cap) for (const c of o.cells) c.mass -= c.mass * 0.01 * dt;
            else if (total > CFG.decayMin) for (const c of o.cells) c.mass -= c.mass * CFG.decayRate * dt;
          }
        } else if (total > CFG.decayMin) {
          for (const c of o.cells) c.mass -= c.mass * CFG.decayRate * dt;
        }
        if (!o.cells.length) {
          if (o.isNpc) {
            this.owners.delete(o.id);
          } else if (o.alive) {
            o.alive = false;
            o.respawnAt = T + CFG.respawnDelay;
            o.killedBy = o.lastHitBy || '';
            if (o.id === this.bountyId) this.notice(`賞金首 ${o.name} が食べられた！`, 'bounty');
          }
        }
      }

      // NPC補充・ヌシの維持（毎秒）
      if (T >= this.npcCheckAt) {
        this.npcCheckAt = T + 1;
        this.maintainGiant();
      }
      // 死んだNPCはすぐ補充
      this.balanceNpcs(false);

      // エサ補充
      const pelletTarget = Math.round(CFG.pelletCount * (size / CFG.baseSize) ** 2 * (this.feverOn ? 2 : 1));
      for (let i = 0; i < 25 && this.pellets.length < pelletTarget; i++) this.spawnPellet();

      // ゴールデンエサ
      if (T >= this.nextGolden) {
        this.spawnGolden();
        this.nextGolden = T + (this.feverOn ? CFG.goldenFeverInterval : CFG.goldenInterval);
      }

      // ラストフィーバー
      const left = this.matchTime - T;
      if (!this.feverOn && left <= CFG.feverLeft) {
        this.feverOn = true;
        this.nextGolden = Math.min(this.nextGolden, T + 3);
        this.notice('ラストフィーバー！ エサ2倍', 'fever');
      }

      // ランキング・賞金首
      this.updateRanking();

      if (T >= this.matchTime) {
        this.ended = true;
        this.updateRanking();
        this.result = this.ranking.map((r, i) => ({ rank: i + 1, ...r }));
      }
    }

    maintainGiant() {
      const target = this.giantTarget();
      let giant = null;
      for (const o of this.owners.values()) if (o.isNpc && o.kind === 'G') giant = o;
      if (!giant) { this.spawnNpc('G'); return; }
      const m = this.massOf(giant);
      if (m < target) {
        const add = Math.min(target - m, Math.max(target * 0.05, 30));
        let main = giant.cells[0];
        for (const c of giant.cells) if (c.mass > main.mass) main = c;
        main.mass += add;
      } else if (m > target * 1.4) {
        for (const c of giant.cells) c.mass *= 0.97;
      }
    }

    spawnGolden() {
      const ps = this.players().filter((p) => p.alive).sort((a, b) => this.massOf(a) - this.massOf(b));
      const lower = ps.slice(0, Math.max(1, Math.ceil(ps.length / 2)));
      for (let i = 0; i < 3; i++) {
        let x, y;
        if (lower.length && Math.random() < 0.75) {
          const c = this.centerOf(lower[Math.floor(Math.random() * lower.length)]);
          const a = Math.random() * Math.PI * 2, d = rand(300, 650);
          x = clamp(c.x + Math.cos(a) * d, 50, this.size - 50); y = clamp(c.y + Math.sin(a) * d, 50, this.size - 50);
        } else { x = rand(100, this.size - 100); y = rand(100, this.size - 100); }
        this.golden.push({ id: uid++, x, y, until: this.time + CFG.goldenLife });
      }
      this.notice('ゴールデンエサが出現！', 'gold');
    }

    updateMeteors(dt) {
      const T = this.time;
      for (const at of CFG.meteorChecks) {
        if (!this.meteorChecked[at] && T >= at) {
          this.meteorChecked[at] = true;
          if (Math.random() < CFG.meteorChance) {
            this.meteorUntil = T + CFG.meteorDuration;
            this.notice('流星群が来た！ 大きいセルは割れる！', 'meteor');
          }
        }
      }
      if (T < this.meteorUntil && T >= this.meteorNext) {
        this.meteorNext = T + 0.25;
        let x, y;
        const big = [];
        for (const o of this.owners.values()) for (const c of o.cells) if (c.mass >= CFG.meteorPopMass) big.push(c);
        if (big.length && Math.random() < 0.5) {
          const c = big[Math.floor(Math.random() * big.length)];
          x = c.x + rand(-450, 450); y = c.y + rand(-450, 450);
        } else { x = rand(0, this.size); y = rand(0, this.size); }
        this.meteors.push({ id: uid++, x: clamp(x, 0, this.size), y: clamp(y, 0, this.size), hitAt: T + CFG.meteorWarn, hit: false });
      }
      for (const mt of this.meteors) {
        if (mt.hit || T < mt.hitAt) continue;
        mt.hit = true;
        this.cellGrid.query(mt.x - 800, mt.y - 800, mt.x + 800, mt.y + 800, (c) => {
          if (c.mass < CFG.meteorPopMass) return;
          const r = radius(c.mass);
          if (dist2(c.x, c.y, mt.x, mt.y) < (r + CFG.meteorRadius) ** 2) this.popCell(c, 0);
        });
      }
      this.meteors = this.meteors.filter((mt) => T < mt.hitAt + 0.5);
    }

    updateRanking() {
      const ps = this.players();
      this.ranking = ps.map((p) => ({ id: p.id, name: p.name, score: Math.floor(this.massOf(p)), hue: p.hue }))
        .sort((a, b) => b.score - a.score);
      const r = this.ranking;
      let bounty = null;
      if (r.length >= 2 && r[0].score >= CFG.bountyMinScore && r[0].score >= r[1].score * CFG.bountyRatio) bounty = r[0].id;
      if (bounty !== this.bountyId) {
        if (bounty) {
          const p = this.owners.get(bounty);
          if (p) this.notice(`${p.name} が賞金首に！ 食べると1.5倍`, 'bounty');
        }
        this.bountyId = bounty;
      }
    }

    // ---------- 視点ごとのスナップショット ----------
    view(id, vw, vh) {
      const p = this.owners.get(id);
      const T = this.time;
      let cx = this.size / 2, cy = this.size / 2, total = 0, zoom = 0.5;
      if (p && p.cells.length) {
        const c = this.centerOf(p);
        cx = c.x; cy = c.y;
        total = this.massOf(p);
        let spread = 0;
        for (const cell of p.cells) spread = Math.max(spread, Math.hypot(cell.x - cx, cell.y - cy) + radius(cell.mass));
        zoom = Math.pow(CFG.startMass / Math.max(CFG.startMass, total), 0.22);
        const fit = Math.min(vw, vh) * 0.42 / Math.max(spread, 1);
        zoom = Math.min(zoom, fit);
        zoom = clamp(zoom, 0.12, 1);
      } else if (p && p.lastView) {
        cx = p.lastView.cx; cy = p.lastView.cy; zoom = p.lastView.zoom;
      }
      if (p) p.lastView = { cx, cy, zoom };
      const scale = drawScale(zoom, vw, vh);
      const hw = vw / 2 / scale + 120, hh = vh / 2 / scale + 120;
      const x0 = cx - hw, x1 = cx + hw, y0 = cy - hh, y1 = cy + hh;
      const inView = (x, y, r) => x + r > x0 && x - r < x1 && y + r > y0 && y - r < y1;

      const cells = [];
      for (const o of this.owners.values()) for (const c of o.cells) {
        const r = radius(c.mass);
        if (!inView(c.x, c.y, r)) continue;
        cells.push({
          i: c.id, x: Math.round(c.x), y: Math.round(c.y), m: Math.round(c.mass),
          h: o.hue, n: o.isNpc ? '' : o.name, k: o.isNpc ? o.kind : 'P',
          g: c.ghostUntil > T ? 1 : 0, b: (!o.isNpc && o.id === this.bountyId) ? 1 : 0, me: o.id === id ? 1 : 0,
        });
      }
      const pellets = [];
      for (const pl of this.pellets) if (inView(pl.x, pl.y, 5)) pellets.push(Math.round(pl.x), Math.round(pl.y), pl.hue);
      const viruses = [];
      for (const v of this.viruses) if (inView(v.x, v.y, 80)) viruses.push({ i: v.id, x: Math.round(v.x), y: Math.round(v.y), m: v.mass });
      const ejected = [];
      for (const e of this.ejected) if (inView(e.x, e.y, 30)) ejected.push({ i: e.id, x: Math.round(e.x), y: Math.round(e.y), h: e.hue });
      const golden = [];
      for (const g of this.golden) if (inView(g.x, g.y, 30)) golden.push({ i: g.id, x: Math.round(g.x), y: Math.round(g.y) });
      const meteors = [];
      for (const mt of this.meteors) if (inView(mt.x, mt.y, 150)) meteors.push({ i: mt.id, x: Math.round(mt.x), y: Math.round(mt.y), t: +(mt.hitAt - T).toFixed(2) });

      const myRank = this.ranking.findIndex((r) => r.id === id);
      const players = [];
      for (const o of this.owners.values()) {
        if (o.isNpc || !o.alive || !o.cells.length) continue;
        const c = this.centerOf(o);
        players.push([Math.round(c.x), Math.round(c.y), o.id === id ? 1 : 0, o.id === this.bountyId ? 1 : 0]);
      }
      let giantPos = null;
      for (const o of this.owners.values()) if (o.isNpc && o.kind === 'G' && o.cells.length) {
        const c = this.centerOf(o); giantPos = [Math.round(c.x), Math.round(c.y)];
      }

      return {
        t: T, left: Math.max(0, this.matchTime - T), size: this.size,
        cam: { x: cx, y: cy, zoom },
        me: p ? {
          alive: p.alive, score: Math.floor(total), respawnIn: p.alive ? 0 : Math.max(0, p.respawnAt - T),
          killedBy: p.killedBy || '', rank: myRank + 1, bounty: p.id === this.bountyId,
        } : null,
        cells, pellets, viruses, ejected, golden, meteors,
        ranking: this.ranking.slice(0, 10).map((r) => ({ id: r.id, n: r.name, s: r.score, me: r.id === id ? 1 : 0, b: r.id === this.bountyId ? 1 : 0 })),
        myRow: myRank >= 10 ? { rank: myRank + 1, n: this.ranking[myRank].name, s: this.ranking[myRank].score } : null,
        players, giant: giantPos,
        notices: this.notices.filter((n) => T - n.t < 4).map((n) => ({ i: n.id, text: n.text, k: n.kind })),
        meteor: T < this.meteorUntil, fever: this.feverOn,
        ended: this.ended, result: this.ended ? this.result : null,
      };
    }
  }

  return { Game, CFG, radius, speedOf, drawScale };
});
