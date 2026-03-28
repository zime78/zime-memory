# Contributing to zime-memory

zime-memory에 기여해주셔서 감사합니다! 이 문서는 기여 방법을 안내합니다.

## 개발 환경 설정

```bash
git clone https://github.com/zime78/zime-memory.git
cd zime-memory
cp .env.example .env
# .env에 필수 키 입력 (openssl rand -hex 32 등)
docker compose up -d
npm install
npm run build
ollama pull bge-m3
```

## 브랜치 전략

- `main` — 안정 릴리스
- `develop` — 개발 브랜치 (PR 대상)
- `feat/*` — 새 기능
- `fix/*` — 버그 수정

## Pull Request 절차

1. `develop` 브랜치에서 feature 브랜치 생성
2. 변경 사항 구현 + 빌드 확인 (`npm run build`)
3. PR 생성 (base: `develop`)
4. 리뷰 후 머지

## 커밋 메시지 규칙

[Conventional Commits](https://www.conventionalcommits.org/) 형식을 따릅니다:

```
feat: 새 기능 추가
fix: 버그 수정
docs: 문서 변경
refactor: 리팩토링
test: 테스트 추가/수정
chore: 빌드/도구 변경
```

## 코드 스타일

- TypeScript strict mode
- ESM (ES Modules)
- Zod로 입력 검증
- 함수/주요 로직에 한글 주석

## 테스트

```bash
npm run build            # TypeScript 컴파일 확인
bash scripts/test-setup.sh setup  # 테스트 데이터 생성
# docs/test-cases.md의 Phase 1~17 테스트 수행
bash scripts/test-setup.sh cleanup  # 테스트 데이터 정리
```

## 프로젝트 구조

```
src/
├── index.ts              # MCP 서버 진입점
├── config.ts             # 환경변수 검증
├── tools/                # 19개 MCP 도구
├── services/             # 비즈니스 로직
│   ├── stores/           # store별 연산 (general, file, secret)
│   ├── qdrantService.ts  # 벡터 DB
│   ├── minioService.ts   # 오브젝트 스토리지
│   ├── cacheService.ts   # 읽기 캐시
│   └── connectionMonitor.ts  # 연결 상태 감시
└── types/                # 타입 정의
```

## 이슈 리포트

[GitHub Issues](https://github.com/zime78/zime-memory/issues)에서 다음 정보를 포함하여 보고해주세요:

- 재현 단계
- 기대 동작 vs 실제 동작
- 환경 (OS, Node.js 버전, Docker 버전)
- 관련 로그 (MCP 서버 stderr)

## 라이선스

MIT License — 자유롭게 사용, 수정, 배포할 수 있습니다.
