/**
 * Ollama LLM 서비스 (선택사항)
 * 카테고리별 요약(memory_summarize)을 위해 Ollama의 텍스트 생성 API를 호출한다.
 * 임베딩 전용인 embeddingService.ts와 분리하여 LLM 생성 기능을 담당한다.
 *
 * 주의: LLM_MODEL 환경변수 미설정 시 이 서비스의 모든 함수는 실패한다.
 * 태그는 Claude가 memory_save 호출 시 직접 제공하므로 suggestTags는 더 이상 사용되지 않는다.
 * summarizeTexts만 memory_summarize에서 사용된다.
 */

import { config } from "../config.js";
import { error as logError } from "../utils/logger.js";

/** Ollama /api/generate 응답 타입 */
interface OllamaGenerateResponse {
  response: string;
  done: boolean;
}

/**
 * Ollama LLM에 텍스트 생성을 요청한다.
 *
 * @param prompt - 생성 프롬프트
 * @returns 생성된 텍스트
 */
async function generate(prompt: string): Promise<string> {
  const url = `${config.ollama.url}/api/generate`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.llm.model,
      prompt,
      stream: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Ollama 생성 요청 실패 (HTTP ${response.status}): ${body}`
    );
  }

  const data = (await response.json()) as OllamaGenerateResponse;
  return data.response.trim();
}

/**
 * 여러 텍스트를 종합하여 요약을 생성한다.
 * 카테고리별 메모리 요약에 사용된다.
 *
 * @param texts - 요약할 텍스트 배열
 * @param context - 요약 맥락 (예: 카테고리명, 태그 등)
 * @returns 요약 텍스트
 */
export async function summarizeTexts(
  texts: string[],
  context: string
): Promise<string> {
  // 텍스트가 너무 길면 각각 앞부분만 잘라서 결합한다
  const maxPerText = Math.floor(4000 / texts.length);
  const combined = texts
    .map((t, i) => {
      const truncated = t.length > maxPerText ? t.substring(0, maxPerText) + "..." : t;
      return `[${i + 1}] ${truncated}`;
    })
    .join("\n\n");

  const prompt = `다음은 "${context}" 관련 메모리 ${texts.length}건이다. 핵심 주제와 인사이트를 한국어로 요약해줘. 구조화된 요약을 제공하되, 불필요한 서론 없이 바로 요약을 시작해.

${combined}

요약:`;

  try {
    return await generate(prompt);
  } catch (err) {
    logError("요약 생성 실패:", err);
    throw err;
  }
}
