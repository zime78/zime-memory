/**
 * 백업 서비스
 * Qdrant 스냅샷, MinIO NAS 동기화, SQLCipher 파일 복사의 통합 백업을 담당한다.
 */

import { config } from "../config.js";
import { info, error as logError } from "../utils/logger.js";
import { mkdir, writeFile, copyFile, stat, readdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import {
  listObjects,
  downloadObject,
  resolveBucket,
} from "./minioService.js";

/** Qdrant 스냅샷 응답 타입 */
interface SnapshotInfo {
  name: string;
  creation_time: string;
  size: number;
}

/**
 * Qdrant 컬렉션의 스냅샷을 생성한다.
 * POST /collections/{name}/snapshots API를 호출한다.
 *
 * @returns 생성된 스냅샷 정보
 */
export async function createSnapshot(): Promise<SnapshotInfo> {
  const url = `${config.qdrant.url}/collections/${config.qdrant.collectionName}/snapshots`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.qdrant.apiKey) {
    headers["api-key"] = config.qdrant.apiKey;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`스냅샷 생성 실패 (HTTP ${response.status}): ${body}`);
  }

  const data = (await response.json()) as { result: SnapshotInfo };
  info(`스냅샷 생성 완료: ${data.result.name}`);
  return data.result;
}

/**
 * Qdrant 컬렉션의 스냅샷 목록을 조회한다.
 *
 * @returns 스냅샷 목록
 */
export async function listSnapshots(): Promise<SnapshotInfo[]> {
  const url = `${config.qdrant.url}/collections/${config.qdrant.collectionName}/snapshots`;

  const headers: Record<string, string> = {};
  if (config.qdrant.apiKey) {
    headers["api-key"] = config.qdrant.apiKey;
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`스냅샷 목록 조회 실패 (HTTP ${response.status}): ${body}`);
  }

  const data = (await response.json()) as { result: SnapshotInfo[] };
  return data.result;
}

/**
 * 스냅샷 파일을 다운로드한다.
 *
 * @param snapshotName - 다운로드할 스냅샷 이름
 * @returns 스냅샷 파일의 바이너리 데이터
 */
async function downloadSnapshot(snapshotName: string): Promise<ArrayBuffer> {
  const url = `${config.qdrant.url}/collections/${config.qdrant.collectionName}/snapshots/${snapshotName}`;

  const headers: Record<string, string> = {};
  if (config.qdrant.apiKey) {
    headers["api-key"] = config.qdrant.apiKey;
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(`스냅샷 다운로드 실패 (HTTP ${response.status})`);
  }

  return response.arrayBuffer();
}

/**
 * 스냅샷을 NAS 경로로 복사한다.
 * NAS_BACKUP_PATH 환경변수가 설정되어 있어야 한다.
 *
 * @param snapshotName - 복사할 스냅샷 이름
 * @returns 복사된 파일 경로
 */
export async function copySnapshotToNas(snapshotName: string): Promise<string> {
  const nasPath = config.backup.nasPath;
  if (!nasPath) {
    throw new Error("NAS 백업 경로가 설정되지 않았습니다 (NAS_BACKUP_PATH 환경변수)");
  }

  // NAS 디렉토리가 없으면 생성
  if (!existsSync(nasPath)) {
    await mkdir(nasPath, { recursive: true });
  }

  // 스냅샷 다운로드 후 NAS에 저장
  const data = await downloadSnapshot(snapshotName);
  const destPath = join(nasPath, snapshotName);

  await writeFile(destPath, Buffer.from(data));

  info(`스냅샷 NAS 복사 완료: ${destPath}`);
  return destPath;
}

// ─────────────────────────────────────────────
// 통합 백업 (Qdrant + MinIO + SQLCipher)
// ─────────────────────────────────────────────

/**
 * SQLCipher DB 파일을 NAS에 타임스탬프 포함하여 복사한다.
 * @returns 복사된 파일 경로
 */
