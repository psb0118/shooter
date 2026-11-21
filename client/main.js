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
const RECONCILE_DIST = 3.5;
const SENS = 0.0022;
const TOUCH_SENS = 0.006;
const JOY_R = 44;
const PLANT_TIME = 1.5;
const DEFUSE_TIME = 7;
const JUMP_VEL = 6.8;
const GRAVITY = 18;
const SERVER_TICK_RATE = 30;          // 리모트 속도 추정용 (스냅샷 t 는 서버 30Hz 틱)
const INPUT_SAMPLE_MS = 34;
const ULT_RADIUS = 5.5;
const SMOKE_DURATION = 10;

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
  x: 12, y: 0, z: -40,
  yaw: Math.PI, pitch: 0,
  vx: 0, vz: 0, vy: 0,
  prevSpace: false,
  ultCharge: 0,
  map: null,
  mapId: "center",
  weapons: {},
  characters: {},
  maps: {},
  myChar: "vanguard",
  speedMult: 1,
  maxHp: 150,
  scores: { red: 0, blue: 0 },
  timeLeft: 100,
  phase: "waiting",
  round: 0,
  spike: { carrierId: null, dropped: false, dropX: 0, dropZ: 0, planted: false, plantX: 0, plantZ: 0, defusingId: null, defuseProgress: 0 },
  keys: { w: false, a: false, s: false, d: false, shift: false, space: false },
  firing: false,
  ads: false,
  uiLock: false,
  joinBuyOpened: false,
  players: new Map(),      // id -> { group, hpBar, name, target } (리모트)
  mapObjects: [],
  tracers: [],
  impacts: [],
  enemies: [],
  smokes: [],
  screenShake: 0,
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
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
if (THREE.ACESFilmicToneMapping) {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.88;
}
container.appendChild(renderer.domElement);

const hemiLight = new THREE.HemisphereLight(0xcfe4ff, 0x667799, 1.0);
scene.add(hemiLight);
const ambientLight = new THREE.AmbientLight(0x93b4dd, 0.2);
scene.add(ambientLight);
const sun = new THREE.DirectionalLight(0xfff3e0, 1.2);
sun.position.set(40, 90, 25);
scene.add(sun);
const fillLight = new THREE.DirectionalLight(0x7fb6ff, 0.3);
fillLight.position.set(-60, 45, -40);
scene.add(fillLight);

/* ------------- 뷰모델 (1인칭 총 — 무기별 실루엣/색 변화) ------------- */

const VM_LOOK = {
  pistol: { color: 0x9aa0b0, accent: 0x5fe7ff, w: 0.07,  len: 0.34, magLen: 0.12 },
  smg:    { color: 0x4f86d8, accent: 0x5fe7ff, w: 0.085, len: 0.5,  magLen: 0.18 },
  ar:     { color: 0x36a77a, accent: 0x7dffc4, w: 0.09,  len: 0.62, magLen: 0.22 },
  sr:     { color: 0xa25fd0, accent: 0xffd75f, w: 0.08,  len: 0.82, magLen: 0.2 },
  sg:     { color: 0xd08a3c, accent: 0xffb36b, w: 0.12,  len: 0.52, magLen: 0.24 },
};

let viewmodel = null;

function clearViewModel() {
  if (!viewmodel) return;
  for (const c of [...viewmodel.children]) {
    viewmodel.remove(c);
    c.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material.dispose();
      }
    });
  }
}

function buildViewModel(weaponId) {
  clearViewModel();
  const spec = VM_LOOK[weaponId] || VM_LOOK.pistol;
  const bodyMat = new THREE.MeshStandardMaterial({ color: spec.color, roughness: 0.42, metalness: 0.55 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x2a3646, roughness: 0.5, metalness: 0.55 });
  const metalMat = new THREE.MeshStandardMaterial({ color: 0x8a97a8, roughness: 0.32, metalness: 0.82 });
  const accentMat = new THREE.MeshBasicMaterial({ color: spec.accent || 0x5fe7ff });
  const L = spec.len;
  const box = (w, h, d, mat) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  const cyl = (r, h, mat) => new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 10), mat);

  const receiver = box(spec.w, 0.11, L * 0.55, bodyMat);
  receiver.position.set(0, 0, -L * 0.26);
  const handguard = box(spec.w * 0.9, 0.085, L * 0.3, darkMat);
  handguard.position.set(0, -0.005, -L * 0.52);
  const grip = box(spec.w * 0.75, 0.16, 0.12, darkMat);
  grip.position.set(0, -0.14, 0.03);
  grip.rotation.x = 0.28;
  const mag = box(spec.w * 0.7, 0.18, 0.1, metalMat);
  mag.position.set(0, -0.13, -L * 0.18);
  mag.rotation.x = 0.12;
  const barrel = cyl(0.022, L * 0.5, metalMat);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.025, -L * 0.82);
  const muzzle = cyl(0.024, 0.04, accentMat);
  muzzle.rotation.x = Math.PI / 2;
  muzzle.position.set(0, 0.025, -L * 1.03);
  const sight = box(0.05, 0.05, 0.09, darkMat);
  sight.position.set(0, 0.075, -L * 0.16);
  const dot = box(0.016, 0.016, 0.016, accentMat);
  dot.position.set(0, 0.104, -L * 0.16);
  const rail = box(spec.w * 0.55, 0.024, L * 0.4, metalMat);
  rail.position.set(0, 0.07, -L * 0.26);
  const strip = box(0.02, 0.026, L * 0.4, accentMat);
  strip.position.set(spec.w * 0.5 + 0.01, -0.005, -L * 0.3);
  const handR = box(0.06, 0.09, 0.1, darkMat);
  handR.position.set(0, -0.12, 0.02);
  viewmodel.add(receiver, handguard, grip, mag, barrel, muzzle, sight, dot, rail, strip, handR);

  if (L > 0.38) {
    const stock = box(spec.w * 0.8, 0.13, 0.2, darkMat);
    stock.position.set(0, -0.015, 0.14);
    viewmodel.add(stock);
  }

  if (weaponId === "sr") {
    const scope = cyl(0.045, 0.18, darkMat);
    scope.rotation.x = Math.PI / 2;
    scope.position.set(0, 0.115, -L * 0.2);
    const lens = cyl(0.036, 0.012, accentMat);
    lens.rotation.x = Math.PI / 2;
    lens.position.set(0, 0.115, -L * 0.29);
    viewmodel.add(scope, lens);
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
  viewmodel.position.set(0.28, -0.2, -0.88);
  viewmodel.rotation.set(0.08, -0.7, 0);
  viewmodel.scale.setScalar(0.8);
  camera.add(viewmodel);
  scene.add(camera);
  buildViewModel(state.myWeapon || "pistol");
  return viewmodel;
}
makeViewModel();

/* ------------- 세계 생성 ------------- */

