/**
 * memory_save 도구
 * store 파라미터에 따라 Qdrant, MinIO+Qdrant, SQLCipher로 라우팅하여 저장한다.
 */

import { z } from "zod";
import { generateEmbedding } from "../services/embeddingService.js";
import { searchMemories } from "../services/qdrantService.js";
import { saveGeneral, saveFile, saveSecretEntry } from "../services/storeRouter.js";
import type { MemoryPayload } from "../types/index.js";
import { jsonResponse, errorResponse } from "../utils/response.js";

/** memory_save 도구의 입력 스키마 */
export const memorySaveSchema = z.object({
  /** 저장소 타입 (기본: general) */
  store: z
    .enum(["general", "images", "files", "secrets"])
    .default("general"),

  // === general store 필드 (기존) ===
  /** 저장할 메모리 내용 (general 필수) */
  content: z.string().optional(),
  /** 메모리 제목 (선택) */
  title: z.string().optional(),
  /** 분류용 태그 목록 */
  tags: z.array(z.string()).default([]),
  /** 메모리 카테고리 */
  category: z
    .enum(["note", "knowledge", "reference", "snippet", "decision", "custom"])
    .default("note"),
  /** 우선순위 */
  priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  /** 출처 정보 (선택) */
  source: z.string().optional(),
  /** 메모리 상태 (published: 확정, draft: 임시 저장) */
  status: z.enum(["published", "draft"]).default("published"),
  /** TTL - 메모리 자동 만료 기간 (예: "3d", "12h", "0h"=만료 없음, "permanent"=영구 보존) */
  ttl: z.string().default("permanent"),
  /** 메모리 고정 여부 (true: 검색 결과 상단 고정) */
  pinned: z.boolean().default(false),
  /** 상위 메모리 ID (선택) */
  parentId: z.string().uuid().optional(),
  /** 연결 메모리 ID 목록 (선택) */
  relatedIds: z.array(z.string().uuid()).optional(),

  // === images/files store 전용 필드 ===
  /** base64 인코딩된 파일 데이터 */
  fileData: z.string().optional(),
  /** 로컬 파일 경로 (fileData 대안) */
  filePath: z.string().optional(),
  /** MIME 타입 (images/files 필수) */
  mimeType: z.string().optional(),
  /** 원본 파일명 */
  originalName: z.string().optional(),
  /** 파일/이미지 설명 (images/files 필수, 임베딩 생성에 사용) */
  description: z.string().optional(),
  /** 이미지 해상도 (images only, 선택) */
  resolution: z
    .object({ width: z.number().int().positive(), height: z.number().int().positive() })
    .optional(),

  // === secrets store 전용 필드 ===
  /** 시크릿 이름 (secrets 필수) */
  name: z.string().optional(),
  /** 시크릿 값 (secrets 필수) */
  value: z.string().optional(),
  /** 시크릿 유형 */
  secretType: z
    .enum(["api-key", "token", "password", "certificate", "other"])
    .optional(),
  /** 관련 서비스명 */
  service: z.string().optional(),
  /** 시크릿 메모 */
  notes: z.string().optional(),
});

/**
 * TTL 문자열을 밀리초로 파싱한다.
 * 지원 형식: "3d" (일), "12h" (시간)
 */
function parseTTL(ttl: string): number {
  const match = ttl.match(/^(\d+)([dh])$/);
  if (!match) throw new Error("Invalid TTL format. Use like '3d' or '12h'");
  const [, amount, unit] = match;
  const ms: Record<string, number> = { d: 86400000, h: 3600000 };
  return parseInt(amount) * ms[unit];
}

export type MemorySaveInput = z.infer<typeof memorySaveSchema>;

/**
 * 메모리를 저장하는 핸들러
 * store에 따라 적절한 백엔드로 라우팅한다.
 */
