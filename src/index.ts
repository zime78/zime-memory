/**
 * zime-memory MCP 서버 진입점
 * Qdrant 벡터 DB와 Ollama 임베딩을 활용한 메모리 관리 MCP 서버.
 * shrimp-task-manager 패턴을 따라 구현되었다.
 */

/* 다른 모듈보다 먼저 .env를 로드한다 (ES 모듈 import 순서 보장) */
import "./env.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  CallToolRequest,
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { checkHealth } from "./services/healthCheck.js";
import { ensureCollection, deleteExpiredDrafts, getCollectionInfo, purgeExpiredQdrantDeletes } from "./services/qdrantService.js";
import { config } from "./config.js";
import { createSnapshot, copySnapshotToNas, pruneQdrantSnapshots } from "./services/backupService.js";
import { info, warn, error as logError } from "./utils/logger.js";
import { initMinio } from "./services/minioService.js";
import { initSqlcipher, closeSqlcipher, isSqlcipherReady, countSecrets, purgeExpiredDeletes } from "./services/sqlcipherService.js";
import { validateSqlcipherIntegrity, validateQdrantIntegrity, localBackupSqlcipher, updateSqlcipherWatermark, updateQdrantWatermark } from "./services/safetyService.js";
import { initCache, closeCache, pruneCache, getCacheStats } from "./services/cacheService.js";
import { startMonitoring, stopMonitoring, isOnline } from "./services/connectionMonitor.js";
import { INSTRUCTIONS } from "./instructions.js";
import { toolRegistry } from "./tools/registry.js";

