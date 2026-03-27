/**
 * Ollama 임베딩 프로바이더
 * Ollama REST API (/api/embed)를 통해 텍스트를 벡터로 변환한다.
 */

import { config } from "../../config.js";
import { error as logError } from "../../utils/logger.js";
import type { EmbeddingProvider } from "../embeddingService.js";

/** Ollama /api/embed 응답 타입 */
interface OllamaEmbedResponse {
  embeddings: number[][];
}

export class OllamaProvider implements EmbeddingProvider {
  readonly name = "ollama";
  readonly dimensions: number;

  constructor() {
    this.dimensions = config.ollama.dimensions;
  }

  /**
   * Ollama REST API를 호출하여 텍스트를 벡터 임베딩으로 변환한다.
   * @param text - 임베딩할 텍스트
   * @returns 벡터 배열
   */
  async generateEmbedding(text: string): Promise<number[]> {
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

  /**
   * Ollama 서비스 연결 상태를 확인한다.
   * /api/tags 엔드포인트를 호출하여 설정된 모델이 존재하는지 검증한다.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${config.ollama.url}/api/tags`);
      if (!response.ok) return false;

      const data = (await response.json()) as {
        models?: Array<{ name: string }>;
      };
      const models = data.models || [];
      return models.some(
        (m) =>
          m.name === config.ollama.model ||
          m.name === `${config.ollama.model}:latest`
      );
    } catch {
      return false;
    }
  }
}
