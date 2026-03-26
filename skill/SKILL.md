---
name: zime-memory
description: Qdrant 벡터 DB 기반 개인 메모리 시스템 — 저장, 검색, 수정, 조회, 목록, 삭제, 통계, 내보내기, 가져오기, 건수, 일괄삭제, 고정, 연결, 요약, 백업, Obsidian 동기화, 재인덱싱
triggers:
  - "메모리"
  - "memory"
  - "기억"
  - "기억해"
  - "remember"
  - "메모리 저장"
  - "메모리 검색"
  - "메모리 목록"
  - "메모리 삭제"
  - "메모리 통계"
  - "메모리 수정"
  - "메모리 업데이트"
  - "메모리 조회"
  - "메모리 내보내기"
  - "메모리 가져오기"
  - "메모리 백업"
  - "메모리 복원"
  - "메모리 건수"
  - "메모리 일괄 삭제"
  - "메모리 고정"
  - "메모리 핀"
  - "태그 달아줘"
  - "태그 추가"
  - "메모리 연결"
  - "메모리 링크"
  - "메모리 요약"
  - "카테고리 요약"
  - "메모리 스냅샷"
  - "옵시디언 동기화"
  - "재인덱싱"
  - "zime-memory"
  - "zime memory"
  - "memory update"
  - "memory export"
  - "memory import"
  - "memory count"
  - "memory backup"
  - "memory link"
  - "memory summarize"
  - "memory reindex"
  - "obsidian sync"
---

# zime-memory — Qdrant 벡터 메모리 시스템

개인 벡터 메모리 MCP 서버 래퍼 스킬. Qdrant에 텍스트를 임베딩하여 저장하고, 의미 기반 유사도 검색을 수행한다. 도구는 registry.ts에서 자동 관리됨.

## 사용 가능한 명령

| 명령 | 설명 | 예시 |
|------|------|------|
| `save` | 메모리 저장 (중복감지 포함) | `/zime-memory save "내용"` |
| `search` | 의미 기반 검색 | `/zime-memory search "쿼리"` |
| `get` | ID로 단건 전체 조회 | `/zime-memory get {uuid}` |
| `update` | 기존 메모리 수정 | `/zime-memory update {uuid} --title "새제목"` |
| `list` | 목록 조회 (필터) | `/zime-memory list` |
| `count` | 건수 조회 (그룹별) | `/zime-memory count --groupBy category` |
| `delete` | ID로 삭제 | `/zime-memory delete {uuid}` |
| `bulk-delete` | 필터 일괄 삭제 | `/zime-memory bulk-delete --category note` |
| `export` | 전체 JSON 내보내기 | `/zime-memory export` |
| `import` | JSON에서 일괄 복원 | `/zime-memory import` |
| `stats` | 컬렉션 통계 | `/zime-memory stats` |
| `link` | 메모리 간 관계 설정 | `/zime-memory link {sourceId} {targetId}` |
| `summarize` | 카테고리별 LLM 요약 | `/zime-memory summarize --category knowledge` |
| `backup` | Qdrant 스냅샷 백업 | `/zime-memory backup` |
| `obsidian-sync` | Obsidian 양방향 동기화 | `/zime-memory obsidian-sync --direction export` |
| `reindex` | 임베딩 모델 변경 재인덱싱 | `/zime-memory reindex` |

## MCP 도구 매핑

이 스킬은 다음 MCP 도구를 호출한다:

| 명령 | MCP 도구 |
|------|----------|
| save | `mcp__zime-memory__memory_save` |
| search | `mcp__zime-memory__memory_search` |
| get | `mcp__zime-memory__memory_get` |
| update | `mcp__zime-memory__memory_update` |
| list | `mcp__zime-memory__memory_list` |
| count | `mcp__zime-memory__memory_count` |
| delete | `mcp__zime-memory__memory_delete` |
| bulk-delete | `mcp__zime-memory__memory_bulk_delete` |
| export | `mcp__zime-memory__memory_export` |
| import | `mcp__zime-memory__memory_import` |
| stats | `mcp__zime-memory__memory_stats` |
| link | `mcp__zime-memory__memory_link` |
| summarize | `mcp__zime-memory__memory_summarize` |
| backup | `mcp__zime-memory__memory_backup` |
| obsidian-sync | `mcp__zime-memory__memory_obsidian_sync` |
| reindex | `mcp__zime-memory__memory_reindex` |

## 파라미터 레퍼런스

### save

