#!/bin/bash
# zime-memory SSH 터널 스크립트
# Mac Mini Docker 서비스(Qdrant, MinIO, Ollama)에 SSH 터널을 설정한다.
# 사전 조건: autossh 설치 (brew install autossh), SSH 키 인증 설정
#
# 사용법:
#   ./scripts/ssh-tunnel.sh          # 터널 시작
#   ./scripts/ssh-tunnel.sh stop     # 터널 중지
#   ./scripts/ssh-tunnel.sh status   # 터널 상태 확인

set -e

SSH_HOST="${ZIME_SSH_HOST:?ZIME_SSH_HOST 환경변수를 설정하세요 (예: .env에 ZIME_SSH_HOST=your-server)}"
TUNNEL_PORTS=(
  "6333:localhost:6333"   # Qdrant REST API
  "6334:localhost:6334"   # Qdrant gRPC
  "9000:localhost:9000"   # MinIO API
  "9001:localhost:9001"   # MinIO Console
  "11434:localhost:11434" # Ollama
)

case "${1:-start}" in
  start)
    # 이미 실행 중인지 확인
    if pgrep -f "autossh.*6333.*${SSH_HOST}" > /dev/null 2>&1; then
      echo "[zime-memory] SSH 터널이 이미 실행 중입니다."
      exit 0
    fi

    PORT_ARGS=""
    for port in "${TUNNEL_PORTS[@]}"; do
      PORT_ARGS="${PORT_ARGS} -L ${port}"
    done

    autossh -M 0 -f -N \
      -o "ServerAliveInterval=30" \
      -o "ServerAliveCountMax=3" \
      -o "ExitOnForwardFailure=yes" \
      -o "ConnectTimeout=10" \
      ${PORT_ARGS} \
      "${SSH_HOST}"

    echo "[zime-memory] SSH 터널 시작 완료 (${SSH_HOST})"
    echo "  Qdrant:  localhost:6333"
    echo "  MinIO:   localhost:9000"
    echo "  Ollama:  localhost:11434"
    ;;

  stop)
    pkill -f "autossh.*6333.*${SSH_HOST}" 2>/dev/null && \
      echo "[zime-memory] SSH 터널 중지 완료" || \
      echo "[zime-memory] 실행 중인 터널 없음"
    ;;

  status)
    if pgrep -f "autossh.*6333.*${SSH_HOST}" > /dev/null 2>&1; then
      echo "[zime-memory] SSH 터널: 실행 중"
      echo "  Qdrant:  $(curl -s -o /dev/null -w '%{http_code}' http://localhost:6333/healthz 2>/dev/null || echo 'unreachable')"
      echo "  MinIO:   $(curl -s -o /dev/null -w '%{http_code}' http://localhost:9000/minio/health/live 2>/dev/null || echo 'unreachable')"
      echo "  Ollama:  $(curl -s -o /dev/null -w '%{http_code}' http://localhost:11434/api/tags 2>/dev/null || echo 'unreachable')"
    else
      echo "[zime-memory] SSH 터널: 중지됨"
    fi
    ;;

  *)
    echo "사용법: $0 {start|stop|status}"
    exit 1
    ;;
esac
