/**
 * 임베딩 서비스 (Strategy Pattern)
 * EMBEDDING_PROVIDER 환경변수에 따라 적절한 프로바이더를 선택하여 임베딩을 생성한다.
 * - "ollama" (기본값): Ollama REST API
 * - "local": @huggingface/transformers 로컬 임베딩
 * - "off": 임베딩 비활성 (제로 벡터)
 */

import { config } from "../config.js";
import { info } from "../utils/logger.js";

/** 임베딩 프로바이더 공통 인터페이스 */
export interface EmbeddingProvider {
  /** 프로바이더 이름 */
  readonly name: string;
  /** 임베딩 벡터 차원 수 */
  readonly dimensions: number;
  /** 텍스트를 벡터 임베딩으로 변환한다 */
  generateEmbedding(text: string): Promise<number[]>;
  /** 프로바이더 사용 가능 여부를 확인한다 */
  isAvailable(): Promise<boolean>;
}

/** 현재 활성 프로바이더 싱글톤 */
let provider: EmbeddingProvider | null = null;

/**
 * 설정에 따라 적절한 임베딩 프로바이더를 생성한다.
 * 모듈을 동적 import하여 불필요한 의존성 로딩을 방지한다.
 */
async function createProvider(): Promise<EmbeddingProvider> {
  const providerType = config.embedding.provider;

  switch (providerType) {
    case "ollama": {
      const { OllamaProvider } = await import("./providers/ollamaProvider.js");
      return new OllamaProvider();
    }
    case "local": {
      const { LocalProvider } = await import("./providers/localProvider.js");
      return new LocalProvider();
    }
    case "off": {
      const { NoopProvider } = await import("./providers/noopProvider.js");
      return new NoopProvider();
    }
    default:
      throw new Error(`알 수 없는 임베딩 프로바이더: ${providerType}`);
  }
}

/**
 * 현재 활성 프로바이더 인스턴스를 반환한다.
 * 최초 호출 시 프로바이더를 생성하고 캐싱한다.
 */
export async function getProvider(): Promise<EmbeddingProvider> {
  if (!provider) {
    provider = await createProvider();
    info(`임베딩 프로바이더 초기화: ${provider.name} (${provider.dimensions}차원)`);
  }
  return provider;
}

/**
 * 주어진 텍스트를 벡터 임베딩으로 변환한다.
 * 기존 호출부와의 호환성을 유지하는 래퍼 함수.
 *
 * @param text - 임베딩할 텍스트
 * @returns 벡터 배열
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const p = await getProvider();
  return p.generateEmbedding(text);
}

/**
 * 현재 프로바이더가 임베딩 비활성(off) 모드인지 확인한다.
 */
export function isEmbeddingOff(): boolean {
  return config.embedding.provider === "off";
}

/**
 * 현재 프로바이더의 벡터 차원 수를 반환한다.
 * 프로바이더가 아직 초기화되지 않았으면 config 기반으로 추정한다.
 */
export function getEmbeddingDimensions(): number {
  if (provider) return provider.dimensions;
  // 프로바이더 초기화 전에도 차원을 알 수 있도록 config 기반 추정
  if (config.embedding.provider === "local") {
    // local 모델의 기본 차원 (all-MiniLM-L6-v2 = 384)
    return 384;
  }
  return config.ollama.dimensions;
}