| 파라미터 | 필수 | 타입 | 설명 |
|----------|------|------|------|
| `content` | O | string | 저장할 텍스트 내용 |
| `title` | X | string | 메모리 제목 |
| `category` | X | enum | `note`, `knowledge`, `reference`, `snippet`, `decision`, `custom` (기본: `note`) |
| `tags` | X | string[] | 태그 목록 |
| `priority` | X | enum | `low`, `medium`, `high`, `critical` (기본: `medium`) |
| `source` | X | string | 출처 정보 |
| `pinned` | X | boolean | 메모리 고정 여부 (기본: `false`) |
| `parentId` | X | uuid | 상위 메모리 ID (계층 구조) |
| `relatedIds` | X | uuid[] | 연결 메모리 ID 목록 |
| `status` | X | enum | `published`, `draft` (기본: `published`) |
| `ttl` | X | string | draft 자동 만료 기간 (예: `"3d"`, `"12h"`) |

유사도 0.9 이상인 기존 메모리가 있으면 `duplicateWarning` 필드가 응답에 포함된다 (저장은 정상 진행).
태그는 Claude가 내용을 분석하여 tags 파라미터로 직접 제공한다.

### search

| 파라미터 | 필수 | 타입 | 설명 |
|----------|------|------|------|
| `query` | O | string | 검색 쿼리 (자연어) |
| `category` | X | enum | 카테고리 필터 |
| `tags` | X | string[] | 태그 필터 |
| `priority` | X | enum | 우선순위 필터 |
| `limit` | X | int | 결과 수 (1-20, 기본: 5) |
| `scoreThreshold` | X | float | 유사도 임계값 (0-1, 기본: 0.3) |

### get

| 파라미터 | 필수 | 타입 | 설명 |
|----------|------|------|------|
| `id` | O | uuid | 조회할 메모리 ID |

내용을 잘라내지 않고 전체 페이로드를 반환한다.

### update

| 파라미터 | 필수 | 타입 | 설명 |
|----------|------|------|------|
| `id` | O | uuid | 수정할 메모리 ID |
| `content` | X | string | 수정할 내용 |
| `title` | X | string | 수정할 제목 |
| `tags` | X | string[] | 수정할 태그 목록 |
| `category` | X | enum | 수정할 카테고리 |
| `priority` | X | enum | 수정할 우선순위 |
| `source` | X | string | 수정할 출처 |

| `pinned` | X | boolean | 고정 여부 |
| `parentId` | X | uuid | 상위 메모리 ID |
| `relatedIds` | X | uuid[] | 연결 메모리 ID 목록 |
| `status` | X | enum | `published`, `draft` |
| `ttl` | X | string | draft 자동 만료 기간 |

id 외에 최소 하나의 수정 필드가 필요하다. content/title 변경 시 임베딩이 재생성된다.
createdAt은 유지되고 updatedAt만 갱신된다. status를 published로 변경하면 expiresAt이 제거된다.

### list

| 파라미터 | 필수 | 타입 | 설명 |
|----------|------|------|------|
| `category` | X | enum | 카테고리 필터 |
| `tags` | X | string[] | 태그 필터 |
| `priority` | X | enum | 우선순위 필터 |
| `limit` | X | int | 결과 수 (1-100, 기본: 20) |
| `offset` | X | string | 페이지네이션 오프셋 |

### count

| 파라미터 | 필수 | 타입 | 설명 |
|----------|------|------|------|
| `groupBy` | X | enum | `category`, `priority`, `tags` (생략 시 총 건수만 반환) |

groupBy 지정 시 항목별 breakdown 객체를 반환한다.

### delete

| 파라미터 | 필수 | 타입 | 설명 |
|----------|------|------|------|
| `id` | O | uuid | 삭제할 메모리 ID |

### bulk-delete

| 파라미터 | 필수 | 타입 | 설명 |
|----------|------|------|------|
| `category` | X | enum | 카테고리 필터 |
| `tags` | X | string[] | 태그 필터 (OR 조건) |
| `priority` | X | enum | 우선순위 필터 |

최소 하나의 필터 조건이 필요하다 (전체 삭제 방지). 삭제 전 매칭 건수를 먼저 조회하여 응답에 포함한다.

### export

| 파라미터 | 필수 | 타입 | 설명 |
|----------|------|------|------|
| `category` | X | enum | 카테고리 필터 |
| `tags` | X | string[] | 태그 필터 |
| `priority` | X | enum | 우선순위 필터 |

필터 없으면 전체 메모리를 JSON으로 내보낸다. 내용을 잘라내지 않고 전체를 포함한다.

### import

| 파라미터 | 필수 | 타입 | 설명 |
|----------|------|------|------|
| `memories` | O | array | 가져올 메모리 배열 (각 항목: content 필수, title/tags/category/priority/source/id/createdAt 선택) |
| `skipDuplicates` | X | boolean | 동일 ID 존재 시 건너뛰기 (기본: `true`) |

각 메모리에 대해 임베딩을 자동 생성한다. id를 지정하면 원본 ID를 보존한다.

### stats

파라미터 없음.

## 실행 규칙

