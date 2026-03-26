#!/usr/bin/env node
/**
 * 시크릿 만료 체크 스크립트
 * SQLCipher DB에서 만료 임박 시크릿을 조회하고 Slack Bot API로 알림을 전송한다.
 *
 * 환경변수:
 *   ZIME_ENCRYPTION_KEY — SQLCipher 암호화 키 (필수)
 *   SLACK_BOT_TOKEN     — Slack Bot User OAuth Token (필수)
 *   SLACK_CHANNEL       — Slack 채널 ID (필수)
 *   EXPIRY_DAYS         — 만료 임박 기준 일수 (기본: 30)
 */

const path = require("path");
const https = require("https");

/* ── 설정 ─────────────────────────────────────────── */
const ENCRYPTION_KEY = process.env.ZIME_ENCRYPTION_KEY;
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL;
const EXPIRY_DAYS = parseInt(process.env.EXPIRY_DAYS || "30", 10);
const DB_PATH = process.env.SQLCIPHER_DB_PATH || path.resolve(__dirname, "..", "data", "secrets.db");

if (!ENCRYPTION_KEY) {
  console.error("ZIME_ENCRYPTION_KEY 환경변수가 필요합니다.");
  process.exit(1);
}
if (!SLACK_TOKEN) {
  console.error("SLACK_BOT_TOKEN 환경변수가 필요합니다.");
  process.exit(1);
}
if (!SLACK_CHANNEL) {
  console.error("SLACK_CHANNEL 환경변수가 필요합니다.");
  process.exit(1);
}

/* ── DB 조회 ──────────────────────────────────────── */
const Database = require(path.resolve(__dirname, "..", "node_modules", "better-sqlite3-multiple-ciphers"));
const db = new Database(DB_PATH);
db.pragma(`key = "x'${ENCRYPTION_KEY}'"`);

const rows = db.prepare(`
  SELECT name, service, secret_type, expires_at, notes
  FROM secrets
  WHERE expires_at IS NOT NULL
    AND date(expires_at) <= date('now', '+' || ? || ' days')
  ORDER BY expires_at ASC
`).all(EXPIRY_DAYS);

db.close();

if (rows.length === 0) {
  console.log(`만료 ${EXPIRY_DAYS}일 이내 시크릿 없음. 알림 생략.`);
  process.exit(0);
}

/* ── 메시지 구성 ──────────────────────────────────── */
const today = new Date();
const lines = rows.map((r) => {
  const exp = new Date(r.expires_at);
  const diff = Math.ceil((exp - today) / (1000 * 60 * 60 * 24));
  const emoji = diff <= 0 ? ":red_circle:" : diff <= 7 ? ":large_orange_circle:" : ":large_yellow_circle:";
  const status = diff <= 0 ? `*만료됨* (${Math.abs(diff)}일 전)` : `*${diff}일 남음*`;
  return `${emoji}  *${r.name}*  — ${r.service || "N/A"} | ${r.expires_at} | ${status}`;
});

const payload = {
  channel: SLACK_CHANNEL,
  blocks: [
    {
      type: "header",
      text: { type: "plain_text", text: `🔑 시크릿 만료 알림 (${rows.length}건)`, emoji: true },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n") },
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `_${today.toISOString().slice(0, 10)} 기준 | ${EXPIRY_DAYS}일 이내 만료 항목_` },
      ],
    },
  ],
  text: `시크릿 만료 알림: ${rows.length}건이 ${EXPIRY_DAYS}일 이내 만료 예정`,
};

/* ── Slack chat.postMessage API ───────────────────── */
const body = JSON.stringify(payload);

const req = https.request(
  {
    hostname: "slack.com",
    path: "/api/chat.postMessage",
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Authorization": `Bearer ${SLACK_TOKEN}`,
      "Content-Length": Buffer.byteLength(body),
    },
  },
  (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      try {
        const result = JSON.parse(data);
        if (result.ok) {
          console.log(`Slack 알림 전송 완료 (${rows.length}건) → #${SLACK_CHANNEL}`);
        } else {
          console.error(`Slack API 에러: ${result.error}`);
          process.exit(1);
        }
      } catch (e) {
        console.error(`Slack 응답 파싱 실패: ${data}`);
        process.exit(1);
      }
    });
  }
);

req.on("error", (err) => {
  console.error("Slack 전송 에러:", err.message);
  process.exit(1);
});

req.write(body);
req.end();