function makeSkyTexture(top, bottom) {
  const cv = document.createElement("canvas");
  cv.width = 8; cv.height = 256;
  const ctx = cv.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, "#" + top.getHexString());
  g.addColorStop(0.58, "#" + bottom.getHexString());
  g.addColorStop(1, "#" + bottom.clone().multiplyScalar(0.72).getHexString());
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 8, 256);
  const tex = new THREE.CanvasTexture(cv);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  if ("SRGBColorSpace" in THREE) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeGroundTexture(base) {
  const cv = document.createElement("canvas");
  cv.width = 512; cv.height = 512;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#" + base.getHexString();
  ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 2200; i++) {
    const a = Math.random() * 0.055;
    ctx.fillStyle = Math.random() > 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
    const s = 2 + Math.random() * 7;
    ctx.fillRect(Math.random() * 512, Math.random() * 512, s, s);
  }
  ctx.strokeStyle = "rgba(255,255,255,.075)";
  ctx.lineWidth = 2;
  for (let i = 0; i <= 512; i += 128) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 512); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(512, i); ctx.stroke();
  }
  ctx.strokeStyle = "rgba(95,231,255,.12)";
  ctx.lineWidth = 5;
  ctx.strokeRect(64, 64, 384, 384);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  if ("SRGBColorSpace" in THREE) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildWorld(map) {
  clearWorldObjects();
  state.map = map;
  const hs = map.halfSize;
  const th = map.theme || {};

  // 맵 테마별 하늘/안개/조명 적용 (다채로운 분위기)
  const skyCol = new THREE.Color(th.sky != null ? th.sky : 0x9db4d6);
  scene.background = skyCol;
  if (scene.fog) scene.fog.color = new THREE.Color(th.fog != null ? th.fog : 0x9db4d6);
  if (hemiLight) { hemiLight.color.set(th.hemiSky != null ? th.hemiSky : 0xcfe4ff); hemiLight.groundColor.set(th.hemiGround != null ? th.hemiGround : 0x667799); }
  if (sun) sun.intensity = Math.min(1.5, th.sun != null ? th.sun : 1.15);

  // 그라데이션 스카이 돔 — 단조로운 단색 하늘 대신 깊이감 있는 배경
  const skyTop = skyCol.clone().multiplyScalar(0.38);
  const skyBottom = skyCol.clone().lerp(new THREE.Color(0xffffff), 0.22);
  const skyDome = new THREE.Mesh(
    new THREE.SphereGeometry(360, 24, 14),
    new THREE.MeshBasicMaterial({ map: makeSkyTexture(skyTop, skyBottom), side: THREE.BackSide, fog: false, depthWrite: false })
  );
  skyDome.position.y = 70;
  skyDome.renderOrder = -10;
  scene.add(skyDome);
  state.mapObjects.push(skyDome);
  if (scene.fog) { scene.fog.near = 70; scene.fog.far = 230; }

  const groundTex = makeGroundTexture(new THREE.Color(th.ground != null ? th.ground : 0x8899ad));
  groundTex.repeat.set(Math.max(3, Math.round(hs / 9)), Math.max(3, Math.round(hs / 9)));
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(hs * 2, hs * 2),
    new THREE.MeshStandardMaterial({ map: groundTex, color: 0xc7d2e0, roughness: 1, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  state.mapObjects.push(ground);

  // 바닥 그리드 라인 — 단조로운 바닥에 구조감/색감 추가
  const grid = new THREE.GridHelper(hs * 2, 26, th.edge != null ? th.edge : 0x5c6a82, th.edge != null ? th.edge : 0x5c6a82);
  grid.position.y = 0.02;
  grid.material.opacity = 0.25;
  grid.material.transparent = true;
  scene.add(grid);
  state.mapObjects.push(grid);

  for (const team of ["red", "blue"]) {
    const role = team === "red" ? "attack" : "defend";
    const col = TEAM_COLOR[team];
    for (const sp of map.spawns[role]) {
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(1.2, 24),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.18, depthWrite: false })
      );
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(sp.x, 0.02, sp.z);
      scene.add(disc);
      state.mapObjects.push(disc);

      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1.16, 1.36, 28),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(sp.x, 0.028, sp.z);
      scene.add(ring);
      state.mapObjects.push(ring);
    }
  }

  const baseH = th.obstacleH != null ? th.obstacleH : 0.58;
  const baseS = th.obstacleS != null ? th.obstacleS : 0.12;
  const baseL = th.obstacleL != null ? th.obstacleL : 0.22;
  const spread = th.obstacleSpread != null ? th.obstacleSpread : 0.002;
  const edgeColor = new THREE.Color(th.edge != null ? th.edge : 0x5c6a82).lerp(new THREE.Color(0xffffff), 0.35);
  for (const ob of map.obstacles) {
    const geo = new THREE.BoxGeometry(ob.w, map.wallHeight, ob.d);
    // 각 장애물마다 색상 변화 (다채로운 맵)
    const seedH = ((((ob.x * 13 + ob.z * 7) | 0) % 100) + 100) % 100;
    const seedS = ((((ob.z * 11 + ob.x * 3) | 0) % 100) + 100) % 100;
    const seedL = ((((ob.x + ob.z * 5) | 0) % 100) + 100) % 100;
    const h = Math.min(0.95, baseH + seedH * 0.001);
    const s = Math.max(0.12, Math.min(0.8, baseS + seedS * spread));
    const l = Math.max(0.27, Math.min(0.62, baseL + seedL * (spread * 0.8) + 0.025));
    const col = new THREE.Color().setHSL(h, s, l);
    const boxMat = new THREE.MeshStandardMaterial({
      color: col, roughness: 0.82, metalness: 0.14,
      emissive: col.clone().multiplyScalar(0.14), emissiveIntensity: 1,
    });
    const mesh = new THREE.Mesh(geo, boxMat);
    mesh.position.set(ob.x, map.wallHeight / 2, ob.z);
    scene.add(mesh);
    state.mapObjects.push(mesh);

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: 0.45 })
    );
    edges.position.copy(mesh.position);
    scene.add(edges);
    state.mapObjects.push(edges);

    // 커버 하단 네온 트림 — 사이트 A는 그린, B는 앰버, 나머지는 시안
    const trimCol = ob.z > 20 && ob.x < 0 ? 0x57d69b : ob.z > 20 && ob.x > 0 ? 0xffa94d : 0x5fe7ff;
    const trim = new THREE.Mesh(
      new THREE.BoxGeometry(ob.w + 0.06, 0.05, ob.d + 0.06),
      new THREE.MeshBasicMaterial({ color: trimCol, transparent: true, opacity: 0.5, depthWrite: false })
    );
    trim.position.set(ob.x, 0.035, ob.z);
    scene.add(trim);
    state.mapObjects.push(trim);
  }

  const wallCol = new THREE.Color(th.wall != null ? th.wall : 0x2b3350);
  const wallMat = new THREE.MeshStandardMaterial({
    color: wallCol, roughness: 0.85, metalness: 0.12,
    emissive: wallCol.clone().multiplyScalar(0.12), emissiveIntensity: 1,
  });
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

  // 경계 벽 하단 라이트 스트립 + 코너 필라
  const wallTrimMat = new THREE.MeshBasicMaterial({ color: 0x5fe7ff, transparent: true, opacity: 0.42, depthWrite: false });
  const trimPieces = [
    [new THREE.BoxGeometry(hs * 2, 0.07, 0.07), 0, 0.11, hs - 0.06],
    [new THREE.BoxGeometry(hs * 2, 0.07, 0.07), 0, 0.11, -hs + 0.06],
    [new THREE.BoxGeometry(0.07, 0.07, hs * 2), hs - 0.06, 0.11, 0],
    [new THREE.BoxGeometry(0.07, 0.07, hs * 2), -hs + 0.06, 0.11, 0],
  ];
  for (const [geo, x, y, z] of trimPieces) {
    const m = new THREE.Mesh(geo, wallTrimMat);
    m.position.set(x, y, z);
    scene.add(m);
    state.mapObjects.push(m);
  }
  const pillarMat = new THREE.MeshBasicMaterial({ color: 0x5fe7ff, transparent: true, opacity: 0.3, depthWrite: false });
  const pillarGeo = new THREE.CylinderGeometry(0.16, 0.16, map.wallHeight + 2, 8);
  for (const [px, pz] of [[hs, hs], [hs, -hs], [-hs, hs], [-hs, -hs]]) {
    const pillar = new THREE.Mesh(pillarGeo, pillarMat);
    pillar.position.set(px, (map.wallHeight + 2) / 2, pz);
    scene.add(pillar);
    state.mapObjects.push(pillar);
  }

  // A/B 사이트 표시 — 홀로그램 존 + 컬러 조명 + 비콘 링
  for (const site of Object.values(map.sites)) {
    const labelTxt = site.label || (site.cx < 0 ? "A" : "B");
    const siteCol = labelTxt === "B" ? 0xffa94d : 0x57d69b;
    const siteHex = "#" + new THREE.Color(siteCol).getHexString();

    const zoneMat = new THREE.MeshBasicMaterial({ color: siteCol, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });
    const zone = new THREE.Mesh(new THREE.PlaneGeometry(site.w, site.d), zoneMat);
    zone.rotation.x = -Math.PI / 2;
    zone.position.set(site.cx, 0.02, site.cz);
    scene.add(zone);
    state.mapObjects.push(zone);

    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(site.w, site.d)),
      new THREE.LineBasicMaterial({ color: siteCol, transparent: true, opacity: 0.8 })
    );
    edge.rotation.x = -Math.PI / 2;
    edge.position.set(site.cx, 0.03, site.cz);
    scene.add(edge);
    state.mapObjects.push(edge);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.7, 1.9, 32),
      new THREE.MeshBasicMaterial({ color: siteCol, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(site.cx, 0.035, site.cz);
    scene.add(ring);
    state.mapObjects.push(ring);

    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(1.05, 1.05, map.wallHeight, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: siteCol, transparent: true, opacity: 0.055, side: THREE.DoubleSide, depthWrite: false })
    );
    beam.position.set(site.cx, map.wallHeight / 2, site.cz);
    scene.add(beam);
    state.mapObjects.push(beam);

    const lamp = new THREE.PointLight(siteCol, 1.15, 20, 2);
    lamp.position.set(site.cx, 3.2, site.cz);
    scene.add(lamp);
    state.mapObjects.push(lamp);

    const label = makeTxtSprite(labelTxt, siteHex, 128);
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
  state.smokes = [];
  clearSmokeMeshes();
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
  const teamCol = new THREE.Color(TEAM_COLOR[p.team]);
  const pCol = new THREE.Color().setHSL(((p.playerColor || 0) % 360) / 360, 0.7, 0.6);
  const armorMat = new THREE.MeshStandardMaterial({
    color: teamCol.clone().multiplyScalar(0.72), roughness: 0.55, metalness: 0.35,
  });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x1b2430, roughness: 0.8, metalness: 0.2 });
  const accentMat = new THREE.MeshStandardMaterial({
    color: pCol, roughness: 0.45, metalness: 0.35,
    emissive: pCol.clone().multiplyScalar(0.35), emissiveIntensity: 1,
  });
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xd8b28a, roughness: 0.9, metalness: 0 });
  const visorMat = new THREE.MeshBasicMaterial({ color: 0x7fe7ff });
  const cyl = (rt, rb, h, seg, mat) => new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);

  // 다리 / 부츠
  for (const sx of [-0.17, 0.17]) {
    const leg = cyl(0.115, 0.14, 0.58, 8, darkMat);
    leg.position.set(sx, 0.34, 0);
    const boot = meshBox(0.23, 0.13, 0.34, darkMat);
    boot.position.set(sx, 0.065, 0.06);
    const knee = meshBox(0.2, 0.12, 0.22, armorMat);
    knee.position.set(sx, 0.54, 0.05);
    group.add(leg, boot, knee);
  }

  // 힙 / 몸통 / 가슴 플레이트
  const hips = meshBox(0.46, 0.18, 0.3, darkMat); hips.position.y = 0.64;
  const torso = cyl(0.27, 0.34, 0.58, 8, armorMat); torso.position.y = 0.96;
  const chest = meshBox(0.56, 0.34, 0.32, armorMat); chest.position.set(0, 1.02, 0.07);
  const chestGlow = meshBox(0.18, 0.22, 0.02, accentMat); chestGlow.position.set(0, 1.02, 0.24);
  const belt = meshBox(0.48, 0.07, 0.31, accentMat); belt.position.y = 0.74;
  group.add(hips, torso, chest, chestGlow, belt);

  // 어꺠 / 팔 / 장갑
  for (const sx of [-1, 1]) {
    const shoulder = new THREE.Mesh(new THREE.SphereGeometry(0.125, 10, 8), armorMat);
    shoulder.position.set(sx * 0.35, 1.2, 0);
    const shoulderGlow = meshBox(0.1, 0.035, 0.12, accentMat);
    shoulderGlow.position.set(sx * 0.35, 1.31, 0.03);
    const arm = cyl(0.07, 0.085, 0.46, 8, darkMat);
    arm.position.set(sx * 0.4, 0.93, 0.02);
    arm.rotation.z = sx * 0.12;
    const glove = meshBox(0.1, 0.11, 0.13, darkMat);
    glove.position.set(sx * 0.42, 0.7, 0.06);
    group.add(shoulder, shoulderGlow, arm, glove);
  }

  // 목 / 헤드 / 헬멧 / 발광 바이저
  const neck = cyl(0.09, 0.1, 0.12, 8, skinMat); neck.position.y = 1.3;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), skinMat); head.position.y = 1.48;
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.195, 12, 10), armorMat);
  helmet.position.set(0, 1.51, -0.02); helmet.scale.y = 0.9;
  const visor = meshBox(0.3, 0.1, 0.12, visorMat); visor.position.set(0, 1.48, 0.15);
  const visorFrame = meshBox(0.34, 0.13, 0.02, darkMat); visorFrame.position.set(0, 1.48, 0.09);
  group.add(neck, head, helmet, visor, visorFrame);

  // 백패 / 백팩 라이트
  const pack = meshBox(0.4, 0.5, 0.2, darkMat); pack.position.set(0, 1.0, -0.27);
  const packLight = meshBox(0.16, 0.04, 0.02, accentMat); packLight.position.set(0, 1.14, -0.38);
  group.add(pack, packLight);

  // 소총 (오른손)
  const gun = new THREE.Group();
  const receiver = meshBox(0.1, 0.13, 0.46, darkMat); receiver.position.set(0, 0, 0);
  const barrel = cyl(0.032, 0.032, 0.34, 8, darkMat);
  barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.04, 0.4);
  const stock = meshBox(0.09, 0.14, 0.2, darkMat); stock.position.set(0, -0.02, -0.32);
  const mag = meshBox(0.07, 0.18, 0.1, darkMat); mag.position.set(0, -0.13, 0.02);
  const gunGlow = meshBox(0.11, 0.02, 0.3, accentMat); gunGlow.position.set(0, 0.08, 0.03);
  gun.add(receiver, barrel, stock, mag, gunGlow);
  gun.position.set(0.34, 1.03, 0.28);
  group.add(gun);

  // 발밑 팀 링
  const teamRing = new THREE.Mesh(
    new THREE.RingGeometry(0.5, 0.58, 24),
    new THREE.MeshBasicMaterial({ color: teamCol, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false })
  );
  teamRing.rotation.x = -Math.PI / 2;
  teamRing.position.y = 0.018;
  group.add(teamRing);

  const nameSpr = makeTxtSprite(p.nickname, p.team === "red" ? "#ff8a8a" : "#8ab6ff", 26);
  nameSpr.scale.set(1.34, 0.34, 1);
  nameSpr.position.set(0, 2.22, 0);
  group.add(nameSpr);

  const hpBar = makeHpBarSprite();
  hpBar.sprite.position.set(0, 2.6, 0);
  group.add(hpBar.sprite);

  // 스파이크(폭탄) 캐리어 표시 — 머리 위 아이콘 (들고 있을 때만 표시)
  const spikeSpr = makeSpikeSprite();
  spikeSpr.visible = false;
  group.add(spikeSpr);

  return { group, hpBar, spikeSpr };
}

