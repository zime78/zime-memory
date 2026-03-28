/**
 * memory_update 도구
 * 기존 메모리의 내용, 제목, 태그, 카테고리, 우선순위, 출처를 수정한다.
 */

import { z } from "zod";
import { generateEmbedding } from "../services/embeddingService.js";
import { getMemoryById, upsertMemory } from "../services/qdrantService.js";
import type { MemoryPayload } from "../types/index.js";
import { jsonResponse, errorResponse } from "../utils/response.js";

/** memory_update 도구의 입력 스키마 */
export const memoryUpdateSchema = z
  .object({
    /** 대상 스토어 (기본: general) */
    store: z.enum(["general", "images", "files", "secrets"]).default("general"),
    /** 수정할 메모리의 UUID (필수) */
    id: z.string().uuid("유효한 UUID 형식이어야 합니다"),
    /** 수정할 내용 (선택) */
    content: z.string().min(1, "내용은 비어있을 수 없습니다").optional(),
    /** 수정할 제목 (선택) */
    title: z.string().optional(),
    /** 수정할 태그 목록 (선택) */
    tags: z.array(z.string()).optional(),
    /** 수정할 카테고리 (선택) */
    category: z
      .enum(["note", "knowledge", "reference", "snippet", "decision", "custom"])
      .optional(),
    /** 수정할 우선순위 (선택) */
    priority: z.enum(["low", "medium", "high", "critical"]).optional(),
    /** 수정할 출처 정보 (선택) */
    source: z.string().optional(),
    /** 수정할 상태 (published로 변경 시 expiresAt 제거) */
    status: z.enum(["published", "draft"]).optional(),
    /** 수정할 TTL (draft 상태에서만 유효, expiresAt 재계산) */
    ttl: z.string().optional(),
    /** 고정 여부 수정 (선택) */
    pinned: z.boolean().optional(),
    /** 상위 메모리 ID (선택, nullable) */
    parentId: z.string().uuid().optional(),
    /** 연결 메모리 ID 목록 (선택) */
    relatedIds: z.array(z.string().uuid()).optional(),
  })
  .refine(
    (data) => {
      const { id, ...rest } = data;
      return Object.values(rest).some((v) => v !== undefined);
    },
    { message: "id 외에 최소 하나의 수정 필드가 필요합니다" }
  );

/**
 * TTL 문자열을 밀리초로 파싱한다.
 * 지원 형식: "3d" (일), "12h" (시간)
 *
 * @param ttl - TTL 문자열
 * @returns 밀리초 값
 */
function parseTTL(ttl: string): number {
  const match = ttl.match(/^(\d+)([dh])$/);
  if (!match) throw new Error("Invalid TTL format. Use like '3d' or '12h'");
  const [, amount, unit] = match;
  const ms: Record<string, number> = { d: 86400000, h: 3600000 };
  return parseInt(amount) * ms[unit];
}

export type MemoryUpdateInput = z.infer<typeof memoryUpdateSchema>;

/**
 * 기존 메모리를 조회하고, 전달된 필드만 병합하여 업데이트한다.
 * content 또는 title이 변경된 경우 임베딩을 재생성한다.
 *
 * @param args - 수정할 메모리 ID와 변경 필드
 * @returns MCP 응답 형식의 수정 결과
 */
