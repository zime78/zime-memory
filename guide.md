# zime-memory v2.1.0 사용 가이드

> **v2.1.0 — 아키텍처 리팩토링 (Tool Registry, Store 분리, Zod 설정 검증)**

## 프로젝트 구조

```
src/
├── index.ts                  # MCP 서버 진입점 (도구 등록 → registry 위임)
├── instructions.ts           # 서버 instructions 문자열 (index.ts에서 분리)
├── config.ts                 # 환경변수 로딩 + Zod 스키마 검증 (fail-fast)
├── tools/
│   └── registry.ts           # 19개 도구 배열 등록 (switch-case 대체)
├── utils/
│   └── response.ts           # jsonResponse / errorResponse 공통 유틸
├── stores/
│   ├── storeRouter.ts        # store 파라미터 라우팅
│   ├── generalOps.ts         # general store 연산 (텍스트/벡터)
│   ├── fileOps.ts            # images/files store 연산 (MinIO+Qdrant)
│   └── secretOps.ts          # secrets store 연산 (SQLCipher)
├── services/
│   ├── qdrantService.ts      # Qdrant 클라이언트 팩토리 (getDb → factory)
│   ├── minioService.ts       # MinIO 클라이언트 팩토리 (getMinioClient → factory)
│   ├── sqlcipherService.ts   # SQLCipher DB 팩토리
│   └── safetyService.ts      # validateWatermark() 통합 (generic)
└── types/
    └── index.ts              # SecretRow.deletedAt 추가, as any 감소
```

---

## Multi-Store 아키텍처

```
general (Qdrant)     ── 텍스트 메모, 지식, 코드 스니펫
images  (MinIO+Qdrant) ── 이미지, 스크린샷, 다이어그램
files   (MinIO+Qdrant) ── 문서, 설정 파일, 바이너리
secrets (SQLCipher)   ── API 키, 토큰, 비밀번호 (AES-256 암호화)
```

store를 지정하지 않으면 `general`로 자동 라우팅된다.

---

## General Store (텍스트)

### 저장 (memory_save)
- "Docker Compose에서 네트워크 설정하는 방법 저장해줘"
- "이 에러 해결법 중요사항으로 저장해줘"
- 파라미터: content(필수), title, category, priority, tags[], source, status, ttl, pinned

### 검색 (memory_search)
- "도커 네트워크 관련 메모 찾아줘"
- 정확한 키워드 불필요, 의미 유사도 기반 검색
- "Docker 설정" 검색 → "docker compose 네트워크 구성" 결과 반환
- `EMBEDDING_PROVIDER=off` 시 키워드/필터 기반 검색만 가능 (의미 유사도 비활성)

### 목록 (memory_list)
- "저장된 스니펫 목록 보여줘"
- 카테고리/태그/우선순위 필터링 지원

### 삭제 (memory_delete)
- "ID가 xxx인 항목 삭제해줘"

---

## Images Store (이미지)

### 이미지 저장
- "이 스크린샷 저장해줘" → memory_save(store: "images", filePath, mimeType, description)
- 필수: filePath 또는 fileData, mimeType, description
- 선택: originalName, resolution, tags[]
- MinIO 바이너리 + Qdrant 메타데이터 이중 쓰기

### 이미지 검색
- "아키텍처 다이어그램 찾아줘" → memory_search(store: "images", query)
- 결과에 presignedUrl 포함 (1시간 유효)

### 이미지 다운로드
- "이미지 다운로드해줘" → memory_download(id, store: "images", urlOnly: true)
- urlOnly: true → presigned URL만 반환
- urlOnly: false → base64 인코딩 반환

---

## Files Store (파일)

### 파일 저장
- "이 설정 파일 보관해줘" → memory_save(store: "files", filePath, mimeType, description)
- 필수: filePath 또는 fileData, mimeType, description
- 선택: originalName, tags[]
- 파일 크기 제한: 50MB