export async function backupSqlcipher(): Promise<{
  backupPath: string;
  size: number;
}> {
  const nasPath = config.backup.nasPath;
  if (!nasPath) {
    throw new Error("NAS 백업 경로가 설정되지 않았습니다 (NAS_BACKUP_PATH 환경변수)");
  }

  const dbPath = config.sqlcipher.dbPath;
  if (!existsSync(dbPath)) {
    throw new Error(`SQLCipher DB 파일이 존재하지 않습니다: ${dbPath}`);
  }

  const sqlcipherDir = join(nasPath, "sqlcipher");
  if (!existsSync(sqlcipherDir)) {
    await mkdir(sqlcipherDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const destPath = join(sqlcipherDir, `secrets_${timestamp}.db`);

  await copyFile(dbPath, destPath);

  const fileInfo = await stat(destPath);

  info(`SQLCipher 백업 완료: ${destPath} (${fileInfo.size} bytes)`);
  return { backupPath: destPath, size: fileInfo.size };
}

/**
 * MinIO 버킷 내용을 NAS 경로로 증분 동기화한다.
 * NAS에 없는 파일만 다운로드하여 복사한다.
 * @returns 동기화된 파일 수
 */
export async function syncMinioToNas(): Promise<{
  imagesSynced: number;
  filesSynced: number;
}> {
  const nasPath = config.backup.nasPath;
  if (!nasPath) {
    throw new Error("NAS 백업 경로가 설정되지 않았습니다 (NAS_BACKUP_PATH 환경변수)");
  }

  let imagesSynced = 0;
  let filesSynced = 0;

  for (const store of ["images", "files"] as const) {
    const bucket = resolveBucket(store);
    const storeDir = join(nasPath, "minio", store);
    if (!existsSync(storeDir)) {
      await mkdir(storeDir, { recursive: true });
    }

    const objects = await listObjects(bucket, undefined, 10000);

    for (const obj of objects) {
      const destPath = join(storeDir, obj.key);
      if (existsSync(destPath)) continue; // 이미 동기화됨

      /* 하위 디렉토리 생성 */
      const destDir = join(storeDir, ...obj.key.split("/").slice(0, -1));
      if (destDir !== storeDir && !existsSync(destDir)) {
        await mkdir(destDir, { recursive: true });
      }

      const buffer = await downloadObject(bucket, obj.key);
      await writeFile(destPath, buffer);

      if (store === "images") imagesSynced++;
      else filesSynced++;
    }
  }

  info(`MinIO→NAS 동기화 완료: 이미지 ${imagesSynced}건, 파일 ${filesSynced}건`);
  return { imagesSynced, filesSynced };
}

/** 통합 백업 결과 타입 */
export interface UnifiedBackupResult {
  qdrant?: { snapshotName: string; size: number };
  minio?: { imagesSynced: number; filesSynced: number };
  sqlcipher?: { backupPath: string; size: number };
  errors: string[];
}

/**
 * 모든 스토어를 통합 백업한다.
 * Qdrant 스냅샷 + MinIO→NAS 동기화 + SQLCipher 파일 복사.
 * 각각 독립 실행하여 하나가 실패해도 나머지는 계속 진행한다.
 */
export async function createUnifiedBackup(): Promise<UnifiedBackupResult> {
  const result: UnifiedBackupResult = { errors: [] };

  /* 1. Qdrant 스냅샷 */
  try {
    const snapshot = await createSnapshot();
    result.qdrant = { snapshotName: snapshot.name, size: snapshot.size };
    if (config.backup.nasPath) {
      await copySnapshotToNas(snapshot.name);
    }
  } catch (err) {
    const msg = `Qdrant 백업 실패: ${err instanceof Error ? err.message : String(err)}`;
    logError(msg);
    result.errors.push(msg);
  }

  /* 2. MinIO→NAS 동기화 */
  if (config.backup.nasPath) {
    try {
      result.minio = await syncMinioToNas();
    } catch (err) {
      const msg = `MinIO 동기화 실패: ${err instanceof Error ? err.message : String(err)}`;
      logError(msg);
      result.errors.push(msg);
    }
  }

  /* 3. SQLCipher 백업 */
  if (config.sqlcipher.encryptionKey && config.backup.nasPath) {
    try {
      result.sqlcipher = await backupSqlcipher();
    } catch (err) {
      const msg = `SQLCipher 백업 실패: ${err instanceof Error ? err.message : String(err)}`;
      logError(msg);
      result.errors.push(msg);
    }
  }

  /* 4. 오래된 백업 프루닝 */
  try {
    await pruneQdrantSnapshots(config.backup.maxQdrantSnapshots);
  } catch (err) {
    const msg = `Qdrant 스냅샷 프루닝 실패: ${err instanceof Error ? err.message : String(err)}`;
    logError(msg);
    result.errors.push(msg);
  }

  if (config.backup.nasPath) {
    try {
      await pruneNasBackups(config.backup.nasPath, config.backup.maxNasBackups);
      const sqlcipherDir = join(config.backup.nasPath, "sqlcipher");
      if (existsSync(sqlcipherDir)) {
        await pruneNasBackups(sqlcipherDir, config.backup.maxNasBackups);
      }
    } catch (err) {
      const msg = `NAS 백업 프루닝 실패: ${err instanceof Error ? err.message : String(err)}`;
      logError(msg);
      result.errors.push(msg);
    }
  }

  info(`통합 백업 완료 (오류 ${result.errors.length}건)`);
  return result;
}

// ─────────────────────────────────────────────
// 백업 프루닝 (Qdrant 스냅샷 + NAS 파일)
// ─────────────────────────────────────────────

/**
 * Qdrant 스냅샷을 삭제한다.
 * DELETE /collections/{name}/snapshots/{snapshot_name} API를 호출한다.
 */
async function deleteSnapshot(snapshotName: string): Promise<void> {
  const url = `${config.qdrant.url}/collections/${config.qdrant.collectionName}/snapshots/${snapshotName}`;

  const headers: Record<string, string> = {};
  if (config.qdrant.apiKey) {
    headers["api-key"] = config.qdrant.apiKey;
  }

  const response = await fetch(url, { method: "DELETE", headers });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`스냅샷 삭제 실패 (HTTP ${response.status}): ${body}`);
  }

  info(`[PRUNE] Qdrant 스냅샷 삭제: ${snapshotName}`);
}

