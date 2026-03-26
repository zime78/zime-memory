/**
 * memory_migrate 도구
 * 기존 Qdrant 데이터에 store:"general" 태그를 추가한다.
 * 데이터 분석(analyze) 및 태그 부여(tag-store) 모드를 지원한다.
 */

import { z } from "zod";
import { scrollMemories, upsertMemory, getMemoryById } from "../services/qdrantService.js";
import type { MemoryPayload } from "../types/index.js";
import { jsonResponse, errorResponse } from "../utils/response.js";

/** memory_migrate 도구의 입력 스키마 */
export const memoryMigrateSchema = z.object({
  /** 마이그레이션 모드 */
  mode: z.enum([
    "analyze",     // 기존 데이터를 분석하여 store 분류 제안만 출력 (dry run)
    "tag-store",   // 기존 Qdrant 레코드에 store:"general" 필드 추가 (non-destructive)
  ]),
  /** 확인 문구 — tag-store 모드에서 "CONFIRM" 입력 필수 */
  confirm: z.string().optional(),
});

export type MemoryMigrateInput = z.infer<typeof memoryMigrateSchema>;

/**
 * 기존 데이터를 분석하거나 store 태그를 추가하는 핸들러
 */
export async function memoryMigrate(args: MemoryMigrateInput) {
  if (args.mode === "analyze") {
    return await analyzeMode();
  }

  if (args.mode === "tag-store") {
    if (args.confirm !== "CONFIRM") {
      return jsonResponse({
        success: false,
        error: 'tag-store 모드에는 confirm: "CONFIRM"이 필수입니다.',
      });
    }
    return await tagStoreMode();
  }

  throw new Error(`지원하지 않는 마이그레이션 모드: ${args.mode}`);
}

/** 기존 데이터를 분석하여 store 분류 제안을 출력한다 */
async function analyzeMode() {
  let total = 0;
  let withStore = 0;
  let withoutStore = 0;
  let offset: string | undefined;

  /* 모든 메모리를 스크롤하며 분석 */
  do {
    const result = await scrollMemories(undefined, 100, offset);

    for (const point of result.points) {
      total++;
      const payload = point.payload as Record<string, unknown> | null;

      if (payload?.store) {
        withStore++;
      } else {
        withoutStore++;
      }
    }

    offset = result.nextOffset != null ? String(result.nextOffset) : undefined;
  } while (offset);

  return jsonResponse({
    success: true,
    mode: "analyze",
    total,
    withStore,
    withoutStore,
    message: withoutStore > 0
      ? `${withoutStore}건의 메모리에 store 필드가 없습니다. tag-store 모드로 "general" 태그를 추가할 수 있습니다.`
      : "모든 메모리에 store 필드가 설정되어 있습니다.",
  });
}

/** 기존 Qdrant 레코드에 store:"general" 필드를 추가한다 */
async function tagStoreMode() {
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  let offset: string | undefined;

  do {
    const result = await scrollMemories(undefined, 50, offset);

    for (const point of result.points) {
      const payload = point.payload as Record<string, unknown> | null;

      /* 이미 store 필드가 있으면 건너뛴다 */
      if (payload?.store) {
        skipped++;
        continue;
      }

      try {
        /* 벡터 포함으로 조회하여 재upsert */
        const full = await getMemoryById(String(point.id), true);
        if (full && full.vector) {
          const updatedPayload = {
            ...(full.payload as Record<string, unknown>),
            store: "general",
          } as MemoryPayload;

          await upsertMemory(
            String(full.id),
            full.vector as number[],
            updatedPayload,
          );
          updated++;
        }
      } catch {
        /* 개별 메모리 업데이트 실패는 건너뛰고 계속 진행 */
        errors++;
      }
    }

    offset = result.nextOffset != null ? String(result.nextOffset) : undefined;
  } while (offset);

  return jsonResponse({
    success: true,
    mode: "tag-store",
    updated,
    skipped,
    errors,
    message: `${updated}건 업데이트, ${skipped}건 건너뜀, ${errors}건 오류`,
  });
}
