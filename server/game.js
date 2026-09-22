"use strict";

/* =========================================================
   server/game.js — 라운드제 5v5 전술 슈터 게임 엔진
   (발로란트 감성: 스파이크 설치/해체, 라운드당 1생명, 경제)
========================================================= */

const TICK_RATE = 30;
const STATE_RATE = 15;
const STATE_TICK = TICK_RATE / STATE_RATE;

/* ---- 라운드/시간 ---- */
const BUY_TIME = 12;            // 구매 단계 (초)
const ROUND_TIME = 100;         // 전투 라운드 시간 (초)
const SPIKE_TIME = 45;          // 설치 후 폭발 카운트다운 (초)
const SPIKE_PLANT_TIME = 1.5;   // 설치 홀드 시간
const SPIKE_DEFUSE_TIME = 7;    // 해체 홀드 시간
const ROUND_OVER_TIME = 6;      // 라운드 종료 화면 (초)
const ROUNDS_TO_WIN = 13;       // 발로란트식 선 13승

/* ---- 경제 (발로란트 감성) ---- */
const START_MONEY = 800;
const MAX_MONEY = 9000;
const MONEY_KILL = 200;
const MONEY_PLANT = 300;
const MONEY_ROUND_WIN = 3000;
const MONEY_LOSS_BASE = 1900;
const MONEY_LOSS_STEP = 500;
const MONEY_LOSS_MAX = 2900;

/* ---- 이동/사격 ---- */
const PLAYER_RADIUS = 0.45;
const EYE_HEIGHT = 1.6;
const MOVE_SPEED = 5.5;
const SPRINT_MULT = 1.55;
const ACCEL = 12;
const SHOT_RANGE = 250;
const MAX_ORIGIN_DIST = 2.0; // 클라 예측 좌표로 쏜 원점을 서버 위치와 얼마나 벗어날 수 있는지 상한
const MAX_HP = 150;

/* ---- 점프 ---- */
const JUMP_VEL = 6.8;       // 초기 수직 속도 (정지 높이 ~1.28m)
const GRAVITY = 18;         // 중력 가속도

/* ---- 스킬 (연막 / 궁극기) ---- */
const SMOKE_RADIUS = 4.5;
const SMOKE_DURATION = 10;  // 초
const SMOKE_THROW_RANGE = 18;
const SMOKE_COOLDOWN = 22;  // 초
const ULT_THROW_RANGE = 18;
const ULT_RADIUS = 5.5;
const ULT_DMG = 90;
const ULT_PENDING_TIME = 1.2;   // 궁극기 '낙뢰' 발동 전 유도선 (초)
const ULT_CHARGE_KILL = 40;
const ULT_CHARGE_PLANT = 25;
const ULT_CHARGE_DEFUSE = 25;
const ULT_CHARGE_MAX = 100;

function clamp(v, mn, mx) { return v < mn ? mn : v > mx ? mx : v; }
function dist2(ax, az, bx, bz) { const dx = ax - bx, dz = az - bz; return Math.sqrt(dx * dx + dz * dz); }
function rnd(n) { return Math.floor(Math.random() * n); }

/* =========================================================
   무기 정의
   body/head/legs = 부위별 데미지, price = 구매 가격([0]권총 무료)
   moveSpread = 이동 중 추가 확산(0~1), adsSpread = 조준 배율(0.35)
========================================================= */

const WEAPONS = {
  pistol: { id: "pistol", name: "PISTOL",   price: 0,    body: 26, head: 104, legs: 22, cadence: 0.28,  spread: 0.015, magSize: 12, reloadTime: 1.5, auto: false, moveSpread: 1.4, icon: "🔫", desc: "기본 지급 권총. 무료로 매 라운드 재지급." },
  smg:    { id: "smg",    name: "SMG",      price: 1600, body: 22, head: 88,  legs: 19, cadence: 0.085, spread: 0.024, magSize: 30, reloadTime: 1.7, auto: true,  moveSpread: 1.5, adsSpread: 0.4, falloff: { from: 20, to: 40, min: 0.7 }, icon: "💨", desc: "근거리 연사형. 빠른 사격속도로 근접 압박." },
  ar:     { id: "ar",     name: "AR",       price: 2900, body: 30, head: 120, legs: 26, cadence: 0.115, spread: 0.005, magSize: 30, reloadTime: 2.0, auto: true,  moveSpread: 1.25, adsSpread: 0.18, falloff: { from: 30, to: 55, min: 0.8 }, icon: "🎯", desc: "주력 중장거리 소총. 조준(우클릭) 시 정확도 급상승." },
  sr:     { id: "sr",     name: "SNIPER",   price: 4700, body: 99, head: 150, legs: 85, cadence: 1.1,   spread: 0.0,   magSize: 5,  reloadTime: 2.6, auto: false, moveSpread: 0.5, icon: "🔭", desc: "고위력 저격총. 우클릭으로 스코프, 헤드샷 원킬." },
  sg:     { id: "sg",     name: "SHOTGUN",  price: 900,  body: 17, head: 68,  legs: 15, cadence: 0.9,   spread: 0.09,  magSize: 6,  reloadTime: 2.2, auto: false, moveSpread: 1.8, pellets: 8, range: 40, icon: "💥", desc: "근접 샷건. 한 발에 8발의 펠릿, 가까울수록 파괴적." },
};

/* =========================================================
   캐릭터 정의 — 고유 스탯(체력/속도), 스킬(연막), 궁(낙뢰)
   hp/speed = 배율, smokeCd = 연막 쿨다운(초)
   ultRadius/ultDmg = 궁 범위/데미지
========================================================= */

