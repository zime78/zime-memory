#!/usr/bin/env bash
# ============================================================================
# zime-memory 아카이브 생성 스크립트
# 소스코드 + install.sh + skill 파일을 tar.gz로 패키징
#
# 사용법: ./pack.sh
# 결과물: ~/zime-memory-installer.tar.gz
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT="$HOME/zime-memory-installer.tar.gz"

echo "[INFO] zime-memory 아카이브 생성 중..."

tar -czf "$OUTPUT" \
  -C "$(dirname "$SCRIPT_DIR")" \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='.git' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='data/secrets.db' \
  --exclude='data/secrets.db-shm' \
  --exclude='data/secrets.db-wal' \
  --exclude='data/safety-backups' \
  --exclude='.omc' \
  --exclude='.bkit' \
  --exclude='.claude' \
  --exclude='.DS_Store' \
  --exclude='scripts/*.log' \
  "$(basename "$SCRIPT_DIR")"

SIZE=$(du -h "$OUTPUT" | cut -f1)
echo "[OK]   아카이브 생성 완료: $OUTPUT ($SIZE)"
echo ""
echo "새 컴퓨터에서 설치:"
echo "  tar xzf zime-memory-installer.tar.gz"
echo "  cd zime-memory"
echo "  ./install.sh"
