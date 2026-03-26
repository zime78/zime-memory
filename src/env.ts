/**
 * 환경변수 로드 모듈
 * ES 모듈에서 다른 모듈보다 먼저 실행되도록 별도 파일로 분리한다.
 * index.ts의 첫 번째 import로 사용하여 config.ts가 process.env를 읽기 전에 .env를 로드한다.
 */

import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: join(__dirname, "..", ".env") });
