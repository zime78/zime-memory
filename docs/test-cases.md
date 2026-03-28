# zime-memory Multi-Store 통합 테스트 케이스

> 최종 업데이트: 2026-03-27
> 대상 버전: v2.1.0 (Qdrant + MinIO + SQLCipher, 아키텍처 리팩토링)
> Phase 8-14: memory_update 버그 수정 검증 + 누락 도구 전수 검증
> Phase 15: 환경변수 Zod 검증 + LOG_LEVEL 테스트 (v2.1.0)
> Phase 16: 임베딩 프로바이더 3-Mode 테스트 (ollama/local/off)
> Phase 17: 원격 접속 + 읽기 캐시 테스트 (서버/클라이언트)

## 사전 조건

### 자동 셋업 (권장)

```bash
bash scripts/test-setup.sh setup    # 서비스 확인 + 테스트 파일 6개 자동 생성
bash scripts/test-setup.sh status   # 서비스 + 파일 상태 확인
bash scripts/test-setup.sh cleanup  # 테스트 파일 전체 삭제
```

### 생성되는 테스트 파일

| 파일 | 크기 | 경로 | 용도 |
|------|------|------|------|
| `test-image.png` | 67B | `/tmp/zime-memory-test/` | Phase 2: images store CRUD (1x1 PNG) |
| `test-image-update.jpeg` | 22B | `/tmp/zime-memory-test/` | Phase 8: images update 테스트 (JFIF) |
| `test-config.json` | 90B | `/tmp/zime-memory-test/` | Phase 3: files store CRUD |
| `test-archive.zip` | ~211B | `/tmp/zime-memory-test/` | Phase 8: files update 테스트 |
| `test-51mb.bin` | 51MB | `/tmp/zime-memory-test/` | T25: 파일 크기 제한 (50MB 초과) |
| `test-document.txt` | ~189B | `/tmp/zime-memory-test/` | export/import 참조 문서 |

### 수동 셋업 (대안)

1. **Docker 서비스 실행 확인**
   ```bash
   curl -s http://localhost:6333/healthz        # Qdrant
   curl -s http://localhost:9000/minio/health/live  # MinIO
   curl -s http://localhost:11434/api/tags       # Ollama
   ```

2. **테스트 파일 수동 생성** (자동 셋업 사용 시 불필요)
   ```bash
   mkdir -p /tmp/zime-memory-test

   # 1x1 PNG (67 bytes)
   printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82' > /tmp/zime-memory-test/test-image.png

   # JSON 설정 파일 (90 bytes)
   echo '{"compilerOptions":{"target":"ES2022","module":"ESNext","strict":true},"include":["src"]}' > /tmp/zime-memory-test/test-config.json

   # 51MB 더미 파일 (크기 제한 테스트)
   dd if=/dev/zero of=/tmp/zime-memory-test/test-51mb.bin bs=1048576 count=51
   ```

3. **환경변수 확인** (`.env` 또는 settings.json)
   - `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` 설정됨
   - `ZIME_ENCRYPTION_KEY` 설정됨 (hex 64자)

---

## Phase 1: General Store (기존 기능 하위 호환)

### T01: general 메모리 저장
- **도구**: `memory_save`
- **입력**:
  ```json
  {
    "store": "general",
    "content": "Next.js 15에서 Server Actions는 use server 지시어로 서버 전용 함수를 정의한다. 클라이언트 컴포넌트에서 직접 호출 가능하며 form action에 바인딩할 수 있다.",
    "title": "Next.js 15 Server Actions 정리",
    "tags": ["nextjs", "server-actions", "react"],
    "category": "knowledge",
    "priority": "high"
  }
  ```
- **기대 결과**: `success: true`, `id` (UUID), `store: "general"`
- **검증 포인트**: store 미지정 시에도 동일 동작 확인 (하위 호환)

### T02: general 벡터 검색
- **도구**: `memory_search`
- **입력**:
  ```json
  {
    "store": "general",
    "query": "Next.js Server Actions 사용법",
    "limit": 3
  }
  ```
- **기대 결과**: T01 결과 검색됨, `score > 0.5`
- **검증 포인트**: images/files store 데이터가 결과에 포함되지 않음 (store 격리)

### T03: general ID 조회
- **도구**: `memory_get`
- **입력**: `{ "store": "general", "id": "<T01 id>" }`
- **기대 결과**: 전체 payload 반환, `store: "general"`, content 잘림 없음

### T04: general 목록 조회
- **도구**: `memory_list`
- **입력**: `{ "store": "general" }`
- **기대 결과**: T01 포함된 목록, `count >= 1`

---

## Phase 2: Images Store (MinIO 이중 쓰기)

### T05: 이미지 저장 (filePath)
- **도구**: `memory_save`
- **입력**:
  ```json
  {
    "store": "images",
    "filePath": "/tmp/zime-memory-test/test-image.png",
    "mimeType": "image/png",
    "description": "시스템 아키텍처 다이어그램 - Qdrant MinIO SQLCipher 하이브리드 구조",
    "tags": ["아키텍처", "다이어그램"],
    "originalName": "architecture-diagram.png"
  }
  ```
- **기대 결과**: `success: true`, `objectKey`, `bucket: "zime-memory-images"`, `size: 67`
- **검증 포인트**:
  - MinIO에 바이너리 업로드됨
  - Qdrant에 메타데이터 저장됨 (이중 쓰기)
  - `objectKey` 형식: `{uuid}.png`

### T06: 이미지 검색
- **도구**: `memory_search`
- **입력**: `{ "store": "images", "query": "아키텍처 다이어그램", "limit": 3 }`
- **기대 결과**: T05 결과 검색됨, `presignedUrl` 포함, `score > 0.3`
- **검증 포인트**: presignedUrl이 `http://localhost:9000/zime-memory-images/...` 형식

### T07: 이미지 다운로드 (presigned URL)
- **도구**: `memory_download`
- **입력**: `{ "id": "<T05 id>", "store": "images", "urlOnly": true }`
- **기대 결과**: `presignedUrl` 반환, `mimeType: "image/png"`, `fileSize: 67`
- **검증 포인트**: URL이 1시간 유효 (X-Amz-Expires=3600)

### T08: 이미지 ID 조회
- **도구**: `memory_get`
- **입력**: `{ "store": "images", "id": "<T05 id>" }`
- **기대 결과**: 메타 전체 + `objectKey`, `bucket`, `mimeType`, `description`, `presignedUrl`
- **검증 포인트**: images 전용 필드(objectKey, bucket, mimeType, fileSize, description) 모두 포함

---

