/**
 * memory_reindex 도구
 * 임베딩 모델 변경 시 전체 메모리의 벡터를 재생성한다.
 */
import { z } from "zod";
import { generateEmbedding } from "../services/embeddingService.js";
import { scrollMemories, upsertMemory } from "../services/qdrantService.js";
import type { MemoryPayload } from "../types/index.js";
import { jsonResponse } from "../utils/response.js";

export const memoryReindexSchema = z.object({
  /** 확인 문구 — "CONFIRM"을 입력해야 실행된다 (실수 방지) */
  confirm: z.literal("CONFIRM"),
});

export type MemoryReindexInput = z.infer<typeof memoryReindexSchema>;

/**
 * 전체 메모리를 순회하며 각 메모리의 임베딩 벡터를 재생성한다.
 * 임베딩 모델 변경 후 벡터 차원 불일치를 해소하기 위해 사용한다.
 *
 * @param args - confirm: "CONFIRM" 문자열 필수 (실수 방지)
 * @returns 처리 건수와 실패 건수를 포함한 결과
 */
export async function memoryReindex(args: MemoryReindexInput) {
  let processed = 0;
  let failed = 0;
  let offset: string | undefined = undefined;

  // 전체 메모리를 배치 단위로 순회하며 벡터를 재생성한다
  while (true) {
    const batch = await scrollMemories(undefined, 50, offset);
    if (batch.points.length === 0) break;

    for (const point of batch.points) {
      try {
        const payload = point.payload as Record<string, unknown>;
        const content = payload.content as string;
        const title = payload.title as string | undefined;
        const textToEmbed = title ? `${title}\n\n${content}` : content;

        // 새 임베딩 모델로 벡터를 재생성하고 upsert한다
        const vector = await generateEmbedding(textToEmbed);
        await upsertMemory(String(point.id), vector, payload as unknown as MemoryPayload);
        processed++;
      } catch {
        failed++;
      }
    }

    if (!batch.nextOffset) break;
    offset = String(batch.nextOffset);
  }

  return jsonResponse({
    success: true,
    message: `재인덱싱 완료: ${processed}건 처리, ${failed}건 실패`,
    processed,
    failed,
  });
}
