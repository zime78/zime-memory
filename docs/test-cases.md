# zime-memory Multi-Store 통합 테스트 케이스

> 최종 업데이트: 2026-03-26
> 대상 버전: v2.1.0 (Qdrant + MinIO + SQLCipher, 아키텍처 리팩토링)
> Phase 8-14: memory_update 버그 수정 검증 + 누락 도구 전수 검증
> Phase 15: 환경변수 Zod 검증 + LOG_LEVEL 테스트 (v2.1.0)

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
