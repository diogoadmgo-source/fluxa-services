import { XMLParser } from "fast-xml-parser";

/**
 * Cliente de distribuição DF-e. A autorização vem de integrations.dfe_auth do tenant
 * (certificado A1 cifrado ou procuração e-CAC) — nunca hardcoded.
 *
 * TODO(produção): assinar as requisições com o certificado do tenant e paginar por NSU.
 * O parse abaixo já é o real e independe de como o XML chegou.
 */
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

export type ParsedInvoice = {
  accessKey: string; model: string; number: string; series: string;
  issuedAt: string; direction: "in" | "out";
  counterpartyCnpj: string; counterpartyName: string;
  totalCents: number;
  items: Array<{
    line: number; ncm: string; cst: string; cclasstrib: string;
    description: string; qty: number; unit: string;
    unitPriceCents: number; baseCents: number;
  }>;
  installments: Array<{ dueDate: string; amountCents: number }>;
  inconsistencies: string[];
};

const toCents = (v: unknown) => Math.round(Number(v ?? 0) * 100);

export function parseNFe(xml: string, ownCnpj: string): ParsedInvoice {
  const doc = parser.parse(xml);
  const inf = doc?.nfeProc?.NFe?.infNFe ?? doc?.NFe?.infNFe;
  if (!inf) throw new Error("XML sem infNFe");

  const emit = String(inf.emit?.CNPJ ?? "");
  const direction: "in" | "out" = emit.replace(/\D/g, "") === ownCnpj.replace(/\D/g, "") ? "out" : "in";
  const other = direction === "out" ? inf.dest : inf.emit;

  const rawItems = Array.isArray(inf.det) ? inf.det : [inf.det].filter(Boolean);
  const inconsistencies: string[] = [];

  const items = rawItems.map((d: any, idx: number) => {
    const p = d.prod ?? {};
    const trib = d.imposto?.IBSCBS ?? {};
    const cst = String(trib.CST ?? "");
    const cclasstrib = String(trib.cClassTrib ?? "");
    // Checagem que a SEFAZ faz e é a maior causa de rejeição hoje:
    if (!cst || !cclasstrib) inconsistencies.push(`item ${idx + 1}: CST/cClassTrib ausente`);
    return {
      line: Number(d["@_nItem"] ?? idx + 1),
      ncm: String(p.NCM ?? ""),
      cst, cclasstrib,
      description: String(p.xProd ?? ""),
      qty: Number(p.qCom ?? 0),
      unit: String(p.uCom ?? "UN"),
      unitPriceCents: toCents(p.vUnCom),
      baseCents: toCents(p.vProd),
    };
  });

  const dup = inf.cobr?.dup;
  const dups = Array.isArray(dup) ? dup : [dup].filter(Boolean);

  return {
    accessKey: String(inf["@_Id"] ?? "").replace(/^NFe/, ""),
    model: String(inf.ide?.mod ?? "55"),
    number: String(inf.ide?.nNF ?? ""),
    series: String(inf.ide?.serie ?? ""),
    issuedAt: String(inf.ide?.dhEmi ?? "").slice(0, 10),
    direction,
    counterpartyCnpj: String(other?.CNPJ ?? other?.CPF ?? ""),
    counterpartyName: String(other?.xNome ?? ""),
    totalCents: toCents(inf.total?.ICMSTot?.vNF ?? inf.total?.IBSCBSTot?.vNF),
    items,
    installments: dups.map((d: any) => ({
      dueDate: String(d.dVenc ?? "").slice(0, 10),
      amountCents: toCents(d.vDup),
    })),
    inconsistencies,
  };
}