function makeSpikeSprite() {
  const cv = document.createElement("canvas");
  cv.width = 64; cv.height = 64;
  const ctx = cv.getContext("2d");
  ctx.font = "46px 'Segoe UI Emoji','Malgun Gothic',sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,.9)";
  ctx.shadowBlur = 8;
  ctx.fillText("💣", 32, 34);
  const tex = new THREE.CanvasTexture(cv);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
  spr.scale.set(0.7, 0.7, 1);
  spr.position.set(0, 3.15, 0);
  return spr;
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
  spr.scale.set(0.75, 0.083, 1);
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

/* ------------- 연막 (스모크) ------------- */

const smokeMeshes = new Map();   // id -> { mesh, inner }

function clearSmokeMeshes() {
  for (const [, sm] of smokeMeshes) {
    scene.remove(sm.mesh);
    if (sm.inner) scene.remove(sm.inner);
  }
  smokeMeshes.clear();
}

function syncSmokeMeshes() {
  // state.smokes 기반 렌더 메시 동기화 (스냅샷/이벤트 공통)
  const alive = new Set(state.smokes.map(s => s.id));
  for (const [id, sm] of smokeMeshes) {
    if (!alive.has(id)) { scene.remove(sm.mesh); if (sm.inner) scene.remove(sm.inner); smokeMeshes.delete(id); }
  }
  for (const sm of state.smokes) {
    if (smokeMeshes.has(sm.id)) continue;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(sm.r, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0x6a7d99, transparent: true, opacity: 0.55, depthWrite: true })
    );
    mesh.position.set(sm.x, 2.4, sm.z);
    const inner = new THREE.Mesh(
      new THREE.SphereGeometry(sm.r * 0.7, 16, 10),
      new THREE.MeshBasicMaterial({ color: 0x3c4757, transparent: true, opacity: 0.5, depthWrite: true })
    );
    inner.position.set(sm.x, 1.7, sm.z);
    scene.add(mesh);
    scene.add(inner);
    smokeMeshes.set(sm.id, { mesh, inner, born: sm.born });
  }
}

