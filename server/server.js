"use strict";

/* =========================================================
   server/server.js — express + socket.io 서버
   방 관리 / 팀 자동 배정 / 게임 루프 / 이벤트 중계
========================================================= */

const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const { WEAPONS, MAPS, CHARACTERS, TICK_RATE, STATE_RATE, createMatch } = require("./game.js");

const ROOT_DIR = path.join(__dirname, "..");
const CLIENT_DIR = path.join(ROOT_DIR, "client");
const PORT = process.env.PORT || 3000;
const TARGET_PER_TEAM = 5; // 봇으로 팀별 5vs5 보충 (인간이 없을 때만)
const BOT_NAMES = ["로봇", "알레망", "레이", "닉스", "토르", "바이퍼", "스카", "버트", "헌터", "제트"];
let botSeq = 0;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
});

/* three.js를 /vendor 경로로 서빙 (import가 가능하도록) */
app.use("/vendor", express.static(path.join(ROOT_DIR, "node_modules")));
app.use(express.static(CLIENT_DIR));

app.get("/", (req, res) => res.sendFile(path.join(CLIENT_DIR, "index.html")));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, rooms: ROOMS.size, tickRate: TICK_RATE, stateRate: STATE_RATE });
});

/* =========================================================
   방 관리
   room = {
     id, host, status("lobby"|"playing"),
     players: [ {socketId, nickname, team, connected} ],
     match,     // createMatch 결과 (게임 중일 때 유효)
     tickCount,
   }
========================================================= */

const ROOMS = new Map();

function createRoomId() {
  let id;
  do { id = Math.random().toString(36).slice(2, 6).toUpperCase(); } while (ROOMS.has(id));
  return id;
}

function teamFor(room) {
  const rc = room.players.filter(p => p.connected && p.team === "red").length;
  const bc = room.players.filter(p => p.connected && p.team === "blue").length;
  return rc <= bc ? "red" : "blue";
}

function roomState(room) {
  return {
    roomId: room.id,
    host: room.host,
    status: room.status,
    mapId: room.mapId || "center",
    players: room.players.map(p => ({
      socketId: p.socketId,
      nickname: p.nickname,
      team: p.team,
      connected: p.connected,
      isBot: !!p.isBot,
      charId: p.charId || "vanguard",
    })),
  };
}

function broadcastLobby(room) {
  if (!room) return;
  io.to(room.id).emit("lobby:state", roomState(room));
}

/* =========================================================
   봇 — 팀별 부족 인원을 채워서 혼자서도 바로 플레이 가능
   단, "방장 외 인간 플레이어가 1명 이상 있으면 AI 제거" 정책.
   → 인간이 2명 미만(순수 솔로)일 때만 봇 보충.
========================================================= */

function humanCount(room) {
  return room.players.filter(p => p.connected && !p.isBot).length;
}

function fillBots(room) {
  // 방장 제외 참여한 인간이 1명 이상이면 AI 미보충
  if (humanCount(room) >= 2) {
    clearBots(room);
    return;
  }
  clearBots(room);
  for (const team of ["red", "blue"]) {
    let count = room.players.filter(p => p.team === team && p.connected).length;
    while (count < TARGET_PER_TEAM) {
      const id = "bot-" + (++botSeq);
      const nick = BOT_NAMES[(botSeq - 1) % BOT_NAMES.length] + botSeq;
      const charId = (["vanguard", "rush", "guard", "venom"])[botSeq % 4];
      room.players.push({ socketId: id, nickname: nick, team, connected: true, isBot: true, charId });
      room.match.addPlayer({ id, nickname: nick, team, charId });
      count++;
    }
  }
  console.log(`[BOTS] ${room.id} red=${room.players.filter(p => p.team === "red" && p.isBot).length} blue=${room.players.filter(p => p.team === "blue" && p.isBot).length}`);
}

function clearBots(room) {
  for (const bp of room.players) {
    if (bp.isBot && room.match) room.match.removePlayer(bp.socketId);
  }
  room.players = room.players.filter(p => !p.isBot);
}

