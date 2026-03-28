/**
 * Store 라우팅 디스패처 (슬림 코디네이터)
 * store 파라미터에 따라 Qdrant, MinIO, SQLCipher로 요청을 분배한다.
 * 개별 store 연산은 stores/ 하위 파일에 위임한다.
 */

import { generateEmbedding } from "./embeddingService.js";
import {
  searchMemories,
  deleteMemory,
  getMemoryById,
  countByFilter,
  getCollectionInfo,
  upsertMemory,
} from "./qdrantService.js";
import type { FilterOptions } from "./qdrantService.js";
import {
  deleteObject as deleteMinioObject,
  getPresignedUrl,
  resolveBucket,
  getBucketUsage,
  isMinioReady,
} from "./minioService.js";
import {
  searchSecrets,
  getSecret,
  updateSecret,
  deleteSecret,
  countSecrets,
  isSqlcipherReady,
} from "./sqlcipherService.js";
import { isOnline } from "./connectionMonitor.js";
import {
  cacheMemory,
  getCachedMemory,
  cacheSearchResults,
  getCachedSearch,
  getCachedList,
} from "./cacheService.js";
import { config } from "../config.js";
import { info, error as logError } from "../utils/logger.js";
import type { MemoryPayload, MemoryStore, RouteResult } from "../types/index.js";

/** store 라우팅 결과의 공통 형태 — 하위 호환을 위해 re-export */
export type { RouteResult } from "../types/index.js";

// ─────────────────────────────────────────────
// Re-exports from store files
// ─────────────────────────────────────────────

export { saveGeneral, searchQdrant } from "./stores/generalOps.js";
export { saveFile } from "./stores/fileOps.js";
export { saveSecretEntry } from "./stores/secretOps.js";

// ─────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────

/** 크로스 스토어 검색 — Qdrant + SQLCipher 병렬 */
export async function searchAll(args: {
  query: string;
  limit: number;
  filterOptions?: FilterOptions;
  scoreThreshold?: number;
}): Promise<
  Array<{
    id: string | number;
    score: number | null;
    store: string;
    matchType: "vector" | "keyword" | "cache";
    payload?: Record<string, unknown> | null;
    presignedUrl?: string;
    _fromCache?: boolean;
  }>
> {
  /* 오프라인 + 캐시 활성 → 캐시에서 검색 */
  if (config.cache.enabled && !isOnline()) {
    const cached = getCachedSearch(args.query);
    if (cached) return cached.map((r) => ({ ...r, matchType: "cache" as const }));
    return getCachedList(args.filterOptions?.store, args.limit);
  }

  /* Qdrant(general+images+files) + SQLCipher(secrets) 병렬 실행 */
  const [qdrantResults, secretResults] = await Promise.all([
    (async () => {
      const vector = await generateEmbedding(args.query);
      /* store 필터 없이 모든 Qdrant 데이터 검색 */
      const results = await searchMemories(
        vector,
        args.limit,
        args.filterOptions,
        args.scoreThreshold,
      );

      return Promise.all(
        results.map(async (r) => {
          const payload = r.payload as Record<string, unknown> | undefined;
          const store = (payload?.store as string) || "general";
          let presignedUrl: string | undefined;

          if (
            isMinioReady() &&
            (store === "images" || store === "files") &&
            payload?.objectKey &&
            payload?.bucket
          ) {
            try {
              presignedUrl = await getPresignedUrl(
                payload.bucket as string,
                payload.objectKey as string,
              );
            } catch { /* presigned URL 생성 실패는 무시 — 메타데이터만 반환 */ }
          }

          return {
            id: r.id,
            score: r.score as number | null,
            store,
            matchType: "vector" as const,
            payload: r.payload,
            presignedUrl,
          };
        }),
      );
    })(),
    (async () => {
      /* isSqlcipherReady 가드 — 미초기화 또는 쿼리 실패 시 빈 배열 반환 */
      let secrets: import("../types/index.js").SecretRow[] = [];
      if (isSqlcipherReady()) {
        try {
          secrets = searchSecrets({ query: args.query, limit: args.limit });
        } catch {
          /* SQLCipher 쿼리 실패 시 secrets 결과 없이 진행 */
        }
      }
      return secrets.map((s) => ({
        id: s.id as string | number,
        score: null,
        store: "secrets",
        matchType: "keyword" as const,
        payload: {
          name: s.name,
          secretType: s.secretType,
          service: s.service,
          tags: s.tags,
          notes: s.notes,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        } as Record<string, unknown>,
        presignedUrl: undefined,
      }));
    })(),
  ]);

  /* score 기준 병합 (벡터 결과 우선, keyword 결과 뒤에) */
  const merged = [...qdrantResults, ...secretResults];
  merged.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

  const results = merged.slice(0, args.limit);

  /* 온라인 + 캐시 활성 → 결과를 캐시에 저장 */
  if (config.cache.enabled) {
    cacheSearchResults(args.query, results);
    for (const r of results) {
      if (r.payload && r.id) {
        cacheMemory(String(r.id), r.store, r.payload as Record<string, unknown>);
      }
    }
  }

  return results;
}