/* ------------- 궁극기 (낙뢰) ------------- */

let ultTelegraph = null;
let ultBoomMesh = null;
function showUltTelegraph(x, z, r) {
  if (ultTelegraph) scene.remove(ultTelegraph);
  // 버그: 반경을 상수 ULT_RADIUS 로 고정 → 서버가 캐릭터별 ultRadius 를 r 로 보내주는데 무시됐다.
  const rad = r || ULT_RADIUS;
  ultTelegraph = new THREE.Mesh(
    new THREE.RingGeometry(rad - 0.15, rad, 32),
    new THREE.MeshBasicMaterial({ color: 0xffd75f, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false })
  );
  ultTelegraph.rotation.x = -Math.PI / 2;
  ultTelegraph.position.set(x, 0.05, z);
  scene.add(ultTelegraph);
  setTimeout(() => {
    if (ultTelegraph) { scene.remove(ultTelegraph); ultTelegraph = null; }
    showUltBoom(x, z);
  }, 1200);
}
function showUltBoom(x, z) {
  if (ultBoomMesh) scene.remove(ultBoomMesh);
  ultBoomMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xffd75f, transparent: true, opacity: 0.95 })
  );
  ultBoomMesh.position.set(x, 2.5, z);
  scene.add(ultBoomMesh);
  setTimeout(() => { if (ultBoomMesh) { scene.remove(ultBoomMesh); ultBoomMesh = null; } }, 500);
  state.screenShake = Math.max(state.screenShake, 0.35);
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
  // 구매/대기 단계에서는 이동 금지 (전투 시작 후에만 움직인다)
  const frozen = state.planting || state.defusing || state.phase !== "combat";
  const speed = (state.keys.shift ? SPRINT_MULT : 1) * (state.speedMult || 1);
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
  if (frozen) { state.vx = 0; state.vz = 0; }
  else {
    state.vx += (tx - state.vx) * Math.min(1, ACCEL * dt);
    state.vz += (tz - state.vz) * Math.min(1, ACCEL * dt);
    state.x += state.vx * dt;
    state.z += state.vz * dt;
  }

  if (state.map && !frozen) {
    for (const box of state.map.obstacles) {
      [state.x, state.z] = circleAABB(state.x, state.z, PLAYER_RADIUS, box);
    }
  }
  const hs = state.map ? state.map.halfSize - PLAYER_RADIUS : 999;
  state.x = clamp(state.x, -hs, hs);
  state.z = clamp(state.z, -hs, hs);

  // 점프 로컬 예측 (서버와 동일 물리 — 상승 에지)
  if (state.y <= 0 && state.keys.space && !state.prevSpace && !frozen) state.vy = JUMP_VEL;
  state.prevSpace = state.keys.space;
  if (state.y > 0 || state.vy > 0) {
    state.vy -= GRAVITY * dt;
    state.y += state.vy * dt;
    if (state.y <= 0) { state.y = 0; state.vy = 0; }
  }
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

