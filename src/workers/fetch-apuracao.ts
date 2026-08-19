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

  // A cota já foi debitada acima. A partir daqui, QUALQUER falha precisa passar
  // pelo tratamento — inclusive as que acontecem antes de sair da nossa máquina.
  //
  // Na primeira execução real este bloco não existia: a leitura da credencial
  // falhou FORA do try, o job morreu, e a cota do dia ficou consumida por uma
  // consulta que nunca chegou à Receita. O cliente perdia o direito do dia por
  // um erro nosso.
  //
  // Distinção que importa: erro LOCAL devolve a cota (nada foi consumido lá
  // fora); erro DA RECEITA não devolve (a chamada aconteceu de verdade).
  let saiuDaNossaMaquina = false;

  try {
    await progress(job.id, 35, "Autenticando na Receita");
    const { clientId, clientSecret, certRef } = await credencialRtc(tenant);

    saiuDaNossaMaquina = true;   // a partir daqui há tráfego externo
    const token = await obterToken(clientId, clientSecret, certRef);

    await progress(job.id, 60, "Solicitando a apuração");
    const urlRetorno = `${env.RTC_WEBHOOK_BASE}/functions/v1/rtc-webhook?ref=${p.webhook_ref}`;
    const r = await solicitarApuracao(token, p.cnpj8, urlRetorno, certRef);

    await db.from("rtc_apuracao").update({ tiquete_solicitacao: r.tiquete ?? null })
      .eq("id", p.id);
    await marcarUso(tenant, "consulta_apuracao", true, job.id, "solicitação enviada");
    return { solicitado: true, id: p.id, cota: p.cota,
      aviso: "A Receita responderá no nosso webhook. O download acontece em seguida, automaticamente." };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.rpc("rtc_apuracao_falhar", {
      p_id: p.id, p_erro: msg, p_devolver_cota: !saiuDaNossaMaquina,
    });
    await marcarUso(tenant, "consulta_apuracao", false, job.id, msg);
    throw new Error(msg + (!saiuDaNossaMaquina
      ? " (a consulta não chegou à Receita; a cota do dia foi devolvida)"
      : ""));
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
      const { clientId, clientSecret, certRef } = await credencialRtc(p.tenant_id);
      const token = await obterToken(clientId, clientSecret, certRef);
      const extrato = await baixarApuracao(token, p.tiquete, certRef);

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
async function credencialRtc(tenant: string):
  Promise<{ clientId: string; clientSecret: string; certRef: string | null }> {
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

  // FORMATO (confirmado com quem cifra, não suposto): texto puro UTF-8
  //   <CLIENT_ID>:<CLIENT_SECRET>
  // Sem JSON, sem quebra de linha, já com trim aplicado dos dois lados.
  //
  // A divisão é no PRIMEIRO dois-pontos apenas. O ClientSecret do Portal RTC
  // pode conter ':' — um split(":") ingênuo cortaria a credencial no meio, e o
  // sintoma seria um 401 da Receita depois de já ter gasto uma das 2 consultas
  // diárias. Erro caro e difícil de diagnosticar.
  const corte = bruto.indexOf(":");
  if (corte <= 0 || corte === bruto.length - 1) {
    throw new Error("Credencial da Receita em formato inesperado. " +
      "Recadastre o ClientId e o ClientSecret em Configurações > Integrações.");
  }
  const clientId = bruto.slice(0, corte);
  const clientSecret = bruto.slice(corte + 1);
  if (!clientId || !clientSecret) throw new Error("Credencial da Receita incompleta.");

  // As APIs da Receita exigem autenticação mútua: o certificado A1 da empresa
  // é apresentado no handshake TLS, junto do token. Reaproveitamos o mesmo
  // certificado já cadastrado para a ingestão de DF-e — o cliente não precisa
  // subir dois.
  const { data: cert } = await db.from("integration_credentials")
    .select("secret_ref").eq("tenant_id", tenant).eq("provider", "dfe")
    .eq("kind", "certificado_a1").eq("status", "ativa").maybeSingle();

  return { clientId, clientSecret, certRef: cert?.secret_ref ?? null };
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
