/**
 * Qdrant 벡터 데이터베이스 서비스
 * 컬렉션 관리, 메모리 저장/검색/삭제 등 Qdrant 조작을 담당한다.
 */

import { QdrantClient } from "@qdrant/js-client-rest";
import { config } from "../config.js";
import { getEmbeddingDimensions } from "./embeddingService.js";
import { info, error as logError } from "../utils/logger.js";
import type { MemoryPayload } from "../types/index.js";

/** Qdrant 클라이언트 싱글턴 인스턴스 */
const client = new QdrantClient({
  url: config.qdrant.url,
  apiKey: config.qdrant.apiKey,
});

/**
 * 카테고리/태그/우선순위/상태/날짜 범위/고정 필터 옵션 타입
 */
export interface FilterOptions {
  category?: string;
  tags?: string[];
  priority?: string;
  /** 메모리 상태 필터 (published 또는 draft) */
  status?: string;
  /** 생성일 시작 범위 (ISO 8601) */
  fromDate?: string;
  /** 생성일 종료 범위 (ISO 8601) */
  toDate?: string;
  /** 고정 메모리 필터 (true: 고정된 메모리만, false: 고정되지 않은 메모리만) */
  pinned?: boolean;
  /** 저장소 타입 필터 (general, images, files) */
  store?: string;
}

/**
 * Qdrant SDK의 filter 파라미터 타입.
 * @qdrant/js-client-rest의 filter 타입이 내부적으로 복잡한 제네릭 구조여서
 * 직접 참조가 어렵다. 최상위 buildFilter에서만 한 번 캐스팅하고
 * 호출부에서는 이 타입을 그대로 사용하여 중복 as any를 제거한다.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QdrantFilter = any;

/**
 * FilterOptions에서 Qdrant 필터 객체를 생성한다.
 * 각 조건은 must 배열에 추가되어 AND 조건으로 결합된다.
 */
