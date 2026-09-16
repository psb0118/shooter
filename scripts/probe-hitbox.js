"use strict";
/* 히트박스 정렬 검증 v2: 게임 정상 경로로 발사 -> shot 이벤트의 part 판정 */
const { createMatch, MAP } = require("../server/game.js");

const EYE = 1.6;

// 스프레드 0 고정
let realRandom = Math.random;
Math.random = () => 0.5;

const m = createMatch("HIT");
m.addPlayer({ id: "r", nickname: "흑", team: "red" });
m.addPlayer({ id: "b", nickname: "청", team: "blue" });
const T = { t: 0 };
m._now = () => T.t;
m._adv = (s) => { T.t += s; };
m.start();

// 구매 단계 스킵 후 전투
for (let i = 0; i < 12.2 * 30; i++) { m._adv(1 / 30); m.tick(1 / 30); }
if (m.phase !== "combat") { console.log("combat 아님:", m.phase); process.exit(1); }

const r = m.getPlayer("r");
const b = m.getPlayer("b");
if (!r || !b) { console.log("no players"); process.exit(1); }

// 열린 지형으로 이동 (중앙 구조물 피함, x=-26 통로)
r.x = -26; r.z = -20; r.cx = -26; r.cz = -20; r.vx = 0; r.vz = 0; r.yaw = 0; r.alive = true;
b.x = -26; b.z = 5; b.vx = 0; b.vz = 0; b.yaw = 0; b.alive = true; b.hp = 150;
r.weapon = "ar"; r.ammo = 60; r.firing = false; r.ads = false;

function aim(yTarget) { return Math.atan2(yTarget - EYE, 25); }

const cases = [
  { label: "헤드(1.62)", y: 1.62 },
  { label: "어깨/헬멧(1.78)", y: 1.78 },
  { label: "몸통 가슴(1.05)", y: 1.05 },
  { label: "몸통 배(0.63)", y: 0.63 },
  { label: "다리(0.28)", y: 0.28 },
  { label: "정면 수평(1.6)", y: 1.6 },
];

for (const c of cases) {
  b.hp = 150; b.alive = true; r.ammo = 60; r.reloading = false;
  r.pitch = aim(c.y);
  r.firing = false;
  console.log(`${c.label.padEnd(16)} r=(${r.x.toFixed(1)},${r.z.toFixed(1)}) b=(${b.x.toFixed(1)},${b.z.toFixed(1)}) alive=${b.alive} pitch=${r.pitch.toFixed(3)}`);
  m.input("r", { keys: {}, yaw: 0, pitch: r.pitch, firing: true, ads: false });
  const ev = m.tick(1 / 30);
  m.input("r", { keys: {}, yaw: 0, pitch: r.pitch, firing: false, ads: false });
  m.tick(1 / 30);
  // cadence 대기
  for (let i = 0; i < 6; i++) { m._adv(1 / 30); m.tick(1 / 30); }
  const shot = ev.find(e => e.type === "shot");
  if (!shot) { console.log(c.label, `-> shot 없음 (p.firing=${r.firing} ammo=${r.ammo} alive=${b.alive})`); continue; }
  console.log(`   shot ox=${shot.ox.toFixed(1)} oy=${shot.oy.toFixed(1)} oz=${shot.oz.toFixed(1)} dx=${shot.dx.toFixed(3)} dy=${shot.dy.toFixed(3)} dz=${shot.dz.toFixed(3)}`);
  console.log(`${c.label.padEnd(16)} part=${(shot.part || "miss").padEnd(5)} hitY=${(shot.hitY ?? -1).toFixed(2)} dmg=${shot.dmg || 0}`);
}

Math.random = realRandom;
process.exit(0);