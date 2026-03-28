#!/bin/bash
# zime-memory SSH 원격 백업 스크립트
# 시크릿(secrets.db) + 암호화 키(.env) + 안전 백업을 원격 호스트에 rsync로 백업한다.
# 순수 백업 2중화 목적 — 원격지에서 데이터를 운영하지 않는다.
#
# 사전 조건: rsync 설치, SSH 키 인증 설정 (ssh mac 접속 가능)
#
# 사용법:
#   ./scripts/ssh-backup.sh              # 백업 실행
#   ./scripts/ssh-backup.sh status       # 원격 백업 상태 조회
#   ./scripts/ssh-backup.sh list         # 원격 스냅샷 목록
#   ./scripts/ssh-backup.sh restore <snapshot>  # 원격 스냅샷 복원

set -e

# .env에서 환경변수 로드 (스크립트 위치 기준)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="${SCRIPT_DIR}/.."
ENV_FILE="${PROJECT_DIR}/.env"
if [ -f "$ENV_FILE" ]; then
  set -a; source "$ENV_FILE" 2>/dev/null; set +a
fi

# 설정
SSH_HOST="${SSH_BACKUP_HOST:-${ZIME_SSH_HOST:?SSH_BACKUP_HOST 또는 ZIME_SSH_HOST 환경변수를 설정하세요}}"
REMOTE_PATH="${SSH_BACKUP_PATH:-~/zime-memory-backup}"
MAX_SNAPSHOTS="${SSH_BACKUP_MAX_SNAPSHOTS:-20}"
DB_PATH="${PROJECT_DIR}/data/secrets.db"
SAFETY_DIR="${PROJECT_DIR}/data/safety-backups"

# SSH 연결 확인 함수
check_ssh() {
  if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "${SSH_HOST}" "echo ok" > /dev/null 2>&1; then
    echo "[ssh-backup] SSH 연결 실패: ${SSH_HOST}"
    echo "  SSH 키 인증이 설정되어 있는지 확인하세요."
    exit 1
  fi
}