export function buildFilter(options: FilterOptions & { includeDeleted?: boolean } = {}): QdrantFilter {
  const must: object[] = [];
  const must_not: object[] = [];

  /* soft-delete된 항목 기본 제외 */
  if (!options.includeDeleted) {
    must_not.push({ key: "deletedAt", range: { gte: "1970-01-01T00:00:00Z" } });
  }

  if (options.category) {
    must.push({
      key: "category",
      match: { value: options.category },
    });
  }

  if (options.tags && options.tags.length > 0) {
    must.push({
      key: "tags",
      match: { any: options.tags },
    });
  }

  if (options.priority) {
    must.push({
      key: "priority",
      match: { value: options.priority },
    });
  }

  if (options.status) {
    must.push({
      key: "status",
      match: { value: options.status },
    });
  }

  if (options.fromDate) {
    must.push({
      key: "createdAt",
      range: { gte: options.fromDate },
    });
  }

  if (options.toDate) {
    must.push({
      key: "createdAt",
      range: { lte: options.toDate },
    });
  }

  if (options.pinned !== undefined) {
    must.push({
      key: "pinned",
      match: { value: options.pinned },
    });
  }

  if (options.store) {
    must.push({
      key: "store",
      match: { value: options.store },
    });
  }

  if (must.length === 0 && must_not.length === 0) {
    return undefined;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filter: Record<string, object[]> = {};
  if (must.length > 0) filter.must = must;
  if (must_not.length > 0) filter.must_not = must_not;
  // buildFilter 반환 타입이 QdrantFilter(any)이므로 호출부에서 추가 캐스팅 불필요
  return filter;
}

/**
 * "memories" 컬렉션이 없으면 생성하고, 페이로드 인덱스를 설정한다.
 * 벡터 차원은 768, 거리 함수는 Cosine을 사용한다.
 */
export async function ensureCollection(): Promise<void> {
  const name = config.qdrant.collectionName;

  try {
    const collections = await client.getCollections();
    const exists = collections.collections.some((c) => c.name === name);

    if (!exists) {
      info(`컬렉션 "${name}" 생성 중...`);
      await client.createCollection(name, {
        vectors: {
          size: getEmbeddingDimensions(),
          distance: "Cosine",
        },
      });

      // 페이로드 필드에 키워드 인덱스 생성
      await client.createPayloadIndex(name, {
        field_name: "category",
        field_schema: "keyword",
      });
      await client.createPayloadIndex(name, {
        field_name: "priority",
        field_schema: "keyword",
      });
      await client.createPayloadIndex(name, {
        field_name: "tags",
        field_schema: "keyword",
      });
      await client.createPayloadIndex(name, {
        field_name: "status",
        field_schema: "keyword",
      });
      await client.createPayloadIndex(name, {
        field_name: "expiresAt",
        field_schema: "keyword",
      });
      // Phase 3 호환: pinned 필드 인덱스
      await client.createPayloadIndex(name, {
        field_name: "pinned",
        field_schema: "keyword",
      });
      // Phase 4 호환: parentId 필드 인덱스
      await client.createPayloadIndex(name, {
        field_name: "parentId",
        field_schema: "keyword",
      });
      // Multi-store: store 필드 인덱스 (general/images/files 라우팅)
      await client.createPayloadIndex(name, {
        field_name: "store",
        field_schema: "keyword",
      });
      // Soft-delete: deletedAt 필드 인덱스
      await client.createPayloadIndex(name, {
        field_name: "deletedAt",
        field_schema: "keyword",
      });

      info(`컬렉션 "${name}" 생성 완료`);
    } else {
      // 기존 컬렉션의 벡터 차원이 현재 모델 차원과 다른지 확인한다
      const collectionInfo = await client.getCollection(name);
      const vectorsParam = collectionInfo.config?.params?.vectors;
      const existingSize =
        vectorsParam !== null &&
        typeof vectorsParam === "object" &&
        !Array.isArray(vectorsParam)
          ? (vectorsParam as { size?: number }).size
          : undefined;

      if (existingSize !== undefined && existingSize !== getEmbeddingDimensions()) {
        info(
          `경고: 컬렉션 벡터 차원(${existingSize})과 현재 모델 차원(${getEmbeddingDimensions()})이 다릅니다. memory_reindex를 실행하세요.`
        );
      } else {
        info(`컬렉션 "${name}" 이미 존재함`);
        // 기존 컬렉션에 store 인덱스가 없을 수 있으므로 추가 시도
        try {
          await client.createPayloadIndex(name, {
            field_name: "store",
            field_schema: "keyword",
          });
          info(`컬렉션 "${name}"에 store 인덱스 추가됨`);
        } catch {
          // 이미 인덱스가 존재하면 무시
        }
      }
    }
  } catch (err) {
    logError("컬렉션 초기화 실패:", err);
    throw err;
  }
}

/**
 * 컬렉션의 현재 벡터 차원 수를 반환한다.
 * 프로바이더 전환 시 차원 불일치 감지에 사용한다.
 *
 * @returns 벡터 차원 수 (확인 불가 시 undefined)
 */
export async function getCollectionDimensions(): Promise<number | undefined> {
  const collectionInfo = await client.getCollection(config.qdrant.collectionName);
  const vectorsParam = collectionInfo.config?.params?.vectors;
  if (
    vectorsParam !== null &&
    typeof vectorsParam === "object" &&
    !Array.isArray(vectorsParam)
  ) {
    return (vectorsParam as { size?: number }).size;
  }
  return undefined;
}

/**
 * 컬렉션을 삭제하고 새 차원으로 재생성한다.
 * 프로바이더 전환 시 벡터 차원이 변경될 때 사용한다.
 * 주의: 기존 데이터가 모두 삭제되므로 재인덱싱과 함께 사용해야 한다.
 *
 * @param newDimensions - 새 벡터 차원 수
 */
export async function recreateCollection(newDimensions: number): Promise<void> {
  const name = config.qdrant.collectionName;

  // 기존 데이터를 메모리에 백업 (페이로드만)
  const allPayloads: Array<{ id: string; payload: Record<string, unknown> }> = [];
  let offset: string | undefined = undefined;
  while (true) {
    const batch = await client.scroll(name, {
      limit: 100,
      offset: offset ? offset : undefined,
      with_payload: true,
    });
    for (const point of batch.points) {
      allPayloads.push({
        id: String(point.id),
        payload: point.payload as Record<string, unknown>,
      });
    }
    if (!batch.next_page_offset) break;
    offset = String(batch.next_page_offset);
  }

  info(`[RECREATE] ${allPayloads.length}건의 페이로드를 백업 완료`);

  // 컬렉션 삭제 후 새 차원으로 재생성
  await client.deleteCollection(name);
  await client.createCollection(name, {
    vectors: { size: newDimensions, distance: "Cosine" },
  });

  // 페이로드 인덱스 재생성
  const indexFields = [
    "category", "priority", "tags", "status", "expiresAt",
    "pinned", "parentId", "store", "deletedAt",
  ];
  for (const field of indexFields) {
    await client.createPayloadIndex(name, {
      field_name: field,
      field_schema: "keyword",
    });
  }

  // 백업한 페이로드를 제로 벡터로 임시 저장 (재인덱싱에서 실제 벡터 생성)
  const zeroVector = new Array(newDimensions).fill(0);
  for (let i = 0; i < allPayloads.length; i += 100) {
    const batch = allPayloads.slice(i, i + 100);
    await client.upsert(name, {
      wait: true,
      points: batch.map((p) => ({
        id: p.id,
        vector: zeroVector,
        payload: p.payload,
      })),
    });
  }

  info(`[RECREATE] 컬렉션 재생성 완료 (${newDimensions}차원, ${allPayloads.length}건 페이로드 복원)`);
}

/**
 * 메모리를 Qdrant에 저장(upsert)한다.
 *
 * @param id - 메모리 고유 ID (UUID)
 * @param vector - 임베딩 벡터
 * @param payload - 메모리 페이로드 데이터
 */
export async function upsertMemory(
  id: string,
  vector: number[],
  payload: MemoryPayload
): Promise<void> {
  // 방어: upsert는 전체 교체이므로 필수 필드 기본값 보장
  if (!payload.store) {
    payload.store = "general";
  }
  if (!payload.status) {
    payload.status = "published";
  }
  await client.upsert(config.qdrant.collectionName, {
    wait: true,
    points: [
      {
        id,
        vector,
        payload: payload as unknown as Record<string, unknown>,
      },
    ],
  });
}

/**
 * 벡터 유사도 기반으로 메모리를 검색한다.
 *
 * @param vector - 검색 쿼리의 임베딩 벡터
 * @param limit - 반환할 최대 결과 수
 * @param filterOptions - 카테고리/태그/우선순위 필터 (선택)
 * @param scoreThreshold - 최소 유사도 점수 (선택)
 * @returns 검색 결과 배열 (점수, 페이로드 포함)
 */
export async function searchMemories(
  vector: number[],
  limit: number,
  filterOptions?: FilterOptions,
  scoreThreshold?: number
): Promise<
  Array<{
    id: string | number;
    score: number;
    payload: Record<string, unknown> | null | undefined;
  }>
> {
  // off 모드: 벡터 유사도 검색 대신 scroll+filter 기반 키워드 검색
  if (config.embedding.provider === "off") {
    const filter = filterOptions ? buildFilter(filterOptions) : undefined;
    const scrollResult = await client.scroll(config.qdrant.collectionName, {
      filter,
      limit,
      with_payload: true,
    });
    return scrollResult.points.map((p) => ({
      id: p.id,
      score: 0,
      payload: p.payload,
    }));
  }

  const filter = filterOptions ? buildFilter(filterOptions) : undefined;

  const results = await client.search(config.qdrant.collectionName, {
    vector,
    limit,
    filter: filter,
    score_threshold: scoreThreshold,
    with_payload: true,
  });

  return results.map((r) => ({
    id: r.id,
    score: r.score,
    payload: r.payload,
  }));
}

/**
 * 필터 조건으로 메모리 목록을 스크롤(페이지네이션)한다.
 * 벡터 검색 없이 페이로드 필터만으로 조회할 때 사용한다.
 *
 * @param filterOptions - 카테고리/태그/우선순위 필터 (선택)
 * @param limit - 반환할 최대 결과 수
 * @param offset - 스크롤 커서 (이전 응답의 next_page_offset, 첫 페이지는 undefined)
 * @returns 포인트 목록과 다음 페이지 오프셋
 */
export async function scrollMemories(
  filterOptions?: FilterOptions,
  limit: number = 20,
  offset?: string
): Promise<{
  points: Array<{
    id: string | number;
    payload: Record<string, unknown> | null | undefined;
  }>;
  nextOffset: string | number | null | undefined;
}> {
  const filter = filterOptions ? buildFilter(filterOptions) : undefined;

  const result = await client.scroll(config.qdrant.collectionName, {
    filter: filter,
    limit,
    offset: offset || undefined,
    with_payload: true,
  });

  // next_page_offset이 Record 타입일 수 있으므로 string/number만 추출한다
  const rawOffset = result.next_page_offset;
  const nextOffset =
    typeof rawOffset === "string" || typeof rawOffset === "number"
      ? rawOffset
      : rawOffset != null
        ? String(rawOffset)
        : null;

  return {
    points: result.points.map((p) => ({
      id: p.id,
      payload: p.payload,
    })),
    nextOffset,
  };
}

/**
 * ID로 메��리를 soft-delete 처리한다.
 * Qdrant 포인트를 삭제하지 않고 deletedAt 페이로드를 설정한다.
 *
 * @param id - soft-delete할 메모리의 UUID
 */
/**
 * 특정 필드만 부분 업데이트한다 (벡터 재생성 없이).
 * upsertMemory와 달리 지정한 필드만 변경하고 나머지 payload는 유지한다.
 */
export async function setMemoryPayload(
  id: string,
  payload: Record<string, unknown>
): Promise<void> {
  await client.setPayload(config.qdrant.collectionName, {
    payload,
    points: [id],
  });
}

export async function deleteMemory(id: string): Promise<void> {
  const now = new Date().toISOString();
  await client.setPayload(config.qdrant.collectionName, {
    payload: { deletedAt: now },
    points: [id],
  });
}

/**
 * soft-delete된 메모리를 복원한다.
 * deletedAt 페이로드 키를 제거한다.
 */
export async function restoreMemory(id: string): Promise<void> {
  await client.deletePayload(config.qdrant.collectionName, {
    keys: ["deletedAt"],
    points: [id],
  });
}

/**
 * ID로 메모리를 영구 삭제한다 (hard delete).
 * soft-delete 이후 보존 기간이 지난 항목에만 사용한다.
 */
export async function hardDeleteMemory(id: string): Promise<void> {
  await client.delete(config.qdrant.collectionName, {
    wait: true,
    points: [id],
  });
}

/**
 * 보존 기간이 지난 soft-delete 항목을 일괄 영구 삭제한다.
 * @param retentionDays - 보존 기간 (일)
 */
export async function purgeExpiredQdrantDeletes(retentionDays: number = 30): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  let totalPurged = 0;

  /* soft-delete된 항목 중 보존 기간 초과한 것을 반복 조회/삭제 */
  while (true) {
    // QdrantFilter(any)로 타입 지정 — Qdrant SDK filter 타입이 복잡한 제네릭 구조여서 직접 할당 불가
    const expiredFilter: QdrantFilter = {
      must: [{ key: "deletedAt", range: { lt: cutoff } }],
    };
    const result = await client.scroll(config.qdrant.collectionName, {
      filter: expiredFilter,
      limit: 100,
      with_payload: false,
    });

    if (result.points.length === 0) break;

    const ids = result.points.map(p => p.id);
    await client.delete(config.qdrant.collectionName, {
      wait: true,
      points: ids as string[],
    });

    totalPurged += ids.length;
  }

  if (totalPurged > 0) {
    info(`만료된 soft-delete Qdrant 포인트 ${totalPurged}건 영구 삭제됨`);
  }
  return totalPurged;
}

