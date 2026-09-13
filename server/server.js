"use strict";

/* =========================================================
   server/server.js — express + socket.io 서버
   방 관리 / 팀 자동 배정 / 게임 루프 / 이벤트 중계
========================================================= */

const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const { WEAPONS, MAP, TICK_RATE, STATE_RATE, createMatch } = require("./game.js");

const ROOT_DIR = path.join(__dirname, "..");
const CLIENT_DIR = path.join(ROOT_DIR, "client");
const PORT = process.env.PORT || 3000;
const TARGET_PER_TEAM = 2; // 봇으로 팀별 최소 인원 보충
const BOT_NAMES = ["로봇", "알레망", "레이", "닉스", "토르", "바이퍼", "스카", "버트"];
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
    players: room.players.map(p => ({
      socketId: p.socketId,
      nickname: p.nickname,
      team: p.team,
      connected: p.connected,
      isBot: !!p.isBot,
    })),
  };
}

function broadcastLobby(room) {
  if (!room) return;
  io.to(room.id).emit("lobby:state", roomState(room));
}

/* =========================================================
   봇 — 팀별 부족 인원을 채워서 혼자서도 바로 플레이 가능
========================================================= */

function fillBots(room) {
  for (const team of ["red", "blue"]) {
    let count = room.players.filter(p => p.team === team && p.connected).length;
    while (count < TARGET_PER_TEAM) {
      const id = "bot-" + (++botSeq);
      const nick = BOT_NAMES[(botSeq - 1) % BOT_NAMES.length] + botSeq;
      room.players.push({ socketId: id, nickname: nick, team, connected: true, isBot: true });
      room.match.addPlayer({ id, nickname: nick, team });
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

function stepBot(room, botId) {
  const m = room.match;
  const me = m.getPlayer(botId);
  if (!me) return;

  if (!me.alive) {
    m.input(botId, { keys: { w: false, a: false, s: false, d: false, shift: false }, firing: false });
    return;
  }

  // 가장 가까운 살아있는 적
  const enemies = m.getPlayers().filter(t => t.id !== botId && t.alive && t.team !== me.team);
  let target = null, bestD = Infinity;
  for (const t of enemies) {
    const d = Math.hypot(t.x - me.x, t.z - me.z);
    if (d < bestD) { bestD = d; target = t; }
  }

  if (!target) {
    // 배회
    me._wander = (me._wander || 0) + (Math.random() - 0.5) * 0.25;
    m.input(botId, { keys: { w: true, a: false, s: false, d: false, shift: false }, yaw: me.yaw + me._wander * 0.02, pitch: 0, firing: false });
    return;
  }

  // 조준 (거리 기반 확산), 직선 시야 확인
  const aimErr = Math.min(0.10, 0.006 + bestD * 0.001);
  const jitter = () => (Math.random() - 0.5) * 2 * aimErr;
  const yaw = Math.atan2(target.x - me.x, target.z - me.z) + jitter() * 0.7;
  const pitch = Math.atan2((target.y + 1.4) - 1.6, bestD) + jitter() * 0.5;
  const los = m.hasLos(botId, target.id);

  // 이동: 시야가 없거나 멀면 전진, 가까우면 스트레이프
  const keys = { w: false, a: false, s: false, d: false, shift: false };
  if (!los || bestD > 16) {
    keys.w = true;
    if (los && Math.random() < 0.2) keys.shift = true;
  } else {
    if (Math.random() < 0.55) keys.a = true; else keys.d = true;
    if (Math.random() < 0.15) keys.s = true;
  }

  const firing = los && bestD < 90 && Math.random() < 0.9;
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

  if (room.players.length === 0) {
    ROOMS.delete(room.id);
  } else {
    broadcastLobby(room);
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
        case "spawn":
          io.to(room.id).emit("game:spawn", { pid: ev.pid, x: ev.x, y: ev.y, z: ev.z });
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

  socket.emit("server:ready", { ok: true, tickRate: TICK_RATE, stateRate: STATE_RATE });

  /* ---------- 로비 ---------- */

  socket.on("lobby:create", (data) => {
    const nickname = String(data?.nickname || "플레이어").trim().slice(0, 16) || "플레이어";
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
      match: createMatch(roomId),
      tickCount: 0,
    };
    ROOMS.set(roomId, room);

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = "host";
    room.players.push({ socketId: socket.id, nickname, team: "red", connected: true });
    room.match.addPlayer({ id: socket.id, nickname, team: "red" });

    socket.emit("lobby:created", { ok: true, roomId, room: roomState(room) });
    console.log(`[ROOM CREATE] ${roomId} host=${nickname}`);
  });

  socket.on("lobby:join", (data) => {
    const roomId = String(data?.roomId || "").trim().toUpperCase();
    const nickname = String(data?.nickname || "플레이어").trim().slice(0, 16) || "플레이어";
    const room = ROOMS.get(roomId);
    if (!room) {
      socket.emit("lobby:join", { ok: false, reason: "방을 찾을 수 없습니다." });
      return;
    }

    if (socket.data.roomId) leaveRoom(socket, ROOMS.get(socket.data.roomId));

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = "member";
    room.players.push({ socketId: socket.id, nickname, team: teamFor(room), connected: true });
    room.match.addPlayer({ id: socket.id, nickname, team: room.players[room.players.length - 1].team });

    socket.emit("lobby:join", { ok: true, roomId, room: roomState(room) });
    broadcastLobby(room);

    /* 게임이 진행 중이면 바로 참전 — 맵/무기 설정 동기화 */
    if (room.status === "playing") {
      socket.emit("game:sync", { map: MAP, weapons: WEAPONS });
    }
    console.log(`[ROOM JOIN] ${roomId} <- ${nickname}`);
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
      map: MAP,
      weapons: WEAPONS,
      me: {
        socketId: socket.id,
        team: room.players.find(p => p.socketId === socket.id)?.team,
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

  socket.on("game:weapon", (data) => {
    const room = ROOMS.get(socket.data.roomId);
    if (!room || !room.match) return;
    room.match.setWeapon(socket.id, String(data?.weapon || ""));
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