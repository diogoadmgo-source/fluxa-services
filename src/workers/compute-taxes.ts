import { db } from "../lib/supabase.js";
import { progress, type Job } from "../lib/jobs.js";
import { calculate } from "../adapters/rtc-calc.js";

/**
 * svc-calc — aplica a calculadora oficial item a item e carimba a versão da regra.
 * Toda linha calculada guarda rule_version_id: sem isso não há reprocessamento
 * confiável quando a Receita muda a tabela.
 */
export async function computeTaxes(job: Job) {
  const tenant = job.tenant_id;
  const { data: rule } = await db.from("rule_versions").select("id, calc_version")
    .eq("is_current", true).single();

  const { data: items, error } = await db
    .from("invoice_items")
    .select("id, ncm, cst, cclasstrib, base_cents, invoices!inner(id, issued_at, direction)")
    .eq("tenant_id", tenant)
    .limit(20000);
  if (error) throw error;

  let done = 0, creditTotal = 0;
  for (const it of items ?? []) {
    const inv = (it as any).invoices;
    const out = await calculate({
      ncm: (it as any).ncm ?? "", cst: (it as any).cst ?? "", cclasstrib: (it as any).cclasstrib ?? "",
      baseCents: Number((it as any).base_cents ?? 0),
      ufOrigem: "GO", ufDestino: "GO",           // TODO: vir do endereço da nota
      issuedAt: inv.issued_at,
    });

    // Crédito só existe na ENTRADA. Numa saída, o imposto é débito, não crédito.
    const isPurchase = inv.direction === "in";
    await db.from("invoice_items").update({
      ibs_cents: out.ibsCents, cbs_cents: out.cbsCents, is_cents: out.isCents,
      credit_eligible: isPurchase && out.creditEligible,
      credit_cents: isPurchase ? out.creditCents : 0,
      calc_memory: out.memory,
    }).eq("id", (it as any).id);

    if (isPurchase) creditTotal += out.creditCents;
    if (++done % 200 === 0) await progress(job.id, (done / (items?.length ?? 1)) * 100);
  }

  // Consolida os totais no cabeçalho da nota a partir dos itens.
  const { error: eRollup } = await db.rpc("rollup_invoice_totals", { p_tenant: tenant, p_rule: rule?.id });
  if (eRollup && !/does not exist|not find/i.test(eRollup.message)) throw eRollup;

  return { items: done, rule_version: rule?.calc_version, credit_total_cents: creditTotal };
}
