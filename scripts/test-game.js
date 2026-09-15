"use strict";

/* =========================================================
   scripts/test-game.js — game.js 라운드제 엔진 단위 테스트
   실행: node scripts/test-game.js
   가짜 시계(m._now)로 타이밍 로직(구매→전투, 설치/해체, 폭발) 검증
========================================================= */

const assert = require("assert");
const { createMatch, WEAPONS, MAP } = require("../server/game.js");

const ROUNDS_TO_WIN = 13;
const BUY_TIME = 12;
const ROUND_OVER_TIME = 6;

let passed = 0;
function ok(name) { passed++; console.log(`  ✓ ${name}`); }

function setup() {
  const m = createMatch("TEST");
  m.addPlayer({ id: "r", nickname: "레드", team: "red" });
  m.addPlayer({ id: "b", nickname: "블루", team: "blue" });
  const T = { t: 0 };
  m._now = () => T.t;
  m._adv = (s) => { T.t += s; };
  const startEvents = m.start();
  return { m, T, startEvents };
}

function run(m, seconds) {
  const events = [];
  const n = Math.round(seconds * 30) + 1;
  for (let i = 0; i < n; i++) {
    if (m._adv) m._adv(1 / 30);
    events.push(...m.tick(1 / 30));
  }
  return events;
}

/* 종료 판정: 라운드가 roundover까지 간 상태에서 다음 라운드로 진행 */
function nextRound(m) {
  m._adv(ROUND_OVER_TIME + 0.1);
  run(m, 0.1);
}

function toCombat(m) {
  m._adv(BUY_TIME + 0.1);
  run(m, 0.1);
  return m.phase === "combat";
}

/* --- 1. 라운드 시작/캐리어/HP --- */
{
  console.log("1) 라운드 시작 구조");
  const { m, startEvents } = setup();
  assert(m.phase === "buy", "첫 라운드는 buy 단계");
  assert(m.round === 1, "라운드 1 시작");
  assert(m._playerMap.get("r").hp === 150, "HP 150");
  const rs = startEvents.find(e => e.type === "roundstart");
  assert(rs && rs.attackTeam === "red" && rs.defendTeam === "blue", "roundstart 이벤트");
  const cs = startEvents.find(e => e.type === "spikecarrier");
  assert(cs, "spikecarrier 이벤트");
  const carrier = m._playerMap.get(m.spike.carrierId);
  assert(carrier && carrier.team === "red" && carrier.hasSpike, "공격팀 캐리어가 스파이크 소지");
  const carriers = m.getPlayers().filter(p => p.hasSpike);
  assert(carriers.length === 1, "캐리어는 정확히 1명");
  ok(`라운드 ${m.round} buy · 캐리어 ${carrier.id} · HP ${carrier.hp}`);
}

/* --- 2. 경제/구매 --- */
{
  console.log("2) 경제 & 구매");
  const { m } = setup();
  const r = m._playerMap.get("r");
  assert.equal(r.money, 800, "시작 자금 800");

  assert(m.buy("r", "ar") === false, "자금 부족 AR 구매 거부");
  assert(m.buy("r", "smg") === false, "자금 부족 SMG 구매 거부");
  assert(m.buy("r", "pistol") === true, "권총(현재 무기) 재구매 무료");
  assert.equal(r.money, 800, "재구매 시 돈 차감 없음");

  r.money = 1600;
  assert(m.buy("r", "smg") === true, "SMG 구매 성공");
  assert.equal(r.weapon, "smg", "무기 교체");
  assert.equal(r.money, 0, "1600 차감");
  assert(m.buy("r", "smg") === true, "현재 보유 무기 재구매 무료");
  assert.equal(r.money, 0, "재구매 무료 유지");

  r.money = 2900;
  assert(m.buy("r", "ar") === true, "AR 구매 성공");
  assert.equal(r.money, 0, "2900 차감");
  ok("구매 차감/거부/무료 재구매 규칙");

  /* 전투 단계 구매 차단 */
  assert(toCombat(m), "전투 전환");
  assert(m.buy("r", "sg") === false, "전투 중 구매 불가");
  ok("전투 단계 구매 차단");
}

