/**
 * memory_search 도구
 * 벡터 유사도 기반으로 메모리를 검색한다.
 */

import { z } from "zod";
import { generateEmbedding } from "../services/embeddingService.js";
import { searchMemories } from "../services/qdrantService.js";
import type { FilterOptions } from "../services/qdrantService.js";
import { searchQdrant, searchAll } from "../services/storeRouter.js";
import { jsonResponse, errorResponse } from "../utils/response.js";

/** memory_search 도구의 입력 스키마 */
export const memorySearchSchema = z.object({
  /** 저장소 타입 (기본: general, "all"이면 크로스 검색) */
  store: z
    .enum(["general", "images", "files", "secrets", "all"])
    .default("general"),
  /** 검색 쿼리 텍스트 (필수) */
  query: z.string().min(1, "검색어는 비어있을 수 없습니다"),
  /** 반환할 최대 결과 수 (1~20, 기본값: 5) */
  limit: z.number().int().min(1).max(20).default(5),
  /** 카테고리 필터 (선택) */
  category: z
    .enum(["note", "knowledge", "reference", "snippet", "decision", "custom"])
    .optional(),
  /** 태그 필터 (선택, OR 조건) */
  tags: z.array(z.string()).optional(),
  /** 우선순위 필터 (선택) */
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  /** 최소 유사도 점수 (0~1, 기본값: 0.3) */
  scoreThreshold: z.number().min(0).max(1).default(0.3),
  /** 메모리 상태 필터 (선택, 명시 시 includeDrafts 무시) */
  status: z.enum(["published", "draft"]).optional(),
  /** draft 포함 여부 (기본: false, false면 자동으로 status="published" 필터 적용) */
  includeDrafts: z.boolean().default(false),
  /** 생성일 시작 범위 (ISO 8601, 선택) */
  fromDate: z.string().datetime().optional(),
  /** 생성일 종료 범위 (ISO 8601, 선택) */
  toDate: z.string().datetime().optional(),
});

export type MemorySearchInput = z.infer<typeof memorySearchSchema>;

/**
 * 쿼리 텍스트를 임베딩한 뒤 Qdrant에서 유사한 메모리를 검색한다.
 * 선택적으로 카테고리, 태그, 우선순위 필터를 적용할 수 있다.
 *
 * @param args - 검색 조건
 * @returns MCP 응답 형식의 검색 결과
 */
export async function memorySearch(args: MemorySearchInput) {
  // ─── 크로스 스토어 검색 ───
  if (args.store === "all") {
    const filterOptions: FilterOptions = {};
    if (args.category) filterOptions.category = args.category;
    if (args.tags) filterOptions.tags = args.tags;
    if (args.priority) filterOptions.priority = args.priority;
    if (args.status) filterOptions.status = args.status;
    else if (!args.includeDrafts) filterOptions.status = "published";
    if (args.fromDate) filterOptions.fromDate = args.fromDate;
    if (args.toDate) filterOptions.toDate = args.toDate;

    const results = await searchAll({
      query: args.query,
      limit: args.limit,
      filterOptions,
      scoreThreshold: args.scoreThreshold,
    });

    return jsonResponse({
      query: args.query,
      store: "all",
      resultCount: results.length,
      results: results.map((r) => ({
        id: r.id,
        score: r.score != null ? Math.round(r.score * 1000) / 1000 : null,
        store: r.store,
        matchType: r.matchType,
        payload: r.payload,
        presignedUrl: r.presignedUrl,
      })),
    } as Record<string, unknown>);
  }

  // ─── secrets store 검색 ───
  if (args.store === "secrets") {
    const { searchSecrets, isSqlcipherReady } = await import("../services/sqlcipherService.js");
    /* isSqlcipherReady 가드 — 미초기화 시 에러 응답 반환 */
    if (!isSqlcipherReady()) {
      return errorResponse("SQLCipher가 초기화되지 않았습니다. ZIME_ENCRYPTION_KEY 환경변수를 확인하세요.");
    }
    const results = searchSecrets({
      query: args.query,
      tags: args.tags,
      limit: args.limit,
    });

    return jsonResponse({
      query: args.query,
      store: "secrets",
      resultCount: results.length,
      results: results.map((s) => ({
        id: s.id,
        name: s.name,
        secretType: s.secretType,
        service: s.service,
        tags: s.tags,
        notes: s.notes,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
    } as Record<string, unknown>);
  }

  // ─── general/images/files store 검색 (Qdrant) ───
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

  const results = await searchQdrant({
    query: args.query,
    store: args.store as "general" | "images" | "files",
    limit: args.limit,
    filterOptions,
    scoreThreshold: args.scoreThreshold,
  });

  const formatted = results.map((r) => {
    const payload = r.payload as Record<string, unknown> | null;
    return {
      id: r.id,
      score: Math.round(r.score * 1000) / 1000,
      store: r.store,
      title: payload?.title || payload?.originalName || "(제목 없음)",
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
      presignedUrl: r.presignedUrl,
    };
  });

  formatted.sort((a, b) => {
    const aPinned = a.pinned ? 1 : 0;
    const bPinned = b.pinned ? 1 : 0;
    return bPinned - aPinned;
  });

  return jsonResponse({
    query: args.query,
    store: args.store,
    resultCount: formatted.length,
    results: formatted,
  } as Record<string, unknown>);
}