const CHARACTERS = {
  vanguard: {
    id: "vanguard", name: "뱅가드", emoji: "🃏",
    desc: "균형 잡힌 올라운더. 어떤 상황에서도 무난하게 활약합니다.",
    hp: 1.0, speed: 1.0,
    smokeCd: 22,
    ultRadius: ULT_RADIUS, ultDmg: ULT_DMG,
    skillDesc: "연막 [Q] — 조준점 방향 최대 18m에 시야·사격 차단 연막(4.5m, 10초)을 깝니다. 벽에 닿으면 즉시 터집니다.",
    ultDesc: "낙뢰 [X] — 조준점 18m 내에 5.5m 반경 번개를 떨어뜨려 적에게 90 대미지. 킬/설치/해체로 궁 게이지 축적.",
  },
  rush: {
    id: "rush", name: "러시", emoji: "💨",
    desc: "빠른 이동 속도와 짧은 연막 쿨다운. 진격/플랭크에 특화된 공격형.",
    hp: 0.85, speed: 1.15,
    smokeCd: 18,
    ultRadius: 4.5, ultDmg: 110,
    skillDesc: "연막 [Q] — 뱅가드보다 4초 빠른 18초 쿨다운. 전술 기동에 유리합니다.",
    ultDesc: "번개 일격 [X] — 좁지만 강렬한 4.5m 반경, 110 대미지.",
  },
  guard: {
    id: "guard", name: "가드", emoji: "🛡️",
    desc: "높은 체력과 강한 궁극기 범위. 사이트 방어에 특화된 수비형.",
    hp: 1.3, speed: 0.88,
    smokeCd: 26,
    ultRadius: 6.5, ultDmg: 60,
    skillDesc: "연막 [Q] — 쿨다운 26초. 넓은 범위로 진입로를 막습니다.",
    ultDesc: "균열 낙뢰 [X] — 넓은 6.5m 반경에 60 대미지. 진입 차단용.",
  },
  venom: {
    id: "venom", name: "베놈", emoji: "☠️",
    desc: "공·수 균형형. 넓은 궁 범위와 준수한 화력.",
    hp: 0.95, speed: 1.06,
    smokeCd: 20,
    ultRadius: 6.0, ultDmg: 85,
    skillDesc: "연막 [Q] — 쿨다운 20초.",
    ultDesc: "맹독 낙뢰 [X] — 6.0m 반경, 85 대미지.",
  },
};

/* =========================================================
   맵 정의 — 104×104, A/B 사이트, 공격(-z) ↔ 수비(+z)
========================================================= */

const MAPS = {
  center: {
    id: "center",
    name: "센터",
    desc: "균형 잡힌 중앙 구조와 넓은 플랭크. 올라운더 지향.",
    halfSize: 52,
    wallHeight: 5.5,
    obstacles: [
      // 중앙 구조물 (타워 + 남북 블록 — 리듬 있는 배치)
      { x:  0,  z:  0,  w: 12, d: 12 },
      { x:  0,  z: 18,  w:  8, d:  8 },
      { x:  0,  z:-16,  w: 10, d: 10 },
      // 남쪽 중앙 보조 커버
      { x:  0,  z:-30,  w:  3, d:  8 },
      // 동/서 레인 분리 — 길이·위상 비대칭 (인위적 대칭 제거)
      { x:-18,  z: -2,  w:  3, d: 14 },
      { x: 18,  z:  6,  w:  3, d: 18 },
      // 레인 중간 커버 (비대칭 배치)
      { x:-32,  z:-10,  w:  5, d:  7 },
      { x: 40,  z:-12,  w:  7, d:  5 },
      // L자형 진입 커버 (서/동 비대칭)
      { x:-31,  z: 12,  w:  4, d: 10 },
      { x:-40,  z: 19,  w: 10, d:  4 },
      { x: 31,  z: 18,  w:  4, d:  8 },
      { x: 39,  z: 15,  w:  7, d:  4 },
      // 사이트 A 방어 커버
      { x:-31,  z: 28,  w:  6, d:  6 },
      { x:-17,  z: 27,  w:  6, d:  5 },
      // 사이트 B 방어 커버
      { x: 32,  z: 29,  w:  6, d:  5 },
      { x: 18,  z: 28,  w:  4, d:  6 },
      // 중앙-사이트 사이 핀치 커버
      { x:-12,  z: 24,  w:  5, d:  6 },
      { x: 12,  z: 30,  w:  5, d:  5 },
      // 공격측 등진 커버 (외곽 벽에 붙임)
      { x:-38,  z:-34,  w:  4, d: 10 },
      { x: 38,  z:-28,  w:  5, d:  8 },
      // 공격 스폰 근처 스나이퍼 포치 (비대칭)
      { x:-16,  z:-36,  w:  6, d:  4 },
      { x: 16,  z:-38,  w:  6, d:  4 },
      // 수비측 배후 커버 (비대칭)
      { x:-30,  z: 44,  w: 10, d:  4 },
      { x: 32,  z: 43,  w:  8, d:  4 },
      // 넓은 플랭크 벽 (좌우 길이 다르게)
      { x:-44,  z:-12,  w:  4, d: 26 },
      { x: 44,  z:-20,  w:  4, d: 34 },
      // 극단 플랭크 근접 커버 (사선 느낌의 스태거)
      { x:-47,  z:-34,  w:  4, d:  8 },
      { x:-44,  z:-48,  w:  4, d:  8 },
      { x: 46,  z:-42,  w:  6, d:  4 },
      { x: 43,  z:-30,  w:  6, d:  3 },
    ],
    spawns: {
      attack: [
        { x: -24, z: -44 },
        { x:  -8, z: -44 },
        { x:   0, z: -44 },
        { x:   8, z: -44 },
        { x:  24, z: -44 },
      ],
      defend: [
        { x: -24, z:  44 },
        { x:  -8, z:  44 },
        { x:   0, z:  44 },
        { x:   8, z:  44 },
        { x:  24, z:  44 },
      ],
    },
    // 스파이크 설치 구역 (A/B)
    sites: {
      A: { cx: -24, cz: 32, w: 6, d: 6 },
      B: { cx:  24, cz: 32, w: 6, d: 6 },
    },
    // 봇 내비게이션용 접근 경로
    waypoints: {
      A: [
        { x: -28, z: -36 }, { x: -28, z: -18 }, { x: -26, z: 6 }, { x: -24, z: 22 }, { x: -24, z: 30 },
      ],
      B: [
        { x: 28, z: -36 }, { x: 28, z: -18 }, { x: 26, z: 6 }, { x: 24, z: 22 }, { x: 24, z: 30 },
      ],
    },
  },
  canyons: {
    id: "canyons",
    name: "캐니언",
    desc: "좁은 레인과 깊숙한 코너. 근접·갱크 중심 맵.",
    halfSize: 48,
    wallHeight: 6,
    obstacles: [
      { x:  0,  z:   0, w:  8, d:  8 },
      { x:  0,  z:  16, w:  6, d:  6 },
      { x:  0,  z:-15,  w:  6, d:  6 },
      { x:-14,  z:   5, w:  4, d: 16 },
      { x: 14,  z:   5, w:  4, d: 16 },
      { x:-26,  z:-10,  w:  5, d:  6 },
      { x: 26,  z:-10,  w:  5, d:  6 },
      { x:-26,  z: 20,  w:  5, d:  6 },
      { x: 26,  z: 20,  w:  5, d:  6 },
      { x:-36,  z:-26,  w:  4, d: 10 },
      { x: 36,  z:-26,  w:  4, d: 10 },
      { x:-30,  z: 32,  w:  6, d:  6 },
      { x: 30,  z: 32,  w:  6, d:  6 },
      { x:-14,  z:-30,  w:  8, d:  4 },
      { x: 14,  z:-30,  w:  8, d:  4 },
      { x:-40,  z: 10,  w:  4, d: 22 },
      { x: 40,  z: 10,  w:  4, d: 22 },
      { x:  0,  z: 30,  w:  4, d:  4 },
    ],
    spawns: {
      attack: [
        { x: -22, z: -40 },
        { x:  -8, z: -40 },
        { x:   0, z: -40 },
        { x:   8, z: -40 },
        { x:  22, z: -40 },
      ],
      defend: [
        { x: -22, z:  40 },
        { x:  -8, z:  40 },
        { x:   0, z:  40 },
        { x:   8, z:  40 },
        { x:  22, z:  40 },
      ],
    },
    sites: {
      A: { cx: -24, cz: 32, w: 6, d: 6 },
      B: { cx:  24, cz: 32, w: 6, d: 6 },
    },
    waypoints: {
      A: [
        { x: -24, z: -30 }, { x: -24, z: -10 }, { x: -24, z: 14 }, { x: -24, z: 28 },
      ],
      B: [
        { x: 24, z: -30 }, { x: 24, z: -10 }, { x: 24, z: 14 }, { x: 24, z: 28 },
      ],
    },
  },
};

