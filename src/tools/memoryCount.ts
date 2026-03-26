/**
 * memory_count 도구
 * 카테고리/태그/우선순위별 메모리 건수를 조회한다.
 * groupBy를 지정하면 항목별 분류 건수를 반환한다.
 */

import { z } from "zod";
import { getCollectionInfo, scrollMemories, countByFilter } from "../services/qdrantService.js";
import { jsonResponse, errorResponse } from "../utils/response.js";

/** memory_count 도구의 입력 스키마 */
export const memoryCountSchema = z.object({
  /** 대상 스토어 (기본: all — 전체 store 합산) */
  store: z.enum(["general", "images", "files", "secrets", "all"]).default("all"),
  /** 그룹화 기준 (선택, 생략 시 총 건수만 반환) */
  groupBy: z.enum(["category", "priority", "tags"]).optional(),
});

export type MemoryCountInput = z.infer<typeof memoryCountSchema>;

/**
 * 메모리 건수를 조회한다.
 * groupBy가 없으면 컬렉션의 총 포인트 수를 반환한다.
 * groupBy가 있으면 모든 메모리를 순회하여 해당 필드별 건수를 집계한다.
 *
 * @param args - 그룹화 기준
 * @returns MCP 응답 형식의 건수 정보
 */
export async function memoryCount(args: MemoryCountInput) {
  // secrets store만 조회 — SQLCipher countSecrets 호출
  if (args.store === "secrets") {
    const { countSecrets, isSqlcipherReady } = await import("../services/sqlcipherService.js");
    /* isSqlcipherReady 가드 — 미초기화 시 에러 응답 반환 */
    if (!isSqlcipherReady()) {
      return errorResponse("SQLCipher가 초기화되지 않았습니다. ZIME_ENCRYPTION_KEY 환경변수를 확인하세요.");
    }
    const result = countSecrets("secret_type");
    return jsonResponse({
      store: "secrets",
      total: result.total,
      breakdown: result.breakdown,
    });
  }

  // all — Qdrant(general/images/files) + SQLCipher(secrets) 합산
  if (args.store === "all" && !args.groupBy) {
    const { countSecrets, isSqlcipherReady } = await import("../services/sqlcipherService.js");
    /* isSqlcipherReady 가드 — 미초기화 시 secrets는 0으로 합산 */
    const secretsTotal = isSqlcipherReady() ? countSecrets("secret_type").total : 0;
    const [qdrantInfo] = await Promise.all([
      getCollectionInfo(),
    ]);
    const secretsResult = { total: secretsTotal };
    return jsonResponse({
      store: "all",
      total: qdrantInfo.pointsCount + secretsResult.total,
      byStore: {
        qdrant: qdrantInfo.pointsCount,
        secrets: secretsResult.total,
      },
    });
  }

  // 특정 Qdrant store 필터 적용 (general/images/files)
  const storeFilter = args.store !== "all" ? { store: args.store } : undefined;

  // groupBy가 없으면 총 건수만 반환
  if (!args.groupBy) {
    if (storeFilter) {
      // store 필터가 있으면 countByFilter 사용
      const total = await countByFilter(storeFilter);
      return jsonResponse({ store: args.store, total });
    }
    // all + groupBy 없음은 위에서 처리됨 — 여기는 도달하지 않음
    const info = await getCollectionInfo();
    return jsonResponse({ total: info.pointsCount });
  }

  // groupBy가 있으면 전체 메모리를 순회하여 집계 (store 필터 적용)
  const breakdown: Record<string, number> = {};
  let total = 0;
  let offset: string | undefined = undefined;

  while (true) {
    const result = await scrollMemories(storeFilter, 100, offset);

    for (const point of result.points) {
      const payload = point.payload as Record<string, unknown> | null;
      total++;

      if (args.groupBy === "tags") {
        // 태그는 배열이므로 각 태그별로 카운트
        const tags = (payload?.tags as string[]) || [];
        for (const tag of tags) {
          breakdown[tag] = (breakdown[tag] || 0) + 1;
        }
      } else {
        // category 또는 priority는 단일 값
        const value = (payload?.[args.groupBy] as string) || "unknown";
        breakdown[value] = (breakdown[value] || 0) + 1;
      }
    }

    if (result.nextOffset == null) {
      break;
    }
    offset = String(result.nextOffset);
  }

  return jsonResponse({
    store: args.store,
    total,
    breakdown,
  });
}
