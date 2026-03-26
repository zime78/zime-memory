/**
 * MinIO 오브젝트 스토리지 서비스
 * 이미지/파일 바이너리의 업로드, 다운로드, 삭제, 목록 조회를 담당한다.
 * S3 호환 API를 사용하며, Object Lock으로 삭제 방지를 지원한다.
 */

import { Client as MinioClient } from "minio";
import { config } from "../config.js";
import { info, error as logError } from "../utils/logger.js";

/** MinIO 클라이언트 싱글턴 인스턴스 */
let _client: MinioClient;

/**
 * MinIO 클라이언트 인스턴스를 반환한다. 미초기화 시 에러를 throw한다.
 */
export function getMinioClient(): MinioClient {
  if (!_client) throw new Error("MinIO가 초기화되지 않았습니다");
  return _client;
}

/** MinIO 클라이언트가 초기화되었는지 확인한다 */
export function isMinioReady(): boolean {
  return _client != null;
}

/**
 * MinIO 클라이언트를 초기화하고 버킷을 확인/생성한다.
 * 서버 시작 시 한 번 호출된다.
 */
export async function initMinio(): Promise<void> {
  /* C2: 크레덴셜 미설정 시 명확한 에러 — 하드코딩 기본값 사용 방지 */
  if (!config.minio.accessKey || !config.minio.secretKey) {
    throw new Error(
      "images/files store를 사용하려면 MINIO_ACCESS_KEY와 MINIO_SECRET_KEY 환경변수를 설정하세요.",
    );
  }

  _client = new MinioClient({
    endPoint: config.minio.endPoint,
    port: config.minio.port,
    useSSL: config.minio.useSSL,
    accessKey: config.minio.accessKey,
    secretKey: config.minio.secretKey,
  });

  const buckets = [config.minio.imagesBucket, config.minio.filesBucket];

  for (const bucket of buckets) {
    const exists = await _client.bucketExists(bucket);
    if (!exists) {
      /* Object Lock 활성화된 버킷 생성 (삭제 방지) */
      try {
        await _client.makeBucket(bucket, "", { ObjectLocking: true });
        info(`MinIO 버킷 생성됨 (Object Lock 활성): ${bucket}`);

        /* GOVERNANCE 모드로 보존 정책 설정 — 지정 기간 동안 삭제 방지 */
        await _client.setObjectLockConfig(bucket, {
          mode: "GOVERNANCE",
          unit: "Days",
          validity: config.minio.retentionDays,
        });
        info(`MinIO Object Lock 설정됨: ${bucket} (${config.minio.retentionDays}일 GOVERNANCE)`);
      } catch (lockErr) {
        /* Object Lock 미지원 환경이면 일반 버킷으로 생성 */
        logError(`Object Lock 버킷 생성 실패, 일반 버킷으로 재시도: ${lockErr}`);
        try {
          await _client.makeBucket(bucket, "");
          info(`MinIO 버킷 생성됨 (Object Lock 없음): ${bucket}`);
        } catch {
          /* 이미 생성됐을 수 있음 (경합 조건) */
        }
      }
    } else {
      info(`MinIO 버킷 확인됨: ${bucket}`);
      /* 기존 버킷에 Object Lock 설정 시도 (실패 시 경고만) */
      try {
        await _client.setObjectLockConfig(bucket, {
          mode: "GOVERNANCE",
          unit: "Days",
          validity: config.minio.retentionDays,
        });
        info(`MinIO Object Lock 설정 갱신됨: ${bucket}`);
      } catch {
        /* 기존 버킷이 Object Lock 없이 생성됐으면 설정 불가 — 경고만 출력 */
        info(`MinIO Object Lock 미지원 버킷 (기존): ${bucket} — 버킷 재생성 필요`);
      }
    }
  }
}

/** store 타입에 따라 버킷명을 반환한다 */
export function resolveBucket(store: "images" | "files"): string {
  return store === "images"
    ? config.minio.imagesBucket
    : config.minio.filesBucket;
}

/**
 * 파일 바이너리를 MinIO에 업로드한다.
 * @param bucket - 대상 버킷명
 * @param objectKey - 오브젝트 키 (예: "uuid.png")
 * @param data - 파일 바이너리 데이터
 * @param metadata - 파일 메타데이터
 * @returns etag와 파일 크기
 */
export async function uploadObject(
  bucket: string,
  objectKey: string,
  data: Buffer,
  metadata: {
    mimeType: string;
    originalName: string;
    memoryId: string;
  },
): Promise<{ etag: string; size: number }> {
  const result = await getMinioClient().putObject(bucket, objectKey, data, data.length, {
    "Content-Type": metadata.mimeType,
    "x-amz-meta-original-name": metadata.originalName,
    "x-amz-meta-memory-id": metadata.memoryId,
  });

  info(`MinIO 업로드 완료: ${bucket}/${objectKey} (${data.length} bytes)`);

  return {
    etag: result.etag,
    size: data.length,
  };
}