1. **인수 파싱**: 사용자 입력에서 명령과 내용을 분리한다
   - `/zime-memory save "내용"` → save 명령 + content
   - `/zime-memory search NAS 설정` → search 명령 + query
   - `/zime-memory` (인수 없음) → stats 실행
   - `/zime-memory list knowledge` → list 명령 + category=knowledge
   - `/zime-memory count category` → count 명령 + groupBy=category
   - `/zime-memory get {uuid}` → get 명령 + id
   - `/zime-memory update {uuid} --title "제목"` → update 명령 + id + title

2. **MCP 도구 호출**: 파싱된 명령에 해당하는 MCP 도구를 호출한다

3. **결과 포맷팅**: MCP 응답을 테이블 형식으로 정리하여 출력한다

4. **자연어 지원**: 명시적 명령어 없이도 의도를 파악한다
   - "이거 기억해줘: ..." → save
   - "~에 대해 기억나?" → search
   - "이거 자세히 보여줘" / "전문 보여줘" → get
   - "이거 수정해줘" / "내용 바꿔줘" → update
   - "저장된 거 보여줘" → list
   - "몇 개야?" / "건수" → count
   - "메모리 현황" → stats
   - "메모리 백업" / "내보내기" → export
   - "메모리 복원" / "가져오기" → import
   - "전부 삭제" / "일괄 삭제" → bulk-delete

## 카테고리 가이드

| 카테고리 | 용도 | 예시 |
|----------|------|------|
| `note` | 일반 메모 | 회의 내용, 아이디어 |
| `knowledge` | 학습/지식 | 기술 정보, 개념 정리 |
| `reference` | 참조 정보 | URL, 문서 위치, 설정값 |
| `snippet` | 코드 조각 | 자주 쓰는 명령어, 코드 패턴 |
| `decision` | 의사결정 | 기술 선택 이유, 아키텍처 결정 |
| `custom` | 기타 | 분류 불가 항목 |

## 신규 도구 파라미터 레퍼런스

### link

| 파라미터 | 필수 | 타입 | 설명 |
|----------|------|------|------|
| `sourceId` | O | uuid | 관계 출발점 메모리 ID |
| `targetId` | O | uuid | 관계 도착점 메모리 ID |
| `bidirectional` | X | boolean | 양방향 관계 여부 (기본: `true`) |

두 메모리의 `relatedIds`에 서로를 추가한다. 자기 자신과의 연결은 불가.

### summarize

| 파라미터 | 필수 | 타입 | 설명 |
|----------|------|------|------|
| `category` | X | enum | 요약 대상 카테고리 |
| `tags` | X | string[] | 요약 대상 태그 (OR 조건) |
| `limit` | X | int | 요약할 최대 메모리 수 (1-50, 기본: 20) |

LLM이 메모리들을 종합하여 핵심 주제와 인사이트를 요약한다.

### backup

| 파라미터 | 필수 | 타입 | 설명 |
|----------|------|------|------|
| `copyToNas` | X | boolean | NAS에 스냅샷 복사 여부 (기본: `false`) |
| `listOnly` | X | boolean | 스냅샷 목록만 조회 (기본: `false`) |

Qdrant 스냅샷을 생성하고, NAS_BACKUP_PATH 설정 시 NAS에 복사할 수 있다.
자동 백업(6시간 간격) 시 오래된 스냅샷은 자동 프루닝된다 (Qdrant/NAS/로컬 각각 최대 20개 유지).

#### 백업 관련 환경 변수

| 환경 변수 | 기본값 | 설명 |
|----------|--------|------|
| `BACKUP_INTERVAL_HOURS` | `6` | 자동 백업 주기 (시간) |
| `NAS_BACKUP_PATH` | - | NAS 백업 경로 (미설정 시 NAS 복사 비활성) |
| `MAX_QDRANT_SNAPSHOTS` | `20` | Qdrant 서버 스냅샷 최대 보관 수 |
| `MAX_NAS_BACKUPS` | `20` | NAS 디렉토리별 백업 최대 보관 수 |
| `DISABLE_LOCAL_BACKUP` | - | `true` 설정 시 로컬 안전 백업 비활성 |

### obsidian-sync

| 파라미터 | 필수 | 타입 | 설명 |
|----------|------|------|------|
| `vaultPath` | X | string | Obsidian vault 경로 (미지정 시 환경변수 사용) |
| `folder` | X | string | vault 내 하위 폴더 (기본: `"zime-memory"`) |
| `direction` | O | enum | `import`, `export`, `bidirectional` |

YAML frontmatter로 zime-id, category, priority, tags를 매핑한다.
bidirectional은 updatedAt 비교로 최신 쪽 우선.

### reindex

| 파라미터 | 필수 | 타입 | 설명 |
|----------|------|------|------|
| `confirm` | O | literal | `"CONFIRM"` 입력 필수 (실수 방지) |

EMBEDDING_MODEL 변경 후 전체 메모리의 벡터를 재생성한다.
