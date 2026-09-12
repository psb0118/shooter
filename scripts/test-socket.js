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
    assert(gs.map && gs.weapons && gs.state.players.length === 4, "맵/무기/스냅샷 전달 (인간 2 + 봇 2)");
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

    /* -------- 솔로 시작 + 봇 -------- */
    const c = await connect("C");
    c.emit("lobby:create", { nickname: "솔로" });
    await once(c, "lobby:created");
    const cStart = once(c, "game:started");
    c.emit("lobby:start");
    const gcs = await cStart;
    assert(gcs.ok, "솔로 시작 ok");
    assert.equal(gcs.state.players.length, 4, `봇 포함 4명 (${gcs.state.players.length}명)`);
    const bots = gcs.state.players.filter(p => p.id.startsWith("bot-"));
    assert.equal(bots.length, 3, "봇 3명");
    assert.equal(gcs.state.players.filter(p => p.team === "red").length, 2, "레드 2명");
    assert.equal(gcs.state.players.filter(p => p.team === "blue").length, 2, "블루 2명");
    ok("혼자 시작 가능 → 봇으로 2:2 구성");

    const bx0 = bots[0].x, bz0 = bots[0].z;
    let botMoved = false;
    for (let i = 0; i < 25; i++) {
      const snap = await once(c, "game:state");
      const bp = snap.players.find(p => p.id === bots[0].id);
      if (bp && Math.hypot(bp.x - bx0, bp.z - bz0) > 1) { botMoved = true; break; }
    }
    assert(botMoved, "봇 AI 이동 안 함");
    ok("봇 AI 이동");

    c.emit("lobby:leave");
    c.close();
    await new Promise((r) => setTimeout(r, 200));

    console.log(`\n[socket] ${passed}개 테스트 통과`);
  } catch (err) {
    console.error("\n[socket] 테스트 실패:", err.message);
    process.exitCode = 1;
  } finally {
    server.kill();
  }
})();