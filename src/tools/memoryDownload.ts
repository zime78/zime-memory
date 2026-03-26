/**
 * memory_download 도구
 * images/files store의 바이너리를 다운로드한다.
 * presigned URL 또는 base64 인코딩된 데이터를 반환한다.
 */

import { z } from "zod";
import { getMemoryById } from "../services/qdrantService.js";
import { getPresignedUrl, downloadObject, isMinioReady } from "../services/minioService.js";
import { jsonResponse, errorResponse } from "../utils/response.js";

/** memory_download 도구의 입력 스키마 */
export const memoryDownloadSchema = z.object({
  /** 다운로드할 메모리의 UUID (필수) */
  id: z.string().uuid("유효한 UUID 형식이어야 합니다"),
  /** 저장소 타입 (images 또는 files만 가능) */
  store: z.enum(["images", "files"]),
  /** presigned URL만 반환할지 여부 (기본: true, false면 base64 데이터 반환) */
  urlOnly: z.boolean().default(true),
});

export type MemoryDownloadInput = z.infer<typeof memoryDownloadSchema>;

/**
 * images/files store의 바이너리를 다운로드한다.
 * Qdrant에서 메타데이터를 조회한 뒤 MinIO에서 파일을 가져온다.
 */
export async function memoryDownload(args: MemoryDownloadInput) {
  /* C3 fix: MinIO 가용성 가드 */
  if (!isMinioReady()) {
    return errorResponse("MinIO가 초기화되지 않았습니다. MINIO_ACCESS_KEY/MINIO_SECRET_KEY 환경변수를 확인하세요.");
  }

  /* Qdrant에서 메타데이터 조회 */
  const result = await getMemoryById(args.id);

  if (!result) {
    return errorResponse(`메모리를 찾을 수 없습니다 (ID: ${args.id})`);
  }

  const payload = result.payload as Record<string, unknown> | null;
  const objectKey = payload?.objectKey as string | undefined;
  const bucket = payload?.bucket as string | undefined;

  if (!objectKey || !bucket) {
    return errorResponse("이 메모리에는 연결된 파일이 없습니다.");
  }

  if (args.urlOnly) {
    /* presigned URL만 반환 */
    const url = await getPresignedUrl(bucket, objectKey);
    return jsonResponse({
      success: true,
      id: args.id,
      store: args.store,
      originalName: payload?.originalName,
      mimeType: payload?.mimeType,
      fileSize: payload?.fileSize,
      presignedUrl: url,
      message: "presigned URL이 생성되었습니다 (1시간 유효)",
    } as Record<string, unknown>);
  }

  /* base64로 바이너리 데이터 반환 */
  const buffer = await downloadObject(bucket, objectKey);
  return jsonResponse({
    success: true,
    id: args.id,
    store: args.store,
    originalName: payload?.originalName,
    mimeType: payload?.mimeType,
    fileSize: payload?.fileSize,
    data: buffer.toString("base64"),
    encoding: "base64",
  } as Record<string, unknown>);
}
