/* =========================================================
   client/main.js — Three.js 3D FPS 클라이언트
   - Rendering, Pointer Lock 조준, 입력 전송
   - 서버 스냅샷 기반 리모트 보간 + 자기 예측(가벼운)
========================================================= */

import * as THREE from "/vendor/three/build/three.module.js";

/* =========================================================
   상수 (서버와 동일)
========================================================= */

const EYE_HEIGHT = 1.6;
const PLAYER_RADIUS = 0.45;
const MOVE_SPEED = 5.5;
const SPRINT_MULT = 1.55;
const ACCEL = 12;
const INPUT_INTERVAL = 34; // ms
const RECONCILE_DIST = 3.5;

const TEAM_COLOR = { red: 0xe84c4c, blue: 0x4c8bee };

/* =========================================================
   소켓 & 전역 상태
========================================================= */

const socket = io();
const $ = (sel) => document.querySelector(sel);

const HOME_TEAM = { red: "RED", blue: "BLUE" };

const state = {
  inGame: false,
  map: null,
  players: new Map(),   // id -> { mesh group, target {...}, alive }
  mapObjects: [],       // 셀로 클린업용
  tracers: [],
  impacts: [],
  scores: { red: 0, blue: 0 },
  timeLeft: 0,
  killfeed: [],
  myPred: { x: 0, z: 0, vx: 0, vz: 0, yaw: 0, pitch: 0 },
  keys: { w: false, a: false, s: false, d: false, shift: false },
  firing: false,
  lastSend: 0,
  myHP: 100,
  myAlive: true,
  myWeapon: "ar",
  myAmmo: 30,
  myReloading: false,
};

function myId() { return socket.id; }

/* =========================================================
   렌더러 초기화
========================================================= */

const container = $("#game-canvas");
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9db4d6);
scene.fog = new THREE.Fog(0x9db4d6, 80, 200);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 400);
camera.rotation.order = "YXZ";

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
container.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x8899bb, 1.0));
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(40, 80, 20);
scene.add(sun);

/* =========================================================
   나만 보는 1인칭 총 모델 (뷰모델)
========================================================= */

const viewmodel = new THREE.Group();
{
  const mat = new THREE.MeshLambertMaterial({ color: 0x3a4258 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.14, 0.62), mat);
  body.position.set(0, 0, -0.25);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.18, 0.16), mat);
  grip.position.set(0, -0.16, 0.02);
  const matDark = new THREE.MeshLambertMaterial({ color: 0x22262f });
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.5), matDark);
  barrel.position.set(0, 0.02, -0.6);
  viewmodel.add(body, grip, barrel);
  viewmodel.position.set(0.28, -0.28, -0.5);
}
camera.add(viewmodel);

/* =========================================================
   월드 빌드 (서버가 보내준 MAP 기준)
========================================================= */

function buildWorld(map) {
  clearWorld();

  const hs = map.halfSize;

  // 바닥
  const groundTex = makeGridTexture(hs);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(hs * 2, hs * 2),
    new THREE.MeshLambertMaterial({ map: groundTex })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0;
  scene.add(ground);
  state.mapObjects.push(ground);

  // 팀 스폰 영역 표시
  for (const team of ["red", "blue"]) {
    for (const sp of map.spawns[team]) {
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(1.3, 24),
        new THREE.MeshLambertMaterial({ color: TEAM_COLOR[team], transparent: true, opacity: 0.25 })
      );
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(sp.x, 0.02, sp.z);
      scene.add(disc);
      state.mapObjects.push(disc);
    }
  }

  // 장애물
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

  // 경계 벽
  const wallMat = new THREE.MeshLambertMaterial({ color: 0x2b3350, transparent: true, opacity: 0.9 });
  const wallGeo = new THREE.BoxGeometry(hs * 2, map.wallHeight + 2, 1);
  const walls = [
    [0, 0, hs, 0],
    [0, 0, -hs, 0],
    [hs, 0, 0, Math.PI / 2],
    [-hs, 0, 0, Math.PI / 2],
  ];
  for (const [x, , z, ry] of walls) {
    const w = new THREE.Mesh(wallGeo, wallMat);
    w.rotation.y = ry;
    w.position.set(x, (map.wallHeight + 2) / 2, z);
    scene.add(w);
    state.mapObjects.push(w);
  }
}

