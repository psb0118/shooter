"use strict";

/* Q/X 모바일 터치 버튼이 DOM과 터치 디스패처에 연결되어 있는지 빠르게 검사하는 회귀 테스트.
   실제 터치 발동은 scripts/test-mobile-touch.js에서 Puppeteer로 검증한다. */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "client/index.html"), "utf8");
const main = fs.readFileSync(path.join(root, "client/main.js"), "utf8");
const server = fs.readFileSync(path.join(root, "server/server.js"), "utf8");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/test.yml"), "utf8");
const mobileTest = fs.readFileSync(path.join(root, "scripts/test-mobile-touch.js"), "utf8");

assert.match(html, /id="btn-smoke"[^>]*aria-label="연막 \(Q\)"/, "연막 터치 버튼 마크업");
assert.match(html, /id="btn-ult"[^>]*aria-label="궁극기 \(X\)"/, "궁극기 터치 버튼 마크업");
assert.match(main, /id === "btn-smoke"\) useSmoke\(\)/, "btn-smoke → useSmoke 연결");
assert.match(main, /id === "btn-ult"\) useUlt\(\)/, "btn-ult → useUlt 연결");
assert.match(main, /function useSmoke\(\)[\s\S]*game:skill[\s\S]*smoke/, "연막 스킬 전송 경로");
assert.match(main, /function useUlt\(\)[\s\S]*game:skill[\s\S]*ult/, "궁극기 스킬 전송 경로");

// 이번 개선분의 UI/네트워크 계약이 파일에서 빠지지 않게 고정한다.
assert.match(html, /id="onboarding-card"/, "온보딩 카드 마크업");
assert.match(html, /id="btn-help"/, "온보딩 다시 열기");
assert.match(html, /id="bot-difficulty"/, "봇 난이도 선택 UI");
assert.match(html, /id="connection-overlay"/, "재접속 오버레이");
assert.match(main, /session:resume/, "세션 재개 전송");
assert.match(main, /lastAckSeq/, "입력 ack 추적");
assert.match(main, /applyRenderScale/, "적응형 렌더 해상도");
assert.match(server, /BOT_DIFFICULTY/, "봇 난이도 서버 설정");
assert.match(server, /replacePlayerId/, "재접속 ID 이전");
assert.match(workflow, /SHOOTER_REQUIRE_MOBILE_TEST/, "CI 모바일 테스트 필수 게이트");
assert.match(workflow, /mobile-touch-failure/, "CI 실패 아티팩트");
assert.match(mobileTest, /mobile-touch-failure\.png/, "모바일 실패 스크린샷");

console.log("  ✓ Q/X 터치 버튼 DOM·디스패처 연결");
console.log("  ✓ 온보딩·봇 난이도·재접속·성능·CI 계약");
console.log("\n[touch-wiring] 2개 테스트 통과");
