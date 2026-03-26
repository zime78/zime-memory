/**
 * SQLCipher 암호화 데이터베이스 서비스
 * API 키, 토큰, 비밀번호 등 민감 정보를 AES-256 전체 DB 암호화로 저장한다.
 * better-sqlite3를 SQLCipher 빌드 플래그로 사용한다.
 */

import Database from "better-sqlite3-multiple-ciphers";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import { config } from "../config.js";
import { info, error as logError } from "../utils/logger.js";
import type { SecretRow, SecretType } from "../types/index.js";

/** SQLCipher DB 싱글턴 인스턴스 */
let _db: Database.Database;

/**
 * SQLCipher DB 인스턴스를 반환한다. 미초기화 시 에러를 throw한다.
 */
export function getDb(): Database.Database {
  if (!_db) throw new Error("SQLCipher DB가 초기화되지 않았습니다");
  return _db;
}

/** SQLCipher DB가 초기화되었는지 확인한다 */
export function isSqlcipherReady(): boolean {
  return _db != null;
}

/**
 * SQLCipher DB를 초기화하고 스키마를 생성한다.
 * ZIME_ENCRYPTION_KEY 환경변수가 설정되어 있어야 한다.
 */
export async function initSqlcipher(): Promise<void> {
  if (!config.sqlcipher.encryptionKey) {
    throw new Error(
      "secrets store를 사용하려면 ZIME_ENCRYPTION_KEY 환경변수를 설정하세요. " +
        "openssl rand -hex 32 명령으로 키를 생성할 수 있습니다.",
    );
  }

  /* data 디렉토리가 없으면 생성한다 */
  const dbDir = path.dirname(config.sqlcipher.dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const dbInstance = new Database(config.sqlcipher.dbPath);

  /* C1: 암호화 키 hex 형식 검증 — 인젝션 방지 */
  const key = config.sqlcipher.encryptionKey;
  if (!/^[0-9a-fA-F]{32,}$/.test(key)) {
    dbInstance.close();
    throw new Error(
      "ZIME_ENCRYPTION_KEY는 hex 문자열이어야 합니다 (openssl rand -hex 32 로 생성).",
    );
  }

  try {
    /* SQLCipher 권장 hex 키 형식으로 전달 */
    /* 주의: cipher pragma 생략 — DB가 라이브러리 기본 cipher로 생성되었으므로 명시하면 불일치 발생 */
    dbInstance.pragma(`key = "x'${key}'"`);
  } catch (err) {
    /* C3 fix: pragma 실패 시 db를 닫고 싱글턴을 null로 유지하여 isReady false 보장 */
    dbInstance.close();
    throw new Error(`SQLCipher 암호화 초기화 실패: ${err instanceof Error ? err.message : String(err)}`);
  }

  /* 키 검증 + 스키마 생성: 실제 쿼리로 복호화 성공을 확인한 후에만 싱글턴에 할당한다.
   * better-sqlite3-multiple-ciphers는 pragma key가 틀려도 throw하지 않으므로,
   * 실제 DB 조작(WAL, CREATE TABLE)에서 비로소 "file is not a database" 에러가 발생한다.
   * db 할당을 모든 초기화 완료 후로 이동하여 isSqlcipherReady() false positive를 방지한다. */
  try {
    /* WAL 모드 활성화 (성능 향상) */
    dbInstance.pragma("journal_mode = WAL");

    /* 스키마 생성 */
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS secrets (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        value       TEXT NOT NULL,
        secret_type TEXT NOT NULL DEFAULT 'api-key',
        service     TEXT,
        tags        TEXT DEFAULT '[]',
        notes       TEXT,
        expires_at  TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_secrets_type ON secrets(secret_type);
      CREATE INDEX IF NOT EXISTS idx_secrets_service ON secrets(service);
      CREATE INDEX IF NOT EXISTS idx_secrets_name ON secrets(name);
      CREATE INDEX IF NOT EXISTS idx_secrets_expires ON secrets(expires_at);
    `);

    /* 스키마 마이그레이션: soft delete 지원 */
    dbInstance.exec(`CREATE TABLE IF NOT EXISTS _schema_version (version INTEGER PRIMARY KEY);`);
    dbInstance.exec(`INSERT OR IGNORE INTO _schema_version VALUES (0);`);

    const versionRow = dbInstance.prepare("SELECT version FROM _schema_version ORDER BY version DESC LIMIT 1").get() as { version: number };
    if (versionRow.version < 1) {
      try {
        dbInstance.exec(`ALTER TABLE secrets ADD COLUMN deleted_at TEXT;`);
      } catch {
        /* 컬럼이 이미 존재하면 무시 */
      }
      try {
        dbInstance.exec(`CREATE INDEX IF NOT EXISTS idx_secrets_deleted ON secrets(deleted_at);`);
      } catch {
        /* 인덱스가 이미 존재하면 무시 */
      }
      dbInstance.exec(`UPDATE _schema_version SET version = 1;`);
      info("SQLCipher 스키마 마이그레이션 v1: soft delete 컬럼 추가");
    }
  } catch (err) {
    /* 키 불일치 또는 DB 손상 — db 싱글턴을 할당하지 않고 닫는다 */
    dbInstance.close();
    throw new Error(
      `SQLCipher DB 접근 실패 (키 불일치 또는 파일 손상): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  /* 모든 초기화 성공 후에만 싱글턴에 할당 — isReady() false positive 완전 방지 */
  _db = dbInstance;
  info("SQLCipher 데이터베이스 초기화 완료");
}

/** DB 행을 SecretRow로 변환한다 */
function rowToSecretRow(row: Record<string, unknown>): SecretRow {
  return {
    id: row.id as string,
    name: row.name as string,
    value: row.value as string,
    secretType: row.secret_type as SecretType,
    service: (row.service as string) || undefined,
    tags: JSON.parse((row.tags as string) || "[]"),
    notes: (row.notes as string) || undefined,
    expiresAt: (row.expires_at as string) || undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/**
 * 시크릿을 저장한다.
 * @returns 생성된 시크릿의 ID
 */
export function saveSecret(args: {
  id?: string;
  name: string;
  value: string;
  secretType: string;
  service?: string;
  tags?: string[];
  notes?: string;
  expiresAt?: string;
}): { id: string } {
  const id = args.id || uuidv4();
  const now = new Date().toISOString();

  const stmt = getDb().prepare(`
    INSERT INTO secrets (id, name, value, secret_type, service, tags, notes, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    args.name,
    args.value,
    args.secretType,
    args.service || null,
    JSON.stringify(args.tags || []),
    args.notes || null,
    args.expiresAt || null,
    now,
    now,
  );

  info(`시크릿 저장됨: ${args.name} (${id})`);
  return { id };
}

/**
 * 이름/서비스/메모에서 키워드로 시크릿을 검색한다.
 * SQL LIKE 패턴 매칭을 사용한다.
 */
export function searchSecrets(args: {
  query?: string;
  secretType?: string;
  service?: string;
  tags?: string[];
  limit?: number;
}): SecretRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (args.query) {
    /* H1: value 검색 제거 — 시크릿 값 노출 방지 */
    conditions.push(
      "(name LIKE ? OR service LIKE ? OR notes LIKE ?)",
    );
    const pattern = `%${args.query}%`;
    params.push(pattern, pattern, pattern);
  }

  if (args.secretType) {
    conditions.push("secret_type = ?");
    params.push(args.secretType);
  }

  if (args.service) {
    conditions.push("service = ?");
    params.push(args.service);
  }

  if (args.tags && args.tags.length > 0) {
    for (const tag of args.tags) {
      conditions.push("tags LIKE ?");
      /* M6: 태그 내 큰따옴표 이스케이프 — JSON 패턴 매칭 정확도 보장 */
      params.push(`%"${tag.replace(/"/g, '\\"')}"%`);
    }
  }

  /* soft-delete된 항목 제외 */
  conditions.push("deleted_at IS NULL");

  const where = `WHERE ${conditions.join(" AND ")}`;
  const limit = args.limit || 20;

  const stmt = getDb().prepare(
    `SELECT * FROM secrets ${where} ORDER BY updated_at DESC LIMIT ?`,
  );
  params.push(limit);

  const rows = stmt.all(...params) as Record<string, unknown>[];
  return rows.map(rowToSecretRow);
}

/**
 * ID로 시크릿을 조회한다.
 * @returns 시크릿 또는 null
 */
export function getSecret(id: string): SecretRow | null {
  const stmt = getDb().prepare("SELECT * FROM secrets WHERE id = ? AND deleted_at IS NULL");
  const row = stmt.get(id) as Record<string, unknown> | undefined;
  return row ? rowToSecretRow(row) : null;
}

/**
 * 시크릿을 수정한다.
 * @returns 수정 성공 여부
 */
export function updateSecret(args: {
  id: string;
  name?: string;
  value?: string;
  secretType?: string;
  service?: string;
  tags?: string[];
  notes?: string;
  expiresAt?: string;
}): boolean {
  const existing = getSecret(args.id);
  if (!existing) return false;

  const now = new Date().toISOString();

  const stmt = getDb().prepare(`
    UPDATE secrets SET
      name = ?, value = ?, secret_type = ?, service = ?,
      tags = ?, notes = ?, expires_at = ?, updated_at = ?
    WHERE id = ? AND deleted_at IS NULL
  `);

  stmt.run(
    args.name ?? existing.name,
    args.value ?? existing.value,
    args.secretType ?? existing.secretType,
    args.service ?? existing.service ?? null,
    JSON.stringify(args.tags ?? existing.tags),
    args.notes ?? existing.notes ?? null,
    args.expiresAt ?? existing.expiresAt ?? null,
    now,
    args.id,
  );

  info(`시크릿 수정됨: ${args.id}`);
  return true;
}

/**
 * 시크릿을 soft-delete 처리한다.
 * deleted_at에 현재 시각을 기록하고, 실제 데이터는 유지한다.
 * @returns soft-delete 성공 여부
 */
export function deleteSecret(id: string): boolean {
  const now = new Date().toISOString();
  const stmt = getDb().prepare("UPDATE secrets SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL");
  const result = stmt.run(now, id);
  if (result.changes > 0) {
    info(`시크릿 soft-delete 됨: ${id}`);
    return true;
  }
  return false;
}

/**
 * 시크릿을 영구 삭제한다 (hard delete).
 * soft-delete 이후 보존 기간이 지난 항목에 대해서만 사용한다.
 */
export function purgeSecret(id: string): boolean {
  const stmt = getDb().prepare("DELETE FROM secrets WHERE id = ? AND deleted_at IS NOT NULL");
  const result = stmt.run(id);
  if (result.changes > 0) {
    info(`시크릿 영구 삭제됨: ${id}`);
    return true;
  }
  return false;
}

/**
 * soft-delete된 시크릿을 복원한다.
 */
export function restoreSecret(id: string): boolean {
  const stmt = getDb().prepare("UPDATE secrets SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL");
  const result = stmt.run(id);
  if (result.changes > 0) {
    info(`시크릿 복원됨: ${id}`);
    return true;
  }
  return false;
}

/**
 * 보존 기간이 지난 soft-delete 항목을 일괄 영구 삭제한다.
 * @param retentionDays - 보존 기간 (일, 기본 30)
 * @returns 삭제된 건수
 */
export function purgeExpiredDeletes(retentionDays: number = 30): number {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const stmt = getDb().prepare("DELETE FROM secrets WHERE deleted_at IS NOT NULL AND deleted_at < ?");
  const result = stmt.run(cutoff);
  if (result.changes > 0) {
    info(`만료된 soft-delete 항목 ${result.changes}건 영구 삭제됨`);
  }
  return result.changes;
}

/**
 * soft-delete된 시크릿 목록을 반환한다.
 * @returns 복원 가능한 시크릿 목록
 */
export function listDeletedSecrets(): SecretRow[] {
  const stmt = getDb().prepare("SELECT * FROM secrets WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC");
  const rows = stmt.all() as Record<string, unknown>[];
  return rows.map(rowToSecretRow);
}

/**
 * 필터 조건으로 시크릿 목록을 조회한다.
 * @returns 시크릿 목록과 총 건수
 */
export function listSecrets(args: {
  secretType?: string;
  service?: string;
  limit?: number;
  offset?: number;
}): { secrets: SecretRow[]; total: number } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (args.secretType) {
    conditions.push("secret_type = ?");
    params.push(args.secretType);
  }

  if (args.service) {
    conditions.push("service = ?");
    params.push(args.service);
  }

  /* soft-delete된 항목 제외 */
  conditions.push("deleted_at IS NULL");

  const where = `WHERE ${conditions.join(" AND ")}`;
  const limit = args.limit || 20;
  const offset = args.offset || 0;

  /* 총 건수 조회 */
  const countStmt = getDb().prepare(`SELECT COUNT(*) as cnt FROM secrets ${where}`);
  const countRow = countStmt.get(...params) as { cnt: number };

  /* 목록 조회 */
  const listStmt = getDb().prepare(
    `SELECT * FROM secrets ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
  );
  const rows = listStmt.all(...params, limit, offset) as Record<string, unknown>[];

  return {
    secrets: rows.map(rowToSecretRow),
    total: countRow.cnt,
  };
}

/**
 * 시크릿 총 건수를 조회한다.
 * @param groupBy - 그룹화 기준 (선택)
 * @returns 총 건수와 그룹별 분류
 */
export function countSecrets(
  groupBy?: "secret_type" | "service",
): { total: number; breakdown?: Record<string, number> } {
  const totalStmt = getDb().prepare("SELECT COUNT(*) as cnt FROM secrets WHERE deleted_at IS NULL");
  const totalRow = totalStmt.get() as { cnt: number };

  if (!groupBy) {
    return { total: totalRow.cnt };
  }

  /* 방어적 화이트리스트 검증 — SQL 인젝션 방지 */
  const allowedColumns = ["secret_type", "service"] as const;
  if (!allowedColumns.includes(groupBy as typeof allowedColumns[number])) {
    throw new Error(`허용되지 않은 그룹 기준입니다: ${groupBy}`);
  }

  const groupStmt = getDb().prepare(
    `SELECT ${groupBy} as grp, COUNT(*) as cnt FROM secrets WHERE deleted_at IS NULL GROUP BY ${groupBy}`,
  );
  const groups = groupStmt.all() as Array<{ grp: string; cnt: number }>;

  const breakdown: Record<string, number> = {};
  for (const g of groups) {
    breakdown[g.grp || "unknown"] = g.cnt;
  }

  return { total: totalRow.cnt, breakdown };
}

/**
 * 만료된 시크릿 목록을 반환한다.
 */
export function getExpiredSecrets(): SecretRow[] {
  const now = new Date().toISOString();
  const stmt = getDb().prepare(
    "SELECT * FROM secrets WHERE expires_at IS NOT NULL AND expires_at <= ? AND deleted_at IS NULL",
  );
  const rows = stmt.all(now) as Record<string, unknown>[];
  return rows.map(rowToSecretRow);
}

/**
 * 전체 시크릿을 JSON으로 내보낸다.
 * @param includeValues - true이면 값 포함, false이면 값 마스킹 (기본: false)
 */
export function exportSecrets(args: {
  includeValues?: boolean;
  secretType?: string;
  service?: string;
}): SecretRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (args.secretType) {
    conditions.push("secret_type = ?");
    params.push(args.secretType);
  }

  if (args.service) {
    conditions.push("service = ?");
    params.push(args.service);
  }

  /* soft-delete된 항목 제외 */
  conditions.push("deleted_at IS NULL");
  const where = `WHERE ${conditions.join(" AND ")}`;
  const stmt = getDb().prepare(`SELECT * FROM secrets ${where} ORDER BY created_at`);
  const rows = stmt.all(...params) as Record<string, unknown>[];

  return rows.map((row) => {
    const secret = rowToSecretRow(row);
    if (!args.includeValues) {
      secret.value = "***MASKED***";
    }
    return secret;
  });
}

/**
 * SQLCipher 연결 상태를 확인한다.
 */
export function checkSqlcipherHealth(): { ok: boolean; message: string } {
  if (!config.sqlcipher.encryptionKey) {
    return { ok: false, message: "ZIME_ENCRYPTION_KEY 미설정, secrets store 비활성" };
  }

  try {
    if (!_db) {
      return { ok: false, message: "SQLCipher DB 미초기화" };
    }
    const row = getDb().prepare("SELECT COUNT(*) as cnt FROM secrets WHERE deleted_at IS NULL").get() as { cnt: number };
    return { ok: true, message: `SQLCipher 정상 (시크릿 ${row.cnt}건)` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`SQLCipher 헬스체크 실패: ${msg}`);
    return { ok: false, message: `SQLCipher 오류: ${msg}` };
  }
}

/**
 * DB를 안전하게 닫는다.
 * 서버 종료 시 호출한다.
 */
export function closeSqlcipher(): void {
  if (_db) {
    _db.close();
    info("SQLCipher 데이터베이스 닫힘");
  }
}