function inSiteZone(p, map) {
  const mapData = map || MAPS.center;
  for (const key of ["A", "B"]) {
    const s = mapData.sites[key];
    if (Math.abs(p.x - s.cx) < s.w / 2 && Math.abs(p.z - s.cz) < s.d / 2) return key;
  }
  return null;
}

function resetBotRound(me, round) {
  me._bot = {
    site: me.x < 0 ? "A" : "B",
    wpIdx: 0,
    bought: false,
    interacting: false,
    interactType: null,
    stuck: 0,
    nudgeT: 0,
    lastX: me.x,
    lastZ: me.z,
    // AI 난이도: 반응 시간 + 조준 오차 (봇별 랜덤 0.6~1.0)
    skill: 0.6 + Math.random() * 0.4,
    reactUntil: 0,
    holdAim: null,
    burstLeft: 0,
    nextShotT: 0,
  };
  me._botRound = round;
}

function stepBot(room, botId) {
  const m = room.match;
  const me = m.getPlayer(botId);
  if (!me) return;

  if (me._botRound !== m.round) resetBotRound(me, m.round);
  const bot = me._bot;
  if (!bot) return;

  const now = m._now();

  /* 구매 단계: 이동 금지 · 자동 구매 후 대기 */
  if (m.phase === "buy") {
    m.input(botId, { keys: { w: false, a: false, s: false, d: false, shift: false, space: false }, firing: false, ads: false });
    if (!bot.bought) {
      bot.bought = true;
      // AI 경제 보정: 최소한 SMG 살 돈은 있게 (발로란트 감성 유지 + 난이도)
      if (me.money < 1600) me.money = 1600;
      if (!m.buy(botId, "ar") && me.money >= 2900) m.buy(botId, "ar");
      if (me.weapon === "pistol") m.buy(botId, "smg");
    }
    if (bot.interacting) { m.interact(botId, { action: "stop" }); bot.interacting = false; }
    return;
  }

  if (!me.alive || m.phase !== "combat") {
    m.input(botId, { keys: { w: false, a: false, s: false, d: false, shift: false, space: false }, firing: false, ads: false });
    if (bot.interacting) { m.interact(botId, { action: "stop" }); bot.interacting = false; }
    return;
  }

  /* 목표 선택 — 시야(LOS)가 있어야 인식 (벽 뒤 위치 추적 금지) */
  const map = m.map || MAPS.center;
  const enemies = m.getPlayers().filter(t => t.id !== botId && t.alive && t.team !== me.team);
  let target = null, los = false, bestD = Infinity;
  for (const t of enemies) {
    if (!m.hasLos(botId, t.id)) continue;   // 벽/연막 뒤 적은 '보지 못함'
    const d = Math.hypot(t.x - me.x, t.z - me.z);
    if (d > 42) continue;                   // 유효 교전 거리 밖 — 진격 우선 (전맵 저격 방지)
    if (d < bestD) { bestD = d; target = t; los = true; }
  }
  // 최근에 본 적 위치 메모리 (짧은 시간만, 정확도 낮춤)
  let ghost = null;
  if (!target && bot.memory && now - bot.memory.t < 3.0) ghost = bot.memory;
  if (target) bot.memory = { x: target.x, z: target.z, t: now };
  else if (bot.memory && now - bot.memory.t >= 3.0) bot.memory = null;

  const role = m.roleOf(me.team);
  const spike = m.spike;
  let moveTo = null;
  let wantInteract = null;
  let hold = false;

  if (role === "attack") {
    const site = map.sites[bot.site];
    const wp = map.waypoints[bot.site];

    /* 드랍 스파이크가 있으면 먼저 픽업 */
    if (!me.hasSpike && spike.dropped) {
      if (Math.hypot(spike.dropX - me.x, spike.dropZ - me.z) > 2.5) {
        moveTo = { x: spike.dropX, z: spike.dropZ };
      }
    } else {
      const atSite = Math.hypot(site.cx - me.x, site.cz - me.z) < 22;
      if (!atSite) {
        const w = wp[Math.min(bot.wpIdx, wp.length - 1)];
        if (Math.hypot(w.x - me.x, w.z - me.z) < 3 && bot.wpIdx < wp.length - 1) bot.wpIdx++;
        moveTo = wp[Math.min(bot.wpIdx, wp.length - 1)];
      } else {
        moveTo = { x: site.cx, z: site.cz };
        if (me.hasSpike && !spike.planted && inSiteZone(me, map)) {
          moveTo = null;
          hold = false;
          wantInteract = { type: "plant", action: "start" };
          bot.wpIdx = wp.length - 1;
        }
      }
    }
  } else {
    if (spike.planted) {
      /* 설치된 스파이크를 향해 해체 */
      if (Math.hypot(spike.plantX - me.x, spike.plantZ - me.z) <= 3.4) {
        moveTo = null;
        wantInteract = { type: "defuse", action: "start" };
      } else {
        moveTo = { x: spike.plantX, z: spike.plantZ };
      }
    } else {
      /* 사이트 고정 방어 (약간의 진영 변위) */
      const site = map.sites[bot.site];
      // 봇별 고유 오프셋 — 같은 위치에 뭉치지 않고 각자 자리를 지킨다
      let h = 0;
      for (const c of botId) h = (h * 31 + c.charCodeAt(0)) | 0;
      const offAng = ((h % 360) * Math.PI) / 180;
      const offR = 4 + Math.abs(h % 7); // 4~10 단위 거리
      const anchor = {
        x: site.cx + Math.sin(offAng) * offR + (me.x < 0 ? -5 : 5),
        z: site.cz - 8 + Math.cos(offAng) * offR,
      };
      if (Math.hypot(anchor.x - me.x, anchor.z - me.z) < 3) {
        // 도착: 잠시 숨 고르기 후, 다음 무작위 지점으로 계속 순찰 (제자리 고정 방지)
        if (!bot.patrolAt) bot.patrolAt = now;
        if (now - bot.patrolAt < 0.9) {
          moveTo = null; hold = true;
        } else {
          bot.patrolAt = now;
          if (wp.length > 1) bot.wpIdx = Math.floor(Math.random() * wp.length);
        }
      } else {
        moveTo = anchor;
      }
    }
  }

  const keys = { w: false, a: false, s: false, d: false, shift: false, space: false };
  let yaw = me.yaw;
  let pitch = me.pitch;
  let firing = false;

  const reactDelay = 0.35 + (1 - bot.skill) * 0.45; // 숙련도 낮을수록 늦은 반응

  if (target && los) {
    // 반응 시간 경과 전에는 조준도 못함 (처음 보자마자 즉시 조준 불가)
    if (now >= bot.reactUntil) {
      const aimErr = Math.min(0.22, 0.02 + bestD * 0.0022 + (1 - bot.skill) * 0.03);
      const jitter = () => (Math.random() - 0.5) * 2 * aimErr;
      yaw = Math.atan2(target.x - me.x, target.z - me.z) + jitter() * 0.8;
      pitch = Math.atan2((target.y + 1.0) - 1.6, bestD) + jitter() * 0.7;
      // 사격: 연사 시 정확도 급감 + 반응 딜레이 후 점사
      const canShoot = now >= bot.nextShotT && bestD < 42 && Math.random() < 0.45 * bot.skill;
      if (canShoot) {
        firing = true;
        bot.burstLeft = 2 + Math.floor(Math.random() * 2);
        bot.nextShotT = now + (0.9 + Math.random() * 0.6);
      } else if (bot.burstLeft > 0) {
        firing = true;
        bot.burstLeft--;
      }
      bot.holdAim = { yaw, pitch };
    }
    // 사격 중에도 좌우 스트레이프 — 멈춰서 쏘지 않고 흔들며 교전 (더 활발)
    if (firing) {
      if (Math.random() < 0.72) { if (Math.random() < 0.5) keys.a = true; else keys.d = true; }
      if (Math.random() < 0.15) keys.shift = true;
    } else if (bestD < 18) {
      if (Math.random() < 0.5) keys.a = true; else keys.d = true;
    }
  } else if (ghost && now >= bot.reactUntil) {
    // 기억 속 적 방향으로 천천히 조준 (정확도 낮음 — 메모리라서)
    yaw = Math.atan2(ghost.x - me.x, ghost.z - me.z);
    pitch = 0;
  } else if (moveTo) {
    yaw = Math.atan2(moveTo.x - me.x, moveTo.z - me.z);
    pitch = 0;
    keys.w = true;
    if (Math.random() < 0.1) keys.shift = true;
  } else if (hold) {
    /* 시야 360도 순찰 — 반응 준비 */
    if (now < bot.reactUntil) bot.reactUntil = now;
    bot.nudgeT = (bot.nudgeT || 0) + 1;
    if (bot.nudgeT > 90) { yaw = me.yaw + 2.4; bot.nudgeT = 0; }
  }

  // 적을 처음 마주친 순간 반응 딜레이 시작
  if (target && los && now >= bot.reactUntil) bot.reactUntil = now + reactDelay + Math.random() * 0.3;

  /* 전투 중에는 설치/해체를 일시 중단 */
  if (wantInteract && target && los && bestD < 14) wantInteract = null;

  /* 상호작용 (설치/해체 시작/중지) */
  if (wantInteract) {
    if (!bot.interacting || bot.interactType !== wantInteract.type) {
      m.interact(botId, { type: wantInteract.type, action: "start" });
      bot.interacting = true;
      bot.interactType = wantInteract.type;
    }
  } else if (bot.interacting) {
    m.interact(botId, { action: "stop" });
    bot.interacting = false;
    bot.interactType = null;
  }

  m.input(botId, { keys, yaw, pitch, firing });
}

