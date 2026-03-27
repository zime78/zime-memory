---
name: zime-memory
description: |
  Qdrant + MinIO + SQLCipher 기반 Multi-Store 개인 메모리 시스템.
  텍스트(general), 이미지(images), 파일(files), 시크릿(secrets) 4개 store를 지원한다.
  Ollama 임베딩으로 벡터화하여 의미 기반 유사도 검색을 수행한다.
  '메모리', '기억', 'memory', '저장해줘', '찾아줘', '검색', '이미지 저장', '파일 저장', '암호키', '시크릿', '다운로드' 요청 시 사용합니다.
triggers:
  - "메모리"
  - "기억"
  - "memory"
  - "저장해줘"
  - "기억해줘"
  - "찾아줘"
  - "검색해줘"
  - "통계"
  - "백업"
  - "내보내기"
  - "복원"
  - "zime-memory"
  - "메모리 현황"
  - "목록"
  - "이미지 저장"
  - "스크린샷 저장"
  - "파일 저장"
  - "문서 보관"
  - "암호키"
  - "API 키"
  - "시크릿"
  - "비밀번호 저장"
  - "다운로드"
  - "파일 다운로드"
---

# zime-memory v2.0 — Multi-Store 사용 가이드

> 자연어 매핑, 카테고리, 우선순위, 기본 동작 규칙은 MCP instructions에서 자동 제공됨.
> 이 스킬은 **파라미터 상세**, **행동 규칙**, **보안 규칙**, **트러블슈팅**을 보충한다.

---

## Multi-Store 아키텍처

| Store | 백엔드 | 용도 | 기본값 |
|-------|--------|------|--------|
| **general** | Qdrant | 텍스트 메모, 지식, 코드 스니펫 | O (store 미지정 시) |
| **images** | MinIO + Qdrant | 이미지, 스크린샷, 다이어그램 | |
| **files** | MinIO + Qdrant | 문서, 설정 파일, 바이너리 | |
| **secrets** | SQLCipher (AES-256) | API 키, 토큰, 비밀번호 | |

---

## 도구별 파라미터 상세

### memory_save — 메모리 저장

```
필수: content (general) / filePath 또는 fileData + mimeType + description (images/files) / name + value + secretType (secrets)
선택: store(general|images|files|secrets), title, tags[], category, priority, source, status(published|draft), ttl, pinned, parentId, relatedIds[]
```

**store별 추가 파라미터:**

| 파라미터 | general | images | files | secrets |
|----------|:---:|:---:|:---:|:---:|
| content | 필수 | - | - | - |
| filePath / fileData | - | 필수 | 필수 | - |
| mimeType | - | 필수 | 필수 | - |
| description | - | 필수 | 필수 | - |
| originalName | - | 선택 | 선택 | - |
| resolution {width, height} | - | 선택 | - | - |
| name | - | - | - | 필수 |
| value | - | - | - | 필수 |
| secretType | - | - | - | 필수 (api-key/token/password/certificate/other) |
| service | - | - | - | 선택 |
| notes | - | - | - | 선택 |

- 유사도 0.9 이상 기존 메모리 존재 시 `duplicateWarning` 포함 (저장은 진행됨)
- images/files: MinIO 바이너리 + Qdrant 메타데이터 이중 쓰기
- secrets: SQLCipher 암호화 저장, Qdrant에 저장되지 않음

### memory_search — 의미 기반 검색

```
필수: query
선택: store(general|images|files|secrets|all), limit(1-20, 기본 5), category, tags[], priority, scoreThreshold(0-1, 기본 0.3), status, includeDrafts, fromDate, toDate
```

- `store: "all"` → 4개 store 크로스 검색 (벡터 + 키워드 병합, score 내림차순)
- general/images/files: 벡터 유사도 (`matchType: "vector"`)
- secrets: 키워드 매칭 (`matchType: "keyword"`, `score: null`)
- **secrets 검색 시 value 필드 미포함** (name/service/tags/notes만 반환)

