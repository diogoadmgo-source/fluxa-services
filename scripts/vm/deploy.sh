#!/usr/bin/env bash
# Deploy/atualização do fluxa-services na VM. Roda DENTRO da VM, na pasta do repo.
#   ~/fluxa-services/scripts/vm/deploy.sh
# Pré-requisitos: .env preenchido; imagem techiva/rtc-calc importada (scripts/rtc-calc/import.sh).
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f .env ] || { echo "falta .env (copie de .env.example e preencha)"; exit 1; }
grep -q '^RTC_CALC_VERSION=.\+' .env || { echo "RTC_CALC_VERSION vazio no .env"; exit 1; }
grep -q '^SUPABASE_SERVICE_ROLE_KEY=.\+' .env || { echo "SUPABASE_SERVICE_ROLE_KEY vazio no .env"; exit 1; }
git pull -q --ff-only
docker compose up -d --build --remove-orphans
docker compose ps
