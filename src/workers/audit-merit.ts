import { db } from "../lib/supabase.js";
import { progress, type Job } from "../lib/jobs.js";
import { log } from "../lib/log.js";
import {
  calculateBatch, classificacaoAplicavel, classTribMatriz, classTribPorCst,
  engineInfo, isRejected, type ClassTribInfo,
} from "../adapters/rtc-calc.js";
import { env } from "../lib/env.js";

/**
 * AUDITORIA DE MÉRITO DA NOTA FISCAL
 *
 * A SEFAZ valida sintaxe (o par CST×cClassTrib existe? os totais fecham?).
 * Ela NÃO valida mérito: um cClassTrib de tributação integral num item que teria
 * redução passa sem hesitar — o erro só aparece na apuração, quando já virou número.
 *
 * Este worker recalcula cada item no motor OFICIAL e produz seis classes de achado:
 *   A1 ausencia_grupo         item sem CST/cClassTrib
 *   A2 par_invalido           cClassTrib não pertence ao CST informado
 *   A3 classificacao_indevida cClassTrib não aplicável ao NCM/NBS na data (motor: ncm-aplicavel)
 *   A4 valor_divergente       IBS/CBS destacado ≠ recalculado (tolerância de 1 centavo por tributo)
 *   A5 beneficio_nao_usado    existe cClassTrib aplicável com redução maior → dinheiro na mesa
 *   A6 credito_em_risco       entrada cuja classificação não dá crédito ao adquirente
 *
 * Custo: o trabalho é por ASSINATURA FISCAL (cst, cclasstrib, ncm/nbs, uf, ano),
 * não por item — 10 mil itens viram ~40 perguntas ao motor. As respostas de
 * aplicabilidade ficam em calc_classtrib_aplicavel (imutáveis por rule_version).
 */

type Assinatura = {
  cst: string; cclasstrib: string; classificacao: string; tipo: "ncm" | "nbs";
  uf: string; municipio: string | null; ano: number; competencia: string;
};

type ItemRow = {
  id: string; invoice_id: string; tenant_id: string;
  ncm: string | null; cst: string | null; cclasstrib: string | null;
  base_cents: number | null; ibs_cents: number | null; cbs_cents: number | null;
  direction: string | null; issued_at: string; uf: string | null;
};

const CENTAVO = 1;

