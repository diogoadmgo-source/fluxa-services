import { db } from "../lib/supabase.js";
import { progress, enqueue, type Job } from "../lib/jobs.js";
import { parseNFe, type ParsedInvoice } from "../adapters/dfe.js";

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
 * Fonte dos XMLs. Deve ser um STREAM, não um array: um cliente com 100 mil notas
 * não cabe na memória do worker de uma vez.
 *
 * TODO(produção): distribuição DF-e paginada por NSU, autenticada com o
 * certificado A1 do tenant (guardado cifrado, referenciado por
 * integration_credentials.secret_ref) ou pela procuração eletrônica. Guardar o
 * XML bruto no Storage em dfe/{tenant}/{aaaa-mm}/{chave}.xml antes de parsear —
 * o XML é a prova documental e precisa sobreviver a qualquer mudança nossa.
 */
async function* fetchXmlStream(
  _job: Job, _desde: number
): AsyncGenerator<{ xml: string; path: string; total: number }> {
  throw new Error(
    "fetchXmlStream não implementado: conectar à distribuição DF-e com o certificado " +
    "do tenant (integration_credentials, provider='dfe') e paginar por NSU");
}
