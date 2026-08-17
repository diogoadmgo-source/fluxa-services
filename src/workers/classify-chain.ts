import { db } from "../lib/supabase.js";
import { progress, type Job } from "../lib/jobs.js";

/**
 * svc-chain — descobre o regime tributário de cada CNPJ da cadeia.
 * É o dado que nenhum concorrente cruza em escala e o que sustenta a tela de Carteira.
 *
 * Regras firmes:
 *  - NUNCA sobrescreve regime cujo regime_source = 'manual' (o usuário mandou).
 *  - credit_transfer_pct segue o regime: regular transfere 100%, Simples parcial,
 *    MEI/PF zero. Esse número vira "crédito perdido por ano" na tela.
 *  - mudança de regime gera alerta: é evento comercial, não detalhe técnico.
 */
const CREDIT_BY_REGIME: Record<string, number> = {
  real: 100, presumido: 100, simples_hibrido: 100, simples: 28, mei: 0, pf: 0, imune: 0,
};

export async function classifyChain(job: Job) {
  const tenant = job.tenant_id;
  const { data: parties, error } = await db
    .from("counterparties")
    .select("id, cnpj, regime, regime_source, regime_checked_at")
    .eq("tenant_id", tenant);
  if (error) throw error;

  const stale = (parties ?? []).filter(
    (p: any) => p.regime_source !== "manual" &&
      (!p.regime_checked_at || Date.now() - new Date(p.regime_checked_at).getTime() > 30 * 864e5)
  );

  let changed = 0, unknown = 0;
  for (const [i, p] of stale.entries()) {
    const regime = await lookupRegime((p as any).cnpj);
    if (!regime) { unknown++; continue; }

    if (regime !== (p as any).regime) {
      changed++;
      await db.from("alerts").insert({
        tenant_id: tenant, kind: "regime_changed", severity: "warning",
        title: `Regime alterado: ${(p as any).cnpj}`,
        payload: { counterparty_id: (p as any).id, from: (p as any).regime, to: regime },
      });
    }

    await db.from("counterparties").update({
      regime, regime_source: "receita", regime_checked_at: new Date().toISOString(),
      credit_transfer_pct: CREDIT_BY_REGIME[regime] ?? null,
    }).eq("id", (p as any).id);

    if (i % 20 === 0) await progress(job.id, (i / Math.max(stale.length, 1)) * 100);
  }

  await recomputeShares(tenant);
  return { checked: stale.length, changed, unknown };
}

async function lookupRegime(_cnpj: string): Promise<string | null> {
  throw new Error("lookupRegime não implementado: ligar à consulta de regime por CNPJ com cache global");
}

/** Participação de cada contraparte na receita/compra — usado pelo semáforo da Carteira. */
async function recomputeShares(tenant: string) {
  // RPC opcional: se não existir no banco, a tela calcula na leitura via chain_map.
  const { error } = await db.rpc("recompute_counterparty_shares", { p_tenant: tenant });
  if (error && !/does not exist|not find/i.test(error.message)) throw error;
}
