#!/usr/bin/env bash
# Auto-deploy: puxa o main e, SÓ SE mudou, reconstrói e reinicia os serviços.
# Chamado pelo timer systemd techiva-deploy.timer (a cada 5 min).
set -euo pipefail
cd /home/ubuntu/fluxa-services
ANTES=$(git rev-parse HEAD)
git fetch -q origin main
DEPOIS=$(git rev-parse origin/main)
[ "$ANTES" = "$DEPOIS" ] && exit 0
echo "$(date -Is) deploy $ANTES -> $DEPOIS"
git reset --hard origin/main
# --no-cache: o COPY src não invalida camada de forma confiável quando só o conteúdo muda
docker compose build --no-cache worker-ingest worker-pipeline
docker compose up -d --force-recreate worker-ingest worker-pipeline
docker image prune -f >/dev/null 2>&1 || true
echo "$(date -Is) deploy concluído"
