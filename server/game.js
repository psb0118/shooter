"use strict";

/* =========================================================
   server/game.js — 팀 데스매치 3D FPS 게임 엔진
========================================================= */

const TICK_RATE = 30;
const STATE_RATE = 15;       // 상태 브로드캐스트 (Hz)
const STATE_TICK = TICK_RATE / STATE_RATE; // 매 N 틱마다 스냅샷 전송
const MATCH_TIME = 240;      // 4분
const KILL_LIMIT = 20;
const RESPAWN_DELAY = 3.0;
const PLAYER_RADIUS = 0.45;
const EYE_HEIGHT = 1.6;
const MOVE_SPEED = 5.5;
const SPRINT_MULT = 1.55;
const ACCEL = 12;
const SHOT_RANGE = 250;
const HEADSHOT_MULT = 1.5;

/* =========================================================
   무기 정의
========================================================= */

const WEAPONS = {
  smg: { id: "smg",  name: "SMG",  dmg: 6,  cadence: 0.115, spread: 0.018, magSize: 30, reloadTime: 1.6, auto: true  },
  ar:  { id: "ar",   name: "AR",   dmg: 11, cadence: 0.125, spread: 0.005, magSize: 30, reloadTime: 2.0, auto: true  },
  sr:  { id: "sr",   name: "SR",   dmg: 55, cadence: 1.05,  spread: 0.0,   magSize: 5,  reloadTime: 2.6, auto: false },
};

/* =========================================================
   맵 정의 — 중앙 구조물 + 팀 스폰
========================================================= */

const MAP = {
  halfSize: 34,
  wallHeight: 5.5,
  obstacles: [
    { x:  0,  z:  0,  w: 10, d: 10 },
    { x: -14, z: -6,  w:  6, d: 14 },
    { x:  14, z: -14, w: 14, d:  6 },
    { x: -14, z:  8,  w: 14, d:  6 },
    { x:  12, z:  12, w:  8, d:  6 },
    { x: -22, z:  0,  w:  4, d: 12 },
    { x:  22, z:  0,  w:  4, d: 12 },
    { x:  0,  z: -20, w: 12, d:  4 },
    { x:  0,  z:  20, w: 12, d:  4 },
  ],
  spawns: {
    red:  [
      { x: -22, z: -22 },
      { x:  -6, z: -26 },
      { x:   6, z: -26 },
      { x:  22, z: -22 },
    ],
    blue: [
      { x: -22, z:  22 },
      { x:  -6, z:  26 },
      { x:   6, z:  26 },
      { x:  22, z:  22 },
    ],
  },
};

/* =========================================================
   수학 유틸
========================================================= */

function clamp(v, mn, mx) { return v < mn ? mn : v > mx ? mx : v; }

/* =========================================================
   광선-박스 교차 (카우스트 슬래브 알고리즘)
   box = {x, z, w, d} (y: 0 ~ wallHeight)
  озвращает t (≥0) 또는 null
========================================================= */

function rayBox(ox, oy, oz, dx, dy, dz, box) {
  const mnX = box.x - box.w / 2, mxX = box.x + box.w / 2;
  const mnZ = box.z - box.d / 2, mxZ = box.z + box.d / 2;
  const mnY = 0, mxY = MAP.wallHeight;
  let t0 = 0, t1 = Infinity;
  const axes = [
    [ox, dx, mnX, mxX],
    [oy, dy, mnY, mxY],
    [oz, dz, mnZ, mxZ],
  ];
  for (const [o, d, mn, mx] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < mn || o > mx) return null;
    } else {
      let ta = (mn - o) / d, tb = (mx - o) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
      if (t0 > t1 || t1 < 0) return null;
    }
  }
  return t0 > 0 ? t0 : 0;
}

/* =========================================================
   광선-구 교차 (플레이어 히트)
   returns t (≥0) 또는 null
========================================================= */

function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const ax = ox - cx, ay = oy - cy, az = oz - cz;
  const a = dx * dx + dy * dy + dz * dz;
  const b = 2 * (ax * dx + ay * dy + az * dz);
  const c = (ax * ax + ay * ay + az * az) - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t = (-b - sq) / (2 * a);
  if (t < 0) t = (-b + sq) / (2 * a);
  if (t < 0) return null;
  return t;
}

/* =========================================================
   충돌 해소 — 원형 플레이어 vs AABB 장애물
========================================================= */

