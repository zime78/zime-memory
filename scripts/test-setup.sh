#!/bin/bash
# zime-memory 테스트 데이터 자동 생성 스크립트
# 사용법: bash scripts/test-setup.sh [setup|cleanup|status]
#
# setup   - 테스트 파일 생성 + Docker 서비스 확인
# cleanup - 테스트 파일 삭제
# status  - 서비스 상태 + 테스트 파일 존재 여부 확인

set -euo pipefail

TEST_DIR="/tmp/zime-memory-test"
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

log_ok()   { echo -e "${GREEN}✅ $1${NC}"; }
log_fail() { echo -e "${RED}❌ $1${NC}"; }
log_info() { echo -e "${YELLOW}ℹ️  $1${NC}"; }

# ─── 테스트 파일 생성 ───
setup_files() {
  echo "=== 테스트 데이터 생성 ==="
  mkdir -p "$TEST_DIR"

  # 1. 1x1 PNG (67 bytes) — Phase 2 images store 테스트
  printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82' > "$TEST_DIR/test-image.png"
  log_ok "test-image.png ($(wc -c < "$TEST_DIR/test-image.png" | tr -d ' ') bytes)"

  # 2. 10x10 JPEG placeholder (683 bytes) — Phase 8 images update 테스트
  # JFIF 최소 헤더 + 10x10 픽셀 데이터
  python3 -c "
import struct, zlib
# 최소 유효 JPEG: SOI + APP0(JFIF) + DQT + SOF0 + DHT + SOS + EOI
# 간단히 Pillow 없이 바이너리로 생성
data = bytes([
  0xFF, 0xD8,  # SOI
  0xFF, 0xE0,  # APP0
  0x00, 0x10,  # Length 16
  0x4A, 0x46, 0x49, 0x46, 0x00,  # JFIF\0
  0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xFF, 0xD9   # EOI
])
with open('$TEST_DIR/test-image-update.jpeg', 'wb') as f:
    f.write(data)
" 2>/dev/null
  log_ok "test-image-update.jpeg ($(wc -c < "$TEST_DIR/test-image-update.jpeg" | tr -d ' ') bytes)"

  # 3. JSON 설정 파일 (90 bytes) — Phase 3 files store 테스트
  echo '{"compilerOptions":{"target":"ES2022","module":"ESNext","strict":true},"include":["src"]}' > "$TEST_DIR/test-config.json"
  log_ok "test-config.json ($(wc -c < "$TEST_DIR/test-config.json" | tr -d ' ') bytes)"

  # 4. ZIP 아카이브 (테스트용 작은 zip) — Phase 8 files update 테스트
  echo "test content for zip archive" > "$TEST_DIR/_zip_content.txt"
  (cd "$TEST_DIR" && zip -q test-archive.zip _zip_content.txt && rm _zip_content.txt)
  log_ok "test-archive.zip ($(wc -c < "$TEST_DIR/test-archive.zip" | tr -d ' ') bytes)"

  # 5. 51MB 더미 파일 — T25 파일 크기 제한 테스트
  dd if=/dev/zero of="$TEST_DIR/test-51mb.bin" bs=1048576 count=51 2>/dev/null
  log_ok "test-51mb.bin ($(du -h "$TEST_DIR/test-51mb.bin" | cut -f1))"

  # 6. 텍스트 파일 (일반 문서) — export/import 왕복 테스트
  cat > "$TEST_DIR/test-document.txt" << 'EOF'
zime-memory v2.1.0 테스트 문서
이 파일은 자동화 테스트에 사용되는 샘플 문서입니다.
Tool Registry, Store 분리, Zod 환경변수 검증이 적용되었습니다.
EOF
  log_ok "test-document.txt ($(wc -c < "$TEST_DIR/test-document.txt" | tr -d ' ') bytes)"

  echo ""
  echo "=== 생성된 파일 목록 ==="
  ls -lh "$TEST_DIR"/ | grep -v "^total"
  echo ""
  log_info "테스트 디렉토리: $TEST_DIR"
}

# ─── 서비스 상태 확인 ───
check_services() {
  echo "=== 서비스 헬스 체크 ==="

  # Qdrant
  if curl -sf http://localhost:6333/healthz >/dev/null 2>&1; then
    log_ok "Qdrant (localhost:6333)"
  else
    log_fail "Qdrant (localhost:6333) — docker compose up -d"
  fi

  # MinIO
  if curl -sf http://localhost:9000/minio/health/live >/dev/null 2>&1; then
    log_ok "MinIO (localhost:9000)"
  else
    log_fail "MinIO (localhost:9000) — docker compose up -d"
  fi

  # Ollama
  if curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
    log_ok "Ollama (localhost:11434)"
  else
    log_fail "Ollama (localhost:11434) — ollama serve"
  fi

  # 임베딩 모델
  if curl -sf http://localhost:11434/api/tags 2>/dev/null | grep -q "bge-m3"; then
    log_ok "Ollama 모델: bge-m3"
  else
    log_fail "Ollama 모델: bge-m3 — ollama pull bge-m3"
  fi
}

# ─── 테스트 파일 정리 ───
cleanup_files() {
  echo "=== 테스트 데이터 정리 ==="
  if [ -d "$TEST_DIR" ]; then
    rm -rf "$TEST_DIR"
    log_ok "테스트 디렉토리 삭제됨: $TEST_DIR"
  else
    log_info "테스트 디렉토리 없음 (이미 정리됨)"
  fi
}

# ─── 상태 확인 ───
check_status() {
  check_services
  echo ""
  echo "=== 테스트 파일 상태 ==="
  if [ -d "$TEST_DIR" ]; then
    local count
    count=$(ls -1 "$TEST_DIR" 2>/dev/null | wc -l | tr -d ' ')
    log_ok "테스트 디렉토리 존재: $TEST_DIR ($count 파일)"
    ls -lh "$TEST_DIR"/ 2>/dev/null | grep -v "^total"
  else
    log_info "테스트 디렉토리 없음 — bash scripts/test-setup.sh setup"
  fi
}

# ─── 메인 ───
case "${1:-status}" in
  setup)
    check_services
    echo ""
    setup_files
    ;;
  cleanup)
    cleanup_files
    ;;
  status)
    check_status
    ;;
  *)
    echo "사용법: $0 [setup|cleanup|status]"
    exit 1
    ;;
esac
