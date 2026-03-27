/**
 * Noop 임베딩 프로바이더 (off 모드)
 * 임베딩을 생성하지 않고 제로 벡터를 반환한다.
 * 의미 기반 유사도 검색이 불가하며 키워드/필터 검색만 가능하다.
 */

import { config } from "../../config.js";
import type { EmbeddingProvider } from "../embeddingService.js";

export class NoopProvider implements EmbeddingProvider {
  readonly name = "off";
  readonly dimensions: number;

  constructor() {
    // 기존 컬렉션과의 호환성을 위해 현재 설정된 차원 수를 유지한다
    this.dimensions = config.ollama.dimensions;
  }

  /**
   * 제로 벡터를 반환한다.
   * Qdrant 포인트 구조를 유지하면서 실제 임베딩은 생성하지 않는다.
   */
  async generateEmbedding(_text: string): Promise<number[]> {
    return new Array(this.dimensions).fill(0);
  }

  /** 항상 사용 가능 */
  async isAvailable(): Promise<boolean> {
    return true;
  }
}
