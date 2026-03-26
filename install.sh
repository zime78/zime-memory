#!/usr/bin/env bash
# ============================================================================
# zime-memory 설치 스크립트
# Qdrant 벡터 DB + Ollama 임베딩(bge-m3) 기반 Claude Code MCP 메모리 서버
#
# 사용법: tar xzf zime-memory-installer.tar.gz && cd zime-memory && ./install.sh
# ============================================================================
set -euo pipefail

# ── Phase 0: 설정 변수 및 유틸 함수 ──────────────────────────────────────────

INSTALL_DIR="$HOME/mcp/zime-memory"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

QDRANT_URL="http://localhost:6333"
OLLAMA_URL="http://localhost:11434"
EMBEDDING_MODEL="bge-m3"
COLLECTION_NAME="memories"

CLAUDE_SETTINGS="$HOME/.claude/settings.json"
SKILL_DIR="$HOME/.claude/skills/zime-memory"

OS_TYPE="$(uname -s | tr '[:upper:]' '[:lower:]')"
DOCKER_COMPOSE=""

# 색상 (NO_COLOR 환경변수 지원)
if [ -z "${NO_COLOR:-}" ] && [ -t 1 ]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BLUE='\033[0;34m'; NC='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; BLUE=''; NC=''
fi

log_info()    { printf "${BLUE}[INFO]${NC} %s\n" "$1"; }
log_success() { printf "${GREEN}[OK]${NC}   %s\n" "$1"; }
log_warn()    { printf "${YELLOW}[WARN]${NC} %s\n" "$1"; }
log_error()   { printf "${RED}[ERR]${NC}  %s\n" "$1"; }

# 임시 파일 정리 트랩
TMPFILES=()
cleanup() { for f in "${TMPFILES[@]:-}"; do rm -f "$f"; done; }
trap cleanup EXIT

# ── Phase 1: 필수 도구 확인 ──────────────────────────────────────────────────