function runBots(room) {
  for (const bp of room.players) {
    if (bp.isBot) stepBot(room, bp.socketId);
  }
}

function leaveRoom(socket, room) {
  if (!room) return;
  const idx = room.players.findIndex(p => p.socketId === socket.id);
  if (idx !== -1) room.players.splice(idx, 1);

  if (room.match) room.match.removePlayer(socket.id);

  if (room.host === socket.id) {
    const next = room.players.find(p => p.connected && !p.isBot);
    room.host = next ? next.socketId : null;
  }

  socket.leave(room.id);
  socket.data.roomId = null;
  socket.data.role = null;

  if (humanCount(room) < 1) {
    ROOMS.delete(room.id);
  } else {
    broadcastLobby(room);
    // 혼자 남으면 봇 재보충 (대기 상태에서만 — 진행 중 경기는 그대로 두어 팀 성립 유지)
    if (room.status === "lobby" && humanCount(room) < 2) fillBots(room);
  }
}

/* =========================================================
   게임 루프 — 전역 한 개의 루프가 모든 방을 처리
========================================================= */

const TICK_MS = 1000 / TICK_RATE;
const STATE_EVERY = Math.round(TICK_RATE / STATE_RATE);

setInterval(() => {
  const dt = TICK_MS / 1000;
  for (const room of ROOMS.values()) {
    if (room.status !== "playing" || !room.match || room.match.finished) continue;

    runBots(room);

    const events = room.match.tick(dt);
    for (const ev of events) {
      switch (ev.type) {
        case "shot":
          io.to(room.id).emit("game:fx", {
            ox: ev.ox, oy: ev.oy, oz: ev.oz,
            dx: ev.dx, dy: ev.dy, dz: ev.dz,
            hitX: ev.hitX, hitY: ev.hitY, hitZ: ev.hitZ,
            hit: ev.hit, weapon: ev.weapon, shooter: ev.pid,
            snd: ev.snd !== false,
          });
          break;
        case "hurt":
          io.to(room.id).emit("game:hurt", {
            pid: ev.pid, byId: ev.byId, dmg: ev.dmg,
            headshot: ev.headshot, hp: ev.hp, hpMax: ev.hpMax,
          });
          break;
        case "kill": {
          io.to(room.id).emit("game:kill", {
            killerId: ev.killerId, killerName: ev.killerName, killerTeam: ev.killerTeam,
            victimId: ev.victimId, victimName: ev.victimName, victimTeam: ev.victimTeam,
            headshot: ev.headshot,
          });
          break;
        }
        case "roundstart": {
          io.to(room.id).emit("round:start", {
            round: ev.round, phase: ev.phase, buyTime: ev.buyTime,
            attackTeam: ev.attackTeam, defendTeam: ev.defendTeam,
            scores: ev.scores,
          });
          break;
        }
        case "roundend": {
          io.to(room.id).emit("round:end", {
            round: ev.round,
            winner: ev.winner, reason: ev.reason,
            scores: ev.scores,
          });
          break;
        }
        case "phase":
          io.to(room.id).emit("game:phase", { phase: ev.phase, timeLeft: ev.timeLeft });
          break;
        case "spikecarrier":
          io.to(room.id).emit("bomb:carrier", { carrierId: ev.carrierId });
          break;
        case "spikeplant":
          io.to(room.id).emit("bomb:planted", { pid: ev.pid, x: ev.x, z: ev.z, timeLeft: ev.timeLeft });
          break;
        case "spikedrop":
          io.to(room.id).emit("bomb:drop", { x: ev.x, z: ev.z });
          break;
        case "spikepickup":
          io.to(room.id).emit("bomb:pickup", { pid: ev.pid });
          break;
        case "spikedefuse":
          io.to(room.id).emit("bomb:defuse", { byId: ev.byId });
          break;
        case "spikedetonate":
          io.to(room.id).emit("bomb:detonate", { x: ev.x, z: ev.z });
          break;
        case "skill:smoke":
          io.to(room.id).emit("skill:smoke", ev);
          break;
        case "skill:ult":
          io.to(room.id).emit("skill:ult", ev);
          break;
        case "skill:ultboom":
          io.to(room.id).emit("skill:ultboom", ev);
          break;
        case "end": {
          room.match.finished = true;
          room.status = "lobby";
          io.to(room.id).emit("game:ended", { winner: ev.winner, scores: ev.scores });
          clearBots(room);
          if (room.players.length === 0) {
            ROOMS.delete(room.id);
          } else {
            broadcastLobby(room);
          }
          break;
        }
      }
    }

    room.tickCount = (room.tickCount || 0) + 1;
    if (room.tickCount % STATE_EVERY === 0) {
      io.to(room.id).emit("game:state", room.match.snapshot());
    }
  }
}, TICK_MS);

