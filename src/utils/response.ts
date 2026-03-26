/**
 * MCP 도구 공통 응답 유틸리티
 * 모든 도구 핸들러가 동일한 응답 형식을 사용하도록 통일한다.
 */

/** MCP 도구 응답 타입 */
export interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** 성공 JSON 응답을 생성한다 */
export function jsonResponse(data: Record<string, unknown>): ToolResponse {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

/** 에러 응답을 생성한다 */
export function errorResponse(message: string): ToolResponse {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: message }, null, 2) }],
    isError: true,
  };
}
