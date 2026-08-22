#!/usr/bin/env bash
# Bootstrap da VM de produção do fluxa-services (Ubuntu 24.04+/EC2).
# Uso (na VM):  curl -fsSL https://raw.githubusercontent.com/diogoadmgo-source/fluxa-services/main/scripts/vm/bootstrap.sh | bash
# Idempotente: pode rodar de novo sem estragar nada.
set -euo pipefail
echo "» pacotes base"
sudo apt-get update -qq
sudo apt-get install -y -qq ca-certificates curl git unzip >/dev/null
if ! command -v docker >/dev/null 2>&1; then
  echo "» instalando Docker"
  curl -fsSL https://get.docker.com | sudo sh >/dev/null
fi
sudo usermod -aG docker "$USER"
if [ ! -d "$HOME/fluxa-services/.git" ]; then
  echo "» clonando fluxa-services"
  git clone -q https://github.com/diogoadmgo-source/fluxa-services.git "$HOME/fluxa-services"
else
  echo "» atualizando fluxa-services"
  git -C "$HOME/fluxa-services" pull -q --ff-only
fi
mkdir -p "$HOME/rtc-calc"
echo
echo "PRONTO."
echo "  Docker:  $(docker --version 2>/dev/null || echo 'saia e entre de novo (exit + ssh) para usar sem sudo')"
echo "  Repo:    $HOME/fluxa-services"
echo "  Próximo: copiar calculadora.tar.gz para $HOME/rtc-calc/ e rodar scripts/vm/deploy.sh"