/* =========================================================
   Socket.IO
========================================================= */

io.on("connection", (socket) => {
  console.log(`[CONNECT] ${socket.id}`);
  socket.data.roomId = null;
  socket.data.role = null;

  socket.emit("server:ready", {
    ok: true, tickRate: TICK_RATE, stateRate: STATE_RATE,
    characters: CHARACTERS,
    weapons: WEAPONS,
    maps: Object.fromEntries(Object.entries(MAPS).map(([id, m]) => [id, { id: m.id, name: m.name, desc: m.desc }])),
  });

  /* ---------- 로비 ---------- */

  socket.on("lobby:create", (data) => {
    const nickname = String(data?.nickname || "플레이어").trim().slice(0, 16) || "플레이어";
    const charId = ["vanguard", "rush", "guard", "venom"].includes(data?.charId) ? data.charId : "vanguard";
    const mapId = MAPS[data?.mapId] ? data.mapId : "center";
    if (socket.data.roomId) {
      const old = ROOMS.get(socket.data.roomId);
      leaveRoom(socket, old);
    }

    const roomId = createRoomId();
    const room = {
      id: roomId,
      host: socket.id,
      status: "lobby",
      players: [],
      mapId,
      match: createMatch(roomId, { mapId }),
      tickCount: 0,
    };
    ROOMS.set(roomId, room);

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = "host";
    room.players.push({ socketId: socket.id, nickname, team: "red", connected: true, charId });
    room.match.addPlayer({ id: socket.id, nickname, team: "red", charId });

    socket.emit("lobby:created", { ok: true, roomId, room: roomState(room) });
    console.log(`[ROOM CREATE] ${roomId} host=${nickname} map=${mapId} char=${charId}`);
  });

  socket.on("lobby:join", (data) => {
    const roomId = String(data?.roomId || "").trim().toUpperCase();
    const nickname = String(data?.nickname || "플레이어").trim().slice(0, 16) || "플레이어";
    const charId = ["vanguard", "rush", "guard", "venom"].includes(data?.charId) ? data.charId : "vanguard";
    const room = ROOMS.get(roomId);
    if (!room) {
      socket.emit("lobby:join", { ok: false, reason: "방을 찾을 수 없습니다." });
      return;
    }

    if (socket.data.roomId) leaveRoom(socket, ROOMS.get(socket.data.roomId));

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = "member";
    room.players.push({ socketId: socket.id, nickname, team: teamFor(room), connected: true, charId });
    room.match.addPlayer({ id: socket.id, nickname, team: room.players[room.players.length - 1].team, charId });

    socket.emit("lobby:join", { ok: true, roomId, room: roomState(room) });
    broadcastLobby(room);

    /* 게임이 진행 중이면 바로 참전 — 맵/무기 설정 동기화 */
    if (room.status === "playing") {
      if (humanCount(room) >= 2) clearBots(room);
      socket.emit("game:sync", { mapId: room.mapId, map: room.match.map, weapons: WEAPONS, characters: CHARACTERS });
    }
    console.log(`[ROOM JOIN] ${roomId} <- ${nickname} char=${charId}`);
  });

  socket.on("lobby:leave", () => {
    if (socket.data.roomId) leaveRoom(socket, ROOMS.get(socket.data.roomId));
  });

  socket.on("lobby:start", () => {
    const room = ROOMS.get(socket.data.roomId);
    if (!room) return;
    if (room.host !== socket.id) {
      socket.emit("lobby:start", { ok: false, reason: "방장만 시작할 수 있습니다." });
      return;
    }
    const humans = room.players.filter(p => p.connected && !p.isBot);
    if (humans.length < 1) {
      socket.emit("lobby:start", { ok: false, reason: "방에 플레이어가 없습니다." });
      return;
    }

    room.status = "playing";
    room.tickCount = 0;
    room.match.start();
    fillBots(room);

    io.to(room.id).emit("game:started", {
      ok: true,
      mapId: room.mapId,
      map: room.match.map,
      weapons: WEAPONS,
      characters: CHARACTERS,
      me: {
        socketId: socket.id,
        team: room.players.find(p => p.socketId === socket.id)?.team,
        charId: room.players.find(p => p.socketId === socket.id)?.charId || "vanguard",
      },
      state: room.match.snapshot(),
    });
    console.log(`[MATCH START] ${room.id} players=${room.players.length}`);
  });

  /* ---------- 게임 중 ---------- */

  socket.on("game:input", (data) => {
    const room = ROOMS.get(socket.data.roomId);
    if (!room || room.status !== "playing" || !room.match) return;
    room.match.input(socket.id, data || {});
  });

  socket.on("game:buy", (data) => {
    const room = ROOMS.get(socket.data.roomId);
    if (!room || room.status !== "playing" || !room.match) return;
    const ok = room.match.buy(socket.id, String(data?.weapon || ""));
    const me = room.match.getPlayer(socket.id);
    socket.emit("game:buy", { ok: !!ok, weapon: me ? me.weapon : "", money: me ? me.money : 0 });
  });

  socket.on("game:interact", (data) => {
    const room = ROOMS.get(socket.data.roomId);
    if (!room || room.status !== "playing" || !room.match) return;
    room.match.interact(socket.id, data || {});
  });

  socket.on("game:skill", (data) => {
    const room = ROOMS.get(socket.data.roomId);
    if (!room || room.status !== "playing" || !room.match) return;
    const evts = room.match.skill(socket.id, data || {});
    for (const ev of (evts || [])) {
      io.to(room.id).emit(ev.type, ev);
    }
  });

  socket.on("game:reload", () => {
    const room = ROOMS.get(socket.data.roomId);
    if (!room || !room.match) return;
    room.match.reload(socket.id);
  });

  socket.on("disconnect", () => {
    console.log(`[DISCONNECT] ${socket.id}`);
    if (socket.data.roomId) leaveRoom(socket, ROOMS.get(socket.data.roomId));
  });
});

server.listen(PORT, () => {
  console.log(`[SERVER] http://localhost:${PORT}`);
  console.log(`[SERVER] tick=${TICK_RATE}Hz state=${STATE_RATE}Hz`);
});