phase1_check_prerequisites() {
  log_info "Phase 1: 필수 도구 확인"
  local missing=()

  # Docker
  if ! command -v docker &>/dev/null; then
    if [ "$OS_TYPE" = "darwin" ]; then
      missing+=("Docker — brew install --cask docker")
    else
      missing+=("Docker — https://docs.docker.com/engine/install/")
    fi
  fi

  # docker compose 감지
  if docker compose version &>/dev/null 2>&1; then
    DOCKER_COMPOSE="docker compose"
  elif command -v docker-compose &>/dev/null; then
    DOCKER_COMPOSE="docker-compose"
  elif command -v docker &>/dev/null; then
    missing+=("docker compose plugin — Docker Desktop 재설치 또는 apt install docker-compose-plugin")
  fi

  # Node.js >= 18
  if command -v node &>/dev/null; then
    NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_MAJOR" -lt 18 ]; then
      missing+=("Node.js >= 18 (현재: v$(node -v | sed 's/v//')) — https://nodejs.org/")
    fi
  else
    if [ "$OS_TYPE" = "darwin" ]; then
      missing+=("Node.js >= 18 — brew install node")
    else
      missing+=("Node.js >= 18 — https://nodejs.org/")
    fi
  fi

  # Ollama
  if ! command -v ollama &>/dev/null; then
    if [ "$OS_TYPE" = "darwin" ]; then
      missing+=("Ollama — brew install ollama")
    else
      missing+=("Ollama — curl -fsSL https://ollama.com/install.sh | sh")
    fi
  fi

  # jq
  if ! command -v jq &>/dev/null; then
    if [ "$OS_TYPE" = "darwin" ]; then
      missing+=("jq — brew install jq")
    else
      missing+=("jq — apt install jq")
    fi
  fi

  if [ ${#missing[@]} -gt 0 ]; then
    log_error "다음 도구가 누락되었습니다:"
    for item in "${missing[@]}"; do
      printf "  - %s\n" "$item"
    done
    exit 1
  fi

  # Docker 데몬 실행 확인
  if ! docker info &>/dev/null 2>&1; then
    log_error "Docker 데몬이 실행되고 있지 않습니다."
    if [ "$OS_TYPE" = "darwin" ]; then
      log_error "Docker Desktop을 실행해주세요."
    else
      log_error "'sudo systemctl start docker'로 시작해주세요."
    fi
    exit 1
  fi

  # Ollama 서비스 확인
  if ! curl -sf "$OLLAMA_URL/api/tags" &>/dev/null; then
    log_warn "Ollama 서비스가 응답하지 않습니다."
    if [ "$OS_TYPE" = "darwin" ]; then
      log_warn "Ollama.app을 실행하거나 'ollama serve'를 실행해주세요."
    else
      log_warn "'ollama serve &' 또는 'systemctl start ollama'를 실행해주세요."
    fi
    log_warn "Phase 5에서 모델 풀 시 재시도합니다. 계속 진행합니다..."
  fi

  log_success "Phase 1 완료: 필수 도구 확인됨"
}

# ── Phase 2: 소스 배치 + .env 생성 ───────────────────────────────────────────

phase2_setup_source() {
  log_info "Phase 2: 소스 배치"

  if [ "$SCRIPT_DIR" = "$INSTALL_DIR" ]; then
    log_info "이미 설치 위치($INSTALL_DIR)에서 실행 중"
  else
    mkdir -p "$(dirname "$INSTALL_DIR")"
    if [ -d "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/package.json" ]; then
      log_info "기존 설치 발견 — 소스 업데이트"
    fi
    # 아카이브에서 풀린 위치 → 설치 디렉토리로 복사
    cp -R "$SCRIPT_DIR/." "$INSTALL_DIR/"
    log_info "소스를 $INSTALL_DIR 에 배치 완료"
  fi

  # .env 생성 (없을 때만)
  if [ ! -f "$INSTALL_DIR/.env" ]; then
    cat > "$INSTALL_DIR/.env" << 'ENVEOF'
QDRANT_URL=http://localhost:6333
OLLAMA_URL=http://localhost:11434
EMBEDDING_MODEL=bge-m3
COLLECTION_NAME=memories
ENVEOF
    log_info ".env 파일 생성됨"
  else
    log_info ".env 파일 이미 존재 — 건너뜀"
  fi

  log_success "Phase 2 완료: 소스 배치됨"
}

# ── Phase 3: Qdrant 컨테이너 시작 ────────────────────────────────────────────

phase3_start_qdrant() {
  log_info "Phase 3: Qdrant 컨테이너 시작"

  if docker ps --format '{{.Names}}' | grep -q '^zime-memory$'; then
    log_info "Qdrant 컨테이너 'zime-memory' 이미 실행 중"
  else
    log_info "Qdrant 컨테이너 시작 중..."
    cd "$INSTALL_DIR"
    $DOCKER_COMPOSE up -d
  fi

  # 헬스체크 대기 (최대 30초)
  log_info "Qdrant 헬스체크 대기 중..."
  for i in $(seq 1 30); do
    if curl -sf "$QDRANT_URL/healthz" &>/dev/null; then
      log_success "Phase 3 완료: Qdrant 정상 작동"
      return 0
    fi
    if [ "$i" -eq 30 ]; then
      log_error "Qdrant가 30초 내에 응답하지 않습니다."
      log_error "'docker logs zime-memory'로 로그를 확인해주세요."
      exit 1
    fi
    sleep 1
  done
}

# ── Phase 4: npm install + build ─────────────────────────────────────────────

phase4_build() {
  log_info "Phase 4: 의존성 설치 및 빌드"
  cd "$INSTALL_DIR"

  log_info "npm install 실행 중..."
  npm install --loglevel=warn

  log_info "TypeScript 빌드 중..."
  npm run build

  if [ ! -f "$INSTALL_DIR/dist/index.js" ]; then
    log_error "빌드 실패: dist/index.js가 생성되지 않았습니다."
    exit 1
  fi

  log_success "Phase 4 완료: 빌드 성공"
}

# ── Phase 5: Ollama 모델 풀 ──────────────────────────────────────────────────

phase5_pull_model() {
  log_info "Phase 5: Ollama 모델 확인 ($EMBEDDING_MODEL)"

  # Ollama 서비스 재확인
  if ! curl -sf "$OLLAMA_URL/api/tags" &>/dev/null; then
    log_error "Ollama 서비스가 응답하지 않습니다. Ollama를 먼저 실행해주세요."
    log_error "  macOS: Ollama.app 실행 또는 'ollama serve'"
    log_error "  Linux: 'ollama serve &' 또는 'systemctl start ollama'"
    exit 1
  fi

  if ollama list 2>/dev/null | grep -q "$EMBEDDING_MODEL"; then
    log_info "모델 '$EMBEDDING_MODEL' 이미 설치됨"
  else
    log_info "모델 '$EMBEDDING_MODEL' 다운로드 중... (수 분 소요될 수 있음)"
    ollama pull "$EMBEDDING_MODEL"
  fi

  # 임베딩 테스트
  local embed_result
  embed_result=$(curl -sf "$OLLAMA_URL/api/embed" \
    -d "{\"model\": \"$EMBEDDING_MODEL\", \"input\": \"test\"}" 2>/dev/null || echo "{}")
  local dim
  dim=$(echo "$embed_result" | jq '.embeddings[0] | length' 2>/dev/null || echo "0")

  if [ "$dim" = "1024" ]; then
    log_success "Phase 5 완료: 임베딩 모델 정상 (1024차원)"
  elif [ "$dim" != "0" ]; then
    log_warn "임베딩 차원: ${dim} (예상: 1024). 동작에 문제가 있을 수 있습니다."
  else
    log_warn "임베딩 테스트 실패. 모델이 올바르게 설치되었는지 확인해주세요."
  fi
}

# ── Phase 6: Claude Code settings.json 병합 ──────────────────────────────────

phase6_configure_claude() {
  log_info "Phase 6: Claude Code 설정 업데이트"

  local absolute_install_dir
  absolute_install_dir="$(cd "$INSTALL_DIR" && pwd)"

  # ~/.claude 디렉토리 생성
  mkdir -p "$(dirname "$CLAUDE_SETTINGS")"

  # settings.json 없으면 최소 구조 생성
  if [ ! -f "$CLAUDE_SETTINGS" ]; then
    echo '{}' > "$CLAUDE_SETTINGS"
    log_info "settings.json 새로 생성됨"
  fi

  # 임시 파일로 안전하게 병합
  local tmpfile
  tmpfile=$(mktemp)
  TMPFILES+=("$tmpfile")

  jq --arg dir "$absolute_install_dir" \
     --arg qdrant_url "$QDRANT_URL" \
     --arg ollama_url "$OLLAMA_URL" \
     '
     # mcpServers 객체 보장
     .mcpServers //= {} |

     # zime-memory MCP 서버 설정 추가/갱신
     .mcpServers."zime-memory" = {
       "command": "node",
       "args": [($dir + "/dist/index.js")],
       "env": {
         "QDRANT_URL": $qdrant_url,
         "OLLAMA_URL": $ollama_url
       }
     } |

     # permissions.allow 배열 보장
     .permissions.allow //= [] |

     # 권한 추가 (중복 방지)
     if (.permissions.allow | index("mcp__zime-memory__*")) then
       .
     else
       .permissions.allow += ["mcp__zime-memory__*"]
     end
     ' "$CLAUDE_SETTINGS" > "$tmpfile"

  # JSON 유효성 검증 후 교체
  if jq empty "$tmpfile" 2>/dev/null; then
    mv "$tmpfile" "$CLAUDE_SETTINGS"
    log_success "Phase 6 완료: settings.json 업데이트됨"
  else
    log_error "생성된 settings.json이 유효하지 않습니다. 수동 설정이 필요합니다."
    log_error "MCP 서버 경로: $absolute_install_dir/dist/index.js"
    rm -f "$tmpfile"
    exit 1
  fi
}

# ── Phase 7: Skill 파일 설치 ─────────────────────────────────────────────────

phase7_install_skill() {
  log_info "Phase 7: Skill 파일 설치"

  mkdir -p "$SKILL_DIR"

  local skill_src=""
  if [ -f "$INSTALL_DIR/skill/SKILL.md" ]; then
    skill_src="$INSTALL_DIR/skill/SKILL.md"
  elif [ -f "$SCRIPT_DIR/skill/SKILL.md" ]; then
    skill_src="$SCRIPT_DIR/skill/SKILL.md"
  fi

  if [ -n "$skill_src" ]; then
    cp "$skill_src" "$SKILL_DIR/SKILL.md"
    log_success "Phase 7 완료: SKILL.md 설치됨 ($SKILL_DIR/)"
  else
    log_warn "Phase 7: SKILL.md를 찾을 수 없습니다."
    log_warn "수동으로 $SKILL_DIR/SKILL.md 에 복사해주세요."
  fi
}

# ── Phase 8: 헬스체크 검증 ───────────────────────────────────────────────────

phase8_healthcheck() {
  log_info "Phase 8: 헬스체크 검증"

  local pass=0
  local fail=0

  # 1. Qdrant 헬스
  if curl -sf "$QDRANT_URL/healthz" &>/dev/null; then
    log_success "  Qdrant: 정상"
    pass=$((pass + 1))
  else
    log_error "  Qdrant: 응답 없음"
    fail=$((fail + 1))
  fi

  # 2. Ollama 모델 확인
  if ollama list 2>/dev/null | grep -q "$EMBEDDING_MODEL"; then
    log_success "  Ollama: '$EMBEDDING_MODEL' 모델 사용 가능"
    pass=$((pass + 1))
  else
    log_error "  Ollama: '$EMBEDDING_MODEL' 모델 없음"
    fail=$((fail + 1))
  fi

  # 3. MCP 서버 바이너리
  if [ -f "$INSTALL_DIR/dist/index.js" ]; then
    log_success "  MCP 서버: 빌드 산출물 존재"
    pass=$((pass + 1))
  else
    log_error "  MCP 서버: dist/index.js 없음"
    fail=$((fail + 1))
  fi

  # 4. Claude Code 설정
  if jq -e '.mcpServers."zime-memory"' "$CLAUDE_SETTINGS" &>/dev/null; then
    log_success "  Claude 설정: MCP 서버 등록됨"
    pass=$((pass + 1))
  else
    log_error "  Claude 설정: MCP 서버 미등록"
    fail=$((fail + 1))
  fi

  # 5. Skill 파일
  if [ -f "$SKILL_DIR/SKILL.md" ]; then
    log_success "  Skill 파일: 설치됨"
    pass=$((pass + 1))
  else
    log_error "  Skill 파일: 미설치"
    fail=$((fail + 1))
  fi

  # 6. Docker 컨테이너
  if docker ps --format '{{.Names}}' | grep -q '^zime-memory$'; then
    log_success "  Docker: 컨테이너 실행 중"
    pass=$((pass + 1))
  else
    log_error "  Docker: 컨테이너 미실행"
    fail=$((fail + 1))
  fi

  echo ""
  log_info "헬스체크 결과: ${pass}/6 통과, ${fail}/6 실패"
  return $fail
}

# ── Phase 9: 설치 결과 리포트 ────────────────────────────────────────────────

phase9_report() {
  local absolute_install_dir
  absolute_install_dir="$(cd "$INSTALL_DIR" && pwd)"

  echo ""
  echo "========================================="
  echo "  zime-memory 설치 완료"
  echo "========================================="
  echo ""
  echo "  설치 위치:      $absolute_install_dir"
  echo "  Qdrant URL:     $QDRANT_URL"
  echo "  Ollama URL:     $OLLAMA_URL"
  echo "  임베딩 모델:     $EMBEDDING_MODEL (1024차원)"
  echo "  컬렉션 이름:     $COLLECTION_NAME"
  echo ""
  echo "  MCP 설정:       $CLAUDE_SETTINGS"
  echo "  Skill 파일:     $SKILL_DIR/SKILL.md"
  echo ""
  echo "  다음 단계:"
  echo "    1. Claude Code를 재시작하여 MCP 서버 로드"
  echo "    2. '/zime-memory stats' 실행하여 동작 확인"
  echo "    3. '/zime-memory save \"테스트 메모리\"' 로 저장 테스트"
  echo ""
  echo "========================================="
}

# ── 메인 실행 ────────────────────────────────────────────────────────────────

main() {
  echo ""
  echo "========================================="
  echo "  zime-memory 설치 시작"
  echo "  Qdrant + Ollama (bge-m3) MCP 서버"
  echo "========================================="
  echo ""

  phase1_check_prerequisites
  echo ""
  phase2_setup_source
  echo ""
  phase3_start_qdrant
  echo ""
  phase4_build
  echo ""
  phase5_pull_model
  echo ""
  phase6_configure_claude
  echo ""
  phase7_install_skill
  echo ""
  phase8_healthcheck || true
  phase9_report
}

main "$@"