/**
 * MinIO에서 오브젝트를 다운로드하여 Buffer로 반환한다.
 * 주의: 전체 파일을 메모리에 로드한다. 대용량 파일은 presigned URL 사용을 권장한다.
 * @param bucket - 대상 버킷명
 * @param objectKey - 오브젝트 키
 * @returns 파일 바이너리 데이터
 */
export async function downloadObject(
  bucket: string,
  objectKey: string,
): Promise<Buffer> {
  const stream = await getMinioClient().getObject(bucket, objectKey);
  const chunks: Buffer[] = [];

  return new Promise((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/**
 * 오브젝트를 삭제한다.
 * Object Lock 보존 기간이 남아 있으면 삭제가 거부된다.
 * @param bucket - 대상 버킷명
 * @param objectKey - 오브젝트 키
 */
export async function deleteObject(
  bucket: string,
  objectKey: string,
): Promise<void> {
  await getMinioClient().removeObject(bucket, objectKey);
  info(`MinIO 삭제 완료: ${bucket}/${objectKey}`);
}

/** 오브젝트 목록 항목 */
export interface ObjectListItem {
  key: string;
  size: number;
  lastModified: Date;
  etag: string;
}

/**
 * 버킷 내 오브젝트 목록을 조회한다.
 * @param bucket - 대상 버킷명
 * @param prefix - 키 접두사 필터 (선택)
 * @param limit - 최대 결과 수 (선택, 기본 100)
 * @returns 오브젝트 목록
 */
export async function listObjects(
  bucket: string,
  prefix?: string,
  limit: number = 100,
): Promise<ObjectListItem[]> {
  return new Promise((resolve, reject) => {
    const items: ObjectListItem[] = [];
    const stream = getMinioClient().listObjectsV2(bucket, prefix || "", true);

    stream.on("data", (obj) => {
      if (items.length >= limit) {
        stream.destroy();
        return;
      }
      if (obj.name) {
        items.push({
          key: obj.name,
          size: obj.size,
          lastModified: obj.lastModified,
          etag: obj.etag,
        });
      }
    });
    stream.on("end", () => resolve(items));
    stream.on("close", () => resolve(items));
    stream.on("error", reject);
  });
}

/**
 * 임시 다운로드 URL을 생성한다.
 * @param bucket - 대상 버킷명
 * @param objectKey - 오브젝트 키
 * @param expirySeconds - URL 유효 기간 (초, 기본: config.minio.presignedExpiry)
 * @returns presigned URL 문자열
 */
export async function getPresignedUrl(
  bucket: string,
  objectKey: string,
  expirySeconds?: number,
): Promise<string> {
  const expiry = expirySeconds ?? config.minio.presignedExpiry;
  return getMinioClient().presignedGetObject(bucket, objectKey, expiry);
}

/** 오브젝트 메타데이터 */
export interface ObjectStat {
  size: number;
  mimeType: string;
  etag: string;
  lastModified: Date;
}

/**
 * 오브젝트 메타데이터(크기, MIME 등)를 조회한다.
 * @param bucket - 대상 버킷명
 * @param objectKey - 오브젝트 키
 * @returns 오브젝트 메타데이터
 */
export async function statObject(
  bucket: string,
  objectKey: string,
): Promise<ObjectStat> {
  const stat = await getMinioClient().statObject(bucket, objectKey);
  return {
    size: stat.size,
    mimeType: stat.metaData["content-type"] || "application/octet-stream",
    etag: stat.etag,
    lastModified: stat.lastModified,
  };
}

/** 버킷 사용량 정보 */
export interface BucketUsage {
  objectCount: number;
  totalSize: number;
}

/**
 * 버킷의 총 사용량을 계산한다.
 * 주의: 버킷 내 모든 오브젝트를 순회하므로 대용량 버킷에서는 느릴 수 있다.
 * @param bucket - 대상 버킷명
 * @returns 오브젝트 수와 총 크기
 */
export async function getBucketUsage(bucket: string): Promise<BucketUsage> {
  return new Promise((resolve, reject) => {
    let objectCount = 0;
    let totalSize = 0;
    const stream = getMinioClient().listObjectsV2(bucket, "", true);

    stream.on("data", (obj) => {
      objectCount++;
      totalSize += obj.size;
    });
    stream.on("end", () => resolve({ objectCount, totalSize }));
    stream.on("error", reject);
  });
}

/**
 * MinIO 연결 상태를 확인한다.
 * @returns 연결 성공 여부와 메시지
 */
export async function checkMinioHealth(): Promise<{
  ok: boolean;
  message: string;
}> {
  try {
    await getMinioClient().listBuckets();
    return { ok: true, message: "MinIO 연결 정상" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`MinIO 헬스체크 실패: ${msg}`);
    return { ok: false, message: `MinIO 연결 실패: ${msg}` };
  }
}