function clearWorld() {
  for (const o of state.mapObjects) scene.remove(o);
  state.mapObjects = [];
  // 리모트 플레이어 메시 정리
  for (const [, p] of state.players) cleanupPlayerMesh(p);
  state.players.clear();
  clearTracers();
}

/* =========================================================
   그리드 텍스처 (바닥)
========================================================= */

function makeGridTexture(hs) {
  const size = 1024;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const ctx = cv.getContext("2d");

  ctx.fillStyle = "#8fa1bd";
  ctx.fillRect(0, 0, size, size);

  // 격자선 (4유닛 간격)
  ctx.strokeStyle = "#7c8fae";
  ctx.lineWidth = 1;
  const stepWorld = 4;
  for (let w = -hs; w <= hs; w += stepWorld) {
    const p = ((w + hs) / (hs * 2)) * size;
    ctx.beginPath();
    ctx.moveTo(p, 0); ctx.lineTo(p, size);
    ctx.moveTo(0, p); ctx.lineTo(size, p);
    ctx.stroke();
  }

  // 중앙 라인 (팀 기점)
  ctx.strokeStyle = "#33415c";
  ctx.lineWidth = 3;
  const mid = (hs / (hs * 2)) * size;
  ctx.beginPath();
  ctx.moveTo(mid, 0); ctx.lineTo(mid, size);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  return tex;
}

/* =========================================================
   플레이어 메시 (원격 + 자기)
========================================================= */

function makePlayerMesh(nickname, team) {
  const group = new THREE.Group();
  const color = TEAM_COLOR[team];

  const bodyMat = new THREE.MeshLambertMaterial({ color });
  const darkMat = new THREE.MeshLambertMaterial({ color: 0x22262f });
  const skinMat = new THREE.MeshLambertMaterial({ color: 0xd8b28a });

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.72, 1.25, 0.44), bodyMat);
  body.position.y = 0.63;

  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.4, 0.5), darkMat);
  chest.position.set(0, 1.05, 0);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.42), skinMat);
  head.position.y = 1.62;

  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.7), darkMat);
  gun.position.set(0.3, 1.0, 0.5);

  const nameSprite = makeNameSprite(nickname, team);
  nameSprite.position.set(0, 2.35, 0);

  group.add(body, chest, head, gun, nameSprite);
  return { group, body, head, gun, nameSprite };
}

function makeNameSprite(text, team) {
  const cv = document.createElement("canvas");
  cv.width = 256; cv.height = 64;
  const ctx = cv.getContext("2d");
  const color = team === "red" ? "#ff8a8a" : "#8ab6ff";
  ctx.font = "bold 34px 'Malgun Gothic', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,0.85)";
  ctx.shadowBlur = 8;
  ctx.fillStyle = color;
  ctx.fillText(text, 128, 32);
  const tex = new THREE.CanvasTexture(cv);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(2.2, 0.55, 1);
  return sprite;
}

function cleanupPlayerMesh(p) {
  scene.remove(p.group);
}

/* =========================================================
   상호 보간 (리모트 플레이어)
========================================================= */

function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/* =========================================================
   로컬 예측 이동 — 서버와 동일한 이동 공식을 재현
========================================================= */

function predictStep(p, keys, dt) {
  const walk = keys.shift ? SPRINT_MULT : 1;
  const y = p.yaw;
  let ix = 0, iz = 0;
  if (keys.w) { ix += Math.sin(y); iz += Math.cos(y); }
  if (keys.s) { ix -= Math.sin(y); iz -= Math.cos(y); }
  if (keys.a) { ix -= Math.cos(y); iz += Math.sin(y); }
  if (keys.d) { ix += Math.cos(y); iz -= Math.sin(y); }
  const il = Math.sqrt(ix * ix + iz * iz) || 1;
  ix /= il; iz /= il;
  const tx = ix * MOVE_SPEED * walk;
  const tz = iz * MOVE_SPEED * walk;
  p.vx += (tx - p.vx) * Math.min(1, ACCEL * dt);
  p.vz += (tz - p.vz) * Math.min(1, ACCEL * dt);
  p.x += p.vx * dt;
  p.z += p.vz * dt;

  if (state.map) {
    for (const box of state.map.obstacles) {
      [p.x, p.z] = circleAABB(p.x, p.z, PLAYER_RADIUS, box);
    }
  }
  const hs = state.map ? state.map.halfSize - PLAYER_RADIUS : 999;
  p.x = Math.max(-hs, Math.min(hs, p.x));
  p.z = Math.max(-hs, Math.min(hs, p.z));
}

