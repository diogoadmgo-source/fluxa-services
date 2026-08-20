import { db } from "../lib/supabase.js";
import { progress, enqueue, type Job } from "../lib/jobs.js";
import { parseNFe, type ParsedInvoice } from "../adapters/dfe.js";
import { distDFe, manifestarCiencia, chaveDoResumo, ConsumoIndevidoError } from "../adapters/dfe-distribuicao.js";
import { certificadoParaPem } from "../lib/secrets.js";
import { log } from "../lib/log.js";

/**
 * svc-ingest — baixa DF-e, guarda o XML bruto e materializa notas, itens e parcelas.
 *
 * REESCRITO PARA VOLUME (18/08/2026). A versão anterior fazia um upsert por nota,
 * um por conjunto de itens e um por parcela: para 100 mil notas seriam cerca de
 * 500 mil chamadas HTTP — horas de execução, e com o agravante de que, se o job
 * morresse no meio, o cliente ficava com metade da operação carregada.
 *
 * Agora o lote inteiro (cabeçalho + itens + parcelas) vai numa única chamada e o
 * banco resolve em três instruções, dentro de uma transação. Idempotente pela
 * chave de acesso: reprocessar o mesmo lote não duplica nada — testado.
 *
 * Tamanho do lote: 500 notas. Grande o bastante para diluir a latência de rede,
 * pequeno o bastante para o progresso avançar visivelmente e para uma falha
 * custar pouco retrabalho.
 */
const BATCH = 500;

export async function ingestDfe(job: Job) {
  const tenant = job.tenant_id;
  const { data: t } = await db.from("tenants").select("cnpj").eq("id", tenant).single();
  const ownCnpj = t?.cnpj ?? "";

  await progress(job.id, 2, "Verificando o que já foi ingerido");

  // Retomada: se este tenant já tem notas, não recomeçamos do zero.
  const { data: checkpoint } = await db.rpc("ingest_checkpoint", { p_tenant: tenant });
  const jaIngeridas = Number((checkpoint as any)?.total ?? 0);

  await progress(job.id, 5, jaIngeridas > 0
    ? `Retomando (${jaIngeridas} notas já ingeridas)`
    : "Iniciando a primeira carga");

  const totais = { notas: 0, itens: 0, parcelas: 0, contrapartes: 0, inconsistentes: 0, ignoradas: 0 };
  const problemas: string[] = [];
  let lote: Array<Record<string, unknown>> = [];
  let processados = 0;

  const enviarLote = async () => {
    if (lote.length === 0) return;
    const { data, error } = await db.rpc("ingest_invoices_batch", { p_tenant: tenant, p_batch: lote });
    if (error) throw error;
    const r = data as Record<string, number>;
    totais.notas += r.notas ?? 0;
    totais.itens += r.itens ?? 0;
    totais.parcelas += r.parcelas ?? 0;
    totais.contrapartes += r.contrapartes_novas ?? 0;
    totais.inconsistentes += r.com_inconsistencia ?? 0;
    lote = [];
  };

  for await (const { xml, path, total } of fetchXmlStream(job, jaIngeridas)) {
    try {
      const p: ParsedInvoice = parseNFe(xml, ownCnpj);
      lote.push({
        access_key: p.accessKey, direction: p.direction, model: p.model,
        number: p.number, series: p.series, issued_at: p.issuedAt,
        counterparty_cnpj: p.counterpartyCnpj, counterparty_name: p.counterpartyName,
        total_cents: p.totalCents,
        raw_xml_path: path,
        inconsistencies: p.inconsistencies.map((m) => ({ descricao: m })),
        items: p.items.map((it) => ({
          line: it.line, ncm: it.ncm, cst: it.cst, cclasstrib: it.cclasstrib,
          description: it.description, qty: it.qty, unit: it.unit,
          unit_price_cents: it.unitPriceCents, base_cents: it.baseCents,
        })),
        installments: p.installments.map((d) => ({
          due_date: d.dueDate, amount_cents: d.amountCents,
        })),
      });
    } catch (err) {
      // Uma nota mal formada não pode derrubar a carga inteira do cliente.
      totais.ignoradas++;
      if (problemas.length < 50) problemas.push(err instanceof Error ? err.message : String(err));
    }

    if (lote.length >= BATCH) {
      await enviarLote();
      processados += BATCH;
      await progress(job.id, Math.min(5 + (processados / Math.max(total, 1)) * 85, 90),
        `${processados} de ${total} documentos`);
    }
  }
  await enviarLote();

  await progress(job.id, 92, "Encadeando classificação, cálculo e projeção");

  // Cada etapa é um job próprio, com sua própria retentativa.
  await enqueue(tenant, "classify_chain");
  await enqueue(tenant, "compute_taxes");
  await enqueue(tenant, "project_cash");

  return { ...totais, problemas: problemas.slice(0, 20) };
}

