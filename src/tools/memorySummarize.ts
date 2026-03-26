/**
 * memory_summarize 도구
 * 필터 조건에 맞는 메모리를 수집하여 정리된 포맷으로 반환한다.
 * 호출자 AI(Claude, Codex, Gemini 등)가 직접 요약을 수행한다.
 */

import { z } from "zod";
import { scrollMemories, type FilterOptions } from "../services/qdrantService.js";
import { jsonResponse, errorResponse } from "../utils/response.js";

/** memory_summarize 도구의 입력 스키마 */
export const memorySummarizeSchema = z.object({
  /** 요약 대상 카테고리 (선택) */
  category: z
    .enum(["note", "knowledge", "reference", "snippet", "decision", "custom"])
    .optional(),
  /** 요약 대상 태그 (선택, OR 조건) */
  tags: z.array(z.string()).optional(),
  /** 요약할 최대 메모리 수 (1~50, 기본값: 20) */
  limit: z.number().int().min(1).max(50).default(20),
});

export type MemorySummarizeInput = z.infer<typeof memorySummarizeSchema>;

/**
 * 필터 조건으로 메모리를 수집하여 요약용 포맷으로 반환한다.
 * 로컬 LLM 의존성 없이, 호출자 AI가 반환된 데이터를 기반으로 요약한다.
 */
export async function memorySummarize(args: MemorySummarizeInput) {
  const filterOptions: FilterOptions = { status: "published" };
  if (args.category) filterOptions.category = args.category;
  if (args.tags) filterOptions.tags = args.tags;

  const result = await scrollMemories(filterOptions, args.limit);

  if (result.points.length === 0) {
    return errorResponse("요약할 메모리가 없습니다");
  }

  const context = args.category
    ? `${args.category} 카테고리`
    : args.tags
      ? `태그 [${args.tags.join(", ")}]`
      : "전체";

  // 각 메모리의 핵심 정보를 정리된 포맷으로 구성
  const maxPerText = Math.floor(4000 / result.points.length);
  const memories = result.points.map((p, i) => {
    const payload = p.payload as Record<string, unknown>;
    const title = payload.title as string | undefined;
    const content = payload.content as string;
    const category = payload.category as string | undefined;
    const tags = payload.tags as string[] | undefined;
    const truncated = content.length > maxPerText
      ? content.substring(0, maxPerText) + "..."
      : content;

    return {
      index: i + 1,
      title: title || "(제목 없음)",
      content: truncated,
      category,
      tags,
    };
  });

  return jsonResponse({
    success: true,
    instruction: `다음은 "${context}" 관련 메모리 ${memories.length}건입니다. 핵심 주제와 인사이트를 요약해주세요.`,
    memoryCount: memories.length,
    context,
    memories,
  } as Record<string, unknown>);
}
