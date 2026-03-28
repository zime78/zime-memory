/**
 * MCP 서버 instructions 문자열 모듈
 * Server 생성자에 전달되는 instructions를 별도 파일로 분리하여 가독성과 유지보수성을 높인다.
 */

/** MCP 서버 사용 지침 — 자연어 의도 매핑, 카테고리, 동작 규칙 등을 설명한다 */
export const INSTRUCTIONS: string = `Qdrant 벡터 DB 기반 개인 메모리 시스템. 3-Mode 임베딩(ollama/local/off)으로 텍스트를 벡터화하여 저장하고, 의미 기반 유사도 검색을 수행한다.

## 자연어 의도 매핑
- "기억해줘", "저장해줘" → memory_save
- "기억나?", "찾아줘" → memory_search
- "자세히 보여줘", "전문 보여줘" → memory_get
- "수정해줘", "바꿔줘" → memory_update
- "저장된 거 보여줘", "목록" → memory_list
- "몇 개야?", "건수" → memory_count
- "메모리 현황", "통계" → memory_stats
- "백업", "내보내기" → memory_export
- "복원", "가져오기" → memory_import
- "일괄 삭제" → memory_bulk_delete
- "임시 저장", "드래프트" → memory_save (status: "draft")
- "확정해줘", "발행해줘" → memory_update (status: "published")
- "임시 저장 목록" → memory_list (status: "draft")
- "고정해줘", "핀" → memory_update (pinned: true)
- "태그 달아줘", "태그 추가" → memory_save (tags: [...] — Claude가 내용 분석 후 직접 태그 제공)
- "연결해줘", "관계 설정" → memory_link
- "요약해줘", "정리해줘" → memory_summarize
- "스냅샷", "백업 생성" → memory_backup
- "원격 백업", "SSH 백업" → memory_backup (remoteBackup: true)
- "원격 백업 상태", "원격 스냅샷" → memory_backup (remoteStatus: true)
- "옵시디언 동기화" → memory_obsidian_sync
- "재인덱싱", "모델 변경" → memory_reindex
- "이미지 저장", "스크린샷 저장" → memory_save (store: "images")
- "파일 저장", "문서 보관" → memory_save (store: "files")
- "비밀번호 저장", "API 키 저장" → memory_save (store: "secrets")
- "파일 다운로드", "이미지 다운로드" → memory_download
- "전체 검색", "모든 메모리 검색" → memory_search (store: "all")
- "데이터 마이그레이션" → memory_migrate
- "삭제된 거 복원", "복원해줘" → memory_restore (action: "restore-item")
- "삭제된 목록", "휴지통" → memory_restore (action: "list-deleted")
- "백업 목록", "백업 리스트" → memory_restore (action: "list-backups")
- "DB 복원", "백업에서 복원" → memory_restore (action: "restore-sqlcipher", confirm: "RESTORE")

## 카테고리
| 카테고리 | 용도 | 예시 |
|----------|------|------|
| note | 일반 메모 | 회의 내용, 아이디어 |
| knowledge | 학습/지식 | 기술 정보, 개념 정리 |
| reference | 참조 정보 | URL, 문서 위치, 설정값 |
| snippet | 코드 조각 | 자주 쓰는 명령어, 코드 패턴 |
| decision | 의사결정 | 기술 선택 이유, 아키텍처 결정 |
| custom | 기타 | 분류 불가 항목 |

## 주요 동작 규칙
- save: 유사도 0.9 이상 기존 메모리 존재 시 duplicateWarning 포함 (저장은 진행), 관련 메모리 추천
- get: 관련 메모리(유사도 0.5 이상)를 최대 3건 추천
- update: content/title 변경 시 임베딩 재생성, createdAt 유지, status를 published로 변경 시 expiresAt 제거
- bulk_delete: 최소 1개 필터 필수 (전체 삭제 방지)
- search: scoreThreshold 기본 0.3, limit 기본 5, 기본적으로 published만 검색 (includeDrafts로 변경 가능)
- list: 기본적으로 published만 조회 (includeDrafts로 변경 가능), 날짜 범위 필터(fromDate/toDate) 지원
- import: skipDuplicates 기본 true, id 지정 시 원본 ID 보존

## 임시 저장 (Draft) & TTL
- status: "published"(기본) 또는 "draft"(임시 저장)
- ttl: draft 메모리에 자동 만료 기간 설정 (예: "3d", "12h")
- draft + ttl 설정 시 expiresAt이 자동 계산됨
- published로 변경 시 expiresAt과 ttl이 자동 제거됨

## 우선순위
low, medium(기본), high, critical

## 메모리 고정 (Pin)
- pinned: true로 저장하면 검색/목록에서 상단에 표시
- memory_update로 pinned 토글 가능

## 태깅
- 태그는 Claude가 memory_save 호출 시 내용을 분석하여 직접 tags 파라미터로 제공한다
- 로컬 LLM 의존 없이 고품질 태깅이 가능하다

## 메모리 연결 (Link)
- parentId: 상위 메모리 지정 (계층 구조)
- relatedIds: 연결 메모리 목록 (네트워크 구조)
- memory_link: 두 메모리 간 양방향/단방향 관계 설정

## 카테고리 요약
- memory_summarize: 카테고리/태그별 메모리를 LLM으로 종합 요약 (LLM_MODEL 환경변수 설정 필요, 선택사항)

## 백업
- memory_backup: Qdrant 스냅샷 생성, 선택적 NAS 복사
- listOnly: true로 스냅샷 목록만 조회
- memory_backup(remoteBackup: true): SSH로 원격 호스트에 시크릿 백업 (2중화)
- memory_backup(remoteStatus: true): 원격 백업 상태 조회
- memory_backup(remoteList: true): 원격 스냅샷 목록 조회

## Obsidian 동기화
- memory_obsidian_sync: Obsidian vault와 양방향 동기화
- direction: "import" | "export" | "bidirectional"
- YAML frontmatter로 메타데이터 매핑 (zime-id, category, priority, tags)

## 재인덱싱
- memory_reindex: 임베딩 모델 또는 프로바이더 변경 시 전체 벡터 재생성
- confirm: "CONFIRM" 입력 필수 (실수 방지)
- 프로바이더 전환(ollama↔local) 시 차원 불일치 자동 감지 및 컬렉션 재생성
- EMBEDDING_PROVIDER=off 상태에서는 재인덱싱 불가

## 임베딩 프로바이더
- EMBEDDING_PROVIDER=ollama (기본): Ollama REST API로 임베딩 생성 (bge-m3, 1024차원)
- EMBEDDING_PROVIDER=local: @huggingface/transformers 로컬 임베딩 (Ollama 불필요, 384차원)
- EMBEDDING_PROVIDER=off: 임베딩 비활성, 키워드/필터 검색만 가능 (의미 유사도 검색 불가)
- 프로바이더 전환 후 반드시 memory_reindex 실행 필요`;
