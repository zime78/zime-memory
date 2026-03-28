/**
 * 연결 상태 모니터 서비스
 * Qdrant healthz 엔드포인트를 주기적으로 확인하여 온라인/오프라인 상태를 판별한다.
 * CACHE_ENABLED=true일 때만 활성화된다. false이면 항상 온라인으로 간주한다.
 */

import { config } from "../config.js";
import { info, warn } from "../utils/logger.js";

/** 모니터링 설정 */
const PING_INTERVAL_MS = 30_000;
const PING_TIMEOUT_MS = 3_000;

/** 내부 상태 */
let online = true;
let lastChecked = "";
let lastOnline = "";
let monitorTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Qdrant healthz 엔드포인트에 경량 ping을 보낸다.
 * 타임아웃 3초 내 응답이 없으면 오프라인으로 판정한다.
 */
async function ping(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);

    const response = await fetch(`${config.qdrant.url}/healthz`, {
      signal: controller.signal,
    });

    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * 현재 연결 상태를 반��한다.
 * 캐시가 비활성이면 항상 true를 반환한다 (서버 모드).
 */
export function isOnline(): boolean {
  if (!config.cache.enabled) return true;
  return online;
}

/**
 * 연결 상태 상세 정보를 반환한다.
 */
export function getConnectionStatus(): {
  online: boolean;
  lastChecked: string;
  lastOnline: string;
  monitoring: boolean;
} {
  return {
    online: isOnline(),
    lastChecked,
    lastOnline,
    monitoring: monitorTimer !== undefined,
  };
}

/**
 * 주기적 연결 모니터링을 시작한다.
 * 캐시가 비활성이면 모니터링을 시작하지 않는다.
 */
export function startMonitoring(): void {
  if (!config.cache.enabled) return;
  if (monitorTimer) return;

  /* 즉시 첫 ping 실행 */
  checkConnection();

  monitorTimer = setInterval(checkConnection, PING_INTERVAL_MS);
  info("[CONNECTION] 모니터링 시작");
}

/**
 * 모니터링을 중지한다.
 */
export function stopMonitoring(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = undefined;
    info("[CONNECTION] 모니터링 중지");
  }
}

/**
 * 네트워크 에러 여부를 판별한다.
 * fetch 실패, ECONNREFUSED 등 연결 관련 에러를 감지한다.
 */
export function isNetworkError(err: unknown): boolean {
  if (!config.cache.enabled) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|abort/i.test(msg);
}

/**
 * 네트워크 에러 발생 시 오프라인으로 전환하고 에러를 오프라인 메시지로 변환한다.
 * 쓰기 작업의 catch 블록에서 사용한다.
 */
export function handleNetworkError(err: unknown, operation: string): never {
  if (isNetworkError(err)) {
    online = false;
    warn(`[CONNECTION] 오프라인 전환 — ${operation} 중 네트워크 에러 감지`);
    throw new Error(`오프라인 모드에서는 ${operation} 작업을 수행할 수 없습니다. SSH 터널 연결을 확인하세요.`);
  }
  throw err;
}

/**
 * 연결 상태를 확인하고 변경 시 로그를 출력한다.
 */
async function checkConnection(): Promise<void> {
  const now = new Date().toISOString();
  lastChecked = now;

  const reachable = await ping();
  const wasOnline = online;
  online = reachable;

  if (reachable) {
    lastOnline = now;
  }

  /* 상태 변경 시에만 로그 출력 */
  if (wasOnline && !reachable) {
    warn("[CONNECTION] 오프라인 전환 — Qdrant 서비스에 연결할 수 없습니다");
  } else if (!wasOnline && reachable) {
    info("[CONNECTION] 온라인 복귀 — Qdrant 서비스 연결 복구됨");
  }
}
