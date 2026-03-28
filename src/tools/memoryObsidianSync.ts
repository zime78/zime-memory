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
  copyReferencedAssets,
} from "../services/obsidianService.js";
import {
  scrollMemories,
  getMemoryById,
  upsertMemory,
  setMemoryPayload,
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
  /** export 시 이 태그를 가진 메모리만 내보냄 (OR 조건) */
  exportTags: z.array(z.string()).optional(),
  /** export 시 이 카테고리만 내보냄 */
  exportCategory: z.enum(["note", "knowledge", "reference", "snippet", "decision", "custom"]).optional(),
  /** MD 내 이미지/파일 참조를 vault로 복사 */
  copyAssets: z.boolean().default(false),
  /** 에셋 원본 디렉토리 (copyAssets=true 시 사용) */
  assetSourceDir: z.string().optional(),
  /** vault 내 에셋 저장 폴더 (예: "res") */
  assetDestFolder: z.string().optional(),
  /** 이 태그 값으로 서브폴더 분류 (예: "child-issue" → child-issue/ 폴더) */
  subfolderByTag: z.string().optional(),
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
  let totalAssets = 0;
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
              if (args.direction === "bidirectional" && new Date(existingUpdated).getTime() > new Date(note.updatedAt).getTime()) {
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
            const tags = (payload.tags as string[]) || [];
            const category = (payload.category as string) || "note";

            // 태그 필터: exportTags가 지정된 경우 해당 태그를 가진 메모리만 포함
            if (args.exportTags && args.exportTags.length > 0) {
              if (!tags.some(t => args.exportTags!.includes(t))) continue;
            }
            // 카테고리 필터
            if (args.exportCategory && category !== args.exportCategory) continue;

            allMemories.push({
              id: String(point.id),
              title: (payload.title as string) || `memory-${point.id}`,
              content: payload.content as string,
              category,
              priority: (payload.priority as string) || "medium",
              tags,
              relatedIds: (payload.relatedIds as string[]) || [],
            });
          }
          if (!batch.nextOffset) break;
          collectOffset = String(batch.nextOffset);
        }
      }

      // ── Phase 2: 태그 기반 자동 링크 → Qdrant relatedIds 영구 저장 ──
      // 자동 링크에서 제외할 공통 태그 (너무 광범위하여 모든 메모리가 연결됨)
      const EXCLUDE_TAGS_FROM_LINKING = new Set([
        "jira", "ITSM", "Q-글로벌", "child-issue", "parent-issue",
        "작업 완료", "작업_완료", "진행 중", "진행_중", "종료", "Cancel",
        "DEFECT", "하위 작업", "하위_작업", "reference", "APP", "Q", "US",
        "보통", "높음", "낮음", "긴급", "배포전결함",
        "note", "knowledge", "snippet", "decision", "custom",
        "low", "medium", "high", "critical",
      ]);

      // 태그 → 메모리 ID 역인덱스 (공통 태그 제외)
      const tagIndex = new Map<string, string[]>();
      for (const mem of allMemories) {
        for (const tag of mem.tags) {
          if (EXCLUDE_TAGS_FROM_LINKING.has(tag)) continue;
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

        // source 측 relatedIds 업데이트 (set_payload로 부분 업데이트)
        const updatedRelated = [...mem.relatedIds, ...newPeers];
        await setMemoryPayload(mem.id, {
          relatedIds: updatedRelated,
          updatedAt: new Date().toISOString(),
        });
        mem.relatedIds = updatedRelated; // in-memory 동기화

        // 양방향: 각 peer의 relatedIds에도 source 추가 (개별 에러 처리)
        for (const peerId of newPeers) {
          const peer = memMap.get(peerId);
          if (!peer || peer.relatedIds.includes(mem.id)) continue;

          try {
            peer.relatedIds.push(mem.id);
            await setMemoryPayload(peerId, {
              relatedIds: peer.relatedIds,
              updatedAt: new Date().toISOString(),
            });
            autoLinked++;
          } catch (err) {
            errors.push(`auto-link peer ${peerId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      // ── Phase 3: Obsidian 노트 저장 (relatedIds → [[wikilink]]) ──
      const idToTitle = new Map<string, string>();
      for (const mem of allMemories) idToTitle.set(mem.id, mem.title);

      // ITSM 이슈 번호 → 제목 매핑 (ghost node 방지용 wiki-link 변환)
      const itsmToTitle = new Map<string, string>();
      for (const mem of allMemories) {
        for (const tag of mem.tags) {
          if (/^ITSM-\d+$/.test(tag)) {
            itsmToTitle.set(tag, mem.title);
          }
        }
      }

      for (const mem of allMemories) {
        try {
          // relatedIds → 제목 변환
          const relatedTitles: string[] = [];
          for (const rid of mem.relatedIds) {
            const t = idToTitle.get(rid);
            if (t && t !== mem.title) relatedTitles.push(t);
          }

          // ../ITSM-XXXX/ITSM-XXXX.md 링크를 Obsidian wiki-link로 변환
          // (assetPathPrefix 변환 전에 처리하여 이미지 경로와 충돌 방지)
          let exportContent = mem.content;
          exportContent = exportContent.replace(
            /\[([^\]]+)\]\(\.\.\/ITSM-(\d+)\/ITSM-\d+\.md\)/g,
            (_match, displayText, itsmNum) => {
              const title = itsmToTitle.get(`ITSM-${itsmNum}`);
              if (title) {
                const safeTitle = title.replace(/[<>:"/\\|?*]/g, "_");
                return `[[${safeTitle}|${displayText}]]`;
              }
              return _match;
            }
          );

          // 서브폴더 결정: subfolderByTag로 태그 기반 분류
          let effectiveFolder = folder;
          let skipCategoryFolder = false;
          if (args.subfolderByTag) {
            // 지정 태그 매칭 확인
            const matchTag = mem.tags.find(t => t === args.subfolderByTag);
            if (matchTag) {
              effectiveFolder = folder ? `${folder}/${matchTag}` : matchTag;
            } else {
              // 매칭 안 되면 다른 분류 태그를 찾아 폴더명으로 사용
              // (예: "parent-issue", "child-issue" 등 "-issue" 패턴)
              const altTag = mem.tags.find(t => t.endsWith("-issue") && t !== args.subfolderByTag);
              if (altTag) {
                effectiveFolder = folder ? `${folder}/${altTag}` : altTag;
              }
            }
            skipCategoryFolder = true; // subfolderByTag 사용 시 카테고리 서브폴더 생략
          }

          await writeVaultNote(vaultPath, effectiveFolder, {
            id: mem.id,
            title: mem.title,
            content: exportContent,
            category: skipCategoryFolder ? "" : mem.category, // 빈 문자열로 카테고리 폴더 생략
            priority: mem.priority,
            tags: mem.tags,
            relatedTitles,
            assetPathPrefix: args.assetDestFolder, // export 시 이미지 경로 변환 (../ITSM- → ../res/ITSM-)
          });

          // 에셋 복사: 항상 base folder 기준으로 복사 (서브폴더가 아닌 공통 위치)
          if (args.copyAssets && args.assetSourceDir) {
            const assetBaseFolder = args.assetDestFolder
              ? (folder ? `${folder}/${args.assetDestFolder}` : args.assetDestFolder)
              : folder;
            const assetCount = await copyReferencedAssets(
              mem.content,
              args.assetSourceDir,
              vaultPath,
              assetBaseFolder,
              args.assetDestFolder
            );
            totalAssets += assetCount;
          }

          // obsidianPath 업데이트 (set_payload로 부분 업데이트)
          {
            const safeTitle = mem.title.replace(/[<>:"/\\|?*]/g, "_");
            const categoryFolder = args.subfolderByTag ? "" : (mem.category || "note");
            const relPath = categoryFolder
              ? (effectiveFolder ? `${effectiveFolder}/${categoryFolder}/${safeTitle}.md` : `${categoryFolder}/${safeTitle}.md`)
              : (effectiveFolder ? `${effectiveFolder}/${safeTitle}.md` : `${safeTitle}.md`);
            await setMemoryPayload(mem.id, {
              obsidianPath: relPath,
              updatedAt: new Date().toISOString(),
            });
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
    assetsCopied: totalAssets,
    errors: errors.length > 0 ? errors : undefined,
  } as Record<string, unknown>);
}