export async function memorySave(args: MemorySaveInput) {
  // ─── secrets store ───
  if (args.store === "secrets") {
    if (!args.name || !args.value || !args.secretType) {
      return errorResponse("secrets store에는 name, value, secretType이 필수입니다.");
    }

    const result = saveSecretEntry({
      name: args.name,
      value: args.value,
      secretType: args.secretType,
      service: args.service,
      tags: args.tags,
      notes: args.notes,
      expiresAt: args.status === "draft" && args.ttl && args.ttl !== "0h" && args.ttl !== "permanent"
        ? new Date(Date.now() + parseTTL(args.ttl)).toISOString()
        : undefined,
    });

    return jsonResponse({
      success: true,
      id: result.id,
      store: "secrets",
      message: `시크릿이 저장되었습니다: ${args.name} (ID: ${result.id})`,
    });
  }

  // ─── images/files store ───
  if (args.store === "images" || args.store === "files") {
    if ((!args.fileData && !args.filePath) || !args.mimeType || !args.description) {
      return errorResponse(`${args.store} store에는 fileData/filePath, mimeType, description이 필수입니다.`);
    }

    const result = await saveFile({
      store: args.store,
      fileData: args.fileData,
      filePath: args.filePath,
      mimeType: args.mimeType,
      originalName: args.originalName,
      description: args.description,
      tags: args.tags,
      category: args.category,
      priority: args.priority,
      resolution: args.resolution,
    });

    return jsonResponse({
      success: true,
      id: result.id,
      store: args.store,
      objectKey: result.objectKey,
      bucket: result.bucket,
      size: result.size,
      message: `${args.store === "images" ? "이미지" : "파일"}가 저장되었습니다 (ID: ${result.id})`,
    });
  }

  // ─── general store (기존 동작) ───
  if (!args.content) {
    return errorResponse("general store에는 content가 필수입니다.");
  }

  const status = args.status;
  let expiresAt: string | undefined;
  if (status === "draft" && args.ttl && args.ttl !== "0h" && args.ttl !== "permanent") {
    expiresAt = new Date(Date.now() + parseTTL(args.ttl)).toISOString();
  }

  // 중복 감지 및 관련 메모리 추천을 위해 임베딩을 먼저 생성한다
  const textToEmbed = args.title
    ? `${args.title}\n\n${args.content}`
    : args.content;
  const vector = await generateEmbedding(textToEmbed);

  // 중복 감지: 유사도 0.9 이상인 기존 메모리가 있는지 확인
  let duplicateWarning: { similarId: string | number; similarTitle: string; score: number } | undefined;
  try {
    const similar = await searchMemories(vector, 1, { store: "general" }, 0.9);
    if (similar.length > 0) {
      const similarPayload = similar[0].payload as Record<string, unknown> | null;
      duplicateWarning = {
        similarId: similar[0].id,
        similarTitle: (similarPayload?.title as string) || "(제목 없음)",
        score: Math.round(similar[0].score * 1000) / 1000,
      };
    }
  } catch {
    // 중복 감지 실패 시 저장은 계속 진행한다
  }

  // 관련 메모리 추천: 유사도 0.5 이상 0.9 미만인 메모리를 최대 3건 검색
  let relatedMemories: Array<{ id: string | number; title: string; score: number }> = [];
  try {
    const related = await searchMemories(vector, 3, { store: "general" }, 0.5);
    relatedMemories = related
      .filter((r) => r.score < 0.9)
      .map((r) => {
        const p = r.payload as Record<string, unknown> | null;
        return {
          id: r.id,
          title: (p?.title as string) || "(제목 없음)",
          score: Math.round(r.score * 1000) / 1000,
        };
      });
  } catch {
    // 관련 메모리 검색 실패 시 저장은 계속 진행한다
  }

  // saveGeneral에 위임 — 중복 감지에서 이미 생성한 벡터를 전달하여 Ollama 이중 호출 방지
  const saveResult = await saveGeneral({
    content: args.content,
    title: args.title,
    tags: args.tags,
    category: args.category,
    priority: args.priority,
    source: args.source,
    status,
    ttl: args.ttl,
    expiresAt,
    pinned: args.pinned,
    parentId: args.parentId,
    relatedIds: args.relatedIds,
    precomputedVector: vector,
  });

  const id = saveResult.id;

  const result: Record<string, unknown> = {
    success: true,
    id,
    store: "general",
    message: `메모리가 저장되었습니다 (ID: ${id})`,
    category: args.category,
    priority: args.priority,
    tags: args.tags,
    status,
    pinned: args.pinned,
  };

  if (duplicateWarning) {
    result.duplicateWarning = duplicateWarning;
  }

  if (relatedMemories.length > 0) {
    result.relatedMemories = relatedMemories;
  }

  return jsonResponse(result);
}
