/**
 * Ollama 임베딩 서비스
 * 텍스트를 벡터로 변환하기 위해 Ollama REST API를 호출한다.
 */

import { config } from "../config.js";
import { error as logError } from "../utils/logger.js";

/** Ollama /api/embed 응답 타입 */
interface OllamaEmbedResponse {
  embeddings: number[][];
}

/**
 * 주어진 텍스트를 벡터 임베딩으로 변환한다.
 * Ollama의 /api/embed 엔드포인트를 호출하여 nomic-embed-text 모델로 임베딩을 생성한다.
 *
 * @param text - 임베딩할 텍스트
 * @returns 벡터 배열 (768차원)
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const url = `${config.ollama.url}/api/embed`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.ollama.model,
        input: text,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Ollama 임베딩 요청 실패 (HTTP ${response.status}): ${body}`
      );
    }

    const data = (await response.json()) as OllamaEmbedResponse;

    if (!data.embeddings || data.embeddings.length === 0) {
      throw new Error("Ollama 응답에 임베딩 데이터가 없습니다");
    }

    return data.embeddings[0];
  } catch (err) {
    logError("임베딩 생성 실패:", err);
    throw err;
  }
}
