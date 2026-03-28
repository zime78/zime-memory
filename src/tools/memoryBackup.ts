/**
 * memory_backup 도구
 * Qdrant 스냅샷 + MinIO NAS 동기화 + SQLCipher 파일 복사의 통합 백업을 수행한다.
 */

import { z } from "zod";
import {
  createSnapshot,
  listSnapshots,
  copySnapshotToNas,
  createUnifiedBackup,
  backupToRemote,
  getRemoteBackupStatus,
  listRemoteSnapshots,
} from "../services/backupService.js";
import { jsonResponse } from "../utils/response.js";

/** memory_backup 도구의 입력 스키마 */
export const memoryBackupSchema = z.object({
  /** 스냅샷을 NAS에 복사할지 여부 (기본: false) */
  copyToNas: z.boolean().default(false),
  /** 스냅샷 목록만 조회할지 여부 (기본: false) */
  listOnly: z.boolean().default(false),
  /** 통합 백업 실행 여부 — true이면 Qdrant+MinIO+SQLCipher 모두 백업 (기본: false) */
  unified: z.boolean().default(false),
  /** SSH를 통해 원격 호스트에 시크릿 백업 */
  remoteBackup: z.boolean().default(false),
  /** 원격 백업 상태 조회 */
  remoteStatus: z.boolean().default(false),
  /** 원격 스냅샷 목록 조회 */
  remoteList: z.boolean().default(false),
});

export type MemoryBackupInput = z.infer<typeof memoryBackupSchema>;

/**
 * 백업을 수행한다.
 * unified=true이면 3개 스토어 통합 백업, 아니면 기존 Qdrant 전용 백업.
 */
export async function memoryBackup(args: MemoryBackupInput) {
  // ─── SSH 원격 백업 ───
  if (args.remoteBackup) {
    const result = await backupToRemote();
    return jsonResponse({
      success: true,
      message: `SSH 원격 백업 완료 (${result.host}:${result.path})`,
      remoteBackup: {
        host: result.host,
        path: result.path,
        snapshotName: result.snapshotName,
        dbSize: result.dbSize,
        safetyBackupsSynced: result.safetyBackupsSynced,
        snapshotsPruned: result.snapshotsPruned,
      },
    });
  }

  // ─── 원격 백업 상태 조회 ───
  if (args.remoteStatus) {
    const status = await getRemoteBackupStatus();
    return jsonResponse({
      success: true,
      message: `원격 백업 상태 (${status.host})`,
      status: {
        host: status.host,
        path: status.path,
        latestSnapshot: status.latestSnapshot,
        snapshotCount: status.snapshotCount,
        safetyBackupCount: status.safetyBackupCount,
        currentDbSize: status.currentDbSize,
        totalSize: status.totalSize,
      },
    });
  }

  // ─── 원격 스냅샷 목록 ───
  if (args.remoteList) {
    const snapshots = await listRemoteSnapshots();
    return jsonResponse({
      success: true,
      snapshots: snapshots.map((s) => ({ name: s.name, size: s.size })),
      count: snapshots.length,
    });
  }

  // 목록만 조회
  if (args.listOnly) {
    const snapshots = await listSnapshots();
    return jsonResponse({
      success: true,
      snapshots: snapshots.map((s) => ({
        name: s.name,
        createdAt: s.creation_time,
        size: s.size,
      })),
      count: snapshots.length,
    });
  }

  // ─── 통합 백업 (Qdrant + MinIO + SQLCipher) ───
  if (args.unified) {
    const result = await createUnifiedBackup();

    return jsonResponse({
      success: result.errors.length === 0,
      message: `통합 백업 완료 (오류 ${result.errors.length}건)`,
      qdrant: result.qdrant
        ? { snapshotName: result.qdrant.snapshotName, size: result.qdrant.size }
        : null,
      minio: result.minio
        ? { imagesSynced: result.minio.imagesSynced, filesSynced: result.minio.filesSynced }
        : null,
      sqlcipher: result.sqlcipher
        ? { backupPath: result.sqlcipher.backupPath, size: result.sqlcipher.size }
        : null,
      errors: result.errors.length > 0 ? result.errors : undefined,
    } as Record<string, unknown>);
  }

  // ─── 기존 Qdrant 전용 백업 (하위 호환) ───
  const snapshot = await createSnapshot();

  let nasPath: string | undefined;
  if (args.copyToNas) {
    try {
      nasPath = await copySnapshotToNas(snapshot.name);
    } catch (err) {
      return jsonResponse({
        success: true,
        message: `스냅샷 생성 완료, NAS 복사 실패`,
        snapshot: {
          name: snapshot.name,
          createdAt: snapshot.creation_time,
          size: snapshot.size,
        },
        nasError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return jsonResponse({
    success: true,
    message: `스냅샷 생성 완료${nasPath ? " + NAS 복사 완료" : ""}`,
    snapshot: {
      name: snapshot.name,
      createdAt: snapshot.creation_time,
      size: snapshot.size,
    },
    ...(nasPath ? { nasPath } : {}),
  });
}