/* --- 3. 라운드 전환: 생존 무기 유지 / 전사 권총 --- */
{
  console.log("3) 라운드 전환 (생존 무기 유지)");
  const { m } = setup();
  toCombat(m);
  const r = m._playerMap.get("r");
  const b = m._playerMap.get("b");

  // r이 b를 처치 → b 사망, r 생존
  r.lastShootAt = -100;
  r.weapon = "sr";
  r.ammo = WEAPONS.sr.magSize;
  b.x = r.x; b.z = r.z + 5;
  r.yaw = 0; r.pitch = 0;
  r.money = 5000;
  m.input("r", { keys: {}, yaw: 0, pitch: 0, firing: true });
  const ev = run(m, 0.5);
  const kill = ev.find(e => e.type === "kill");
  assert(kill && kill.victimId === "b", "처치 이벤트");
  assert(!b.alive, "b 사망");
  assert(ev.find(e => e.type === "spawn") === undefined, "라운드 내 부활 없음");
  assert(ev.find(e => e.type === "roundend" && e.winner === "red"), "전멸로 라운드 종료");
  ok(`라운드 전멸 종료 (scores=${JSON.stringify(m.scores)})`);

  const bKills = b.deaths, bWp = b.weapon;
  assert(bKills === 1 && bWp === "pistol", "데스 기록 / 전사자는 권총 보유");

  nextRound(m);
  assert.equal(m.round, 2, "라운드 2 시작");
  assert.equal(r.weapon, "sr", "생존자 무기 유지");
  assert.equal(r.ammo, WEAPONS.sr.magSize, "생존자 풀탄창");
  assert.equal(b.weapon, "pistol", "전사자는 권총");
  assert.equal(b.hp, 150, "부활은 HP 150");
  assert.equal(m.getPlayers().filter(p => p.hasSpike).length, 1, "새 캐리어 배정");
  ok("생존 유지/전사 권총/만피 부활");
}

/* --- 4. 설치/폭발 --- */
{
  console.log("4) 설치 & 폭발");
  const { m } = setup();
  assert(toCombat(m), "전투 전환");
  const r = m._playerMap.get("r");
  assert.equal(r.hasSpike, true, "캐리어가 스파이크 소지");

  // 사이트 밖 → 설치 불가
  m.interact("r", { type: "plant", action: "start" });
  run(m, 1.0);
  assert(!m.spike.planted && !r.planting, "사이트 밖 설치 불가");

  // 사이트 중앙 → 설치 (홀드 중 이동 고정 확인)
  r.x = MAP.sites.A.cx; r.z = MAP.sites.A.cz;
  m.interact("r", { type: "plant", action: "start" });
  assert(r.planting, "설치 시작");
  const zHold = r.z;
  m.input("r", { keys: { w: true, a: false, s: false, d: false, shift: false }, yaw: 0, pitch: 0, firing: false });
  run(m, 0.7);
  assert(Math.abs(r.z - zHold) < 0.1, "설치 홀드 중 이동 고정");
  run(m, 1.3);
  assert(m.spike.planted, "1.5초 홀드 후 설치 완료");
  assert(!r.planting && !r.hasSpike, "설치 후 캐리어 상태 해제");
  assert.equal(r.money, 800 + 300, "설치 보너스 +300");
  ok("설치 보너스/무브락 확인");

  // 폭발 대기 → 공격 승
  run(m, 46);
  assert(m.roundWinner === "red" && m.roundEndReason === "detonate", "45초 후 폭발 → 공격 승");
  ok(`폭발 승리 (scores=${JSON.stringify(m.scores)})`);
}

/* --- 5. 해체 & 체크포인트 --- */
{
  console.log("5) 해체 & 체크포인트");
  const { m } = setup();
  toCombat(m);
  const r = m._playerMap.get("r");
  const b = m._playerMap.get("b");
  r.x = MAP.sites.B.cx; r.z = MAP.sites.B.cz;
  m.interact("r", { type: "plant", action: "start" });
  run(m, 1.7);
  assert(m.spike.planted, "설치 완료");

  // 유효 범위 밖 해체 불가
  b.x = m.spike.plantX + 6; b.z = m.spike.plantZ;
  m.interact("b", { type: "defuse", action: "start" });
  assert(!b.defusing, "범위 밖 해체 불가");

  // 범위 내 해체 → 3.5초 미만 중단 시 초기화
  b.x = m.spike.plantX + 1; b.z = m.spike.plantZ;
  m.interact("b", { type: "defuse", action: "start" });
  run(m, 1.0);
  assert(b.defusing, "해체 시작");
  m.interact("b", { action: "stop" });
  assert.equal(m.spike.defuseProgress, 0, "3.5초 미만 중단 → 진행 초기화");

  // 3.5초 이상 → 체크포인트 보존
  m.interact("b", { type: "defuse", action: "start" });
  run(m, 3.7);
  m.interact("b", { action: "stop" });
  assert(m.spike.defuseProgress >= 0.5, "절반 이상 진행 보존");

  // 재개 후 완료
  m.interact("b", { type: "defuse", action: "start" });
  run(m, 3.7);
  assert(!m.spike.planted && m.roundWinner === "blue" && m.roundEndReason === "defuse", "해체 완료 → 수비 승");
  ok("해체 체크포인트(3.5s)/완료");

  // 라운드 종료 후 다음 라운드
  nextRound(m);
  assert.equal(m.round, 2, "다음 라운드");
}