### memory_list — 목록 조회 (벡터 검색 아님)

```
선택: store(general|images|files|secrets), category, tags[], priority, limit(1-100, 기본 20), offset, includeDrafts
```

- 페이지네이션: `offset`으로 이전 결과 이후부터 조회
- **secrets 목록 시 value 필드 미포함**

### memory_get — 단건 상세 조회

```
필수: id (UUID)
선택: store(general|images|files|secrets)
```

- images/files: `presignedUrl` 포함
- secrets: **value 필드 포함** (명시적 ID 조회 시만)
- 관련 메모리(유사도 0.5 이상) 최대 3건 추천

### memory_update — 메모리 수정

```
필수: id (UUID) + 최소 1개 변경 필드
선택: store, content, title, tags[], category, priority, source, status, ttl, pinned, parentId, relatedIds[]
```

- `content` 또는 `title` 변경 시 임베딩 재생성
- `createdAt`은 유지, `updatedAt`만 갱신
- `status`를 `published`로 변경 시 `expiresAt` 자동 제거

### memory_delete — 단건 삭제

```
필수: id (UUID)
선택: store(general|images|files|secrets)
```

- images/files: MinIO 오브젝트 + Qdrant 포인트 동시 삭제

### memory_count — 건수 조회

```
선택: store(general|images|files|secrets|all), category, tags[], priority
```

- `store: "all"` → store별 분류 카운트 반환

### memory_stats — 전체 통계

```
파라미터 없음 (항상 4 store 통합)
```

- general: `pointsCount`, `status`
- images: `objectCount`, `totalSize`
- files: `objectCount`, `totalSize`
- secrets: `total`, `breakdown` (secretType별)

### memory_download — 파일 다운로드

```
필수: id (UUID)
선택: store(images|files), urlOnly (boolean)
```

- `urlOnly: true` → presigned URL만 반환 (1시간 유효)
- `urlOnly: false` → base64 인코딩 반환
- images/files store 전용

### memory_export — 내보내기

```
선택: store(general|images|files|secrets), category, priority, tags[]
```

- JSON 배열 형태로 전체 또는 필터링된 메모리 반환
- secrets export 시 value 제외 옵션 있음

### memory_import — 가져오기

```
필수: memories (배열)
선택: store(general|images|files), skipDuplicates (기본 true)
```

- `id` 지정 시 원본 ID 보존
- **secrets import 미지원** (보안)

### memory_bulk_delete — 일괄 삭제

```
최소 1개 필터 필수: category, tags, priority, olderThan
선택: store(general|images|files)
```

- 전체 삭제 방지를 위해 필터 없이 호출 불가
- **secrets bulk_delete 미지원** (안전)

### memory_link — 메모리 관계 설정

```
필수: sourceId, targetId
선택: type, bidirectional
```

- general store 전용 (Qdrant)
- parentId: 계층 구조, relatedIds: 네트워크 구조

### memory_summarize — 카테고리 요약

```
필수: category 또는 tags
선택: limit
```

- general store 전용 (텍스트)
- LLM_MODEL 환경변수 설정 필요 (선택사항)

### memory_backup — 통합 백업

```
선택: unified (boolean), listOnly (boolean)
```

- `unified: true` → Qdrant + MinIO + SQLCipher 3개 store 통합 백업
- `listOnly: true` → 기존 스냅샷 목록만 조회
- NAS_BACKUP_PATH 설정 시 NAS 복사 포함
- 자동 프루닝: 오래된 백업은 자동 삭제 (Qdrant/NAS/로컬 각각 최대 20개 유지)
- MAX_QDRANT_SNAPSHOTS(기본 20), MAX_NAS_BACKUPS(기본 20) 환경변수로 보관 수 조정 가능

### memory_migrate — 마이그레이션