/**
 * Qdrant 스냅샷을 최근 maxCount개만 유지하고 나머지를 삭제한다.
 * @param maxCount - 유지할 최대 스냅샷 수
 * @returns 삭제된 스냅샷 수
 */
export async function pruneQdrantSnapshots(maxCount: number): Promise<number> {
  const snapshots = await listSnapshots();
  if (snapshots.length <= maxCount) return 0;

  /* 생성 시간 내림차순 정렬 후 초과분 삭제 */
  const sorted = snapshots.sort(
    (a, b) => new Date(b.creation_time).getTime() - new Date(a.creation_time).getTime()
  );
  const toDelete = sorted.slice(maxCount);

  let deleted = 0;
  for (const snap of toDelete) {
    try {
      await deleteSnapshot(snap.name);
      deleted++;
    } catch (err) {
      logError(`[PRUNE] 스냅샷 삭제 실패 (${snap.name}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (deleted > 0) {
    info(`[PRUNE] Qdrant 스냅샷 ${deleted}개 삭제 (${snapshots.length}→${snapshots.length - deleted}개)`);
  }
  return deleted;
}

/**
 * NAS 백업 디렉토리에서 오래된 파일을 정리한다. 최근 maxCount개만 유지.
 * 파일명의 타임스탬프를 기준으로 정렬한다.
 * @param dir - 정리 대상 디렉토리 경로
 * @param maxCount - 유지할 최대 파일 수
 * @returns 삭제된 파일 수
 */
export async function pruneNasBackups(dir: string, maxCount: number): Promise<number> {
  if (!existsSync(dir)) return 0;

  const files = (await readdir(dir))
    .filter(f => !f.startsWith(".") && f !== "minio")  // 숨김 파일 및 minio 디렉토리 제외
    .sort()
    .reverse();  // 타임스탬프 포함 파일명이므로 역순 = 최신 우선

  const toDelete = files.slice(maxCount);
  let deleted = 0;

  for (const file of toDelete) {
    const filePath = join(dir, file);
    try {
      const fileStat = await stat(filePath);
      if (fileStat.isFile()) {
        await unlink(filePath);
        info(`[PRUNE] NAS 백업 삭제: ${file}`);
        deleted++;
      }
    } catch (err) {
      logError(`[PRUNE] NAS 백업 삭제 실패 (${file}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (deleted > 0) {
    info(`[PRUNE] NAS 백업 ${deleted}개 삭제 (${dir})`);
  }
  return deleted;
}
