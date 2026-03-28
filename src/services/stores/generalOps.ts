/**
 * general store 연산
 * Qdrant 벡터 DB에 일반 메모리를 저장하고 검색한다.
 */

import { v4 as uuidv4 } from "uuid";
import { generateEmbedding } from "../embeddingService.js";
import {
  upsertMemory,
  searchMemories,
  getMemoryById,
} from "../qdrantService.js";
import type { FilterOptions } from "../qdrantService.js";
import {
  getPresignedUrl,
  isMinioReady,
} from "../minioService.js";
import { isOnline } from "../connectionMonitor.js";
import { config } from "../../config.js";
import type { MemoryPayload, MemoryStore, RouteResult } from "../../types/index.js";

/** general store 저장 — 기존 Qdrant 동작 */
export async function saveGeneral(args: {
  id?: string;
  content: string;
  title?: string;
  tags: string[];
  category: string;
  priority: string;
  source?: string;
  status?: string;
  ttl?: string;
  expiresAt?: string;
  pinned?: boolean;
  parentId?: string;
  relatedIds?: string[];
  /** 사전 계산된 임베딩 벡터 (제공 시 재생성 생략) */
  precomputedVector?: number[];
}): Promise<RouteResult> {
  /* 오프라인 시 쓰기 차단 */
  if (config.cache.enabled && !isOnline()) {
    throw new Error("오프라인 모드에서는 저장 작업을 수행할 수 없습니다. SSH 터널 연결을 확인하세요.");
  }

  const id = args.id || uuidv4();
  const now = new Date().toISOString();
  /* CRITICAL fix: 호출자가 벡터를 제공하면 재생성하지 않는다 */
  const vector = args.precomputedVector ??
    await generateEmbedding(args.title ? `${args.title}\n\n${args.content}` : args.content);

  const payload: MemoryPayload = {
    content: args.content,
    title: args.title,
    tags: args.tags,
    category: args.category as MemoryPayload["category"],
    priority: args.priority as MemoryPayload["priority"],
    source: args.source,
    status: (args.status as "published" | "draft") || "published",
    ttl: args.ttl,
    expiresAt: args.expiresAt,
    pinned: args.pinned,
    parentId: args.parentId,
    relatedIds: args.relatedIds,
    createdAt: now,
    updatedAt: now,
    store: "general",
  };

  await upsertMemory(id, vector, payload);
  return { id, store: "general" };
}

/** Qdrant 벡터 검색 (general/images/files) */
export async function searchQdrant(args: {
  query: string;
  store?: MemoryStore;
  limit: number;
  filterOptions?: FilterOptions;
  scoreThreshold?: number;
}): Promise<
  Array<{
    id: string | number;
    score: number;
    store: string;
    payload: Record<string, unknown> | null | undefined;
    presignedUrl?: string;
    _fromCache?: boolean;
  }>
> {
  /* 오프라인 + 캐시 활성 → 캐시에서 검색 */
  if (config.cache.enabled && !isOnline()) {
    const { getCachedSearch, getCachedList } = await import("../cacheService.js");
    const cached = getCachedSearch(args.query);
    if (cached) return cached.map((r) => ({ ...r, score: r.score ?? 0, payload: r.payload ?? null }));
    return getCachedList(args.store, args.limit).map((r) => ({ ...r, score: 0, payload: r.payload ?? null }));
  }

  const vector = await generateEmbedding(args.query);

  /* store 필터 추가 — general 포함 모든 store에 필터 적용 (C5 fix) */
  const filters: FilterOptions = { ...args.filterOptions };
  filters.store = args.store || "general";

  const results = await searchMemories(vector, args.limit, filters, args.scoreThreshold);

  /* images/files인 경우 presigned URL 첨부 */
  const enriched = await Promise.all(
    results.map(async (r) => {
      const payload = r.payload as Record<string, unknown> | undefined;
      const resultStore = (payload?.store as string) || "general";
      let presignedUrl: string | undefined;

      if (
        (resultStore === "images" || resultStore === "files") &&
        payload?.objectKey &&
        payload?.bucket
      ) {
        try {
          presignedUrl = await getPresignedUrl(
            payload.bucket as string,
            payload.objectKey as string,
          );
        } catch {
          /* presigned URL 생성 실패는 무시 — 메타데이터만 반환 */
        }
      }

      return {
        id: r.id,
        score: r.score,
        store: resultStore,
        payload: r.payload,
        presignedUrl,
      };
    }),
  );

  /* 온라인 + 캐시 활성 → 결과를 캐시에 저장 */
  if (config.cache.enabled && enriched.length > 0) {
    const { cacheSearchResults, cacheMemory } = await import("../cacheService.js");
    cacheSearchResults(args.query, enriched);
    for (const r of enriched) {
      if (r.payload && r.id) {
        cacheMemory(String(r.id), r.store, r.payload as Record<string, unknown>);
      }
    }
  }

  return enriched;
}