```
필수: mode (analyze | tag-store)
선택: confirm
```

- `analyze`: 기존 데이터의 store 태그 현황 분석
- `tag-store`: store 태그 없는 데이터에 general 태그 부여

### memory_reindex — 재인덱싱

```
필수: confirm ("CONFIRM")
```

- general store 전용 (Qdrant)
- 임베딩 모델 변경 시 전체 벡터 재생성

### memory_obsidian_sync — Obsidian 동기화

```
필수: direction (import | export | bidirectional)
선택: vaultPath, folder
```

- general store 전용 (텍스트)
- YAML frontmatter로 메타데이터 매핑

---

## store별 도구 지원 범위

```
                  general  images  files  secrets  all
save/get/update     O        O       O      O      -
delete              O        O       O      O      -
search              O        O       O      O      O
list/count          O        O       O      O      O
export              O        O       O      O      -
import              O        O       O      X      -
bulk_delete         O        O       O      X      -
download            -        O       O      -      -
link/summarize      O        -       -      -      -
reindex             O        -       -      -      -
obsidian_sync       O        -       -      -      -
```

---

## 보안 규칙 (secrets store)

1. **search/list 응답에 value 미포함** — name, secretType, service, tags, notes만 반환
2. **get 응답에 value 포함** — 명시적 ID 조회 시만 전체 필드 반환 (의도적)
3. **SQLCipher 전체 DB 암호화** — ZIME_ENCRYPTION_KEY (hex 64자) 필수
4. **import/bulk_delete 미지원** — 시크릿은 개별 저장/삭제만 허용
5. **파일 크기 50MB 제한** — images/files store maxFileSize 초과 시 에러
6. **MinIO Object Lock** — GOVERNANCE 모드 30일, 보존 기간 내 삭제 방지

---

## 주요 규칙

1. **저장 시**: 사용자가 카테고리/우선순위를 명시하지 않으면 내용을 보고 적절히 추론하여 지정
2. **저장 시**: 사용자가 태그를 명시하지 않으면 내용을 분석하여 적절한 태그를 생성하여 제공
3. **저장 시**: store를 명시하지 않으면 내용에 따라 적절한 store 판단 (키/토큰 → secrets, 이미지 → images, 파일 → files, 텍스트 → general)
4. **검색 시**: 결과가 없으면 `scoreThreshold`를 낮춰서 재시도 제안
5. **삭제 시**: 삭제 전 해당 메모리 내용을 먼저 보여주고 확인 요청
6. **목록 시**: 20건 이상이면 카테고리별 건수를 먼저 보여주고 필터링 제안
7. **결과 표시**: 검색/목록 결과는 테이블 형태로 보기 좋게 정리

---

## 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| MCP 도구 호출 실패 | Qdrant 미실행 | `docker ps`로 Qdrant 컨테이너 확인 |
| 임베딩 실패 | Ollama 미실행 | `ollama serve` 또는 Ollama 앱 실행 확인 |
| 검색 결과 없음 | 임계값 너무 높음 | `scoreThreshold`를 0.2로 낮춰 재시도 |
| 느린 검색 | 세그먼트 과다 | Qdrant 컬렉션 최적화 필요 |
| 이미지/파일 저장 실패 | MinIO 미실행 | `curl http://localhost:9000/minio/health/live` 확인 |
| 이미지/파일 저장 실패 | MinIO 크레덴셜 미설정 | MINIO_ACCESS_KEY, MINIO_SECRET_KEY 환경변수 확인 |
| 시크릿 저장 실패 | SQLCipher 암호키 미설정 | ZIME_ENCRYPTION_KEY (hex 64자) 환경변수 확인 |
| 파일 크기 초과 에러 | 50MB 제한 | 대용량 파일은 NAS 직접 저장 권장 |
| presignedUrl 만료 | 1시간 유효기간 | memory_download로 새 URL 재발급 |
