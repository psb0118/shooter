/* =========================================================
   client/main.js — 5v5 전술 슈터 (발로란트식 라운드, 스파이크, 경제)
   - Three.js 3D 렌더링 / Pointer Lock 조준 / 로컬 예측
   - 라운드 진행, 스파이크 설치/해체, 구매 UI, HUD
   서버 좌표 규약: yaw=0 -> +Z, x=왼-오른, z=앞-뒤
========================================================= */

import * as THREE from "/vendor/three/build/three.module.js";

/* ================= 상수 ================= */

const EYE_HEIGHT = 1.6;
const PLAYER_RADIUS = 0.45;
const MOVE_SPEED = 5.5;
const SPRINT_MULT = 1.55;
const ACCEL = 12;
const INPUT_INTERVAL = 34; // ms
const RECONCILE_DIST = 3.5;
const SENS = 0.0022;
const TOUCH_SENS = 0.006;
const JOY_R = 44;
const PLANT_TIME = 1.5;
const DEFUSE_TIME = 7;

const TEAM_COLOR = { red: 0xe84c4c, blue: 0x4c8bee };
const TEAM_NAME = { red: "RED", blue: "BLUE" };
const PHASE_LABEL = { waiting: "대기", buy: "구매", combat: "전투", roundover: "라운드 종료", finished: "경기 종료" };

const $ = (sel) => document.querySelector(sel);

/* 모바일 기기 감지 — 터치스크린이 달린 PC/노트북(pointer: fine + 마우스 주 입력)은
   데스크톱으로 취급해 모바일 UI를 띄우지 않는다. */
const IS_PRIMARY_TOUCH = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
const IS_TOUCH_UA = /Android|iPhone|iPad|iPod|Mobi|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
const TOUCH = ("ontouchstart" in window || navigator.maxTouchPoints > 0) && (IS_PRIMARY_TOUCH || IS_TOUCH_UA);

/* ================= 전역 상태 ================= */

const state = {
  inGame: false,
  myId: null,
  myTeam: null,
  myHP: 150,
  myAmmo: 0,
  myMoney: 0,
  myWeapon: "pistol",
  myReloading: false,
  alive: true,
  kills: 0,
  deaths: 0,
  planting: false,
  defusing: false,
  x: 12, z: -40,
  yaw: Math.PI, pitch: 0,
  vx: 0, vz: 0,
  map: null,
  weapons: {},
  scores: { red: 0, blue: 0 },
  timeLeft: 100,
  phase: "waiting",
  round: 0,
  spike: { carrierId: null, dropped: false, dropX: 0, dropZ: 0, planted: false, plantX: 0, plantZ: 0, defusingId: null, defuseProgress: 0 },
  keys: { w: false, a: false, s: false, d: false, shift: false },
  firing: false,
  ads: false,
  uiLock: false,
  joinBuyOpened: false,
  players: new Map(),      // id -> { group, hpBar, name, target } (리모트)
  mapObjects: [],
  tracers: [],
  impacts: [],
  enemies: [],
  lastInput: 0,
  cam: { fov: 75 },
  viewmodel: null,
  lastViewModel: null,
  crosshairDot: null,
};

function windowState() { return state; }
window.__s = windowState; // 디버그 훅

const socket = io();
state.myId = socket.id;

/* ================= 오디오 (합성) ================= */

const Sfx = (() => {
  let ctx = null;
  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) ctx = new AC();
    }
    if (ctx && ctx.state === "suspended") ctx.resume();
    return ctx;
  }
  function env(buf, t0, a, d, peak) {
    // ADSR-ish 엔벨로프 단순화
  }
  function shot(weapon) {
    const c = ensure(); if (!c) return;
    const t = c.currentTime;
    const len = 0.15;
    const buf = c.createBuffer(1, c.sampleRate * len, c.sampleRate);
    const d = buf.getChannelData(0);
    const freq = weapon === "pistol" ? 480 : weapon === "ar" ? 260 : weapon === "smg" ? 340 : weapon === "sr" ? 160 : 200;
    for (let i = 0; i < d.length; i++) {
      const n = Math.random() * 2 - 1;
      d[i] = n * Math.pow(1 - i / d.length, 2) * (1 + 0.4 * Math.sin(2 * Math.PI * (freq * (1 + i / d.length * 0.6)) * (i / c.sampleRate))) * 0.6;
    }
    const src = c.createBufferSource(); src.buffer = buf;
    const f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = freq * 6;
    const g = c.createGain(); g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
    src.connect(f); f.connect(g); g.connect(c.destination); src.start(t);
  }
  function reload() {
    const c = ensure(); if (!c) return;
    const t = c.currentTime;
    const osc = c.createOscillator(); osc.type = "square"; osc.frequency.value = 900;
    const g = c.createGain(); g.gain.setValueAtTime(0.05, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    osc.connect(g); g.connect(c.destination); osc.start(t); osc.stop(t + 0.06);
  }
  function switchW() {
    const c = ensure(); if (!c) return;
    const t = c.currentTime;
    const osc = c.createOscillator(); osc.type = "triangle"; osc.frequency.value = 1400;
    const g = c.createGain(); g.gain.setValueAtTime(0.06, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    osc.connect(g); g.connect(c.destination); osc.start(t); osc.stop(t + 0.05);
  }
  function buy() { switchW(); }
  function hurt() {
    const c = ensure(); if (!c) return;
    const t = c.currentTime;
    const buf = c.createBuffer(1, c.sampleRate * 0.12, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2) * 0.4;
    const src = c.createBufferSource(); src.buffer = buf;
    const f = c.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 5000;
    const g = c.createGain(); g.gain.value = 0.8;
    src.connect(f); f.connect(g); g.connect(c.destination); src.start(t);
  }
  function tick(n) {
    const c = ensure(); if (!c) return;
    const t = c.currentTime;
    for (let i = 0; i < n; i++) {
      if (i > 5) break;
      const osc = c.createOscillator(); osc.type = "square"; osc.frequency.value = 880 + i * 40;
      const g = c.createGain();
      const start = t + i * 0.55;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.12, start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
      osc.connect(g); g.connect(c.destination); osc.start(start); osc.stop(start + 0.2);
    }
  }
  return { shot, reload, switchW, buy, hurt, tick, unlock: ensure };
})();

/* ================= 렌더러 / 씬 ================= */

const container = $("#game-canvas");
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9db4d6);
scene.fog = new THREE.Fog(0x9db4d6, 90, 240);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 500);
camera.rotation.order = "YXZ";
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
container.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x667799, 1.0));
const sun = new THREE.DirectionalLight(0xffffff, 1.15);
sun.position.set(40, 90, 25);
scene.add(sun);

/* ------------- 뷰모델 (1인칭 총 — 무기별 실루엣/색 변화) ------------- */

const VM_LOOK = {
  pistol: { color: 0x9aa0b0, w: 0.07,  len: 0.34, magLen: 0.12 },
  smg:    { color: 0x4f86d8, w: 0.085, len: 0.5,  magLen: 0.18 },
  ar:     { color: 0x36a77a, w: 0.09,  len: 0.62, magLen: 0.22 },
  sr:     { color: 0xa25fd0, w: 0.08,  len: 0.82, magLen: 0.2 },
  sg:     { color: 0xd08a3c, w: 0.12,  len: 0.52, magLen: 0.24 },
};

let viewmodel = null;

