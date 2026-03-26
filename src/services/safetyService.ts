/**
 * 데이터 안전 서비스
 * 삭제/대량 변경 전 자동 백업, 워터마크 무결성 검증을 담당한다.
 * NAS 설정 없이도 data/safety-backups/에 로컬 백업을 유지한다.
 */

import { copyFile, mkdir, readdir, unlink } from "fs/promises";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "../config.js";
import { info, warn, error as logError } from "../utils/logger.js";

/** 프로젝트 루트의 data/ 디렉토리 (절대경로 — CWD 무관) */
const DATA_DIR = dirname(config.sqlcipher.dbPath);
/** 로컬 안전 백업 디렉토리 (절대경로) */
const LOCAL_BACKUP_DIR = join(DATA_DIR, "safety-backups");
/** 최대 로컬 백업 보관 수 */
const MAX_LOCAL_BACKUPS = 20;

/**
 * SQLCipher DB의 로컬 안전 복사본을 생성한다.
 * NAS 설정과 무관하게 항상 data/safety-backups/에 저��한다.
 * @param reason - 백업 사유 (예: "pre-delete", "auto-scheduled")
 * @returns 백업 파일 경로
 */
export async function localBackupSqlcipher(reason: string): Promise<string> {
  if (!existsSync(LOCAL_BACKUP_DIR)) {
    await mkdir(LOCAL_BACKUP_DIR, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const destPath = join(LOCAL_BACKUP_DIR, `secrets_${reason}_${timestamp}.db`);

  await copyFile(config.sqlcipher.dbPath, destPath);
  info(`[SAFETY] SQLCipher 로컬 백업: ${destPath} (사유: ${reason})`);

  await pruneLocalBackups("secrets_");
  return destPath;
}

/**
 * Qdrant 스냅샷을 생성한다.
 * backupService.createSnapshot()을 래핑하여 사유를 로깅한다.
 * @param reason - 백업 사유
 * @returns 스냅샷 이름
 */
export async function localBackupQdrant(reason: string): Promise<string> {
  const { createSnapshot } = await import("./backupService.js");
  const snapshot = await createSnapshot();
  info(`[SAFETY] Qdrant 스냅샷: ${snapshot.name} (사유: ${reason})`);
  return snapshot.name;
}

/** 워터마크 무결성 검증 옵션 */
interface WatermarkValidateOptions {
  /** 워터마크 파일 경로 */
  watermarkPath: string;
  /** 워터마크 JSON의 카운트 키 (예: "rowCount" 또는 "pointsCount") */
  countKey: string;
  /** 서비스 라벨 (로그 출력용, 예: "Qdrant" 또는 "SQLCipher") */
  label: string;
  /** 현재 카운트 값 */
  currentCount: number;
}

/**
 * 워터마크 기반 무결성을 검증한다.
 * 워터마크 파일의 이전 카운트와 현재 카운트를 비교하여 급감/초기화 여부를 감지한다.
 * @returns 검증 결과 (ok=false이면 warning 메시지 포함)
 */
function validateWatermark(opts: WatermarkValidateOptions): {
  ok: boolean;
  warning?: string;
  previousCount: number;
  currentCount: number;
} {
  const { watermarkPath, countKey, label, currentCount } = opts;

  if (existsSync(watermarkPath)) {
    try {
      const watermark = JSON.parse(readFileSync(watermarkPath, "utf-8"));
      const previousCount = (watermark[countKey] as number) ?? 0;

      if (previousCount > 0 && currentCount === 0) {
        return {
          ok: false,
          warning: `CRITICAL: ${label}이(가) 비어있습니다! 이전 ${previousCount}건 → 현재 0건. 재생성된 것 같습니다. 백업에서 복원이 필요합니다.`,
          previousCount,
          currentCount,
        };
      }

      if (previousCount > 5 && currentCount < previousCount * 0.5) {
        return {
          ok: false,
          warning: `WARNING: ${label} 건수가 급감했습니다 (${previousCount}건 → ${currentCount}건). 데이터 손실 가능성을 확인하세요.`,
          previousCount,
          currentCount,
        };
      }
    } catch {
      // 워터마크 파일 파싱 실패 시 무시 — 새로 생성
    }
  }

  // 워터마크가 없을 때 0건이면 경고
  if (currentCount === 0) {
    warn(`[INTEGRITY] ${label} 워터마크 없음 + 0건. 신규 설치인지 확인하세요.`);
  }

  return { ok: true, previousCount: currentCount, currentCount };
}

/** 워터마크 갱신 옵션 */
interface WatermarkUpdateOptions {
  /** 워터마크 파일 경로 */
  watermarkPath: string;
  /** 워터마크 JSON의 카운트 키 (예: "rowCount" 또는 "pointsCount") */
  countKey: string;
  /** 현재 카운트 값 */
  count: number;
  /** 워터마크 JSON에 추가로 기록할 메타 필드 */
  meta: Record<string, string>;
}

/**
 * 워터마크 파일을 갱신한다.
 * 성공적인 저장/삭제 후 호출하여 최신 카운트를 기록한다.
 */
function updateWatermark(opts: WatermarkUpdateOptions): void {
  const { watermarkPath, countKey, count, meta } = opts;
  const dir = dirname(watermarkPath);
  if (!existsSync(dir)) {
    return; // 대상 디렉토리가 없으면 건너뜀
  }
  try {
    writeFileSync(
      watermarkPath,
      JSON.stringify({ [countKey]: count, updatedAt: new Date().toISOString(), ...meta }),
    );
  } catch {
    // 워터마크 쓰기 실패는 치명적이지 않음
  }
}

/**
 * SQLCipher DB의 무결성을 검증한다.
 * 워터마크 파일과 실제 row count를 비교하여 silent recreation을 감지한다.
 * @param currentCount - 현재 secrets 테이블 행 수
 * @returns 검증 결과
 */
export function validateSqlcipherIntegrity(currentCount: number): {
  ok: boolean;
  warning?: string;
  previousCount: number;
  currentCount: number;
} {
  const watermarkPath = join(dirname(config.sqlcipher.dbPath), ".secrets-watermark.json");
  const result = validateWatermark({
    watermarkPath,
    countKey: "rowCount",
    label: "SQLCipher secrets DB",
    currentCount,
  });

  if (result.ok) {
    updateSqlcipherWatermark(currentCount);
  }

  return result;
}

/**
 * SQLCipher 워터마크를 갱신한다.
 * 성공적인 저장/삭제 후 호출하여 최신 상태를 기록한다.
 */
export function updateSqlcipherWatermark(rowCount: number): void {
  const watermarkPath = join(dirname(config.sqlcipher.dbPath), ".secrets-watermark.json");
  updateWatermark({
    watermarkPath,
    countKey: "rowCount",
    count: rowCount,
    meta: { dbPath: config.sqlcipher.dbPath },
  });
}

/**
 * Qdrant 컬렉션의 무결성을 검증한다.
 * 워터마크와 비교하여 컬렉션이 silent recreation 되었는지 감지한다.
 * @param currentCount - 현재 포인트 수
 * @returns 검증 결과
 */
export function validateQdrantIntegrity(currentCount: number): {
  ok: boolean;
  warning?: string;
  previousCount: number;
  currentCount: number;
} {
  const watermarkPath = join(DATA_DIR, ".qdrant-watermark.json");
  const result = validateWatermark({
    watermarkPath,
    countKey: "pointsCount",
    label: "Qdrant 컬렉션",
    currentCount,
  });

  if (result.ok) {
    updateQdrantWatermark(currentCount);
  }

  return result;
}

/**
 * Qdrant 워터마크를 갱신한다.
 */
export function updateQdrantWatermark(pointsCount: number): void {
  const watermarkPath = join(DATA_DIR, ".qdrant-watermark.json");
  updateWatermark({
    watermarkPath,
    countKey: "pointsCount",
    count: pointsCount,
    meta: { collectionName: config.qdrant.collectionName },
  });
}

/**
 * 사용 가능한 로컬 백업 목록을 반환한다.
 * @returns 백업 파일 목록 (최신순)
 */
export async function listLocalBackups(): Promise<Array<{
  filename: string;
  path: string;
  size: number;
  createdAt: string;
}>> {
  if (!existsSync(LOCAL_BACKUP_DIR)) return [];

  const { stat } = await import("fs/promises");
  const files = await readdir(LOCAL_BACKUP_DIR);
  const backups = [];

  for (const file of files.filter(f => f.endsWith(".db"))) {
    const filePath = join(LOCAL_BACKUP_DIR, file);
    const fileStat = await stat(filePath);
    backups.push({
      filename: file,
      path: filePath,
      size: fileStat.size,
      createdAt: fileStat.mtime.toISOString(),
    });
  }

  return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * 오래된 로컬 백업을 정리한다. 최근 MAX_LOCAL_BACKUPS개만 유지.
 */
async function pruneLocalBackups(prefix: string): Promise<void> {
  if (!existsSync(LOCAL_BACKUP_DIR)) return;

  const files = (await readdir(LOCAL_BACKUP_DIR))
    .filter(f => f.startsWith(prefix))
    .sort()
    .reverse();

  for (const file of files.slice(MAX_LOCAL_BACKUPS)) {
    await unlink(join(LOCAL_BACKUP_DIR, file));
    info(`[SAFETY] 오래된 백업 삭제: ${file}`);
  }
}