## Phase 3: Files Store (MinIO 이중 쓰기)

### T09: 파일 저장 (filePath)
- **도구**: `memory_save`
- **입력**:
  ```json
  {
    "store": "files",
    "filePath": "/tmp/zime-memory-test/test-config.json",
    "mimeType": "application/json",
    "description": "프로젝트 설정 파일 백업 - tsconfig.json 원본 보관",
    "tags": ["설정", "백업"],
    "originalName": "tsconfig.json"
  }
  ```
- **기대 결과**: `success: true`, `bucket: "zime-memory-files"`, `size: 90`

### T10: 파일 검색
- **도구**: `memory_search`
- **입력**: `{ "store": "files", "query": "tsconfig 설정 파일", "limit": 3 }`
- **기대 결과**: T09 결과 검색됨, `presignedUrl` 포함

### T11: 파일 목록 조회
- **도구**: `memory_list`
- **입력**: `{ "store": "files" }`
- **기대 결과**: T09 포함, `count >= 1`

---

## Phase 4: Secrets Store (SQLCipher)

### T12: 시크릿 저장
- **도구**: `memory_save`
- **입력**:
  ```json
  {
    "store": "secrets",
    "name": "OpenAI API Key (테스트)",
    "value": "FAKE-TEST-VALUE-NOT-A-REAL-KEY",
    "secretType": "api-key",
    "service": "openai",
    "tags": ["ai", "api"],
    "notes": "테스트용 가짜 키"
  }
  ```
- **기대 결과**: `success: true`, `id` (UUID), `store: "secrets"`

### T13: 시크릿 검색 (보안 검증)
- **도구**: `memory_search`
- **입력**: `{ "store": "secrets", "query": "OpenAI" }`
- **기대 결과**: T12 이름으로 검색됨
- **보안 검증**: 응답에 `value` 필드 **미포함** (name, secretType, service만)

### T14: 시크릿 ID 조회
- **도구**: `memory_get`
- **입력**: `{ "store": "secrets", "id": "<T12 id>" }`
- **기대 결과**: 전체 필드 반환
- **보안 검증**: get에서는 `value: "FAKE-TEST-VALUE-NOT-A-REAL-KEY"` **포함** (의도적)

### T15: 시크릿 목록 (보안 검증)
- **도구**: `memory_list`
- **입력**: `{ "store": "secrets" }`
- **기대 결과**: T12 포함, `count >= 1`
- **보안 검증**: 목록에 `value` 필드 **미포함**

---

## Phase 5: 크로스 스토어 + 통합 기능

### T16: 크로스 검색 (all)
- **도구**: `memory_search`
- **입력**: `{ "store": "all", "query": "시스템 아키텍처", "limit": 10 }`
- **기대 결과**: general + images + files + secrets 병합 결과
- **검증 포인트**:
  - 벡터 결과는 `matchType: "vector"`, `score > 0`
  - secrets 결과는 `matchType: "keyword"`, `score: null`
  - images/files 결과에 `presignedUrl` 포함
  - score 기준 내림차순 정렬

### T17: 전체 통계
- **도구**: `memory_stats`
- **입력**: `{}` (파라미터 없음)
- **기대 결과**:
  ```json
  {
    "general": { "pointsCount": N, "status": "green" },
    "images": { "objectCount": N, "totalSize": N },
    "files": { "objectCount": N, "totalSize": N },
    "secrets": { "total": N, "breakdown": { "api-key": N } },
    "totalPoints": N
  }
  ```
- **검증 포인트**: 4개 store 모두 통계 포함

### T18: 전체 카운트
- **도구**: `memory_count`
- **입력**: `{ "store": "all" }`
- **기대 결과**: `total: N`, `byStore: { qdrant: N, secrets: N }`

### T19: 마이그레이션 분석
- **도구**: `memory_migrate`
- **입력**: `{ "mode": "analyze" }`
- **기대 결과**: `total`, `withStore`, `withoutStore` 건수
- **검증 포인트**: 신규 데이터는 모두 `withStore`에 포함 (withoutStore: 0)

### T20: 통합 백업
- **도구**: `memory_backup`
- **입력**: `{ "unified": true }`
- **기대 결과**:
  - `qdrant`: 스냅샷 이름 + 크기
  - `minio`: NAS_BACKUP_PATH 설정 시 동기화 건수, 미설정 시 null
  - `sqlcipher`: NAS_BACKUP_PATH 설정 시 백업 경로, 미설정 시 null
  - `errors`: 빈 배열

### T20-1: SSH 원격 백업
- **도구**: `memory_backup`
- **입력**: `{ "remoteBackup": true }`
- **사전 조건**: SSH 연결 가능 (`ssh mac "echo ok"`), secrets.db 존재, SSH_BACKUP_HOST 설정
- **기대 결과**:
  - `remoteBackup.host`: SSH 호스트명
  - `remoteBackup.snapshotName`: `secrets_YYYY-MM-DDTHH-MM-SS.db` 형식
  - `remoteBackup.dbSize`: 0보다 큰 숫자
- **검증**: 원격 디렉토리에 current/secrets.db, current/.env, snapshots/ 파일 존재 확인

### T20-2: SSH 원격 백업 상태 조회
- **도구**: `memory_backup`
- **입력**: `{ "remoteStatus": true }`
- **사전 조건**: T20-1 완료 (원격 백업 1회 이상 수행)
- **기대 결과**:
  - `status.snapshotCount`: 1 이상
  - `status.latestSnapshot`: null이 아닌 파일명
  - `status.totalSize`: null이 아닌 용량 문자열

### T20-3: SSH 원격 스냅샷 목록
- **도구**: `memory_backup`
- **입력**: `{ "remoteList": true }`
- **사전 조건**: T20-1 완료
- **기대 결과**: `snapshots` 배열, 각 항목에 `name`, `size` 포함
- **검증**: 타임스탬프 역순 정렬

### T20-4: SSH 연결 실패 시 에러 처리
- **도구**: `memory_backup`
- **입력**: `{ "remoteBackup": true }` (SSH 미연결 상태에서 실행)
- **기대 결과**: `isError: true`, SSH 연결 실패 에러 메시지
- **검증**: 로컬 데이터(secrets.db, safety-backups)에 영향 없음

---

## Phase 6: 에지 케이스

### T21: store 미지정 시 기본값 확인
- **도구**: `memory_save`
- **입력**: `{ "content": "store 미지정 테스트" }` (store 파라미터 생략)
- **기대 결과**: `store: "general"`로 자동 라우팅