export async function auditMerit(job: Job) {
  const tenant = job.tenant_id;

  const { data: rule } = await db.from("rule_versions")
    .select("calc_version").eq("is_current", true).maybeSingle();
  const ruleVersion = rule?.calc_version;
  if (!ruleVersion) throw new Error("nenhuma rule_version marcada como is_current");

  if (env.RTC_CALC_URL) {
    const eng = await engineInfo();
    if (eng.versao !== ruleVersion) {
      throw new Error(`rule_version corrente é ${ruleVersion}, motor no ar é ${eng.versao}. ` +
        `A auditoria só vale se as duas forem a mesma — publique a rule_version antes.`);
    }
  }

  await progress(job.id, 5, "Carregando a matriz de classificações do motor oficial");
  const matriz = await carregarMatriz(ruleVersion);

  await progress(job.id, 12, "Lendo os itens emitidos");
  const itens = await carregarItens(tenant);
  if (itens.length === 0) {
    return { itens_auditados: 0, achados: 0, valor_risco_cents: 0, rule_version: ruleVersion };
  }

  // ---------------------------------------------------------------- A1
  const achados: Record<string, unknown>[] = [];
  const semGrupo = itens.filter((i) => !i.cst || !i.cclasstrib);
  for (const it of semGrupo) {
    achados.push(finding(it, "ausencia_grupo", "critical", ruleVersion, 0, {
      esperado: { regra: "LC 214/2025 art. 60 e NT 2025.002: item do regime regular deve destacar IBS/CBS" },
      encontrado: { cst: it.cst, cclasstrib: it.cclasstrib },
      memoria: { fonte: "estrutura do documento fiscal" },
    }));
  }

  // agrupa o resto por assinatura fiscal
  const comGrupo = itens.filter((i) => i.cst && i.cclasstrib);
  const grupos = new Map<string, { a: Assinatura; itens: ItemRow[] }>();
  for (const it of comGrupo) {
    const tipo: "ncm" | "nbs" = it.ncm && it.ncm.length >= 8 ? "ncm" : "nbs";
    const a: Assinatura = {
      cst: it.cst!, cclasstrib: it.cclasstrib!, classificacao: it.ncm ?? "",
      tipo, uf: it.uf ?? env.RTC_DEFAULT_UF, municipio: null,
      ano: new Date(it.issued_at).getUTCFullYear(),
      competencia: it.issued_at.slice(0, 7) + "-01",
    };
    const k = [a.cst, a.cclasstrib, a.classificacao, a.uf, a.ano].join("|");
    const g = grupos.get(k) ?? { a, itens: [] };
    g.itens.push(it);
    grupos.set(k, g);
  }
  log.info({ itens: itens.length, assinaturas: grupos.size, sem_grupo: semGrupo.length }, "auditoria: itens agrupados");

  const cstValidos = new Map<string, Set<string>>();
  let n = 0;
  for (const { a, itens: doGrupo } of grupos.values()) {
    n++;
    await progress(job.id, 12 + Math.round((n / grupos.size) * 78),
      `Auditando assinatura ${n}/${grupos.size} (${a.cst}/${a.cclasstrib})`);
    const dataFG = `${a.ano}-06-15`;
    const baseTotal = doGrupo.reduce((s, i) => s + Number(i.base_cents ?? 0), 0);

    // ------------------------------------------------------------- A2
    if (!cstValidos.has(a.cst)) {
      try { cstValidos.set(a.cst, new Set(await classTribPorCst(a.cst))); }
      catch { cstValidos.set(a.cst, new Set()); }
    }
    const validosDoCst = cstValidos.get(a.cst)!;
    if (validosDoCst.size > 0 && !validosDoCst.has(a.cclasstrib)) {
      for (const it of doGrupo) {
        achados.push(finding(it, "par_invalido", "critical", ruleVersion, 0, {
          esperado: { cst: a.cst, cclasstrib_validos: [...validosDoCst].slice(0, 12) },
          encontrado: { cst: a.cst, cclasstrib: a.cclasstrib },
          memoria: { fonte: "dados abertos do motor oficial: classificacoes-tributarias/cbs-ibs/{cst}" },
        }));
      }
      continue; // par inválido: não faz sentido seguir para mérito
    }

    // ------------------------------------------------------------- A3
    if (a.classificacao) {
      const apl = await aplicavelComCache(ruleVersion, a.cclasstrib, a.tipo, a.classificacao, a.ano, dataFG);
      if (!apl.valido) {
        const risco = await riscoDaReclassificacao(a, doGrupo, baseTotal, matriz, ruleVersion, dataFG);
        for (const it of doGrupo) {
          achados.push(finding(it, "classificacao_indevida", "critical", ruleVersion,
            Math.round(risco.valorRiscoCents * (Number(it.base_cents ?? 0) / (baseTotal || 1))), {
            esperado: { candidatos_aplicaveis: risco.candidatos.slice(0, 5), observacao: risco.observacao },
            encontrado: { cst: a.cst, cclasstrib: a.cclasstrib, [a.tipo]: a.classificacao },
            memoria: { fonte: `motor oficial: classificacoes-tributarias/${a.tipo}-aplicavel`, motivo: apl.motivo, data: dataFG },
          }));
        }
        continue;
      }
    }

    // ------------------------------------------------------------- A4
    const [calc] = await calculateBatch([{
      cst: a.cst, cclasstrib: a.cclasstrib,
      ...(a.tipo === "ncm" && a.classificacao ? { ncm: a.classificacao } : {}),
      ...(a.tipo === "nbs" && a.classificacao ? { nbs: a.classificacao } : {}),
      baseCents: 10000, ufDestino: a.uf, issuedAt: dataFG,
    }]);
    if (calc && !isRejected(calc)) {
      for (const it of doGrupo) {
        const base = Number(it.base_cents ?? 0);
        if (base <= 0) continue;
        const espIbs = Math.round(base * ((calc.ibsUfCents + calc.ibsMunCents) / 10000));
        const espCbs = Math.round(base * (calc.cbsCents / 10000));
        const difIbs = Number(it.ibs_cents ?? 0) - espIbs;
        const difCbs = Number(it.cbs_cents ?? 0) - espCbs;
        if (Math.abs(difIbs) > CENTAVO || Math.abs(difCbs) > CENTAVO) {
          achados.push(finding(it, "valor_divergente", "warning", ruleVersion, Math.abs(difIbs) + Math.abs(difCbs), {
            esperado: { ibs_cents: espIbs, cbs_cents: espCbs, aliquotas: calc.aliquotas, reducao_pct: calc.reducaoPct },
            encontrado: { ibs_cents: it.ibs_cents, cbs_cents: it.cbs_cents },
            memoria: calc.memory,
          }));
        }
      }

      // ----------------------------------------------------------- A5
      const melhor = await melhorCandidato(a, matriz, ruleVersion, dataFG, calc.reducaoPct ?? 0);
      if (melhor) {
        const ganho = Math.round(baseTotal * ((calc.cbsCents + calc.ibsUfCents + calc.ibsMunCents) / 10000)
          * ((melhor.reducao - (calc.reducaoPct ?? 0)) / 100));
        if (ganho > 0) {
          for (const it of doGrupo) {
            achados.push(finding(it, "beneficio_nao_usado", "info", ruleVersion,
              Math.round(ganho * (Number(it.base_cents ?? 0) / (baseTotal || 1))), {
              esperado: { cclasstrib: melhor.cclasstrib, descricao: melhor.descricao, reducao_pct: melhor.reducao },
              encontrado: { cclasstrib: a.cclasstrib, reducao_pct: calc.reducaoPct ?? 0 },
              memoria: { fonte: "matriz de classificações + ncm-aplicavel do motor oficial",
                         aviso: "candidato aplicável ao NCM; confirmar aderência da descrição do produto ao anexo da LC 214/2025" },
            }));
          }
        }
      }

      // ----------------------------------------------------------- A6
      const info = matriz.get(a.cclasstrib);
      const entradas = doGrupo.filter((i) => i.direction === "in");
      if (entradas.length > 0 && info && (info.creditoAdquirenteCbs === false || info.creditoAdquirenteIbs === false)) {
        for (const it of entradas) {
          const perdido = Number(it.ibs_cents ?? 0) + Number(it.cbs_cents ?? 0);
          achados.push(finding(it, "credito_em_risco", "warning", ruleVersion, perdido, {
            esperado: { observacao: "classificação do fornecedor não transfere crédito integral ao adquirente" },
            encontrado: { cclasstrib: a.cclasstrib, credito_cbs: info.creditoAdquirenteCbs, credito_ibs: info.creditoAdquirenteIbs },
            memoria: { fonte: "dados abertos: indicaApropriacaoCreditoAdquirente{Cbs,Ibs}", descricao: info.descricao },
          }));
        }
      }
    }
  }

  await progress(job.id, 92, "Gravando achados");
  await gravar(tenant, achados);

  const risco = achados.reduce((s, a) => s + Number(a.valor_risco_cents ?? 0), 0);
  return {
    itens_auditados: itens.length,
    assinaturas: grupos.size,
    achados: achados.length,
    itens_com_achado: new Set(achados.map((a) => a.invoice_item_id)).size,
    valor_risco_cents: risco,
    rule_version: ruleVersion,
  };
}

