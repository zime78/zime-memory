# zime-memory

> Qdrant + MinIO + SQLCipher 기반 Multi-Store 개인 메모리 MCP 서버

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-Compatible-purple)](https://modelcontextprotocol.io/)

Claude Code에서 자연어로 메모리를 저장하고, 의미 기반 유사도 검색으로 다시 찾을 수 있는 개인 메모리 시스템입니다.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Claude Code (MCP Client)               │
│                                                             │
│   "Docker 네트워크 설정 방법 저장해줘"                         │
│   "API 키 저장해줘"  /  "스크린샷 보관해줘"                    │
└───────────────────────────┬─────────────────────────────────┘
                            │ MCP Protocol (stdio)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                  zime-memory MCP Server                     │
│                                                             │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │  19 MCP │  │  Store   │  │ Embedding│  │   Safety   │  │
│  │  Tools  │──│  Router  │  │ Service  │  │  Service   │  │
│  └────┬────┘  └────┬─────┘  └────┬─────┘  └────────────┘  │
│       │            │             │                          │
│       ▼            ▼             ▼                          │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Store Operations Layer                 │   │
│  │                                                     │   │
│  │  ┌───────────┐  ┌──────────┐  ┌──────────────┐    │   │
│  │  │ generalOps│  │ fileOps  │  │  secretOps   │    │   │
│  │  │ (텍스트)  │  │(이미지/  │  │ (API 키/     │    │   │
│  │  │           │  │  파일)   │  │  비밀번호)   │    │   │
│  │  └─────┬─────┘  └────┬─────┘  └──────┬───────┘    │   │
│  └────────┼──────────────┼───────────────┼────────────┘   │
└───────────┼──────────────┼───────────────┼────────────────┘
            │              │               │
            ▼              ▼               ▼
┌───────────────┐  ┌──────────────┐  ┌──────────────┐
│    Qdrant     │  │    MinIO     │  │  SQLCipher   │
│  Vector DB    │  │ Object Store │  │ Encrypted DB │
│               │  │              │  │              │
│ - 벡터 임베딩 │  │ - 바이너리   │  │ - AES-256    │
│ - 메타데이터  │  │ - Object Lock│  │ - 암호화 저장│
│ - 유사도 검색 │  │ - Presigned  │  │ - 개별 CRUD  │
│               │  │   URL        │  │              │
└───────────────┘  └──────────────┘  └──────────────┘
     (Docker)          (Docker)        (로컬 파일)

┌─────────────────────────────────────────────────┐
│           Embedding Provider (선택)              │
│                                                  │
│  ┌───────────┐ ┌────────────┐ ┌──────────────┐  │
│  │  Ollama   │ │   Local    │ │     Off      │  │
│  │ (bge-m3)  │ │(transformers│ │ (키워드만)   │  │
│  │ 1024차원  │ │  .js 384d) │ │ 임베딩 없음  │  │
│  │  기본값   │ │ Ollama불필요│ │              │  │
│  └───────────┘ └────────────┘ └──────────────┘  │
│         EMBEDDING_PROVIDER 환경변수로 선택        │
└─────────────────────────────────────────────────┘
```

---

## Features

### 4개 Store

| Store | Backend | 용도 | 보안 |
|-------|---------|------|------|
| **general** | Qdrant | 텍스트 메모, 지식, 코드 스니펫 | 벡터 유사도 검색 |
| **images** | MinIO + Qdrant | 이미지, 스크린샷, 다이어그램 | Object Lock (30일) |
| **files** | MinIO + Qdrant | 문서, 설정 파일, 바이너리 | Object Lock (30일) |
| **secrets** | SQLCipher | API 키, 토큰, 비밀번호 | AES-256 전체 DB 암호화 |

### 19개 MCP 도구

| 도구 | 설명 |
|------|------|
| `memory_save` | 메모리 저장 (자동 임베딩, 중복 감지) |
| `memory_search` | 의미 기반 유사도 검색 (크로스 스토어 지원) |
| `memory_get` | 단건 상세 조회 (관련 메모리 추천) |
| `memory_list` | 필터 기반 목록 조회 (페이지네이션) |
| `memory_update` | 메모리 수정 (임베딩 자동 재생성) |
| `memory_delete` | 단건 삭제 |
| `memory_count` | 건수 조회 (그룹별 분류) |
| `memory_stats` | 4개 스토어 통합 통계 |
| `memory_export` | JSON 내보내기 |
| `memory_import` | JSON 가져오기 (중복 건너뛰기) |
| `memory_bulk_delete` | 필터 기반 일괄 삭제 |
| `memory_link` | 메모리 간 관계 설정 |
| `memory_summarize` | LLM 기반 카테고리 요약 |
| `memory_backup` | Qdrant + MinIO + SQLCipher 통합 백업 |
| `memory_restore` | soft-delete 복원, DB 복원 |
| `memory_download` | 이미지/파일 다운로드 (Presigned URL) |
| `memory_reindex` | 임베딩 모델 변경 시 벡터 재생성 |
| `memory_migrate` | 기존 데이터 store 태그 마이그레이션 |
| `memory_obsidian_sync` | Obsidian vault 양방향 동기화 |

### 주요 특징

- **3-Mode 임베딩** — Ollama(기본), 로컬(transformers.js), Off(키워드만) 선택 가능
- **의미 기반 검색** — 정확한 키워드 불필요, "Docker 설정" 검색 시 "docker compose 네트워크 구성" 결과 반환
- **크로스 스토어 검색** — `store: "all"`로 4개 스토어 통합 검색
- **Obsidian 연동** — YAML frontmatter 기반 양방향 동기화
- **자동 백업** — NAS 복사, 스냅샷 프루닝 (최대 20개)
- **Draft & TTL** — 임시 저장, 자동 만료
- **메모리 연결** — 계층 구조 (parentId) + 네트워크 구조 (relatedIds)

---

## Prerequisites

| 도구 | 버전 | 용도 |
|------|------|------|
| [Node.js](https://nodejs.org/) | >= 18 | 런타임 |
| [Docker](https://www.docker.com/) | latest | Qdrant, MinIO 컨테이너 |
| [Ollama](https://ollama.com/) | latest | 임베딩 모델 (기본: bge-m3, `EMBEDDING_PROVIDER=local` 시 불필요) |
| [Claude Code](https://claude.com/claude-code) | latest | MCP 클라이언트 |

---

## Installation

### GitHub Clone (권장)

```bash
git clone https://github.com/zime78/zime-memory.git
cd zime-memory
./install.sh
```

### Archive Install

```bash
tar xzf zime-memory-installer.tar.gz
cd zime-memory
./install.sh
```

### install.sh 자동 실행 내용

| Phase | 내용 | 미설치 시 |
|-------|------|----------|
| 1. 필수 도구 확인 | Docker, Node.js, Ollama, jq | Y/n 확인 후 자동 설치 (macOS brew / Linux) |
| 2. 소스 배치 + .env | 설치 위치 복사, 환경변수 생성 | MinIO/SQLCipher 키 자동 생성 |
| 3. Docker 시작 | Qdrant + MinIO 컨테이너 | macOS: Docker Desktop 자동 실행 |
| 4. 빌드 | `npm install` + TypeScript 빌드 | - |
| 5. Ollama 모델 | bge-m3 (1024차원) 다운로드 | macOS: Ollama 서비스 자동 시작 |
| 6. Claude 설정 | `settings.json` MCP 서버 등록 | - |
| 7. Skill 설치 | `~/.claude/skills/` 에 SKILL.md 복사 | - |
| 8. 헬스체크 | 6개 항목 검증 | - |

### Upgrade (기존 사용자)

```bash
cd ~/mcp/zime-memory
git pull
./install.sh
```

업그레이드 시 자동 처리:
- `.env` 및 `data/` **보존** (기존 키/데이터 유지)
- 소스 업데이트 → `dist/` 정리 → 리빌드
- SKILL.md 변경분만 업데이트
- 버전 비교 표시 (현재 → 새 버전)

### Manual Install

```bash
# 1. Clone
git clone https://github.com/zime78/zime-memory.git
cd zime-memory

# 2. 환경변수 설정
cp .env.example .env
# .env 파일을 열어 실제 값 입력
# SQLCipher 키 생성: openssl rand -hex 32

# 3. Docker 서비스 시작
docker compose up -d

# 4. 빌드
npm install
npm run build

# 5. Ollama 임베딩 모델 설치
ollama pull bge-m3

# 6. Claude Code에 MCP 서버 등록
claude mcp add zime-memory node ~/mcp/zime-memory/dist/index.js
```

---

## Configuration

`.env.example`을 `.env`로 복사하고 값을 설정합니다:

```bash
cp .env.example .env
```

| 변수 | 필수 | 기본값 | 설명 |
|------|:---:|--------|------|
| `EMBEDDING_PROVIDER` | | `ollama` | 임베딩 프로바이더: `ollama`, `local`, `off` |
| `QDRANT_URL` | | `http://localhost:6333` | Qdrant 연결 URL |
| `OLLAMA_URL` | | `http://localhost:11434` | Ollama 서비스 URL (ollama 모드) |
| `EMBEDDING_MODEL` | | `bge-m3` | Ollama 임베딩 모델 (ollama 모드) |
| `LOCAL_EMBEDDING_MODEL` | | `Xenova/all-MiniLM-L6-v2` | 로컬 임베딩 모델 (local 모드, 384차원) |
| `MINIO_ACCESS_KEY` | * | | MinIO 접근 키 (images/files 사용 시) |
| `MINIO_SECRET_KEY` | * | | MinIO 비밀 키 (images/files 사용 시) |
| `ZIME_ENCRYPTION_KEY` | * | | SQLCipher 암호화 키 (secrets 사용 시) |
| `OBSIDIAN_VAULT_PATH` | | | Obsidian vault 경로 |
| `NAS_BACKUP_PATH` | | | NAS 백업 경로 |

> `*` = 해당 store 사용 시 필수. `openssl rand -hex 32`로 암호화 키를 생성하세요.

---

## Usage

Claude Code에서 자연어로 사용합니다:

```
# 텍스트 저장
"Docker Compose에서 네트워크 설정하는 방법 저장해줘"

# 의미 기반 검색
"도커 네트워크 관련 메모 찾아줘"

# API 키 저장
"GitHub API 키 저장해줘" → secrets store 자동 라우팅

# 이미지 저장
"이 스크린샷 저장해줘" → images store 자동 라우팅

# 크로스 스토어 검색
"전체 검색: 인증 관련 모든 메모리"

# 통계 확인
"메모리 저장소 통계 보여줘"
```

---

## Project Structure

```
zime-memory/
├── src/
│   ├── index.ts                 # MCP 서버 진입점
│   ├── config.ts                # Zod 환경변수 검증
│   ├── instructions.ts          # MCP instructions
│   ├── tools/
│   │   ├── registry.ts          # 19개 도구 레지스트리
│   │   ├── memorySave.ts        # 저장
│   │   ├── memorySearch.ts      # 검색
│   │   └── ...                  # 17개 추가 도구
│   ├── services/
│   │   ├── qdrantService.ts     # Qdrant 벡터 DB
│   │   ├── minioService.ts      # MinIO 오브젝트 스토리지
│   │   ├── sqlcipherService.ts  # SQLCipher 암호화 DB
│   │   ├── embeddingService.ts  # 임베딩 Strategy Pattern (ollama/local/off)
│   │   ├── providers/
│   │   │   ├── ollamaProvider.ts   # Ollama REST API 프로바이더
│   │   │   ├── localProvider.ts    # @huggingface/transformers 로컬 프로바이더
│   │   │   └── noopProvider.ts     # Off 모드 (제로 벡터)
│   │   ├── backupService.ts     # 통합 백업
│   │   ├── obsidianService.ts   # Obsidian 동기화
│   │   ├── safetyService.ts     # 워터마크 검증
│   │   ├── storeRouter.ts       # store 라우팅
│   │   └── stores/
│   │       ├── generalOps.ts    # general store (텍스트)
│   │       ├── fileOps.ts       # images/files store
│   │       └── secretOps.ts     # secrets store
│   ├── types/
│   │   └── index.ts             # 타입 정의
│   └── utils/
│       ├── logger.ts            # 로깅
│       └── response.ts          # 응답 유틸
├── scripts/
│   ├── check-expiry.cjs         # 시크릿 만료 알림 (Slack)
│   └── test-setup.sh            # 테스트 데이터 생성
├── docker-compose.yml           # Qdrant + MinIO
├── install.sh                   # 자동 설치 스크립트
├── pack.sh                      # 배포 아카이브 생성
├── .env.example                 # 환경변수 템플릿
├── package.json
└── tsconfig.json
```

---

## Security

| 보호 대상 | 방법 |
|----------|------|
| secrets store | SQLCipher AES-256 전체 DB 암호화 |
| 시크릿 검색/목록 | `value` 필드 미포함 (명시적 `get`만 반환) |
| 이미지/파일 | MinIO Object Lock (GOVERNANCE 30일) |
| Docker 포트 | `127.0.0.1` 로컬 바인딩 |
| 파일 경로 | Path Traversal 검증 |
| SQL 쿼리 | 파라미터 바인딩 + 화이트리스트 검증 |
| import/bulk_delete | secrets store 미지원 (안전) |

---

## Store Support Matrix

| 도구 | general | images | files | secrets | all |
|------|:---:|:---:|:---:|:---:|:---:|
| save/get/update | O | O | O | O | - |
| delete | O | O | O | O | - |
| search | O | O | O | O | O |
| list/count | O | O | O | O | O |
| export | O | O | O | O | - |
| import | O | O | O | X | - |
| bulk_delete | O | O | O | X | - |
| download | - | O | O | - | - |
| link/summarize | O | - | - | - | - |
| reindex | O | - | - | - | - |
| obsidian_sync | O | - | - | - | - |

---

## Tech Stack

| 기술 | 용도 |
|------|------|
| [MCP SDK](https://modelcontextprotocol.io/) | Claude Code 통합 프로토콜 |
| [Qdrant](https://qdrant.tech/) | 벡터 유사도 검색 엔진 |
| [MinIO](https://min.io/) | S3 호환 오브젝트 스토리지 |
| [SQLCipher](https://www.zetetic.net/sqlcipher/) | AES-256 암호화 SQLite |
| [Ollama](https://ollama.com/) | 임베딩 모델 (기본: bge-m3, local 모드 시 불필요) |
| [@huggingface/transformers](https://huggingface.co/docs/transformers.js) | 로컬 임베딩 (local 모드, Ollama 불필요) |
| [Zod](https://zod.dev/) | 입력 스키마 검증 |
| [TypeScript](https://www.typescriptlang.org/) | 타입 안전 코드 |

---

## License

MIT
