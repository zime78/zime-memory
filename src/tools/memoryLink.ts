/**
 * memory_link 도구
 * 두 메모리 간 명시적 관계를 설정한다.
 */

import { z } from "zod";
import { getMemoryById, upsertMemory } from "../services/qdrantService.js";
import type { MemoryPayload } from "../types/index.js";
import { jsonResponse, errorResponse } from "../utils/response.js";

/** memory_link 도구의 입력 스키마 */
export const memoryLinkSchema = z.object({
  /** 관계의 출발점 메모리 UUID (필수) */
  sourceId: z.string().uuid("유효한 UUID 형식이어야 합니다"),
  /** 관계의 도착점 메모리 UUID (필수) */
  targetId: z.string().uuid("유효한 UUID 형식이어야 합니다"),
  /** 양방향 관계 설정 여부 (기본: true) */
  bidirectional: z.boolean().default(true),
});

export type MemoryLinkInput = z.infer<typeof memoryLinkSchema>;

/**
 * 두 메모리 간 관계를 설정한다.
 * sourceId의 relatedIds에 targetId를 추가하고, 양방향이면 반대도 설정한다.
 */
export async function memoryLink(args: MemoryLinkInput) {
  if (args.sourceId === args.targetId) {
    return errorResponse("자기 자신과는 연결할 수 없습니다");
  }

  // 두 메모리 모두 존재하는지 확인 (벡터 포함 조회 - upsert에 필요)
  const [source, target] = await Promise.all([
    getMemoryById(args.sourceId, true),
    getMemoryById(args.targetId, true),
  ]);

  if (!source) {
    return errorResponse(`source 메모리를 찾을 수 없습니다 (ID: ${args.sourceId})`);
  }
  if (!target) {
    return errorResponse(`target 메모리를 찾을 수 없습니다 (ID: ${args.targetId})`);
  }

  const now = new Date().toISOString();

  // source에 target 연결 추가
  const sourcePayload = source.payload as Record<string, unknown>;
  const sourceRelated = (sourcePayload.relatedIds as string[]) || [];
  if (!sourceRelated.includes(args.targetId)) {
    sourceRelated.push(args.targetId);
  }
  const updatedSourcePayload: MemoryPayload = {
    ...(sourcePayload as unknown as MemoryPayload),
    relatedIds: sourceRelated,
    updatedAt: now,
    store: (sourcePayload.store as MemoryPayload["store"]) || "general",
  };
  await upsertMemory(args.sourceId, source.vector!, updatedSourcePayload);

  // 양방향이면 target에도 source 연결 추가
  if (args.bidirectional) {
    const targetPayload = target.payload as Record<string, unknown>;
    const targetRelated = (targetPayload.relatedIds as string[]) || [];
    if (!targetRelated.includes(args.sourceId)) {
      targetRelated.push(args.sourceId);
    }
    const updatedTargetPayload: MemoryPayload = {
      ...(targetPayload as unknown as MemoryPayload),
      relatedIds: targetRelated,
      updatedAt: now,
      store: (targetPayload.store as MemoryPayload["store"]) || "general",
    };
    await upsertMemory(args.targetId, target.vector!, updatedTargetPayload);
  }

  const sourceTitle = (sourcePayload.title as string) || "(제목 없음)";
  const targetTitle = (target.payload as Record<string, unknown>).title as string || "(제목 없음)";

  return jsonResponse({
    success: true,
    message: `메모리 연결 완료`,
    source: { id: args.sourceId, title: sourceTitle },
    target: { id: args.targetId, title: targetTitle },
    bidirectional: args.bidirectional,
  });
}