function circleAABB(px, pz, r, box) {
  const hx = box.w / 2, hz = box.d / 2;
  const cx = clamp(px, box.x - hx, box.x + hx);
  const cz = clamp(pz, box.z - hz, box.z + hz);
  const dx = px - cx, dz = pz - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 < r * r) {
    if (d2 < 1e-10) {
      // 플레이어 중심이 박스 안에 — 가장 얇은 축으로 밀어냄
      const penX = (px < box.x ? box.x - hx - r : box.x + hx + r) - px;
      const penZ = (pz < box.z ? box.z - hz - r : box.z + hz + r) - pz;
      if (Math.abs(penX) < Math.abs(penZ)) { px += penX; } else { pz += penZ; }
      return [px, pz];
    }
    const d = Math.sqrt(d2);
    const overlap = r - d;
    px += (dx / d) * overlap;
    pz += (dz / d) * overlap;
    return [px, pz];
  }
  return [px, pz];
}

/* =========================================================
   새 플레이어 생성
========================================================= */

function createPlayer(id, nickname, team, spawnIndex) {
  const spawnPool = MAP.spawns[team];
  const s = spawnPool[spawnIndex % spawnPool.length];
  return {
    id,
    nickname: nickname || "플레이어",
    team,
    x: s.x, y: 0, z: s.z,
    yaw: team === "red" ? Math.PI : 0,
    pitch: 0,
    vx: 0, vz: 0,
    hp: 100,
    alive: true,
    respawnAt: 0,
    weapon: "ar",
    ammo: WEAPONS.ar.magSize,
    reloading: false,
    reloadEndAt: 0,
    lastShootAt: 0,
    keys: { w: false, a: false, s: false, d: false, shift: false },
    firing: false,
    kills: 0,
    deaths: 0,
    walkIndex: 0,
  };
}

/* =========================================================
   무기 리로드
========================================================= */

function startReload(player, now) {
  const wpn = WEAPONS[player.weapon];
  player.reloading = true;
  player.reloadEndAt = now + wpn.reloadTime;
}

function completeReload(player) {
  player.ammo = WEAPONS[player.weapon].magSize;
  player.reloading = false;
}

/* =========================================================
   히트스캔 샷
   returns: { hit: bool, target?, headshot?, dmg?, ox,oy,oz, dx,dy,dz, hitX?,hitY?,hitZ? }
========================================================= */

function shootRay(player, now) {
  const wpn = WEAPONS[player.weapon];
  const spread = wpn.spread;
  const jitter = () => (Math.random() - 0.5) * 2;

  const y2 = player.yaw + jitter() * spread;
  const p2 = player.pitch + jitter() * spread;
  const cp = Math.cos(p2);
  const dx = Math.sin(y2) * cp;
  const dy = Math.sin(p2);
  const dz = Math.cos(y2) * cp;
  const ox = player.x, oy = EYE_HEIGHT, oz = player.z;

  let best = null;

  for (const [, t] of (player._match._playerMap || new Map())) {
    if (t.id === player.id || !t.alive || t.team === player.team) continue;

    // torso sphere + head sphere
    const targets = [
      { cx: t.x, cy: 1.05, cz: t.z, r: 0.55, head: false },
      { cx: t.x, cy: 1.6,  cz: t.z, r: 0.28, head: true  },
    ];

    for (const sphere of targets) {
      const tHit = raySphere(ox, oy, oz, dx, dy, dz, sphere.cx, sphere.cy, sphere.cz, sphere.r);
      if (tHit == null || tHit > SHOT_RANGE) continue;

      // 벽으로 막히는지 검사
      let blocked = false;
      for (const box of MAP.obstacles) {
        const tBox = rayBox(ox, oy, oz, dx, dy, dz, box);
        if (tBox != null && tBox < tHit) { blocked = true; break; }
      }
      if (blocked) continue;

      if (!best || tHit < best.t) {
        best = { t: tHit, target: t, head: sphere.head };
      }
    }
  }

  if (best) {
    const hx = ox + dx * best.t;
    const hy = oy + dy * best.t;
    const hz = oz + dz * best.t;
    const dmg = Math.round(wpn.dmg * (best.head ? HEADSHOT_MULT : 1));
    return { hit: true, target: best.target, head: best.head, dmg, ox, oy, oz, dx, dy, dz, hitX: hx, hitY: hy, hitZ: hz };
  }

  // 벽 충돌 점 찾기
  let wallHitT = SHOT_RANGE;
  for (const box of MAP.obstacles) {
    const tHit = rayBox(ox, oy, oz, dx, dy, dz, box);
    if (tHit != null && tHit < wallHitT) wallHitT = tHit;
  }

  return { hit: false, ox, oy, oz, dx, dy, dz, hitX: ox+dx*wallHitT, hitY: oy+dy*wallHitT, hitZ: oz+dz*wallHitT };
}