// ─────────────────────────────────────────────
// Get
// ─────────────────────────────────────────────

/** ID로 메모리를 조회한다. images/files는 presigned URL 포함 */
export async function getByStore(
  store: MemoryStore,
  id: string,
): Promise<{
  found: boolean;
  store: MemoryStore;
  data?: Record<string, unknown>;
  presignedUrl?: string;
  _fromCache?: boolean;
}> {
  /* 오프라인 + 캐시 활성 + secrets 아닌 경우 → 캐시에서 조회 */
  if (config.cache.enabled && !isOnline() && store !== "secrets") {
    const cached = getCachedMemory(id);
    if (cached) {
      return { found: true, store: cached.store as MemoryStore, data: cached.payload, _fromCache: true };
    }
    return { found: false, store };
  }

  if (store === "secrets") {
    /* isSqlcipherReady 가드 — 미초기화 시 found: false 반환 */
    if (!isSqlcipherReady()) return { found: false, store };
    const secret = getSecret(id);
    if (!secret) return { found: false, store };
    return { found: true, store, data: secret as unknown as Record<string, unknown> };
  }

  /* general/images/files — Qdrant 조회 */
  const result = await getMemoryById(id);
  if (!result) return { found: false, store };

  let presignedUrl: string | undefined;
  const payload = result.payload as Record<string, unknown> | undefined;

  if (
    (store === "images" || store === "files") &&
    payload?.objectKey &&
    payload?.bucket
  ) {
    try {
      presignedUrl = await getPresignedUrl(
        payload.bucket as string,
        payload.objectKey as string,
      );
    } catch { /* presigned URL 생성 실패는 무시 — 메타데이터만 반환 */ }
  }

  /* 온라인 + 캐시 활성 → 결과를 캐시에 저장 */
  if (config.cache.enabled && result.payload) {
    cacheMemory(id, store, result.payload as Record<string, unknown>);
  }

  return {
    found: true,
    store,
    data: result.payload as Record<string, unknown>,
    presignedUrl,
  };
}

// ─────────────────────────────────────────────
// Delete
// ─────────────────────────────────────────────

/** store별 삭제. images/files는 MinIO + Qdrant 동시 삭제 */
export async function deleteByStore(
  store: MemoryStore,
  id: string,
): Promise<boolean> {
  /* 오프라인 시 쓰기 차단 (secrets 제외 — 로컬 SQLCipher) */
  if (config.cache.enabled && !isOnline() && store !== "secrets") {
    throw new Error("오프라인 모드에서는 삭제 작업을 수행할 수 없습니다. SSH 터널 연결을 확인하세요.");
  }

  if (store === "secrets") {
    /* isSqlcipherReady 가드 — 미초기화 시 에러 throw */
    if (!isSqlcipherReady()) {
      throw new Error("SQLCipher가 초기화되지 않았습니다. ZIME_ENCRYPTION_KEY 환경변수를 확인하세요.");
    }
    return deleteSecret(id);
  }

  if (store === "images" || store === "files") {
    /* Qdrant에서 메타데이터 조회 후 MinIO 오브젝트도 삭제 */
    const existing = await getMemoryById(id);
    if (existing?.payload) {
      const payload = existing.payload as Record<string, unknown>;
      if (payload.objectKey && payload.bucket) {
        try {
          await deleteMinioObject(
            payload.bucket as string,
            payload.objectKey as string,
          );
        } catch (err) {
          logError(`MinIO 오브젝트 삭제 실패 (Object Lock일 수 있음): ${err}`);
        }
      }
    }
  }

  await deleteMemory(id);
  return true;
}