### 파일 검색
- "tsconfig 설정 파일 찾아줘" → memory_search(store: "files", query)
- 결과에 presignedUrl 포함

### 파일 목록
- "저장된 파일 목록" → memory_list(store: "files")

---

## Secrets Store (시크릿)

### 시크릿 저장
- "API 키 저장해줘" → memory_save(store: "secrets", name, value, secretType)
- 필수: name, value, secretType(api-key/token/password/certificate/other)
- 선택: service, tags[], notes
- SQLCipher AES-256 암호화 저장

### 시크릿 검색
- "slack 키 찾아줘" → memory_search(store: "secrets", query: "slack")
- **보안**: 검색/목록에서 value 필드 미포함 (name/service/tags/notes만)

### 시크릿 상세 조회
- "키 값 보여줘" → memory_get(store: "secrets", id)
- **명시적 ID 조회 시만 value 포함**

### 시크릿 보안 규칙
- search/list → value 미포함
- get → value 포함 (의도적)
- import/bulk_delete → 미지원 (안전)

---

## 크로스 스토어 검색

- "전체 검색" → memory_search(store: "all", query)
- 4개 store 병합 결과: 벡터(general/images/files) + 키워드(secrets)
- score 기준 내림차순 정렬
- secrets 결과는 matchType: "keyword", score: null

---

## 통계 (memory_stats)
- "메모리 저장소 통계 보여줘"
- 4개 store 통합 통계: general(포인트), images(오브젝트/크기), files(오브젝트/크기), secrets(건수/유형별)

---

## 메모리 고정 (pinned)
- "이 메모리 고정해줘" → memory_update(id, pinned: true)
- 고정된 메모리는 검색/목록에서 항상 상단에 표시

## 태깅
- 태그는 Claude가 내용을 분석하여 memory_save 호출 시 tags 파라미터로 직접 제공한다
- "이거 저장하고 태그도 달아줘" → Claude가 적절한 태그를 생성하여 memory_save(content, tags: [...]) 호출

## 임시 저장 (Draft & TTL)
- status: "draft" → 임시 저장 (기본 검색에서 제외)
- ttl: "3d", "12h" → 자동 만료 기간 설정
- published로 변경 시 expiresAt 자동 제거

## 메모리 연결 (memory_link)
- "이 두 메모리 연결해줘" → memory_link(sourceId, targetId)
- parentId로 계층 구조, relatedIds로 네트워크 구조 표현
- memory_get 시 연결된 메모리의 제목이 함께 표시
- general store 전용

## 카테고리 요약 (memory_summarize)
- "knowledge 카테고리 메모리 요약해줘" → memory_summarize(category: "knowledge")
- LLM이 메모리들을 종합하여 핵심 주제와 인사이트를 정리
- LLM_MODEL 환경변수 설정 필요 (선택사항)
- general store 전용

---

## 백업 (memory_backup)
- "메모리 백업해줘" → memory_backup()
- "통합 백업" → memory_backup(unified: true) → Qdrant + MinIO + SQLCipher 3개 store
- "스냅샷 목록 보여줘" → memory_backup(listOnly: true)
- NAS_BACKUP_PATH 설정 시 NAS 복사 포함
- 자동 프루닝: 오래된 백업은 자동 삭제 (Qdrant/NAS/로컬 각각 최대 20개 유지)
- MAX_QDRANT_SNAPSHOTS, MAX_NAS_BACKUPS 환경변수로 보관 수 조정 가능

## Obsidian 동기화 (memory_obsidian_sync)
- "Obsidian으로 내보내줘" → memory_obsidian_sync(direction: "export")
- "Obsidian에서 가져와줘" → memory_obsidian_sync(direction: "import")
- "양방향 동기화" → memory_obsidian_sync(direction: "bidirectional")
- YAML frontmatter로 zime-id, category, priority, tags 매핑
- general store 전용