function clearViewModel() {
  if (!viewmodel) return;
  while (viewmodel.children.length) {
    const c = viewmodel.children[0];
    viewmodel.remove(c);
    if (c.geometry) c.geometry.dispose();
    if (c.material) {
      if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose());
      else c.material.dispose();
    }
  }
}

function buildViewModel(weaponId) {
  clearViewModel();
  const spec = VM_LOOK[weaponId] || VM_LOOK.pistol;
  const mat = new THREE.MeshLambertMaterial({ color: spec.color });
  const dark = new THREE.MeshLambertMaterial({ color: 0x1c1f2a });
  const L = spec.len;

  const body = new THREE.Mesh(new THREE.BoxGeometry(spec.w, 0.13, L), mat);
  body.position.set(0, 0, -L / 2 + 0.08);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(spec.w * 0.82, 0.17, 0.14), dark);
  grip.position.set(0, -0.15, 0.07);
  const mag = new THREE.Mesh(new THREE.BoxGeometry(spec.w * 0.78, 0.15, spec.magLen), dark);
  mag.position.set(0, -0.045, -0.05);
  viewmodel.add(body, grip, mag);

  if (weaponId === "sr") {
    const scope = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.14, 0.16), dark);
    scope.position.set(0, 0.07, -0.1);
    viewmodel.add(scope);
  }
}

function applyViewModel(weaponId) {
  if (!weaponId || !VM_LOOK[weaponId]) return;
  if (state.lastViewModel === weaponId) return;
  state.lastViewModel = weaponId;
  buildViewModel(weaponId);
  Sfx.switchW();
}

function makeViewModel() {
  if (viewmodel) return viewmodel;
  viewmodel = new THREE.Group();
  // 총을 화면 중앙(조준점)에 정렬 — 오른쪽 어깨 배치 제거
  viewmodel.position.set(0, -0.16, -0.48);
  viewmodel.rotation.x = 0.06;
  camera.add(viewmodel);
  scene.add(camera);
  buildViewModel(state.myWeapon || "pistol");
  return viewmodel;
}
makeViewModel();

/* ------------- 세계 생성 ------------- */

function buildWorld(map) {
  clearWorldObjects();
  state.map = map;
  const hs = map.halfSize;

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(hs * 2, hs * 2),
    new THREE.MeshLambertMaterial({ color: 0x8fa1bd })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  state.mapObjects.push(ground);

  for (const team of ["red", "blue"]) {
    const role = team === "red" ? "attack" : "defend";
    for (const sp of map.spawns[role]) {
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(1.2, 24),
        new THREE.MeshLambertMaterial({ color: TEAM_COLOR[team], transparent: true, opacity: 0.25 })
      );
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(sp.x, 0.02, sp.z);
      scene.add(disc);
      state.mapObjects.push(disc);
    }
  }

  for (const ob of map.obstacles) {
    const geo = new THREE.BoxGeometry(ob.w, map.wallHeight, ob.d);
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x39404f }));
    mesh.position.set(ob.x, map.wallHeight / 2, ob.z);
    scene.add(mesh);
    state.mapObjects.push(mesh);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0x5c6a82 })
    );
    edges.position.copy(mesh.position);
    scene.add(edges);
    state.mapObjects.push(edges);
  }

  const wallMat = new THREE.MeshLambertMaterial({ color: 0x2b3350, transparent: true, opacity: 0.9 });
  const wallGeo = new THREE.BoxGeometry(hs * 2, map.wallHeight + 2, 2);
  const walls = [
    [0, 0, hs, 0],
    [0, 0, -hs, 0],
    [hs, 0, 0, Math.PI / 2],
    [-hs, 0, 0, Math.PI / 2],
  ];
  for (const [wx, , wz, wy] of walls) {
    const wm = new THREE.Mesh(wallGeo, wallMat);
    wm.rotation.y = wy;
    wm.position.set(wx, (map.wallHeight + 2) / 2, wz);
    scene.add(wm);
    state.mapObjects.push(wm);
  }

  // A/B 사이트 표시
  for (const site of Object.values(map.sites)) {
    const zoneMat = new THREE.MeshLambertMaterial({ color: 0x57d69b, transparent: true, opacity: 0.14, side: THREE.DoubleSide });
    const zone = new THREE.Mesh(new THREE.PlaneGeometry(site.w, site.d), zoneMat);
    zone.rotation.x = -Math.PI / 2;
    zone.position.set(site.cx, 0.02, site.cz);
    scene.add(zone);
    state.mapObjects.push(zone);

    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(site.w, site.d)),
      new THREE.LineBasicMaterial({ color: 0x57d69b, transparent: true, opacity: 0.6 })
    );
    edge.rotation.x = -Math.PI / 2;
    edge.position.set(site.cx, 0.03, site.cz);
    scene.add(edge);
    state.mapObjects.push(edge);

    const label = makeTxtSprite(site.label || (site.cx < 0 ? "A" : "B"), "#57d69b", 128);
    label.position.set(site.cx, 0.4, site.cz);
    label.scale.set(3, 0.6, 1);
    scene.add(label);
    state.mapObjects.push(label);
  }
}

function clearWorldObjects() {
  for (const o of state.mapObjects) scene.remove(o);
  state.mapObjects = [];
  clearTracers();
  for (const [, p] of state.players) scene.remove(p.group);
  state.players.clear();
}

function makeTxtSprite(text, color, size) {
  const cv = document.createElement("canvas");
  cv.width = 256; cv.height = 64;
  const ctx = cv.getContext("2d");
  ctx.font = `bold ${size || 34}px 'Malgun Gothic', sans-serif`;
  ctx.fillStyle = color || "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,.8)";
  ctx.shadowBlur = 8;
  ctx.fillText(text, 128, 32);
  const tex = new THREE.CanvasTexture(cv);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false }));
  spr.scale.set(2.2, 0.55, 1);
  return spr;
}

/* ------------- 리모트 플레이어 ------------- */

function makePlayerMesh(p) {
  const group = new THREE.Group();
  const color = TEAM_COLOR[p.team];
  const mat = new THREE.MeshLambertMaterial({ color });
  const dark = new THREE.MeshLambertMaterial({ color: 0x22262f });

  const legL = meshBox(0.24, 0.5, 0.26, dark); legL.position.set(-0.18, 0.28, 0);
  const legR = meshBox(0.24, 0.5, 0.26, dark); legR.position.set(0.18, 0.28, 0);
  const body = meshBox(0.72, 1.25, 0.44, mat); body.position.y = 0.63;
  const chest = meshBox(0.78, 0.42, 0.52, new THREE.MeshLambertMaterial({ color: 0x2c3446 })); chest.position.y = 1.05;
  const pack = meshBox(0.5, 0.55, 0.22, dark); pack.position.set(0, 0.95, -0.32);
  const head = meshBox(0.5, 0.4, 0.42, new THREE.MeshLambertMaterial({ color: 0xd8b28a })); head.position.y = 1.62;
  const helmet = meshBox(0.54, 0.2, 0.46, dark); helmet.position.set(0, 1.78, 0);
  const gun = meshBox(0.12, 0.12, 0.7, dark); gun.position.set(0.34, 1.12, 0.5);

  group.add(legL, legR, body, chest, pack, head, helmet, gun);

  const nameSpr = makeTxtSprite(p.nickname, p.team === "red" ? "#ff8a8a" : "#8ab6ff", 30);
  nameSpr.position.set(0, 2.32, 0);
  group.add(nameSpr);

  const hpBar = makeHpBarSprite();
  hpBar.sprite.position.set(0, 2.76, 0);
  group.add(hpBar.sprite);

  return { group, hpBar };
}

