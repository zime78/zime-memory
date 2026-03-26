/**
 * Obsidian 동기화 서비스
 * Obsidian vault의 마크다운 파일과 zime-memory 간 양방향 동기화를 담당한다.
 */

import { readdir, readFile, writeFile, mkdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { join, basename, relative, resolve } from "path";
import { info } from "../utils/logger.js";

/** Obsidian 노트 구조 */
export interface ObsidianNote {
  /** vault 내 상대 경로 */
  path: string;
  /** 파일명 (확장자 제외) */
  title: string;
  /** 마크다운 본문 내용 (frontmatter 제외) */
  content: string;
  /** YAML frontmatter에서 추출한 메타데이터 */
  metadata: {
    zimeId?: string;
    category?: string;
    priority?: string;
    tags?: string[];
  };
  /** 파일 수정 시각 (ISO 8601) */
  updatedAt: string;
}

/**
 * YAML frontmatter를 파싱한다.
 * --- 으로 감싸진 YAML 블록에서 key-value를 추출한다.
 */
function parseFrontmatter(raw: string): {
  metadata: Record<string, unknown>;
  content: string;
} {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { metadata: {}, content: raw };
  }

  const yamlBlock = match[1];
  const content = match[2].trim();
  const metadata: Record<string, unknown> = {};

  for (const line of yamlBlock.split("\n")) {
    const kv = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (kv) {
      const key = kv[1].trim();
      let value: unknown = kv[2].trim();

      // 배열 파싱: [tag1, tag2]
      if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
        value = value
          .slice(1, -1)
          .split(",")
          .map((v) => v.trim().replace(/^["']|["']$/g, ""))
          .filter((v) => v.length > 0);
      }

      metadata[key] = value;
    }
  }

  return { metadata, content };
}

/**
 * 메모리 데이터를 Obsidian 마크다운 형식으로 변환한다.
 * YAML frontmatter에 zime-memory 메타데이터를 포함한다.
 */
export function toObsidianMarkdown(memory: {
  id: string;
  title?: string;
  content: string;
  category?: string;
  priority?: string;
  tags?: string[];
  /** 연결된 메모리 제목 목록 (wiki-link 생성용) */
  relatedTitles?: string[];
}): string {
  const frontmatter = [
    "---",
    `zime-id: ${memory.id}`,
    memory.category ? `category: ${memory.category}` : null,
    memory.priority ? `priority: ${memory.priority}` : null,
    memory.tags && memory.tags.length > 0
      ? `tags: [${memory.tags.join(", ")}]`
      : null,
    "---",
  ]
    .filter(Boolean)
    .join("\n");

  // 연결된 메모리를 Obsidian wiki-link로 추가
  let relatedSection = "";
  if (memory.relatedTitles && memory.relatedTitles.length > 0) {
    const links = memory.relatedTitles
      .map((t) => `- [[${t.replace(/[<>:"/\\|?*]/g, "_")}]]`)
      .join("\n");
    relatedSection = `\n\n---\n\n## Related\n${links}`;
  }

  return `${frontmatter}\n\n${memory.content}${relatedSection}`;
}

/**
 * vault 경로에서 마크다운 파일 목록을 읽는다.
 *
 * @param vaultPath - Obsidian vault 경로
 * @param folder - vault 내 하위 폴더 (선택)
 * @returns 노트 목록
 */
export async function readVaultNotes(
  vaultPath: string,
  folder?: string
): Promise<ObsidianNote[]> {
  const targetPath = folder ? resolve(vaultPath, folder) : resolve(vaultPath);

  /* 경로 순회 방지 — targetPath가 vaultPath 범위 내인지 검증 */
  if (!targetPath.startsWith(resolve(vaultPath))) {
    throw new Error(`허용되지 않은 경로입니다: ${folder}`);
  }

  if (!existsSync(targetPath)) {
    throw new Error(`경로가 존재하지 않습니다: ${targetPath}`);
  }

  const entries = await readdir(targetPath, { withFileTypes: true });
  const notes: ObsidianNote[] = [];

  /** 단일 .md 파일을 파싱하여 notes 배열에 추가한다 */
  async function parseAndPush(filePath: string, categoryHint?: string) {
    const raw = await readFile(filePath, "utf-8");
    const fileStat = await stat(filePath);
    const { metadata, content } = parseFrontmatter(raw);

    // frontmatter에 카테고리가 없으면 폴더명을 카테고리로 사용
    const category = (metadata.category as string | undefined) || categoryHint;

    notes.push({
      path: relative(vaultPath, filePath),
      title: basename(filePath, ".md"),
      content,
      metadata: {
        zimeId: metadata["zime-id"] as string | undefined,
        category,
        priority: metadata.priority as string | undefined,
        tags: Array.isArray(metadata.tags) ? metadata.tags : undefined,
      },
      updatedAt: fileStat.mtime.toISOString(),
    });
  }

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      // 루트 폴더의 마크다운 파일 (기존 평탄 구조 호환)
      await parseAndPush(join(targetPath, entry.name));
    } else if (entry.isDirectory()) {
      // 카테고리 하위 폴더 탐색 (1단계)
      const subPath = join(targetPath, entry.name);
      const subEntries = await readdir(subPath, { withFileTypes: true });
      for (const subEntry of subEntries) {
        if (!subEntry.isFile() || !subEntry.name.endsWith(".md")) continue;
        await parseAndPush(join(subPath, subEntry.name), entry.name);
      }
    }
  }

  return notes;
}

/**
 * 메모리를 Obsidian vault에 마크다운 파일로 저장한다.
 *
 * @param vaultPath - Obsidian vault 경로
 * @param folder - vault 내 하위 폴더 (선택)
 * @param note - 저장할 노트 데이터
 * @returns 저장된 파일 경로
 */
export async function writeVaultNote(
  vaultPath: string,
  folder: string | undefined,
  note: {
    id: string;
    title: string;
    content: string;
    category?: string;
    priority?: string;
    tags?: string[];
    relatedTitles?: string[];
  }
): Promise<string> {
  // 카테고리별 하위 폴더 구성 (예: zime-memory/note/, zime-memory/knowledge/)
  const categoryFolder = note.category || "note";
  const targetDir = folder
    ? resolve(vaultPath, folder, categoryFolder)
    : resolve(vaultPath, categoryFolder);

  /* 경로 순회 방지 — targetDir가 vaultPath 범위 내인지 검증 */
  if (!targetDir.startsWith(resolve(vaultPath))) {
    throw new Error(`허용되지 않은 경로입니다: ${folder}`);
  }

  if (!existsSync(targetDir)) {
    await mkdir(targetDir, { recursive: true });
  }

  // 파일명에 사용 불가한 문자 제거
  const safeTitle = note.title.replace(/[<>:"/\\|?*]/g, "_");
  const filePath = resolve(targetDir, `${safeTitle}.md`);

  /* 경로 순회 방지 — filePath가 vaultPath 범위 내인지 검증 */
  if (!filePath.startsWith(resolve(vaultPath))) {
    throw new Error(`허용되지 않은 파일명입니다: ${note.title}`);
  }
  const markdown = toObsidianMarkdown(note);

  await writeFile(filePath, markdown, "utf-8");
  info(`Obsidian 노트 저장: ${filePath}`);
  return relative(vaultPath, filePath);
}
