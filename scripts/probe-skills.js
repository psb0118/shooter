"use strict";

/* =========================================================
   scripts/probe-skills.js — 점프 / 연막 / 궁극기 / 스폰 방향 / 스냅샷 필드 검증
========================================================= */

const path = require("path");
const { createMatch, SMOKE_RADIUS } = require(path.join(__dirname, "..", "server", "game.js"));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra || ""}`); }
}

let fakeNow = 1000; // 벽시계 대신 결정적 시계 (퍼포먼스 기반 _now는 실시간이라 틱루프와 안 맞음)

function setup(aq, bq) {
  const m = createMatch("PK");
  m._now = () => fakeNow;
  const a = m.addPlayer({ id: "A", nickname: "공격", team: "red" });
  const b = m.addPlayer({ id: "B", nickname: "수비", team: "blue" });
  m.start();
  m.phase = "combat";
  m.phaseEndAt = 0;
  m.timeLeft = 90;
  m.input("A", { keys: { w: false, a: false, s: false, d: false, shift: false, space: false }, yaw: 0, pitch: 0 });
  m.input("B", { keys: { w: false, a: false, s: false, d: false, shift: false, space: false }, yaw: 0, pitch: 0 });
  if (aq) { a.x = aq.x; a.z = aq.z; }
  if (bq) { b.x = bq.x; b.z = bq.z; b.yaw = Math.PI; }
  a.cx = a.x; a.cz = a.z; b.cx = b.x; b.cz = b.z;
  return { m, a, b };
}
function tickN(m, n, dt) {
  let out = [];
  for (let i = 0; i < n; i++) { fakeNow += dt; out.push(...m.tick(dt)); }
  return out;
}

console.log("[1] 스폰 방향 (공격 +Z=yaw0, 수비 -Z=yawπ)");
{
  const { m } = setup();
  const red = m.getPlayer("A");
  const blue = m.getPlayer("B");
  ok("공격(red) yaw=0 → 적(+Z)을 바라봄", Math.abs(red.yaw % (2 * Math.PI)) < 0.01, `yaw=${red.yaw}`);
  ok("수비(blue) yaw=π → 적(-Z)을 바라봄", Math.abs(((blue.yaw + Math.PI) % (2 * Math.PI)) - Math.PI) < 0.01, `yaw=${blue.yaw}`);
  ok("스냅샷 playerColor 포함", typeof m.snapshot().players[0].playerColor === "number");
}

console.log("[2] 점프 물리");
{
  const { m } = setup();
  m.input("A", { keys: { w: false, a: false, s: false, d: false, shift: false, space: true } });
  const dt = 1 / 30;
  let maxY = 0, airborne = false;
  for (let i = 0; i < 200; i++) {
    fakeNow += dt;
    m.tick(dt);
    const p = m.getPlayer("A");
    if (!airborne && p.y > 0.01) airborne = true;
    maxY = Math.max(maxY, p.y);
  }
  const finalY = m.getPlayer("A").y;
  ok("점프 입력 → 공중(vy>0, y>0)", airborne);
  ok("점프 높이 ~1.2m (0.8~1.5)", maxY > 0.8 && maxY < 1.5, `maxY=${maxY.toFixed(2)}`);
  ok("착지 후 y=0", finalY === 0, `finalY=${finalY}`);
}

console.log("[3] 연막 스킬 — 시야/사격 차단");
{
  // A 남쪽 z=8, B 북쪽 z=32 — 같은 컬럼 x=-27 (열린 경로), 거리 24m
  const { m, a, b } = setup({ x: -27, z: 8 }, { x: -27, z: 32 });
  a.yaw = 0; a.pitch = 0;
  m.input("A", { yaw: 0, pitch: 0, keys: { w: false, a: false, s: false, d: false, shift: false, space: false } });
  a.cx = a.x; a.cz = a.z;

  ok("초기: LOS 성립 (연막 없음)", m.hasLos("A", "B"));
  const evts = m.skill("A", { type: "smoke" });
  ok("연막 스킬 -> skill:smoke 이벤트", Array.isArray(evts) && evts[0] && evts[0].type === "skill:smoke", JSON.stringify(evts));

  const sm = m.smokes[0];
  ok("연막 설치됨", !!sm);
  const midX = (a.x + b.x) / 2, midZ = (a.z + b.z) / 2;
  ok("연막이 길목 중앙 근처", Math.hypot(sm.x - midX, sm.z - midZ) < SMOKE_RADIUS + 2, `smoke(${sm.x},${sm.z}) mid(${midX},${midZ})`);

  ok("연막 -> LOS 차단", !m.hasLos("A", "B"));

  // 쿨다운 중 재사용 차단
  const evt2 = m.skill("A", { type: "smoke" });
  ok("쿨다운 중 재사용 차단", (!evt2 || evt2.length === 0), JSON.stringify(evt2));
}

console.log("[4] 궁극기 — 킬 충전 + 광역 피해");
{
  // A 남쪽 z=38, B 북쪽 z=44 (같은 컬럼 x=-24 열림). D 수비 생존 → 킬 후 라운드 미종료
  const { m, a, b } = setup({ x: -24, z: 38 }, { x: -24, z: 44 });
  const d = m.addPlayer({ id: "D", nickname: "수비3", team: "blue" });
  m.getPlayer("D").x = 40; m.getPlayer("D").z = 44;
  a.yaw = 0; a.pitch = 0;
  b.hp = 10;
  m.input("A", { firing: true, yaw: 0, pitch: 0, keys: { w: false, a: false, s: false, d: false, shift: false, space: false } });
  let killSeen = false;
  for (let i = 0; i < 30 && !killSeen; i++) {
    fakeNow += 1 / 30;
    const evts = m.tick(1 / 30);
    killSeen = evts.some(e => e.type === "kill");
  }
  ok("킬 발생", killSeen);
  ok("킬 후 ultCharge = 40", m.getPlayer("A").ultCharge === 40, `ult=${m.getPlayer("A").ultCharge}`);

  let u = m.skill("A", { type: "ult" });
  ok("충전 부족 시 궁 거부", (!u || u.length === 0));

  // 충전 100, A는 (28,0)에 배치해 동쪽으로 18m 뻗는 열린 경로
  m.getPlayer("A").x = 28; m.getPlayer("A").z = 0; m.getPlayer("A").yaw = 0; m.getPlayer("A").pitch = 0;
  m.getPlayer("A").ultCharge = 100;
  m.getPlayer("A").cx = 28; m.getPlayer("A").cz = 0;
  const c = m.addPlayer({ id: "C", nickname: "수비2", team: "blue" });
  m.getPlayer("C").x = 28; m.getPlayer("C").z = 15; m.getPlayer("C").hp = 150;
  const evts2 = m.skill("A", { type: "ult" });
  ok("궁극기 발동 -> skill:ult 이벤트", Array.isArray(evts2) && evts2[0] && evts2[0].type === "skill:ult");
  ok("pendingUlts 1건", m.pendingUlts.length === 1);

  const dt = 1 / 30;
  let boomSeen = false;
  for (let i = 0; i < 60; i++) {
    fakeNow += dt;
    const et = m.tick(dt);
    boomSeen = boomSeen || et.some(e => e.type === "skill:ultboom");
  }
  ok("낙뢰 폭발 이벤트", boomSeen);
  ok("궁 범위 적 90 데미지 (hp=60)", m.getPlayer("C").hp === 60, `hp=${m.getPlayer("C").hp}`);
  ok("사용 후 ultCharge = 0", m.getPlayer("A").ultCharge === 0, `ult=${m.getPlayer("A").ultCharge}`);
}

console.log("[5] 스냅샷 필드");
{
  const { m } = setup();
  const snap = m.snapshot();
  const p = snap.players.find(q => q.id === "A");
  ok("스냅샷 y/vy 포함", typeof p.y === "number" && typeof p.vy === "number");
  ok("스냅샷 ultCharge 포함", typeof p.ultCharge === "number");
  ok("스냅샷 smokes 배열", Array.isArray(snap.smokes));
  ok("스냅샷 pendingUlts 배열", Array.isArray(snap.pendingUlts));
}

console.log(`\n[probe-skills] ${passed} 통과 / ${failed} 실패`);
process.exit(failed ? 1 : 0);