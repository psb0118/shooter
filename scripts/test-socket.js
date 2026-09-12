"use strict";

/* =========================================================
   scripts/test-socket.js — 서버 + socket.io 통합 테스트
   실행: node scripts/test-socket.js
========================================================= */

const { spawn } = require("child_process");
const path = require("path");
const { io } = require("socket.io-client");
const assert = require("assert");

const PORT = 3222;
const URL = `http://localhost:${PORT}`;

function connect(name) {
  return new Promise((resolve, reject) => {
    const s = io(URL, { transports: ["websocket"], reconnection: false, timeout: 3000 });
    s.on("connect", () => resolve(s));
    s.on("connect_error", (e) => reject(e));
    s.name = name;
  });
}
function once(sock, ev, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`[${sock.name}] 이벤트 ${ev} 타임아웃`)), timeout);
    sock.once(ev, (d) => { clearTimeout(t); resolve(d); });
  });
}

(async () => {
  const server = spawn(process.execPath, ["server/server.js"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });

  await new Promise((r) => setTimeout(r, 1200));

  let passed = 0;
  const ok = (n) => { passed++; console.log(`  ✓ ${n}`); };

  try {
    const a = await connect("A");
    const b = await connect("B");

    /* A 방 생성 */
    a.emit("lobby:create", { nickname: "알파" });
    const created = await once(a, "lobby:created");
    assert(created.ok, "lobby:created ok");
    const roomId = created.room.roomId;
    assert.equal(created.room.host, a.id, "A가 방장");
    ok(`방 생성 (${roomId})`);

    /* B 참여 */
    b.emit("lobby:join", { roomId, nickname: "베타" });
    const joined = await once(b, "lobby:join");
    assert(joined.ok, "lobby:join ok");
    const bState = await once(b, "lobby:state");
    assert.equal(bState.players.length, 2, "플레이어 2명");
    const teams = bState.players.map(p => p.team);
    assert.notEqual(teams[0], teams[1], "팀 나뉨");
    ok(`참여 (팀 ${teams.join(",")})`);

    /* A 시작 */
    const startedA = once(a, "game:started");
    const startedB = once(b, "game:started");
    a.emit("lobby:start");
    const gs = await startedA;
    await startedB;
    assert(gs.ok, "game:started ok");
    assert(gs.map && gs.weapons && gs.state.players.length === 2, "맵/무기/스냅샷 전달");
    ok("게임 시작 & 맵/무기 전달");

    /* 입력 → 이동 상태 반영 */
    const aState = gs.state.players.find(p => p.id === a.id);
    const sx = aState.x, sz = aState.z;
    a.emit("game:input", { keys: { w: true, a: false, s: false, d: false, shift: false }, yaw: aState.yaw, pitch: 0, firing: false });

    let moved = false;
    for (let i = 0; i < 20; i++) {
      const snap = await once(a, "game:state");
      const me = snap.players.find(p => p.id === a.id);
      if (me && Math.hypot(me.x - sx, me.z - sz) > 1) { moved = true; break; }
    }
    assert(moved, "서버에 이동 반영");
    ok("game:input → 서버 위치 갱신");

    /* 사격 → game:fx 이벤트 */
    a.emit("game:input", { keys: {}, yaw: aState.yaw, pitch: 0, firing: true });
    const fx = await once(a, "game:fx");
    assert(fx.ox !== undefined && fx.dx !== undefined, "fx 페이로드");
    a.emit("game:input", { keys: {}, yaw: aState.yaw, pitch: 0, firing: false });
    ok("사격 → game:fx 이벤트");

    /* 나가기 / 방 정리 */
    b.emit("lobby:leave");
    a.emit("lobby:leave");
    await new Promise((r) => setTimeout(r, 300));

    a.close();
    b.close();
    console.log(`\n[socket] ${passed}개 테스트 통과`);
  } catch (err) {
    console.error("\n[socket] 테스트 실패:", err.message);
    process.exitCode = 1;
  } finally {
    server.kill();
  }
})();