/**
 * Fonte dos XMLs: NFeDistribuicaoDFe do Ambiente Nacional, autenticado com o
 * certificado A1 do PRÓPRIO TENANT (integration_credentials, provider='dfe',
 * finalidade 'ingest_dfe'). Paginação por NSU com estado em dfe_sync_state.
 *
 * O que cada schema vira:
 *  - procNFe*   → XML completo: guarda o bruto no Storage (dfe-raw) e ENTREGA ao parse;
 *  - resNFe*    → resumo de compra ainda não manifestada: registra em dfe_pending_manifest
 *                 e dispara Ciência da Operação (210210). O XML completo chega nos
 *                 próximos lotes da distribuição — a rodada seguinte o ingere.
 *  - resEvento* e procEventoNFe* → eventos (cancelamento, ciência confirmada…): apenas
 *                 registrados por enquanto.
 *
 * Regras do AN respeitadas: para quando cStat=137 (fim da fila) e NUNCA repete a
 * chamada com ultNSU==maxNSU (o AN pune com 656 por 1h — ConsumoIndevidoError
 * encerra a rodada com aviso, sem falhar o job).
 */
async function* fetchXmlStream(
  job: Job, _desde: number
): AsyncGenerator<{ xml: string; path: string; total: number }> {
  const tenant = job.tenant_id;

  const { data: t } = await db.from("tenants").select("cnpj, settings").eq("id", tenant).single();
  const cnpj = String(t?.cnpj ?? "").replace(/\D/g, "");
  if (!cnpj) throw new Error("Tenant sem CNPJ — impossível consultar a distribuição DF-e.");
  const ufAutor = Number(((t?.settings as any)?.uf_ibge) ?? 52);   // GO por padrão

  const { data: cred, error: eCred } = await db.from("integration_credentials")
    .select("id, secret_ref").eq("tenant_id", tenant).eq("provider", "dfe")
    .eq("kind", "certificado_a1").eq("status", "ativa")
    .contains("finalidades", ["ingest_dfe"])
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (eCred) throw eCred;
  if (!cred) throw new Error("Nenhum certificado A1 ativo com finalidade ingest_dfe para esta empresa. " +
    "Cadastre em Integrações → Credenciais.");

  const pem = await certificadoParaPem(cred.secret_ref);

  const { data: st } = await db.from("dfe_sync_state").select("ult_nsu").eq("tenant_id", tenant).maybeSingle();
  let ultNSU = String(st?.ult_nsu ?? "0");

  let paginas = 0;
  let vistos = { procNFe: 0, resNFe: 0, eventos: 0 };
  const pendentesCiencia: string[] = [];

  // Resumos de rodadas anteriores que ainda não foram manifestados entram de novo:
  // manifestação recusada ontem não pode significar compra perdida para sempre.
  const { data: antigos } = await db.from("dfe_pending_manifest")
    .select("chave").eq("tenant_id", tenant).is("manifestado_em", null).limit(500);
  for (const a of antigos ?? []) pendentesCiencia.push(String(a.chave));

  try {
    for (;;) {
      const page = await distDFe(pem, cnpj, ufAutor, ultNSU);
      paginas++;

      const totalEstimado = Math.max(Number(page.maxNSU) - Number(ultNSU), page.docs.length);

      for (const d of page.docs) {
        if (/^procNFe/i.test(d.schema)) {
          vistos.procNFe++;
          const chave = (d.xml.match(/Id="NFe(\d{44})"/)?.[1]) ?? d.nsu;
          const path = `dfe/${tenant}/${chave.slice(2, 6)}/${chave}.xml`;
          const { error: eUp } = await db.storage.from("dfe-raw")
            .upload(path, new Blob([d.xml], { type: "application/xml" }), { upsert: true });
          if (eUp) log.warn({ err: eUp.message, chave }, "não guardou o XML bruto (segue o parse)");
          yield { xml: d.xml, path, total: totalEstimado };
        } else if (/^resNFe/i.test(d.schema)) {
          vistos.resNFe++;
          const r = chaveDoResumo(d.xml);
          if (r?.chave) {
            pendentesCiencia.push(r.chave);
            const { error: ePend } = await db.from("dfe_pending_manifest").upsert(
              { tenant_id: tenant, chave: r.chave, emitente: r.emitente, valor_cents: Math.round(r.valor * 100) },
              { onConflict: "tenant_id,chave", ignoreDuplicates: true });
            if (ePend) log.warn({ err: ePend.message, chave: r.chave }, "resumo não registrado em dfe_pending_manifest");
          } else {
            log.warn({ nsu: d.nsu }, "resNFe sem chave extraível — guardando em dfe_events");
            await db.from("dfe_events").insert({ tenant_id: tenant, nsu: d.nsu, schema: d.schema, xml: d.xml })
              .then(({ error }) => { if (error && !/duplicate/i.test(error.message)) log.warn({ err: error.message }, "evento não registrado"); });
          }
        } else {
          vistos.eventos++;
          await db.from("dfe_events").insert({ tenant_id: tenant, nsu: d.nsu, schema: d.schema, xml: d.xml })
            .then(({ error }) => { if (error && !/duplicate/i.test(error.message)) log.warn({ err: error.message }, "evento não registrado"); });
        }
      }

      ultNSU = page.ultNSU;
      await db.from("dfe_sync_state").upsert(
        { tenant_id: tenant, ult_nsu: ultNSU, max_nsu: page.maxNSU, last_stat: page.cStat, synced_at: new Date().toISOString() },
        { onConflict: "tenant_id" });

      // fim da fila: 137 sem documentos, ou alcançamos o maxNSU
      if (page.cStat === 137 || page.docs.length === 0 || ultNSU >= page.maxNSU) break;
    }
  } catch (err) {
    if (err instanceof ConsumoIndevidoError) {
      log.warn({ motivo: err.xMotivo }, "AN pediu pausa (656) — rodada encerrada; a próxima retoma do NSU salvo");
    } else {
      throw err;
    }
  }

  log.info({ paginas, ...vistos, pendentes_ciencia: pendentesCiencia.length }, "distribuição consumida");

  // Ciência da Operação para liberar o XML completo das compras resumidas.
  // FALHA AQUI NÃO DERRUBA O JOB: o download já aconteceu e o estado está salvo;
  // as chaves ficam em dfe_pending_manifest e a próxima rodada tenta de novo.
  if (pendentesCiencia.length > 0) {
    try {
      const unicas = [...new Set(pendentesCiencia)];
      const res = await manifestarCiencia(pem, cnpj, unicas);
      const ok = res.filter((r) => [135, 136, 573].includes(r.cStat));
      for (const r of ok) {
        await db.from("dfe_pending_manifest").update({ manifestado_em: new Date().toISOString(), cstat: r.cStat })
          .eq("tenant_id", tenant).eq("chave", r.chave);
      }
      const falhas = res.filter((r) => ![135, 136, 573].includes(r.cStat));
      if (falhas.length > 0) log.warn({ exemplos: falhas.slice(0, 3) }, `${falhas.length} manifestações recusadas`);
      log.info({ manifestadas: ok.length }, "ciência da operação enviada — XMLs completos virão na próxima rodada");
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err), chaves: pendentesCiencia.length },
        "manifestação falhou — chaves preservadas em dfe_pending_manifest para a próxima rodada");
    }
  }

  await db.from("integration_credentials").update({ last_used_at: new Date().toISOString(), falhas_consecutivas: 0 })
    .eq("id", cred.id);
}
