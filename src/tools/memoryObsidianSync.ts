/**
 * memory_obsidian_sync 도구
 * Obsidian vault와 zime-memory 간 양방향 동기화를 수행한다.
 */

import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { config } from "../config.js";
import { jsonResponse, errorResponse } from "../utils/response.js";
import {
  readVaultNotes,
  writeVaultNote,
} from "../services/obsidianService.js";
import {
  scrollMemories,
  getMemoryById,
  upsertMemory,
} from "../services/qdrantService.js";
import { generateEmbedding } from "../services/embeddingService.js";
import type { MemoryPayload, MemoryCategory, MemoryPriority } from "../types/index.js";

/** memory_obsidian_sync 도구의 입력 스키마 */
export const memoryObsidianSyncSchema = z.object({
  /** Obsidian vault 경로 (미지정 시 환경변수 OBSIDIAN_VAULT_PATH 사용) */
  vaultPath: z.string().optional(),
  /** vault 내 하위 폴더 (선택, 예: "zime-memory") */
  folder: z.string().optional(),
  /** 동기화 방향 */
  direction: z.enum(["import", "export", "bidirectional"]),
});

export type MemoryObsidianSyncInput = z.infer<typeof memoryObsidianSyncSchema>;

const validCategories = ["note", "knowledge", "reference", "snippet", "decision", "custom"];
const validPriorities = ["low", "medium", "high", "critical"];

/**
 * Obsidian vault와 zime-memory 간 동기화를 수행한다.
 */