/**
 * 컬렉션의 상태 정보(포인트 수, 인덱싱 상태 등)를 반환한다.
 */
export async function getCollectionInfo(): Promise<{
  pointsCount: number;
  status: string;
  segmentsCount: number;
}> {
  const info = await client.getCollection(config.qdrant.collectionName);

  return {
    pointsCount: info.points_count ?? 0,
    status: info.status,
    segmentsCount: info.segments_count ?? 0,
  };
}

/**
 * ID로 단일 메모리를 조회한다.
 * client.retrieve()를 사용하여 특정 포인트를 가져온다.
 *
 * @param id - 조회할 메모리의 UUID
 * @param withVector - 벡터 포함 여부 (기본값: false)
 * @returns 포인트 정보 또는 null (존재하지 않을 경우)
 */
export async function getMemoryById(
  id: string,
  withVector?: boolean,
  includeDeleted?: boolean
): Promise<{
  id: string | number;
  payload: Record<string, unknown> | null | undefined;
  vector?: number[];
} | null> {
  const results = await client.retrieve(config.qdrant.collectionName, {
    ids: [id],
    with_payload: true,
    with_vector: withVector ?? false,
  });

  if (results.length === 0) {
    return null;
  }

  const point = results[0];
  /* soft-delete된 포인트는 기본적으로 반환하지 않는다 */
  if (!includeDeleted && (point.payload as Record<string, unknown>)?.deletedAt) {
    return null;
  }
  return {
    id: point.id,
    payload: point.payload as Record<string, unknown> | null | undefined,
    vector: withVector ? (point.vector as number[] | undefined) : undefined,
  };
}