function circleAABB(px, pz, r, box) {
  const hx = box.w / 2, hz = box.d / 2;
  const cx = Math.max(box.x - hx, Math.min(box.x + hx, px));
  const cz = Math.max(box.z - hz, Math.min(box.z + hz, pz));
  const dx = px - cx, dz = pz - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 < r * r) {
    if (d2 < 1e-10) {
      const penX = (px < box.x ? box.x - hx - r : box.x + hx + r) - px;
      const penZ = (pz < box.z ? box.z - hz - r : box.z + hz + r) - pz;
      if (Math.abs(penX) < Math.abs(penZ)) px += penX; else pz += penZ;
      return [px, pz];
    }
    const d = Math.sqrt(d2);
    const overlap = r - d;
    px += (dx / d) * overlap;
    pz += (dz / d) * overlap;
  }
  return [px, pz];
}

/* =========================================================
   입력 (포인터 락 + 키보드)
========================================================= */

let camRecoil = 0;
const SENS = 0.0022;

document.addEventListener("mousemove", (e) => {
  if (!state.inGame || document.pointerLockElement !== renderer.domElement) return;
  state.myPred.yaw = state.myPred.yaw + e.movementX * SENS;
  state.myPred.pitch = Math.max(-1.52, Math.min(1.52, state.myPred.pitch - e.movementY * SENS));
});

window.addEventListener("keydown", (e) => {
  switch (e.code) {
    case "KeyW": state.keys.w = true; break;
    case "KeyA": state.keys.a = true; break;
    case "KeyS": state.keys.s = true; break;
    case "KeyD": state.keys.d = true; break;
    case "ShiftLeft": case "ShiftRight": state.keys.shift = true; break;
    case "KeyR":
      state.myReloading = true;
      socket.emit("game:reload");
      Sfx.reload();
      break;
    case "Digit1": switchWeapon("smg"); break;
    case "Digit2": switchWeapon("ar"); break;
    case "Digit3": switchWeapon("sr"); break;
  }
});
window.addEventListener("keyup", (e) => {
  switch (e.code) {
    case "KeyW": state.keys.w = false; break;
    case "KeyA": state.keys.a = false; break;
    case "KeyS": state.keys.s = false; break;
    case "KeyD": state.keys.d = false; break;
    case "ShiftLeft": case "ShiftRight": state.keys.shift = false; break;
  }
});

function switchWeapon(id) {
  socket.emit("game:weapon", { weapon: id });
  state.myWeapon = id;
  state.myReloading = false;
  Sfx.switchW();
}

renderer.domElement.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  if (!state.inGame) return;
  if (document.pointerLockElement !== renderer.domElement) {
    renderer.domElement.requestPointerLock();
    return;
  }
  state.firing = true;
});
window.addEventListener("mouseup", (e) => {
  if (e.button === 0) state.firing = false;
});

document.addEventListener("pointerlockchange", () => {
  const locked = document.pointerLockElement === renderer.domElement;
  $("#pause").classList.toggle("hidden", locked || !state.inGame);
  if (!locked) state.firing = false;
});

renderer.domElement.addEventListener("pointerlockerror", () => {
  if (state.inGame) $("#pause").classList.remove("hidden");
});

// 일시정지 오버레이 클릭 = 조준 재개
$("#pause").addEventListener("click", () => {
  if (state.inGame) renderer.domElement.requestPointerLock();
});

