/**
 * memory_restore 도구
 * soft-delete 복원, 백업 목록 조회, SQLCipher 백업 복원을 수행한다.
 */

import { z } from "zod";
import path from "path";
import { copyFile } from "fs/promises";
import {
  restoreSecret,
  listDeletedSecrets,
  isSqlcipherReady,
  closeSqlcipher,
  initSqlcipher,
} from "../services/sqlcipherService.js";
import { restoreMemory, type FilterOptions } from "../services/qdrantService.js";
import {
  listLocalBackups,
  localBackupSqlcipher,
} from "../services/safetyService.js";
import { config } from "../config.js";
import { info } from "../utils/logger.js";
import { jsonResponse, errorResponse } from "../utils/response.js";

/** memory_restore 도구의 입력 스키마 */
export const memoryRestoreSchema = z.object({
  /** 복원 액션 */
  action: z.enum([
    "list-deleted",
    "restore-item",
    "list-backups",
    "restore-sqlcipher",
  ]),
  /** 대상 스토어 (기본: general) */
  store: z.enum(["general", "images", "files", "secrets"]).default("general"),
  /** 복원할 항목 ID (action: restore-item 시 필수) */
  id: z.string().uuid().optional(),
  /** 복원할 백업 파일명 (action: restore-sqlcipher 시 필수) */
  backupFile: z.string().optional(),
  /** 확인 문구 (action: restore-sqlcipher 시 "RESTORE" 필수) */
  confirm: z.string().optional(),
});

export type MemoryRestoreInput = z.infer<typeof memoryRestoreSchema>;

/**
 * 복원 작업을 수행한다.
 */
export async function memoryRestore(args: MemoryRestoreInput) {
  switch (args.action) {
    /* soft-delete된 항목 목록 */
    case "list-deleted": {
      if (args.store === "secrets") {
        if (!isSqlcipherReady()) {
          return errorResponse("SQLCipher가 초기화되지 않았습니다.");
        }
        const deleted = listDeletedSecrets();
        return jsonResponse({
          success: true,
          store: "secrets",
          deletedCount: deleted.length,
          items: deleted.map((s) => ({
            id: s.id,
            name: s.name,
            secretType: s.secretType,
            service: s.service,
            deletedAt: s.deletedAt,
          })),
        });
      }

      /* general/images/files — Qdrant soft-delete 항목 조회 (싱글턴 클라이언트 재사용) */
      const { scrollMemories, buildFilter } = await import("../services/qdrantService.js");
      const filterOpts: FilterOptions & { includeDeleted?: boolean } = { includeDeleted: true };
      if (args.store !== "general") filterOpts.store = args.store;
      /* includeDeleted=true로 모든 포인트 조회 후 deletedAt이 있는 것만 필터 */
      const scrollResult = await scrollMemories(filterOpts, 200);
      const result = {
        points: scrollResult.points.filter(
          (p) => p.payload && (p.payload as Record<string, unknown>).deletedAt
        ),
      };

      return jsonResponse({
        success: true,
        store: args.store,
        deletedCount: result.points.length,
        items: result.points.map((p) => {
          const payload = p.payload as Record<string, unknown> | null;
          return {
            id: p.id,
            title: (payload?.title as string) || "",
            category: (payload?.category as string) || "",
            deletedAt: (payload?.deletedAt as string) || "",
          };
        }),
      });
    }

    /* 단일 항목 복원 */
    case "restore-item": {
      if (!args.id) {
        return errorResponse("복원할 항목의 id가 필요합니다.");
      }

      if (args.store === "secrets") {
        if (!isSqlcipherReady()) {
          return errorResponse("SQLCipher가 초기화되지 않았습니다.");
        }
        const ok = restoreSecret(args.id);
        return jsonResponse({
          success: ok,
          id: args.id,
          message: ok
            ? `시크릿이 복원되었습니다 (ID: ${args.id})`
            : `복원할 시크릿을 찾을 수 없습니다 (ID: ${args.id})`,
        });
      }

      /* general/images/files — Qdrant 복원 */
      await restoreMemory(args.id);
      return jsonResponse({
        success: true,
        id: args.id,
        message: `메모리가 복원되었습니다 (ID: ${args.id})`,
      });
    }

    /* 사용 가능한 백업 목록 */
    case "list-backups": {
      const localBackups = await listLocalBackups();

      /* Qdrant 스냅샷 목록 */
      let qdrantSnapshots: any[] = [];
      try {
        const { listSnapshots } = await import("../services/backupService.js");
        qdrantSnapshots = await listSnapshots();
      } catch {
        /* 스냅샷 조회 실패 무시 */
      }

      return jsonResponse({
        success: true,
        localBackups: localBackups.map((b) => ({
          filename: b.filename,
          size: b.size,
          createdAt: b.createdAt,
        })),
        qdrantSnapshots: qdrantSnapshots.map((s: any) => ({
          name: s.name,
          size: s.size,
          creationTime: s.creation_time,
        })),
      });
    }

    /* SQLCipher 백업 파일에서 복원 */
    case "restore-sqlcipher": {
      if (!args.backupFile) {
        return errorResponse("복원할 백업 파일명(backupFile)이 필요합니다.");
      }
      if (args.confirm !== "RESTORE") {
        return jsonResponse({
          success: false,
          message: `DB 복원은 현재 데이터를 덮어씁니다. confirm: "RESTORE"를 포함하여 다시 호출하세요.`,
          backupFile: args.backupFile,
        });
      }

      /* 경로 순회 공격 방지: 파일명만 추출하여 safety-backups 디렉토리 내로 제한 */
      const safeName = path.basename(args.backupFile);
      const backupDir = path.join(path.dirname(config.sqlcipher.dbPath), "safety-backups");
      const backupPath = path.join(backupDir, safeName);
      const resolved = path.resolve(backupPath);
      if (!resolved.startsWith(path.resolve(backupDir))) {
        return errorResponse("유효하지 않은 백업 파일명입니다.");
      }
      const { existsSync } = await import("fs");
      if (!existsSync(backupPath)) {
        return errorResponse(`백업 파일을 찾을 수 없습니다: ${safeName}`);
      }

      /* 1. 현재 DB를 먼저 백업 */
      if (isSqlcipherReady()) {
        await localBackupSqlcipher("pre-restore");
      }

      /* 2. DB 연결 닫기 */
      closeSqlcipher();

      /* 3. 백업 파일로 덮어쓰기 */
      await copyFile(backupPath, config.sqlcipher.dbPath);
      info(`[RESTORE] SQLCipher DB 복원됨: ${backupPath} → ${config.sqlcipher.dbPath}`);

      /* 4. DB 재초기화 */
      await initSqlcipher();

      return jsonResponse({
        success: true,
        message: `SQLCipher DB가 ${args.backupFile}에서 복원되었습니다.`,
        backupFile: args.backupFile,
      });
    }
  }
}