/* TAB 점수판 — 킬/데스/어시스트 오버레이 */
function toggleScoreboard(open) {
  state.tabOpen = open;
  const sb = $("#tab-scoreboard");
  if (!sb) return;
  if (!open) { sb.classList.add("hidden"); return; }
  const rows = [];
  for (const [id, ent] of state.players) {
    if (ent.name == null) continue;
    rows.push({
      name: ent.name, team: ent.team,
      kills: ent.kills || 0, deaths: ent.deaths || 0, assists: ent.assists || 0,
    });
  }
  rows.push({
    name: state.myNick || "나", team: state.myTeam,
    kills: state.kills, deaths: state.deaths, assists: state.assists || 0,
  });
  const tRow = (r) => `<tr class="tab-row ${r.team}"><td class="tn">${esc(r.name)}</td><td>${r.kills}</td><td>${r.deaths}</td><td>${r.assists}</td></tr>`;
  sb.innerHTML = `
    <div class="tab-wrap">
      <div class="tab-head">스코어보드 <kbd>TAB</kbd> — 탁상에서 떼면 닫힘</div>
      <table class="tab-table">
        <thead><tr><th>플레이어</th><th>킬</th><th>데스</th><th>어시스트</th></tr></thead>
        <tbody>${rows.map(tRow).join("")}</tbody>
      </table>
    </div>`;
  sb.classList.remove("hidden");
}
window.addEventListener("keydown", (e) => {
  if (e.code === "Tab") { e.preventDefault(); if (state.inGame) toggleScoreboard(true); }
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Tab") { toggleScoreboard(false); }
});

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
    case "Space":
      if (state.alive && !state.planting && !state.defusing) state.keys.space = true;
      break;
    case "KeyQ": useSmoke(); break;
    case "KeyX": useUlt(); break;
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
    case "Space": state.keys.space = false; break;
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
  // 버그: carrierTeam 은 서버 스냅샷에 없는 필드라 항상 undefined → 공격팀도 defuse 가 잡혔다.
  // 서버가 내려주는 team 필드로만 판정 (정의되지 않은 team 은 방어적으로 defuse 불가 처리)
  if (sp.planted && state.myTeam && sp.team && state.myTeam !== sp.team) {
    if (Math.hypot(state.x - sp.plantX, state.z - sp.plantZ) < 4) return "defuse";
    return "go-defuse";
  }
  // 버그: 픽업은 스파이크가 바닥(dropped)에 있을 때만 가능한데 !sp.dropped 로 반대로 쓰였다
  if (state.myTeam === "red" && sp.dropped && Math.hypot(sp.dropX - state.x, sp.dropZ - state.z) < 4) return "pickup";
  if (state.myTeam === "red" && myIsCarrier() && inPlantZone(state.x, state.z) && !sp.planted) return "plant";
  return null;
}

function myIsCarrier() { return state.spike.carrierId === state.myId; }

function useSmoke() {
  if (state.phase !== "combat" || !state.alive || buyUIOpen()) return false;
  socket.emit("game:skill", { type: "smoke" });
  Sfx.switchW();
  return true;
}

function useUlt() {
  if (state.phase !== "combat" || !state.alive || state.ultCharge < 100 || buyUIOpen()) return false;
  socket.emit("game:skill", { type: "ult" });
  Sfx.shot("sr");
  return true;
}

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
    resetControls();
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

