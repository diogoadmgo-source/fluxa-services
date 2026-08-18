# Importa o componente offline da Calculadora RFB (calculadora.tar.gz) como imagem
# Docker e a tagueia com a versão que o motor declara. Roda uma vez por versão.
#   .\scripts\rtc-calc\import.ps1 -Tar "C:\caminho\calculadora.tar.gz"
param([Parameter(Mandatory=$true)][string]$Tar)
$ErrorActionPreference = "Stop"
if (-not (Test-Path $Tar)) { throw "arquivo não encontrado: $Tar" }

Write-Host "» importando rootfs (pode levar alguns minutos, ~1 GB)…"
docker import $Tar techiva/rtc-calc:candidate | Out-Null

Write-Host "» subindo temporariamente para ler a versão…"
$cid = docker run -d --rm -p 18080:8080 -w /calculadora techiva/rtc-calc:candidate bash start.sh
try {
  $ver = $null
  for ($i = 0; $i -lt 60 -and -not $ver; $i++) {
    Start-Sleep -Seconds 3
    try { $ver = (Invoke-WebRequest -UseBasicParsing "http://localhost:18080/api/calculadora/dados-abertos/versao").Content } catch {}
  }
  if (-not $ver) { throw "motor não respondeu em 3 min; veja: docker logs $cid" }
  $versao = $ver
  try { $j = $ver | ConvertFrom-Json; if ($j.versao) { $versao = $j.versao } elseif ($j.version) { $versao = $j.version } } catch {}
  $versao = $versao.Trim('"').Trim()
  Write-Host "» versão declarada pelo motor: $versao"
  docker tag techiva/rtc-calc:candidate "techiva/rtc-calc:$versao"
  docker tag techiva/rtc-calc:candidate techiva/rtc-calc:latest
  docker rmi techiva/rtc-calc:candidate | Out-Null
  Write-Host ""
  Write-Host "OK. Agora coloque no .env:   RTC_CALC_VERSION=$versao"
  Write-Host "e registre a mesma versão em rule_versions.calc_version (painel da plataforma → Regras fiscais)."
} finally { docker stop $cid | Out-Null }
