"use strict";

/* =========================================================
   scripts/test-game.js — game.js 코어 단위 테스트 (네트워크 없음)
   실행: node scripts/test-game.js
========================================================= */

const assert = require("assert");
const { createMatch, WEAPONS, MAP } = require("../server/game.js");

let passed = 0;
function ok(name) { passed++; console.log(`  ✓ ${name}`); }

function makeMatch() {
  const m = createMatch("TEST");
  m.addPlayer({ id: "p1", nickname: "레드", team: "red" });
  m.addPlayer({ id: "p2", nickname: "블루", team: "blue" });
  m.start();
  return m;
}

/* 가짜 시계 + N틱 시뮬레이션 헬퍼 — 타이밍 의존 로직(사격/리스폰/리로드) 검증용 */
function fakeClock(m, start) {
  let T = start || 0;
  m._now = () => T;
  m._advance = (s) => { T += s; };
  return m;
}
function run(m, seconds) {
  const evs = [];
  const n = Math.round(seconds * 30) + 1;
  for (let i = 0; i < n; i++) {
    if (m._advance) m._advance(1 / 30);
    evs.push(...m.tick(1 / 30));
  }
  return evs;
}

/* --- 1. 이동 & 경계 --- */
{
  console.log("1) 이동 & 경계");
  const m = makeMatch();
  const p1 = m._playerMap.get("p1");
  const sx = p1.x, sz = p1.z;
  m.input("p1", { keys: { w: true, a: false, s: false, d: false, shift: false }, yaw: p1.yaw, pitch: 0, firing: false });
  run(m, 2); // 2초 전진
  assert(Math.hypot(p1.x - sx, p1.z - sz) > 2, "이동 거리 > 2");
  ok("이동 입력이 위치를 바꿈");

  m.input("p1", { keys: { w: true, a: false, s: false, d: false, shift: false }, yaw: 0, pitch: 0, firing: false });
  run(m, 15);
  assert(Math.abs(p1.x) < 35 && Math.abs(p1.z) < 35, "경계 벽 안");
  ok("경계 밖으로 나가지 않음");
}

/* --- 2. 사격 → 히트 (직선/헤드샷/벽 차단) --- */
{
  console.log("2) 사격 판정");
  const m = fakeClock(makeMatch(), 0);
  const p1 = m._playerMap.get("p1");
  const p2 = m._playerMap.get("p2");

  p1.lastShootAt = -100; // 첫 발 즉시 발사
  p1.weapon = "sr";
  p1.ammo = WEAPONS.sr.magSize;
  p2.x = p1.x;
  p2.z = p1.z + 10;
  p1.yaw = 0; p1.pitch = 0;

  m.input("p1", { keys: {}, yaw: 0, pitch: 0, firing: true });
  const events = run(m, 0.5);
  const shot = events.find(e => e.type === "shot");
  assert(shot, "shot 이벤트 발생");
  const hurt = events.find(e => e.type === "hurt");
  assert(hurt && hurt.pid === "p2", "피격 이벤트 발생");
  assert(p2.hp < 100, "p2 체력 감소");
  ok(`정직선 사격 → 피해 (hp ${p2.hp})`);

  /* 벽에 막히는지 — 중앙 구조물 뒤에 있으면 안 맞음 */
  const m2 = fakeClock(makeMatch(), 0);
  const q1 = m2._playerMap.get("p1");
  const q2 = m2._playerMap.get("p2");
  q1.lastShootAt = -100;
  q1.weapon = "ar";
  q2.weapon = "ar";
  q1.x = -20; q1.z = -10;
  q2.x = 6; q2.z = 0;
  q1.yaw = Math.atan2(q2.x - q1.x, q2.z - q1.z);
  q1.pitch = 0;
  m2.input("p1", { keys: {}, yaw: q1.yaw, pitch: 0, firing: true });
  const ev2 = run(m2, 1);
  assert(ev2.find(e => e.type === "hurt") === undefined, "벽 뒤엔 피격 없음");
  ok("벽이 광선을 막음");
}

/* --- 3. 킬 → 점수/리스폰 --- */
{
  console.log("3) 킬 처리");
  const m = fakeClock(makeMatch(), 0);
  const p1 = m._playerMap.get("p1");
  const p2 = m._playerMap.get("p2");
  p1.lastShootAt = -100;
  p1.weapon = "sr";
  p1.ammo = WEAPONS.sr.magSize;
  p2.x = p1.x; p2.z = p1.z + 5;
  p1.yaw = 0; p1.pitch = 0;
  m.input("p1", { keys: {}, yaw: 0, pitch: 0, firing: true });

  const events = run(m, 5);
  const kill = events.find(e => e.type === "kill");
  assert(kill, "킬 이벤트");
  assert(kill.killerId === "p1" && kill.victimId === "p2", "킬러/피해자 맞음");
  assert(m.scores.red === 1, "레드 점수 +1");
  assert(p1.kills === 1 && p2.deaths === 1, "킬/데스 기록");
  ok(`킬 처리 (점수 ${JSON.stringify(m.scores)})`);

  // 리스폰
  const spawn = events.find(e => e.type === "spawn" && e.pid === "p2");
  assert(spawn, "리스폰 이벤트");
  assert(p2.alive && p2.hp === 100, "리스폰 후 만피 부활");
  ok("리스폰 동작");
}

/* --- 4. 무기 교체 & 리로드 --- */
{
  console.log("4) 무기/리로드");
  const m = fakeClock(makeMatch(), 0);
  const p1 = m._playerMap.get("p1");
  m.setWeapon("p1", "sr");
  assert(p1.weapon === "sr" && p1.ammo === WEAPONS.sr.magSize, "무기 교체");
  ok("무기 교체");

  // 수동 리로드
  p1.ammo = 1;
  m.reload("p1");
  assert(p1.reloading, "수동 리로드 시작");
  ok("수동 리로드 시작");
  run(m, 4);
  assert(!p1.reloading && p1.ammo === WEAPONS.sr.magSize, "리로드 완료");
  ok("리로드 완료");

  // 발사로 탄창 소진 시 자동 리로드
  p1.lastShootAt = -100;
  p1.ammo = 1;
  m.input("p1", { keys: {}, yaw: 0, pitch: 0, firing: true });
  run(m, 0.1);
  assert(p1.reloading, "자동 리로드 시작");
  ok("자동 리로드 시작");
}

/* --- 5. 매치 종료 (시간 종료) --- */
{
  console.log("5) 매치 종료");
  const m = makeMatch();
  m.timeLeft = 0.05;
  const ev = run(m, 0.1);
  const end = ev.find(e => e.type === "end");
  assert(end, "end 이벤트");
  assert(m.finished, "finished 플래그");
  ok("시간 종료 시 end 이벤트");
}

console.log(`\n[game.js] ${passed}개 테스트 통과`);
process.exit(0);