async function main() {
  try {
    // 임베딩 프로바이더 모드 표시
    info(`임베딩 프로바이더: ${config.embedding.provider}`);
    if (config.embedding.provider === "off") {
      warn("임베딩이 비활성화되었습니다. 의미 기반 검색을 사용할 수 없습니다.");
    } else if (config.embedding.provider === "local") {
      info(`로컬 임베딩 모델: ${config.embedding.localModel}`);
    }

    // 헬스 체크: Qdrant, Ollama/Provider 연결 확인
    info("서비스 헬스 체크 시작...");
    const health = await checkHealth();
    info(`Qdrant: ${health.qdrant}`);
    info(`임베딩: ${health.ollama}`);
    info(`MinIO: ${health.minio}`);
    info(`SQLCipher: ${health.sqlcipher}`);

    // Qdrant 컬렉션 초기화
    info("Qdrant 컬렉션 초기화 중...");
    await ensureCollection();

    // MinIO 버킷 초기화
    info("MinIO 버킷 초기화 중...");
    try {
      await initMinio();
      info("MinIO 초기화 완료");
    } catch (err) {
      logError("MinIO 초기화 실패 (images/files store 비활성):", err);
    }

    // SQLCipher DB 초기화 (암호화 키 설정 시에만)
    if (config.sqlcipher.encryptionKey) {
      info("SQLCipher 데이터베이스 초기화 중...");
      try {
        await initSqlcipher();
        info("SQLCipher 초기화 완료");
      } catch (err) {
        logError("SQLCipher 초기화 실패 (secrets store 비활성):", err);
      }
    } else {
      info("SQLCipher: 암호화 키 미설정, secrets store 비활성");
    }

    // ── 무결성 검증 ──
    try {
      const qdrantInfo = await getCollectionInfo();
      const qdrantCheck = validateQdrantIntegrity(qdrantInfo.pointsCount);
      if (!qdrantCheck.ok) {
        warn(`[INTEGRITY] ${qdrantCheck.warning}`);
      } else {
        info(`[INTEGRITY] Qdrant 정상 (${qdrantCheck.currentCount}건)`);
      }
    } catch (err) {
      logError("[INTEGRITY] Qdrant 무결성 검증 실패:", err);
    }

    if (isSqlcipherReady()) {
      try {
        const secretsCount = countSecrets();
        const sqlcipherCheck = validateSqlcipherIntegrity(secretsCount.total);
        if (!sqlcipherCheck.ok) {
          warn(`[INTEGRITY] ${sqlcipherCheck.warning}`);
        } else {
          info(`[INTEGRITY] SQLCipher 정상 (${sqlcipherCheck.currentCount}건)`);
        }
      } catch (err) {
        logError("[INTEGRITY] SQLCipher 무결성 검증 실패:", err);
      }
    }

    // ── 읽기 캐시 + 연결 모니터 초기화 ──
    if (config.cache.enabled) {
      initCache();
      startMonitoring();
      info(`[CACHE] 초기화 완료 (현재: ${isOnline() ? "온라인" : "오프라인"})`);
    }

    // TTL 자동 만료 스케줄러: 5분마다 만료된 draft 메모리를 정리한다
    const TTL_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
    const ttlCleanupTimer = setInterval(async () => {
      info("TTL 만료 메모리 정리 중...");
      try {
        await deleteExpiredDrafts();
        info("TTL 만료 메모리 정리 완료");
      } catch (err) {
        logError("TTL 만료 메모리 정리 실패:", err);
      }
    }, TTL_CLEANUP_INTERVAL_MS);

    // 자동 백업 스케줄러: 기본 6시간 간격 (NAS 없이도 로컬 백업 실행)
    let backupTimer: ReturnType<typeof setInterval> | undefined;
    if (config.backup.intervalHours) {
      const BACKUP_INTERVAL_MS = config.backup.intervalHours * 60 * 60 * 1000;

      // 서버 시작 1분 후 첫 백업
      setTimeout(async () => {
        try {
          info("[AUTO-BACKUP] 서버 시작 후 첫 자동 백업 실행...");
          if (config.backup.localBackupEnabled && isSqlcipherReady()) {
            await localBackupSqlcipher("auto-startup");
          }
          const snapshot = await createSnapshot();
          info(`[AUTO-BACKUP] 시작 백업 완료: ${snapshot.name}`);
          // 오래된 스냅샷 프루닝
          await pruneQdrantSnapshots(config.backup.maxQdrantSnapshots);
          // 워터마크 갱신
          const qdrantInfo = await getCollectionInfo();
          updateQdrantWatermark(qdrantInfo.pointsCount);
          if (isSqlcipherReady()) {
            updateSqlcipherWatermark(countSecrets().total);
          }
        } catch (err) {
          warn(`[AUTO-BACKUP] 시작 백업 실패: ${err}`);
        }
      }, 60_000);

      backupTimer = setInterval(async () => {
        info("[AUTO-BACKUP] 주기적 백업 실행 중...");
        try {
          if (config.backup.localBackupEnabled && isSqlcipherReady()) {
            await localBackupSqlcipher("auto-scheduled");
          }
          const snapshot = await createSnapshot();
          info(`[AUTO-BACKUP] 스냅샷: ${snapshot.name}`);
          if (config.backup.nasPath) {
            await copySnapshotToNas(snapshot.name);
            info("[AUTO-BACKUP] NAS 백업 복사 완료");
          }
          // 오래된 스냅샷 프루닝
          await pruneQdrantSnapshots(config.backup.maxQdrantSnapshots);
          // 워터마크 갱신
          const qdrantInfo = await getCollectionInfo();
          updateQdrantWatermark(qdrantInfo.pointsCount);
          if (isSqlcipherReady()) {
            updateSqlcipherWatermark(countSecrets().total);
          }
        } catch (err) {
          logError("[AUTO-BACKUP] 실패:", err);
        }
      }, BACKUP_INTERVAL_MS);
      info(`[AUTO-BACKUP] 활성화: ${config.backup.intervalHours}시간 간격, 로컬=${config.backup.localBackupEnabled}`);
    }

    // Soft-delete 만료 항목 영구 삭제 스케줄러 (24시간마다)
    const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
    const purgeTimer = setInterval(async () => {
      try {
        if (isSqlcipherReady()) {
          const purged = purgeExpiredDeletes(config.backup.softDeleteRetentionDays);
          if (purged > 0) info(`[PURGE] SQLCipher soft-delete 만료 ${purged}건 영구 삭제`);
        }
        const qdrantPurged = await purgeExpiredQdrantDeletes(config.backup.softDeleteRetentionDays);
        if (qdrantPurged > 0) info(`[PURGE] Qdrant soft-delete 만료 ${qdrantPurged}건 영구 삭제`);
      } catch (err) {
        logError("[PURGE] 실패:", err);
      }
    }, PURGE_INTERVAL_MS);

    // 캐시 프루닝 스케줄러: 기본 12시간 간격
    let cacheTimer: ReturnType<typeof setInterval> | undefined;
    if (config.cache.enabled) {
      const CACHE_PRUNE_INTERVAL_MS = config.cache.pruneIntervalHours * 60 * 60 * 1000;
      cacheTimer = setInterval(() => {
        try {
          const pruned = pruneCache(config.cache.maxAgeDays, config.cache.maxEntries);
          if (pruned > 0) info(`[CACHE] ${pruned}건 오래된 캐시 정리`);
        } catch (err) {
          logError("[CACHE] 프루닝 실패:", err);
        }
      }, CACHE_PRUNE_INTERVAL_MS);
      info(`[CACHE] 프루닝 스케줄러 활성화: ${config.cache.pruneIntervalHours}시간 간격`);
    }

    // 프로세스 종료 시 스케줄러를 정리한다
    const shutdown = () => {
      info("서버 종료 중... 스케줄러 정리");
      clearInterval(ttlCleanupTimer);
      if (backupTimer) clearInterval(backupTimer);
      if (cacheTimer) clearInterval(cacheTimer);
      clearInterval(purgeTimer);
      stopMonitoring();
      closeCache();
      closeSqlcipher();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // MCP 서버 생성
    const server = new Server(
      {
        name: "zime-memory",
        version: "2.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
        instructions: INSTRUCTIONS,
      }
    );

    // 도구 목록 핸들러 등록 - 클라이언트에게 사용 가능한 도구 목록을 반환한다
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: toolRegistry.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: zodToJsonSchema(t.schema),
      })),
    }));

    // 도구 호출 핸들러 등록 - 클라이언트의 도구 호출 요청을 처리한다
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    server.setRequestHandler(
      CallToolRequestSchema,
      async (request: CallToolRequest): Promise<any> => {
        try {
          const args = request.params.arguments ?? {};
          const tool = toolRegistry.find((t) => t.name === request.params.name);

          if (!tool) {
            throw new Error(`도구 "${request.params.name}"은(는) 존재하지 않습니다`);
          }

          const parsedArgs = await tool.schema.safeParseAsync(args);
          if (!parsedArgs.success) {
            throw new Error(`${tool.name} 인자 검증 실패: ${parsedArgs.error.message}`);
          }

          return await tool.handler(parsedArgs.data);
        } catch (error) {
          const errorMsg =
            error instanceof Error ? error.message : String(error);
          return {
            content: [
              {
                type: "text" as const,
                text: `오류 발생: ${errorMsg}`,
              },
            ],
            isError: true,
          };
        }
      }
    );

    // 전송 레이어 연결
    const transport = new StdioServerTransport();
    await server.connect(transport);
    info("zime-memory MCP 서버가 시작되었습니다");
  } catch (error) {
    logError("서버 시작 실패:", error);
    process.exit(1);
  }
}

main().catch(console.error);
