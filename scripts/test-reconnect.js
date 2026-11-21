"use strict";

/* =========================================================
   scripts/test-reconnect.js — 재접속/경기 복구 통합 테스트
   실행: node scripts/test-reconnect.js
   - 경기 중 소켓 연결을 끊고 같은 세션 토큰으로 새 소켓을 연결한다.
   - 서버가 경기 상태를 유지한 채 플레이어 ID만 새 소켓으로 옮기는지 검증한다.
========================================================= */

const { spawn } = require("child_process");
const { io } = require("socket.io-client");
const assert = require("assert");

const PORT = 3444;
const URL = `http://localhost:${PORT}`;
const TOKEN = "test-session-reconnect-001";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(name) {
  return new Promise((resolve, reject) => {
    const s = io(URL, { transports: ["websocket"], reconnection: false, timeout: 3000 });
    s.on("connect", () => resolve(s));
    s.on("connect_error", reject);
    s.name = name;
  });
}

function once(sock, event, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`[${sock.name}] ${event} 타임아웃`)), timeout);
    sock.once(event, (data) => { clearTimeout(timer); resolve(data); });
  });
}

(async () => {
  const server = spawn(process.execPath, ["server/server.js"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });
  let a;
  let b;
  let passed = 0;
  const ok = (name) => { passed++; console.log(`  ✓ ${name}`); };

  try {
    await sleep(2500);

    a = await connect("A");
    const createdP = once(a, "lobby:created");
    a.emit("lobby:create", { nickname: "복구테스터", sessionToken: TOKEN, difficulty: "normal" });
    const created = await createdP;
    assert(created.ok, "방 생성");
    const roomId = created.roomId;
    const oldId = a.id;

    const startedP = once(a, "game:started");
    a.emit("lobby:start");
    const started = await startedP;
    assert.equal(started.state.players.length, 10, "봇 포함 10명");
    const myStart = started.state.players.find(p => p.id === oldId);
    assert(myStart, "시작 스냅샷에 내 플레이어");

    a.close();
    a = null;
    await sleep(500);

    b = await connect("B");
    const resumedP = once(b, "session:resumed");
    const syncP = once(b, "game:sync");
    const stateP = once(b, "game:state");
    b.emit("session:resume", { sessionToken: TOKEN });

    const resumed = await resumedP;
    assert(resumed.ok, `재접속 승인 (${resumed.reason || "ok"})`);
    assert.equal(resumed.roomId, roomId, "같은 방 복귀");
    assert.equal(resumed.status, "playing", "경기 중 상태 유지");
    assert(resumed.room.players.some(p => p.socketId === b.id && p.connected), "새 소켓이 방 멤버");

    const sync = await syncP;
    assert(sync.map, "재접속 맵 동기화");
    assert(sync.roomId === roomId, "재접속 방 ID");
    ok("끊김 후 같은 세션으로 경기 복귀");

    const snap = await stateP;
    assert.equal(snap.players.length, 10, "재접속 후 10명 유지");
    assert(snap.players.some(p => p.id === b.id), "새 ID로 플레이어 이전");
    assert(!snap.players.some(p => p.id === oldId && oldId !== b.id), "이전 ID 제거");
    const mine = snap.players.find(p => p.id === b.id);
    assert(mine && mine.team === myStart.team, "팀/경기 상태 유지");
    ok("플레이어 ID 이전/스냅샷 유지");

    b.emit("game:input", { seq: 12, keys: { w: true }, yaw: 0, pitch: 0, firing: false });
    let ack = null;
    for (let i = 0; i < 6; i++) {
      const s = await once(b, "game:state");
      ack = s.players.find(p => p.id === b.id);
      if (ack && ack.inputSeq >= 12) break;
    }
    assert(ack && ack.inputSeq >= 12, "재접속 후 입력 ack");
    ok("재접속 후 입력 seq ack");

    b.emit("lobby:leave");
    await sleep(150);
    console.log(`\n[reconnect] ${passed}개 테스트 통과`);
  } catch (err) {
    console.error("\n[reconnect] 테스트 실패:", err.message);
    process.exitCode = 1;
  } finally {
    if (b) b.close();
    if (a) a.close();
    server.kill();
  }
})();
