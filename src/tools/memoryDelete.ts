/**
 * memory_delete 도구
 * ID로 메모리를 삭제한다.
 */

import { z } from "zod";
import { deleteMemory } from "../services/qdrantService.js";
import { localBackupSqlcipher } from "../services/safetyService.js";
import { isSqlcipherReady } from "../services/sqlcipherService.js";
import { jsonResponse, errorResponse } from "../utils/response.js";

/** memory_delete 도구의 입력 스키마 */
export const memoryDeleteSchema = z.object({
  /** 대상 스토어 (기본: general) */
  store: z.enum(["general", "images", "files", "secrets"]).default("general"),
  /** 삭제할 메모리의 UUID */
  id: z.string().uuid("유효한 UUID 형식이어야 합니다"),
});

export type MemoryDeleteInput = z.infer<typeof memoryDeleteSchema>;

/**
 * 지정된 ID의 메모리를 Qdrant에서 삭제한다.
 *
 * @param args - 삭제할 메모리 ID
 * @returns MCP 응답 형식의 삭제 확인
 */
export async function memoryDelete(args: MemoryDeleteInput) {
  // secrets 삭제 전 로컬 백업
  if (args.store === "secrets" && isSqlcipherReady()) {
    try {
      await localBackupSqlcipher("pre-delete-secret");
    } catch { /* 백업 실패해도 삭제는 진행 */ }
  }

  // secrets/images/files store는 storeRouter.deleteByStore로 위임한다
  if (args.store !== "general") {
    const { deleteByStore } = await import("../services/storeRouter.js");
    const ok = await deleteByStore(args.store, args.id);
    if (!ok) {
      return errorResponse(`메모리를 찾을 수 없습니다 (ID: ${args.id})`);
    }
    return jsonResponse({ success: true, id: args.id, message: `메모리가 삭제되었습니다 (ID: ${args.id})` });
  }

  // general store — 기존 Qdrant 동작 유지
  await deleteMemory(args.id);

  return jsonResponse({
    success: true,
    id: args.id,
    message: `메모리가 삭제되었습니다 (ID: ${args.id})`,
  });
}