// ─────────────────────────────────────────────
// Update
// ─────────────────────────────────────────────

/** store별 수정. images/files는 description 변경 시 재임베딩 */
export async function updateByStore(
  store: MemoryStore,
  id: string,
  updates: Record<string, unknown>,
): Promise<boolean> {
  /* 오프라인 시 쓰기 차단 (secrets 제외 — 로컬 SQLCipher) */
  if (config.cache.enabled && !isOnline() && store !== "secrets") {
    throw new Error("오프라인 모드에서는 수정 작업을 수행할 수 없습니다. SSH 터널 연결을 확인하세요.");
  }

  if (store === "secrets") {
    /* isSqlcipherReady 가드 — 미초기화 시 에러 throw */
    if (!isSqlcipherReady()) {
      throw new Error("SQLCipher가 초기화되지 않았습니다. ZIME_ENCRYPTION_KEY 환경변수를 확인하세요.");
    }
    return updateSecret({
      id,
      name: updates.name as string | undefined,
      value: updates.value as string | undefined,
      secretType: updates.secretType as string | undefined,
      service: updates.service as string | undefined,
      tags: updates.tags as string[] | undefined,
      notes: updates.notes as string | undefined,
      expiresAt: updates.expiresAt as string | undefined,
    });
  }

  /* general/images/files — Qdrant 업데이트 */
  const existing = await getMemoryById(id, true);
  if (!existing) return false;

  const payload = { ...(existing.payload as Record<string, unknown>) } as unknown as MemoryPayload;
  const now = new Date().toISOString();

  /* 제공된 필드만 업데이트 */
  for (const [key, val] of Object.entries(updates)) {
    if (val !== undefined) {
      (payload as unknown as Record<string, unknown>)[key] = val;
    }
  }
  payload.updatedAt = now;

  /* description 또는 content 변경 시 재임베딩 */
  let vector = existing.vector as number[] | undefined;
  if (updates.content || updates.description || updates.title) {
    const embeddingText =
      store === "images" || store === "files"
        ? (payload.description || payload.content)
        : payload.title
          ? `${payload.title}\n\n${payload.content}`
          : payload.content;
    vector = await generateEmbedding(embeddingText);
  }

  if (!vector) {
    /* 벡터가 없으면 업데이트 불가 — 에러 처리 */
    throw new Error(`메모리 ${id}의 벡터를 찾을 수 없습니다. 재인덱싱이 필요할 수 있습니다.`);
  }

  await upsertMemory(id, vector, payload);
  return true;
}

// ─────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────

/** 전체 store 통합 통계 */
export async function getUnifiedStats(): Promise<{
  general: { pointsCount: number; status: string };
  images: { objectCount: number; totalSize: number };
  files: { objectCount: number; totalSize: number };
  secrets: { total: number; breakdown?: Record<string, number> };
  totalPoints: number;
}> {
  const qdrantInfo = await getCollectionInfo();

  /* MinIO/SQLCipher 미초기화 시 기본값 반환 — 서버 크래시 방지 */
  const defaultUsage = { objectCount: 0, totalSize: 0 };
  const defaultSecrets = { total: 0, breakdown: {} as Record<string, number> };

  const imagesUsage = isMinioReady()
    ? await getBucketUsage(resolveBucket("images")).catch(() => defaultUsage)
    : defaultUsage;
  const filesUsage = isMinioReady()
    ? await getBucketUsage(resolveBucket("files")).catch(() => defaultUsage)
    : defaultUsage;
  let secretsCount: { total: number; breakdown?: Record<string, number> } = defaultSecrets;
  if (isSqlcipherReady()) {
    try {
      secretsCount = countSecrets("secret_type");
    } catch (err) {
      logError("SQLCipher 통계 조회 실패:", err);
    }
  }

  return {
    general: { pointsCount: qdrantInfo.pointsCount, status: qdrantInfo.status },
    images: imagesUsage,
    files: filesUsage,
    secrets: secretsCount,
    totalPoints:
      qdrantInfo.pointsCount + imagesUsage.objectCount + filesUsage.objectCount + secretsCount.total,
  };
}