/* =========================================================
   사운드 (WebAudio 합성)
========================================================= */

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
  function noiseBurst(duration, filterFreq, q, gain) {
    const c = ensure();
    if (!c) return;
    const bufferSize = c.sampleRate * duration;
    const buf = c.createBuffer(1, bufferSize, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    const src = c.createBufferSource();
    src.buffer = buf;
    const filt = c.createBiquadFilter();
    filt.type = "bandpass";
    filt.frequency.value = filterFreq;
    filt.Q.value = q;
    const g = c.createGain();
    g.gain.value = gain;
    src.connect(filt).connect(g).connect(c.destination);
    src.start();
  }
  return {
    shot(w) {
      const cfg = {
        smg: [3200, 0.9, 0.03],
        ar: [2000, 1.4, 0.05],
        sr: [900, 2, 0.09],
      };
      const [f, q, g] = cfg[w] || cfg.ar;
      noiseBurst(0.08, f, q, g);
    },
    reload() { noiseBurst(0.05, 1500, 4, 0.04); },
    switchW() { noiseBurst(0.03, 2400, 4, 0.03); },
    hit() { noiseBurst(0.03, 5000, 2, 0.06); },
    death() { noiseBurst(0.4, 400, 1, 0.1); },
    unlock() { ensure(); },
  };
})();

/* =========================================================
   HUD 업데이트
========================================================= */

const WEAPON_LABEL = { smg: "SMG", ar: "AR", sr: "Sniper" };