export async function memoryUpdate(args: MemoryUpdateInput) {
  // secrets store는 SQLCipher updateByStore로 위임한다
  if (args.store === "secrets") {
    const { updateByStore } = await import("../services/storeRouter.js");
    const updates: Record<string, unknown> = {};
    if (args.content !== undefined) updates.value = args.content;
    if (args.title !== undefined) updates.name = args.title;
    if (args.tags !== undefined) updates.tags = args.tags;
    if (args.source !== undefined) updates.notes = args.source;
    const ok = await updateByStore("secrets", args.id, updates);
    if (!ok) {
      return errorResponse(`시크릿을 찾을 수 없습니다 (ID: ${args.id})`);
    }
    return jsonResponse({ success: true, id: args.id, message: `시크릿이 수정되었습니다 (ID: ${args.id})` });
  }

  // images/files store는 storeRouter.updateByStore로 위임한다
  if (args.store === "images" || args.store === "files") {
    const { updateByStore } = await import("../services/storeRouter.js");
    const updates: Record<string, unknown> = {};
    if (args.content !== undefined) updates.content = args.content;
    if (args.title !== undefined) updates.title = args.title;
    if (args.tags !== undefined) updates.tags = args.tags;
    if (args.category !== undefined) updates.category = args.category;
    if (args.priority !== undefined) updates.priority = args.priority;
    if (args.source !== undefined) updates.source = args.source;
    const ok = await updateByStore(args.store, args.id, updates);
    if (!ok) {
      return errorResponse(`메모리를 찾을 수 없습니다 (ID: ${args.id})`);
    }
    return jsonResponse({ success: true, id: args.id, message: `메모리가 수정되었습니다 (ID: ${args.id})` });
  }

  // general store — 기존 Qdrant 동작 유지
  // content나 title 변경 여부에 따라 임베딩 재생성 필요 여부를 결정한다
  const needsReembed = args.content !== undefined || args.title !== undefined;
  // 재생성 불필요 시 기존 벡터를 가져와야 하므로 withVector=true로 조회
  const existing = await getMemoryById(args.id, !needsReembed);

  if (!existing) {
    return errorResponse(`메모리를 찾을 수 없습니다 (ID: ${args.id})`);
  }

  const existingPayload = existing.payload as Record<string, unknown>;
  const now = new Date().toISOString();

  // status/ttl/expiresAt 계산
  const mergedStatus = args.status ?? (existingPayload.status as MemoryPayload["status"]);
  let mergedTtl = args.ttl !== undefined ? args.ttl : (existingPayload.ttl as string | undefined);
  let mergedExpiresAt = existingPayload.expiresAt as string | undefined;

  // status를 "published"로 변경하면 expiresAt과 ttl을 제거한다
  if (args.status === "published") {
    mergedExpiresAt = undefined;
    mergedTtl = undefined;
  }

  // ttl이 변경되고 draft 상태이면 expiresAt을 재계산한다
  if (args.ttl !== undefined && args.ttl !== "0h" && args.ttl !== "permanent" && mergedStatus === "draft") {
    mergedExpiresAt = new Date(Date.now() + parseTTL(args.ttl)).toISOString();
  }

  // 기존 페이로드에 변경 필드를 병합한다
  const mergedPayload: MemoryPayload = {
    content: args.content ?? (existingPayload.content as string),
    title: args.title !== undefined ? args.title : (existingPayload.title as string | undefined),
    tags: args.tags ?? (existingPayload.tags as string[]),
    category: args.category ?? (existingPayload.category as MemoryPayload["category"]),
    priority: args.priority ?? (existingPayload.priority as MemoryPayload["priority"]),
    source: args.source !== undefined ? args.source : (existingPayload.source as string | undefined),
    status: mergedStatus,
    ttl: mergedTtl,
    expiresAt: mergedExpiresAt,
    pinned: args.pinned ?? (existingPayload.pinned as boolean | undefined),
    parentId: args.parentId !== undefined ? args.parentId : (existingPayload.parentId as string | undefined),
    relatedIds: args.relatedIds !== undefined ? args.relatedIds : (existingPayload.relatedIds as string[] | undefined),
    createdAt: existingPayload.createdAt as string,
    updatedAt: now,
    store: (existingPayload.store as MemoryPayload["store"]) || "general",
  };

  // content 또는 title이 변경된 경우 임베딩 재생성, 아니면 기존 벡터 재사용
  let vector: number[];
  if (needsReembed) {
    const textToEmbed = mergedPayload.title
      ? `${mergedPayload.title}\n\n${mergedPayload.content}`
      : mergedPayload.content;
    vector = await generateEmbedding(textToEmbed);
  } else {
    // needsReembed가 false일 때 withVector=true로 이미 조회했으므로 바로 사용
    vector = existing.vector!;
  }

  await upsertMemory(args.id, vector, mergedPayload);

  // 변경된 필드 목록 수집
  const updatedFields: string[] = [];
  if (args.content !== undefined) updatedFields.push("content");
  if (args.title !== undefined) updatedFields.push("title");
  if (args.tags !== undefined) updatedFields.push("tags");
  if (args.category !== undefined) updatedFields.push("category");
  if (args.priority !== undefined) updatedFields.push("priority");
  if (args.source !== undefined) updatedFields.push("source");
  if (args.status !== undefined) updatedFields.push("status");
  if (args.ttl !== undefined) updatedFields.push("ttl");
  if (args.pinned !== undefined) updatedFields.push("pinned");
  if (args.parentId !== undefined) updatedFields.push("parentId");
  if (args.relatedIds !== undefined) updatedFields.push("relatedIds");

  return jsonResponse({
    success: true,
    id: args.id,
    message: `메모리가 수정되었습니다 (ID: ${args.id})`,
    updatedFields,
  } as Record<string, unknown>);
}