const MAP = MAPS.center; // 기본 맵 (기존 테스트 호환용)

/* =========================================================
   수학 유틸
========================================================= */

function rayBox(ox, oy, oz, dx, dy, dz, box, wallHeight) {
  const mnX = box.x - box.w / 2, mxX = box.x + box.w / 2;
  const mnZ = box.z - box.d / 2, mxZ = box.z + box.d / 2;
  const mnY = 0, mxY = wallHeight || MAP.wallHeight;
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

function circleAABB(px, pz, r, box) {
  const hx = box.w / 2, hz = box.d / 2;
  const cx = clamp(px, box.x - hx, box.x + hx);
  const cz = clamp(pz, box.z - hz, box.z + hz);
  const dx = px - cx, dz = pz - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 < r * r) {
    if (d2 < 1e-10) {
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

function inPlantZone(p, map) {
  const mapData = map || MAP;
  for (const key of ["A", "B"]) {
    const s = mapData.sites[key];
    if (Math.abs(p.x - s.cx) < s.w / 2 + 0.6 && Math.abs(p.z - s.cz) < s.d / 2 + 0.6) return true;
  }
  return false;
}

function lossBonus(streak) {
  return Math.min(MONEY_LOSS_MAX, MONEY_LOSS_BASE + (streak > 0 ? (streak - 1) * MONEY_LOSS_STEP : 0));
}

/* =========================================================
   플레이어 생성
========================================================= */

function createPlayer(id, nickname, team, charId, spawnIndex, map) {
  const role = team === "red" ? "attack" : "defend";
  const mapData = map || MAP;
  const s = mapData.spawns[role][spawnIndex % mapData.spawns[role].length];
  const ch = CHARACTERS[charId] || CHARACTERS.vanguard;
  // 플레이어별 유니크 색상 (알록달록)
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  const playerColor = Math.abs(hash) % 360;
  return {
    id,
    nickname: nickname || "플레이어",
    team,
    charId: ch.id,
    playerColor,
    x: s.x, y: 0, z: s.z,
    yaw: role === "attack" ? 0 : Math.PI,
    pitch: 0,
    vx: 0, vz: 0, vy: 0,
    cx: null, cz: null,      // 클라 예측 좌표(사격 원점용, 서버 위치와 2m 내 제한)
    hp: Math.round(MAX_HP * ch.hp),
    maxHp: Math.round(MAX_HP * ch.hp),
    speedMult: ch.speed,
    alive: true,
    weapon: "pistol",
    ammo: WEAPONS.pistol.magSize,
    reloading: false,
    reloadEndAt: 0,
    lastShootAt: 0,
    trigger: 0,             // 반자동 무기 방아쇠 상승 에지 (누른 순간 1회 발사)
    money: START_MONEY,
    survivedRound: false,
    hasSpike: false,
    planting: false,
    plantingProgress: 0,
    defusing: false,
    ads: false,
    keys: { w: false, a: false, s: false, d: false, shift: false, space: false },
    prevSpace: false,
    firing: false,
    kills: 0,
    deaths: 0,
    walkIndex: 0,
    smokeReadyAt: 0,
    ultCharge: 0,
  };
}

/* =========================================================
   무기/리로드/구매
========================================================= */

function startReload(player, now) {
  player.reloading = true;
  player.reloadEndAt = now + WEAPONS[player.weapon].reloadTime;
}

function setWeaponFree(player, weaponId) {
  player.weapon = weaponId;
  player.ammo = WEAPONS[weaponId].magSize;
  player.reloading = false;
  player.firing = false;
}

/* =========================================================
   히트스캔 샷 — 부위(몸통/헤드/다리)별 데미지 + 거리 감쇠
========================================================= */

function shootRay(player, now) {
  const m = player._match;
  const map = m.map || MAP;
  const wpn = WEAPONS[player.weapon];
  // 발로란트: 이동 중 사격은 부정확, ADS 시 완화 — 단, 조준점에서 크게 벗어나기 전에 판정에 들어가도록 완만한 페널티
  const speed = Math.hypot(player.vx, player.vz);
  // 정지 시 확산 = 무기 기본 스프레드(ADS 0.25~0.35배), 이동 배율(moveSpread)는 점진적으로 적용
  const moveCoeff = 1 + Math.min(1, speed / MOVE_SPEED) * ((wpn.moveSpread ?? 1.6) - 1);
  const adsCoeff = player.ads ? (wpn.adsSpread ?? 0.35) : 1;
  const spread = wpn.spread * adsCoeff * (player.ads ? 1 : moveCoeff);
  const jitter = () => (Math.random() - 0.5) * 2;

  const y2 = player.yaw + jitter() * spread;
  const p2 = player.pitch + jitter() * spread;
  const cp = Math.cos(p2);
  const dx = Math.sin(y2) * cp;
  const dy = Math.sin(p2);
  const dz = Math.cos(y2) * cp;
  // 사격 원점: 클라 예측 좌표(레이턴시 보정) — 서버 좌표와 2m 이내일 때만 사용
  const nearPred = typeof player.cx === "number" && Math.hypot(player.cx - player.x, player.cz - player.z) <= MAX_ORIGIN_DIST;
  const ox = nearPred ? player.cx : player.x;
  const oz = nearPred ? player.cz : player.z;
  const oy = EYE_HEIGHT;

  let best = null;

  for (const [, t] of (player._match._playerMap || new Map())) {
    if (t.id === player.id || !t.alive || t.team === player.team) continue;

    const targets = [
      { cx: t.x, cy: 0.9,  cz: t.z, r: 0.62, part: "body" },
      { cx: t.x, cy: 1.6,  cz: t.z, r: 0.3,  part: "head" },
      { cx: t.x, cy: 0.28, cz: t.z, r: 0.36, part: "legs" },
    ];

      for (const sphere of targets) {
      const tHit = raySphere(ox, oy, oz, dx, dy, dz, sphere.cx, sphere.cy, sphere.cz, sphere.r);
      if (tHit == null || tHit > SHOT_RANGE) continue;

      let blocked = false;
      // 연막 차단
      const smokes = m.smokes || [];
      for (const sm of smokes) {
        if (now - sm.born >= sm.dur) continue;
        const tSmoke = raySphere(ox, oy, oz, dx, dy, dz, sm.x, EYE_HEIGHT * 0.75, sm.z, sm.r);
        if (tSmoke != null && tSmoke < tHit) { blocked = true; break; }
      }
      if (blocked) continue;
      const wallH = map.wallHeight || MAP.wallHeight;
      for (const box of map.obstacles) {
        const tBox = rayBox(ox, oy, oz, dx, dy, dz, box, wallH);
        if (tBox != null && tBox < tHit) { blocked = true; break; }
      }
      if (blocked) continue;

      if (!best || tHit < best.t) {
        best = { t: tHit, target: t, part: sphere.part };
      }
    }
  }

  if (best) {
    const hx = ox + dx * best.t;
    const hy = oy + dy * best.t;
    const hz = oz + dz * best.t;
    let dmg = Math.round(wpn[best.part]);
    if (wpn.range) dmg = Math.round(dmg * Math.max(0.3, 1 - best.t / wpn.range));
    if (wpn.falloff) {
      const f = wpn.falloff;
      if (best.t > f.from) dmg = Math.round(dmg * Math.max(f.min, 1 - (best.t - f.from) / (f.to - f.from)));
    }
    const head = best.part === "head";
    return { hit: true, target: best.target, head, part: best.part, dmg, ox, oy, oz, dx, dy, dz, hitX: hx, hitY: hy, hitZ: hz };
  }

  let wallHitT = SHOT_RANGE;
  for (const box of map.obstacles) {
    const tHit = rayBox(ox, oy, oz, dx, dy, dz, box, map.wallHeight || MAP.wallHeight);
    if (tHit != null && tHit < wallHitT) wallHitT = tHit;
  }

  return { hit: false, ox, oy, oz, dx, dy, dz, hitX: ox + dx * wallHitT, hitY: oy + dy * wallHitT, hitZ: oz + dz * wallHitT };
}

/* =========================================================
   매치 생성 — 라운드제
========================================================= */

function createMatch(roomId, opts) {
  opts = opts || {};
  const map = MAPS[opts.mapId] || MAP;
  const match = {
    roomId,
    map,
    _playerMap: new Map(),
    teams: { red: [], blue: [] },
    scores: { red: 0, blue: 0 },     // 라운드 승수
    round: 0,
    phase: "waiting",                 // waiting | buy | combat | roundover | finished
    phaseEndAt: 0,
    timeLeft: 0,                      // 전투/스파이크 타이머
    tickCount: 0,
    finished: false,
    winner: null,
    attackTeam: "red",
    defendTeam: "blue",
    roundWinner: null,
    roundEndReason: null,
    lossStreak: { red: 0, blue: 0 },
    spike: {
      carrierId: null,
      team: null,
      dropped: false, dropX: 0, dropZ: 0,
      planted: false, plantX: 0, plantZ: 0,
      plantingId: null,
      defusingId: null,
      defuseProgress: 0,
    },
    smokes: [],              // [{id, x, z, r, born, dur}]
    pendingUlts: [],         // [{id, x, z, t}] 낙뢰 예정
    startedAt: 0,

    _now() { return performance.now() / 1000; },

    roleOf(team) { return team === match.attackTeam ? "attack" : "defend"; },

    addPlayer(p) {
      const idx = match.teams[p.team].length;
      const player = createPlayer(p.id, p.nickname, p.team, p.charId, idx, match.map);
      player._match = match;
      match._playerMap.set(p.id, player);
      match.teams[p.team].push(p.id);
      return player;
    },

    removePlayer(id) {
      const player = match._playerMap.get(id);
      if (!player) return;
      if (match.spike.carrierId === id) {
        match.spike.carrierId = null;
        match.spike.dropped = true;
        match.spike.dropX = player.x;
        match.spike.dropZ = player.z;
      }
      if (match.spike.defusingId === id) { match.spike.defusingId = null; match.spike.defuseProgress = 0; }
      const arr = match.teams[player.team];
      const idx = arr.indexOf(id);
      if (idx !== -1) arr.splice(idx, 1);
      match._playerMap.delete(id);
    },

    /* 매치 시작 (첫 라운드) */
    start() {
      match.startedAt = Date.now();
      match.scores.red = 0; match.scores.blue = 0;
      match.lossStreak.red = 0; match.lossStreak.blue = 0;
      match.tickCount = 0;
      match.finished = false;
      match.winner = null;
      match.round = 0;
      for (const [, p] of match._playerMap) {
        p.kills = 0; p.deaths = 0;
        p.survivedRound = false;
      }
      const events = [];
      match._startRound(events);
      return events;
    },

    _startRound(events) {
      const now = match._now();
      match.round++;
      match.phase = "buy";
      match.phaseEndAt = now + BUY_TIME;
      match.timeLeft = BUY_TIME;
      match.roundWinner = null;
      match.roundEndReason = null;
      match.spike.carrierId = null;
      match.spike.team = match.attackTeam;
      match.spike.dropped = false;
      match.spike.planted = false;
      match.spike.plantingId = null;
      match.spike.defusingId = null;
      match.spike.defuseProgress = 0;
      match.smokes = [];
      match.pendingUlts = [];

      const attackers = [];
      for (const [, p] of match._playerMap) {
        // 이전 라운드 생존 → 무기 유지(풀탄창), 전사 → 권총
        if (!p.survivedRound || !WEAPONS[p.weapon] || p.weapon === "pistol") {
          setWeaponFree(p, "pistol");
        } else {
          p.ammo = WEAPONS[p.weapon].magSize;
        }
        p.survivedRound = false;
        p.hasSpike = false;
        const ch = CHARACTERS[p.charId] || CHARACTERS.vanguard;
        p.hp = Math.round(MAX_HP * ch.hp);
        p.maxHp = p.hp;
        p.alive = true;
        p.vx = 0; p.vz = 0;
        p.firing = false;
        p.trigger = 0;
        p.ads = false;
        p.planting = false;
        p.plantingProgress = 0;
        p.defusing = false;
        p.keys = { w: false, a: false, s: false, d: false, shift: false, space: false };
        p.vy = 0;
        p.smokeReadyAt = 0;
        const role = match.roleOf(p.team);
        const s = match.map.spawns[role][p.walkIndex % match.map.spawns[role].length];
        p.x = s.x; p.y = 0; p.z = s.z;
        p.cx = p.x; p.cz = p.z;
        p.yaw = role === "attack" ? 0 : Math.PI;
        p.walkIndex++;
        if (role === "attack") attackers.push(p);
      }

      // 스파이크 캐리어 랜덤 배정 (공격팀)
      if (attackers.length > 0) {
        const carrier = attackers[rnd(attackers.length)];
        match.spike.carrierId = carrier.id;
        carrier.hasSpike = true;
        events.push({ type: "spikecarrier", carrierId: carrier.id });
      }

      events.push({
        type: "roundstart",
        round: match.round,
        phase: "buy",
        attackTeam: match.attackTeam,
        defendTeam: match.defendTeam,
        buyTime: BUY_TIME,
        scores: { ...match.scores },
      });
    },

    _endRound(winner, reason, events) {
      if (match.phase !== "combat") return; // 중복 라운드 종료 방지
      match.roundWinner = winner;
      match.roundEndReason = reason;
      match.scores[winner]++;

      // 경제: 승/패 보상 + 연패 보너스
      const loser = winner === match.attackTeam ? match.defendTeam : match.attackTeam;
      match.lossStreak[winner] = 0;
      match.lossStreak[loser]++;
      for (const [, p] of match._playerMap) {
        const gain = p.team === winner ? MONEY_ROUND_WIN : lossBonus(match.lossStreak[p.team]);
        p.money = clamp(p.money + gain, 0, MAX_MONEY);
        // 발로란트: 승패와 무관하게 "생존"하면 다음 라운드 무기 유지
        p.survivedRound = p.alive && p.hp > 0;
      }

      match.spike.plantingId = null;
      match.spike.defusingId = null;
      match.spike.defuseProgress = 0;
      match.phase = "roundover";
      match.phaseEndAt = match._now() + ROUND_OVER_TIME;

      events.push({ type: "roundend", winner, reason, scores: { ...match.scores }, round: match.round });

      if (match.scores[winner] >= ROUNDS_TO_WIN) {
        match.finished = true;
        match.phase = "finished";
        match.winner = winner;
        events.push({ type: "end", winner, scores: { ...match.scores } });
      }
    },

    /* ---- 입력 ---- */

    input(id, data) {
      const p = match._playerMap.get(id);
      if (!p || !p.alive) return;
      if (data.keys) {
        p.keys.w     = !!data.keys.w;
        p.keys.a     = !!data.keys.a;
        p.keys.s     = !!data.keys.s;
        p.keys.d     = !!data.keys.d;
        p.keys.shift = !!data.keys.shift;
        p.keys.space = !!data.keys.space;
      }
      if (typeof data.yaw === "number")   p.yaw = data.yaw;
      if (typeof data.pitch === "number") p.pitch = data.pitch;
      // 클라 예측 좌표 → 사격 원점 (레이턴시 보정, 서버 위치와 2m 내 제한)
      if (typeof data.x === "number" && typeof data.z === "number") {
        if (Math.hypot(data.x - p.x, data.z - p.z) <= MAX_ORIGIN_DIST) {
          p.cx = data.x; p.cz = data.z;
        } else {
          p.cx = p.x; p.cz = p.z;
        }
      }
      if (typeof data.firing === "boolean") {
        const next = data.firing && match.phase === "combat";
        // 반자동 무기용 트리거: false→true 상승 에지에서 1회 발사
        if (next && !p.firing) p.trigger++;
        p.firing = next;
      }
      if (typeof data.ads === "boolean")   p.ads = data.ads;
    },

    /* ---- 구매: 가격 지불, 전투 직전 무기 변경 ---- */
    buy(id, weaponId) {
      const p = match._playerMap.get(id);
      if (!p || !p.alive || match.phase !== "buy") return false;
      const w = WEAPONS[weaponId];
      if (!w) return false;
      const cost = weaponId === p.weapon ? 0 : w.price;
      if (p.money < cost) return false;
      p.money -= cost;
      setWeaponFree(p, weaponId);
      return true;
    },

    /* ---- 스파이크 상호작용 ---- */
    interact(id, data) {
      const p = match._playerMap.get(id);
      if (!p || !p.alive) return;
      const s = match.spike;
      const start = !!(data && data.action === "start");

      if (!start) {
        p.planting = false;
        p.plantingProgress = 0;
        p.defusing = false;
        if (s.defusingId === p.id) {
          s.defusingId = null;
          // 발로란트: 해체 절반(3.5초)을 넘겼으면 진행 보존, 미만이면 초기화
          if (s.defuseProgress < 0.5) s.defuseProgress = 0;
        }
        return;
      }

      if (data.type === "drop") {
        // 구매 단계에서 캐리어가 스파이크를 버려 팀원에게 전달
        if (p.team === match.attackTeam && p.hasSpike && !s.planted && !s.dropped) {
          s.carrierId = null;
          p.hasSpike = false;
          s.dropped = true;
          s.dropX = p.x;
          s.dropZ = p.z;
        }
        return;
      }

      if (data.type === "pickup") {
        // 구매/전투 어느 페이즈든 공격팀만 드랍 스파이크를 픽업
        if (p.team === match.attackTeam && s.dropped && !s.planted && !p.hasSpike && dist2(p.x, p.z, s.dropX, s.dropZ) <= 2) {
          s.dropped = false;
          s.carrierId = p.id;
          p.hasSpike = true;
        }
        return;
      }

      if (match.phase !== "combat") return;

      if (data.type === "plant") {
        if (p.team !== match.attackTeam || !p.hasSpike) return;
        if (s.planted) return;
        if (!inPlantZone(p, match.map)) return;
        p.planting = true;
        s.plantingId = p.id;
      } else if (data.type === "defuse") {
        if (p.team !== match.defendTeam) return;
        if (!s.planted) return;
        if (dist2(p.x, p.z, s.plantX, s.plantZ) > 4) return;
        if (s.defusingId && s.defusingId !== p.id) return;
        p.defusing = true;
        s.defusingId = p.id;
      }
    },

    /* ---- 스킬 (연막 / 궁극기) ---- */
    skill(id, data) {
      const p = match._playerMap.get(id);
      if (!p || !p.alive || match.phase !== "combat") return;
      const ch = CHARACTERS[p.charId] || CHARACTERS.vanguard;
      const now = match._now();
      const cp = Math.cos(p.pitch);
      const dirX = Math.sin(p.yaw) * cp;
      const dirY = Math.sin(p.pitch);
      const dirZ = Math.cos(p.yaw) * cp;
      const ox = p.x, oy = EYE_HEIGHT, oz = p.z;

      if (data.type === "smoke") {
        if (now < p.smokeReadyAt) return;
        p.smokeReadyAt = now + ch.smokeCd;
        // 투사체 도착: 장애물 또는 사거리
        let landT = SMOKE_THROW_RANGE;
        for (const box of match.map.obstacles) {
          const t = rayBox(ox, oy, oz, dirX, dirY, dirZ, box, match.map.wallHeight || MAP.wallHeight);
          if (t != null && t > 0.5 && t < landT) landT = t;
        }
        const sx = ox + dirX * landT;
        const sz = oz + dirZ * landT;
        match.smokes.push({ id: "smoke_" + id + "_" + match.tickCount, x: sx, z: sz, r: SMOKE_RADIUS, born: now, dur: SMOKE_DURATION });
        return [{ type: "skill:smoke", pid: id, x: sx, z: sz, r: SMOKE_RADIUS, dur: SMOKE_DURATION }];
      }

      if (data.type === "ult") {
        if (p.ultCharge < ULT_CHARGE_MAX) return;
        p.ultCharge = 0;
        let landT = ULT_THROW_RANGE;
        for (const box of match.map.obstacles) {
          const t = rayBox(ox, oy, oz, dirX, dirY, dirZ, box, match.map.wallHeight || MAP.wallHeight);
          if (t != null && t > 0.5 && t < landT) landT = t;
        }
        const ux = ox + dirX * landT;
        const uz = oz + dirZ * landT;
        match.pendingUlts.push({ id: id, x: ux, z: uz, r: ch.ultRadius, dmg: ch.ultDmg, t: now + ULT_PENDING_TIME });
        return [{ type: "skill:ult", pid: id, x: ux, z: uz, r: ch.ultRadius }];
      }

      return [];
    },

    /* ---- 발사 ---- */

    _applyShot(actor, result, events) {
      const victim = result.target;
      victim.hp -= result.dmg;
      events.push({ type: "hurt", pid: victim.id, byId: actor.id, dmg: result.dmg, headshot: result.head, hp: Math.max(0, victim.hp), hpMax: victim.maxHp || MAX_HP });
      // 어시스트 추적 — victim을 최근에 때린 다른 공격자 기록
      const now = match._now();
      match._assistHit = match._assistHit || new Map();
      let vm = match._assistHit.get(victim.id);
      if (!vm) { vm = new Map(); match._assistHit.set(victim.id, vm); }
      vm.set(actor.id, { t: now });

      if (victim.hp <= 0) {
        victim.alive = false;
        victim.hp = 0;
        victim.deaths++;
        actor.kills++;
        actor.money = clamp(actor.money + MONEY_KILL, 0, MAX_MONEY);
        actor.ultCharge = Math.min(ULT_CHARGE_MAX, actor.ultCharge + ULT_CHARGE_KILL);

        // 어시스트 — 최근 8초 내에 victim을 때렸던 동맹 누구에게나 1회 부여
        const hits = match._assistHit ? match._assistHit.get(victim.id) : null;
        if (hits) {
          const now = match._now();
          for (const [aid, rec] of hits) {
            if (aid === actor.id || now - rec.t > 8000) continue;
            const ap = match._playerMap.get(aid);
            if (ap && ap.team === actor.team) {
              ap.assists = (ap.assists || 0) + 1;
              events.push({ type: "assist", pid: ap.id, killerId: victim.id });
            }
          }
          match._assistHit.delete(victim.id);
        }
        events.push({ type: "kill", killerId: actor.id, killerName: actor.nickname, killerTeam: actor.team, weapon: actor.weapon, victimId: victim.id, victimName: victim.nickname, victimTeam: victim.team, headshot: result.head });

        // 캐리어 사망 → 스파이크 드랍
        if (match.spike.carrierId === victim.id) {
          match.spike.carrierId = null;
          victim.hasSpike = false;
          match.spike.dropped = true;
          match.spike.dropX = victim.x;
          match.spike.dropZ = victim.z;
          events.push({ type: "spikedrop", x: victim.x, z: victim.z });
        }
        if (match.spike.plantingId === victim.id) match.spike.plantingId = null;
        if (match.spike.defusingId === victim.id) match.spike.defusingId = null;
      }
    },

    /* ---- 스파이크 틱 ---- */
    _spikeTick(now, dt, events) {
      const s = match.spike;

      if (s.planted) {
        const def = s.defusingId ? match._playerMap.get(s.defusingId) : null;
        const valid = def && def.alive && def.team === match.defendTeam &&
          dist2(def.x, def.z, s.plantX, s.plantZ) <= 4;
        if (valid) {
          s.defuseProgress += dt / SPIKE_DEFUSE_TIME;
          if (s.defuseProgress >= 1) {
            s.planted = false;
            s.defusingId = null;
            s.defuseProgress = 0;
            def.ultCharge = Math.min(ULT_CHARGE_MAX, def.ultCharge + ULT_CHARGE_DEFUSE);
            events.push({ type: "spikedefuse", byId: def.id });
            match._endRound(match.defendTeam, "defuse", events);
            return;
          }
        } else {
          s.defusingId = null;
          // 해체 체크포인트: 절반(3.5초) 미만이면 초기화, 초과면 진행 보존
          if (s.defuseProgress < 0.5) s.defuseProgress = 0;
        }
        return;
      }

      // 설치 진행 (공격팀 캐리어만)
      const planter = s.plantingId ? match._playerMap.get(s.plantingId) : null;
      const plantValid = planter && planter.alive && planter.team === match.attackTeam &&
        planter.hasSpike && inPlantZone(planter, match.map);
      if (plantValid) {
        planter.plantingProgress += dt / SPIKE_PLANT_TIME;
        if (planter.plantingProgress >= 1) {
          s.planted = true;
          s.team = planter.team;
          s.plantX = planter.x;
          s.plantZ = planter.z;
          s.plantingId = null;
          s.defuseProgress = 0;
          s.carrierId = null;
          planter.hasSpike = false;
          planter.plantingProgress = 0;
          planter.planting = false;
          match.timeLeft = SPIKE_TIME;
          planter.money = clamp(planter.money + MONEY_PLANT, 0, MAX_MONEY);
          planter.ultCharge = Math.min(ULT_CHARGE_MAX, planter.ultCharge + ULT_CHARGE_PLANT);
          events.push({ type: "spikeplant", pid: planter.id, x: planter.x, z: planter.z, timeLeft: SPIKE_TIME });
        }
      } else if (s.plantingId) {
        const pp = match._playerMap.get(s.plantingId);
        if (pp) { pp.plantingProgress = 0; pp.planting = false; }
        s.plantingId = null;
      }

      // 픽업 (공격팀만, 드랍 지점 도달 시 즉시)
      if (s.dropped) {
        for (const [, p] of match._playerMap) {
          if (p.team !== match.attackTeam || !p.alive || p.hasSpike) continue;
          if (dist2(p.x, p.z, s.dropX, s.dropZ) < 1.2) {
            s.dropped = false;
            s.carrierId = p.id;
            p.hasSpike = true;
            events.push({ type: "spikepickup", pid: p.id });
            break;
          }
        }
      }
    },

    tick(dt) {
      if (match.finished) return [];
      const now = match._now();
      const events = [];
      match.tickCount++;

      // 구매 → 전투 전환
      if (match.phase === "buy" && now >= match.phaseEndAt) {
        match.phase = "combat";
        match.phaseEndAt = 0;
        match.timeLeft = ROUND_TIME;
        events.push({ type: "phase", phase: "combat", timeLeft: ROUND_TIME });
      }

      const canAct = match.phase === "buy" || match.phase === "combat";

      // 구매/전투 모두 HUD 타이머 카운트다운 (발로란트: 구매단계도 제한시간 표시)
      if (canAct) match.timeLeft -= dt;

      // 플레이어 물리/사격
      if (canAct) {
        for (const [, p] of match._playerMap) {
          if (!p.alive) continue;

          if (p.reloading && now >= p.reloadEndAt) {
            p.ammo = WEAPONS[p.weapon].magSize;
            p.reloading = false;
          }

          // 구매 단계에는 이동 불가 (게임 시작 후/전투 시작 전까지 자리를 지킨다)
          // 이동 (전투 중 + 설치/해체 홀드 중에는 발로란트처럼 고정)
          if (match.phase === "combat" && !p.planting && !p.defusing) {
            const walk = (p.keys.shift ? SPRINT_MULT : 1) * (p.speedMult || 1);
            const y = p.yaw;
            let ix = 0, iz = 0;
            if (p.keys.w) { ix += Math.sin(y); iz += Math.cos(y); }
            if (p.keys.s) { ix -= Math.sin(y); iz -= Math.cos(y); }
            if (p.keys.a) { ix += Math.cos(y); iz -= Math.sin(y); }
            if (p.keys.d) { ix -= Math.cos(y); iz += Math.sin(y); }
            const il = Math.sqrt(ix * ix + iz * iz) || 1;
            ix /= il; iz /= il;
            const tx = ix * MOVE_SPEED * walk;
            const tz = iz * MOVE_SPEED * walk;
            p.vx += (tx - p.vx) * Math.min(1, ACCEL * dt);
            p.vz += (tz - p.vz) * Math.min(1, ACCEL * dt);
            p.x += p.vx * dt;
            p.z += p.vz * dt;

            for (const box of match.map.obstacles) {
              const [nx, nz] = circleAABB(p.x, p.z, PLAYER_RADIUS, box);
              p.x = nx; p.z = nz;
            }
            const hs = match.map.halfSize - PLAYER_RADIUS;
            p.x = clamp(p.x, -hs, hs);
            p.z = clamp(p.z, -hs, hs);
          }

          // 점프 (누르는 순간 1회 — 홀드 시 반복 점프를 막기 위해 상승 에지)
          if (
            p.y <= 0 &&
            p.keys.space &&
            !p.prevSpace &&
            !p.planting &&
            !p.defusing
          ) {
            p.vy = JUMP_VEL;
          }
          p.prevSpace = p.keys.space;
          if (p.y > 0 || p.vy > 0) {
            p.vy -= GRAVITY * dt;
            p.y += p.vy * dt;
            if (p.y <= 0) { p.y = 0; p.vy = 0; }
          }

          // 사격 (전투 단계만)
          if (match.phase === "combat" && !p.reloading && p.ammo > 0) {
            const wpn = WEAPONS[p.weapon];
            const canAuto = wpn.auto && p.firing && now - p.lastShootAt >= wpn.cadence;
            const canSemi = !wpn.auto && p.trigger > 0 && now - p.lastShootAt >= wpn.cadence;
            if (canAuto || canSemi) {
              if (!wpn.auto) p.trigger--;
              p.lastShootAt = now;
              p.ammo--;
              const shots = wpn.pellets || 1;
              for (let k = 0; k < shots; k++) {
                const result = shootRay(p, now);
                events.push({ type: "shot", pid: p.id, weapon: p.weapon, snd: k === 0, ...result });
                if (!result.hit || !result.target) continue;
                match._applyShot(p, result, events);
                const victim = result.target;
                if (!victim.alive) break; // 죽인 탄환에서 중단
              }
              if (p.ammo <= 0 && !p.reloading) {
                startReload(p, now);
              }
            }
          }
        }
      }

      // 연막 만료
      match.smokes = match.smokes.filter(sm => now - sm.born < sm.dur);

      // 궁극기 발동 (낙뢰)
      for (let i = match.pendingUlts.length - 1; i >= 0; i--) {
        const pu = match.pendingUlts[i];
        if (now < pu.t) continue;
        match.pendingUlts.splice(i, 1);
        const rIdx = pu.r || ULT_RADIUS;
        const dmgIdx = pu.dmg || ULT_DMG;
        // 범위 내 적 데미지
        for (const [, ep] of match._playerMap) {
          if (!ep.alive || ep.team === match._playerMap.get(pu.id)?.team) continue;
          const d = dist2(ep.x, ep.z, pu.x, pu.z);
          if (d <= rIdx + PLAYER_RADIUS) {
            ep.hp -= dmgIdx;
            events.push({ type: "hurt", pid: ep.id, byId: pu.id, dmg: dmgIdx, headshot: false, hp: Math.max(0, ep.hp), hpMax: ep.maxHp || MAX_HP });
            if (ep.hp <= 0) {
              ep.alive = false; ep.hp = 0; ep.deaths++;
              const killer = match._playerMap.get(pu.id);
              if (killer) { killer.kills++; killer.money = clamp(killer.money + MONEY_KILL, 0, MAX_MONEY); killer.ultCharge = Math.min(ULT_CHARGE_MAX, killer.ultCharge + ULT_CHARGE_KILL); }
              events.push({ type: "kill", killerId: pu.id, killerName: killer?.nickname||"?", killerTeam: killer?.team||"?", weapon: "ult", victimId: ep.id, victimName: ep.nickname, victimTeam: ep.team, headshot: false });
              if (match.spike.carrierId === ep.id) { match.spike.carrierId = null; ep.hasSpike = false; match.spike.dropped = true; match.spike.dropX = ep.x; match.spike.dropZ = ep.z; }
            }
          }
        }
        events.push({ type: "skill:ultboom", x: pu.x, z: pu.z, r: rIdx });
      }

      // 스파이크 진행 (전투 단계) — 단, 구매 단계에서도 드랍 스파이크 픽업(팀원 전달)은 허용
      if (match.phase === "combat" || (match.phase === "buy" && match.spike.dropped)) {
        match._spikeTick(now, dt, events);

        // 라운드 종료 판정
        if (!match.finished) {
          let aliveAttack = 0, aliveDefend = 0;
          for (const [, p] of match._playerMap) {
            if (!p.alive) continue;
            if (p.team === match.attackTeam) aliveAttack++; else aliveDefend++;
          }

          match.timeLeft = Math.max(0, match.timeLeft);
          let win = null, reason = null;

          if (match.spike.planted) {
            if (match.timeLeft <= 0) { win = match.attackTeam; reason = "detonate"; }
          } else if (match.timeLeft <= 0) {
            win = match.defendTeam; reason = "timeout";
          }

          if (!win && aliveDefend <= 0) { win = match.attackTeam; reason = "elim"; }
          if (!win && aliveAttack <= 0 && !match.spike.planted) { win = match.defendTeam; reason = "elim"; }

          if (win) {
            if (reason === "detonate") events.push({ type: "spikedetonate", x: match.spike.plantX, z: match.spike.plantZ });
            match._endRound(win, reason, events);
          }
        }
      } else if (match.phase === "roundover" && now >= match.phaseEndAt) {
        match._startRound(events);
      }

      return events;
    },

    getPlayers() { return [...match._playerMap.values()]; },

    getPlayer(id) { return match._playerMap.get(id) || null; },

    /* 봇 AI용 — 조준점 사이 벽 검사 */
    hasLos(aId, bId) {
      const a = match._playerMap.get(aId);
      const b = match._playerMap.get(bId);
      if (!a || !b) return false;
      const ox = a.x, oy = EYE_HEIGHT, oz = a.z;
      const tx = b.x, ty = 1.0, tz = b.z;
      let dx = tx - ox, dy = ty - oy, dz = tz - oz;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < 0.001) return true;
      dx /= dist; dy /= dist; dz /= dist; // 정규화 (rayBox t = 거리 m)
      const end = dist - 0.1; // 타깃 직전까지만 차단
      const wallH = match.map.wallHeight || MAP.wallHeight;
      for (const box of match.map.obstacles) {
        const t = rayBox(ox, oy, oz, dx, dy, dz, box, wallH);
        if (t != null && t > 0.3 && t < end) return false;
      }
      // 연막 시야 차단
      const now = match._now();
      for (const sm of match.smokes) {
        if (now - sm.born >= sm.dur) continue;
        const tSmoke = raySphere(ox, oy, oz, dx, dy, dz, sm.x, EYE_HEIGHT * 0.75, sm.z, sm.r);
        if (tSmoke != null && tSmoke > 0.3 && tSmoke < end) return false;
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

    snapshot() {
      const players = [];
      for (const [, p] of match._playerMap) {
        players.push({
          id: p.id, nickname: p.nickname, team: p.team, playerColor: p.playerColor,
          charId: p.charId,
          speedMult: p.speedMult,
          x: p.x, y: p.y, z: p.z,
          yaw: p.yaw, pitch: p.pitch,
          vy: p.vy,
          hp: p.hp, maxHp: p.maxHp, alive: p.alive,
          kills: p.kills, deaths: p.deaths, assists: p.assists || 0, assists: p.assists || 0,
          weapon: p.weapon, ammo: p.ammo,
          reloading: p.reloading,
          money: p.money,
          hasSpike: p.hasSpike,
          planting: p.planting,
          defusing: p.defusing,
          sprinting: p.keys.shift && (p.keys.w || p.keys.a || p.keys.s || p.keys.d),
          ultCharge: p.ultCharge,
        });
      }
      const now = match._now();
      const smokes = match.smokes.filter(sm => now - sm.born < sm.dur).map(sm => ({ id: sm.id, x: sm.x, z: sm.z, r: sm.r, born: sm.born, dur: sm.dur }));
      return {
        t: match.tickCount,
        serverTime: now,
        mapId: match.map.id,
        phase: match.phase,
        round: match.round,
        timeLeft: Math.max(0, match.timeLeft),
        scores: { ...match.scores },
        roundWinner: match.roundWinner,
        roundEndReason: match.roundEndReason,
        attackTeam: match.attackTeam,
        defendTeam: match.defendTeam,
        spike: {
          carrierId: match.spike.carrierId,
          team: match.spike.team,
          carrierTeam: match.spike.team,
          dropped: match.spike.dropped,
          dropX: match.spike.dropX,
          dropZ: match.spike.dropZ,
          planted: match.spike.planted,
          plantX: match.spike.plantX,
          plantZ: match.spike.plantZ,
          defusingId: match.spike.defusingId,
          defuseProgress: match.spike.defuseProgress,
        },
        smokes,
        pendingUlts: match.pendingUlts.map(pu => ({ x: pu.x, z: pu.z, t: pu.t })),
        players,
        finished: match.finished,
        winner: match.winner,
      };
    },
  };

  return match;
}

module.exports = { WEAPONS, MAP, MAPS, CHARACTERS, TICK_RATE, STATE_RATE, createMatch, EYE_HEIGHT, SMOKE_RADIUS, SMOKE_COOLDOWN, SMOKE_DURATION, ULT_RADIUS, ULT_DMG, ULT_CHARGE_KILL };