function updateHud() {
  $("#healthfill").style.width = Math.max(0, Math.min(100, state.myHP)) + "%";
  $("#kd").textContent = state.myKD ? `${state.myKD.kills}/${state.myKD.deaths}` : "0/0";
  $("#weapon-name").textContent = WEAPON_LABEL[state.myWeapon] || "AR";
  const ammoEl = $("#ammo");
  if (state.myReloading) {
    ammoEl.textContent = "재장전 중…";
    ammoEl.classList.remove("low");
  } else {
    ammoEl.textContent = `${state.myAmmo} / ∞`;
    ammoEl.classList.toggle("low", state.myAmmo <= 5);
  }
  $("#score-red").textContent = state.scores.red;
  $("#score-blue").textContent = state.scores.blue;
  const t = Math.max(0, Math.ceil(state.timeLeft));
  $("#timer").textContent = `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
  $("#my-team-tag").textContent = HOME_TEAM[state.myTeam] || "";
  $("#my-team-tag").className = "red";
  if (state.myTeam) {
    $("#my-team-tag").classList.add(state.myTeam);
  }
}

let hitmarkerTimer = null;
function showHitmarker() {
  const hm = $("#hitmarker");
  hm.classList.remove("hidden");
  clearTimeout(hitmarkerTimer);
  hitmarkerTimer = setTimeout(() => hm.classList.add("hidden"), 220);
}

let dmgTimer = null;
function flashDamage() {
  const dv = $("#damage-vignette");
  dv.style.opacity = 0.7;
  clearTimeout(dmgTimer);
  dmgTimer = setTimeout(() => { dv.style.opacity = 0; }, 300);
}

function addKillfeed(killer, killerTeam, victim, victimTeam, headshot) {
  const kf = $("#killfeed");
  const item = document.createElement("div");
  item.className = "kill-item";
  item.innerHTML =
    `<span class="killer ${killerTeam || ""}">${escapeHtml(killer)}</span>` +
    `<span class="victim"> → ${escapeHtml(victim)}</span>` +
    (headshot ? `<span class="hs">💀 헤드샷</span>` : "");
  kf.appendChild(item);
  while (kf.children.length > 5) kf.removeChild(kf.firstChild);
  setTimeout(() => { item.remove(); }, 5000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* =========================================================
   로비 UI
========================================================= */

const DEFAULT_NICK = localStorage.getItem("shooter_nick") || "";
$("#nickname").value = DEFAULT_NICK;

function setStatus(msg, color) {
  const el = $("#lobby-status");
  el.textContent = msg;
  el.style.color = color || "#ff7a7a";
}

$("#btn-create").addEventListener("click", () => {
  const nick = ($("#nickname").value || "플레이어").trim().slice(0, 16) || "플레이어";
  localStorage.setItem("shooter_nick", nick);
  socket.emit("lobby:create", { nickname: nick });
});

$("#btn-join").addEventListener("click", () => {
  const nick = ($("#nickname").value || "플레이어").trim().slice(0, 16) || "플레이어";
  const code = $("#join-code").value.trim().toUpperCase();
  if (!code) { setStatus("방 코드를 입력해주세요."); return; }
  localStorage.setItem("shooter_nick", nick);
  socket.emit("lobby:join", { roomId: code, nickname: nick });
});

// 방 코드를 URL 쿼리(?room=)로 자동 채우기
{
  const c = new URLSearchParams(location.search).get("room");
  if (c) $("#join-code").value = c.toUpperCase();
}

$("#btn-start").addEventListener("click", () => {
  socket.emit("lobby:start");
});

$("#btn-back-lobby").addEventListener("click", () => {
  $("#end-screen").classList.add("hidden");
  $("#lobby").classList.remove("hidden");
});

function enterLobby(room) {
  state.inGame = false;
  $("#hud").classList.add("hidden");
  $("#end-screen").classList.add("hidden");
  $("#death-screen").classList.add("hidden");
  $("#lobby").classList.remove("hidden");
  state.myTeam = room.players.find(p => p.socketId === socket.id)?.team || null;
  renderLobby(room);
}

function renderLobby(room) {
  const isHost = room.host === socket.id;
  $("#lobby-room").classList.remove("hidden");
  $("#room-code").textContent = room.roomId;
  $("#player-list").innerHTML = room.players.map(p => `
    <div class="player-item">
      <span class="pdot ${p.team}"></span>
      <span class="pname">${escapeHtml(p.nickname)}${p.socketId === socket.id ? " (나)" : ""}${!p.connected ? " (이탈)" : ""}</span>
      ${p.socketId === room.host ? '<span class="phost">방장</span>' : ""}
    </div>`).join("");
  $("#btn-start").classList.toggle("hidden", !isHost);
}

/* =========================================================
   소켓 이벤트
========================================================= */

socket.on("server:ready", () => {});

socket.on("lobby:created", (d) => {
  if (!d.ok) return;
  setStatus("");
  enterLobby(d.room);
});
socket.on("lobby:join", (d) => {
  if (!d.ok) { setStatus(d.reason); return; }
  setStatus("");
  enterLobby(d.room);
});
socket.on("lobby:state", (room) => {
  state.myTeam = room.players.find(p => p.socketId === socket.id)?.team || null;
  renderLobby(room);
});
socket.on("lobby:start", (d) => {
  if (!d.ok && d.reason) setStatus(d.reason);
});

/* ---- 게임 중 참전 (맵 동기화) ---- */

socket.on("game:sync", (d) => {
  if (state.inGame) return;
  state.map = d.map;
  state.inGame = true;
  state.scores = { red: 0, blue: 0 };
  state.killfeed = [];
  state.myPred = { x: 0, z: 0, vx: 0, vz: 0, yaw: 0, pitch: 0 };
  state.keys = { w: false, a: false, s: false, d: false, shift: false };
  state.firing = false;
  buildWorld(d.map);
  $("#lobby").classList.add("hidden");
  $("#end-screen").classList.add("hidden");
  $("#death-screen").classList.add("hidden");
  $("#hud").classList.remove("hidden");
  $("#killfeed").innerHTML = "";
  renderer.domElement.requestPointerLock();
  Sfx.unlock();
});

/* ---- 게임 시작 ---- */

socket.on("game:started", (d) => {
  if (!d.ok) return;
  state.map = d.map;
  state.inGame = true;
  state.scores = { red: 0, blue: 0 };
  state.killfeed = [];
  state.myTeam = d.me?.team || null;
  state.myPred = { x: 0, z: 0, vx: 0, vz: 0, yaw: 0, pitch: 0 };
  state.keys = { w: false, a: false, s: false, d: false, shift: false };
  state.firing = false;

  // 첫 스냅샷으로 내 위치 초기화
  for (const p of (d.state?.players || [])) {
    if (p.id === myId()) {
      state.myPred.x = p.x;
      state.myPred.z = p.z;
      state.myPred.yaw = p.yaw;
      state.myPred.pitch = p.pitch;
    }
  }

  buildWorld(d.map);

  $("#lobby").classList.add("hidden");
  $("#end-screen").classList.add("hidden");
  $("#death-screen").classList.add("hidden");
  $("#hud").classList.remove("hidden");
  $("#killfeed").innerHTML = "";

  renderer.domElement.requestPointerLock();
  Sfx.unlock();
});

/* ---- 게임 상태 스냅샷 ---- */

socket.on("game:state", (snap) => {
  state.scores = snap.scores;
  state.timeLeft = snap.timeLeft;

  const seen = new Set();
  for (const sp of snap.players) {
    seen.add(sp.id);
    let p = state.players.get(sp.id);
    if (!p) {
      const mesh = makePlayerMesh(sp.nickname, sp.team);
      mesh.group.position.set(sp.x, 0, sp.z);
      mesh.group.rotation.y = sp.yaw;
      scene.add(mesh.group);
      p = { group: mesh, target: { x: sp.x, z: sp.z, yaw: sp.yaw, pitch: sp.pitch } };
      state.players.set(sp.id, p);
    }
    // 서버가 리스폰시킨 좌표 변화는 즉시 반영 (리모트/자기)
    p.target.x = sp.x;
    p.target.z = sp.z;
    p.target.yaw = sp.yaw;
    p.target.pitch = sp.pitch;

    if (sp.id === myId()) {
      state.myTeam = sp.team;
      state.myHP = sp.hp;
      state.myAlive = sp.alive;
      state.myWeapon = sp.weapon;
      state.myAmmo = sp.ammo;
      state.myReloading = sp.reloading;
      state.myKD = { kills: sp.kills, deaths: sp.deaths };

      // 자기 예측 위치와 서버 위치 비교 — 차이가 크면 보정
      const dx = state.myPred.x - sp.x;
      const dz = state.myPred.z - sp.z;
      if (Math.hypot(dx, dz) > RECONCILE_DIST || !sp.alive) {
        state.myPred.x = sp.x;
        state.myPred.z = sp.z;
        state.myPred.vx = 0;
        state.myPred.vz = 0;
      }

      if (!sp.alive) {
        $("#death-screen").classList.remove("hidden");
      } else {
        $("#death-screen").classList.add("hidden");
      }
      updateHud();
    }
  }

  // 퇴장 플레이어 정리
  for (const [id, p] of state.players) {
    if (!seen.has(id)) {
      cleanupPlayerMesh(p);
      state.players.delete(id);
    }
  }
});

/* ---- 이벤트 (사격/피격/킬/리스폰) ---- */

socket.on("game:fx", (fx) => {
  // 사선 (tracer)
  const mat = new THREE.LineBasicMaterial({ color: fx.hit ? 0xffe066 : 0xcfd8e6, transparent: true, opacity: 0.9 });
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(fx.ox, fx.oy, fx.oz),
    new THREE.Vector3(fx.hitX, fx.hitY, fx.hitZ),
  ]);
  const line = new THREE.Line(geo, mat);
  scene.add(line);
  state.tracers.push({ line, born: performance.now() });

  // 발사음 (내가 쏜 것만 크게)
  if (fx.shooter === myId()) Sfx.shot(fx.weapon);

  // 임팩트 이펙트 (히트 시)
  if (fx.hit) {
    makeImpact(new THREE.Vector3(fx.hitX, fx.hitY, fx.hitZ), fx.weapon);
  }
});

function makeImpact(pos, weapon) {
  const color = weapon === "sr" ? 0xffd75f : 0xffffff;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ color, transparent: true, opacity: 0.9 })
  );
  sprite.position.copy(pos);
  sprite.scale.set(0.5, 0.5, 1);
  scene.add(sprite);
  state.impacts.push({ sprite, born: performance.now() });
}

socket.on("game:hurt", (d) => {
  if (d.pid === myId()) {
    flashDamage();
  }
  if (d.byId === myId() && d.pid !== myId()) {
    showHitmarker();
    Sfx.hit();
  }
});

socket.on("game:kill", (d) => {
  addKillfeed(d.killerName, d.killerTeam, d.victimName, d.victimTeam, d.headshot);
  if (d.victimId === myId()) {
    Sfx.death();
    $("#death-screen").classList.remove("hidden");
  }
  if (d.killerId === myId() && d.victimId !== myId()) {
    Sfx.hit();
  }
});

socket.on("game:spawn", (d) => {
  const p = state.players.get(d.pid);
  if (p) { p.target.x = d.x; p.target.z = d.z; }
  if (d.pid === myId()) {
    state.myPred.x = d.x;
    state.myPred.z = d.z;
    state.myPred.vx = 0; state.myPred.vz = 0;
    $("#death-screen").classList.add("hidden");
  }
});

socket.on("game:ended", (d) => {
  state.inGame = false;
  state.firing = false;
  if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
  $("#death-screen").classList.add("hidden");
  $("#hud").classList.add("hidden");
  $("#end-screen").classList.remove("hidden");
  $("#end-title").textContent =
    d.winner === "draw" ? "무승부" :
    d.winner === state.myTeam ? "🎉 우리 팀 승리!" : "패배";
  $("#end-title").style.color = d.winner === "draw" ? "#dfe5f0" : d.winner === state.myTeam ? "#4ade80" : "#ff6b6b";
  $("#end-score").textContent = `RED ${d.scores.red} : ${d.scores.blue} BLUE`;
  clearWorld();
});

/* =========================================================
   렌더 루프
========================================================= */

let lastFrame = performance.now();

function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  if (state.inGame && state.myAlive && document.pointerLockElement === renderer.domElement) {
    // 자기 예측 이동
    predictStep(state.myPred, state.keys, dt);

    // 카메라 배치
    const cx = state.myPred.x;
    const cz = state.myPred.z;
    camera.position.set(cx, EYE_HEIGHT, cz);

    // 반동 자연스럽게 감쇠
    camRecoil = Math.max(0, camRecoil - dt * 6);

    const cdir = new THREE.Vector3(
      Math.sin(state.myPred.yaw) * Math.cos(state.myPred.pitch),
      Math.sin(state.myPred.pitch),
      Math.cos(state.myPred.yaw) * Math.cos(state.myPred.pitch)
    );
    camera.lookAt(camera.position.clone().add(cdir));
    camera.rotateX(camRecoil * 0.04);

    // 뷰모델 흔들림
    viewmodel.position.set(0.28, -0.28 - camRecoil * 0.02, -0.5);

    // 입력 전송 (30Hz 근처)
    if (now - state.lastSend >= INPUT_INTERVAL) {
      state.lastSend = now;
      socket.emit("game:input", {
        keys: state.keys,
        yaw: state.myPred.yaw,
        pitch: state.myPred.pitch,
        firing: state.firing,
      });
    }
  }

  // 리모트 플레이어 보간
  const t = 1 - Math.exp(-dt * 14);
  for (const [, p] of state.players) {
    const g = p.group;
    if (!g) continue;
    g.position.x += (p.target.x - g.position.x) * t;
    g.position.z += (p.target.z - g.position.z) * t;
    g.rotation.y = lerpAngle(g.rotation.y, p.target.yaw, t);
  }

  // 트레이서 수명
  for (let i = state.tracers.length - 1; i >= 0; i--) {
    const tr = state.tracers[i];
    const age = (now - tr.born) / 1000;
    if (age > 0.09) {
      scene.remove(tr.line);
      tr.line.geometry.dispose();
      tr.line.material.dispose();
      state.tracers.splice(i, 1);
    } else {
      tr.line.material.opacity = 0.9 * (1 - age / 0.09);
    }
  }
  for (let i = state.impacts.length - 1; i >= 0; i--) {
    const ip = state.impacts[i];
    const age = (now - ip.born) / 1000;
    const s = 0.5 + age * 2;
    ip.sprite.scale.set(s, s, 1);
    ip.sprite.material.opacity = Math.max(0, 0.9 * (1 - age / 0.35));
    if (age > 0.35) {
      scene.remove(ip.sprite);
      ip.sprite.material.dispose();
      state.impacts.splice(i, 1);
    }
  }

  renderer.render(scene, camera);
}

function clearTracers() {
  for (const tr of state.tracers) {
    scene.remove(tr.line);
    tr.line.geometry.dispose();
    tr.line.material.dispose();
  }
  state.tracers = [];
  for (const ip of state.impacts) {
    scene.remove(ip.sprite);
    ip.sprite.material.dispose();
  }
  state.impacts = [];
}

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

requestAnimationFrame(animate);