// ESC/탭 전환 등으로 키가 갇히지 않도록 모든 입력 리셋 (무빙워크 방지)
window.addEventListener("blur", resetControls);
function resetControls() {
  const wasHeld = state.firing || state.ads || state.keys.w || state.keys.a || state.keys.s || state.keys.d || state.keys.shift || state.keys.space;
  state.keys.w = state.keys.a = state.keys.s = state.keys.d = state.keys.shift = state.keys.space = false;
  state.prevSpace = false;
  state.firing = false;
  state.ads = false;
  if (wasHeld && state.inGame) flushInput();
}

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
    } else {
      const btn = t.target.closest(".btn-control");
      if (btn) {
        const id = btn.id;
        if (id === "btn-fire") { state.firing = true; flushInput(); }
        else if (id === "btn-reload") { socket.emit("game:reload"); Sfx.reload(); }
        else if (id === "btn-swap") toggleBuyUI(false);
        else if (id === "btn-interact") startInteract(true);
        else if (id === "btn-smoke") useSmoke();
        else if (id === "btn-ult") useUlt();
        btnTimer.set(t.identifier, id);
      } else {
        // 나머지 화면 영역 → 스와이프로 시야 회전
        look.active = true; look.id = t.identifier; look.lx = t.clientX; look.ly = t.clientY;
      }
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

    // 스파이크 상태 — 설치됨(타이머) / 소지자 표시
    const spikeEl = $("#spike-status");
    if (state.spike.planted) {
      spikeEl.textContent = `💣 ${formatClock(state.timeLeft)}`;
      spikeEl.className = "planted";
      spikeEl.classList.remove("hidden");
    } else if (state.spike.carrierId) {
      const carrier = [...state.players.entries()].find(([id]) => id === state.spike.carrierId);
      const nm = myIsCarrier() ? "나" : (carrier ? (carrier[1].name || "아군") : "아군");
      spikeEl.textContent = `💣 스파이크: ${nm}`;
      spikeEl.className = "carrying";
      spikeEl.classList.remove("hidden");
    } else if (state.spike.dropped) {
      spikeEl.textContent = "💣 스파이크 드랍됨";
      spikeEl.className = "dropped";
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

    // 스킬 HUD
    const ultEl = $("#skill-ult");
    const ultPct = Math.min(100, Math.round(state.ultCharge || 0));
    const uc = $("#skill-ult-charge");
    if (uc) uc.textContent = ultPct >= 100 ? "궁극기!" : ultPct + "%";
    if (ultEl) ultEl.classList.toggle("ready", ultPct >= 100);
    const smokeReady = state.alive && state.phase === "combat";
    const smokeEl = $("#skill-smoke");
    if (smokeEl) {
      smokeEl.classList.toggle("ready", smokeReady);
      smokeEl.style.opacity = smokeReady ? 1 : 0.5;
    }
    const smokeBtn = $("#btn-smoke");
    if (smokeBtn) {
      smokeBtn.classList.toggle("ready", smokeReady);
      smokeBtn.setAttribute("aria-disabled", String(!smokeReady));
    }
    const ultBtn = $("#btn-ult");
    if (ultBtn) {
      const ultReady = smokeReady && ultPct >= 100;
      ultBtn.classList.toggle("ready", ultReady);
      ultBtn.setAttribute("aria-disabled", String(!ultReady));
    }
    // 스코프 오버레이 상태 동기화
    const scopeOvr = $("#scope-overlay");
    if (!(state.myWeapon === "sr" && state.ads && state.alive && state.phase === "combat")) {
      scopeOvr.classList.add("hidden");
    }

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

/* 캐릭터/맵/무기 선택 카드 */

let lobbyToastTimer = 0;
function lobbyToast(msg, color) {
  const el = $("#lobby-toast");
  if (!el) return;
  el.textContent = msg;
  el.style.color = color || "#8be28b";
  el.classList.remove("hidden");
  clearTimeout(lobbyToastTimer);
  lobbyToastTimer = setTimeout(() => el.classList.add("hidden"), 1700);
}

function pickPulse(el) {
  if (!el) return;
  el.classList.remove("pop");
  void el.offsetWidth;
  el.classList.add("pop");
  setTimeout(() => el.classList.remove("pop"), 300);
}

function updateLobbyLoadout(pulse) {
  const el = $("#lobby-loadout");
  if (!el) return;
  const ch = (state.characters || {})[state.myChar];
  const mp = (state.maps || {})[state.mapId];
  el.innerHTML = `<span class="lo-title">현재 설정</span>
    <span class="lo-item ${ch ? "on" : ""} ${pulse === "char" ? "pulse" : ""}">${ch ? (ch.emoji || "🎯") + " " + esc(ch.name) : "캐릭터 미선택"}<em>장착</em></span>
    <span class="lo-item ${mp ? "on" : ""} ${pulse === "map" ? "pulse" : ""}">🗺️ ${mp ? esc(mp.name) : "맵 미선택"}<em>선택</em></span>`;
}

const AGENT_META = {
  vanguard: { role: "INITIATOR" },
  rush: { role: "DUELIST" },
  guard: { role: "SENTINEL" },
  venom: { role: "CONTROLLER" },
};

function updateAgentShowcase() {
  const root = $("#agent-showcase");
  if (!root) return;
  const id = state.myChar || "vanguard";
  const ch = (state.characters || {})[id];
  const meta = AGENT_META[id] || { role: "AGENT" };
  root.className = "agent-showcase char-" + id;

  const text = (sel, value) => { const el = $(sel); if (el) el.textContent = value; };
  text("#showcase-role", meta.role);
  text("#showcase-name", ch?.name || "에이전트");
  text("#showcase-desc", ch?.desc || "에이전트 정보를 불러오는 중…");

  const hp = ch ? Math.round(150 * ch.hp) : 150;
  const spd = ch ? Math.round(ch.speed * 100) : 100;
  text("#showcase-hp", String(hp));
  text("#showcase-speed", spd + "%");

  const hpBar = $("#showcase-hp-bar");
  if (hpBar) hpBar.style.setProperty("--v", Math.min(100, hp / 2) + "%");
  const spBar = $("#showcase-speed-bar");
  if (spBar) spBar.style.setProperty("--v", Math.min(100, spd * 0.7) + "%");

  text("#showcase-skill", ch?.skillDesc || "");
  text("#showcase-ult", ch?.ultDesc || "");
}

function renderLobbySelect() {
  const chars = state.characters || {};
  const charEl = $("#char-select");
  if (charEl && Object.keys(chars).length) {
    charEl.innerHTML = Object.values(chars).map(ch => {
      const hp = Math.round(150 * ch.hp);
      const meta = AGENT_META[ch.id] || { role: "AGENT" };
      return `<button class="agent-card char-${ch.id} ${ch.id === state.myChar ? "sel" : ""}" data-char="${ch.id}" type="button" aria-label="${esc(ch.name)} 선택">
        <span class="agent-art"></span>
        <span class="agent-shade"></span>
        <span class="agent-check">✓</span>
        <span class="agent-meta">
          <span class="agent-role">${meta.role}</span>
          <span class="agent-name">${esc(ch.name)}</span>
          <span class="agent-stats">HP ${hp} · SPD ${Math.round(ch.speed * 100)}</span>
        </span>
      </button>`;
    }).join("");
    for (const b of charEl.querySelectorAll(".agent-card")) {
      b.addEventListener("click", () => {
        state.myChar = b.dataset.char;
        state.speedMult = (chars[state.myChar]?.speed) || 1;
        renderLobbySelect();
        pickPulse(charEl.querySelector(`.agent-card[data-char="${state.myChar}"]`));
        updateLobbyLoadout("char");
        lobbyToast(`✓ ${chars[state.myChar]?.name || "캐릭터"} 장착!`);
      });
    }
    updateAgentShowcase();
  } else if (charEl) {
    charEl.innerHTML = '<div class="pk-note">서버 연결 대기 중…</div>';
  }

  const mapsData = state.maps || {};
  const mapEl = $("#map-select");
  if (mapEl && Object.keys(mapsData).length) {
    mapEl.innerHTML = Object.values(mapsData).map(m => `
      <button class="map-card map-${m.id} ${m.id === state.mapId ? "sel" : ""}" data-map="${m.id}" type="button">
        <span class="map-art"></span>
        <span class="map-name">${esc(m.name)}</span>
        <span class="map-desc">${esc(m.desc || "")}</span>
      </button>`).join("");
    for (const b of mapEl.querySelectorAll(".map-card")) {
      b.addEventListener("click", () => {
        state.mapId = b.dataset.map;
        renderLobbySelect();
        pickPulse(mapEl.querySelector(`.map-card[data-map="${state.mapId}"]`));
        updateLobbyLoadout("map");
        lobbyToast(`✓ ${mapsData[state.mapId]?.name || "맵"} 선택! (방 만들 때 적용)`);
      });
    }
  } else if (mapEl) {
    mapEl.innerHTML = '<div class="pk-note">서버 연결 대기 중…</div>';
  }

  const weapons = state.weapons || {};
  const wEl = $("#weapon-info");
  if (wEl && Object.keys(weapons).length) {
    wEl.innerHTML = Object.values(weapons).map(w => {
      return `<div class="weapon-chip">
        <span class="w-icon">${w.icon || "🔫"}</span>
        <span class="w-copy">
          <span class="w-name">${esc(w.name)}</span>
          <span class="w-stats">DMG ${w.body} / HS ${w.head} · ${w.magSize}발</span>
        </span>
        <span class="w-price">${w.price === 0 ? "FREE" : w.price.toLocaleString()}</span>
      </div>`;
    }).join("");
  } else if (wEl) {
    wEl.innerHTML = '<div class="pk-note">서버 연결 대기 중…</div>';
  }

  updateLobbyLoadout();
}

/* 총구 섬광 — 총구/조준점 발광 제거 (비활성) */
function addMuzzleFlash() {
  // 총구 불빛·잔상 제거 — 아무것도 하지 않음
}

/* ================= 로비 UI ================= */

function renderLobby(room) {
  const isHost = room.host === socket.id;
  $("#lobby").classList.add("in-room");
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
  // 버그: 로비 재진입 시 이전 라운드의 맵/벽/사이트/플레이어 메시가 남아 중첩됐다 — 씬 정리 선행
  clearWorldObjects();
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

socket.on("server:ready", (d) => {
  if (d.characters) state.characters = d.characters;
  if (d.weapons) state.weapons = d.weapons;
  if (d.maps) state.maps = d.maps;
  renderLobbySelect();
});

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
  state.mapId = d.mapId;
  state.weapons = d.weapons || {};
  state.characters = d.characters || {};
  state.myChar = d.me?.charId || "vanguard";
  state.speedMult = 1;
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
  state.yaw = state.myTeam === "red" ? 0 : Math.PI;
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
  state.mapId = d.mapId;
  state.weapons = d.weapons || {};
  state.characters = d.characters || {};
  state.speedMult = 1;
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
  state.lastSnapStamp = performance.now();

  // 돌발 — 스파이크 드랍 상태 갱신
  setDropMarker();
  if (!state.myId) return;

  const mine = snap.players.find(p => p.id === state.myId) || null;
  if (mine) {
    state.myHP = mine.hp;
    state.maxHp = mine.maxHp || 150;
    state.speedMult = mine.speedMult || 1;
    state.myChar = mine.charId || state.myChar;
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
    state.ultCharge = typeof mine.ultCharge === "number" ? mine.ultCharge : state.ultCharge;
    if (mine.hasSpike) state.spike.carrierId = mine.id;
  }

  state.scores.red = snap.scores.red;
  state.scores.blue = snap.scores.blue;

  // 자기 좌표 보정 (서버) — 수직도 포함
  const self = snap.players.find(p => p.id === state.myId);
  if (self) {
    const dx = state.x - self.x, dz = state.z - self.z;
    if (Math.hypot(dx, dz) > RECONCILE_DIST) { state.x = self.x; state.z = self.z; state.vx = 0; state.vz = 0; }
    if (Math.abs(state.y - (self.y || 0)) > 0.6) { state.y = self.y || 0; state.vy = 0; }
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
      mesh.group.position.y = p.y || 0;
      mesh.group.rotation.y = p.yaw;
      ent = { group: mesh.group, hpBar: mesh.hpBar, spikeSpr: mesh.spikeSpr, name: p.nickname, target: { x: p.x, y: p.y || 0, z: p.z, yaw: p.yaw, hp: p.hp }, px: p.x, pz: p.z, pt: snap.t, vx: 0, vz: 0 };
      state.players.set(p.id, ent);
    }
    if (ent.spikeSpr) ent.spikeSpr.visible = !!p.hasSpike && p.alive !== false;
    if (ent.px != null && snap.t !== ent.pt) {
      const dtx = (snap.t - ent.pt) || 1;
      ent.vx = (p.x - ent.px) * (SERVER_TICK_RATE / dtx);
      ent.vz = (p.z - ent.pz) * (SERVER_TICK_RATE / dtx);
    }
    ent.px = p.x;
    ent.pz = p.z;
    ent.pt = snap.t;
    ent.target.x = p.x;
    ent.target.y = p.y || 0;
    ent.target.z = p.z;
    ent.target.yaw = p.yaw;
    ent.target.hp = p.hp;
    ent.kills = p.kills || 0; ent.deaths = p.deaths || 0; ent.assists = p.assists || 0;
    ent.hpBar.draw(p, null);
  }
  for (const [id, ent] of state.players) {
    if (!seen.has(id)) { scene.remove(ent.group); state.players.delete(id); }
  }

  // 스모크 동기화 (스냅샷) — born/dur 모두 서버 초 단위
  state.smokes = (snap.smokes || []).map(sm => ({ id: sm.id, x: sm.x, z: sm.z, r: sm.r, born: sm.born || 0, dur: sm.dur }));
  syncSmokeMeshes();

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
  state.yaw = state.myTeam === "red" ? 0 : Math.PI;
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
  } else if (!d.ok && d.weapon && d.weapon !== state.myWeapon) {
    // 버그: 실패 시 낙관적으로 바꿔둔 무기/뷰모델이 롤백되지 않아 표시가 어긋났다.
    // 서버가 실패 응답으로 보내주는 현재(진짜) 무기로 되돌린다 (money 는 위에서 확정).
    state.myWeapon = d.weapon;
    applyViewModel(d.weapon);
  }
  ui.update();
  if (buyUIOpen()) refreshBuyGrid();
});

