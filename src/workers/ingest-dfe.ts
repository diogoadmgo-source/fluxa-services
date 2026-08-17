import { db } from "../lib/supabase.js";
import { progress, enqueue, type Job } from "../lib/jobs.js";
import { parseNFe } from "../adapters/dfe.js";

/**
 * svc-ingest — baixa DF-e do tenant, guarda o XML bruto e materializa notas/itens.
 * Idempotente pela chave de acesso: reexecutar não duplica.
 * Falha em uma nota não derruba o job — registra a inconsistência e segue.
 */
export async function ingestDfe(job: Job) {
  const tenant = job.tenant_id;
  const { data: t } = await db.from("tenants").select("cnpj").eq("id", tenant).single();
  const ownCnpj = t?.cnpj ?? "";

  await progress(job.id, 5, "Autorização e paginação DF-e");

  // TODO(produção): buscar credencial em integrations(kind='dfe_auth') e paginar por NSU.
  const xmls: string[] = await fetchXmlBatch(job);

  let ok = 0, skipped = 0;
  const problems: string[] = [];
  const seenParties = new Map<string, string>();

  for (const [i, xml] of xmls.entries()) {
    try {
      const p = parseNFe(xml, ownCnpj);

      let partyId: string | undefined = seenParties.get(p.counterpartyCnpj);
      if (!partyId) {
        const { data: party, error } = await db.from("counterparties")
          .upsert({
            tenant_id: tenant, cnpj: p.counterpartyCnpj, name: p.counterpartyName,
            role: p.direction === "out" ? "customer" : "supplier",
          }, { onConflict: "tenant_id,cnpj" })
          .select("id").single();
        if (error) throw error;
        partyId = party.id as string;
        seenParties.set(p.counterpartyCnpj, partyId);
      }

      const { data: inv, error: eInv } = await db.from("invoices")
        .upsert({
          tenant_id: tenant, direction: p.direction, model: p.model, access_key: p.accessKey,
          number: p.number, series: p.series, issued_at: p.issuedAt, counterparty_id: partyId,
          total_cents: p.totalCents, status: "authorized",
          raw_xml_path: `dfe/${tenant}/${p.issuedAt.slice(0, 7)}/${p.accessKey}.xml`,
          inconsistencies: p.inconsistencies,
        }, { onConflict: "access_key" })
        .select("id").single();
      if (eInv) throw eInv;

      await db.from("invoice_items").upsert(
        p.items.map((it) => ({
          tenant_id: tenant, invoice_id: inv.id, line: it.line, ncm: it.ncm, cst: it.cst,
          cclasstrib: it.cclasstrib, description: it.description, qty: it.qty, unit: it.unit,
          unit_price_cents: it.unitPriceCents, base_cents: it.baseCents,
        })), { onConflict: "invoice_id,line" });

      if (p.direction === "out" && p.installments.length) {
        await db.from("receivables").insert(
          p.installments.map((d, idx) => ({
            tenant_id: tenant, invoice_id: inv.id, installment: idx + 1,
            due_date: d.dueDate, amount_cents: d.amountCents, source: "invoice", confidence: 0.8,
          })));
      }

      if (p.inconsistencies.length) {
        await db.from("alerts").insert({
          tenant_id: tenant, kind: "inconsistent_item", severity: "warning",
          title: `Nota ${p.number} com classificação inconsistente`,
          payload: { invoice_id: inv.id, issues: p.inconsistencies },
        });
        problems.push(...p.inconsistencies);
      }
      ok++;
    } catch (err) {
      skipped++;
      problems.push(err instanceof Error ? err.message : String(err));
    }
    if (i % 50 === 0) await progress(job.id, 5 + (i / xmls.length) * 85, `${i}/${xmls.length} notas`);
  }

  // Encadeia o pipeline. Cada etapa é um job próprio, com sua própria retentativa.
  await enqueue(tenant, "classify_chain");
  await enqueue(tenant, "compute_taxes");
  await enqueue(tenant, "project_cash");

  return { invoices: ok, skipped, parties: seenParties.size, problems: problems.slice(0, 50) };
}

async function fetchXmlBatch(_job: Job): Promise<string[]> {
  throw new Error("fetchXmlBatch não implementado: conectar à distribuição DF-e com o certificado do tenant");
}
