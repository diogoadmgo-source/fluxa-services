# svc-calc — Calculadora de Tributos da RFB em container

A Receita não hospeda API de cálculo. O motor oficial é o **componente offline**
(imagem Docker ou JAR Java 21), distribuído em https://consumo.tributos.gov.br → Calcular
Tributos sobre Consumo → Calculadora offline (login gov.br). Este diretório só o **importa**
e **tagueia**; não construímos nada nosso por cima.

## Uma vez por versão do motor
1. Baixe o pacote Docker (zip ~260 MB) e extraia; o que interessa é `calculadora.tar.gz`.
2. `./scripts/rtc-calc/import.sh /caminho/calculadora.tar.gz` (Linux/Mac) ou
   `.\scripts\rtc-calc\import.ps1 -Tar "C:\...\calculadora.tar.gz"` (Windows).
   O script importa, sobe, lê `dados-abertos/versao` e cria `techiva/rtc-calc:<versão>`.
3. Coloque `RTC_CALC_VERSION=<versão>` no `.env` **e** publique a mesma string em
   `rule_versions.calc_version` (painel da plataforma → Regras fiscais). O worker
   `compute_taxes` se recusa a rodar se as três (env, motor, rule_version) não baterem.

## Subir
- Produção: `docker compose up -d` (a calculadora fica só na rede interna).
- Dev: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d rtc-calc`
  expõe :8080 (API + Swagger em http://localhost:8080/api), :8081 (split simplificado), :80 (site).

## Endpoints usados por `src/adapters/rtc-calc.ts`
POST `/api/calculadora/regime-geral` · POST `/api/calculadora/validar-xml?tipo=nfe&subtipo=grupo`
· GET `/api/calculadora/dados-abertos/{versao,classificacoes-tributarias/cbs-ibs,…}`.