socket.on("game:fx", (fx) => {
  // 내가 쏜 총알은 총구 앞에서부터 트레이서 시작 (시야 확보 — 특히 스나이퍼)
  let ox = fx.ox, oy = fx.oy, oz = fx.oz;
  const isMine = fx.shooter === state.myId;
  if (isMine) {
    const cast = 0.42;
    const len = Math.hypot(fx.dx, fx.dy, fx.dz) || 1;
    ox += (fx.dx / len) * cast;
    oy += (fx.dy / len) * cast;
    oz += (fx.dz / len) * cast;
  }
  // 밝고 두꺼운 트레이서 (Additive) — 총알이 보여야 발사 체감이 난다
  const color = fx.hit ? 0xffe066 : (fx.weapon === "sr" ? 0x66cfff : 0xd8e6ff);
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending });
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(ox, oy, oz),
    new THREE.Vector3(fx.hitX, fx.hitY, fx.hitZ),
  ]);
   // 발사 빛줄기(트레이서) 제거 — 시각효과 비활성
   if (false) {
   const line = new THREE.Line(geo, mat);
   scene.add(line);
   // 로컬 샷은 더 길게 표시 (탄속 체감)
   const life = fx.weapon === "sr" ? 0.2 : (isMine ? 0.12 : 0.09);
   state.tracers.push({ line, born: performance.now(), life });
   }

  // 총구 섬광 (내 총알만) — 발사 순간 화면 중앙 섬광
  if (isMine && fx.snd !== false) {
    Sfx.shot(fx.weapon);
    addMuzzleFlash();
  }
  if (isMine && fx.hit) showHitMarker();
   if (fx.hit && false) {
     const col = fx.weapon === "sr" ? 0xffd75f : 0xffffff;
     const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ color: col, transparent: true, opacity: 1, blending: THREE.AdditiveBlending }));
     sprite.position.set(fx.hitX, fx.hitY, fx.hitZ);
     sprite.scale.set(0.75, 0.75, 1);
     scene.add(sprite);
     state.impacts.push({ sprite, born: performance.now() });
   }
});

