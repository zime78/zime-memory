/**
 * MCP 도구 레지스트리
 * 모든 도구의 정의(이름, 설명, 스키마, 핸들러)를 단일 배열로 관리한다.
 * 새 도구 추가 = 이 배열에 1줄 추가 + 도구 파일 1개 생성.
 */

import { ZodType } from "zod";

import { memorySaveSchema, memorySave } from "./memorySave.js";
import { memorySearchSchema, memorySearch } from "./memorySearch.js";
import { memoryListSchema, memoryList } from "./memoryList.js";
import { memoryDeleteSchema, memoryDelete } from "./memoryDelete.js";
import { memoryStatsSchema, memoryStats } from "./memoryStats.js";
import { memoryUpdateSchema, memoryUpdate } from "./memoryUpdate.js";
import { memoryGetSchema, memoryGet } from "./memoryGet.js";
import { memoryExportSchema, memoryExport } from "./memoryExport.js";
import { memoryImportSchema, memoryImport } from "./memoryImport.js";
import { memoryCountSchema, memoryCount } from "./memoryCount.js";
import { memoryBulkDeleteSchema, memoryBulkDelete } from "./memoryBulkDelete.js";
import { memoryReindexSchema, memoryReindex } from "./memoryReindex.js";
import { memoryLinkSchema, memoryLink } from "./memoryLink.js";
import { memorySummarizeSchema, memorySummarize } from "./memorySummarize.js";
import { memoryBackupSchema, memoryBackup } from "./memoryBackup.js";
import { memoryObsidianSyncSchema, memoryObsidianSync } from "./memoryObsidianSync.js";
import { memoryDownloadSchema, memoryDownload } from "./memoryDownload.js";
import { memoryMigrateSchema, memoryMigrate } from "./memoryMigrate.js";
import { memoryRestoreSchema, memoryRestore } from "./memoryRestore.js";

/** MCP 도구 정의 인터페이스 */
export interface ToolDefinition {
  /** 도구 이름 (MCP 프로토콜용) */
  name: string;
  /** 도구 설명 (Claude에게 노출) */
  description: string;
  /** Zod 입력 스키마 */
  schema: ZodType<any>;
  /** 도구 핸들러 함수 */
  handler: (args: any) => Promise<any>;
}