function meshBox(w, h, d, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  return m;
}

function makeHpBarSprite() {
  const cv = document.createElement("canvas");
  cv.width = 128; cv.height = 12;
  const ctx = cv.getContext("2d");
  const tex = new THREE.CanvasTexture(cv);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false }));
  spr.scale.set(1.0, 0.11, 1);
  let owner = null;
  const draw = (p, ref) => {
    owner = p;
    const fr = Math.max(0, Math.min(1, p.hp / 150));
    ctx.clearRect(0, 0, 128, 12);
    ctx.fillStyle = "rgba(0,0,0,.72)";
    ctx.fillRect(0, 0, 128, 12);
    const r = Math.round(255 * (1 - fr));
    const g = Math.round(255 * fr);
    ctx.fillStyle = `rgb(${r},${g},40)`;
    ctx.fillRect(2, 2, Math.max(2, Math.round(124 * fr)), 8);
    tex.needsUpdate = true;
  };
  return { sprite: spr, draw };
}

/* ------------- 스파이크 드랍 마커 / 폭발 ------------- */

let dropMarker = null;
let explosionMesh = null;

function setDropMarker() {
  if (dropMarker !== null) { scene.remove(dropMarker); dropMarker = null; }
  if (!state.spike.dropped) return;
  dropMarker = new THREE.Mesh(
    new THREE.CylinderGeometry(1.1, 1.1, 0.1, 24),
    new THREE.MeshLambertMaterial({ color: 0xffd75f, transparent: true, opacity: 0.75 })
  );
  dropMarker.position.set(state.spike.dropX, 0.06, state.spike.dropZ);
  scene.add(dropMarker);
}

function showExplosionAt(x, z) {
  if (explosionMesh !== null) { scene.remove(explosionMesh); }
  explosionMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xffa94d, transparent: true, opacity: 0.95 })
  );
  explosionMesh.position.set(x, 1.2, z);
  scene.add(explosionMesh);
  setTimeout(() => { if (explosionMesh) { scene.remove(explosionMesh); explosionMesh = null; } }, 350);
}

/* ------------- 이동 예측 (서버와 동일) ------------- */

function circleAABB(px, pz, r, box) {
  const hx = box.w / 2, hz = box.d / 2;
  const cx = clamp(px, box.x - hx, box.x + hx);
  const cz = clamp(pz, box.z - hz, box.z + hz);
  let dx = px - cx, dz = pz - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 < r * r) {
    if (d2 < 1e-10) {
      const penX = (px < box.x ? box.x - hx - r : box.x + hx + r) - px;
      const penZ = (pz < box.z ? box.z - hz - r : box.z + hz + r) - pz;
      if (Math.abs(penX) < Math.abs(penZ)) px += penX; else pz += penZ;
      return [px, pz];
    }
    const d = Math.sqrt(d2);
    const over = r - d;
    px += (dx / d) * over;
    pz += (dz / d) * over;
  }
  return [px, pz];
}

function predictStep(dt) {
  const frozen = state.planting || state.defusing;
  const speed = state.keys.shift ? SPRINT_MULT : 1;
  const y = state.yaw;
  let ix = 0, iz = 0;
  if (!frozen) {
    if (state.keys.w) { ix += Math.sin(y); iz += Math.cos(y); }
    if (state.keys.s) { ix -= Math.sin(y); iz -= Math.cos(y); }
    if (state.keys.a) { ix += Math.cos(y); iz -= Math.sin(y); }
    if (state.keys.d) { ix -= Math.cos(y); iz += Math.sin(y); }
    const il = Math.sqrt(ix * ix + iz * iz) || 1;
    ix /= il; iz /= il;
  }
  const tx = ix * MOVE_SPEED * speed;
  const tz = iz * MOVE_SPEED * speed;
  if (frozen) { state.vx = 0; state.vz = 0; return; }
  state.vx += (tx - state.vx) * Math.min(1, ACCEL * dt);
  state.vz += (tz - state.vz) * Math.min(1, ACCEL * dt);
  state.x += state.vx * dt;
  state.z += state.vz * dt;

  if (state.map) {
    for (const box of state.map.obstacles) {
      [state.x, state.z] = circleAABB(state.x, state.z, PLAYER_RADIUS, box);
    }
  }
  const hs = state.map ? state.map.halfSize - PLAYER_RADIUS : 999;
  state.x = clamp(state.x, -hs, hs);
  state.z = clamp(state.z, -hs, hs);
}

function clamp(v, mn, mx) { return v < mn ? mn : v > mx ? mx : v; }

function inPlantZone(x, z) {
  const map = state.map;
  if (!map) return false;
  for (const site of Object.values(map.sites)) {
    if (Math.abs(x - site.cx) < site.w / 2 + 0.6 && Math.abs(z - site.cz) < site.d / 2 + 0.6) return true;
  }
  return false;
}

/* ================= 입력 ================= */

function anyKey() {
  return state.keys.w || state.keys.a || state.keys.s || state.keys.d;
}

window.addEventListener("keydown", (e) => {
  if (!state.inGame) return;
  switch (e.code) {
    case "KeyW": state.keys.w = true; break;
    case "KeyA": state.keys.a = true; break;
    case "KeyS": state.keys.s = true; break;
    case "KeyD": state.keys.d = true; break;
    case "ShiftLeft":
    case "ShiftRight": state.keys.shift = true; break;
    case "Digit1": buyWeapon("pistol"); break;
    case "Digit2": buyWeapon("smg"); break;
    case "Digit3": buyWeapon("ar"); break;
    case "Digit4": buyWeapon("sg"); break;
    case "Digit5": buyWeapon("sr"); break;
    case "KeyB": case "KeyP": toggleBuyUI(true); break;
    case "KeyR":
      if (state.phase !== "combat" || !state.alive) return;
      socket.emit("game:reload");
      Sfx.reload();
      break;
    case "KeyE": startInteract(true); break;
    case "Escape":
      if (buyUIOpen()) closeBuyUI(true);
      break;
  }
});

window.addEventListener("keyup", (e) => {
  switch (e.code) {
    case "KeyW": state.keys.w = false; break;
    case "KeyA": state.keys.a = false; break;
    case "KeyS": state.keys.s = false; break;
    case "KeyD": state.keys.d = false; break;
    case "ShiftLeft":
    case "ShiftRight": state.keys.shift = false; break;
    case "KeyE": startInteract(false); break;
  }
});

function toggleBuyUI(force) {
  if (!state.inGame) return;
  if (state.phase === "buy") {
    if (buyUIOpen()) closeBuyUI(false);
    else openBuyUI();
  } else if (buyUIOpen()) {
    closeBuyUI(false);
  }
}

function buyUIOpen() { return !$("#weapon-select").classList.contains("hidden"); }

function buyWeapon(id) {
  if (state.phase !== "buy" || !state.alive) return;
  const w = state.weapons[id];
  if (!w) return;
  const cost = w.id === state.myWeapon ? 0 : w.price; // 서버와 동일: 현재 무기 재구매 무료
  if (state.myMoney < cost) {
    flashBuyToast("크레딧 부족 — 구매할 수 없습니다");
    Sfx.hurt();
    return;
  }
  socket.emit("game:buy", { weapon: id });
  state.myWeapon = id;
  state.myMoney = Math.max(0, state.myMoney - cost);
  applyViewModel(id); // 내부에서 무기 교체 효과음 재생
  refreshBuyGrid();
  ui.update();
  if (buyUIOpen()) closeBuyUI(false);
}