### T22: images store에서 필수 필드 누락
- **도구**: `memory_save`
- **입력**: `{ "store": "images", "description": "설명만 있음" }` (fileData/filePath 없음)
- **기대 결과**: `success: false`, 에러 메시지

### T23: secrets store에서 필수 필드 누락
- **도구**: `memory_save`
- **입력**: `{ "store": "secrets", "name": "테스트" }` (value, secretType 없음)
- **기대 결과**: `success: false`, 에러 메시지

### T24: 존재하지 않는 ID 조회
- **도구**: `memory_get`
- **입력**: `{ "store": "general", "id": "00000000-0000-0000-0000-000000000000" }`
- **기대 결과**: `success: false`, 에러 메시지

### T25: 파일 크기 제한 확인
- **검증 방법**: 50MB 초과 파일 저장 시도
- **기대 결과**: 에러 메시지 (크기 제한 초과)

---

## Phase 7: 정리 (DB 초기화)

### C01~C04: 개별 삭제
- 각 store별로 저장된 테스트 데이터 ID를 수집하여 `memory_delete` 호출
  ```
  memory_delete(store: "general", id: "<T01 id>")
  memory_delete(store: "images", id: "<T05 id>")
  memory_delete(store: "files", id: "<T09 id>")
  memory_delete(store: "secrets", id: "<T12 id>")
  ```

### C05: 최종 카운트 확인
- `memory_stats` → 모든 store의 카운트가 0

### C06: 테스트 파일 정리
- ```bash
  bash scripts/test-setup.sh cleanup   # 또는: rm -rf /tmp/zime-memory-test
  ```

---

## 테스트 실행 결과 기록

| # | 테스트 | 날짜 | 결과 | 비고 |
|---|--------|------|:---:|------|
| T01 | general 저장 | 2026-03-25 | PASS | id: 9dd1197b |
| T02 | general 검색 | 2026-03-25 | PASS | score: 0.756 |
| T03 | general ID 조회 | 2026-03-25 | PASS | |
| T04 | general 목록 | 2026-03-25 | PASS | |
| T05 | 이미지 저장 | 2026-03-25 | PASS | MinIO+Qdrant 이중쓰기 |
| T06 | 이미지 검색 | 2026-03-25 | PASS | presignedUrl 포함 |
| T07 | 이미지 다운로드 | 2026-03-25 | PASS | 1시간 URL |
| T08 | 이미지 ID 조회 | 2026-03-25 | PASS | 전용 필드 모두 포함 |
| T09 | 파일 저장 | 2026-03-25 | PASS | files 버킷 저장 |
| T10 | 파일 검색 | 2026-03-25 | PASS | presignedUrl 포함 |
| T11 | 파일 목록 | 2026-03-25 | PASS | |
| T12 | 시크릿 저장 | 2026-03-25 | PASS | SQLCipher 저장 |
| T13 | 시크릿 검색 | 2026-03-25 | PASS | value 미노출 |
| T14 | 시크릿 ID 조회 | 2026-03-25 | PASS | value 포함 |
| T15 | 시크릿 목록 | 2026-03-25 | PASS | value 미포함 |
| T16 | 크로스 검색 | 2026-03-25 | PASS | 3 store 병합 |
| T17 | 전체 통계 | 2026-03-25 | PASS | 4 store 통합 |
| T18 | 전체 카운트 | 2026-03-25 | PASS | store별 분류 |
| T19 | 마이그레이션 | 2026-03-25 | PASS | withoutStore: 0 |
| T20 | 통합 백업 | 2026-03-25 | PASS | Qdrant 스냅샷 1.2MB |
| T20-1 | SSH 원격 백업 | | TODO | SSH 연결 필요 |
| T20-2 | 원격 백업 상태 | | TODO | T20-1 선행 |
| T20-3 | 원격 스냅샷 목록 | | TODO | T20-1 선행 |
| T20-4 | SSH 연결 실패 에러 | | TODO | SSH 미연결 상태 |
| T21 | store 미지정 | 2026-03-25 | PASS | general 자동 라우팅 |
| T22 | images 필수 누락 | 2026-03-25 | PASS | 에러 메시지 반환 |
| T23 | secrets 필수 누락 | 2026-03-25 | PASS | 에러 메시지 반환 |
| T24 | 존재하지 않는 ID | 2026-03-25 | PASS | 에러 메시지 반환 |
| T25 | 파일 크기 제한 | 2026-03-25 | PASS | 51MB > 50MB 제한 |

---

## 보안 체크리스트

| # | 항목 | 기대 | 결과 |
|---|------|------|:---:|
| S01 | secrets search에서 value 미노출 | name/service/notes만 검색 | PASS |
| S02 | secrets list에서 value 미노출 | value 필드 제외 | PASS |
| S03 | secrets get에서 value 포함 | 명시적 조회 시만 | PASS |
| S04 | SQLCipher DB 전체 암호화 | ZIME_ENCRYPTION_KEY hex 검증 | PASS |
| S05 | MinIO 크레덴셜 미설정 시 에러 | undefined 기본값, 명확한 에러 | PASS |
| S06 | 파일 크기 50MB 제한 | maxFileSize 초과 시 에러 | PASS |
| S07 | Object Lock GOVERNANCE 30일 | 버킷 삭제 방지 | PASS |

---

## 참고: MCP 도구 store 파라미터 지원 현황

