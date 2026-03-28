/**
 * Obsidian 동기화 서비스
 * Obsidian vault의 마크다운 파일과 zime-memory 간 양방향 동기화를 담당한다.
 */

import { readdir, readFile, writeFile, mkdir, stat, copyFile } from "fs/promises";
import { existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { createHash } from "crypto";
import { join, basename, dirname, relative, resolve } from "path";
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

  const lines = yamlBlock.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;

    const key = kv[1].trim();
    const rawValue = (kv[2] || "").trim();

    if (rawValue === "") {
      // 다중줄 YAML 리스트: "tags:\n  - item1\n  - item2"
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1])) {
        i++;
        items.push(lines[i].replace(/^\s+-\s+/, "").replace(/^["']|["']$/g, ""));
      }
      if (items.length > 0) {
        metadata[key] = items;
      }
      continue;
    }

    let value: unknown = rawValue;

    // 인라인 배열 파싱: [tag1, tag2]
    if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
      value = value
        .slice(1, -1)
        .split(",")
        .map((v) => v.trim().replace(/^["']|["']$/g, ""))
        .filter((v) => v.length > 0);
    }

    metadata[key] = value;
  }

  return { metadata, content };
}

/** Obsidian 태그 규격에 맞게 변환 (공백→하이픈, 콜론→슬래시) */
function sanitizeObsidianTag(tag: string): string {
  return tag.replace(/ /g, "-").replace(/:/g, "/");
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
  /** 에셋 경로 변환: ../ITSM-XXXX/ → ../res/ITSM-XXXX/ 등 */
  assetPathPrefix?: string;
}): string {
  const frontmatter = [
    "---",
    `zime-id: ${memory.id}`,
    memory.category ? `category: ${memory.category}` : null,
    memory.priority ? `priority: ${memory.priority}` : null,
    memory.tags && memory.tags.length > 0
      ? `tags: [${memory.tags.map(sanitizeObsidianTag).join(", ")}]`
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

  // 에셋 경로 변환: ../ITSM- → ../res/ITSM- (assetPathPrefix가 지정된 경우)
  let processedContent = memory.content;
  if (memory.assetPathPrefix) {
    processedContent = processedContent.replace(
      /\.\.\/(?!res\/)(?=ITSM-)/g,
      `../${memory.assetPathPrefix}/`
    );
  }

  return `${frontmatter}\n\n${processedContent}${relatedSection}`;
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
    assetPathPrefix?: string;
  }
): Promise<string> {
  // 카테고리별 하위 폴더 구성 (예: zime-memory/note/, zime-memory/knowledge/)
  // category가 빈 문자열이면 카테고리 폴더를 생략한다 (subfolderByTag 사용 시)
  const categoryFolder = note.category || "";
  const targetDir = categoryFolder
    ? (folder ? resolve(vaultPath, folder, categoryFolder) : resolve(vaultPath, categoryFolder))
    : (folder ? resolve(vaultPath, folder) : resolve(vaultPath));

  /* 경로 순회 방지 — targetDir가 vaultPath 범위 내인지 검증 */
  if (!targetDir.startsWith(resolve(vaultPath))) {
    throw new Error(`허용되지 않은 경로입니다: ${folder}`);
  }

  if (!existsSync(targetDir)) {
    await mkdir(targetDir, { recursive: true });
  }

  // 파일명에 사용 불가한 문자 제거 + 길이 제한 (255바이트)
  let safeTitle = note.title.replace(/[<>:"/\\|?*]/g, "_");
  if (Buffer.byteLength(safeTitle, "utf-8") > 200) {
    const titleHash = createHash("md5").update(note.title).digest("hex").slice(0, 8);
    safeTitle = safeTitle.slice(0, 190) + "_" + titleHash;
  }
  const filePath = resolve(targetDir, `${safeTitle}.md`);

  /* 경로 순회 방지 — filePath가 vaultPath 범위 내인지 검증 */
  if (!filePath.startsWith(resolve(vaultPath))) {
    throw new Error(`허용되지 않은 파일명입니다: ${note.title}`);
  }
  const markdown = toObsidianMarkdown(note);

  // 기존 파일과 내용 비교 → 변경 시에만 덮어쓰기
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf-8");
    if (existing === markdown) {
      return relative(vaultPath, filePath); // 동일 → 스킵
    }
  }

  await writeFile(filePath, markdown, "utf-8");
  info(`Obsidian 노트 저장: ${filePath}`);
  return relative(vaultPath, filePath);
}

/**
 * MD 콘텐츠에서 이미지/파일 참조를 파싱하여 vault로 복사한다.
 * 상대 경로(../ITSM-XXXX/image.png)와 절대 경로 모두 지원.
 * assetDestFolder 지정 시 해당 폴더 하위에 복사한다 (예: "res").
 */
export async function copyReferencedAssets(
  content: string,
  sourceBaseDir: string,
  vaultPath: string,
  folder?: string,
  assetDestFolder?: string
): Promise<number> {
  const imgRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
  const refs: string[] = [];
  let match;
  while ((match = imgRegex.exec(content)) !== null) {
    refs.push(match[1]);
  }

  let copied = 0;
  for (const ref of refs) {
    let sourcePath: string;
    let targetRelPath: string;

    if (ref.startsWith("../")) {
      const cleanRef = ref.replace(/^\.\.\//, "");
      // assetDestFolder가 있으면 ../res/ITSM-XXXX/ 형태에서 res/ 제거하여 소스 경로 생성
      const refWithoutDest = assetDestFolder && cleanRef.startsWith(assetDestFolder + "/")
        ? cleanRef.slice(assetDestFolder.length + 1)
        : cleanRef;
      sourcePath = resolve(sourceBaseDir, refWithoutDest);
      // 타겟은 항상 원래 cleanRef 구조 유지 (res/ITSM-XXXX/image.png)
      targetRelPath = cleanRef;
    } else if (ref.startsWith("/")) {
      sourcePath = ref;
      targetRelPath = assetDestFolder
        ? `${assetDestFolder}/${basename(ref)}`
        : basename(ref);
    } else {
      continue;
    }

    // folder 기준으로 타겟 경로 생성 (effectiveFolder가 아닌 base folder)
    const targetDir = folder
      ? resolve(vaultPath, folder, dirname(targetRelPath))
      : resolve(vaultPath, dirname(targetRelPath));
    const targetPath = resolve(targetDir, basename(targetRelPath));

    // 경로 순회 방지
    if (!targetPath.startsWith(resolve(vaultPath))) continue;

    if (!existsSync(sourcePath)) continue;

    if (existsSync(targetPath)) {
      // 파일 존재 시: 크기 비교 → 다르면 해시 비교 → 다르면 업데이트
      try {
        const srcStat = statSync(sourcePath);
        const tgtStat = statSync(targetPath);
        if (srcStat.size === tgtStat.size) {
          // 크기 같으면 해시 비교 (50MB 이하만)
          if (srcStat.size <= 50 * 1024 * 1024) {
            const srcHash = createHash("md5").update(readFileSync(sourcePath)).digest("hex");
            const tgtHash = createHash("md5").update(readFileSync(targetPath)).digest("hex");
            if (srcHash === tgtHash) continue; // 동일 파일 → 스킵
          } else {
            continue; // 50MB 초과 + 크기 동일 → 스킵
          }
        }
        // 내용 다름 → 덮어쓰기
        await copyFile(sourcePath, targetPath);
        copied++;
      } catch (err) {
        info(`에셋 비교 실패: ${sourcePath} → ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      // 파일 없음 → 새로 복사
      mkdirSync(targetDir, { recursive: true });
      try {
        await copyFile(sourcePath, targetPath);
        copied++;
      } catch (err) {
        info(`에셋 복사 실패: ${sourcePath} → ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return copied;
}
