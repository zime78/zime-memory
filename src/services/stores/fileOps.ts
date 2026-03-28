/**
 * images/files store 연산
 * MinIO 바이너리 저장 + Qdrant 메타데이터 이중 쓰기를 담당한다.
 */

import { v4 as uuidv4 } from "uuid";
import fs from "fs/promises";
import path from "path";
import { generateEmbedding } from "../embeddingService.js";
import { upsertMemory } from "../qdrantService.js";
import {
  uploadObject,
  deleteObject as deleteMinioObject,
  resolveBucket,
  isMinioReady,
} from "../minioService.js";
import { config } from "../../config.js";
import { isOnline } from "../connectionMonitor.js";
import { error as logError } from "../../utils/logger.js";
import type { MemoryPayload, RouteResult } from "../../types/index.js";

/**
 * 파일 데이터를 Buffer로 변환한다.
 * base64 문자열 또는 로컬 파일 경로를 지원한다.
 */
async function resolveFileData(args: {
  fileData?: string;
  filePath?: string;
}): Promise<Buffer> {
  let buffer: Buffer;
  if (args.fileData) {
    buffer = Buffer.from(args.fileData, "base64");
  } else if (args.filePath) {
    /* 경로 순회(Path Traversal) 방지 — resolve 후 '..' 포함 여부 검증 */
    const resolved = path.resolve(args.filePath);
    if (resolved.includes("..")) {
      throw new Error(`허용되지 않은 파일 경로입니다: ${args.filePath}`);
    }
    buffer = await fs.readFile(resolved);
  } else {
    throw new Error("fileData 또는 filePath 중 하나를 제공해야 합니다.");
  }

  /* H2: 파일 크기 제한 — 메모리 소진 방지 */
  const maxSize = config.minio.maxFileSize ?? 50 * 1024 * 1024;
  if (buffer.length > maxSize) {
    throw new Error(
      `파일 크기(${buffer.length} bytes)가 제한(${maxSize} bytes)을 초과합니다.`,
    );
  }

  return buffer;
}

/** 파일 확장자를 MIME 타입에서 추출한다 */
function getExtension(mimeType: string, originalName?: string): string {
  if (originalName) {
    const ext = path.extname(originalName);
    if (ext) return ext;
  }
  const mimeMap: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "application/json": ".json",
    "application/zip": ".zip",
  };
  return mimeMap[mimeType] || ".bin";
}

/** images/files store 저장 — MinIO 바이너리 + Qdrant 메타 이중 쓰기 */
export async function saveFile(args: {
  store: "images" | "files";
  fileData?: string;
  filePath?: string;
  mimeType: string;
  originalName?: string;
  description: string;
  tags?: string[];
  category?: string;
  priority?: string;
  resolution?: { width: number; height: number };
}): Promise<RouteResult> {
  /* 오프라인 시 쓰기 차단 */
  if (config.cache.enabled && !isOnline()) {
    throw new Error("오프라인 모드에서는 파일 저장 작업을 수행할 수 없습니다. SSH 터널 연결을 확인하세요.");
  }

  if (!isMinioReady()) {
    throw new Error("MinIO가 초기화되지 않았습니다. MINIO_ACCESS_KEY/MINIO_SECRET_KEY 환경변수를 확인하세요.");
  }

  const id = uuidv4();
  const now = new Date().toISOString();
  const ext = getExtension(args.mimeType, args.originalName);
  const objectKey = `${id}${ext}`;
  const bucket = resolveBucket(args.store);
  const buffer = await resolveFileData(args);

  /* 1. MinIO에 바이너리 업로드 */
  const { etag, size } = await uploadObject(bucket, objectKey, buffer, {
    mimeType: args.mimeType,
    originalName: args.originalName || `file${ext}`,
    memoryId: id,
  });

  /* 2. description으로 임베딩 생성 */
  const vector = await generateEmbedding(args.description);

  /* 3. Qdrant에 메타데이터 저장 */
  const payload: MemoryPayload = {
    content: args.description,
    title: args.originalName,
    tags: args.tags || [],
    category: (args.category as MemoryPayload["category"]) || "reference",
    priority: (args.priority as MemoryPayload["priority"]) || "medium",
    status: "published",
    createdAt: now,
    updatedAt: now,
    store: args.store,
    objectKey,
    originalName: args.originalName || `file${ext}`,
    mimeType: args.mimeType,
    fileSize: size,
    bucket,
    description: args.description,
    resolution: args.resolution,
  };

  try {
    await upsertMemory(id, vector, payload);
  } catch (err) {
    /* Qdrant 실패 시 MinIO 오브젝트 롤백 */
    logError(`Qdrant upsert 실패, MinIO 롤백: ${objectKey}`);
    try {
      await deleteMinioObject(bucket, objectKey);
    } catch (rollbackErr) {
      logError(`MinIO 롤백 실패: ${rollbackErr}`);
    }
    throw err;
  }

  return { id, store: args.store, objectKey, bucket, etag, size };
}