export async function memoryObsidianSync(args: MemoryObsidianSyncInput) {
  const vaultPath = args.vaultPath || config.obsidian.vaultPath;
  if (!vaultPath) {
    return errorResponse("Obsidian vault 경로가 지정되지 않았습니다. vaultPath 파라미터 또는 OBSIDIAN_VAULT_PATH 환경변수를 설정하세요.");
  }

  const folder = args.folder || "zime-memory";
  let imported = 0;
  let exported = 0;
  let skipped = 0;
  let autoLinked = 0;
  const errors: string[] = [];

  // Import: Obsidian → zime-memory
  if (args.direction === "import" || args.direction === "bidirectional") {
    try {
      const notes = await readVaultNotes(vaultPath, folder);

      for (const note of notes) {
        try {
          // zime-id가 있으면 기존 메모리 업데이트, 없으면 새로 저장
          if (note.metadata.zimeId) {
            const existing = await getMemoryById(note.metadata.zimeId, true);
            if (existing) {
              // bidirectional: 더 최신인 쪽이 우선
              const existingPayload = existing.payload as Record<string, unknown>;
              const existingUpdated = existingPayload.updatedAt as string;
              if (args.direction === "bidirectional" && existingUpdated > note.updatedAt) {
                skipped++;
                continue;
              }

              const textToEmbed = note.title ? `${note.title}\n\n${note.content}` : note.content;
              const vector = await generateEmbedding(textToEmbed);
              const payload: MemoryPayload = {
                ...(existingPayload as unknown as MemoryPayload),
                content: note.content,
                title: note.title,
                tags: note.metadata.tags || (existingPayload.tags as string[]) || [],
                category: (validCategories.includes(note.metadata.category || "") ? note.metadata.category : existingPayload.category) as MemoryCategory,
                obsidianPath: note.path,
                updatedAt: new Date().toISOString(),
              };
              await upsertMemory(note.metadata.zimeId, vector, payload);
              imported++;
              continue;
            }
          }

          // 새 메모리 생성
          const id = note.metadata.zimeId || uuidv4();
          const textToEmbed = note.title ? `${note.title}\n\n${note.content}` : note.content;
          const vector = await generateEmbedding(textToEmbed);
          const now = new Date().toISOString();

          const payload: MemoryPayload = {
            content: note.content,
            title: note.title,
            tags: note.metadata.tags || [],
            category: (validCategories.includes(note.metadata.category || "") ? note.metadata.category : "note") as MemoryCategory,
            priority: (validPriorities.includes(note.metadata.priority || "") ? note.metadata.priority : "medium") as MemoryPriority,
            status: "published",
            store: "general",
            obsidianPath: note.path,
            createdAt: now,
            updatedAt: now,
          };

          await upsertMemory(id, vector, payload);
          imported++;
        } catch (err) {
          errors.push(`import ${note.path}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      errors.push(`vault 읽기: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Export: zime-memory → Obsidian
  if (args.direction === "export" || args.direction === "bidirectional") {
    try {
      // ── Phase 1: 전체 메모리 수집 ──
      interface MemoryEntry {
        id: string;
        title: string;
        content: string;
        category: string;
        priority: string;
        tags: string[];
        relatedIds: string[];
      }
      const allMemories: MemoryEntry[] = [];
      {
        let collectOffset: string | undefined = undefined;
        while (true) {
          const batch = await scrollMemories({ status: "published" }, 50, collectOffset);
          if (batch.points.length === 0) break;
          for (const point of batch.points) {
            const payload = point.payload as Record<string, unknown>;
            allMemories.push({
              id: String(point.id),
              title: (payload.title as string) || `memory-${point.id}`,
              content: payload.content as string,
              category: (payload.category as string) || "note",
              priority: (payload.priority as string) || "medium",
              tags: (payload.tags as string[]) || [],
              relatedIds: (payload.relatedIds as string[]) || [],
            });
          }
          if (!batch.nextOffset) break;
          collectOffset = String(batch.nextOffset);
        }
      }

      // ── Phase 2: 태그 기반 자동 링크 → Qdrant relatedIds 영구 저장 ──
      // 태그 → 메모리 ID 역인덱스
      const tagIndex = new Map<string, string[]>();
      for (const mem of allMemories) {
        for (const tag of mem.tags) {
          const list = tagIndex.get(tag) || [];
          list.push(mem.id);
          tagIndex.set(tag, list);
        }
      }

      // 각 메모리에 대해 2개+ 태그를 공유하는 피어를 찾아 relatedIds에 추가
      const memMap = new Map<string, MemoryEntry>();
      for (const mem of allMemories) memMap.set(mem.id, mem);

      for (const mem of allMemories) {
        const tagOverlapCount = new Map<string, number>();
        for (const tag of mem.tags) {
          for (const peerId of tagIndex.get(tag) || []) {
            if (peerId === mem.id) continue;
            tagOverlapCount.set(peerId, (tagOverlapCount.get(peerId) || 0) + 1);
          }
        }

        const newPeers: string[] = [];
        for (const [peerId, count] of tagOverlapCount) {
          if (count >= 2 && !mem.relatedIds.includes(peerId)) {
            newPeers.push(peerId);
          }
        }

        if (newPeers.length === 0) continue;

        // source 측 relatedIds 업데이트
        const updatedRelated = [...mem.relatedIds, ...newPeers];
        const sourceFull = await getMemoryById(mem.id, true);
        if (sourceFull && sourceFull.vector) {
          const sourcePayload: MemoryPayload = {
            ...(sourceFull.payload as unknown as MemoryPayload),
            relatedIds: updatedRelated,
            updatedAt: new Date().toISOString(),
          };
          await upsertMemory(mem.id, sourceFull.vector, sourcePayload);
          mem.relatedIds = updatedRelated; // in-memory 동기화
        }

        // 양방향: 각 peer의 relatedIds에도 source 추가
        for (const peerId of newPeers) {
          const peer = memMap.get(peerId);
          if (!peer || peer.relatedIds.includes(mem.id)) continue;

          peer.relatedIds.push(mem.id);
          const peerFull = await getMemoryById(peerId, true);
          if (peerFull && peerFull.vector) {
            const peerPayload: MemoryPayload = {
              ...(peerFull.payload as unknown as MemoryPayload),
              relatedIds: peer.relatedIds,
              updatedAt: new Date().toISOString(),
            };
            await upsertMemory(peerId, peerFull.vector, peerPayload);
          }
          autoLinked++;
        }
      }

      // ── Phase 3: Obsidian 노트 저장 (relatedIds → [[wikilink]]) ──
      const idToTitle = new Map<string, string>();
      for (const mem of allMemories) idToTitle.set(mem.id, mem.title);

      for (const mem of allMemories) {
        try {
          // relatedIds → 제목 변환
          const relatedTitles: string[] = [];
          for (const rid of mem.relatedIds) {
            const t = idToTitle.get(rid);
            if (t && t !== mem.title) relatedTitles.push(t);
          }

          await writeVaultNote(vaultPath, folder, {
            id: mem.id,
            title: mem.title,
            content: mem.content,
            category: mem.category,
            priority: mem.priority,
            tags: mem.tags,
            relatedTitles,
          });

          // obsidianPath 업데이트
          {
            const full = await getMemoryById(mem.id, true);
            if (full && full.vector) {
              const safeTitle = mem.title.replace(/[<>:"/\\|?*]/g, "_");
              const categoryFolder = mem.category || "note";
              const relPath = folder ? `${folder}/${categoryFolder}/${safeTitle}.md` : `${categoryFolder}/${safeTitle}.md`;
              const updated: MemoryPayload = {
                ...(full.payload as unknown as MemoryPayload),
                obsidianPath: relPath,
                updatedAt: new Date().toISOString(),
              };
              await upsertMemory(mem.id, full.vector, updated);
            }
          }

          exported++;
        } catch (err) {
          errors.push(`export ${mem.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

    } catch (err) {
      errors.push(`export: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return jsonResponse({
    success: errors.length === 0,
    message: `동기화 완료 (방향: ${args.direction})`,
    imported,
    exported,
    skipped,
    autoLinked,
    errors: errors.length > 0 ? errors : undefined,
  } as Record<string, unknown>);
}
