#!/usr/bin/env bash
# ============================================================================
# zime-memory 설치 스크립트
# Qdrant 벡터 DB + 3-Mode 임베딩(ollama/local/off) 기반 Claude Code MCP 메모리 서버
#
# 사용법:
#   GitHub: git clone https://github.com/zime78/zime-memory.git && cd zime-memory && ./install.sh
#   아카이브: tar xzf zime-memory-installer.tar.gz && cd zime-memory && ./install.sh
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
IS_UPGRADE=false

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

# 사용자 확인 프롬프트 (Y/n)
ask_install() {
  local tool="$1"
  local cmd="$2"
  printf "${YELLOW}[ASK]${NC} %s이(가) 설치되어 있지 않습니다. 설치할까요? [Y/n] " "$tool"
  read -r answer
  if [ "${answer:-Y}" = "Y" ] || [ "${answer:-y}" = "y" ] || [ -z "$answer" ]; then
    log_info "$tool 설치 중..."
    eval "$cmd"
    return $?
  else
    log_warn "$tool 설치를 건너뛰었습니다."
    return 1
  fi
}

# 임시 파일 정리 트랩
TMPFILES=()
cleanup() { for f in "${TMPFILES[@]:-}"; do rm -f "$f"; done; }
trap cleanup EXIT

# ── Phase 1: 필수 도구 확인 ──────────────────────────────────────────────────

phase1_check_prerequisites() {
  log_info "Phase 1: 필수 도구 확인 및 설치"
  local failed=false

  # ── macOS: Homebrew 확인 ──
  if [ "$OS_TYPE" = "darwin" ] && ! command -v brew &>/dev/null; then
    log_warn "Homebrew가 설치되어 있지 않습니다."
    log_warn "설치: /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
    log_error "Homebrew 설치 후 다시 실행해주세요."
    exit 1
  fi

  # ── Docker ──
  if ! command -v docker &>/dev/null; then
    if [ "$OS_TYPE" = "darwin" ]; then
      ask_install "Docker Desktop" "brew install --cask docker" || failed=true
    else
      log_warn "Docker가 설치되어 있지 않습니다."
      log_warn "설치: curl -fsSL https://get.docker.com | sh"
      log_warn "또는: https://docs.docker.com/engine/install/"
      failed=true
    fi
  else
    log_success "Docker: $(docker --version | head -1)"
  fi

  # ── docker compose 감지 ──
  if docker compose version &>/dev/null 2>&1; then
    DOCKER_COMPOSE="docker compose"
  elif command -v docker-compose &>/dev/null; then
    DOCKER_COMPOSE="docker-compose"
  elif command -v docker &>/dev/null; then
    log_warn "docker compose 플러그인이 없습니다."
    if [ "$OS_TYPE" = "darwin" ]; then
      log_warn "Docker Desktop을 재설치하면 포함됩니다."
    else
      log_warn "설치: sudo apt install docker-compose-plugin"
    fi
    failed=true
  fi

  # ── Node.js >= 18 ──
  if command -v node &>/dev/null; then
    NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_MAJOR" -lt 18 ]; then
      log_warn "Node.js 버전이 낮습니다 (현재: v$(node -v | sed 's/v//')). >= 18 필요."
      if [ "$OS_TYPE" = "darwin" ]; then
        ask_install "Node.js (최신)" "brew upgrade node" || failed=true
      else
        log_warn "업그레이드: https://nodejs.org/"
        failed=true
      fi
    else
      log_success "Node.js: $(node -v)"
    fi
  else
    if [ "$OS_TYPE" = "darwin" ]; then
      ask_install "Node.js" "brew install node" || failed=true
    else
      log_warn "Node.js가 설치되어 있지 않습니다."
      log_warn "설치: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
      failed=true
    fi
  fi

  # ── Ollama ──
  if ! command -v ollama &>/dev/null; then
    if [ "$OS_TYPE" = "darwin" ]; then
      ask_install "Ollama" "brew install ollama" || failed=true
    else
      ask_install "Ollama" "curl -fsSL https://ollama.com/install.sh | sh" || failed=true
    fi
  else
    log_success "Ollama: $(ollama --version 2>/dev/null || echo 'installed')"
  fi

  # ── jq ──
  if ! command -v jq &>/dev/null; then
    if [ "$OS_TYPE" = "darwin" ]; then
      ask_install "jq" "brew install jq" || failed=true
    else
      ask_install "jq" "sudo apt install -y jq" || failed=true
    fi
  else
    log_success "jq: $(jq --version)"
  fi

  # ── 실패한 도구가 있으면 종료 ──
  if [ "$failed" = true ]; then
    echo ""
    log_error "일부 필수 도구가 설치되지 않았습니다."
    log_error "위 안내에 따라 설치한 후 다시 ./install.sh를 실행해주세요."
    exit 1
  fi

  # ── Docker 데몬 실행 확인 ──
  if ! docker info &>/dev/null 2>&1; then
    log_warn "Docker 데몬이 실행되고 있지 않습니다."
    if [ "$OS_TYPE" = "darwin" ]; then
      log_info "Docker Desktop을 실행합니다..."
      open -a Docker
      log_info "Docker 시작 대기 중... (최대 60초)"
      for i in $(seq 1 60); do
        if docker info &>/dev/null 2>&1; then
          log_success "Docker 데몬 시작됨"
          break
        fi
        if [ "$i" -eq 60 ]; then
          log_error "Docker가 60초 내에 시작되지 않았습니다. Docker Desktop을 수동으로 실행해주세요."
          exit 1
        fi
        sleep 1
      done
    else
      log_error "'sudo systemctl start docker'로 시작해주세요."
      exit 1
    fi
  fi

  # ── Ollama 서비스 확인 ──
  if ! curl -sf "$OLLAMA_URL/api/tags" &>/dev/null; then
    log_warn "Ollama 서비스가 응답하지 않습니다."
    if [ "$OS_TYPE" = "darwin" ]; then
      log_info "Ollama 서비스를 시작합니다..."
      ollama serve &>/dev/null &
      sleep 3
      if curl -sf "$OLLAMA_URL/api/tags" &>/dev/null; then
        log_success "Ollama 서비스 시작됨"
      else
        log_warn "Ollama 서비스 시작 실패. Phase 5에서 재시도합니다."
      fi
    else
      log_warn "'ollama serve &' 또는 'systemctl start ollama'를 실행해주세요."
      log_warn "Phase 5에서 모델 풀 시 재시도합니다. 계속 진행합니다..."
    fi
  fi

  log_success "Phase 1 완료: 필수 도구 확인됨"
}

