# fluxa-services

Workers do FLUXA / TECH-IVA. É a **metade que não vive no Lovable**: tudo que é pesado,
demorado ou fala com sistema externo (Receita, SEFAZ, banco, FIDC).

O app (Lovable + Supabase) **enfileira** jobs; estes workers **executam** e escrevem
o resultado de volta no mesmo Postgres, com `service_role`.

```
[Lovable/Supabase] --insert em jobs--> [fila no Postgres] --claim_job--> [workers]
        ^                                                                    |
        +------------------ escrita com service_role ------------------------+
```

## Por que fora do Lovable

Ingestão de 50 mil XMLs, calculadora oficial da Receita rodando offline em container
próprio e retentativa com backoff não cabem em edge function. O front nunca fala com
a Receita, com a SEFAZ nem com o motor de crédito — só com o banco.

## Serviços

| Worker | Job | O que faz |
|---|---|---|
| `ingest-dfe` | `ingest_dfe` | Baixa DF-e, guarda XML bruto no Storage, materializa notas/itens/recebíveis, detecta CST × cClassTrib inconsistente. Idempotente pela chave de acesso. |
| `classify-chain` | `classify_chain` | Descobre o regime de cada CNPJ da cadeia, define `credit_transfer_pct`, alerta em mudança de regime. Nunca sobrescreve regime definido manualmente. |
| `compute-taxes` | `compute_taxes` | Chama a Calculadora RTC item a item, grava memória de cálculo e carimba `rule_version_id`. |
| `project-cash` | `project_cash` | Gera `tax_cash_events` do horizonte de 120 dias. É o que alimenta o Caixa do Imposto. |

## A regra que mais importa no `project-cash`

Projetar imposto apenas das notas **já emitidas** subestima o futuro e faz a tela
mostrar folga onde existe aperto. A empresa continua vendendo, e cada venda futura
carrega IBS/CBS que sai no recebimento. O projetor soma três fontes:

1. `tax_out` dos recebíveis emitidos e não pagos, na data esperada de recebimento;
2. `tax_out` **projetado** pelo run-rate (média semanal das vendas dos últimos 90 dias);
3. `credit_in` das compras, com retorno em 150–180 dias.

A confiança decai com a distância da data — é ela que desenha a banda do gráfico.

## Contrato de fila

- `claim_job(kinds, worker, lease)` — pega um job com `FOR UPDATE SKIP LOCKED`.
  **Um job por tenant+kind por vez**: um cliente com 50 mil notas não trava os outros.
  Job órfão (lease vencido) é retomado automaticamente.
- `report_job(job, status, progress, message, result, error)` — progresso e conclusão.
  Em falha, o banco reenfileira com backoff (30s, 2min, 10min, 1h, 6h) até 5 tentativas
  e só então marca `failed` e cria alerta.

Ambas só são executáveis por `service_role`.

## Rodar

```bash
cp .env.example .env      # preencher SUPABASE_SERVICE_ROLE_KEY
npm install
npm run dev               # worker em watch
npm run run:once -- project_cash <tenant_id>   # enfileira um job avulso
```

Produção: `docker compose up -d` (dois workers + container da calculadora).

## O que falta implementar

Três funções estão marcadas e lançam erro explícito em vez de devolver dado falso:

- `adapters/dfe.ts → fetchXmlBatch` — conectar à distribuição DF-e com o certificado
  A1 do tenant (guardado cifrado em `integrations.dfe_auth`) e paginar por NSU.
  O **parser já é real** e funciona sobre qualquer XML que chegue.
- `workers/classify-chain.ts → lookupRegime` — consulta de regime por CNPJ, com cache
  global de 30 dias (a mesma empresa aparece na cadeia de centenas de clientes).
- `adapters/rtc-calc.ts` — **implementado com o contrato real** do componente offline
  (`POST /api/calculadora/regime-geral`, `validar-xml`, `dados-abertos/*`). Exige o container
  no ar (`scripts/rtc-calc/README.md`); sem `RTC_CALC_URL` lança `EngineUnavailableError`.
  O stub de 18% só liga com `RTC_CALC_ALLOW_STUB=1` fora de produção. Falta apenas
  confirmar contra o Swagger da versão instalada os campos opcionais (`impostoSeletivo`,
  `tributacaoRegular`, `gRed`) — o núcleo `gIBSCBS` está aderente à documentação.

## Segurança

`SUPABASE_SERVICE_ROLE_KEY` ignora RLS. Não vai para o front, não vai para o repositório,
não vai para log. Toda query daqui carrega `tenant_id` explícito — a proteção do banco
some neste processo, a disciplina não pode sumir.
