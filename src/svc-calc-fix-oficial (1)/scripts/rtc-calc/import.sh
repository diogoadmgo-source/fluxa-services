#!/usr/bin/env bash
# Importa o componente offline da Calculadora RFB (calculadora.tar.gz) como imagem
# Docker e a tagueia com a versão que o motor declara. Roda uma vez por versão.
#   ./scripts/rtc-calc/import.sh /caminho/para/calculadora.tar.gz
set -euo pipefail
TAR="${1:?uso: import.sh /caminho/calculadora.tar.gz}"
[ -f "$TAR" ] || { echo "arquivo não encontrado: $TAR"; exit 1; }

echo "» importando rootfs (pode levar alguns minutos, ~1 GB)…"
docker import "$TAR" techiva/rtc-calc:candidate >/dev/null

echo "» subindo temporariamente para ler a versão…"
CID=$(docker run -d --rm -p 18080:8080 -w /calculadora techiva/rtc-calc:candidate bash start.sh)
trap 'docker stop "$CID" >/dev/null 2>&1 || true' EXIT
for i in $(seq 1 60); do
  if VER=$(curl -fsS http://localhost:18080/api/calculadora/dados-abertos/versao 2>/dev/null); then break; fi
  sleep 3
done
[ -n "${VER:-}" ] || { echo "motor não respondeu em 3 min; veja: docker logs $CID"; exit 1; }
# VersaoOutput oficial: { versaoApp, versaoDb, ... } → identidade = versaoApp-dbVersaoDb (tag Docker nao aceita +)
APP=$(echo "$VER" | sed -nE 's/.*"versaoApp"\s*:\s*"([^"]+)".*/\1/p')
DB=$(echo "$VER" | sed -nE 's/.*"versaoDb"\s*:\s*"([^"]+)".*/\1/p')
if [ -n "$APP" ] && [ -n "$DB" ]; then VERSAO="${APP}-db${DB}"; else VERSAO="${APP:-$(echo "$VER" | tr -d '"')}"; fi
echo "» versão declarada pelo motor: $VERSAO"
docker tag techiva/rtc-calc:candidate "techiva/rtc-calc:${VERSAO}"
docker tag techiva/rtc-calc:candidate techiva/rtc-calc:latest
docker rmi techiva/rtc-calc:candidate >/dev/null
echo
echo "OK. Agora coloque no .env:   RTC_CALC_VERSION=${VERSAO}"
echo "e registre a mesma versão em rule_versions.calc_version (painel da plataforma → Regras fiscais)."
