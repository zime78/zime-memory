/**
 * memory_bulk_delete 도구
 * 필터 기반으로 메모리를 일괄 삭제한다.
 * 최소 하나의 필터 조건이 필요하며, 전체 삭제를 방지한다.
 */

import { z } from "zod";
import { countByFilter, deleteByFilter } from "../services/qdrantService.js";
import { localBackupQdrant } from "../services/safetyService.js";
import { jsonResponse } from "../utils/response.js";

/** memory_bulk_delete 도구의 입력 스키마 */
export const memoryBulkDeleteSchema = z
  .object({
    /** 대상 스토어 (기본: general, secrets는 bulk delete 미지원) */
    store: z.enum(["general", "images", "files"]).default("general"),
    /** 카테고리 필터 (선택) */
    category: z
      .enum(["note", "knowledge", "reference", "snippet", "decision", "custom"])
      .optional(),
    /** 태그 필터 (선택, OR 조건) */
    tags: z.array(z.string()).optional(),
    /** 우선순위 필터 (선택) */
    priority: z.enum(["low", "medium", "high", "critical"]).optional(),
    /** 삭제 확인 문구 — "DELETE"를 입력해야 실행된다 (실수 방지) */
    confirm: z.string().optional(),
  })
  .refine(
    (data) => {
      return data.category !== undefined || data.tags !== undefined || data.priority !== undefined;
    },
    { message: "최소 하나의 필터 조건이 필요합니다 (전체 삭제 방지)" }
  );

export type MemoryBulkDeleteInput = z.infer<typeof memoryBulkDeleteSchema>;

/**
 * 필터 조건에 해당하는 메모리를 일괄 삭제한다.
 * 삭제 전 매칭 건수를 먼저 조회하여 응답에 포함한다.
 *
 * @param args - 삭제 필터 조건
 * @returns MCP 응답 형식의 삭제 결과
 */
export async function memoryBulkDelete(args: MemoryBulkDeleteInput) {
  // store 필터를 항상 포함하여 다른 store의 데이터를 보호한다
  const filterOptions: { store?: string; category?: string; tags?: string[]; priority?: string } = {};
  filterOptions.store = args.store;
  if (args.category) filterOptions.category = args.category;
  if (args.tags) filterOptions.tags = args.tags;
  if (args.priority) filterOptions.priority = args.priority;

  // 삭제 전 매칭 건수 조회
  const count = await countByFilter(filterOptions);

  if (count === 0) {
    return jsonResponse({
      success: true,
      deletedCount: 0,
      filter: filterOptions,
      message: "조건에 해당하는 메모리가 없습니다",
    });
  }

  // confirm이 없으면 preview만 반환하고 실제 삭제는 하지 않는다
  if (args.confirm !== "DELETE") {
    return jsonResponse({
      success: false,
      preview: true,
      matchedCount: count,
      filter: filterOptions,
      message: `${count}건의 메모리가 삭제 대상입니다. 실제 삭제하려면 confirm: "DELETE"를 추가하세요.`,
    });
  }

  // 삭제 전 자동 백업
  try {
    await localBackupQdrant("pre-bulk-delete");
  } catch { /* 백업 실패해도 삭제는 진행 */ }

  // 필터 기반 일괄 삭제
  await deleteByFilter(filterOptions);

  return jsonResponse({
    success: true,
    deletedCount: count,
    filter: filterOptions,
    message: `${count}건의 메모리가 삭제되었습니다`,
  });
}
