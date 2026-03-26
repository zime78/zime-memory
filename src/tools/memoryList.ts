/**
 * memory_list 도구
 * 필터 조건으로 메모리 목록을 조회한다 (벡터 검색 없이 스크롤).
 */

import { z } from "zod";
import { scrollMemories } from "../services/qdrantService.js";
import type { FilterOptions } from "../services/qdrantService.js";
import { jsonResponse, errorResponse } from "../utils/response.js";

/** memory_list 도구의 입력 스키마 */
export const memoryListSchema = z.object({
  /** 저장소 타입 (기본: general) */
  store: z.enum(["general", "images", "files", "secrets"]).default("general"),
  /** 카테고리 필터 (선택) */
  category: z
    .enum(["note", "knowledge", "reference", "snippet", "decision", "custom"])
    .optional(),
  /** 태그 필터 (선택, OR 조건) */
  tags: z.array(z.string()).optional(),
  /** 우선순위 필터 (선택) */
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  /** 반환할 최대 결과 수 (1~100, 기본값: 20) */
  limit: z.number().int().min(1).max(100).default(20),
  /** 스크롤 커서 (이전 응답의 nextOffset 값, 첫 페이지는 생략) */
  offset: z.string().optional(),
  /** 메모리 상태 필터 (선택, 명시 시 includeDrafts 무시) */
  status: z.enum(["published", "draft"]).optional(),
  /** draft 포함 여부 (기본: false, false면 자동으로 status="published" 필터 적용) */
  includeDrafts: z.boolean().default(false),
  /** 생성일 시작 범위 (ISO 8601, 선택) */
  fromDate: z.string().datetime().optional(),
  /** 생성일 종료 범위 (ISO 8601, 선택) */
  toDate: z.string().datetime().optional(),
});

export type MemoryListInput = z.infer<typeof memoryListSchema>;

/**
 * 필터 조건으로 메모리 목록을 페이지네이션하여 조회한다.
 * Qdrant의 scroll API를 사용하여 벡터 검색 없이 페이로드 필터만으로 조회한다.
 *
 * @param args - 조회 조건
 * @returns MCP 응답 형식의 메모리 목록
 */
export async function memoryList(args: MemoryListInput) {
  // ─── secrets store ───
  if (args.store === "secrets") {
    const { listSecrets, isSqlcipherReady } = await import("../services/sqlcipherService.js");
    /* isSqlcipherReady 가드 — 미초기화 시 에러 응답 반환 */
    if (!isSqlcipherReady()) {
      return errorResponse("SQLCipher가 초기화되지 않았습니다. ZIME_ENCRYPTION_KEY 환경변수를 확인하세요.");
    }
    const result = listSecrets({
      limit: args.limit,
      offset: args.offset ? parseInt(args.offset) : undefined,
    });

    return jsonResponse({
      store: "secrets",
      count: result.secrets.length,
      total: result.total,
      secrets: result.secrets.map((s) => ({
        id: s.id,
        name: s.name,
        secretType: s.secretType,
        service: s.service,
        tags: s.tags,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
    } as Record<string, unknown>);
  }

  // ─── general/images/files store ───
  const filterOptions: FilterOptions = {};
  if (args.category) filterOptions.category = args.category;
  if (args.tags) filterOptions.tags = args.tags;
  if (args.priority) filterOptions.priority = args.priority;

  if (args.status) {
    filterOptions.status = args.status;
  } else if (!args.includeDrafts) {
    filterOptions.status = "published";
  }

  if (args.fromDate) filterOptions.fromDate = args.fromDate;
  if (args.toDate) filterOptions.toDate = args.toDate;

  // store 필터 추가
  filterOptions.store = args.store;

  const result = await scrollMemories(
    Object.keys(filterOptions).length > 0 ? filterOptions : undefined,
    args.limit,
    args.offset
  );

  const formatted = result.points.map((p) => {
    const payload = p.payload as Record<string, unknown> | null;
    return {
      id: p.id,
      title: payload?.title || "(제목 없음)",
      content:
        typeof payload?.content === "string"
          ? payload.content.length > 200
            ? payload.content.substring(0, 200) + "..."
            : payload.content
          : "",
      category: payload?.category,
      priority: payload?.priority,
      tags: payload?.tags || [],
      pinned: payload?.pinned ?? false,
      createdAt: payload?.createdAt,
    };
  });

  // pinned 메모리를 상단에 정렬 (목록 내 순서는 유지)
  formatted.sort((a, b) => {
    const aPinned = a.pinned ? 1 : 0;
    const bPinned = b.pinned ? 1 : 0;
    return bPinned - aPinned;
  });

  return jsonResponse({
    count: formatted.length,
    nextOffset: result.nextOffset ?? null,
    memories: formatted,
  } as Record<string, unknown>);
}