/* ================= 상호작용 (설치/해체/스파이크 건네주기) ================= */

function interactTarget() {
  const sp = state.spike;
  if (state.phase === "buy") {
    if (myIsCarrier()) {
      if (Math.hypot(state.x - sp.dropX, state.z - sp.dropZ) < 4 && sp.dropped) return "pickup";
      return "drop";
    }
    return null;
  }
  if (state.phase !== "combat") return null;
  if (sp.planted && state.myTeam && state.myTeam !== state.spike.carrierTeam) {
    if (Math.hypot(state.x - sp.plantX, state.z - sp.plantZ) < 4) return "defuse";
    return "go-defuse";
  }
  if (state.myTeam === "red" && !sp.dropped && Math.hypot(sp.dropX - state.x, sp.dropZ - state.z) < 4) return "pickup";
  if (state.myTeam === "red" && myIsCarrier() && inPlantZone(state.x, state.z) && !sp.planted) return "plant";
  return null;
}

function myIsCarrier() { return state.spike.carrierId === state.myId; }

let holding = false;
let plantHoldStart = null;
function startInteract(on) {
  if (!state.inGame || !state.alive) return;
  const t = interactTarget();
  if (!t || t === "go-defuse" || t === "pickup") return;

  if (on) {
    if (t === "plant") { socket.emit("game:interact", { type: "plant", action: "start" }); holding = "plant"; }
    else if (t === "defuse") { socket.emit("game:interact", { type: "defuse", action: "start" }); holding = "defuse"; }
    else if (t === "drop") { socket.emit("game:interact", { type: "drop", action: "start" }); holding = null; }
  } else {
    if (holding) socket.emit("game:interact", { action: "stop" });
    holding = null;
  }
}

function updateInteractHint() {
  const el = $("#interact-hint");
  if (!state.alive || state.phase !== "combat") { el.classList.add("hidden"); return; }
  const t = interactTarget();
  if (!t) { el.classList.add("hidden"); return; }
  const lbl = $("#interact-text");
  if (t === "plant") lbl.textContent = "스파이크 설치 [E]";
  else if (t === "defuse") lbl.textContent = "스파이크 해체 [E]";
  else if (t === "go-defuse") lbl.textContent = "스파이크 해체 필요!";
  else if (t === "pickup") lbl.textContent = "스파이크 픽업";
  el.classList.remove("hidden");
}

/* ================= 포인터 락 ================= */

let heldFire = false;   // 물리적으로 눌려 있는 좌클릭 (포인터 락 획득 클릭도 즉시 발사 처리)
let heldAds = false;

function flushInput() {
  if (!state.inGame || !state.alive) return;
  socket.emit("game:input", {
    keys: state.keys, yaw: state.yaw, pitch: state.pitch,
    x: state.x, z: state.z,
    firing: state.firing, ads: state.ads,
  });
}

function pointerLocked() { return document.pointerLockElement === renderer.domElement; }
function tryLock() {
  if (!state.inGame) return;
  const hasOverlay = !$("#lobby").classList.contains("hidden") ||
    !$("#weapon-select").classList.contains("hidden") ||
    !$("#end-screen").classList.contains("hidden") ||
    !$("#pause").classList.contains("hidden");
  if (!hasOverlay && !pointerLocked()) {
    try {
      const p = renderer.domElement.requestPointerLock();
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
  }
}
function exitLock() {
  if (pointerLocked()) document.exitPointerLock();
}

document.addEventListener("pointerlockchange", () => {
  if (!pointerLocked()) {
    state.firing = false;
    state.ads = false;
    if (state.inGame && state.alive && !state.uiLock && !buyUIOpen() && $("#end-screen").classList.contains("hidden") && !state.planting && !state.defusing && state.phase === "combat") {
      // 전투 중 락 해제(ESC) 시 설정 탭 표시
      syncSettingsUI();
      $("#pause").classList.remove("hidden");
    }
  } else {
    $("#pause").classList.add("hidden");
    // 락을 획득한 바로 그 클릭이 마우스를 누른 채면 즉시 발사 시작 (첫 클릭부터 발사 가능)
    if (state.inGame && !state.uiLock) {
      if (heldFire) { state.firing = true; flushInput(); }
      if (heldAds) state.ads = true;
    }
  }
});

/* ================= 설정 (ESC 메뉴) ================= */

const SETTINGS = Object.assign(
  { sens: 1, invertY: false },
  JSON.parse(localStorage.getItem("shooter_settings") || "null") || {}
);
function saveSettings() {
  localStorage.setItem("shooter_settings", JSON.stringify(SETTINGS));
}
function syncSettingsUI() {
  $("#set-sens").value = SETTINGS.sens;
  $("#set-sens-val").textContent = SETTINGS.sens.toFixed(2) + "x";
  $("#set-invy").checked = SETTINGS.invertY;
}
$("#set-sens").addEventListener("input", (e) => {
  SETTINGS.sens = parseFloat(e.target.value) || 1;
  $("#set-sens-val").textContent = SETTINGS.sens.toFixed(2) + "x";
  saveSettings();
});
$("#set-invy").addEventListener("change", (e) => {
  SETTINGS.invertY = e.target.checked;
  saveSettings();
});
$("#btn-resume").addEventListener("click", () => {
  $("#pause").classList.add("hidden");
  tryLock();
});
$("#btn-leave").addEventListener("click", () => {
  $("#pause").classList.add("hidden");
  socket.emit("lobby:leave");
  enterLobbyUI();
});

document.addEventListener("mousemove", (e) => {
  if (!state.inGame || !pointerLocked()) return;
  state.yaw -= e.movementX * SENS * SETTINGS.sens;
  state.pitch = clamp(state.pitch + e.movementY * SENS * SETTINGS.sens * (SETTINGS.invertY ? 1 : -1), -1.52, 1.52);
  const tau = Math.PI * 2;
  state.yaw = ((state.yaw % tau) + tau) % tau;
});

renderer.domElement.addEventListener("mousedown", (e) => {
  if (!state.inGame || state.uiLock || buyUIOpen()) return;
  // 터치 장치에서 터치가 만들어낸 합성 mousedown(detail=0)은 무시 (스와이프 시야와 혼동 방지)
  if (TOUCH && e.detail === 0) return;
  if (e.button === 0) heldFire = true;
  else if (e.button === 2) heldAds = true;
  if (!pointerLocked()) { tryLock(); return; }
  if (e.button === 0) state.firing = true;
  else if (e.button === 2) state.ads = true;
  // 즉시 전송: 68ms 샘플러 사이에 끝나는 짧은 클릭(탭)이 유실되지 않도록
  flushInput();
});
window.addEventListener("mouseup", (e) => {
  if (e.button === 0) { heldFire = false; state.firing = false; flushInput(); }
  else if (e.button === 2) { heldAds = false; state.ads = false; flushInput(); }
});
window.addEventListener("contextmenu", (e) => e.preventDefault());

/* ================= 모바일 터치 ================= */

const joy = { active: false, ox: 0, oy: 0, id: -1 };
const btnTimer = new Map();
const look = { active: false, id: -1, lx: 0, ly: 0 };

function resetJoy() {
  joy.active = false; joy.id = -1;
  state.keys.w = state.keys.a = state.keys.s = state.keys.d = state.keys.shift = false;
  const k = $("#joy-knob");
  if (k) k.style.transform = "translate(0,0)";
}

function updateJoy(t) {
  const dx = t.clientX - joy.ox, dy = t.clientY - joy.oy;
  const len = Math.hypot(dx, dy);
  const cl = Math.min(len, JOY_R);
  const ux = len ? dx / len : 0, uy = len ? dy / len : 0;
  const k = $("#joy-knob"); if (k) k.style.transform = `translate(${ux * cl}px,${uy * cl}px)`;
  const ax = len < 10 ? 0 : ux * (cl / JOY_R);
  const ay = len < 10 ? 0 : uy * (cl / JOY_R);
  const dead = 0.35;
  state.keys.a = ax < -dead;
  state.keys.d = ax > dead;
  state.keys.w = ay < -dead;
  state.keys.s = ay > dead;
  state.keys.shift = len > JOY_R * 0.8;
}

document.addEventListener("touchstart", (e) => {
  if (!state.inGame || state.uiLock) return;
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (t.target.closest("#joy-base")) {
      if (joy.active) continue;
      joy.active = true; joy.id = t.identifier; joy.ox = t.clientX; joy.oy = t.clientY;
    } else if (t.target.classList.contains("btn-control")) {
      const id = t.target.id;
      if (id === "btn-fire") { state.firing = true; flushInput(); }
      else if (id === "btn-reload") { socket.emit("game:reload"); Sfx.reload(); }
      else if (id === "btn-swap") toggleBuyUI(false);
      else if (id === "btn-interact") startInteract(true);
      btnTimer.set(t.identifier, id);
    } else {
      // 나머지 화면 영역 → 스와이프로 시야 회전
      look.active = true; look.id = t.identifier; look.lx = t.clientX; look.ly = t.clientY;
    }
  }
}, { passive: false });