# ── Phase 2: 소스 배치 + .env 생성 ───────────────────────────────────────────

phase2_setup_source() {
  log_info "Phase 2: 소스 배치"

  # 업그레이드 감지: 기존 설치가 있고 dist/index.js가 존재하면 업그레이드
  if [ -f "$INSTALL_DIR/dist/index.js" ]; then
    IS_UPGRADE=true
    local cur_ver=""
    if [ -f "$INSTALL_DIR/package.json" ]; then
      cur_ver=$(jq -r '.version // "unknown"' "$INSTALL_DIR/package.json" 2>/dev/null || echo "unknown")
    fi
    local new_ver=""
    if [ -f "$SCRIPT_DIR/package.json" ]; then
      new_ver=$(jq -r '.version // "unknown"' "$SCRIPT_DIR/package.json" 2>/dev/null || echo "unknown")
    fi
    echo ""
    log_info "============================================"
    log_info "  기존 설치 감지 — 업그레이드 모드"
    log_info "  현재 버전: ${cur_ver}"
    log_info "  새 버전:   ${new_ver}"
    log_info "============================================"
    echo ""
  fi

  if [ "$SCRIPT_DIR" = "$INSTALL_DIR" ]; then
    log_info "이미 설치 위치($INSTALL_DIR)에서 실행 중"
  else
    mkdir -p "$(dirname "$INSTALL_DIR")"
    if [ "$IS_UPGRADE" = true ]; then
      log_info "기존 설치 발견 — 소스 업데이트 (.env 보존)"
    fi
    # 아카이브/clone에서 풀린 위치 → 설치 디렉토리로 복사 (.env 제외)
    rsync -a --exclude='.env' --exclude='data/' --exclude='node_modules/' --exclude='dist/' \
      "$SCRIPT_DIR/" "$INSTALL_DIR/"
    log_info "소스를 $INSTALL_DIR 에 배치 완료"
  fi

  # .env 생성 (없을 때만) — Multi-Store 전체 설정 포함
  if [ ! -f "$INSTALL_DIR/.env" ]; then
    # 보안 키 자동 생성 (openssl 또는 Node.js fallback)
    local minio_password encryption_key
    if command -v openssl &>/dev/null; then
      minio_password="$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)"
      encryption_key="$(openssl rand -hex 32)"
    elif command -v node &>/dev/null; then
      minio_password="$(node -e "console.log(require('crypto').randomBytes(18).toString('base64url').slice(0,24))")"
      encryption_key="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
    else
      log_error "openssl 또는 Node.js가 필요합니다 (키 생성용)"
      exit 1
    fi

    cat > "$INSTALL_DIR/.env" << ENVEOF
# Qdrant 벡터 DB
QDRANT_URL=http://localhost:6333
COLLECTION_NAME=memories

# 임베딩 프로바이더: ollama(기본), local(코드 기반), off(비활성)
EMBEDDING_PROVIDER=ollama

# Ollama 임베딩 (EMBEDDING_PROVIDER=ollama 일 때)
OLLAMA_URL=http://localhost:11434
EMBEDDING_MODEL=bge-m3

# 로컬 임베딩 모델 (EMBEDDING_PROVIDER=local 일 때)
# LOCAL_EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2

# MinIO 오브젝트 스토리지 (images/files store)
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_ACCESS_KEY=zime
MINIO_SECRET_KEY=${minio_password}

# SQLCipher 암호화 DB (secrets store)
ZIME_ENCRYPTION_KEY=${encryption_key}

# Docker Compose용 MinIO 크레덴셜
MINIO_ROOT_USER=zime
MINIO_ROOT_PASSWORD=${minio_password}

# Obsidian vault 경로 (선택사항)
# OBSIDIAN_VAULT_PATH=/path/to/your/vault

# NAS 백업 경로 (선택사항)
# NAS_BACKUP_PATH=/volume1/backups/zime-memory
ENVEOF
    log_info ".env 파일 생성됨 (MinIO/SQLCipher 키 자동 생성)"
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

  # 업그레이드 시 기존 빌드 정리
  if [ "$IS_UPGRADE" = true ] && [ -d "$INSTALL_DIR/dist" ]; then
    log_info "기존 빌드 정리 중..."
    rm -rf "$INSTALL_DIR/dist"
  fi

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
    if [ "$IS_UPGRADE" = true ] && [ -f "$SKILL_DIR/SKILL.md" ]; then
      if ! diff -q "$skill_src" "$SKILL_DIR/SKILL.md" &>/dev/null; then
        cp "$skill_src" "$SKILL_DIR/SKILL.md"
        log_success "Phase 7 완료: SKILL.md 업데이트됨 ($SKILL_DIR/)"
      else
        log_info "SKILL.md 변경 없음 — 건너뜀"
      fi
    else
      cp "$skill_src" "$SKILL_DIR/SKILL.md"
      log_success "Phase 7 완료: SKILL.md 설치됨 ($SKILL_DIR/)"
    fi
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
  if [ "$IS_UPGRADE" = true ]; then
    echo "  zime-memory 업그레이드 완료"
  else
    echo "  zime-memory 설치 완료"
  fi
  echo "========================================="
  echo ""
  echo "  설치 위치:      $absolute_install_dir"
  echo "  Qdrant URL:     $QDRANT_URL"
  echo "  Ollama URL:     $OLLAMA_URL"
  echo "  임베딩 프로바이더: ollama (변경: EMBEDDING_PROVIDER=local|off)"
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
  echo "  Multi-Store MCP 메모리 서버"
  echo "  Qdrant + MinIO + SQLCipher + Ollama"
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
