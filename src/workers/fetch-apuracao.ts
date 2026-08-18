import { db } from "../lib/supabase.js";
import { progress, type Job } from "../lib/jobs.js";
import { env } from "../lib/env.js";
import { obterToken, solicitarApuracao, baixarApuracao } from "../adapters/rtc-apuracao.js";
import { abrirSegredo } from "../lib/secrets.js";

/**
 * svc-apuracao — traz da Receita a apuração assistida da CBS.
 *
 * Este worker faz DUAS coisas distintas, e é importante que sejam separadas:
 *
 *   modo "solicitar": pede a apuração e encerra. O tíquete de download NÃO vem
 *     na resposta — a Receita chama nosso webhook depois. Não adianta esperar.
 *
 *   modo "baixar": varre as solicitações cujo webhook já respondeu e busca o
 *     arquivo. Roda periodicamente, independente de quem pediu.
 *
 * Separar os modos evita o erro clássico de tentar aguardar de forma síncrona um
 * retorno que é assíncrono por contrato — e que pode demorar minutos.
 *
 * A COTA É DECIDIDA NO BANCO, não aqui. rtc_apuracao_solicitar() debita antes de
 * qualquer chamada externa e devolve "não permitido" com a mensagem pronta. Se a
 * decisão estivesse neste código, duas instâncias do worker rodando ao mesmo
 * tempo poderiam estourar o limite da Receita e derrubar o acesso do cliente
 * pelo resto do dia.
 */
export async function fetchApuracao(job: Job) {
  const modo = String((job.params as any)?.modo ?? "solicitar");
  return modo === "baixar" ? await baixarPendentes(job) : await solicitar(job);
}

async function solicitar(job: Job) {
  const tenant = job.tenant_id;
  const competencia = String((job.params as any)?.competencia ?? mesCorrente());
  const origem = String((job.params as any)?.origem ?? "manual");

  if (!env.RTC_WEBHOOK_BASE) {
    throw new Error("RTC_WEBHOOK_BASE não configurada: sem endereço público de retorno, " +
      "a Receita não tem para onde devolver o tíquete.");
  }

  await progress(job.id, 10, "Verificando a cota da Receita");

  // O banco decide. Aqui só obedecemos.
  const { data: pedido, error } = await db.rpc("rtc_apuracao_solicitar", {
    p_tenant: tenant, p_competencia: competencia, p_origem: origem,
  });
  if (error) throw error;
  const p = pedido as any;
  if (!p?.ok) return { solicitado: false, motivo: p?.motivo, cota: p?.cota };

  await progress(job.id, 35, "Autenticando na Receita");
  const { clientId, clientSecret } = await credencialRtc(tenant);
  const token = await obterToken(clientId, clientSecret);

  await progress(job.id, 60, "Solicitando a apuração");
  const urlRetorno = `${env.RTC_WEBHOOK_BASE}/functions/v1/rtc-webhook?ref=${p.webhook_ref}`;

  try {
    const r = await solicitarApuracao(token, p.cnpj8, urlRetorno);
    await db.from("rtc_apuracao").update({ tiquete_solicitacao: r.tiquete ?? null })
      .eq("id", p.id);
    await marcarUso(tenant, "consulta_apuracao", true, job.id, "solicitação enviada");
    return { solicitado: true, id: p.id, cota: p.cota,
      aviso: "A Receita responderá no nosso webhook. O download acontece em seguida, automaticamente." };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.from("rtc_apuracao").update({ status: "erro", erro: msg, webhook_ref: null })
      .eq("id", p.id);
    await marcarUso(tenant, "consulta_apuracao", false, job.id, msg);
    throw e;
  }
}

async function baixarPendentes(job: Job) {
  await progress(job.id, 10, "Procurando apurações com tíquete pronto");

  const { data: pendentes, error } = await db.rpc("rtc_apuracao_pendentes_download");
  if (error) throw error;
  const lista = (pendentes ?? []) as Array<Record<string, any>>;
  if (lista.length === 0) return { baixadas: 0, mensagem: "Nenhum tíquete pendente." };

  const resultados: unknown[] = [];
  for (const [i, p] of lista.entries()) {
    await progress(job.id, 20 + (i / lista.length) * 70, `Baixando ${i + 1} de ${lista.length}`);

    // a cota de download também é do banco
    const { data: cota } = await db.rpc("rtc_quota_take", {
      p_cnpj: p.cnpj, p_kind: "download", p_origem: "automatico",
    });
    if (!(cota as any)?.permitido) {
      resultados.push({ id: p.id, pulado: (cota as any)?.motivo });
      continue;
    }

    try {
      const { clientId, clientSecret } = await credencialRtc(p.tenant_id);
      const token = await obterToken(clientId, clientSecret);
      const extrato = await baixarApuracao(token, p.tiquete);

      // A ingestão apaga o tíquete: uso único, nunca tentar de novo.
      const { data: ing, error: eIng } = await db.rpc("rtc_apuracao_ingest_json", {
        p_apuracao: p.id, p_json: extrato,
      });
      if (eIng) throw eIng;

      await marcarUso(p.tenant_id, "consulta_apuracao", true, job.id, "extrato baixado");
      resultados.push({ id: p.id, competencia: p.competencia, ...(ing as object) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db.from("rtc_apuracao").update({ status: "erro", erro: msg, tiquete_download: null })
        .eq("id", p.id);
      await marcarUso(p.tenant_id, "consulta_apuracao", false, job.id, msg);
      resultados.push({ id: p.id, erro: msg });
    }
  }

  return { baixadas: resultados.filter((r: any) => !r.erro && !r.pulado).length, resultados };
}

/** Lê a credencial cifrada do cliente. Nunca loga o conteúdo. */
async function credencialRtc(tenant: string): Promise<{ clientId: string; clientSecret: string }> {
  const { data: cred } = await db.from("integration_credentials")
    .select("id, secret_ref, status, finalidades")
    .eq("tenant_id", tenant).eq("provider", "rtc_cbs").eq("status", "ativa")
    .maybeSingle();

  if (!cred?.secret_ref) {
    throw new Error("Esta empresa não tem credencial da API da Receita cadastrada. " +
      "Cadastre o ClientId e o ClientSecret em Configurações > Integrações.");
  }
  if (!(cred.finalidades as string[] | null)?.includes("consulta_apuracao")) {
    throw new Error("A credencial cadastrada não foi autorizada para consultar a apuração.");
  }

  const bruto = await abrirSegredo(cred.secret_ref);
  const { clientId, clientSecret } = JSON.parse(bruto);
  if (!clientId || !clientSecret) throw new Error("Credencial da Receita incompleta.");
  return { clientId, clientSecret };
}

async function marcarUso(tenant: string, finalidade: string, sucesso: boolean,
                         jobId: string, detalhe: string) {
  const { data: cred } = await db.from("integration_credentials")
    .select("id").eq("tenant_id", tenant).eq("provider", "rtc_cbs").eq("status", "ativa")
    .maybeSingle();
  if (!cred?.id) return;
  await db.rpc("log_credential_use", {
    p_credential: cred.id, p_finalidade: finalidade, p_sucesso: sucesso,
    p_job: jobId, p_worker: env.WORKER_NAME, p_detalhe: detalhe,
  });
}

const mesCorrente = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
};