/* --- 6. 시간 초과 → 수비 승 / 설치 후 공격 전멸 → 여전히 폭발 --- */
{
  console.log("6) 시간 초과 & 설치 후 전멸");
  const { m } = setup();
  assert(toCombat(m), "전투 전환");
  run(m, 101);
  assert(m.phase === "roundover" && m.roundWinner === "blue" && m.roundEndReason === "timeout", "시간 초과 → 수비 승");
  ok("시간 초과 → 수비 승");
}

/* --- 6-2. 설치 후 공격팀 전멸이어도 폭발 대기 --- */
{
  const { m } = setup();
  toCombat(m);
  const r = m._playerMap.get("r");
  const b = m._playerMap.get("b");
  r.x = MAP.sites.A.cx; r.z = MAP.sites.A.cz;
  m.interact("r", { type: "plant", action: "start" });
  run(m, 1.7);
  assert(m.spike.planted, "설치");
  r.alive = false; // 공격 전멸
  run(m, 5);
  assert(m.phase === "combat" && m.spike.planted, "설치 후 전멸해도 폭발 대기");
  run(m, 42);
  assert(m.roundWinner === "red" && m.roundEndReason === "detonate", "설치 상태면 폭발 → 공격 승");
  ok("설치 후 전멸 → 여전히 폭발 승리");
}

/* --- 7. 스파이크 드랍/픽업 --- */
{
  console.log("7) 드랍 & 픽업");
  const { m } = setup();
  toCombat(m);
  const r = m._playerMap.get("r");
  assert(r.hasSpike, "캐리어 소지");
  m.interact("r", { type: "drop", action: "start" });
  assert(m.spike.dropped && m.spike.carrierId === null && !r.hasSpike, "드랍으로 캐리어 해제");
  const d = [m.spike.dropX, m.spike.dropZ];
  r.x = d[0]; r.z = d[1];
  run(m, 0.2);
  // 승/패 무관 드랍 지점 픽업
  assert(m.spike.carrierId === "r" && r.hasSpike && !m.spike.dropped, "픽업으로 복원");
  ok("드랍/픽업 동작");
}

/* --- 8. 구매 단계 스파이크 전달 (드랍) --- */
{
  console.log("8) 구매 단계 캐리어 드랍");
  const { m } = setup();
  const r = m._playerMap.get("r");
  assert(r.hasSpike, "구매 단계 캐리어");
  m.interact("r", { type: "drop", action: "start" });
  assert(m.spike.dropped && m.spike.carrierId === null, "구매 단계 드랍 허용");
  ok("구매 단계 드랍(팀 전달용)");
}

/* --- 9. 13라운드 선승 → 매치 종료 --- */
{
  console.log("9) 13라운드 선승 종료");
  const { m } = setup();
  let endEv = null;
  for (let i = 0; i < ROUNDS_TO_WIN; i++) {
    m.phase = "combat";
    m.timeLeft = 100;
    const evs = [];
    m._endRound("red", "elim", evs);
    for (const e of evs) {
      if (e.type === "end") {
        assert(!endEv, "end 이벤트 한 번만");
        endEv = e;
      }
    }
    if (!m.finished) {
      m._adv(ROUND_OVER_TIME + 0.1);
      run(m, 0.1);
    }
  }
  assert(endEv, "end 이벤트 발생");
  assert(m.finished && m.winner === "red", "경기 종료");
  assert.equal(m.scores.red, ROUNDS_TO_WIN, `레드 ${ROUNDS_TO_WIN}승`);
  assert(m.phase === "finished", "finished 상태");
  ok(`${ROUNDS_TO_WIN}라운드 선승 → 종료 (${JSON.stringify(m.scores)})`);
}

console.log(`\n[game.js] ${passed}개 테스트 통과`);
process.exit(0);