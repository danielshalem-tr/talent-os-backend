#!/bin/bash
# deploy.sh — Manual production deployment script
#
# Usage:
#   ./scripts/deploy.sh [branch]
#   ./scripts/deploy.sh main          # Deploy main branch (default)
#   ./scripts/deploy.sh feature/xyz   # Deploy feature branch to staging
#
# Prerequisites:
#   - PROD_HOST environment variable set: export PROD_HOST=ubuntu@your.server.ip
#   - SSH key configured for PROD_HOST
#   - docker-compose.yml present on remote at ~/triolla/
#
# This script does NOT run migrations. Run 'make migrate-prod' separately if needed.
# D-07: Migrations are always a manual human action, never automatic.

set -euo pipefail

BRANCH="${1:-main}"
REMOTE_DIR="${REMOTE_DIR:-~/triolla}"

if [[ -z "${PROD_HOST:-}" ]]; then
  echo "ERROR: PROD_HOST is not set."
  echo "Usage: PROD_HOST=ubuntu@server.ip ./scripts/deploy.sh [branch]"
  exit 1
fi

echo "Deploying branch '$BRANCH' to $PROD_HOST..."
echo ""

ssh "$PROD_HOST" "
  set -euo pipefail
  cd $REMOTE_DIR
  echo 'Pulling latest code...'
  git fetch origin
  git checkout $BRANCH
  git pull origin $BRANCH
  echo 'Rebuilding and restarting containers...'
  docker compose -f docker-compose.yml up -d --build
  echo 'Deployment complete.'
  docker compose -f docker-compose.yml ps
"

echo ""
echo "Deployment of '$BRANCH' to $PROD_HOST complete."
echo "Check logs: ssh $PROD_HOST 'cd $REMOTE_DIR && docker compose logs -f'"
