/**
 * 읽기 캐시 서비스
 * 온라인 시 검색/조회 결과를 로컬 SQLite DB에 캐싱하여 오프라인 폴백을 제공한다.
 * better-sqlite3 사용 (SQLCipher와 동일 패키지, 추가 의존성 없음).
 * CACHE_ENABLED=false이면 모든 함수가 no-op 동작한다.
 */

import Database from "better-sqlite3";
import { createHash } from "crypto";
import { existsSync, statSync } from "fs";
import { dirname } from "path";
import { mkdirSync } from "fs";

import { config } from "../config.js";
import { info, error as logError } from "../utils/logger.js";

/** 캐시 DB 인스턴스 (암호화 없음 — 민감 데이터는 secrets store에서 관리) */
let db: Database.Database | null = null;

/**
 * 캐시 DB를 초기화한다.
 * 테이블이 없으면 생성하고, 인덱스를 설정한다.
 */
export function initCache(): void {
  if (!config.cache.enabled) return;

  const dbDir = dirname(config.cache.dbPath);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(config.cache.dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_cache (
      id TEXT PRIMARY KEY,
      store TEXT NOT NULL,
      payload TEXT NOT NULL,
      cached_at TEXT NOT NULL,
      last_accessed TEXT NOT NULL,
      access_count INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS search_cache (
      query_hash TEXT PRIMARY KEY,
      query_text TEXT NOT NULL,
      results TEXT NOT NULL,
      result_count INTEGER NOT NULL,
      cached_at TEXT NOT NULL,
      last_accessed TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cache_store ON memory_cache(store);
    CREATE INDEX IF NOT EXISTS idx_cache_accessed ON memory_cache(last_accessed);
    CREATE INDEX IF NOT EXISTS idx_search_accessed ON search_cache(last_accessed);
  `);

  info("[CACHE] DB 초기화 완료");
}

/**
 * 캐시 DB를 닫는다. 서버 종료 시 호출한다.
 */
export function closeCache(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ─────────────────────────────────────────────
// 개별 메모리 캐시
// ─────────────────────────────────────────────

/**
 * 개별 메모리를 캐시에 저장한다.
 * 이미 존재하면 페이로드와 접근 시각을 갱신한다.
 */
export function cacheMemory(
  id: string,
  store: string,
  payload: Record<string, unknown>,
): void {
  if (!db) return;

  const now = new Date().toISOString();
  const payloadJson = JSON.stringify(payload);

  db.prepare(`
    INSERT INTO memory_cache (id, store, payload, cached_at, last_accessed, access_count)
    VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      payload = excluded.payload,
      last_accessed = excluded.last_accessed,
      access_count = access_count + 1
  `).run(id, store, payloadJson, now, now);
}

/**
 * 캐시에서 개별 메모리를 조회한다.
 * 조회 시 last_accessed를 갱신한다.
 */
export function getCachedMemory(
  id: string,
): { store: string; payload: Record<string, unknown> } | null {
  if (!db) return null;

  const row = db.prepare(
    "SELECT store, payload FROM memory_cache WHERE id = ?",
  ).get(id) as { store: string; payload: string } | undefined;

  if (!row) return null;

  /* 접근 시각 갱신 */
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE memory_cache SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?",
  ).run(now, id);

  return {
    store: row.store,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  };
}

// ─────────────────────────────────────────────
// 검색 결과 캐시
// ─────────────────────────────────────────────

/** 쿼리 문자열을 SHA-256 해시로 변환한다 */
function hashQuery(query: string): string {
  return createHash("sha256").update(query.trim().toLowerCase()).digest("hex");
}

/**
 * 검색 결과를 캐시에 저장한다.
 */
export function cacheSearchResults(
  query: string,
  results: Array<{
    id: string | number;
    score: number | null;
    store: string;
    payload?: Record<string, unknown> | null;
    [key: string]: unknown;
  }>,
): void {
  if (!db || results.length === 0) return;

  const now = new Date().toISOString();
  const queryHash = hashQuery(query);
  const resultsJson = JSON.stringify(results);

  db.prepare(`
    INSERT INTO search_cache (query_hash, query_text, results, result_count, cached_at, last_accessed)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(query_hash) DO UPDATE SET
      results = excluded.results,
      result_count = excluded.result_count,
      cached_at = excluded.cached_at,
      last_accessed = excluded.last_accessed
  `).run(queryHash, query, resultsJson, results.length, now, now);
}

/**
 * 캐시에서 검색 결과를 조회한다.
 * 쿼리를 정규화(trim + lowercase)하여 해시 매칭한다.
 */
export function getCachedSearch(
  query: string,
): Array<{
  id: string | number;
  score: number | null;
  store: string;
  payload?: Record<string, unknown> | null;
  _fromCache?: boolean;
}> | null {
  if (!db) return null;

  const queryHash = hashQuery(query);
  const row = db.prepare(
    "SELECT results FROM search_cache WHERE query_hash = ?",
  ).get(queryHash) as { results: string } | undefined;

  if (!row) return null;

  /* 접근 시각 갱신 */
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE search_cache SET last_accessed = ? WHERE query_hash = ?",
  ).run(now, queryHash);

  const results = JSON.parse(row.results) as Array<{
    id: string | number;
    score: number | null;
    store: string;
    payload?: Record<string, unknown> | null;
  }>;

  return results.map((r) => ({ ...r, _fromCache: true }));
}

// ─────────────────────────────────────────────
// 캐시 목록 (오프라인 폴백)
// ─────────────────────────────────────────────

/**
 * 캐시된 메모리 목록을 반환한다.
 * 오프라인 시 검색 캐시 미스인 경우 최근 캐시된 메모리를 반환한다.
 */
export function getCachedList(
  store?: string,
  limit: number = 20,
): Array<{
  id: string;
  score: null;
  store: string;
  matchType: "cache";
  payload: Record<string, unknown>;
  _fromCache: boolean;
}> {
  if (!db) return [];

  const query = store
    ? "SELECT id, store, payload FROM memory_cache WHERE store = ? ORDER BY last_accessed DESC LIMIT ?"
    : "SELECT id, store, payload FROM memory_cache ORDER BY last_accessed DESC LIMIT ?";

  const rows = store
    ? (db.prepare(query).all(store, limit) as Array<{ id: string; store: string; payload: string }>)
    : (db.prepare(query).all(limit) as Array<{ id: string; store: string; payload: string }>);

  return rows.map((row) => ({
    id: row.id,
    score: null,
    store: row.store,
    matchType: "cache" as const,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    _fromCache: true,
  }));
}

// ─────────────────────────────────────────────
// 캐시 관리
// ─────────────────────────────────────────────

/**
 * 오래된 캐시 항목을 정리한다.
 * maxAgeDays 초과 항목과 maxEntries 초과 항목을 삭제한다.
 *
 * @returns 삭제된 항목 수
 */
export function pruneCache(
  maxAgeDays: number = config.cache.maxAgeDays,
  maxEntries: number = config.cache.maxEntries,
): number {
  if (!db) return 0;

  let totalPruned = 0;
  const cutoff = new Date(
    Date.now() - maxAgeDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  /* TTL 기반 삭제 */
  const memoryResult = db.prepare(
    "DELETE FROM memory_cache WHERE last_accessed < ?",
  ).run(cutoff);
  totalPruned += memoryResult.changes;

  const searchResult = db.prepare(
    "DELETE FROM search_cache WHERE last_accessed < ?",
  ).run(cutoff);
  totalPruned += searchResult.changes;

  /* 항목 수 제한 (memory_cache) */
  const memoryCount = (
    db.prepare("SELECT COUNT(*) as cnt FROM memory_cache").get() as { cnt: number }
  ).cnt;
  if (memoryCount > maxEntries) {
    const overflow = memoryCount - maxEntries;
    const overflowResult = db.prepare(`
      DELETE FROM memory_cache WHERE id IN (
        SELECT id FROM memory_cache ORDER BY last_accessed ASC LIMIT ?
      )
    `).run(overflow);
    totalPruned += overflowResult.changes;
  }

  /* 항목 수 제한 (search_cache — 메모리의 1/4) */
  const searchCount = (
    db.prepare("SELECT COUNT(*) as cnt FROM search_cache").get() as { cnt: number }
  ).cnt;
  const maxSearchEntries = Math.floor(maxEntries / 4);
  if (searchCount > maxSearchEntries) {
    const overflow = searchCount - maxSearchEntries;
    const overflowResult = db.prepare(`
      DELETE FROM search_cache WHERE query_hash IN (
        SELECT query_hash FROM search_cache ORDER BY last_accessed ASC LIMIT ?
      )
    `).run(overflow);
    totalPruned += overflowResult.changes;
  }

  return totalPruned;
}

/**
 * 캐시 통계를 반환한다.
 */
export function getCacheStats(): {
  memoryCount: number;
  searchCount: number;
  dbSizeBytes: number;
} {
  if (!db) {
    return { memoryCount: 0, searchCount: 0, dbSizeBytes: 0 };
  }

  const memoryCount = (
    db.prepare("SELECT COUNT(*) as cnt FROM memory_cache").get() as { cnt: number }
  ).cnt;

  const searchCount = (
    db.prepare("SELECT COUNT(*) as cnt FROM search_cache").get() as { cnt: number }
  ).cnt;

  let dbSizeBytes = 0;
  try {
    if (existsSync(config.cache.dbPath)) {
      dbSizeBytes = statSync(config.cache.dbPath).size;
    }
  } catch { /* 파일 접근 실패 무시 */ }

  return { memoryCount, searchCount, dbSizeBytes };
}