## 재인덱싱 (memory_reindex)
- 임베딩 모델 또는 프로바이더 변경 후 "메모리 재인덱싱해줘" → memory_reindex(confirm: "CONFIRM")
- 전체 메모리의 벡터를 새 프로바이더/모델로 재생성
- 프로바이더 전환 시 차원 불일치를 자동 감지하고 컬렉션을 재생성 (페이로드 보존)
- off 모드에서는 재인덱싱 불가 (임베딩 비활성 상태)
- general store 전용

## 마이그레이션 (memory_migrate)
- "마이그레이션 분석" → memory_migrate(mode: "analyze") → store 태그 현황 분석
- "store 태그 부여" → memory_migrate(mode: "tag-store") → 기존 데이터에 general 태그

---

## 임베딩 프로바이더 설정

`EMBEDDING_PROVIDER` 환경변수로 임베딩 방식을 선택한다:

| 모드 | 설명 | Ollama 필요 | 환경변수 |
|------|------|:-----------:|----------|
| `ollama` (기본값) | Ollama REST API로 임베딩 생성 | O | `OLLAMA_URL`, `EMBEDDING_MODEL` |
| `local` | @huggingface/transformers로 코드 기반 로컬 임베딩 | X | `LOCAL_EMBEDDING_MODEL` |
| `off` | 임베딩 비활성, 키워드/필터 검색만 | X | - |

### 모드 전환 방법
1. `.env` 파일에서 `EMBEDDING_PROVIDER` 변경
2. MCP 서버 재시작
3. **프로바이더 전환 시 `memory_reindex(confirm: "CONFIRM")` 필수** — 벡터 차원이 다르면 자동 컬렉션 재생성

### local 모드 특징
- 첫 호출 시 모델을 자동 다운로드 (~90MB, `~/.cache/huggingface/` 캐시)
- Ollama 서비스 없이 독립 동작
- 기본 모델: `Xenova/all-MiniLM-L6-v2` (384차원)

### off 모드 제한
- 의미 기반 유사도 검색 불가
- `memory_save` 시 중복 감지(유사도 비교) 비활성
- `memory_search` 결과에 제한 안내 메시지 포함

---

## 카테고리

| 카테고리 | 용도 | 예시 |
|----------|------|------|
| note | 일반 메모 | 회의 내용, 아이디어 |
| knowledge | 학습/지식 | 기술 정보, 개념 정리 |
| reference | 참조 정보 | URL, 문서 위치, 설정값 |
| snippet | 코드 조각 | 자주 쓰는 명령어, 코드 패턴 |
| decision | 의사결정 | 기술 선택 이유, 아키텍처 결정 |
| custom | 기타 | 분류 불가 항목 |

---

## 실전 활용

- 에러 해결 기록: store=general, category=knowledge, priority=high
- 프로젝트 결정: store=general, category=decision, tags=[auth, architecture]
- 자주 쓰는 명령어: store=general, category=snippet, tags=[k8s, docker]
- 참조 문서: store=general, category=reference, source="공식 문서 URL"
- 중요 메모리: pinned=true로 고정하여 검색 시 항상 상단 표시
- 관련 지식 연결: memory_link로 메모리 간 관계 구축
- 스크린샷 보관: store=images, description="UI 디자인 v2"
- 설정 파일 백업: store=files, originalName="tsconfig.json"
- API 키 관리: store=secrets, secretType="api-key", service="github"
- 비밀번호 보관: store=secrets, secretType="password", service="aws"

---

## 환경변수

