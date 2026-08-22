#!/usr/bin/env bash
# Instala o auto-deploy (roda UMA vez, na VM):
#   bash ~/fluxa-services/scripts/vm/install-autodeploy.sh
set -euo pipefail
chmod +x /home/ubuntu/fluxa-services/scripts/vm/autodeploy.sh
sudo tee /etc/systemd/system/techiva-deploy.service >/dev/null <<'UNIT'
[Unit]
Description=TechIVA auto-deploy (git pull + rebuild quando o main muda)
After=docker.service
[Service]
Type=oneshot
User=ubuntu
WorkingDirectory=/home/ubuntu/fluxa-services
ExecStart=/home/ubuntu/fluxa-services/scripts/vm/autodeploy.sh
UNIT
sudo tee /etc/systemd/system/techiva-deploy.timer >/dev/null <<'UNIT'
[Unit]
Description=Verifica atualizacoes do TechIVA a cada 5 minutos
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Unit=techiva-deploy.service
[Install]
WantedBy=timers.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now techiva-deploy.timer
echo
echo "OK — auto-deploy instalado."
systemctl list-timers techiva-deploy.timer --no-pager || true
echo
echo "Acompanhar:  journalctl -u techiva-deploy -f"