document.addEventListener("touchmove", (e) => {
  if (!state.inGame) return;
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (joy.active && t.identifier === joy.id) updateJoy(t);
    else if (look.active && t.identifier === look.id) {
      const dx = t.clientX - look.lx;
      const dy = t.clientY - look.ly;
      look.lx = t.clientX; look.ly = t.clientY;
      state.yaw -= dx * TOUCH_SENS * SETTINGS.sens;
      state.pitch = clamp(state.pitch + dy * TOUCH_SENS * SETTINGS.sens * (SETTINGS.invertY ? 1 : -1), -1.52, 1.52);
    }
  }
}, { passive: false });

document.addEventListener("touchend", (e) => {
  for (const t of e.changedTouches) {
    if (joy.active && t.identifier === joy.id) resetJoy();
    if (look.active && t.identifier === look.id) { look.active = false; look.id = -1; }
    if (btnTimer.has(t.identifier)) {
      const id = btnTimer.get(t.identifier);
      btnTimer.delete(t.identifier);
      if (id === "btn-fire") { state.firing = false; flushInput(); }
      if (id === "btn-interact") startInteract(false);
    }
  }
});
document.addEventListener("touchcancel", (e) => {
  for (const t of e.changedTouches) {
    if (joy.active && t.identifier === joy.id) resetJoy();
    if (look.active && t.identifier === look.id) { look.active = false; look.id = -1; }
    if (btnTimer.has(t.identifier)) {
      const id = btnTimer.get(t.identifier);
      btnTimer.delete(t.identifier);
      if (id === "btn-fire") { state.firing = false; flushInput(); }
      if (id === "btn-interact") startInteract(false);
    }
  }
  state.firing = false;
  flushInput();
});

function initTouchUI() {
  if (!TOUCH) return;
  // 구매 화면 플립 현상 방지를 위해 스크롤 잠금
  document.body.style.overscrollBehavior = "none";
}

/* ================= 구매 UI ================= */

function openBuyUI() {
  if (state.phase !== "buy") return;
  if ($("#weapon-select").classList.contains("hidden")) {
    state.uiLock = true;
    $("#weapon-select").classList.remove("hidden");
    $("#pause").classList.add("hidden");
    exitLock();
    refreshBuyGrid();
  }
}

function closeBuyUI(relock) {
  $("#weapon-select").classList.add("hidden");
  state.uiLock = false;
  if (relock !== false && state.inGame) tryLock();
}

function refreshBuyGrid() {
  const grid = $("#ws-grid");
  const myMoney = state.myMoney;
  const html = Object.values(state.weapons || {}).map((w) => {
    const afford = w.price === 0 || myMoney >= w.price;
    const cur = w.id === state.myWeapon;
    const priceTxt = w.price === 0 ? "무료" : w.price.toLocaleString();
    return `
      <button class="ws-card${cur ? " sel" : ""}${afford ? "" : " poor"}" data-w="${w.id}">
        <div class="ws-icon">${w.icon || "🔫"}</div>
        <div class="ws-name">${w.name}${cur ? ' <span class="ws-owned-tag">보유</span>' : ""}</div>
        <div class="ws-desc">${w.desc || ""}</div>
        <div class="ws-stats">DMG ${w.body}-${w.head} · ${magText(w)}${afford ? "" : ' <span class="ws-note">크레딧 부족</span>'}</div>
        <div class="ws-price${cur ? " owned" : ""}">${priceTxt}</div>
      </button>`;
  }).join("");
  grid.innerHTML = html;
  grid.querySelectorAll(".ws-card").forEach((b) => {
    b.addEventListener("click", () => buyWeapon(b.dataset.w));
  });
  $("#ws-money").textContent = myMoney.toLocaleString();
}

function flashBuyToast(text) {
  const t = $("#ws-toast");
  if (!t) return;
  t.textContent = text;
  t.classList.remove("hidden");
  t.classList.remove("shake");
  void t.offsetWidth;
  t.classList.add("shake");
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.add("hidden"), 1600);
}

function magText(w) {
  if (w.pellets) return `${w.magSize}발 펠릿`;
  const rps = Math.round(1 / w.cadence * 10) / 10;
  return `${w.magSize}발 ${rps}/s`;
}

/* ================= HUD ================= */

const ui = {
  update() {
    // HP
    const hpPct = clamp(state.myHP / 150, 0, 1) * 100;
    $("#healthfill").style.width = hpPct + "%";
    $("#hp-num").textContent = Math.max(0, Math.round(state.myHP));

    const k = $("#kd");
    k.textContent = `${state.kills}/${state.deaths}`;

    // 탄약
    const ammo = $("#ammo");
    const wpn = state.weapons[state.myWeapon];
    const maxAmmo = wpn ? wpn.magSize : 12;
    ammo.textContent = state.myReloading ? "재장전 중…" : `${state.myAmmo}/${maxAmmo}`;
    ammo.classList.toggle("low", !state.myReloading && state.myAmmo <= 3);

    // 무기
    $("#weapon-name").textContent = wpn ? wpn.name : state.myWeapon;

    // 스코어 / 라운드 / 타이머
    $("#score-red").textContent = state.scores.red;
    $("#score-blue").textContent = state.scores.blue;
    $("#round-num").textContent = `R${state.round}`;
    const t = Math.max(0, state.timeLeft);
    $("#timer").textContent = formatClock(t);

    // 머니
    $("#money").textContent = state.myMoney.toLocaleString();
    $("#ws-money").textContent = state.myMoney.toLocaleString();

    // 스파이크 상태 (설치됨 → 타이머 표시)
    const spikeEl = $("#spike-status");
    if (state.spike.planted) {
      spikeEl.textContent = `💣 ${formatClock(state.timeLeft)}`;
      spikeEl.classList.remove("hidden");
    } else {
      spikeEl.classList.add("hidden");
    }

    // 팀 태그
    const tag = $("#my-team-tag");
    tag.textContent = TEAM_NAME[state.myTeam] || "";
    tag.className = "red";
    if (state.myTeam) tag.classList.add(state.myTeam);

    // 단계 라벨
    $("#phase-label").textContent = PHASE_LABEL[state.phase] || state.phase;

    // 사망 화면
    const deadEl = $("#death-screen");
    if (state.inGame && !state.alive && state.phase !== "finished") deadEl.classList.remove("hidden");
    else deadEl.classList.add("hidden");

    updateInteractHint();
  },
};

function formatClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/* ------------- HUD 이벤트 피드 (킬/설치/해체/라운드) ------------- */

function addEventLine(html) {
  const kf = $("#killfeed");
  const div = document.createElement("div");
  div.className = "kill-item";
  div.innerHTML = html;
  kf.appendChild(div);
  const r = (el) => { el.remove(); };
  setTimeout(() => r(div), 5200);
  while (kf.children.length > 5) kf.removeChild(kf.firstChild);
}

function showBanner(text, cls, ms) {
  const b = $("#round-banner");
  b.textContent = text;
  b.className = "round-banner " + (cls || "info");
  b.classList.remove("hidden");
  clearTimeout(b._t);
  b._t = setTimeout(() => b.classList.add("hidden"), ms || 2600);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ================= 로비 UI ================= */

function renderLobby(room) {
  const isHost = room.host === socket.id;
  $("#lobby-room").classList.remove("hidden");
  $("#room-code").textContent = room.roomId;
  $("#btn-start").classList.toggle("hidden", !isHost);
  $("#player-list").innerHTML = room.players.map((p) => {
    const me = p.socketId === socket.id;
    return `<div class="player-item">
      <span class="pdot ${p.team}"></span>
      <span class="pname">${esc(p.nickname)}${me ? " (나)" : ""}${!p.connected ? " (이탈)" : ""}${p.isBot ? " 🤖" : ""}</span>
      ${p.socketId === room.host ? '<span class="phost">방장</span>' : ""}
    </div>`;
  }).join("");
}

function enterLobby(room) {
  state.inGame = false;
  state.myTeam = room.players.find(p => p.socketId === socket.id)?.team || null;
  state.phase = "waiting";
  state.joinBuyOpened = false;
  state.planting = false; state.defusing = false;
  state.spike = { carrierId: null, dropped: false, dropX: 0, dropZ: 0, planted: false, plantX: 0, plantZ: 0, defusingId: null, defuseProgress: 0 };
  $("#lobby").classList.remove("hidden");
  $("#hud").classList.add("hidden");
  $("#end-screen").classList.add("hidden");
  $("#death-screen").classList.add("hidden");
  $("#weapon-select").classList.add("hidden");
  $("#round-banner").classList.add("hidden");
  $("#pause").classList.add("hidden");
  $("#touch-controls").classList.add("hidden");
  renderLobby(room);
  exitLock();
}

function showStatus(msg, color) {
  const el = $("#lobby-status");
  el.textContent = msg || "";
  el.style.color = color || "#ff7a7a";
}

function clearMatchUI() {
  $("#hud").classList.add("hidden");
  $("#touch-controls").classList.add("hidden");
  $("#weapon-select").classList.add("hidden");
  $("#end-screen").classList.add("hidden");
  $("#pause").classList.add("hidden");
  $("#round-banner").classList.add("hidden");
  clearWorldObjects();
  setDropMarker();
}

/* ================= 소켓 이벤트 ================= */

socket.on("connect", () => { state.myId = socket.id; });

socket.on("lobby:created", (d) => { if (d.ok) { showStatus(""); enterLobby(d.room); } });
socket.on("lobby:join", (d) => {
  if (!d.ok) { showStatus(d.reason); return; }
  showStatus("");
  enterLobby(d.room);
});
socket.on("lobby:state", (room) => { state.myTeam = room.players.find(p => p.socketId === socket.id)?.team || null; renderLobby(room); });
socket.on("lobby:start", () => { showStatus(""); });

socket.on("game:started", (d) => {
  if (!d.ok) return;
  state.inGame = true;
  state.map = d.map;
  state.weapons = d.weapons || {};
  state.scores = { red: 0, blue: 0 };
  state.round = d.state.round;
  state.phase = "buy";
  state.timeLeft = d.state.timeLeft;
  state.joinBuyOpened = false;
  state.myTeam = d.me?.team || (d.state.players.find(p => p.id === state.myId)?.team) || null;
  state.kills = 0; state.deaths = 0;
  state.alive = true;
  state.ads = false;
  state.firing = false;
  state.cam.fov = 75;
  camera.fov = 75;
  camera.updateProjectionMatrix();
  state.yaw = state.myTeam === "red" ? Math.PI : 0;
  state.pitch = 0;
  state.spike = {
    carrierId: d.state.spike?.carrierId || null,
    dropped: !!(d.state.spike?.dropped),
    dropX: d.state.spike?.dropX || 0,
    dropZ: d.state.spike?.dropZ || 0,
    planted: !!(d.state.spike?.planted),
    plantX: d.state.spike?.plantX || 0,
    plantZ: d.state.spike?.plantZ || 0,
    defusingId: null,
    defuseProgress: 0,
  };
  buildWorld(d.map);
  $("#lobby").classList.add("hidden");
  $("#touch-controls").classList.toggle("hidden", !TOUCH);
  $("#hud").classList.remove("hidden");
  $("#killfeed").innerHTML = "";
  $("#join-code").value = "";
  setTimeout(() => openBuyUI(), 500);
  state.joinBuyOpened = true;
  showBanner(`ROUND ${state.round} — 구매 단계`, "info", 2000);
  Sfx.unlock();
  ui.update();
});

socket.on("game:sync", (d) => {
  if (state.inGame) return;
  state.map = d.map;
  state.weapons = d.weapons || {};
  state.inGame = true;
  state.alive = true;
  state.ads = false;
  state.firing = false;
  state.cam.fov = 75;
  camera.fov = 75;
  camera.updateProjectionMatrix();
  buildWorld(d.map);
  $("#lobby").classList.add("hidden");
  $("#hud").classList.remove("hidden");
  $("#touch-controls").classList.toggle("hidden", !TOUCH);
  state.joinBuyOpened = false;
});

socket.on("game:state", (snap) => {
  state.spike = snap.spike || state.spike;
  state.phase = snap.phase || state.phase;
  state.round = snap.round || state.round;
  state.timeLeft = snap.timeLeft;

  // 돌발 — 스파이크 드랍 상태 갱신
  setDropMarker();
  if (!state.myId) return;

  const mine = snap.players.find(p => p.id === state.myId) || null;
  if (mine) {
    state.myHP = mine.hp;
    state.myAmmo = mine.ammo;
    if (mine.weapon && mine.weapon !== state.myWeapon) {
      state.myWeapon = mine.weapon;
      applyViewModel(mine.weapon);
    }
    state.myMoney = mine.money;
    state.myReloading = mine.reloading;
    state.planting = mine.planting;
    state.defusing = mine.defusing;
    state.alive = mine.alive !== false;
    state.kills = mine.kills;
    state.deaths = mine.deaths;
    state.myTeam = mine.team || state.myTeam;
    if (mine.hasSpike) state.spike.carrierId = mine.id;
  }

  state.scores.red = snap.scores.red;
  state.scores.blue = snap.scores.blue;

  // 자기 좌표 보정 (서버)
  const self = snap.players.find(p => p.id === state.myId);
  if (self) {
    const dx = state.x - self.x, dz = state.z - self.z;
    if (Math.hypot(dx, dz) > RECONCILE_DIST) { state.x = self.x; state.z = self.z; state.vx = 0; state.vz = 0; }
  }

  // 리모트
  const seen = new Set();
  for (const p of snap.players) {
    if (p.id === state.myId) continue;
    seen.add(p.id);
    let ent = state.players.get(p.id);
    if (!ent) {
      const mesh = makePlayerMesh(p);
      scene.add(mesh.group);
      mesh.group.position.set(p.x, 0, p.z);
      mesh.group.rotation.y = p.yaw;
      ent = { group: mesh.group, hpBar: mesh.hpBar, target: { x: p.x, z: p.z, yaw: p.yaw, hp: p.hp } };
      state.players.set(p.id, ent);
    }
    ent.target.x = p.x;
    ent.target.z = p.z;
    ent.target.yaw = p.yaw;
    ent.target.hp = p.hp;
    ent.hpBar.draw(p, null);
  }
  for (const [id, ent] of state.players) {
    if (!seen.has(id)) { scene.remove(ent.group); state.players.delete(id); }
  }

  // 구매 단계 자동 오픈 (조인/재진입)
  if (state.phase === "buy" && !state.joinBuyOpened && !buyUIOpen()) {
    state.joinBuyOpened = true;
    openBuyUI();
  }

  ui.update();
});

socket.on("round:start", (d) => {
  state.phase = "buy";
  state.round = d.round;
  state.spike = { carrierId: null, dropped: false, dropX: 0, dropZ: 0, planted: false, plantX: 0, plantZ: 0, defusingId: null, defuseProgress: 0 };
  setDropMarker();
  $("#death-screen").classList.add("hidden");
  $("#pause").classList.add("hidden");
  state.ads = false;
  state.firing = false;
  state.cam.fov = 75;
  camera.fov = 75;
  camera.updateProjectionMatrix();
  showBanner(`ROUND ${d.round} — 구매 단계`, "info", 2000);
  state.alive = true;
  state.myHP = 150;
  state.joinBuyOpened = true;
  // 새 라운드 스폰 방향으로 카메라 정렬 (발로란트: 라운드마다 시야 리셋)
  state.yaw = state.myTeam === "red" ? Math.PI : 0;
  state.pitch = 0;
  openBuyUI();
  ui.update();
});

socket.on("round:end", (d) => {
  state.phase = "roundover";
  state.ads = false;
  state.firing = false;
  const win = (d.winner === state.myTeam);
  const reason = d.reason === "elim" ? "전멸" : d.reason === "detonate" ? "폭발" : d.reason === "defuse" ? "해체" : "시간 초과";
  showBanner(win ? `ROUND 승리 · ${reason}` : `ROUND 패배 · ${reason}`, win ? "win" : "lose", 2400);
  // 라운드 종료 시 구매 오버레이 닫기
  closeBuyUI(false);
});

socket.on("game:phase", (d) => {
  state.phase = d.phase;
  if (d.phase === "combat") { showBanner("전투 시작!", "info", 1600); closeBuyUI(false); }
  ui.update();
});

socket.on("game:buy", (d) => {
  // 서버 권위 상태로 동기화 — 성공 시 무기+머니 확정, 실패 시 낙관적 갱신 롤백
  state.myMoney = typeof d.money === "number" ? d.money : state.myMoney;
  if (d.ok && d.weapon && d.weapon !== state.myWeapon) {
    state.myWeapon = d.weapon;
    applyViewModel(d.weapon);
  }
  ui.update();
  if (buyUIOpen()) refreshBuyGrid();
});

socket.on("game:fx", (fx) => {
  const mat = new THREE.LineBasicMaterial({ color: fx.hit ? 0xffe066 : 0xcfd8e6, transparent: true, opacity: 0.9 });
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(fx.ox, fx.oy, fx.oz),
    new THREE.Vector3(fx.hitX, fx.hitY, fx.hitZ),
  ]);
  const line = new THREE.Line(geo, mat);
  scene.add(line);
  state.tracers.push({ line, born: performance.now() });
  if (fx.shooter === state.myId && fx.snd !== false) Sfx.shot(fx.weapon);
  if (fx.shooter === state.myId && fx.hit) showHitMarker();
  if (fx.hit) {
    const col = fx.weapon === "sr" ? 0xffd75f : 0xffffff;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ color: col, transparent: true, opacity: 0.9 }));
    sprite.position.set(fx.hitX, fx.hitY, fx.hitZ);
    sprite.scale.set(0.5, 0.5, 1);
    scene.add(sprite);
    state.impacts.push({ sprite, born: performance.now() });
  }
});

