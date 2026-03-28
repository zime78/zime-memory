/**
 * 환경 변수 기반 설정 모듈
 * Zod로 환경 변수를 검증하고 타입 안전한 설정 객체를 내보낸다.
 */

import path from "path";
import { z } from "zod";

/** 임베딩 모델별 벡터 차원 수 매핑 */
const embeddingModels: Record<string, number> = {
  "bge-m3": 1024,
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "snowflake-arctic-embed": 1024,
  "all-minilm": 384,
};

/** 환경 변수 스키마 정의 */
const envSchema = z.object({
  /** Qdrant 연결 */
  QDRANT_URL: z.string().optional().default("http://localhost:6333"),
  COLLECTION_NAME: z.string().optional().default("memories"),
  QDRANT_API_KEY: z.string().optional(),

  /** 임베딩 프로바이더 선택: ollama(기본), local(코드 기반), off(비활성) */
  EMBEDDING_PROVIDER: z
    .enum(["ollama", "local", "off"])
    .optional()
    .default("ollama"),

  /** Ollama 임베딩 */
  OLLAMA_URL: z.string().optional().default("http://localhost:11434"),
  EMBEDDING_MODEL: z.string().optional().default("bge-m3"),

  /** 로컬 임베딩 모델 (local 모드 전용) */
  LOCAL_EMBEDDING_MODEL: z
    .string()
    .optional()
    .default("Xenova/all-MiniLM-L6-v2"),

  /** Ollama LLM (선택, 요약 기능에만 사용) */
  LLM_MODEL: z.string().optional().default(""),

  /** 백업 설정 */
  NAS_BACKUP_PATH: z.string().optional(),
  BACKUP_INTERVAL_HOURS: z.coerce.number().optional().default(6),
  DISABLE_LOCAL_BACKUP: z.string().optional(),
  SOFT_DELETE_RETENTION_DAYS: z.coerce.number().optional().default(30),
  MAX_QDRANT_SNAPSHOTS: z.coerce.number().optional().default(20),
  MAX_NAS_BACKUPS: z.coerce.number().optional().default(20),

  /** Obsidian 설정 */
  OBSIDIAN_VAULT_PATH: z.string().optional(),

  /** MinIO 오브젝트 스토리지 */
  MINIO_ENDPOINT: z.string().optional().default("localhost"),
  MINIO_PORT: z.coerce.number().optional().default(9000),
  MINIO_USE_SSL: z.string().optional(),
  MINIO_ACCESS_KEY: z.string().optional(),
  MINIO_SECRET_KEY: z.string().optional(),
  MINIO_IMAGES_BUCKET: z.string().optional().default("zime-memory-images"),
  MINIO_FILES_BUCKET: z.string().optional().default("zime-memory-files"),
  MINIO_RETENTION_DAYS: z.coerce.number().optional().default(30),
  MINIO_PRESIGNED_EXPIRY: z.coerce.number().optional().default(3600),
  MINIO_MAX_FILE_SIZE: z.coerce.number().optional().default(50 * 1024 * 1024),

  /** SQLCipher 암호화 DB */
  SQLCIPHER_DB_PATH: z.string().optional(),
  ZIME_ENCRYPTION_KEY: z.string().optional(),

  /** 읽기 캐시 (원격 접속 모드용) */
  CACHE_ENABLED: z.string().optional(),
  CACHE_DB_PATH: z.string().optional(),
  CACHE_MAX_AGE_DAYS: z.coerce.number().optional().default(7),
  CACHE_MAX_ENTRIES: z.coerce.number().optional().default(2000),
  CACHE_PRUNE_INTERVAL_HOURS: z.coerce.number().optional().default(12),
});

/** 환경 변수 파싱 (알 수 없는 키는 무시) */
const env = envSchema.parse(process.env);

const embeddingModel = env.EMBEDDING_MODEL;

