/**
 * 백업 서비스
 * Qdrant 스냅샷, MinIO NAS 동기화, SQLCipher 파일 복사의 통합 백업을 담당한다.
 */

import { config } from "../config.js";
import { info, error as logError } from "../utils/logger.js";
import { mkdir, writeFile, copyFile, stat, readdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { execFile } from "child_process";
import { fileURLToPath } from "url";
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

// ─────────────────────────────────────────────
// SSH 원격 백업 (시크릿 2중화)
// ─────────────────────────────────────────────

/** SSH 명령을 Promise로 실행하는 헬퍼 */
function execAsync(
  cmd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

/** 프로젝트 루트 경로를 구한다 */
function getProjectRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  return join(dirname(__filename), "..", "..");
}

/** SSH 원격 백업 설정 검증 */
function getSshBackupConfig(): { host: string; path: string; maxSnapshots: number } {
  const host = config.sshBackup.host;
  if (!host) {
    throw new Error(
      "SSH 백업 호스트가 설정되지 않았습니다 (SSH_BACKUP_HOST 또는 ZIME_SSH_HOST 환경변수)"
    );
  }
  return {
    host,
    path: config.sshBackup.path,
    maxSnapshots: config.sshBackup.maxSnapshots,
  };
}

/** 원격 백업 결과 타입 */
export interface RemoteBackupResult {
  host: string;
  path: string;
  snapshotName: string;
  dbSize: number;
  safetyBackupsSynced: boolean;
  snapshotsPruned: number;
}

/** 원격 백업 상태 타입 */
export interface RemoteBackupStatus {
  host: string;
  path: string;
  latestSnapshot: string | null;
  snapshotCount: number;
  safetyBackupCount: number;
  currentDbSize: string | null;
  totalSize: string | null;
}

/** 원격 스냅샷 정보 타입 */
export interface RemoteSnapshot {
  name: string;
  size: string;
}

/**
 * SSH를 통해 시크릿 데이터를 원격 호스트에 백업한다.
 * rsync로 secrets.db, .env, safety-backups를 전송하고 타임스탬프 스냅샷을 생성한다.
 */
export async function backupToRemote(): Promise<RemoteBackupResult> {
  const { host, path: remotePath, maxSnapshots } = getSshBackupConfig();
  const projectRoot = getProjectRoot();
  const dbPath = config.sqlcipher.dbPath;
  const envPath = join(projectRoot, ".env");
  const safetyDir = join(projectRoot, "data", "safety-backups");

  // 1. SSH 연결 확인
  try {
    await execAsync("ssh", ["-o", "ConnectTimeout=5", "-o", "BatchMode=yes", host, "echo ok"]);
  } catch {
    throw new Error(`SSH 연결 실패: ${host}`);
  }

  // 2. secrets.db 존재 확인
  if (!existsSync(dbPath)) {
    throw new Error(`secrets.db가 존재하지 않습니다: ${dbPath}`);
  }

  // 3. 원격 디렉토리 생성
  await execAsync("ssh", [host, `mkdir -p ${remotePath}/{current,safety-backups,snapshots}`]);

  // 4. rsync — 최신 DB + .env 전송
  const rsyncFiles = [dbPath];
  if (existsSync(envPath)) rsyncFiles.push(envPath);
  await execAsync("rsync", ["-az", ...rsyncFiles, `${host}:${remotePath}/current/`]);
  await execAsync("ssh", [host, `chmod 600 ${remotePath}/current/*`]);
  info(`[SSH-BACKUP] current/ 동기화 완료 (${host}:${remotePath})`);

  // 5. safety-backups 동기화
  let safetyBackupsSynced = false;
  if (existsSync(safetyDir)) {
    await execAsync("rsync", [
      "-az", "--delete",
      `${safetyDir}/`,
      `${host}:${remotePath}/safety-backups/`,
    ]);
    safetyBackupsSynced = true;
    info(`[SSH-BACKUP] safety-backups/ 동기화 완료`);
  }

  // 6. 타임스탬프 스냅샷 생성
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const snapshotName = `secrets_${timestamp}.db`;
  await execAsync("ssh", [
    host,
    `cp ${remotePath}/current/secrets.db ${remotePath}/snapshots/${snapshotName} && chmod 600 ${remotePath}/snapshots/${snapshotName}`,
  ]);
  info(`[SSH-BACKUP] 스냅샷 생성: ${snapshotName}`);

  // 7. 프루닝
  let snapshotsPruned = 0;
  try {
    const { stdout } = await execAsync("ssh", [
      host,
      `cd ${remotePath}/snapshots && ls -1t *.db 2>/dev/null | tail -n +${maxSnapshots + 1} | xargs -r rm -v 2>&1 | wc -l`,
    ]);
    snapshotsPruned = parseInt(stdout.trim(), 10) || 0;
    if (snapshotsPruned > 0) {
      info(`[SSH-BACKUP] 스냅샷 프루닝: ${snapshotsPruned}개 삭제`);
    }
  } catch {
    /* 프루닝 실패는 무시 */
  }

  // 8. DB 크기 확인
  const fileInfo = await stat(dbPath);

  return {
    host,
    path: remotePath,
    snapshotName,
    dbSize: fileInfo.size,
    safetyBackupsSynced,
    snapshotsPruned,
  };
}

/**
 * 원격 백업 상태를 조회한다. (스냅샷 수, 최신 백업 시각, 총 용량)
 */
export async function getRemoteBackupStatus(): Promise<RemoteBackupStatus> {
  const { host, path: remotePath } = getSshBackupConfig();

  // SSH 연결 확인
  try {
    await execAsync("ssh", ["-o", "ConnectTimeout=5", "-o", "BatchMode=yes", host, "echo ok"]);
  } catch {
    throw new Error(`SSH 연결 실패: ${host}`);
  }

  // 디렉토리 존재 확인
  try {
    await execAsync("ssh", [host, `[ -d ${remotePath} ]`]);
  } catch {
    return {
      host,
      path: remotePath,
      latestSnapshot: null,
      snapshotCount: 0,
      safetyBackupCount: 0,
      currentDbSize: null,
      totalSize: null,
    };
  }

  // 상태 정보 수집 (단일 SSH 호출로 최적화)
  const { stdout } = await execAsync("ssh", [
    host,
    [
      `echo "===LATEST==="; ls -1t ${remotePath}/snapshots/*.db 2>/dev/null | head -1 | xargs basename 2>/dev/null || echo ""`,
      `echo "===SNAP_COUNT==="; ls -1 ${remotePath}/snapshots/*.db 2>/dev/null | wc -l`,
      `echo "===SAFETY_COUNT==="; ls -1 ${remotePath}/safety-backups/*.db 2>/dev/null | wc -l`,
      `echo "===DB_SIZE==="; ls -lh ${remotePath}/current/secrets.db 2>/dev/null | awk '{print $5}' || echo ""`,
      `echo "===TOTAL_SIZE==="; du -sh ${remotePath} 2>/dev/null | cut -f1 || echo ""`,
    ].join("; "),
  ]);

  const extract = (marker: string): string => {
    const re = new RegExp(`===` + marker + `===\\s*(.*)`, "m");
    return re.exec(stdout)?.[1]?.trim() || "";
  };

  return {
    host,
    path: remotePath,
    latestSnapshot: extract("LATEST") || null,
    snapshotCount: parseInt(extract("SNAP_COUNT"), 10) || 0,
    safetyBackupCount: parseInt(extract("SAFETY_COUNT"), 10) || 0,
    currentDbSize: extract("DB_SIZE") || null,
    totalSize: extract("TOTAL_SIZE") || null,
  };
}

/**
 * 원격 스냅샷 목록을 조회한다.
 */
export async function listRemoteSnapshots(): Promise<RemoteSnapshot[]> {
  const { host, path: remotePath } = getSshBackupConfig();

  try {
    await execAsync("ssh", ["-o", "ConnectTimeout=5", "-o", "BatchMode=yes", host, "echo ok"]);
  } catch {
    throw new Error(`SSH 연결 실패: ${host}`);
  }

  const { stdout } = await execAsync("ssh", [
    host,
    `ls -lhS ${remotePath}/snapshots/*.db 2>/dev/null | awk '{print $NF, $5}' | sed 's|.*/||'`,
  ]);

  if (!stdout.trim()) return [];

  return stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [name, size] = line.trim().split(/\s+/);
      return { name, size: size || "unknown" };
    })
    .filter((s) => s.name);
}