/* =========================================================
   매치 생성
========================================================= */

function createMatch(roomId) {
  const match = {
    roomId,
    _playerMap: new Map(),
    teams: { red: [], blue: [] },
    scores: { red: 0, blue: 0 },
    timeLeft: MATCH_TIME,
    tickCount: 0,
    state: "waiting",
    finished: false,
    winner: null,
    startedAt: 0,

    /* 시간 소스 — 테스트에서 교체 가능 */
    _now() { return performance.now() / 1000; },

    addPlayer(p) {
      const team = p.team;
      const idx = match.teams[team].length;
      const player = createPlayer(p.id, p.nickname, team, idx);
      player._match = match;
      match._playerMap.set(p.id, player);
      match.teams[team].push(p.id);
      return player;
    },

    removePlayer(id) {
      const player = match._playerMap.get(id);
      if (!player) return;
      const arr = match.teams[player.team];
      const idx = arr.indexOf(id);
      if (idx !== -1) arr.splice(idx, 1);
      match._playerMap.delete(id);
    },

    start() {
      match.state = "playing";
      match.startedAt = Date.now();
      match.timeLeft = MATCH_TIME;
      match.scores.red = 0;
      match.scores.blue = 0;
      match.finished = false;
      match.winner = null;
      match.tickCount = 0;

      for (const [, p] of match._playerMap) {
        p.hp = 100; p.alive = true;
        p.kills = 0; p.deaths = 0;
        p.ammo = WEAPONS[p.weapon].magSize;
        p.reloading = false;
        p.respawnAt = 0;
        const spawns = MAP.spawns[p.team];
        const s = spawns[p.walkIndex % spawns.length];
        p.x = s.x; p.z = s.z; p.y = 0;
        p.walkIndex++;
        p.keys = { w:false,a:false,s:false,d:false,shift:false };
        p.firing = false;
      }
    },

    input(id, data) {
      const p = match._playerMap.get(id);
      if (!p) return;
      if (data.keys) {
        p.keys.w     = !!data.keys.w;
        p.keys.a     = !!data.keys.a;
        p.keys.s     = !!data.keys.s;
        p.keys.d     = !!data.keys.d;
        p.keys.shift = !!data.keys.shift;
      }
      if (typeof data.yaw === "number")   p.yaw = data.yaw;
      if (typeof data.pitch === "number") p.pitch = data.pitch;
      if (typeof data.firing === "boolean") p.firing = data.firing;
    },

    setWeapon(id, weaponId) {
      const p = match._playerMap.get(id);
      if (!p || !WEAPONS[weaponId]) return;
      if (p.weapon === weaponId) return;
      p.weapon = weaponId;
      p.ammo = WEAPONS[weaponId].magSize;
      p.reloading = false;
      p.firing = false;
    },

    getPlayers() { return [...match._playerMap.values()]; },

    getPlayer(id) { return match._playerMap.get(id) || null; },

    /* 봇 AI용 — 조준점(몸통) 사이에 벽이 있는지 검사 */
    hasLos(aId, bId) {
      const a = match._playerMap.get(aId);
      const b = match._playerMap.get(bId);
      if (!a || !b) return false;
      const ox = a.x, oy = EYE_HEIGHT, oz = a.z;
      const tx = b.x, ty = 1.0, tz = b.z;
      const dx = tx - ox, dy = ty - oy, dz = tz - oz;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      for (const box of MAP.obstacles) {
        const t = rayBox(ox, oy, oz, dx, dy, dz, box);
        if (t != null && t > 0.3 && t < dist - 0.1) return false;
      }
      return true;
    },

    reload(id) {
      const p = match._playerMap.get(id);
      if (!p || !p.alive || p.reloading) return;
      const wpn = WEAPONS[p.weapon];
      if (p.ammo >= wpn.magSize) return;
      startReload(p, match._now());
    },

    tick(dt) {
      if (match.state !== "playing" || match.finished) return [];
      const now = match._now();
      const events = [];

      match.tickCount++;
      match.timeLeft -= dt;

      if (match.timeLeft <= 0) {
        match.timeLeft = 0;
        match.winner = match.scores.red >= match.scores.blue ? "red" : "blue";
        if (match.scores.red === match.scores.blue) match.winner = "draw";
        match.finished = true;
        match.state = "finished";
        events.push({ type: "end", winner: match.winner, scores: { ...match.scores } });
        return events;
      }

      for (const [, p] of match._playerMap) {
        // 리스폰 체크
        if (!p.alive && now >= p.respawnAt) {
          p.alive = true;
          p.hp = 100;
          p.ammo = WEAPONS[p.weapon].magSize;
          p.reloading = false;
          p.firing = false;
          const spawns = MAP.spawns[p.team];
          const s = spawns[p.walkIndex % spawns.length];
          p.x = s.x; p.z = s.z; p.y = 0;
          p.walkIndex++;
          p.vx = 0; p.vz = 0;
          events.push({ type: "spawn", pid: p.id, x: p.x, y: p.y, z: p.z });
        }

        if (!p.alive) continue;

        // 리로드 완료
        if (p.reloading && now >= p.reloadEndAt) {
          completeReload(p);
        }

        // 이동
        const walk = p.keys.shift ? SPRINT_MULT : 1;
        const y = p.yaw;
        let ix = 0, iz = 0;
        if (p.keys.w) { ix += Math.sin(y); iz += Math.cos(y); }
        if (p.keys.s) { ix -= Math.sin(y); iz -= Math.cos(y); }
        if (p.keys.a) { ix -= Math.cos(y); iz += Math.sin(y); }
        if (p.keys.d) { ix += Math.cos(y); iz -= Math.sin(y); }
        const il = Math.sqrt(ix*ix + iz*iz) || 1;
        ix /= il; iz /= il;
        const tx = ix * MOVE_SPEED * walk;
        const tz = iz * MOVE_SPEED * walk;
        p.vx += (tx - p.vx) * Math.min(1, ACCEL * dt);
        p.vz += (tz - p.vz) * Math.min(1, ACCEL * dt);
        p.x += p.vx * dt;
        p.z += p.vz * dt;

        // 장애물 충돌
        for (const box of MAP.obstacles) {
          const [nx, nz] = circleAABB(p.x, p.z, PLAYER_RADIUS, box);
          p.x = nx; p.z = nz;
        }

        // 경계 벽
        const hs = MAP.halfSize - PLAYER_RADIUS;
        p.x = clamp(p.x, -hs, hs);
        p.z = clamp(p.z, -hs, hs);

        // 사격
        if (p.firing && p.alive && !p.reloading && p.ammo > 0) {
          const wpn = WEAPONS[p.weapon];
          if (now - p.lastShootAt >= wpn.cadence) {
            p.lastShootAt = now;
            p.ammo--;

            const result = shootRay(p, now);
            events.push({ type: "shot", pid: p.id, weapon: p.weapon, ...result });

            if (result.hit && result.target) {
              const victim = result.target;
              victim.hp -= result.dmg;
              events.push({ type: "hurt", pid: victim.id, byId: p.id, dmg: result.dmg, headshot: result.head, hp: Math.max(0, victim.hp), hpMax: 100 });

              if (victim.hp <= 0) {
                victim.alive = false;
                victim.respawnAt = now + RESPAWN_DELAY;
                victim.hp = 0;
                victim.deaths++;
                p.kills++;
                match.scores[p.team]++;
                events.push({ type: "kill", killerId: p.id, killerName: p.nickname, killerTeam: p.team, victimId: victim.id, victimName: victim.nickname, victimTeam: victim.team, headshot: result.head });

                // 경기 종료 체크
                if (match.scores[p.team] >= KILL_LIMIT) {
                  match.winner = p.team;
                  match.finished = true;
                  match.state = "finished";
                  events.push({ type: "end", winner: p.team, scores: { ...match.scores } });
                  return events;
                }
              }
            }

            // 자동 리로드
            if (p.ammo <= 0 && !p.reloading) {
              startReload(p, now);
            }
          }
        }
      }

      return events;
    },

    snapshot() {
      const players = [];
      for (const [, p] of match._playerMap) {
        players.push({
          id: p.id, nickname: p.nickname, team: p.team,
          x: p.x, y: p.y, z: p.z,
          yaw: p.yaw, pitch: p.pitch,
          hp: p.hp, alive: p.alive,
          kills: p.kills, deaths: p.deaths,
          weapon: p.weapon, ammo: p.ammo,
          reloading: p.reloading,
          sprinting: p.keys.shift && (p.keys.w || p.keys.a || p.keys.s || p.keys.d),
        });
      }
      return {
        t: match.tickCount,
        timeLeft: Math.max(0, match.timeLeft),
        scores: { ...match.scores },
        players,
        finished: match.finished,
        winner: match.winner,
      };
    },
  };

  return match;
}

module.exports = { WEAPONS, MAP, TICK_RATE, STATE_RATE, createMatch };