| 도구 | store 값 | 비고 |
|------|----------|------|
| memory_save | general/images/files/secrets | images/files: fileData/filePath 필수 |
| memory_search | general/images/files/secrets/**all** | all: 크로스 검색 |
| memory_list | general/images/files/secrets | |
| memory_get | general/images/files/secrets | images/files: presignedUrl 포함 |
| memory_update | general/images/files/secrets | |
| memory_delete | general/images/files/secrets | images: MinIO+Qdrant 동시 삭제 |
| memory_count | general/images/files/secrets/**all** | all: store별 분류 |
| memory_stats | (항상 전체) | 4 store 통합 |
| memory_export | general/images/files/secrets | secrets: value 제외 옵션 |
| memory_import | general/images/files | secrets 미지원 (보안) |
| memory_bulk_delete | general/images/files | secrets 미지원 (안전) |
| memory_backup | (항상 전체) | unified: true → 3 store 통합 |
| memory_download | images/files | presigned URL 또는 base64 |
| memory_migrate | - | analyze/tag-store 모드 |
| memory_link | general만 | Qdrant 전용 |
| memory_summarize | general만 | 텍스트 전용 |
| memory_reindex | general만 | Qdrant 전용 |
| memory_obsidian_sync | general만 | 텍스트 전용 |

---

## Phase 8: memory_update 집중 테스트 (store 필드 버그 수정 검증)

> **배경**: memory_update 시 mergedPayload에 `store` 필드 누락으로 list/search에서 항목 소실되는 버그 발견 및 수정.
> 수정 파일: `memoryUpdate.ts`, `memoryObsidianSync.ts`, `memoryLink.ts`, `qdrantService.ts`, `memoryImport.ts`

### T26: general content 수정 + 임베딩 재생성
- **도구**: `memory_save` → `memory_update` → `memory_list` → `memory_search`
- **검증**: content 수정 후 list 유지, 수정된 내용으로 search 가능 (임베딩 재생성)
- **핵심**: update 후 `store:"general"` 필드 보존 확인

### T27: general title 수정 + createdAt 유지
- **도구**: `memory_update` → `memory_get`
- **검증**: title 변경됨, content 유지, createdAt 유지, updatedAt 갱신

### T28: general tags 수정 + list 필터
- **도구**: `memory_update` → `memory_list`
- **검증**: 새 태그 list OK, 이전 태그 조회 0건

### T29: general category/priority/source 수정
- **도구**: `memory_update` → `memory_list(category+priority 필터)`
- **검증**: 3필드 변경, list 필터 정상 매칭

### T30: general draft→published 전환
- **도구**: `memory_save(status:draft)` → `memory_update(status:published)` → `memory_get`
- **검증**: expiresAt/ttl 제거됨, status=published

### T31: general pinned 수정
- **도구**: `memory_update(pinned:true)` → `memory_update(pinned:false)`
- **검증**: true→false 토글 정상

### T32: images content(description) 수정 (실제 이미지)
- **도구**: `memory_save(images, IMG_5133.jpeg)` → `memory_update(content)` → `memory_get` → `memory_search`
- **테스트 파일**: `/tmp/zime-memory-test/test-image.png` (scripts/test-setup.sh로 자동 생성)
- **검증**: description 재임베딩, objectKey/bucket/fileSize 유지, search 가능

### T33: images tags/title 수정
- **도구**: `memory_update(title,tags)` → `memory_list(images, 새 태그)`
- **검증**: title/tags 변경, 바이너리 메타 유지, list 정상

### T34: files content 수정 (실제 파일)
- **도구**: `memory_save(files, old_android_keystore.zip)` → `memory_update(content)` → `memory_list` → `memory_search`
- **테스트 파일**: `/tmp/zime-memory-test/test-archive.zip` (scripts/test-setup.sh로 자동 생성)
- **검증**: description 재임베딩, fileSize 유지, list/search 정상

### T35: secrets value 수정
- **도구**: `memory_save(secrets)` → `memory_update(content→value)` → `memory_get`
- **검증**: value "old→new" 변경, name/service 유지

### T36: secrets name/tags 수정
- **도구**: `memory_update(title→name, tags)` → `memory_search`
- **검증**: name 변경, search 가능, **value 미노출** (보안)

### T37: 존재하지 않는 ID update
- **도구**: `memory_update(id:00000000...)`
- **검증**: isError:true, "메모리를 찾을 수 없습니다"

---

## Phase 9: memory_export / memory_import

### T38: general export (태그 필터)
- **도구**: `memory_export(tags:["test-update-v2"])`
- **검증**: exportedAt, count, memories 배열 반환

### T39: general export (category+priority 필터)
- **도구**: `memory_export(category:snippet, priority:critical)`
- **검증**: 필터된 결과만 포함

### T40: secrets export (보안 검증)
- **도구**: `memory_export(store:secrets)`
- **검증**: **모든 value가 `***MASKED***`** (보안 OK)

### T41: import 신규 ID 2건
- **도구**: `memory_import(memories:[{content, tags}×2])`
- **검증**: imported:2, skipped:0
- **발견 버그**: `memoryImport.ts` payload에 `status` 필드 누락 → import된 항목이 list/search 기본 필터(status:"published")에서 누락
- **수정**: `memoryImport.ts`에 `status: "published"` 추가, `qdrantService.ts` upsertMemory guard에 status 기본값 추가

### T42: import 기존 ID (skipDuplicates=true)
- **도구**: `memory_import(skipDuplicates:true, memories:[{id:기존ID}])`
- **검증**: skipped:1, 원본 content 유지

### T43: import 기존 ID (skipDuplicates=false)
- **도구**: `memory_import(skipDuplicates:false, memories:[{id:기존ID}])`
- **검증**: imported:1, content 덮어쓰기 확인

---

## Phase 10: memory_link / memory_summarize

### T44: 양방향 연결 (기본)
- **도구**: `memory_save`×2 → `memory_link` → `memory_get`
- **검증**: source/target 양쪽 relatedIds, linkedMemories 표시

### T45: 단방향 연결
- **도구**: `memory_link(bidirectional:false)` → `memory_get(target)`
- **검증**: target의 relatedIds 비어있음

### T46: 자기 참조 에러
- **도구**: `memory_link(sourceId=targetId)`
- **검증**: "자기 자신과는 연결할 수 없습니다"

### T47: 존재하지 않는 ID 연결 에러
- **도구**: `memory_link(targetId:00000000...)`
- **검증**: "target 메모리를 찾을 수 없습니다"

### T48: summarize category 기반
- **도구**: `memory_summarize(category:knowledge)`
- **검증**: Ollama LLM 생성 모델 필요 (환경 의존)

### T49: summarize tags 기반
- **도구**: `memory_summarize(tags:[...])`
- **검증**: Ollama LLM 생성 모델 필요 (환경 의존)

---

## Phase 11: memory_bulk_delete / memory_restore

### T50: bulk_delete preview (confirm 미제공)
- **도구**: `memory_save`×2 → `memory_bulk_delete(tags, confirm 없음)`
- **검증**: preview:true, matchedCount:2, 실제 삭제 안됨

### T51: bulk_delete 실행 (confirm="DELETE")
- **도구**: `memory_bulk_delete(tags, confirm:"DELETE")` → `memory_list`
- **검증**: deletedCount:2, list 0건
- **참고**: bulk_delete는 hard delete (soft-delete 아님, restore 불가)

### T52: bulk_delete 필터 없이 에러
- **도구**: `memory_bulk_delete(confirm:"DELETE")` (필터 없음)
- **검증**: "최소 하나의 필터 조건이 필요합니다" (전체 삭제 방지)

### T53: bulk_delete category 필터
- **도구**: `memory_save(category:custom)` → `memory_bulk_delete(category:custom)`
- **검증**: deletedCount:1

### T54: restore list-deleted
- **도구**: `memory_save` → `memory_delete` → `memory_restore(action:"list-deleted")`
- **검증**: 삭제된 항목 목록에 포함

### T55: restore restore-item
- **도구**: `memory_restore(action:"restore-item", id)` → `memory_list`
- **검증**: 복원 후 list에 정상 노출

### T56: restore list-backups
- **도구**: `memory_restore(action:"list-backups")`
- **검증**: localBackups + qdrantSnapshots 배열 존재

### T57: restore-sqlcipher confirm 없이 안전 검증
- **도구**: `memory_restore(action:"restore-sqlcipher", backupFile:"nonexistent.db")`
- **검증**: confirm 없이 거부 메시지 반환 (안전장치)

### T57-1: 원격 스냅샷에서 복원
- **도구**: `memory_restore(action:"restore-from-remote", snapshotName:"secrets_*.db")`
- **사전 조건**: 원격 스냅샷 존재 (T20-1 완료)
- **기대 결과**:
  - `restoredFrom`: 스냅샷 파일명
  - `localBackup`: pre-remote-restore 백업 파일명 (기존 DB가 있을 경우)
  - `size`: 0보다 큰 숫자
- **검증**: 복원 후 SQLCipher DB open 성공 (무결성 확인), safety-backups에 pre-remote-restore 백업 생성됨

---

## Phase 12: memory_reindex

### T58: reindex 실행
- **도구**: `memory_reindex(confirm:"CONFIRM")`
- **검증**: processed 건수, failed:0, 기존 search 정상 작동

---

## Phase 13: 통합 시나리오

### T59: export→import 왕복
- **검증**: import된 데이터 search 가능 (status 수정 후)

### T60: save→update→link→get 통합
- **검증**: content 수정, relatedIds 포함, linkedMemories 표시, 전체 플로우 정합성

### T61: draft→published→search
- **검증**: draft 시 기본 search 제외, published 전환 후 search 포함 (score:1.0)

### T62: bulk_delete→restore 왕복
- **검증**: bulk_delete는 hard delete → restore 불가 (설계 의도)
- **참고**: soft-delete + restore는 `memory_delete` + `memory_restore` 조합 사용

---

## Phase 14: Cleanup

테스트 데이터 태그 기반 bulk_delete + 개별 delete로 전량 제거.

| 정리 대상 | 태그/ID | store |
|----------|--------|-------|
| C07 | test-update-v2 | general |
| C08 | test-update-status | general |
| C09 | test-import | general |
| C10 | test-import-overwrite | general |
| C11 | test-link | general |
| C12 | test-restore | general |
| C13 | test-e2e | general |
| C14 | test-draft-e2e | general |
| C15 | T32 이미지 ID | images |
| C16 | T34 파일 ID | files |
| C17 | T35 시크릿 ID | secrets |

### 최종 상태 확인
| 항목 | 초기 | 최종 | 상태 |
|------|:---:|:---:|:---:|
| general (필터) | 84 | 84 | **정상** |
| Images (MinIO) | 0 | 0 | **정상** |
| Files (MinIO) | 0 | 0 | **정상** |
| Secrets (SQLCipher) | 82 | 82 | **정상** |

---

## Phase 8-13 테스트 실행 결과 기록

| # | 테스트 | 날짜 | 결과 | 비고 |
|---|--------|------|:---:|------|
| T26 | general content 수정 | 2026-03-26 | PASS | 임베딩 재생성, search score:0.59 |
| T27 | general title 수정 | 2026-03-26 | PASS | createdAt 유지, updatedAt 갱신 |
| T28 | general tags 수정 | 2026-03-26 | PASS | 새 태그 OK, 이전 태그 0건 |
| T29 | general category/priority/source | 2026-03-26 | PASS | 3필드 변경, list 필터 정상 |
| T30 | draft→published 전환 | 2026-03-26 | PASS | expiresAt/ttl 제거 |
| T31 | pinned 수정 | 2026-03-26 | PASS | true→false 토글 |
| T32 | images content 수정 | 2026-03-26 | PASS | 실제 이미지 246KB, objectKey 유지 |
| T33 | images tags/title 수정 | 2026-03-26 | PASS | 바이너리 메타 유지, list 정상 |
| T34 | files content 수정 | 2026-03-26 | PASS | 실제 파일 165KB, fileSize 유지, search score:0.717 |
| T35 | secrets value 수정 | 2026-03-26 | PASS | value old→new 변경 |
| T36 | secrets name/tags 수정 | 2026-03-26 | PASS | search 가능, value 미노출 |
| T37 | 존재하지 않는 ID update | 2026-03-26 | PASS | 에러 정상 반환 |
| T38 | general export (태그) | 2026-03-26 | PASS | exportedAt, count:1 |
| T39 | general export (category+priority) | 2026-03-26 | PASS | 필터 적용, count:2 |
| T40 | secrets export (보안) | 2026-03-26 | PASS | 전체 value `***MASKED***` |
| T41 | import 신규 2건 | 2026-03-26 | PASS | **버그 발견→수정**: status 필드 누락 |
| T42 | import skipDuplicates=true | 2026-03-26 | PASS | skipped:1, 원본 유지 |
| T43 | import skipDuplicates=false | 2026-03-26 | PASS | imported:1, 덮어쓰기 |
| T44 | link 양방향 | 2026-03-26 | PASS | 양쪽 relatedIds, linkedMemories |
| T45 | link 단방향 | 2026-03-26 | PASS | target relatedIds 비어있음 |
| T46 | link 자기 참조 에러 | 2026-03-26 | PASS | 에러 정상 |
| T47 | link 존재하지 않는 ID 에러 | 2026-03-26 | PASS | 에러 정상 |
| T48 | summarize category | 2026-03-26 | SKIP | Ollama LLM 생성 모델 미설정 |
| T49 | summarize tags | 2026-03-26 | SKIP | Ollama LLM 생성 모델 미설정 |
| T50 | bulk_delete preview | 2026-03-26 | PASS | matchedCount:2, 삭제 안됨 |
| T51 | bulk_delete 실행 | 2026-03-26 | PASS | deletedCount:2, list 0건 |
| T52 | bulk_delete 필터 없이 에러 | 2026-03-26 | PASS | 전체 삭제 방지 안전장치 |
| T53 | bulk_delete category 필터 | 2026-03-26 | PASS | deletedCount:1 |
| T54 | restore list-deleted | 2026-03-26 | PASS | soft-delete 목록 포함 |
| T55 | restore restore-item | 2026-03-26 | PASS | 복원 후 list 정상 |
| T56 | restore list-backups | 2026-03-26 | PASS | local 8건 + qdrant 12건 |
| T57 | restore-sqlcipher dry-run | 2026-03-26 | PASS | confirm 없이 거부 |
| T57-1 | 원격 스냅샷 복원 | | TODO | SSH 연결 + T20-1 선행 |
| T58 | reindex | 2026-03-26 | PASS | 95건 처리, 0건 실패 |
| T59 | export→import 왕복 | 2026-03-26 | PASS | import 후 search 정상 |
| T60 | save→update→link→get 통합 | 2026-03-26 | PASS | 전체 플로우 정합성 |
| T61 | draft→published→search | 2026-03-26 | PASS | published 후 score:1.0 |
| T62 | bulk_delete→restore 왕복 | 2026-03-26 | PARTIAL | bulk_delete=hard delete, restore 불가 (설계 의도) |

---

## 발견 버그 및 수정 이력

### BUG-001: memory_update 후 list/search 누락 (2026-03-26 수정)
- **원인**: `memoryUpdate.ts` mergedPayload에 `store` 필드 누락 → upsert 전체 교체 시 store 삭제 → store:"general" 필터 매칭 실패
- **수정 파일**:
  - `src/tools/memoryUpdate.ts:190` — store 필드 추가
  - `src/tools/memoryObsidianSync.ts:110` — 새 메모리에 store:"general" 추가
  - `src/tools/memoryLink.ts:74,89` — source/target 명시적 store fallback
  - `src/services/qdrantService.ts:226-228` — upsertMemory 방어 guard (store+status)

### BUG-002: memory_import 후 list/search 누락 (2026-03-26 수정)
- **원인**: `memoryImport.ts` payload에 `status` 필드 누락 → 기본 필터(status:"published") 매칭 실패
- **수정 파일**:
  - `src/tools/memoryImport.ts:85` — `status: "published"` 추가

---

## Phase 15: 환경변수 검증 (P8 Zod)

> 대상: config.ts Zod 스키마 검증 + LOG_LEVEL 지원 (v2.1.0)

### T63: 유효한 환경변수로 서버 정상 시작
- **전제**: 모든 필수 환경변수 정상 설정 (MINIO_ACCESS_KEY, MINIO_SECRET_KEY, ZIME_ENCRYPTION_KEY)
- **실행**: `npm run build && node dist/index.js`
- **기대**: 서버 정상 시작, Zod 검증 에러 없음
- **검증**: MCP 클라이언트에서 memory_stats 호출 성공

### T64: MINIO_PORT에 비숫자 값 입력 시 Zod 에러로 서버 시작 실패 (fail-fast)
- **전제**: `.env`에서 `MINIO_PORT=abc` 설정
- **실행**: `node dist/index.js`
- **기대**: 서버 시작 실패, stderr에 Zod ValidationError 출력 (MINIO_PORT: Expected number)
- **검증**: 프로세스 exit code != 0, 에러 메시지에 "MINIO_PORT" 포함

### T65: LOG_LEVEL=debug 설정 시 debug 로그 출력 확인
- **전제**: `.env`에서 `LOG_LEVEL=debug` 설정
- **실행**: 서버 시작 후 memory_save 호출
- **기대**: stderr/stdout에 debug 레벨 로그 출력 (info 레벨에서는 미출력되는 상세 로그 포함)
- **검증**: `LOG_LEVEL=info` 설정 시 동일 작업에서 debug 로그 미출력 확인
  - `src/services/qdrantService.ts:229-231` — upsertMemory guard에 status 기본값 추가

---

## Phase 16: 임베딩 프로바이더 3-Mode 테스트

> 대상: EMBEDDING_PROVIDER 환경변수 (ollama/local/off) Strategy Pattern
> 관련 파일: embeddingService.ts, providers/*.ts, config.ts, healthCheck.ts, qdrantService.ts

### T66: ollama 모드 (기본값) — 기존 동작 호환
- **전제**: `EMBEDDING_PROVIDER=ollama` (또는 미설정), Ollama 서비스 실행 중
- **실행**: memory_save → memory_search → memory_update(content 변경)
- **기대**: 기존과 100% 동일한 동작 (벡터 임베딩 생성, 유사도 검색, 임베딩 재생성)
- **검증**: 검색 결과에 score > 0, 의미 유사도 매칭 정상

### T67: ollama 모드 — 헬스체크
- **전제**: `EMBEDDING_PROVIDER=ollama`
- **실행**: 서버 시작
- **기대**: 시작 로그에 "임베딩 프로바이더: ollama" 출력, Ollama 헬스체크 실행
- **검증**: stderr에 "Ollama 연결 성공 (모델: bge-m3)" 포함

### T68: local 모드 — 기본 save/search 동작
- **전제**: `EMBEDDING_PROVIDER=local`, `LOCAL_EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2`, Ollama 서비스 **미실행**
- **실행**: memory_save(content: "Docker Compose 네트워크 설정 방법") → memory_search(query: "도커 네트워크")
- **기대**: 임베딩 생성 성공 (Ollama 없이), 검색 결과에 저장한 메모리 반환
- **검증**: 검색 결과 score > 0, Ollama 미실행 상태에서도 정상 동작

### T69: local 모드 — 첫 실행 시 모델 다운로드
- **전제**: `EMBEDDING_PROVIDER=local`, `~/.cache/huggingface/` 에 모델 캐시 없음
- **실행**: memory_save 첫 호출
- **기대**: 로그에 "로컬 임베딩 모델 로딩 중: Xenova/all-MiniLM-L6-v2" 출력 후 다운로드 완료
- **검증**: `~/.cache/huggingface/` 에 모델 파일 캐시됨, 이후 호출 시 다운로드 없이 즉시 응답

### T70: local 모드 — 헬스체크 (Ollama 체크 스킵)
- **전제**: `EMBEDDING_PROVIDER=local`, Ollama 미실행
- **실행**: 서버 시작
- **기대**: 시작 로그에 "임베딩 프로바이더: local" 출력, Ollama 헬스체크 **미실행**
- **검증**: stderr에 "Ollama" 관련 에러 없음, "로컬 임베딩" 관련 메시지 출력

### T71: off 모드 — save/search 동작
- **전제**: `EMBEDDING_PROVIDER=off`, Ollama 미실행
- **실행**: memory_save(content: "테스트 메모") → memory_search(query: "테스트")
- **기대**: 저장 성공 (제로 벡터), 검색은 필터 기반으로 동작
- **검증**: 저장 응답에 에러 없음, 검색 결과의 score = 0

### T72: off 모드 — 검색 결과 notice 메시지
- **전제**: `EMBEDDING_PROVIDER=off`
- **실행**: memory_search(query: "테스트")
- **기대**: 응답에 `notice` 필드 포함 ("임베딩 비활성 상태: 의미 기반 유사도 검색을 사용할 수 없습니다")
- **검증**: notice 문자열에 "EMBEDDING_PROVIDER" 안내 포함

### T73: off 모드 — 헬스체크 (Ollama 체크 스킵)
- **전제**: `EMBEDDING_PROVIDER=off`, Ollama 미실행
- **실행**: 서버 시작
- **기대**: 시작 로그에 "임베딩이 비활성화되었습니다" 경고, Ollama 헬스체크 미실행
- **검증**: 서버 정상 시작, stderr에 Ollama 연결 에러 없음

### T74: off 모드 — reindex 거부
- **전제**: `EMBEDDING_PROVIDER=off`
- **실행**: memory_reindex(confirm: "CONFIRM")
- **기대**: 에러 응답 — "임베딩이 비활성(off) 상태입니다"
- **검증**: isError: true, 재인덱싱 미수행

### T75: 프로바이더 전환 — ollama→local 차원 불일치 감지
- **전제**: `EMBEDDING_PROVIDER=ollama`로 데이터 저장 (1024차원 컬렉션)
- **실행**: `EMBEDDING_PROVIDER=local`로 변경 후 서버 재시작, memory_reindex(confirm: "CONFIRM")
- **기대**: 차원 불일치 감지 (1024→384), 컬렉션 자동 재생성, 전체 벡터 재생성
- **검증**: 로그에 "차원 불일치 감지" + "컬렉션 재생성 완료 (384차원)" 출력, reindex 완료 후 검색 정상

### T76: 프로바이더 전환 — 페이로드 보존
- **전제**: T75 이후 상태 (ollama→local 전환 + reindex 완료)
- **실행**: memory_list 또는 memory_get으로 기존 데이터 확인
- **기대**: 전환 전 저장한 메모리의 content, title, tags, category 등 페이로드 그대로 보존
- **검증**: 전환 전 저장한 메모리 ID로 get → 동일 데이터 반환

### T77: 잘못된 EMBEDDING_PROVIDER 값
- **전제**: `EMBEDDING_PROVIDER=invalid` 설정
- **실행**: 서버 시작
- **기대**: Zod 검증 에러로 서버 시작 실패
- **검증**: stderr에 Zod ValidationError, EMBEDDING_PROVIDER 관련 에러 메시지

### T78: local 모드 — @huggingface/transformers 미설치 시
- **전제**: `EMBEDDING_PROVIDER=local`, node_modules에서 @huggingface/transformers 제거
- **실행**: memory_save 호출
- **기대**: 에러 응답 — 패키지 미설치 안내
- **검증**: 에러 메시지에 "npm install @huggingface/transformers" 포함

---

## Phase 17: 원격 접속 + 읽기 캐시 (서버/클라이언트)

> 사전 조건: Mac Mini Docker 실행 중, autossh 설치됨, SSH 키 인증 설정됨

### Phase 17-A: 서버 모드 테스트 (Mac Mini, CACHE_ENABLED=false)

#### T-S01: 서버 모드 서비스 시작 확인
- **사전 조건**: `.env`에 `CACHE_ENABLED=false`
- **검증 방법**: MCP 서버 시작 로그 확인
- **기대 결과**:
  - 로그에 `[CACHE]`, `[CONNECTION]` 메시지 **없음**
  - 기존 로그만 출력 (Qdrant, MinIO, SQLCipher 초기화)
- **검증 포인트**: `data/cache.db` 파일이 **생성되지 않음**

#### T-S02: 서버 모드 기존 기능 정상 동작
- **검증 방법**: Phase 1~6의 T01~T25 전체 정상 통과
- **기대 결과**: 기존 테스트 100% 통과, 성능 차이 없음

#### T-S03: 서버 모드 connectionMonitor 비활성 확인
- **검증 방법**: `isOnline()` 호출
- **기대 결과**: 항상 `true` 반환 (모니터링 비활성)

---

### Phase 17-B: 클라이언트 모드 — SSH 터널 연결 테스트

#### T-C01: SSH 터널 스크립트 실행
- **사전 조건**: Mac Mini Docker 서비스 실행 중
- **검증 방법**: `./scripts/ssh-tunnel.sh` 실행
- **기대 결과**:
  ```bash
  curl -s http://localhost:6333/healthz        # → Qdrant 응답
  curl -s -o /dev/null -w "%{http_code}" http://localhost:9000/minio/health/live  # → 200
  curl -s http://localhost:11434/api/tags | head -1  # → {"models":[...]}
  ```
- **검증 포인트**: 3개 서비스 모두 localhost로 접근 가능

#### T-C02: SSH 터널 자동 재연결 (autossh)
- **검증 방법**: `pkill -f "ssh.*mac-mini"` → 10초 대기 → 서비스 재확인
- **기대 결과**: autossh가 자동 재연결, 서비스 접근 복구

#### T-C03: launchd 자동시작 확인
- **검증 방법**: `launchctl list | grep zime.memory-tunnel`
- **기대 결과**: 서비스 등록됨, PID 할당됨

---

### Phase 17-C: 클라이언트 모드 — 온라인 동작 테스트 (CACHE_ENABLED=true)

#### T-C04: 클라이언트 모드 서비스 시작 확인
- **사전 조건**: `.env`에 `CACHE_ENABLED=true`, SSH 터널 연결됨
- **검증 방법**: MCP 서버 시작 로그 확인
- **기대 결과**:
  - `[CACHE] 초기화 완료 (현재: 온라인)` 로그 출력
  - `data/cache.db` 파일 생성됨

#### T-C05: 온라인 검색 + 캐시 저장
- **도구**: `memory_search`
- **입력**: `{ "query": "Next.js Server Actions", "limit": 3 }`
- **기대 결과**: Mac Mini Qdrant에서 결과 반환, `_fromCache` 필드 **없음**
- **검증 포인트**: `data/cache.db`의 `search_cache` 테이블에 결과 캐시됨

#### T-C06: 온라인 단건 조회 + 캐시 저장
- **도구**: `memory_get`
- **입력**: `{ "id": "<기존 메모리 ID>" }`
- **기대 결과**: Mac Mini Qdrant에서 상세 반환
- **검증 포인트**: `data/cache.db`의 `memory_cache` 테이블에 해당 ID 캐시됨

#### T-C07: 온라인 저장 (쓰기 정상)
- **도구**: `memory_save`
- **입력**: `{ "content": "원격 접속 모드 테스트 메모", "title": "Remote Test" }`
- **기대 결과**: `success: true`, Mac Mini Qdrant에 저장됨

#### T-C08: 온라인 secrets 접근 (로컬 SQLCipher)
- **도구**: `memory_search`
- **입력**: `{ "store": "secrets", "query": "API" }`
- **기대 결과**: 로컬 SQLCipher에서 검색 결과 반환

---

### Phase 17-D: 클라이언트 모드 — 오프라인 동작 테스트 (터널 끊김)

#### T-C09: 터널 중지 + 오프라인 감지
- **검증 방법**: `pkill -f "ssh.*mac-mini"` → 최대 60초 대기
- **기대 결과**: `[CONNECTION] 오프라인 전환` 로그 출력

#### T-C10: 오프라인 검색 — 캐시 히트
- **사전 조건**: T-C05에서 캐시된 검색 결과 존재
- **도구**: `memory_search`
- **입력**: `{ "query": "Next.js Server Actions", "limit": 3 }` (T-C05와 동일 쿼리)
- **기대 결과**: 캐시된 결과 반환, `_fromCache: true`

#### T-C11: 오프라인 단건 조회 — 캐시 히트
- **사전 조건**: T-C06에서 캐시된 메모리 존재
- **도구**: `memory_get`
- **입력**: `{ "id": "<T-C06과 동일 ID>" }`
- **기대 결과**: 캐시된 결과 반환, `_fromCache: true`

#### T-C12: 오프라인 검색 — 캐시 미스
- **도구**: `memory_search`
- **입력**: `{ "query": "캐시에 없는 새로운 쿼리", "limit": 3 }`
- **기대 결과**: 빈 결과 또는 캐시 목록에서 부분 결과 반환

#### T-C13: 오프라인 저장 차단 (general)
- **도구**: `memory_save`
- **입력**: `{ "content": "오프라인 저장 시도" }`
- **기대 결과**: 에러 — "오프라인 모드에서는 저장 작업을 수행할 수 없습니다"

#### T-C14: 오프라인 저장 차단 (images)
- **도구**: `memory_save`
- **입력**: `{ "store": "images", "filePath": "...", "mimeType": "image/png", "description": "test" }`
- **기대 결과**: 에러 — "오프라인 모드에서는 파일 저장 작업을 수행할 수 없습니다"

#### T-C15: 오프라인 secrets 접근 (정상 동작)
- **도구**: `memory_save`
- **입력**: `{ "store": "secrets", "name": "Offline Test Key", "value": "test", "secretType": "api-key" }`
- **기대 결과**: `success: true` — secrets는 로컬이므로 오프라인에서도 쓰기 가능

#### T-C16: 오프라인 삭제/수정 차단 (general)
- **도구**: `memory_update`, `memory_delete`
- **기대 결과**: 에러 — "오프라인 모드에서는 수정/삭제 작업을 수행할 수 없습니다"

---

### Phase 17-E: 클라이언트 모드 — 재연결 + 캐시 관리

#### T-C17: 터널 재연결 + 온라인 복귀
- **검증 방법**: `./scripts/ssh-tunnel.sh` → 최대 60초 대기
- **기대 결과**: `[CONNECTION] 온라인 복귀` 로그 출력

#### T-C18: 재연결 후 쓰기 정상 동작
- **도구**: `memory_save`
- **입력**: `{ "content": "재연결 후 저장 테스트" }`
- **기대 결과**: `success: true`

#### T-C19: 캐시 프루닝 동작
- **검증 방법**: CACHE_MAX_AGE_DAYS 초과 데이터에 대해 프루닝 트리거
- **기대 결과**: 오래된 캐시 항목 삭제됨

#### T-C20: 캐시 통계 확인
- **검증 방법**: 캐시 DB 통계 조회
- **기대 결과**: `{ memoryCount: N, searchCount: N, dbSizeBytes: N }` (N > 0)

---

### Phase 17-F: 정리

#### T-C21: 테스트 데이터 정리
- T-C07에서 저장한 메모리 삭제
- T-C15에서 저장한 secrets 삭제
- T-C18에서 저장한 메모리 삭제

#### T-C22: 최종 상태 확인
- **서버**: `memory_stats` → 테스트 전과 동일
- **클라이언트**: `data/cache.db` 존재, 캐시 통계 확인

---

### Phase 17 테스트 실행 체크리스트

| # | 테스트 | 환경 | 결과 | 비고 |
|---|--------|------|------|------|
| T-S01 | 서버 시작 (캐시 없음) | Mac Mini | ☐ | |
| T-S02 | 서버 기존 기능 정상 | Mac Mini | ☐ | Phase 1~6 재실행 |
| T-S03 | 서버 모니터 비활성 | Mac Mini | ☐ | |
| T-C01 | SSH 터널 연결 | 클라이언트 | ☐ | |
| T-C02 | autossh 재연결 | 클라이언트 | ☐ | |
| T-C03 | launchd 자동시작 | 클라이언트 | ☐ | |
| T-C04 | 클라이언트 시작 | 클라이언트 | ☐ | |
| T-C05 | 온라인 검색+캐시 | 클라이언트 | ☐ | |
| T-C06 | 온라인 조회+캐시 | 클라이언트 | ☐ | |
| T-C07 | 온라인 저장 | 클라이언트 | ☐ | |
| T-C08 | 온라인 secrets | 클라이언트 | ☐ | |
| T-C09 | 오프라인 감지 | 클라이언트 | ☐ | |
| T-C10 | 오프라인 검색(히트) | 클라이언트 | ☐ | |
| T-C11 | 오프라인 조회(히트) | 클라이언트 | ☐ | |
| T-C12 | 오프라인 검색(미스) | 클라이언트 | ☐ | |
| T-C13 | 오프라인 저장 차단 | 클라이언트 | ☐ | |
| T-C14 | 오프라인 이미지 차단 | 클라이언트 | ☐ | |
| T-C15 | 오프라인 secrets 정상 | 클라이언트 | ☐ | |
| T-C16 | 오프라인 수정/삭제 차단 | 클라이언트 | ☐ | |
| T-C17 | 재연결 온라인 복귀 | 클라이언트 | ☐ | |
| T-C18 | 재연결 후 쓰기 | 클라이언트 | ☐ | |
| T-C19 | 캐시 프루닝 | 클라이언트 | ☐ | |
| T-C20 | 캐시 통계 | 클라이언트 | ☐ | |
| T-C21 | 테스트 데이터 정리 | 양쪽 | ☐ | |
| T-C22 | 최종 상태 확인 | 양쪽 | ☐ | |
