/**
 * 로컬 임베딩 프로바이더
 * @huggingface/transformers를 사용하여 Node.js 프로세스 내에서 직접 임베딩을 생성한다.
 * Ollama 없이 독립적으로 동작하며, 모델은 첫 호출 시 lazy loading된다.
 */

import { config } from "../../config.js";
import { info, warn, error as logError } from "../../utils/logger.js";
import type { EmbeddingProvider } from "../embeddingService.js";

/** 로컬 임베딩 모델별 벡터 차원 수 매핑 */
const localModelDimensions: Record<string, number> = {
  "Xenova/all-MiniLM-L6-v2": 384,
  "Xenova/bge-m3": 1024,
  "Xenova/bge-small-en-v1.5": 384,
  "Xenova/bge-base-en-v1.5": 768,
  "nomic-ai/nomic-embed-text-v1.5": 768,
};

/** feature-extraction 파이프라인 인스턴스 (lazy loaded) */
let extractorPipeline: any = null;
/** 모델 로딩 진행 중 flag (중복 초기화 방지) */
let loading: Promise<any> | null = null;

/**
 * feature-extraction 파이프라인을 lazy loading한다.
 * 첫 호출 시에만 모델을 다운로드/로드하며, 이후 캐싱된 인스턴스를 반환한다.
 */
async function getExtractor(): Promise<any> {
  if (extractorPipeline) return extractorPipeline;

  if (loading) return loading;

  loading = (async () => {
    const modelName = config.embedding.localModel;
    info(`로컬 임베딩 모델 로딩 중: ${modelName} (첫 실행 시 다운로드될 수 있습니다)...`);

    try {
      const { pipeline } = await import("@huggingface/transformers");
      extractorPipeline = await pipeline("feature-extraction", modelName, {
        dtype: "fp32",
      });
      info(`로컬 임베딩 모델 로드 완료: ${modelName}`);
      return extractorPipeline;
    } catch (err) {
      loading = null;
      logError(`로컬 임베딩 모델 로드 실패: ${modelName}`, err);
      throw new Error(
        `로컬 임베딩 모델 "${modelName}" 로드 실패. ` +
          `네트워크 연결을 확인하거나, 모델이 ~/.cache/huggingface/에 캐시되어 있는지 확인하세요. ` +
          `원인: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  })();

  return loading;
}

export class LocalProvider implements EmbeddingProvider {
  readonly name = "local";
  readonly dimensions: number;

  constructor() {
    const modelName = config.embedding.localModel;
    this.dimensions = localModelDimensions[modelName] ?? 384;
  }

  /**
   * @huggingface/transformers 파이프라인을 사용하여 텍스트를 벡터 임베딩으로 변환한다.
   * @param text - 임베딩할 텍스트
   * @returns 벡터 배열
   */
  async generateEmbedding(text: string): Promise<number[]> {
    const extractor = await getExtractor();
    const output = await extractor(text, { pooling: "mean", normalize: true });
    return Array.from(output.data as Float32Array);
  }

  /**
   * 로컬 모델 사용 가능 여부를 확인한다.
   * 실제 모델 로드를 시도하지 않고, @huggingface/transformers 모듈 존재 여부만 확인한다.
   */
  async isAvailable(): Promise<boolean> {
    try {
      await import("@huggingface/transformers");
      return true;
    } catch {
      warn(
        "@huggingface/transformers 패키지가 설치되지 않았습니다. " +
          "npm install @huggingface/transformers 를 실행하세요."
      );
      return false;
    }
  }
}
