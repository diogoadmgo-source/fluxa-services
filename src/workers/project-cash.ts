import { db } from "../lib/supabase.js";
import { progress, type Job } from "../lib/jobs.js";

/**
 * svc-cash — o coração do produto: transforma notas e recebíveis em eventos de caixa.
 *
 * LIÇÃO APRENDIDA (17/08/2026, na geração do dataset de demonstração):
 * projetar imposto APENAS das notas já emitidas subestima o futuro e faz a tela
 * mostrar folga onde há aperto. A empresa vai continuar vendendo nas próximas
 * semanas, e cada venda futura carrega IBS/CBS que sai no recebimento (split).
 * Por isso o projetor soma TRÊS fontes:
 *   1. tax_out dos recebíveis já emitidos e ainda não pagos, na data esperada;
 *   2. tax_out PROJETADO pelo run-rate das vendas (média semanal dos últimos 90 dias);
 *   3. credit_in das compras, com retorno em 150–180 dias;
 *   4. provision mensal — reserva sugerida, que NÃO entra no cálculo do buraco
 *      (é conselho de gestão, não movimento de caixa).
 * A confiança cai conforme a data se afasta — é o que alimenta a banda do gráfico.
 */
const HORIZON_DAYS = 120;
const CREDIT_LAG_DAYS = 150;

export async function projectCash(job: Job) {
  const tenant = job.tenant_id;
  const today = new Date();
  const horizon = new Date(today.getTime() + HORIZON_DAYS * 864e5);
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  await progress(job.id, 5, "Lendo recebíveis em aberto");

  const { data: ruleRow } = await db.from("rule_versions").select("id").eq("is_current", true).single();
  const ruleId = ruleRow?.id ?? null;

  const { data: receivables, error: e1 } = await db
    .from("receivables")
    .select("id, expected_date, due_date, confidence, invoices!inner(id, ibs_cents, cbs_cents)")
    .eq("tenant_id", tenant)
    .is("paid_at", null)
    .lte("due_date", iso(horizon));
  if (e1) throw e1;

  const events: Array<Record<string, unknown>> = [];

  for (const r of receivables ?? []) {
    const when = (r as any).expected_date ?? (r as any).due_date;
    if (when < iso(today) || when > iso(horizon)) continue;
    const inv = (r as any).invoices;
    events.push({
      tenant_id: tenant, event_date: when, kind: "tax_out",
      amount_cents: Number(inv.ibs_cents ?? 0) + Number(inv.cbs_cents ?? 0),
      ref_invoice_id: inv.id, confidence: r.confidence ?? 0.6, rule_version_id: ruleId,
    });
  }

  await progress(job.id, 35, "Projetando vendas futuras pelo run-rate");

  // Fonte 2: run-rate. Sem isto, o horizonte fica artificialmente vazio.
  const since = iso(new Date(today.getTime() - 90 * 864e5));
  const { data: recent, error: e2 } = await db
    .from("invoices")
    .select("ibs_cents, cbs_cents")
    .eq("tenant_id", tenant).eq("direction", "out").gte("issued_at", since);
  if (e2) throw e2;

  const weeklyTax = Math.round(
    (recent ?? []).reduce((s, i: any) => s + Number(i.ibs_cents ?? 0) + Number(i.cbs_cents ?? 0), 0) / 13
  );

  for (let w = 1; w * 7 <= HORIZON_DAYS; w++) {
    const when = new Date(today.getTime() + w * 7 * 864e5);
    events.push({
      tenant_id: tenant, event_date: iso(when), kind: "tax_out",
      amount_cents: weeklyTax,
      // confiança decai com a distância: é uma projeção, não um fato
      confidence: Math.max(0.45, 0.85 - (w * 7) / 300),
      rule_version_id: ruleId,
    });
  }

  await progress(job.id, 60, "Calculando retorno de crédito das compras");

  const { data: purchases, error: e3 } = await db
    .from("invoices")
    .select("id, issued_at, credit_cents")
    .eq("tenant_id", tenant).eq("direction", "in").gt("credit_cents", 0);
  if (e3) throw e3;

  for (const p of purchases ?? []) {
    const back = new Date(new Date((p as any).issued_at).getTime() + CREDIT_LAG_DAYS * 864e5);
    if (back < today || back > horizon) continue;
    events.push({
      tenant_id: tenant, event_date: iso(back), kind: "credit_in",
      amount_cents: Number((p as any).credit_cents), ref_invoice_id: (p as any).id,
      confidence: 0.7, rule_version_id: ruleId,
    });
  }

  await progress(job.id, 75, "Calculando provisão mensal sugerida");

  // Fonte 4: provisão mensal. É o valor que a empresa deveria separar por mês para
  // não ser pega de surpresa pelo split. Sem isto o card "Provisão sugerida" fica zerado.
  const byMonth = new Map<string, number>();
  for (const e of events) {
    if ((e as any).kind !== "tax_out") continue;
    const m = String((e as any).event_date).slice(0, 7);
    byMonth.set(m, (byMonth.get(m) ?? 0) + Number((e as any).amount_cents));
  }
  for (const [month, taxTotal] of byMonth) {
    // Data da provisão: dia 1º do mês, EXCETO no mês corrente já em curso —
    // nesse caso vale hoje, senão ela cai fora do horizonte e o card zera.
    const firstDay = `${month}-01`;
    const when = firstDay < iso(today) ? iso(today) : firstDay;
    events.push({
      tenant_id: tenant, event_date: when, kind: "provision",
      amount_cents: Math.round(taxTotal / 4),   // reserva semanal equivalente
      confidence: 0.8, rule_version_id: ruleId,
    });
  }

  await progress(job.id, 85, "Gravando eventos");

  // Substituição atômica do horizonte: apaga e reescreve, nunca acumula duplicado.
  const { error: e4 } = await db.from("tax_cash_events")
    .delete().eq("tenant_id", tenant).gte("event_date", iso(today));
  if (e4) throw e4;

  for (let i = 0; i < events.length; i += 500) {
    const { error } = await db.from("tax_cash_events").insert(events.slice(i, i + 500));
    if (error) throw error;
  }

  await db.rpc("refresh_cash_timeline");

  // provisão é sugestão de reserva, não movimento de caixa: fica fora do gap
  const gap30 = events
    .filter((e: any) => e.kind !== "provision" && e.event_date <= iso(new Date(today.getTime() + 30 * 864e5)))
    .reduce((s, e: any) => s + (e.kind === "tax_out" ? -e.amount_cents : e.amount_cents), 0);

  const provision = events
    .filter((e: any) => e.kind === "provision")
    .reduce((s, e: any) => s + Number(e.amount_cents), 0);

  return {
    events: events.length,
    weekly_run_rate_cents: weeklyTax,
    gap_30_cents: gap30,
    provision_cents: provision,
  };
}
