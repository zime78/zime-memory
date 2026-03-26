/**
 * memory_import 도구
 * JSON 배열에서 메모리를 일괄 복원한다.
 * 기존 ID 보존, 중복 건너뛰기를 지원한다.
 */

import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { generateEmbedding } from "../services/embeddingService.js";
import { getMemoryById, upsertMemory } from "../services/qdrantService.js";
import type { MemoryPayload } from "../types/index.js";
import { jsonResponse } from "../utils/response.js";

/** 가져올 단일 메모리 항목의 스키마 */
const memoryItemSchema = z.object({
  /** 메모리 내용 (필수) */
  content: z.string().min(1, "내용은 비어있을 수 없습니다"),
  /** 제목 (선택) */
  title: z.string().optional(),
  /** 태그 목록 (선택) */
  tags: z.array(z.string()).optional(),
  /** 카테고리 (선택) */
  category: z
    .enum(["note", "knowledge", "reference", "snippet", "decision", "custom"])
    .default("note"),
  /** 우선순위 (선택) */
  priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  /** 출처 정보 (선택) */
  source: z.string().optional(),
  /** 원본 ID 보존 (선택) */
  id: z.string().uuid().optional(),
  /** 생성 일시 (선택, ISO 8601) */
  createdAt: z.string().optional(),
});

/** memory_import 도구의 입력 스키마 */
export const memoryImportSchema = z.object({
  /** 대상 스토어 (기본: general, secrets는 import 미지원) */
  store: z.enum(["general", "images", "files"]).default("general"),
  /** 가져올 메모리 배열 */
  memories: z.array(memoryItemSchema).min(1, "최소 하나의 메모리가 필요합니다"),
  /** 동일 ID가 이미 존재할 경우 건너뛸지 여부 (기본값: true) */
  skipDuplicates: z.boolean().default(true),
});

export type MemoryImportInput = z.infer<typeof memoryImportSchema>;

/**
 * JSON 배열의 메모리를 일괄 저장한다.
 * 각 메모리에 대해 임베딩을 생성하고, 중복 검사 후 upsert한다.
 *
 * @param args - 가져올 메모리 배열과 중복 처리 옵션
 * @returns MCP 응답 형식의 가져오기 결과 요약
 */
export async function memoryImport(args: MemoryImportInput) {
  let imported = 0;
  let skipped = 0;
  const now = new Date().toISOString();

  for (const item of args.memories) {
    const id = item.id ?? uuidv4();

    // 중복 검사: ID가 지정되고 skipDuplicates가 true인 경우
    if (item.id && args.skipDuplicates) {
      const existing = await getMemoryById(id);
      if (existing) {
        skipped++;
        continue;
      }
    }

    // 임베딩 생성을 위한 텍스트 준비
    const textToEmbed = item.title
      ? `${item.title}\n\n${item.content}`
      : item.content;
    const vector = await generateEmbedding(textToEmbed);

    const payload: MemoryPayload = {
      content: item.content,
      title: item.title,
      tags: item.tags ?? [],
      category: item.category,
      priority: item.priority,
      source: item.source,
      // store 필드를 페이로드에 포함하여 store별 필터가 가능하게 한다
      store: args.store as MemoryPayload["store"],
      status: "published",
      createdAt: item.createdAt ?? now,
      updatedAt: now,
    };

    await upsertMemory(id, vector, payload);
    imported++;
  }

  const total = args.memories.length;

  return jsonResponse({
    success: true,
    imported,
    skipped,
    total,
    message: `${imported}건 가져오기 완료 (건너뛴 항목: ${skipped}건, 전체: ${total}건)`,
  });
}
