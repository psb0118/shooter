"use strict";

/* =========================================================
   scripts/test-socket.js — 서버 + socket.io 통합 테스트 (라운드제)
   실행: node scripts/test-socket.js
   봇(5v5 보충) / 구매 / 라운드 흐름 / 봇 AI 이동 검증
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
function once(sock, ev, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`[${sock.name}] 이벤트 ${ev} 타임아웃`)), timeout);
    sock.once(ev, (d) => { clearTimeout(t); resolve(d); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const server = spawn(process.execPath, ["server/server.js"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });

  await sleep(3000);

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

    /* A 시작 (혼자) → 5v5 봇 보충 */
    const startedA = once(a, "game:started");
    a.emit("lobby:start");
    const gs = await startedA;
    assert(gs.ok, "game:started ok");
    assert(gs.map && gs.weapons && gs.state.players.length === 10, `맵/무기/스냅샷 (1인+봇9=${gs.state.players.length})`);
    assert.equal(gs.state.phase, "buy", "첫 라운드 buy");
    assert.equal(gs.state.round, 1, "라운드 1");
    const bots = gs.state.players.filter(p => p.id.startsWith("bot-"));
    assert.equal(bots.length, 9, "봇 9명");
    assert.equal(gs.state.players.filter(p => p.team === "red").length, 5, "레드 5명");
    assert.equal(gs.state.players.filter(p => p.team === "blue").length, 5, "블루 5명");
    const carrier = gs.state.players.find(p => p.hasSpike);
    assert(carrier && carrier.team === "red", "공격(레드) 캐리어 보유");
    ok("혼자 시작 → 5v5 & 캐리어 배정");

    /* 구매 단계: 자금 부족 AR 구매 거부, 권총 재구매 허용 */
    const moneyStart = (await once(a, "game:state")).players.find(p => p.id === a.id).money;
    a.emit("game:buy", { weapon: "ar" });
    const arReply = await once(a, "game:buy");
    assert(arReply.ok === false, `자금 부족 AR 거부 (money=${moneyStart})`);
    a.emit("game:buy", { weapon: "pistol" });
    const pistolReply = await once(a, "game:buy");
    assert(pistolReply.ok === true, "권총 재구매 무료 허용");
    ok(`구매 프로토콜 (money=${moneyStart}, AR 거부/권총 허용)`);

    /* 전투 전환 이벤트 대기 */
    const ph = await once(a, "game:phase", 20000);
    assert.equal(ph.phase, "combat", "전투 단계 전환");
    ok("buy → combat 전환 (game:phase)");

    /* 봇 AI: 구매로 무기 교체(권총 탈피) + 전투 후 이동 */
    let armed = 0;
    for (let i = 0; i < 3; i++) {
      const snap = await once(a, "game:state");
      armed = snap.players.filter(p => p.id.startsWith("bot-") && p.weapon !== "pistol").length;
      if (armed > 0) break;
    }
    assert(armed >= 4, `봇들이 구매 후 AR/SMG 장비 (장비=${armed})`);
    ok(`봇 구매 (전투 참전 장비 ${armed}/9)`);

    const bot = (await once(a, "game:state")).players.find(p => p.id.startsWith("bot-"));

    /* 게임 진행: 봇 이동(전투 돌격) */
    const bx = bot.x, bz = bot.z;
    let botMoved = false;
    for (let i = 0; i < 60; i++) {
      const snap = await once(a, "game:state", 15000);
      if (snap.phase === "roundover" || snap.phase === "finished") break;
      const bp = snap.players.find(p => p.id === bot.id);
      if (bp && Math.hypot(bp.x - bx, bp.z - bz) > 1.5) { botMoved = true; break; }
    }
    assert(botMoved, "봇 AI 이동");
    ok("봇 AI 전투 이동");

    /* 라운드 종료 이벤트 수신 (구매 12s + 전투 최대 100s → 최대 150초) */
    const re = await once(a, "round:end", 150000);
    assert(re.winner === "red" || re.winner === "blue", `round:end 수신 (winner=${re.winner})`);
    ok(`round:end 수신 (winner=${re.winner}, reason=${re.reason})`);

    /* 인간 2명째 조인 → 봇 제거 정책 */
    b.emit("lobby:join", { roomId, nickname: "베타" });
    const joined = await once(b, "lobby:join");
    assert(joined.ok, "lobby:join ok");
    await once(b, "lobby:state");
    let noBotSnap = null;
    for (let i = 0; i < 6; i++) {
      noBotSnap = await once(a, "game:state", 15000);
      if (noBotSnap.players.filter(p => p.id.startsWith("bot-")).length === 0) break;
      await sleep(400);
    }
    const aliveBots = noBotSnap ? noBotSnap.players.filter(p => p.id.startsWith("bot-")).length : -1;
    assert.equal(aliveBots, 0, `인간 2명째 조인 → 봇 제거 (봇=${aliveBots})`);
    assert.equal(noBotSnap.players.length, 2, `봇 제거 후 인간 2명만 (n=${noBotSnap.players.length})`);
    ok("인간 2명째 조인 → AI 제거 (2명만 남음)");

    b.emit("lobby:leave");
    a.emit("lobby:leave");
    await sleep(300);
    a.close();
    b.close();

    /* -------- 솔로 시작 + 5v5 봇 -------- */
    const c = await connect("C");
    c.emit("lobby:create", { nickname: "솔로" });
    await once(c, "lobby:created");
    const cStart = once(c, "game:started");
    c.emit("lobby:start");
    const gcs = await cStart;
    assert(gcs.ok, "솔로 시작 ok");
    assert.equal(gcs.state.players.length, 10, `봇 포함 10명 (${gcs.state.players.length}명)`);
    const bots2 = gcs.state.players.filter(p => p.id.startsWith("bot-"));
    assert.equal(bots2.length, 9, "봇 9명");
    assert.equal(gcs.state.players.filter(p => p.team === "blue").length, 5, "블루 5명(전원 봇)");
    ok("혼자 시작 → 5v5 봇 구성");

    c.emit("lobby:leave");
    c.close();
    await sleep(200);

    console.log(`\n[socket] ${passed}개 테스트 통과`);
  } catch (err) {
    console.error("\n[socket] 테스트 실패:", err.message);
    process.exitCode = 1;
  } finally {
    server.kill();
  }
})();