/**
 * 필터 조건에 해당하는 메모리 수를 반환한다.
 * client.count()를 사용하여 정확한 개수를 조회한다.
 *
 * @param filterOptions - 카테고리/태그/우선순위 필터 (선택)
 * @returns 매칭되는 포인트 수
 */
export async function countByFilter(
  filterOptions?: FilterOptions
): Promise<number> {
  const filter = filterOptions ? buildFilter(filterOptions) : undefined;

  const result = await client.count(config.qdrant.collectionName, {
    filter: filter,
    exact: true,
  });

  return result.count;
}

/**
 * 필터 조건에 해당하는 메모리를 일괄 삭제한다.
 * 포인트 ID가 아닌 필터 셀렉터를 사용하여 삭제한다.
 *
 * @param filterOptions - 카테고리/태그/우선순위 필터 (최소 하나 필수)
 */
export async function deleteByFilter(
  filterOptions: FilterOptions
): Promise<void> {
  const filter = buildFilter(filterOptions);

  if (!filter) {
    throw new Error("삭제 필터가 비어있습니다. 최소 하나의 필터 조건이 필요합니다.");
  }

  await client.delete(config.qdrant.collectionName, {
    wait: true,
    filter: filter,
  });
}

/**
 * 만료된 draft 메모리를 일괄 삭제한다.
 * expiresAt이 현재 시각보다 이전인 draft 상태의 메모리를 제거한다.
 *
 * @returns 삭제 완료 여부
 */
export async function deleteExpiredDrafts(): Promise<void> {
  const now = new Date().toISOString();

  const filter = {
    must: [
      { key: "status", match: { value: "draft" } },
      { key: "expiresAt", range: { lt: now } },
    ],
  };

  await client.delete(config.qdrant.collectionName, {
    wait: true,
    filter: filter,
  });
}