export const config = {
  /** Qdrant 벡터 데이터베이스 연결 설정 */
  qdrant: {
    url: env.QDRANT_URL,
    collectionName: env.COLLECTION_NAME,
    apiKey: env.QDRANT_API_KEY,
  },

  /** Ollama 임베딩 서비스 연결 설정 */
  ollama: {
    url: env.OLLAMA_URL,
    model: embeddingModel,
    /** 현재 모델의 벡터 차원 수 (매핑에 없으면 1024 기본값) */
    dimensions: embeddingModels[embeddingModel] ?? 1024,
  },

  /** 임베딩 프로바이더 설정 */
  embedding: {
    /** 프로바이더 종류: "ollama" | "local" | "off" */
    provider: env.EMBEDDING_PROVIDER as "ollama" | "local" | "off",
    /** 로컬 임베딩 모델 (local 모드 전용) */
    localModel: env.LOCAL_EMBEDDING_MODEL,
  },

  /** Ollama LLM 서비스 설정 (선택사항: 요약 기능에만 사용) */
  /** 태그는 Claude가 memory_save 호출 시 직접 제공하므로 autoTag용 LLM은 불필요하다. */
  /** memory_summarize 사용 시에만 텍스트 생성 가능한 LLM 모델을 설치하고 LLM_MODEL을 설정한다. */
  llm: {
    model: env.LLM_MODEL,
  },

  /** 임베딩 모델 매핑 (모델 전환 시 참조) */
  embeddingModels,

  /** 백업 설정 */
  backup: {
    /** NAS 백업 경로 (선택, 미설정 시 NAS 복사 비활성) */
    nasPath: env.NAS_BACKUP_PATH,
    /** 자동 백업 주기 (시간 단위, 기본 6시간) */
    intervalHours: env.BACKUP_INTERVAL_HOURS,
    /** 로컬 안전 백업 활성화 여부 (기본: true, NAS 없이도 data/safety-backups에 저장) */
    localBackupEnabled: env.DISABLE_LOCAL_BACKUP !== "true",
    /** soft delete 보존 기간 (일, 기본 30) */
    softDeleteRetentionDays: env.SOFT_DELETE_RETENTION_DAYS,
    /** Qdrant 스냅샷 최대 보관 수 (기본 20) */
    maxQdrantSnapshots: env.MAX_QDRANT_SNAPSHOTS,
    /** NAS 디렉토리별 백업 최대 보관 수 (기본 20) */
    maxNasBackups: env.MAX_NAS_BACKUPS,
  },

  /** Obsidian 설정 */
  obsidian: {
    /** Obsidian vault 기본 경로 (선택) */
    vaultPath: env.OBSIDIAN_VAULT_PATH,
  },

  /** MinIO 오브젝트 스토리지 연결 설정 (이미지/파일 바이너리 저장) */
  minio: {
    /** MinIO 엔드포인트 (호스트명, 프로토콜 제외) */
    endPoint: env.MINIO_ENDPOINT,
    /** MinIO 포트 */
    port: env.MINIO_PORT,
    /** SSL 사용 여부 */
    useSSL: env.MINIO_USE_SSL === "true",
    /** MinIO 접근 키 (필수, 미설정 시 images/files store 비활성) */
    accessKey: env.MINIO_ACCESS_KEY,
    /** MinIO 비밀 키 (필수, 미설정 시 images/files store 비활성) */
    secretKey: env.MINIO_SECRET_KEY,
    /** 이미지 버킷명 */
    imagesBucket: env.MINIO_IMAGES_BUCKET,
    /** 파일 버킷명 */
    filesBucket: env.MINIO_FILES_BUCKET,
    /** Object Lock 보존 기간 (일, 기본 30일) */
    retentionDays: env.MINIO_RETENTION_DAYS,
    /** presigned URL 유효 기간 (초, 기본 1시간) */
    presignedExpiry: env.MINIO_PRESIGNED_EXPIRY,
    /** 업로드 최대 파일 크기 (bytes, 기본 50MB) */
    maxFileSize: env.MINIO_MAX_FILE_SIZE,
  },

  /** SQLCipher 암호화 데이터베이스 설정 (시크릿 저장) */
  sqlcipher: {
    /** DB 파일 경로 (절대경로 사용 — CWD에 따라 다른 DB를 참조하는 문제 방지) */
    dbPath:
      env.SQLCIPHER_DB_PATH ||
      path.join(
        path.dirname(new URL(import.meta.url).pathname),
        "..",
        "data",
        "secrets.db"
      ),
    /** 암호화 키 (필수, 미설정 시 secrets store 비활성) */
    encryptionKey: env.ZIME_ENCRYPTION_KEY,
  },

  /** 읽기 캐시 설정 (원격 접속 모드용, 오프라인 폴백) */
  cache: {
    /** 캐시 활성화 여부 (기본 false, 원격 접속 클라이언트에서 true로 설정) */
    enabled: env.CACHE_ENABLED === "true",
    /** 캐시 DB 파일 경로 */
    dbPath:
      env.CACHE_DB_PATH ||
      path.join(
        path.dirname(new URL(import.meta.url).pathname),
        "..",
        "data",
        "cache.db"
      ),
    /** 캐시 최대 보관 일수 (기본 7일) */
    maxAgeDays: env.CACHE_MAX_AGE_DAYS,
    /** 캐시 최대 항목 수 (기본 2000) */
    maxEntries: env.CACHE_MAX_ENTRIES,
    /** 캐시 프루닝 주기 (시간 단위, 기본 12시간) */
    pruneIntervalHours: env.CACHE_PRUNE_INTERVAL_HOURS,
  },
};