| 구분 | 변수 | 기본값 | 설명 |
|------|------|--------|------|
| Qdrant | QDRANT_URL | http://localhost:6333 | 벡터 DB |
| | COLLECTION_NAME | memories | 컬렉션명 |
| 임베딩 | EMBEDDING_PROVIDER | ollama | 프로바이더: ollama, local, off |
| | LOCAL_EMBEDDING_MODEL | Xenova/all-MiniLM-L6-v2 | local 모드 모델 (384차원) |
| Ollama | OLLAMA_URL | http://localhost:11434 | 임베딩 서비스 (ollama 모드) |
| | EMBEDDING_MODEL | bge-m3 | Ollama 임베딩 모델 |
| | LLM_MODEL | (미설정) | 요약용 LLM |
| MinIO | MINIO_ENDPOINT | localhost | 오브젝트 스토리지 |
| | MINIO_PORT | 9000 | 포트 |
| | MINIO_ACCESS_KEY | (필수) | 접근 키 |
| | MINIO_SECRET_KEY | (필수) | 시크릿 키 |
| | MINIO_IMAGES_BUCKET | zime-memory-images | 이미지 버킷 |
| | MINIO_FILES_BUCKET | zime-memory-files | 파일 버킷 |
| | MINIO_RETENTION_DAYS | 30 | Object Lock 보존 기간 |
| | MINIO_PRESIGNED_EXPIRY | 3600 | presigned URL 유효(초) |
| | MINIO_MAX_FILE_SIZE | 52428800 | 최대 파일 크기 (50MB) |
| SQLCipher | SQLCIPHER_DB_PATH | data/secrets.db | DB 파일 경로 |
| | ZIME_ENCRYPTION_KEY | (필수, hex 64자) | 암호화 키 |
| 백업 | NAS_BACKUP_PATH | (미설정) | NAS 마운트 경로 |
| | BACKUP_INTERVAL_HOURS | 6 | 자동 백업 주기 (시간) |
| | MAX_QDRANT_SNAPSHOTS | 20 | Qdrant 스냅샷 최대 보관 수 |
| | MAX_NAS_BACKUPS | 20 | NAS 디렉토리별 백업 최대 보관 수 |
| | DISABLE_LOCAL_BACKUP | (미설정) | true 시 로컬 안전 백업 비활성 |
| | SOFT_DELETE_RETENTION_DAYS | 30 | soft delete 보존 기간 (일) |
| Obsidian | OBSIDIAN_VAULT_PATH | (미설정) | Vault 루트 경로 |
| 로깅 | LOG_LEVEL | info | 로그 레벨 (debug/info/warn/error) |

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

## 원격 접속 모드 (SSH 터널)

### 개요

zime-memory를 멀티 머신 환경에서 운영할 수 있다. Mac Mini를 Docker 서버로, 다른 컴퓨터를 클라이언트로 사용한다.

- **서버 (Mac Mini)**: Docker(Qdrant + MinIO) + Ollama 실행, `CACHE_ENABLED=false`
- **클라이언트**: SSH 터널로 서버 접속, 로컬 캐시로 오프라인 폴백, `CACHE_ENABLED=true`

### 서버/클라이언트 .env 차이

| 변수 | 서버 (Mac Mini) | 클라이언트 |
|------|----------------|-----------|
| `CACHE_ENABLED` | `false` | `true` (기본값) |
| `QDRANT_URL` | `http://localhost:6333` | `http://localhost:6333` (터널) |
| `MINIO_ENDPOINT` | `localhost` | `localhost` (터널) |
| `OLLAMA_URL` | `http://localhost:11434` | `http://localhost:11434` (터널) |

> 양쪽 모두 localhost를 사용한다. 클라이언트는 SSH 터널이 localhost 포트를 Mac Mini로 포워딩한다.

### SSH 터널 설정

```bash
# 1. autossh 설치 (macOS)
brew install autossh

# 2. SSH 키 인증 설정
ssh-copy-id your-server

# 3. 터널 시작/중지/상태
./scripts/ssh-tunnel.sh          # 시작
./scripts/ssh-tunnel.sh stop     # 중지
./scripts/ssh-tunnel.sh status   # 상태 확인

# 4. launchd 자동시작 (로그인 시 자동 터널)
ln -sf ~/mcp/zime-memory/scripts/com.zime.memory-tunnel.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.zime.memory-tunnel.plist
```

### 온라인/오프라인 동작

**온라인** (SSH 터널 연결됨):
- 모든 MCP 도구 정상 동작
- 검색/조회 결과가 자동으로 로컬 캐시(`data/cache.db`)에 저장됨
- 30초 간격으로 연결 상태 모니터링

