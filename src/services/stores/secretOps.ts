/**
 * secrets store 연산
 * SQLCipher 암호화 DB에 비밀값을 저장한다.
 */

import {
  saveSecret,
  isSqlcipherReady,
} from "../sqlcipherService.js";
import type { RouteResult } from "../../types/index.js";

/** secrets store 저장 — SQLCipher만 */
export function saveSecretEntry(args: {
  name: string;
  value: string;
  secretType: string;
  service?: string;
  tags?: string[];
  notes?: string;
  expiresAt?: string;
}): RouteResult {
  if (!isSqlcipherReady()) {
    throw new Error("SQLCipher가 초기화되지 않았습니다. ZIME_ENCRYPTION_KEY 환경변수를 확인하세요.");
  }
  const result = saveSecret({
    name: args.name,
    value: args.value,
    secretType: args.secretType,
    service: args.service,
    tags: args.tags,
    notes: args.notes,
    expiresAt: args.expiresAt,
  });
  return { id: result.id, store: "secrets" };
}
