/**
 * memory_stats 도구
 * 메모리 컬렉션의 통계 정보를 조회한다.
 */

import { z } from "zod";
import { jsonResponse } from "../utils/response.js";

/** memory_stats 도구의 입력 스키마 (파라미터 없음) */
export const memoryStatsSchema = z.object({});

export type MemoryStatsInput = z.infer<typeof memoryStatsSchema>;

/**
 * Qdrant, MinIO, SQLCipher 통합 통계를 조회한다.
 * storeRouter.getUnifiedStats()를 통해 전체 store 현황을 한 번에 반환한다.
 *
 * @returns MCP 응답 형식의 통합 통계
 */
export async function memoryStats(_args: MemoryStatsInput) {
  const { getUnifiedStats } = await import("../services/storeRouter.js");
  const stats = await getUnifiedStats();

  return jsonResponse({
    collection: "memories",
    general: stats.general,
    images: stats.images,
    files: stats.files,
    secrets: stats.secrets,
    totalPoints: stats.totalPoints,
  } as Record<string, unknown>);
}