/**
 * 원격 스냅샷을 로컬로 복원한다.
 * 주의: 현재 secrets.db를 덮어쓰므로 사전에 로컬 safety-backup을 자동 생성한다.
 */
export async function restoreFromRemote(snapshotName: string): Promise<{
  restoredFrom: string;
  localBackup: string | null;
  size: number;
}> {
  const { host, path: remotePath } = getSshBackupConfig();
  const dbPath = config.sqlcipher.dbPath;
  const projectRoot = getProjectRoot();
  const safetyDir = join(projectRoot, "data", "safety-backups");

  // SSH 연결 확인
  try {
    await execAsync("ssh", ["-o", "ConnectTimeout=5", "-o", "BatchMode=yes", host, "echo ok"]);
  } catch {
    throw new Error(`SSH 연결 실패: ${host}`);
  }

  // 원격 스냅샷 존재 확인
  try {
    await execAsync("ssh", [host, `[ -f ${remotePath}/snapshots/${snapshotName} ]`]);
  } catch {
    throw new Error(`원격 스냅샷을 찾을 수 없습니다: ${snapshotName}`);
  }

  // 로컬 safety-backup 생성
  let localBackup: string | null = null;
  if (existsSync(dbPath)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backupName = `secrets_pre-remote-restore_${timestamp}.db`;
    if (!existsSync(safetyDir)) {
      await mkdir(safetyDir, { recursive: true });
    }
    const backupPath = join(safetyDir, backupName);
    await copyFile(dbPath, backupPath);
    localBackup = backupName;
    info(`[SSH-BACKUP] 복원 전 로컬 백업 생성: ${backupName}`);
  }

  // 원격 스냅샷 → 로컬 복원
  await execAsync("rsync", ["-az", `${host}:${remotePath}/snapshots/${snapshotName}`, dbPath]);
  const fileInfo = await stat(dbPath);

  info(`[SSH-BACKUP] 원격 스냅샷 복원 완료: ${snapshotName} (${fileInfo.size} bytes)`);

  return {
    restoredFrom: snapshotName,
    localBackup,
    size: fileInfo.size,
  };
}
