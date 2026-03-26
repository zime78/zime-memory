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
});

export type MemoryBackupInput = z.infer<typeof memoryBackupSchema>;

/**
 * 백업을 수행한다.
 * unified=true이면 3개 스토어 통합 백업, 아니면 기존 Qdrant 전용 백업.
 */
export async function memoryBackup(args: MemoryBackupInput) {
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