socket.on("game:hurt", (d) => {
  if (d.pid === state.myId) {
    Sfx.hurt();
    flashDamage();
  } else if (d.byId === state.myId) {
    const ent = state.players.get(d.pid);
    if (ent) ent.flinch = performance.now();
  }
});

socket.on("game:kill", (d) => {
  const wk = d.weapon ? ` <span class="wk">${esc((state.weapons[d.weapon]?.name || d.weapon).toLowerCase())}</span>` : "";
  addEventLine(`<span class="killer ${d.killerTeam}">${esc(d.killerName)}</span><span class="wl"> → </span><span class="victim">${esc(d.victimName)}</span>${wk}${d.headshot ? '<span class="hs"> 헤드샷</span>' : ""}`);
  if (d.victimId === state.myId) {
    state.alive = false;
    state.firing = false;
    showBanner("전사했습니다", "lose", 2000);
    ui.update();
  }
});

socket.on("bomb:carrier", (d) => {
  if (d.carrierId === state.myId) {
    showBanner("스파이크를 들었습니다", "info", 1800);
  }
  ui.update();
});

socket.on("bomb:planted", (d) => {
  state.spike.planted = true;
  state.spike.plantX = d.x;
  state.spike.plantZ = d.z;
  state.timeLeft = d.timeLeft;
  showBanner("스파이크 설치됨!", "win", 2200);
  Sfx.tick(8);
  ui.update();
});

socket.on("bomb:drop", (d) => {
  state.spike.dropped = true;
  state.spike.dropX = d.x;
  state.spike.dropZ = d.z;
  state.spike.carrierId = null;
  setDropMarker();
});

socket.on("bomb:pickup", (d) => {
  state.spike.dropped = false;
  state.spike.carrierId = d.pid;
  setDropMarker();
  if (d.pid === state.myId) showBanner("스파이크 획득", "info", 1500);
});

socket.on("bomb:defuse", (d) => {
  state.spike.planted = false;
  state.spike.defusingId = null;
  showBanner("스파이크 해체 성공", "lose", 2000);
  Sfx.reload();
});

socket.on("bomb:detonate", (d) => {
  showBanner("💥 스파이크 폭발!", "lose", 2200);
  showExplosionAt(d.x, d.z);
  Sfx.tick(10);
});

