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
const TARGET_PER_TEAM = 5; // 봇으로 팀별 5vs5 보충
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

function inSiteZone(p) {
  for (const key of ["A", "B"]) {
    const s = MAP.sites[key];
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

  /* 구매 단계: 자동 구매 후 대기 */
  if (m.phase === "buy") {
    m.input(botId, { keys: { w: false, a: false, s: false, d: false, shift: false }, firing: false, ads: false });
    if (!bot.bought) {
      bot.bought = true;
      // AI 경제 보정: 최소한 SMG 살 돈은 있게 (발로란트 감성 유지 + 난이도)
      if (me.money < 1600) me.money = 1600;
      if (!m.buy(botId, "ar")) m.buy(botId, "smg");
    }
    if (bot.interacting) { m.interact(botId, { action: "stop" }); bot.interacting = false; }
    return;
  }

  if (!me.alive || m.phase !== "combat") {
    m.input(botId, { keys: { w: false, a: false, s: false, d: false, shift: false }, firing: false, ads: false });
    if (bot.interacting) { m.interact(botId, { action: "stop" }); bot.interacting = false; }
    return;
  }

  /* 목표 선택 — 가장 가까운 살아있는 적 */
  const enemies = m.getPlayers().filter(t => t.id !== botId && t.alive && t.team !== me.team);
  let target = null, bestD = Infinity;
  for (const t of enemies) {
    const d = Math.hypot(t.x - me.x, t.z - me.z);
    if (d < bestD) { bestD = d; target = t; }
  }
  const los = target ? m.hasLos(botId, target.id) : false;

  const role = m.roleOf(me.team);
  const spike = m.spike;
  let moveTo = null;
  let wantInteract = null;
  let hold = false;

  if (role === "attack") {
    const site = MAP.sites[bot.site];
    const wp = MAP.waypoints[bot.site];

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
        if (me.hasSpike && !spike.planted && inSiteZone(me)) {
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
      const site = MAP.sites[bot.site];
      const anchor = { x: site.cx + (me.x < 0 ? -5 : 5), z: site.cz - 8 };
      if (Math.hypot(anchor.x - me.x, anchor.z - me.z) < 3) {
        moveTo = null; hold = true;
      } else {
        moveTo = anchor;
      }
    }
  }

  const keys = { w: false, a: false, s: false, d: false, shift: false };
  let yaw = me.yaw;
  let pitch = me.pitch;
  let firing = false;

  if (target && los) {
    /* 조준 (거리 기반 확산) */
    const aimErr = Math.min(0.10, 0.006 + bestD * 0.0012);
    const jitter = () => (Math.random() - 0.5) * 2 * aimErr;
    yaw = Math.atan2(target.x - me.x, target.z - me.z) + jitter() * 0.7;
    pitch = Math.atan2((target.y + 1.0) - 1.6, bestD) + jitter() * 0.6;
    firing = bestD < 85 && Math.random() < 0.9;

    if (bestD < 22) {
      if (Math.random() < 0.55) keys.a = true; else keys.d = true;
    } else if (moveTo && bestD > 30) {
      const navYaw = Math.atan2(moveTo.x - me.x, moveTo.z - me.z);
      yaw = navYaw;
      keys.w = true;
    }
  } else if (moveTo) {
    yaw = Math.atan2(moveTo.x - me.x, moveTo.z - me.z);
    pitch = 0;
    keys.w = true;
    if (Math.random() < 0.12) keys.shift = true;
  } else if (hold) {
    /* 시야 360도 순찰 */
    bot.nudgeT = (bot.nudgeT || 0) + 1;
    if (bot.nudgeT > 90) { yaw = me.yaw + 2.4; bot.nudgeT = 0; }
  }

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