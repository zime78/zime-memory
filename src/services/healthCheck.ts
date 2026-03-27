/**
 * 헬스 체크 서비스
 * Qdrant와 Ollama 서비스의 연결 상태를 확인한다.
 * 최대 3회 재시도하며, 각 재시도 사이에 2초 대기한다.
 * MinIO와 SQLCipher는 선택적 서비스로 별도 확인한다.
 */

import { config } from "../config.js";
import { info, warn, error as logError } from "../utils/logger.js";
import { checkMinioHealth } from "./minioService.js";
import { checkSqlcipherHealth } from "./sqlcipherService.js";
import { getProvider } from "./embeddingService.js";

/** 재시도 설정 */
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

/**
 * 지정된 밀리초만큼 대기한다.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Qdrant 서비스의 연결 상태를 확인한다.
 * GET /healthz 엔드포인트를 호출하여 응답을 검증한다.
 */
async function checkQdrant(): Promise<{ ok: boolean; message: string }> {
  try {
    const response = await fetch(`${config.qdrant.url}/healthz`);
    if (response.ok) {
      return { ok: true, message: "Qdrant 연결 성공" };
    }
    return {
      ok: false,
      message: `Qdrant 응답 오류 (HTTP ${response.status})`,
    };
  } catch (err) {
    return {
      ok: false,
      message: `Qdrant 연결 실패: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Ollama 서비스의 연결 상태와 임베딩 모델 존재 여부를 확인한다.
 * GET /api/tags 엔드포인트를 호출하여 모델 목록에서 설정된 모델을 찾는다.
 */
async function checkOllama(): Promise<{ ok: boolean; message: string }> {
  try {
    const response = await fetch(`${config.ollama.url}/api/tags`);
    if (!response.ok) {
      return {
        ok: false,
        message: `Ollama 응답 오류 (HTTP ${response.status})`,
      };
    }

    const data = (await response.json()) as {
      models?: Array<{ name: string }>;
    };
    const models = data.models || [];
    const modelExists = models.some(
      (m) =>
        m.name === config.ollama.model ||
        m.name === `${config.ollama.model}:latest`
    );

    if (modelExists) {
      return {
        ok: true,
        message: `Ollama 연결 성공 (모델: ${config.ollama.model})`,
      };
    }

    return {
      ok: false,
      message: `Ollama에 모델 "${config.ollama.model}"이(가) 없습니다. "ollama pull ${config.ollama.model}" 명령으로 설치하세요.`,
    };
  } catch (err) {
    return {
      ok: false,
      message: `Ollama 연결 실패: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Qdrant와 Ollama의 연결 상태를 확인한다.
 * 실패 시 최대 3회까지 2초 간격으로 재시도한다.
 * MinIO와 SQLCipher는 선택적 서비스로 재시도 루프 밖에서 별도 확인한다.
 *
 * @returns 각 서비스의 상태 메시지
 * @throws 재시도 후에도 연결 실패 시 에러
 */
export async function checkHealth(): Promise<{
  qdrant: string;
  ollama: string;
  minio: string;
  sqlcipher: string;
}> {
  let lastQdrantResult = { ok: false, message: "" };
  let lastOllamaResult = { ok: false, message: "" };

  // 임베딩 프로바이더에 따라 Ollama 헬스체크를 조건부 실행한다
  const embeddingProvider = config.embedding.provider;
  const needsOllamaCheck = embeddingProvider === "ollama";

  if (!needsOllamaCheck) {
    if (embeddingProvider === "off") {
      lastOllamaResult = { ok: true, message: "임베딩 비활성 (off 모드)" };
    } else if (embeddingProvider === "local") {
      // local 모드: @huggingface/transformers 모듈 존재 여부 확인
      try {
        const provider = await getProvider();
        const available = await provider.isAvailable();
        lastOllamaResult = available
          ? { ok: true, message: `로컬 임베딩 (${config.embedding.localModel})` }
          : { ok: false, message: "@huggingface/transformers 패키지 미설치" };
      } catch {
        lastOllamaResult = { ok: false, message: "로컬 임베딩 프로바이더 초기화 실패" };
      }
    }
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    info(`헬스 체크 시도 ${attempt}/${MAX_RETRIES}...`);

    const checks: Promise<{ ok: boolean; message: string }>[] = [checkQdrant()];
    if (needsOllamaCheck) checks.push(checkOllama());

    const [qdrantResult, ollamaResult] = await Promise.all(checks);

    lastQdrantResult = qdrantResult;
    if (ollamaResult) lastOllamaResult = ollamaResult;

    const allOk = lastQdrantResult.ok && lastOllamaResult.ok;
    if (allOk) {
      info("모든 서비스 정상 연결 확인");
      break;
    }

    if (attempt < MAX_RETRIES) {
      if (!lastQdrantResult.ok) warn(`Qdrant: ${lastQdrantResult.message}`);
      if (needsOllamaCheck && !lastOllamaResult.ok) warn(`Ollama: ${lastOllamaResult.message}`);
      warn(`${RETRY_DELAY_MS}ms 후 재시도합니다...`);
      await sleep(RETRY_DELAY_MS);
    }
  }

  // 최대 재시도 후에도 실패한 서비스가 있으면 경고 로그 출력 후 상태 반환
  if (!lastQdrantResult.ok) {
    logError(`Qdrant 연결 실패: ${lastQdrantResult.message}`);
  }
  if (needsOllamaCheck && !lastOllamaResult.ok) {
    logError(`Ollama 연결 실패: ${lastOllamaResult.message}`);
  }

  // MinIO와 SQLCipher는 선택적 서비스이므로 재시도 없이 단순 확인한다
  let minioMessage = "MinIO 비활성";
  try {
    const minioResult = await checkMinioHealth();
    minioMessage = minioResult.message;
  } catch (err) {
    minioMessage = `MinIO 확인 실패: ${err instanceof Error ? err.message : String(err)}`;
  }

  let sqlcipherMessage = "SQLCipher 비활성";
  try {
    const sqlcipherResult = checkSqlcipherHealth();
    sqlcipherMessage = sqlcipherResult.message;
  } catch (err) {
    sqlcipherMessage = `SQLCipher 확인 실패: ${err instanceof Error ? err.message : String(err)}`;
  }

  // 서버는 시작하되, 연결 실패 상태를 반환한다
  // (도구 호출 시점에 다시 연결을 시도할 수 있으므로 치명적 에러로 처리하지 않음)
  return {
    qdrant: lastQdrantResult.message,
    ollama: lastOllamaResult.message,
    minio: minioMessage,
    sqlcipher: sqlcipherMessage,
  };
}