socket.on("game:ended", (d) => {
  state.inGame = false;
  state.phase = "finished";
  state.ads = false;
  state.firing = false;
  state.cam.fov = 75;
  camera.fov = 75;
  camera.updateProjectionMatrix();
  clearMatchUI();
  $("#end-screen").classList.remove("hidden");
  const myWin = d.winner === state.myTeam;
  $("#end-title").textContent = myWin ? "우리 팀 승리!" : (d.winner === "red" ? "RED 승리" : "BLUE 승리");
  $("#end-title").style.color = myWin ? "#4ade80" : (d.winner === "red" ? "#ff6b6b" : "#6ba6ff");
  $("#end-score").textContent = `RED ${d.scores.red} : ${d.scores.blue} BLUE`;
});

socket.on("disconnect", () => {});

/* ================= 로비 버튼 ================= */

$("#btn-create").addEventListener("click", () => {
  socket.emit("lobby:create", { nickname: ($("#nickname").value || "플레이어").trim().slice(0, 16) || "플레이어" });
});
$("#btn-join").addEventListener("click", () => {
  const code = $("#join-code").value.trim().toUpperCase();
  if (!code) { showStatus("방 코드를 입력하세요."); return; }
  socket.emit("lobby:join", { roomId: code, nickname: ($("#nickname").value || "플레이어").trim().slice(0, 16) || "플레이어" });
});
$("#btn-start").addEventListener("click", () => socket.emit("lobby:start"));
$("#btn-back-lobby").addEventListener("click", () => {
  socket.emit("lobby:leave");
  enterLobbyUI();
});
$("#pause").addEventListener("click", (e) => {
  if (e.target === $("#pause")) {
    $("#pause").classList.add("hidden");
    tryLock();
  }
});

function enterLobbyUI() {
  state.inGame = false;
  $("#end-screen").classList.add("hidden");
  $("#weapon-select").classList.add("hidden");
  $("#hud").classList.add("hidden");
  $("#lobby").classList.remove("hidden");
}

// 방 코드 URL 지원 (?room=)
{
  const q = new URLSearchParams(location.search).get("room");
  if (q) $("#join-code").value = q.toUpperCase();
}

/* ================= 렌더 루프 ================= */

let lastFrame = performance.now();

function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  if (!state.inGame) { renderer.render(scene, camera); return; }

  /* 카메라 */
  if (state.alive && (pointerLocked() || TOUCH)) {
    // 로컬 예측 충돌
    predictStep(dt);

    // 반동 감쇠
    // (스프레드는 서버가 처리 — 클라 눈으로만 이동감 감쇠 표현)
    const targetFov = state.ads ? 42 : 75;
    state.cam.fov += (targetFov - state.cam.fov) * Math.min(1, dt * 12);
    camera.fov = state.cam.fov;
    camera.updateProjectionMatrix();

    // 뷰모델 ADS 위치 (x는 항상 중앙 고정)
    const vx = 0;
    const vy = state.ads ? -0.22 : -0.16;
    const vz = state.ads ? -0.3 : -0.48;
    viewmodel.position.x += (vx - viewmodel.position.x) * Math.min(1, dt * 14);
    viewmodel.position.y += (vy - viewmodel.position.y) * Math.min(1, dt * 14);
    viewmodel.position.z += (vz - viewmodel.position.z) * Math.min(1, dt * 14);
  }

  camera.position.set(state.x, EYE_HEIGHT, state.z);
  const dx = Math.sin(state.yaw) * Math.cos(state.pitch);
  const dy = Math.sin(state.pitch);
  const dz = Math.cos(state.yaw) * Math.cos(state.pitch);
  camera.lookAt(camera.position.x + dx, camera.position.y + dy, camera.position.z + dz);

  /* 크로스헤어 — ADS 중에도 유지, 작게 */
  const dot = $("#crosshair");
  dot.classList.toggle("ads", state.ads);

  /* 리모트 보간 */
  for (const [, ent] of state.players) {
    const g = ent.group;
    const t = 1 - Math.exp(-dt * 14);
    g.position.x += (ent.target.x - g.position.x) * t;
    g.position.z += (ent.target.z - g.position.z) * t;
    g.rotation.y += angDiff(ent.target.yaw, g.rotation.y) * t;
  }

  /* 트레이서/임팩트 수명 */
  for (let i = state.tracers.length - 1; i >= 0; i--) {
    const tr = state.tracers[i];
    const age = (now - tr.born) / 1000;
    if (age > 0.09) { scene.remove(tr.line); tr.line.geometry.dispose(); tr.line.material.dispose(); state.tracers.splice(i, 1); }
    else tr.line.material.opacity = 0.9 * (1 - age / 0.09);
  }
  for (let i = state.impacts.length - 1; i >= 0; i--) {
    const ip = state.impacts[i];
    const age = (now - ip.born) / 1000;
    if (age > 0.35) { scene.remove(ip.sprite); ip.sprite.material.dispose(); state.impacts.splice(i, 1); }
    else {
      ip.sprite.scale.set(0.5 + age * 2, 0.5 + age * 2, 1);
      ip.sprite.material.opacity = Math.max(0, 0.9 * (1 - age / 0.35));
    }
  }

  /* 스파이크 설치/해체 진행중 — 진행바 표시 */
  const prog = $("#interact-progress");
  const fill = $("#interact-fill");
  if (state.planting && holding === "plant") {
    prog.classList.remove("hidden");
    if (plantHoldStart == null) plantHoldStart = now;
    fill.style.width = Math.min(100, ((now - plantHoldStart) / 1500) * 100) + "%";
  } else if (state.defusing) {
    prog.classList.remove("hidden");
    const dp = state.spike ? (state.spike.defuseProgress || 0) : 0;
    fill.style.width = Math.min(100, (dp / 7) * 100) + "%";
  } else {
    prog.classList.add("hidden");
    plantHoldStart = null;
  }

  /* 입력 전송 */
  const nowMs = now;
  if (state.phase === "combat" && state.alive && nowMs - state.lastInput >= INPUT_INTERVAL * 2) {
    state.lastInput = nowMs;
    socket.emit("game:input", {
      keys: state.keys, yaw: state.yaw, pitch: state.pitch,
      x: state.x, z: state.z,
      firing: state.firing, ads: state.ads,
    });
  }

  renderer.render(scene, camera);
}

function angDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function clearTracers() {
  for (const tr of state.tracers) { scene.remove(tr.line); tr.line.geometry.dispose(); tr.line.material.dispose(); }
  for (const ip of state.impacts) { scene.remove(ip.sprite); ip.sprite.material.dispose(); }
  state.tracers = [];
  state.impacts = [];
}

/* ------------- 피격 비네트 ------------- */

let dmgTimeout = null;
function flashDamage() {
  const dv = $("#damage-vignette");
  dv.style.opacity = 0.6;
  clearTimeout(dmgTimeout);
  dmgTimeout = setTimeout(() => { dv.style.opacity = 0; }, 280);
}

let hitTimeout = null;
function showHitMarker() {
  const hm = $("#hitmarker");
  hm.classList.remove("hidden");
  clearTimeout(hitTimeout);
  hitTimeout = setTimeout(() => hm.classList.add("hidden"), 160);
}

/* ------------- 초기화 ------------- */

initTouchUI();
const nick = localStorage.getItem("shooter_nick") || "";
if (nick) $("#nickname").value = nick;
$("#nickname").addEventListener("change", (e) => localStorage.setItem("shooter_nick", e.target.value.trim()));

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

window.__s.camera = camera;
window.__s.renderer = renderer;
window.__s.statefn = windowState;

requestAnimationFrame(animate);