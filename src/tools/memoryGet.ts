/**
 * memory_get 도구
 * ID로 단일 메모리를 조회한다. 내용을 잘라내지 않고 전체를 반환한다.
 */

import { z } from "zod";
import { getMemoryById, searchMemories } from "../services/qdrantService.js";
import { getByStore } from "../services/storeRouter.js";
import { jsonResponse, errorResponse } from "../utils/response.js";

/** memory_get 도구의 입력 스키마 */
export const memoryGetSchema = z.object({
  /** 저장소 타입 (기본: general) */
  store: z.enum(["general", "images", "files", "secrets"]).default("general"),
  /** 조회할 메모리의 UUID (필수) */
  id: z.string().uuid("유효한 UUID 형식이어야 합니다"),
});

export type MemoryGetInput = z.infer<typeof memoryGetSchema>;

/**
 * ID로 메모리를 조회하여 전체 페이로드를 반환한다.
 * 내용을 잘라내지 않고 전체 content를 포함한다.
 *
 * @param args - 조회할 메모리 ID
 * @returns MCP 응답 형식의 메모리 상세 정보
 */
export async function memoryGet(args: MemoryGetInput) {
  // ─── secrets store ───
  if (args.store === "secrets") {
    const storeResult = await getByStore("secrets", args.id);
    if (!storeResult.found) {
      return errorResponse(`시크릿을 찾을 수 없습니다 (ID: ${args.id})`);
    }
    return jsonResponse({ ...storeResult.data as Record<string, unknown>, store: "secrets" });
  }

  // ─── general/images/files store ───
  // 벡터 포함 조회하여 관련 메모리 검색에 활용한다
  const result = await getMemoryById(args.id, true);

  if (!result) {
    return errorResponse(`메모리를 찾을 수 없습니다 (ID: ${args.id})`);
  }

  const payload = result.payload as Record<string, unknown> | null;

  // 관련 메모리 추천: 벡터로 유사도 0.5 이상인 메모리를 검색하고 자기 자신을 제외한다
  let relatedMemories: Array<{ id: string | number; title: string; score: number }> = [];
  if (result.vector && result.vector.length > 0) {
    try {
      const related = await searchMemories(result.vector, 4, undefined, 0.5);
      relatedMemories = related
        .filter((r) => String(r.id) !== String(args.id))
        .slice(0, 3)
        .map((r) => {
          const p = r.payload as Record<string, unknown> | null;
          return {
            id: r.id,
            title: (p?.title as string) || "(제목 없음)",
            score: Math.round(r.score * 1000) / 1000,
          };
        });
    } catch {
      // 관련 메모리 검색 실패 시 조회는 계속 진행한다
    }
  }

  // 명시적 연결 메모리의 제목을 조회한다
  let linkedMemories: Array<{ id: string; title: string }> = [];
  const relatedIds = (payload?.relatedIds as string[]) || [];
  if (relatedIds.length > 0) {
    const fetches = relatedIds.slice(0, 10).map(async (rid) => {
      try {
        const linked = await getMemoryById(rid);
        if (linked) {
          const lp = linked.payload as Record<string, unknown> | null;
          return { id: rid, title: (lp?.title as string) || "(제목 없음)" };
        }
      } catch { /* skip */ }
      return null;
    });
    linkedMemories = (await Promise.all(fetches)).filter((m): m is { id: string; title: string } => m !== null);
  }

  // images/files인 경우 presigned URL 생성
  let presignedUrl: string | undefined;
  const payloadStore = (payload?.store as string) || "general";
  if (
    (payloadStore === "images" || payloadStore === "files") &&
    payload?.objectKey &&
    payload?.bucket
  ) {
    try {
      const { getPresignedUrl } = await import("../services/minioService.js");
      presignedUrl = await getPresignedUrl(
        payload.bucket as string,
        payload.objectKey as string,
      );
    } catch { /* presigned URL 생성 실패는 무시 — 메타데이터만 반환 */ }
  }

  const response: Record<string, unknown> = {
    id: result.id,
    store: payloadStore,
    title: payload?.title || "(제목 없음)",
    content: payload?.content ?? "",
    category: payload?.category,
    priority: payload?.priority,
    tags: payload?.tags || [],
    pinned: payload?.pinned ?? false,
    source: payload?.source,
    status: payload?.status,
    ttl: payload?.ttl,
    expiresAt: payload?.expiresAt,
    parentId: payload?.parentId,
    relatedIds: payload?.relatedIds || [],
    createdAt: payload?.createdAt,
    updatedAt: payload?.updatedAt,
  };

  // images/files 전용 필드
  if (payloadStore === "images" || payloadStore === "files") {
    response.objectKey = payload?.objectKey;
    response.originalName = payload?.originalName;
    response.mimeType = payload?.mimeType;
    response.fileSize = payload?.fileSize;
    response.bucket = payload?.bucket;
    response.description = payload?.description;
    response.resolution = payload?.resolution;
    if (presignedUrl) response.presignedUrl = presignedUrl;
  }

  if (linkedMemories.length > 0) {
    response.linkedMemories = linkedMemories;
  }

  if (relatedMemories.length > 0) {
    response.relatedMemories = relatedMemories;
  }

  return jsonResponse(response);
}
