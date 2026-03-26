/**
 * 메모리 데이터 타입 정의 모듈
 * 메모리 카테고리, 우선순위, 저장소, 페이로드 인터페이스를 정의한다.
 */

/** 메모리 저장소 타입 — 데이터가 저장될 백엔드를 결정한다 */
export const MemoryStore = {
  /** 기존 Qdrant 텍스트 메모리 (기본값) */
  GENERAL: "general",
  /** MinIO 이미지 바이너리 + Qdrant 메타데이터 */
  IMAGES: "images",
  /** MinIO 파일 바이너리 + Qdrant 메타데이터 */
  FILES: "files",
  /** SQLCipher 암호화 DB (API키, 토큰, 비밀번호) */
  SECRETS: "secrets",
} as const;

export type MemoryStore = (typeof MemoryStore)[keyof typeof MemoryStore];

/** 메모리 카테고리 - 저장되는 정보의 종류를 분류한다 */
export const MemoryCategory = {
  NOTE: "note",
  KNOWLEDGE: "knowledge",
  REFERENCE: "reference",
  SNIPPET: "snippet",
  DECISION: "decision",
  CUSTOM: "custom",
} as const;

export type MemoryCategory = (typeof MemoryCategory)[keyof typeof MemoryCategory];

/** 메모리 우선순위 - 정보의 중요도를 나타낸다 */
export const MemoryPriority = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical",
} as const;

export type MemoryPriority = (typeof MemoryPriority)[keyof typeof MemoryPriority];

/** Qdrant에 저장되는 메모리 페이로드 구조 */
export interface MemoryPayload {
  /** 메모리 본문 내용 */
  content: string;
  /** 메모리 제목 (선택) */
  title?: string;
  /** 분류를 위한 태그 목록 */
  tags: string[];
  /** 메모리 카테고리 */
  category: MemoryCategory;
  /** 우선순위 */
  priority: MemoryPriority;
  /** 출처 정보 (선택) */
  source?: string;
  /** 메모리 상태 - published(기본) 또는 draft(임시 저장) */
  status?: "published" | "draft";
  /** TTL 원본 문자열 (예: "3d", "12h") */
  ttl?: string;
  /** 만료 일시 (ISO 8601, ttl 기반 자동 계산) */
  expiresAt?: string;
  /** 중요 메모리 고정 여부 — 검색/목록에서 상단에 표시된다 */
  pinned?: boolean;
  /** 상위 메모리 ID — 계층 구조의 부모를 가리킨다 */
  parentId?: string;
  /** 연결된 메모리 ID 목록 — 명시적 관계를 표현한다 */
  relatedIds?: string[];
  /** Obsidian vault 내 파일 경로 — 동기화 추적용 */
  obsidianPath?: string;
  /** 생성 일시 (ISO 8601) */
  createdAt: string;
  /** 수정 일시 (ISO 8601) */
  updatedAt: string;
  /** 저장소 타입 — store 라우팅에 사용 (기본: general) */
  store?: MemoryStore;
  /** MinIO 오브젝트 키 — images/files store 전용 */
  objectKey?: string;
  /** 원본 파일명 — images/files store 전용 */
  originalName?: string;
  /** MIME 타입 — images/files store 전용 */
  mimeType?: string;
  /** 파일 크기 (bytes) — images/files store 전용 */
  fileSize?: number;
  /** MinIO 버킷명 — images/files store 전용 */
  bucket?: string;
  /** 파일/이미지 설명 — images/files store의 임베딩 생성에 사용 */
  description?: string;
  /** 이미지 해상도 — images store 전용 */
  resolution?: { width: number; height: number };
}

/** store 라우팅 결과의 공통 형태 */
export interface RouteResult {
  id: string;
  store: MemoryStore;
  [key: string]: unknown;
}

/** 시크릿 유형 — 저장되는 비밀 정보의 종류를 분류한다 */
export const SecretType = {
  API_KEY: "api-key",
  TOKEN: "token",
  PASSWORD: "password",
  CERTIFICATE: "certificate",
  OTHER: "other",
} as const;

export type SecretType = (typeof SecretType)[keyof typeof SecretType];

/** SQLCipher secrets 테이블의 행 구조 */
export interface SecretRow {
  /** UUID */
  id: string;
  /** 시크릿 이름 (예: "GitHub API Key") */
  name: string;
  /** 시크릿 값 (DB 전체가 암호화되므로 평문 저장) */
  value: string;
  /** 시크릿 유형 */
  secretType: SecretType;
  /** 관련 서비스명 (예: "github", "openai") */
  service?: string;
  /** 분류용 태그 목록 */
  tags: string[];
  /** 메모/설명 */
  notes?: string;
  /** 만료 일시 (ISO 8601, 선택) */
  expiresAt?: string;
  /** 생성 일시 (ISO 8601) */
  createdAt: string;
  /** 수정 일시 (ISO 8601) */
  updatedAt: string;
  /** 소프트 삭제 일시 (ISO 8601, 삭제된 경우에만 존재) */
  deletedAt?: string;
}