socket.on("skill:smoke", (d) => {
  if (!state.inGame) return;
  state.smokes.push({ id: "evt_" + performance.now(), x: d.x, z: d.z, r: d.r || 4.5, born: performance.now() / 1000, dur: d.dur || SMOKE_DURATION });
  syncSmokeMeshes();
});

socket.on("skill:ult", (d) => {
  if (!state.inGame) return;
  showUltTelegraph(d.x, d.z, d.r);
});

socket.on("skill:ultboom", (d) => {
  if (!state.inGame) return;
  showUltBoom(d.x, d.z);
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
  socket.emit("lobby:create", {
    nickname: ($("#nickname").value || "플레이어").trim().slice(0, 16) || "플레이어",
    charId: state.myChar,
    mapId: state.mapId,
  });
});
$("#btn-join").addEventListener("click", () => {
  const code = $("#join-code").value.trim().toUpperCase();
  if (!code) { showStatus("방 코드를 입력하세요."); return; }
  socket.emit("lobby:join", {
    roomId: code,
    nickname: ($("#nickname").value || "플레이어").trim().slice(0, 16) || "플레이어",
    charId: state.myChar,
  });
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
  // 버그: (btn-leave / btn-back-lobby) 로비 복귀 시 미정리된 3D 오브젝트가 다음 라운드에 중첩됐다
  clearWorldObjects();
  $("#end-screen").classList.add("hidden");
  $("#weapon-select").classList.add("hidden");
  $("#hud").classList.add("hidden");
  $("#lobby").classList.remove("hidden");
  $("#lobby").classList.remove("in-room");
  $("#lobby-room").classList.add("hidden");
  renderLobbySelect();
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
    const scopeFov = state.myWeapon === "sr" ? 26 : 42;
    const targetFov = state.ads ? scopeFov : 75;
    state.cam.fov += (targetFov - state.cam.fov) * Math.min(1, dt * 12);
    camera.fov = state.cam.fov;
    camera.updateProjectionMatrix();

    // 스나이퍼 스코프 오버레이 — 화면 어두워지는 효과 제거 (항상 숨김)
    const scopeOvr = $("#scope-overlay");
    if (scopeOvr) scopeOvr.classList.add("hidden");

    // 화면 흔들림 (궁극기 폭발 등) — 오프셋 적용은 아래 camera.position.set 이후에 수행

    // 뷰모델 ADS 위치 (x는 항상 중앙 고정)
    const vx = state.ads ? 0.04 : 0.28;
    const vy = state.ads ? -0.16 : -0.2;
    const vz = state.ads ? -0.65 : -0.88;
    viewmodel.position.x += (vx - viewmodel.position.x) * Math.min(1, dt * 14);
    viewmodel.position.y += (vy - viewmodel.position.y) * Math.min(1, dt * 14);
    viewmodel.position.z += (vz - viewmodel.position.z) * Math.min(1, dt * 14);
  }

  camera.position.set(state.x, EYE_HEIGHT + state.y, state.z);

  // 버그: 흔들림 오프셋이 set 이전에 더해져 매 프레임 set 이 덮어쓰며 효과가 없었다.
  // set 으로 정확한 위치를 복원한 뒤 흔들림을 더해야 화면 흔들림이 유지된다.
  if (state.screenShake > 0.001) {
    state.screenShake *= Math.pow(0.001, dt); // 빠르게 감쇠
    camera.position.x += (Math.random() - 0.5) * state.screenShake;
    camera.position.y += (Math.random() - 0.5) * state.screenShake;
  }
  const dx = Math.sin(state.yaw) * Math.cos(state.pitch);
  const dy = Math.sin(state.pitch);
  const dz = Math.cos(state.yaw) * Math.cos(state.pitch);
  camera.lookAt(camera.position.x + dx, camera.position.y + dy, camera.position.z + dz);

  /* 크로스헤어 — ADS 중에도 유지, 작게 */
  const dot = $("#crosshair");
  dot.classList.toggle("ads", state.ads);

  /* 리모트 보간 + 서버 레이턴시 예보(외삽) */
  const estDelay = (now - state.lastSnapStamp) / 1000;
  const extrap = Math.min(0.12, Math.max(0, estDelay));
  for (const [, ent] of state.players) {
    const g = ent.group;
    const t = 1 - Math.exp(-dt * 14);
    let ex = ent.target.x, ez = ent.target.z;
    if (ent.vx || ent.vz) { ex += ent.vx * extrap * 2; ez += ent.vz * extrap * 2; }
    g.position.x += (ex - g.position.x) * t;
    g.position.z += (ez - g.position.z) * t;
    g.position.y += (ent.target.y - g.position.y) * t;
    g.rotation.y += angDiff(ent.target.yaw, g.rotation.y) * t;
  }

  /* 트레이서/임팩트 수명 */
  for (let i = state.tracers.length - 1; i >= 0; i--) {
    const tr = state.tracers[i];
    const age = (now - tr.born) / 1000;
    const life = tr.life || 0.09;
    if (age > life) { scene.remove(tr.line); tr.line.geometry.dispose(); tr.line.material.dispose(); state.tracers.splice(i, 1); }
    else tr.line.material.opacity = 0.9 * (1 - age / life);
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

  /* 연막 수명/강도 (born/dur 초 단위) */
  const smNowS = now / 1000;
  for (let i = state.smokes.length - 1; i >= 0; i--) {
    const sm = state.smokes[i];
    const age = smNowS - sm.born;
    if (age > sm.dur + 0.5) {
      state.smokes.splice(i, 1);
      const mesh = smokeMeshes.get(sm.id);
      if (mesh) { scene.remove(mesh.mesh); if (mesh.inner) scene.remove(mesh.inner); smokeMeshes.delete(sm.id); }
    }
  }
  // 플레이어가 연막 안에 들어가면 시야 차폐 (연막 체감)
  {
    let inSmoke = 0;
    for (const sm of state.smokes) {
      const age = smNowS - sm.born;
      if (age > sm.dur) continue;
      const d = Math.hypot(state.x - sm.x, state.z - sm.z);
      if (d < sm.r) inSmoke = Math.max(inSmoke, 1 - d / sm.r);
    }
    const sb = $("#smoke-blind");
    if (sb) sb.style.opacity = String(Math.min(1, inSmoke));
  }
  for (const [id, m] of smokeMeshes) {
    const sm = state.smokes.find(s => s.id === id);
    if (!sm) continue;
    const ageS = smNowS - sm.born;
    const fade = Math.min(1, Math.max(0.25, 1 - (ageS - (sm.dur - 1.5)) / 1.5));
    m.mesh.material.opacity = 0.4 * fade;
    m.inner.material.opacity = 0.5 * fade;
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

  /* 입력 전송 — 원점(위치) 신선도 유지: 34ms 샘플 */
  const nowMs = now;
  if (state.phase === "combat" && state.alive && nowMs - state.lastInput >= INPUT_SAMPLE_MS) {
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