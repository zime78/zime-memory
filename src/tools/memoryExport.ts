/**
 * memory_export 도구
 * 전체 메모리를 JSON으로 내보낸다. 선택적으로 카테고리/태그/우선순위 필터를 적용할 수 있다.
 */

import { z } from "zod";
import { scrollMemories } from "../services/qdrantService.js";
import { jsonResponse, errorResponse } from "../utils/response.js";

/** memory_export 도구의 입력 스키마 */
export const memoryExportSchema = z.object({
  /** 대상 스토어 (기본: general) */
  store: z.enum(["general", "images", "files", "secrets"]).default("general"),
  /** 카테고리 필터 (선택) */
  category: z
    .enum(["note", "knowledge", "reference", "snippet", "decision", "custom"])
    .optional(),
  /** 태그 필터 (선택, OR 조건) */
  tags: z.array(z.string()).optional(),
  /** 우선순위 필터 (선택) */
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
});

export type MemoryExportInput = z.infer<typeof memoryExportSchema>;

/**
 * 모든 메모리를 페이지네이션으로 순회하여 전체 JSON 배열을 반환한다.
 * 선택적으로 카테고리, 태그, 우선순위 필터를 적용할 수 있다.
 * 내용을 잘라내지 않고 전체를 포함한다.
 *
 * @param args - 내보내기 필터 조건
 * @returns MCP 응답 형식의 전체 메모리 JSON
 */
export async function memoryExport(args: MemoryExportInput) {
  // secrets store — SQLCipher exportSecrets (값 제외, 메타만 내보낸다)
  if (args.store === "secrets") {
    const { exportSecrets, isSqlcipherReady } = await import("../services/sqlcipherService.js");
    /* isSqlcipherReady 가드 — 미초기화 시 에러 응답 반환 */
    if (!isSqlcipherReady()) {
      return errorResponse("SQLCipher가 초기화되지 않았습니다. ZIME_ENCRYPTION_KEY 환경변수를 확인하세요.");
    }
    const result = exportSecrets({ includeValues: false });
    return jsonResponse({
      store: "secrets",
      exportedAt: new Date().toISOString(),
      count: result.length,
      secrets: result,
    } as Record<string, unknown>);
  }

  // general/images/files — Qdrant scroll에 store 필터 추가
  const filterOptions: { store?: string; category?: string; tags?: string[]; priority?: string } = {};
  filterOptions.store = args.store;
  if (args.category) filterOptions.category = args.category;
  if (args.tags) filterOptions.tags = args.tags;
  if (args.priority) filterOptions.priority = args.priority;

  const allMemories: Array<Record<string, unknown>> = [];
  let offset: string | undefined = undefined;

  // 모든 메모리를 페이지네이션으로 순회한다 (store 필터 항상 적용)
  while (true) {
    const result = await scrollMemories(
      filterOptions,
      100,
      offset
    );

    for (const point of result.points) {
      const payload = point.payload as Record<string, unknown> | null;
      allMemories.push({
        id: point.id,
        title: payload?.title,
        content: payload?.content,
        category: payload?.category,
        priority: payload?.priority,
        tags: payload?.tags || [],
        source: payload?.source,
        createdAt: payload?.createdAt,
        updatedAt: payload?.updatedAt,
      });
    }

    // 다음 페이지가 없으면 종료
    if (result.nextOffset == null) {
      break;
    }
    offset = String(result.nextOffset);
  }

  return jsonResponse({
    exportedAt: new Date().toISOString(),
    count: allMemories.length,
    memories: allMemories,
  } as Record<string, unknown>);
}
