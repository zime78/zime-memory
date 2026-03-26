/**
 * 간단한 stderr 로거
 * MCP 서버는 stdout을 프로토콜 통신에 사용하므로 로그는 stderr로 출력한다.
 * LOG_LEVEL 환경 변수로 출력 수준을 제어한다 (debug/info/warn/error, 기본: info).
 */

/** 로그 레벨 순서 (낮을수록 상세) */
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

/** 설정된 최소 로그 레벨 (이 레벨 미만의 메시지는 출력하지 않는다) */
const configuredLevel: Level = (() => {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return raw in LEVELS ? (raw as Level) : "info";
})();

/** 현재 시각을 ISO 형식 문자열로 반환한다 */
function timestamp(): string {
  return new Date().toISOString();
}

/** 지정한 레벨이 출력 임계값 이상인지 확인한다 */
function isEnabled(level: Level): boolean {
  return LEVELS[level] >= LEVELS[configuredLevel];
}

/** 디버그 수준 로그를 stderr로 출력한다 */
export function debug(message: string, ...args: unknown[]): void {
  if (isEnabled("debug")) {
    console.error(`[${timestamp()}] [DEBUG] ${message}`, ...args);
  }
}

/** 정보 수준 로그를 stderr로 출력한다 */
export function info(message: string, ...args: unknown[]): void {
  if (isEnabled("info")) {
    console.error(`[${timestamp()}] [INFO] ${message}`, ...args);
  }
}

/** 경고 수준 로그를 stderr로 출력한다 */
export function warn(message: string, ...args: unknown[]): void {
  if (isEnabled("warn")) {
    console.error(`[${timestamp()}] [WARN] ${message}`, ...args);
  }
}

/** 에러 수준 로그를 stderr로 출력한다 */
export function error(message: string, ...args: unknown[]): void {
  if (isEnabled("error")) {
    console.error(`[${timestamp()}] [ERROR] ${message}`, ...args);
  }
}
