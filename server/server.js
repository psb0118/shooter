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
    })),
  };
}

function broadcastLobby(room) {
  if (!room) return;
  io.to(room.id).emit("lobby:state", roomState(room));
}

function leaveRoom(socket, room) {
  if (!room) return;
  const idx = room.players.findIndex(p => p.socketId === socket.id);
  if (idx !== -1) room.players.splice(idx, 1);

  if (room.match) room.match.removePlayer(socket.id);

  if (room.host === socket.id) {
    const next = room.players.find(p => p.connected);
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

    const events = room.match.tick(dt);
    for (const ev of events) {
      switch (ev.type) {
        case "shot":
          io.to(room.id).emit("game:fx", {
            ox: ev.ox, oy: ev.oy, oz: ev.oz,
            dx: ev.dx, dy: ev.dy, dz: ev.dz,
            hitX: ev.hitX, hitY: ev.hitY, hitZ: ev.hitZ,
            hit: ev.hit, weapon: ev.weapon, shooter: ev.pid,
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
          broadcastLobby(room);
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
    if (humans.length < 2) {
      socket.emit("lobby:start", { ok: false, reason: "최소 2명이 필요합니다." });
      return;
    }

    room.status = "playing";
    room.tickCount = 0;
    room.match.start();

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