export const toolRegistry: ToolDefinition[] = [
  {
    name: "memory_save",
    description:
      "메모리를 벡터 임베딩과 함께 저장한다. 텍스트 내용을 Qdrant에 벡터화하여 저장하며, 카테고리/태그/우선순위로 분류할 수 있다. status로 임시 저장(draft) 가능하고, TTL로 자동 만료를 설정할 수 있다. 저장 시 관련 메모리를 추천한다.",
    schema: memorySaveSchema,
    handler: memorySave,
  },
  {
    name: "memory_search",
    description:
      "벡터 유사도 기반으로 메모리를 검색한다. 자연어 쿼리를 임베딩하여 의미적으로 유사한 메모리를 찾는다. 카테고리/태그/우선순위/상태 필터와 날짜 범위(fromDate/toDate) 필터를 추가할 수 있다. 기본적으로 published 상태만 검색한다.",
    schema: memorySearchSchema,
    handler: memorySearch,
  },
  {
    name: "memory_list",
    description:
      "필터 조건으로 메모리 목록을 조회한다. 벡터 검색 없이 카테고리/태그/우선순위/상태 필터와 날짜 범위(fromDate/toDate)로 메모리를 브라우징한다. 페이지네이션을 지원한다. 기본적으로 published 상태만 조회한다.",
    schema: memoryListSchema,
    handler: memoryList,
  },
  {
    name: "memory_delete",
    description:
      "ID로 메모리를 삭제한다. UUID를 지정하여 특정 메모리를 Qdrant에서 제거한다.",
    schema: memoryDeleteSchema,
    handler: memoryDelete,
  },
  {
    name: "memory_stats",
    description:
      "메모리 컬렉션의 통계 정보를 조회한다. 저장된 메모리 수, 컬렉션 상태, 세그먼트 수 등을 확인한다.",
    schema: memoryStatsSchema,
    handler: memoryStats,
  },
  {
    name: "memory_update",
    description:
      "기존 메모리를 수정한다. ID로 메모리를 찾아 내용, 제목, 태그, 카테고리, 우선순위, 출처, 상태(status), TTL을 선택적으로 변경한다. 내용/제목 변경 시 임베딩이 재생성된다. status를 published로 변경하면 expiresAt이 제거된다.",
    schema: memoryUpdateSchema,
    handler: memoryUpdate,
  },
  {
    name: "memory_get",
    description:
      "ID로 단일 메모리를 조회한다. 내용을 잘라내지 않고 전체 페이로드를 반환하며, 관련 메모리(유사도 0.5 이상)를 최대 3건 추천한다.",
    schema: memoryGetSchema,
    handler: memoryGet,
  },
  {
    name: "memory_export",
    description:
      "전체 메모리를 JSON으로 내보낸다. 선택적으로 카테고리/태그/우선순위 필터를 적용할 수 있다. 내용을 잘라내지 않고 전체를 포함한다.",
    schema: memoryExportSchema,
    handler: memoryExport,
  },
  {
    name: "memory_import",
    description:
      "JSON 배열에서 메모리를 일괄 복원한다. 각 메모리에 대해 임베딩을 자동 생성하며, 기존 ID 보존과 중복 건너뛰기를 지원한다.",
    schema: memoryImportSchema,
    handler: memoryImport,
  },
  {
    name: "memory_count",
    description:
      "메모리 건수를 조회한다. groupBy를 지정하면 카테고리/우선순위/태그별 분류 건수를 반환한다.",
    schema: memoryCountSchema,
    handler: memoryCount,
  },
  {
    name: "memory_bulk_delete",
    description:
      "필터 기반으로 메모리를 일괄 삭제한다. 카테고리/태그/우선순위 중 최소 하나의 필터가 필요하며, 전체 삭제를 방지한다.",
    schema: memoryBulkDeleteSchema,
    handler: memoryBulkDelete,
  },
  {
    name: "memory_reindex",
    description:
      '임베딩 모델 변경 시 전체 메모리의 벡터를 재생성한다. confirm에 "CONFIRM"을 입력해야 실행되며, 벡터 차원 불일치 해소에 사용한다.',
    schema: memoryReindexSchema,
    handler: memoryReindex,
  },
  {
    name: "memory_link",
    description:
      "두 메모리 간 명시적 관계를 설정한다. sourceId와 targetId를 지정하여 연결하며, 기본적으로 양방향 관계를 생성한다.",
    schema: memoryLinkSchema,
    handler: memoryLink,
  },
  {
    name: "memory_summarize",
    description:
      "필터 조건에 맞는 메모리를 LLM으로 종합 요약한다. 카테고리나 태그별로 메모리를 그룹화하여 핵심 주제와 인사이트를 정리한다.",
    schema: memorySummarizeSchema,
    handler: memorySummarize,
  },
  {
    name: "memory_backup",
    description:
      "Qdrant 스냅샷을 생성하고 선택적으로 NAS에 복사한다. listOnly로 기존 스냅샷 목록을 조회할 수 있다.",
    schema: memoryBackupSchema,
    handler: memoryBackup,
  },
  {
    name: "memory_obsidian_sync",
    description:
      "Obsidian vault와 zime-memory 간 양방향 동기화를 수행한다. import/export/bidirectional 방향을 지정할 수 있으며, YAML frontmatter로 메타데이터를 매핑한다.",
    schema: memoryObsidianSyncSchema,
    handler: memoryObsidianSync,
  },
  {
    name: "memory_download",
    description:
      "images/files store의 바이너리를 다운로드한다. presigned URL 또는 base64 데이터를 반환한다.",
    schema: memoryDownloadSchema,
    handler: memoryDownload,
  },
  {
    name: "memory_migrate",
    description:
      '기존 메모리 데이터에 store 태그를 추가한다. analyze 모드로 분석하거나 tag-store 모드로 "general" 태그를 부여한다.',
    schema: memoryMigrateSchema,
    handler: memoryMigrate,
  },
  {
    name: "memory_restore",
    description:
      'soft-delete된 메모리를 복원하거나, 백업에서 SQLCipher DB를 복원한다. action: "list-deleted"(삭제 항목 목록), "restore-item"(단일 복원), "list-backups"(백업 목록), "restore-sqlcipher"(DB 복원, confirm: "RESTORE" 필수).',
    schema: memoryRestoreSchema,
    handler: memoryRestore,
  },
];