**오프라인** (SSH 터널 끊김):
- 읽기: 캐시에서 이전 검색/조회 결과 반환 (`_fromCache: true` 표시)
- 쓰기: 차단됨 — "오프라인 모드에서는 쓰기 작업을 수행할 수 없습니다" 에러
- **예외**: secrets store는 로컬 SQLCipher이므로 오프라인에서도 읽기/쓰기 가능
- 터널 재연결 시 30초 내 자동 온라인 복귀

### 캐시 설정

| 환경변수 | 기본값 | 설명 |
|----------|--------|------|
| `CACHE_ENABLED` | `true` | 캐시 활성화 (서버에서 `false`) |
| `CACHE_DB_PATH` | `data/cache.db` | 캐시 DB 경로 |
| `CACHE_MAX_AGE_DAYS` | `7` | 캐시 보관 기간 (일) |
| `CACHE_MAX_ENTRIES` | `2000` | 최대 캐시 항목 수 |
| `CACHE_PRUNE_INTERVAL_HOURS` | `12` | 프루닝 주기 (시간) |

### 일반 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| Docker 컨테이너 시작 실패 | Docker 미실행 | `docker info` 확인, Docker Desktop 시작 |
| Qdrant 연결 실패 | 컨테이너 미시작 | `docker compose up -d` |
| MinIO 연결 실패 | 키 미설정 | `.env`의 `MINIO_ACCESS_KEY/SECRET_KEY` 확인 |
| SQLCipher 오류 | 키 형식 오류 | `openssl rand -hex 32`로 64자 hex 키 생성 |
| 임베딩 실패 (ollama) | Ollama 미실행/모델 없음 | `ollama serve` + `ollama pull bge-m3` |
| 임베딩 실패 (local) | 첫 실행 시 모델 다운로드 | 수 분 대기 (자동 다운로드) |
| MCP 서버 미등록 | settings.json 누락 | `./install.sh` 재실행 또는 수동 등록 |

### 원격 접속 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| "오프라인 모드" 에러 | SSH 터널 끊김 | `./scripts/ssh-tunnel.sh status`로 확인 후 재시작 |
| 검색 결과 오래됨 | 캐시 데이터 | 온라인 복귀 후 동일 검색 → 최신 결과로 캐시 갱신 |
| 서버 접속 불가 | SSH 설정 문제 | `ssh your-server` 직접 테스트 |
| autossh 미설치 | 패키지 미설치 | `brew install autossh` |
| launchd 미동작 | plist 미등록 | `launchctl load ~/Library/LaunchAgents/com.zime.memory-tunnel.plist` |

---

## 멀티 머신 운영

### 데이터 마이그레이션

기존 양쪽 Docker에 분산된 데이터를 Mac Mini로 통합한다:

```bash
# 1. 현재 컴퓨터에서 데이터 내보내기
# Claude Code에서: "전체 메모리 내보내줘"
# → memory_export 실행 → JSON 파일 생성

# 2. Mac Mini에서 데이터 가져오기
# Claude Code에서: "메모리 가져오기" + JSON 파일 경로
# → memory_import 실행 (중복 건너뛰기)

# 3. 현재 컴퓨터의 Docker 중지 (리소스 절약)
cd ~/mcp/zime-memory && docker compose down

# 4. SSH 터널 시작
./scripts/ssh-tunnel.sh

# 5. 검증
# Claude Code에서: "메모리 통계 보여줘"
```

### SQLCipher (secrets) 운영

secrets store는 로컬 SQLCipher DB(`data/secrets.db`)를 사용하므로 머신별 독립 관리된다:

- Mac Mini와 클라이언트는 각각 별도의 secrets를 가짐
- 필요 시 수동 복사: `scp your-server:~/mcp/zime-memory/data/secrets.db ./data/secrets.db`
- 복사 시 `ZIME_ENCRYPTION_KEY`가 동일해야 함