/* ------------------------------------------------------------------ apoio */

function finding(it: ItemRow, classe: string, sev: string, ruleVersion: string, risco: number,
                 extra: { esperado: unknown; encontrado: unknown; memoria: unknown }) {
  return {
    tenant_id: it.tenant_id, invoice_item_id: it.id, invoice_id: it.invoice_id,
    classe, severidade: sev,
    cst: it.cst, cclasstrib: it.cclasstrib, classificacao: it.ncm,
    uf: it.uf, competencia: it.issued_at.slice(0, 10),
    valor_risco_cents: Math.max(0, Math.round(risco)),
    esperado: extra.esperado, encontrado: extra.encontrado, memoria: extra.memoria,
    rule_version: ruleVersion, status: "aberto",
  };
}

async function carregarItens(tenant: string): Promise<ItemRow[]> {
  const out: ItemRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("invoice_items")
      .select("id, invoice_id, tenant_id, ncm, cst, cclasstrib, base_cents, ibs_cents, cbs_cents, invoices!inner(issued_at, direction, uf)")
      .eq("tenant_id", tenant)
      .gte("invoices.issued_at", "2026-01-01")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as any[];
    for (const r of rows) {
      const inv = Array.isArray(r.invoices) ? r.invoices[0] : r.invoices;
      out.push({ ...r, issued_at: inv?.issued_at ?? "2026-01-01", direction: inv?.direction ?? null, uf: inv?.uf ?? null });
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

async function carregarMatriz(ruleVersion: string): Promise<Map<string, ClassTribInfo>> {
  const { data: cache } = await db.from("calc_classtrib_matriz")
    .select("cclasstrib, cst, descricao, tipo_aliquota, possui_reducao, pct_reducao_cbs, pct_reducao_ibs_uf, pct_reducao_ibs_mun, credito_adquirente_cbs, credito_adquirente_ibs, tipos_dfe, bruto")
    .eq("rule_version", ruleVersion);
  if (cache && cache.length > 0) {
    return new Map(cache.map((c: any) => [c.cclasstrib, {
      cclasstrib: c.cclasstrib, cst: c.cst, descricao: c.descricao, tipoAliquota: c.tipo_aliquota,
      possuiReducao: c.possui_reducao, pctReducaoCbs: c.pct_reducao_cbs,
      pctReducaoIbsUf: c.pct_reducao_ibs_uf, pctReducaoIbsMun: c.pct_reducao_ibs_mun,
      creditoAdquirenteCbs: c.credito_adquirente_cbs, creditoAdquirenteIbs: c.credito_adquirente_ibs,
      tiposDfe: c.tipos_dfe, bruto: c.bruto,
    } as ClassTribInfo]));
  }
  const lista = await classTribMatriz();
  if (lista.length > 0) {
    const linhas = lista.map((c) => ({
      rule_version: ruleVersion, cclasstrib: c.cclasstrib, cst: c.cst ?? null, descricao: c.descricao ?? null,
      tipo_aliquota: c.tipoAliquota ?? null, possui_reducao: c.possuiReducao ?? null,
      pct_reducao_cbs: c.pctReducaoCbs ?? null, pct_reducao_ibs_uf: c.pctReducaoIbsUf ?? null,
      pct_reducao_ibs_mun: c.pctReducaoIbsMun ?? null,
      credito_adquirente_cbs: c.creditoAdquirenteCbs ?? null, credito_adquirente_ibs: c.creditoAdquirenteIbs ?? null,
      tipos_dfe: c.tiposDfe ?? null, bruto: c.bruto ?? null,
    }));
    for (let i = 0; i < linhas.length; i += 500) {
      const { error } = await db.from("calc_classtrib_matriz").upsert(linhas.slice(i, i + 500), { onConflict: "rule_version,cclasstrib" });
      if (error) log.warn({ err: error.message }, "matriz não persistida (segue em memória)");
    }
  }
  log.info({ classificacoes: lista.length, rule_version: ruleVersion }, "matriz de classificações carregada do motor");
  return new Map(lista.map((c) => [c.cclasstrib, c]));
}

/** Resposta do motor sobre aplicabilidade, memoizada por (rule_version, cclasstrib, tipo, codigo, ano). */
async function aplicavelComCache(ruleVersion: string, cclasstrib: string, tipo: "ncm" | "nbs",
                                 codigo: string, ano: number, data: string): Promise<{ valido: boolean; motivo?: string }> {
  const { data: hit } = await db.from("calc_classtrib_aplicavel")
    .select("valido").eq("rule_version", ruleVersion).eq("cclasstrib", cclasstrib)
    .eq("tipo", tipo).eq("codigo", codigo).eq("ano", ano).maybeSingle();
  if (hit) return { valido: hit.valido };

  const r = await classificacaoAplicavel(cclasstrib, tipo, codigo, data);
  await db.from("calc_classtrib_aplicavel").upsert(
    { rule_version: ruleVersion, cclasstrib, tipo, codigo, ano, valido: r.valido },
    { onConflict: "rule_version,cclasstrib,tipo,codigo,ano" });
  return r;
}

/**
 * Quando a classificação usada não vale para o NCM, procura quais valeriam.
 * Testa só candidatos com redução (os que mudam dinheiro) e limita a varredura
 * para não transformar a auditoria em varredura exaustiva da matriz.
 */
async function riscoDaReclassificacao(a: Assinatura, itens: ItemRow[], baseTotal: number,
                                      matriz: Map<string, ClassTribInfo>, ruleVersion: string, data: string) {
  const candidatos: Array<{ cclasstrib: string; descricao?: string; reducao: number }> = [];
  if (!a.classificacao) return { candidatos, valorRiscoCents: 0, observacao: "sem NCM/NBS para verificar" };

  let testados = 0;
  for (const c of matriz.values()) {
    if (testados >= 60) break;
    if (!c.possuiReducao) continue;
    if (c.cclasstrib === a.cclasstrib) continue;
    testados++;
    const r = await aplicavelComCache(ruleVersion, c.cclasstrib, a.tipo, a.classificacao, a.ano, data);
    if (r.valido) {
      candidatos.push({ cclasstrib: c.cclasstrib, descricao: c.descricao,
                        reducao: Math.max(c.pctReducaoCbs ?? 0, c.pctReducaoIbsUf ?? 0) });
    }
  }
  // risco = o tributo destacado sob classificação inválida (é o que a Receita pode recalcular)
  const destacado = itens.reduce((s, i) => s + Number(i.ibs_cents ?? 0) + Number(i.cbs_cents ?? 0), 0);
  return {
    candidatos: candidatos.sort((x, y) => y.reducao - x.reducao),
    valorRiscoCents: destacado,
    observacao: candidatos.length > 0
      ? "classificações aplicáveis a este NCM segundo o motor oficial"
      : "nenhum candidato com redução aplicável — revisar o NCM do cadastro",
  };
}

/** Existe classificação aplicável a este NCM com redução maior que a usada? (A5) */
async function melhorCandidato(a: Assinatura, matriz: Map<string, ClassTribInfo>,
                               ruleVersion: string, data: string, reducaoAtual: number) {
  if (!a.classificacao) return null;
  let melhor: { cclasstrib: string; descricao?: string; reducao: number } | null = null;
  let testados = 0;
  for (const c of matriz.values()) {
    if (testados >= 40) break;
    if (!c.possuiReducao || c.cclasstrib === a.cclasstrib) continue;
    const reducao = Math.max(c.pctReducaoCbs ?? 0, c.pctReducaoIbsUf ?? 0);
    if (reducao <= reducaoAtual) continue;
    testados++;
    const r = await aplicavelComCache(ruleVersion, c.cclasstrib, a.tipo, a.classificacao, a.ano, data);
    if (r.valido && (!melhor || reducao > melhor.reducao)) {
      melhor = { cclasstrib: c.cclasstrib, descricao: c.descricao, reducao };
    }
  }
  return melhor;
}

async function gravar(tenant: string, achados: Record<string, unknown>[]) {
  // rodada nova substitui a anterior da mesma rule_version: o que foi corrigido some
  const versoes = [...new Set(achados.map((a) => a.rule_version))];
  for (const v of versoes) {
    await db.from("audit_findings").delete().eq("tenant_id", tenant).eq("rule_version", v as string).eq("status", "aberto");
  }
  for (let i = 0; i < achados.length; i += 500) {
    const { error } = await db.from("audit_findings").upsert(achados.slice(i, i + 500), { onConflict: "invoice_item_id,classe,rule_version" });
    if (error) throw error;
  }
}
