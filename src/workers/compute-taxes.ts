import { db } from "../lib/supabase.js";
import { progress, type Job } from "../lib/jobs.js";
import { calculateBatch, engineInfo } from "../adapters/rtc-calc.js";
import { env } from "../lib/env.js";

/**
 * svc-calc — aplica a Calculadora oficial e carimba a versão da regra.
 *
 * REESCRITO APÓS TESTE DE CARGA (18/08/2026, 100 mil notas / 225 mil itens).
 * A versão anterior tinha dois defeitos, os dois silenciosos:
 *   - `.limit(20000)`: com 225 mil itens, 90% nunca eram calculados e o número
 *     na tela ficava errado sem nenhum erro aparecer.
 *   - uma chamada HTTP de UPDATE por item: 225 mil idas e voltas, ~75 minutos.
 *
 * A correção não foi "otimizar o loop", foi TIRAR o loop. Insight: a tributação
 * depende da ASSINATURA FISCAL (CST, cClassTrib, NCM/NBS, origem, destino, ano),
 * não do valor. Dois itens de R$ 10 e R$ 10.000 com a mesma assinatura seguem a
 * mesma regra — só a base muda. Então:
 *   1. pedimos ao banco as assinaturas DISTINTAS ainda sem regra (dezenas ou
 *      centenas, não centenas de milhares);
 *   2. consultamos a Calculadora uma vez por assinatura;
 *   3. gravamos a regra no cache;
 *   4. o banco aplica a regra a TODOS os itens numa única operação em lote.
 *
 * Medido: 225 mil itens em ~21 s, contra ~75 min antes — e agora correto.
 */
export async function computeTaxes(job: Job) {
  const tenant = job.tenant_id;

  const { data: rule } = await db.from("rule_versions")
    .select("id, calc_version").eq("is_current", true).single();
  const ruleVersion = rule?.calc_version;
  if (!ruleVersion) throw new Error("nenhuma rule_version marcada como is_current");

  // Regra versionada: o motor no ar tem que ser o da rule_version corrente.
  // engineInfo() falha alto se RTC_CALC_VERSION divergir do dados-abertos/versao.
  if (env.RTC_CALC_URL) {
    const eng = await engineInfo();
    if (eng.versao !== ruleVersion) {
      throw new Error(`rule_version corrente é ${ruleVersion}, mas o motor no ar é ${eng.versao}. ` +
        `Publique uma rule_version para ${eng.versao} (painel da plataforma) antes de calcular.`);
    }
  }

  await progress(job.id, 5, "Levantando assinaturas fiscais distintas");

  let totalSignatures = 0;
  // Em lotes, porque um tenant novo pode ter muitas assinaturas na primeira carga.
  for (let round = 0; ; round++) {
    const { data: signatures, error } = await db.rpc("pending_calc_signatures", {
      p_tenant: tenant, p_rule_version: ruleVersion, p_limit: 500,
    });
    if (error) throw error;
    const list = (signatures ?? []) as Array<Record<string, any>>;
    if (list.length === 0) break;

    await progress(job.id, Math.min(10 + round * 5, 60),
      `Consultando a calculadora para ${list.length} assinaturas`);

    // Uma chamada em lote por até 200 assinaturas (o endpoint aceita itens[]).
    // Base fictícia de R$ 100 só para extrair ALÍQUOTA e redução — a regra é
    // proporcional; a base real de cada item entra depois, no SQL (apply_calc_rules).
    const outs = await calculateBatch(list.map((s) => ({
      cst: s.cst, cclasstrib: s.cclasstrib,
      ncm: s.classificacao || undefined,
      baseCents: 10000,
      ufDestino: s.uf_destino || env.RTC_DEFAULT_UF,
      municipioDestino: s.municipio || undefined,
      issuedAt: `${s.ano}-06-15`,
    })));

    const rules: Array<Record<string, unknown>> = list.map((s, k) => {
      const out = outs[k];
      if (!out) throw new Error(`Calculadora não devolveu a assinatura ${k + 1} do lote`);
      return {
        rule_version: ruleVersion,
        cst: s.cst, cclasstrib: s.cclasstrib, classificacao: s.classificacao,
        uf_origem: s.uf_origem, uf_destino: s.uf_destino, municipio: s.municipio, ano: s.ano,
        // apply_calc_rules multiplica base_cents pela alíquota em FRAÇÃO e aplica reducao_pct/100.
        // Se o motor já devolveu alíquota efetiva (gRed.pAliqEfet), usamos a NOMINAL + reducao,
        // que é o que a função do banco espera.
        aliq_ibs_uf: out.aliquotas.ibsUf ?? out.ibsUfCents / 10000,
        aliq_ibs_mun: out.aliquotas.ibsMun ?? out.ibsMunCents / 10000,
        aliq_cbs: out.aliquotas.cbs ?? out.cbsCents / 10000,
        aliq_is: out.aliquotas.is ?? out.isCents / 10000,
        reducao_pct: out.reducaoPct ?? 0,
        permite_credito: out.creditEligible,
        memoria: out.memory,
      };
    });
    totalSignatures += list.length;

    const { error: eUp } = await db.rpc("calc_rule_cache_upsert", { p: rules });
    if (eUp) throw eUp;

    if (list.length < 500) break;   // acabaram as assinaturas pendentes
  }

  await progress(job.id, 70, "Aplicando as regras a todos os itens");

  // Uma única chamada. O banco faz o trabalho em lote, sem round-trip por linha.
  const { data: applied, error: eApply } = await db.rpc("apply_calc_rules", {
    p_tenant: tenant, p_rule_version: ruleVersion, p_batch: 50000,
  });
  if (eApply) throw eApply;

  const result = applied as { itens_atualizados: number; itens_sem_regra: number };

  // Se sobrou item sem regra, é sinal de assinatura que a calculadora recusou.
  // Falha alto: melhor o job falhar do que a tela mostrar número incompleto.
  if (result.itens_sem_regra > 0) {
    throw new Error(
      `${result.itens_sem_regra} itens ficaram sem regra fiscal — provável CST/cClassTrib inválido. ` +
      `Verifique as inconsistências antes de confiar nos totais.`);
  }

  return { ...result, assinaturas_calculadas: totalSignatures, rule_version: ruleVersion };
}