case "${1:-start}" in
  start)
    echo "[ssh-backup] 원격 백업 시작 (${SSH_HOST}:${REMOTE_PATH})"

    # 1. SSH 연결 확인
    check_ssh

    # 2. secrets.db 존재 확인
    if [ ! -f "$DB_PATH" ]; then
      echo "[ssh-backup] secrets.db가 존재하지 않습니다: ${DB_PATH}"
      exit 1
    fi

    # 3. 원격 디렉토리 생성
    ssh "${SSH_HOST}" "mkdir -p ${REMOTE_PATH}/{current,safety-backups,snapshots}"

    # 4. rsync 전송 — 최신 DB + .env
    rsync -az \
      "$DB_PATH" "$ENV_FILE" \
      "${SSH_HOST}:${REMOTE_PATH}/current/"
    ssh "${SSH_HOST}" "chmod 600 ${REMOTE_PATH}/current/*"
    echo "[ssh-backup] current/ 동기화 완료 (secrets.db + .env)"

    # 5. safety-backups 동기화
    if [ -d "$SAFETY_DIR" ]; then
      rsync -az --delete \
        "${SAFETY_DIR}/" \
        "${SSH_HOST}:${REMOTE_PATH}/safety-backups/"
      echo "[ssh-backup] safety-backups/ 동기화 완료"
    fi

    # 6. 타임스탬프 스냅샷 생성 (원격에서 실행)
    TIMESTAMP=$(date +%Y-%m-%dT%H-%M-%S)
    ssh "${SSH_HOST}" "cp ${REMOTE_PATH}/current/secrets.db ${REMOTE_PATH}/snapshots/secrets_${TIMESTAMP}.db && chmod 600 ${REMOTE_PATH}/snapshots/secrets_${TIMESTAMP}.db"
    echo "[ssh-backup] 스냅샷 생성: secrets_${TIMESTAMP}.db"

    # 7. 오래된 스냅샷 프루닝 (최근 N개 유지)
    PRUNED=$(ssh "${SSH_HOST}" "cd ${REMOTE_PATH}/snapshots && ls -1t *.db 2>/dev/null | tail -n +$((MAX_SNAPSHOTS + 1)) | xargs -r rm -v 2>&1 | wc -l")
    if [ "$PRUNED" -gt 0 ] 2>/dev/null; then
      echo "[ssh-backup] 스냅샷 프루닝: ${PRUNED}개 삭제 (최대 ${MAX_SNAPSHOTS}개 유지)"
    fi

    # 8. 결과 요약
    REMOTE_SIZE=$(ssh "${SSH_HOST}" "du -sh ${REMOTE_PATH} 2>/dev/null | cut -f1")
    SNAP_COUNT=$(ssh "${SSH_HOST}" "ls -1 ${REMOTE_PATH}/snapshots/*.db 2>/dev/null | wc -l")
    echo ""
    echo "[ssh-backup] 백업 완료"
    echo "  호스트:      ${SSH_HOST}"
    echo "  경로:        ${REMOTE_PATH}"
    echo "  스냅샷 수:   ${SNAP_COUNT}개"
    echo "  총 용량:     ${REMOTE_SIZE}"
    ;;

  status)
    check_ssh
    echo "[ssh-backup] 원격 백업 상태 (${SSH_HOST}:${REMOTE_PATH})"
    echo ""

    # 디렉토리 존재 확인
    if ! ssh "${SSH_HOST}" "[ -d ${REMOTE_PATH} ]" 2>/dev/null; then
      echo "  상태: 백업 없음 (디렉토리 미존재)"
      exit 0
    fi

    # 최신 백업 시각
    LATEST=$(ssh "${SSH_HOST}" "ls -1t ${REMOTE_PATH}/snapshots/*.db 2>/dev/null | head -1 | xargs basename 2>/dev/null" || echo "없음")
    SNAP_COUNT=$(ssh "${SSH_HOST}" "ls -1 ${REMOTE_PATH}/snapshots/*.db 2>/dev/null | wc -l" || echo "0")
    SAFETY_COUNT=$(ssh "${SSH_HOST}" "ls -1 ${REMOTE_PATH}/safety-backups/*.db 2>/dev/null | wc -l" || echo "0")
    REMOTE_SIZE=$(ssh "${SSH_HOST}" "du -sh ${REMOTE_PATH} 2>/dev/null | cut -f1" || echo "알 수 없음")
    CURRENT_SIZE=$(ssh "${SSH_HOST}" "ls -lh ${REMOTE_PATH}/current/secrets.db 2>/dev/null | awk '{print \$5}'" || echo "없음")

    echo "  최신 스냅샷:   ${LATEST}"
    echo "  스냅샷 수:     ${SNAP_COUNT}개"
    echo "  안전 백업 수:  ${SAFETY_COUNT}개"
    echo "  현재 DB 크기:  ${CURRENT_SIZE}"
    echo "  총 용량:       ${REMOTE_SIZE}"
    ;;

  list)
    check_ssh
    echo "[ssh-backup] 원격 스냅샷 목록 (${SSH_HOST}:${REMOTE_PATH}/snapshots/)"
    echo ""
    ssh "${SSH_HOST}" "ls -lh ${REMOTE_PATH}/snapshots/*.db 2>/dev/null | awk '{print \$NF, \$5}' | sed 's|.*/||'" || echo "  스냅샷 없음"
    ;;

  restore)
    SNAPSHOT="${2}"
    if [ -z "$SNAPSHOT" ]; then
      echo "사용법: $0 restore <snapshot_filename>"
      echo "  스냅샷 목록 확인: $0 list"
      exit 1
    fi

    check_ssh

    # 원격 스냅샷 존재 확인
    if ! ssh "${SSH_HOST}" "[ -f ${REMOTE_PATH}/snapshots/${SNAPSHOT} ]" 2>/dev/null; then
      echo "[ssh-backup] 스냅샷을 찾을 수 없습니다: ${SNAPSHOT}"
      echo "  '$0 list'로 사용 가능한 스냅샷을 확인하세요."
      exit 1
    fi

    # 복원 확인 프롬프트
    echo "[ssh-backup] 복원 대상: ${SNAPSHOT}"
    echo "  주의: 현재 secrets.db를 덮어씁니다."
    echo "  (로컬 safety-backup이 자동 생성됩니다.)"
    read -p "  계속하시겠습니까? (yes/no): " CONFIRM
    if [ "$CONFIRM" != "yes" ]; then
      echo "  복원 취소됨."
      exit 0
    fi

    # 로컬 safety-backup 생성
    if [ -f "$DB_PATH" ]; then
      BACKUP_NAME="secrets_pre-remote-restore_$(date +%Y-%m-%dT%H-%M-%S).db"
      mkdir -p "$SAFETY_DIR"
      cp "$DB_PATH" "${SAFETY_DIR}/${BACKUP_NAME}"
      echo "[ssh-backup] 로컬 safety-backup 생성: ${BACKUP_NAME}"
    fi

    # 원격 스냅샷 → 로컬 복원
    rsync -az "${SSH_HOST}:${REMOTE_PATH}/snapshots/${SNAPSHOT}" "$DB_PATH"
    chmod 600 "$DB_PATH"
    echo "[ssh-backup] 복원 완료: ${SNAPSHOT} → ${DB_PATH}"
    ;;

  *)
    echo "사용법: $0 {start|status|list|restore <snapshot>}"
    exit 1
    ;;
esac
