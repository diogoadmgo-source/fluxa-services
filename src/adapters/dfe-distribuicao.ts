import { request, Agent } from "undici";
import { gunzipSync } from "node:zlib";
import { XMLParser } from "fast-xml-parser";

/**
 * Cliente do AMBIENTE NACIONAL da NF-e para o CNPJ do tenant:
 *
 *  - NFeDistribuicaoDFe (nfeDistDFeInteresse, distDFeInt 1.01): entrega, por NSU
 *    sequencial, todos os DF-e em que o CNPJ é destinatário/interessado —
 *    procNFe (XML completo), resNFe (resumo), resEvento/procEventoNFe.
 *  - NFeRecepcaoEvento4 (envEvento 1.00): usado aqui para o evento 210210
 *    "Ciência da Operação" — sem ele, compras chegam só como resumo; com ele,
 *    o XML completo passa a ser distribuído nos próximos lotes.
 *
 * Autenticação: mTLS com o certificado A1 do tenant (PEM vindo de
 * certificadoParaPem). Nada de chave própria nossa: a identidade é a empresa.
 *
 * Códigos de retorno que importam (cStat do retDistDFeInt):
 *   137 = nenhum documento localizado (fim da fila) — normal.
 *   138 = documentos localizados.
 *   656 = consumo indevido (chamadas repetidas com ultNSU=maxNSU) — o AN
 *         bloqueia por ~1h; tratamos como "parar e tentar mais tarde".
 */

const AN_DIST = "https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx";
const AN_EVENTO = "https://www1.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx";
const TIMEOUT_MS = 60_000;

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true });

export type DistDoc = {
  nsu: string;
  schema: string;      // ex.: procNFe_v4.00.xsd, resNFe_v1.01.xsd, procEventoNFe_v1.00.xsd
  xml: string;         // conteúdo descompactado
};

export type DistPage = {
  cStat: number;
  xMotivo: string;
  ultNSU: string;
  maxNSU: string;
  docs: DistDoc[];
};

export class ConsumoIndevidoError extends Error {
  constructor(public xMotivo: string) { super(`AN bloqueou por consumo indevido (656): ${xMotivo}`); }
}

function mtlsAgent(pem: { key: string; cert: string }): Agent {
  return new Agent({ connect: { key: pem.key, cert: pem.cert } });
}

async function soap(url: string, action: string, inner: string, pem: { key: string; cert: string }): Promise<string> {
  const envelope =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">` +
    `<soap12:Body>${inner}</soap12:Body></soap12:Envelope>`;
  const res = await request(url, {
    method: "POST",
    dispatcher: mtlsAgent(pem),
    headers: { "content-type": `application/soap+xml; charset=utf-8; action="${action}"` },
    body: envelope,
    headersTimeout: TIMEOUT_MS,
    bodyTimeout: TIMEOUT_MS,
  });
  const text = await res.body.text();
  if (res.statusCode >= 300) {
    // SOAP Fault vem com o motivo no corpo — precisamos dele INTEIRO para diagnosticar
    const reason = text.match(/<soap:Text[^>]*>([\s\S]*?)<\/soap:Text>/)?.[1]
                ?? text.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/)?.[1]
                ?? text.slice(0, 1200);
    throw new Error(`Ambiente Nacional respondeu HTTP ${res.statusCode}: ${reason.trim().slice(0, 1200)}`);
  }
  return text;
}

const pad15 = (n: string | number) => String(n).padStart(15, "0");

/** Uma página da distribuição a partir de ultNSU (exclusivo). */
export async function distDFe(
  pem: { key: string; cert: string },
  cnpj: string,
  ufAutor: string | number,
  ultNSU: string | number,
): Promise<DistPage> {
  const dist =
    `<nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">` +
    `<nfeDadosMsg><distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">` +
    `<tpAmb>1</tpAmb><cUFAutor>${ufAutor}</cUFAutor><CNPJ>${cnpj.replace(/\D/g, "")}</CNPJ>` +
    `<distNSU><ultNSU>${pad15(ultNSU)}</ultNSU></distNSU>` +
    `</distDFeInt></nfeDadosMsg></nfeDistDFeInteresse>`;

  const raw = await soap(AN_DIST, "http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse", dist, pem);
  const doc = parser.parse(raw);
  const ret = doc?.Envelope?.Body?.nfeDistDFeInteresseResponse?.nfeDistDFeInteresseResult?.retDistDFeInt
           ?? doc?.Envelope?.Body?.nfeDistDFeInteresseResult?.retDistDFeInt;
  if (!ret) throw new Error(`Resposta da distribuição sem retDistDFeInt: ${raw.slice(0, 300)}`);

  const cStat = Number(ret.cStat);
  if (cStat === 656) throw new ConsumoIndevidoError(String(ret.xMotivo ?? ""));

  const lote = ret.loteDistDFeInt?.docZip;
  const zips = lote == null ? [] : Array.isArray(lote) ? lote : [lote];
  const docs: DistDoc[] = zips.map((z: any) => ({
    nsu: String(z["@_NSU"] ?? ""),
    schema: String(z["@_schema"] ?? ""),
    xml: gunzipSync(Buffer.from(String(z["#text"] ?? z), "base64")).toString("utf-8"),
  }));

  return {
    cStat,
    xMotivo: String(ret.xMotivo ?? ""),
    ultNSU: String(ret.ultNSU ?? pad15(ultNSU)),
    maxNSU: String(ret.maxNSU ?? "0"),
    docs,
  };
}

/* ------------------------------------------------------------------ eventos */

/**
 * Assinatura XML-DSig do evento, SEM biblioteca de C14N: o XML do infEvento é
 * gerado JÁ em forma canônica (sem espaços, atributos na ordem, xmlns herdado
 * declarado explicitamente no digest). É a técnica consagrada das libs de NF-e
 * brasileiras — funciona porque nós controlamos byte a byte a serialização.
 * Algoritmos: RSA-SHA1 + SHA1, os exigidos pelo layout de eventos da NF-e.
 */
async function assinarInfEvento(idRef: string, infEventoCanonico: string, pem: { key: string; cert: string }):
  Promise<string> {
  const forge = (await import("node-forge")).default;

  const md = forge.md.sha1.create();
  md.update(infEventoCanonico, "utf8");
  const digestValue = forge.util.encode64(md.digest().getBytes());

  const signedInfo =
    `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">` +
    `<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></CanonicalizationMethod>` +
    `<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"></SignatureMethod>` +
    `<Reference URI="#${idRef}">` +
    `<Transforms>` +
    `<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></Transform>` +
    `<Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></Transform>` +
    `</Transforms>` +
    `<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"></DigestMethod>` +
    `<DigestValue>${digestValue}</DigestValue>` +
    `</Reference></SignedInfo>`;

  const key = forge.pki.privateKeyFromPem(pem.key);
  const mdSig = forge.md.sha1.create();
  mdSig.update(signedInfo, "utf8");
  const signatureValue = forge.util.encode64(key.sign(mdSig) as unknown as string);

  const certDer = forge.util.encode64(
    forge.asn1.toDer(forge.pki.certificateToAsn1(forge.pki.certificateFromPem(pem.cert))).getBytes());

  return (
    `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">` +
    signedInfo.replace(` xmlns="http://www.w3.org/2000/09/xmldsig#"`, "") +
    `<SignatureValue>${signatureValue}</SignatureValue>` +
    `<KeyInfo><X509Data><X509Certificate>${certDer}</X509Certificate></X509Data></KeyInfo>` +
    `</Signature>`
  );
}

export type ManifestResult = { chave: string; cStat: number; xMotivo: string };

/**
 * Evento 210210 — Ciência da Operação — em lote (até 20 chaves por envio).
 * cStat esperados por evento: 135/136 = vinculado; 573 = duplicidade (já
 * manifestado — tratamos como sucesso idempotente).
 */
export async function manifestarCiencia(
  pem: { key: string; cert: string },
  cnpj: string,
  chaves: string[],
): Promise<ManifestResult[]> {
  if (chaves.length === 0) return [];
  const out: ManifestResult[] = [];
  // dhEvento em horário de Brasília com offset explícito (o AN valida o formato)
  const agora = new Date(Date.now() - 3 * 3600_000);
  const dh = agora.toISOString().replace(/\.\d{3}Z$/, "-03:00");

  for (let off = 0; off < chaves.length; off += 20) {
    const lote = chaves.slice(off, off + 20);
    const eventos: string[] = [];
    for (let i = 0; i < lote.length; i++) {
      const ch = lote[i]!;
      const id = `ID210210${ch}01`;
      const inf =
        `<infEvento Id="${id}">` +
        `<cOrgao>91</cOrgao><tpAmb>1</tpAmb><CNPJ>${cnpj.replace(/\D/g, "")}</CNPJ>` +
        `<chNFe>${ch}</chNFe><dhEvento>${dh}</dhEvento><tpEvento>210210</tpEvento>` +
        `<nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento>` +
        `<detEvento versao="1.00"><descEvento>Ciencia da Operacao</descEvento></detEvento>` +
        `</infEvento>`;
      // Digest sobre a forma canônica COM o namespace herdado declarado:
      const canonico = inf.replace(`<infEvento Id=`, `<infEvento xmlns="http://www.portalfiscal.inf.br/nfe" Id=`);
      const sig = await assinarInfEvento(id, canonico, pem);
      eventos.push(`<evento versao="1.00">${inf}${sig}</evento>`);
    }

    const env =
      `<nfeRecepcaoEvento xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4">` +
      `<nfeDadosMsg><envEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">` +
      `<idLote>${Date.now()}</idLote>${eventos.join("")}</envEvento></nfeDadosMsg></nfeRecepcaoEvento>`;

    const raw = await soap(AN_EVENTO, "http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4/nfeRecepcaoEvento", env, pem);
    const doc = parser.parse(raw);
    const ret = doc?.Envelope?.Body?.nfeRecepcaoEventoResponse?.nfeRecepcaoEventoResult?.retEnvEvento
             ?? doc?.Envelope?.Body?.nfeRecepcaoEventoResult?.retEnvEvento;
    const rets = ret?.retEvento == null ? [] : Array.isArray(ret.retEvento) ? ret.retEvento : [ret.retEvento];
    for (const r of rets) {
      const infRet = r?.infEvento ?? {};
      out.push({ chave: String(infRet.chNFe ?? ""), cStat: Number(infRet.cStat ?? 0), xMotivo: String(infRet.xMotivo ?? "") });
    }
    if (rets.length === 0 && ret?.cStat) {
      // lote inteiro recusado (ex.: 128 não processado) — registra por chave
      for (const ch of lote) out.push({ chave: ch, cStat: Number(ret.cStat), xMotivo: String(ret.xMotivo ?? "") });
    }
  }
  return out;
}

/** Chave de acesso a partir de um resumo (resNFe) já parseado ou do XML cru. */
export function chaveDoResumo(xml: string): { chave: string; emitente: string; valor: number } | null {
  try {
    const d = parser.parse(xml);
    const r = d?.resNFe;
    if (!r) return null;
    return { chave: String(r.chNFe ?? ""), emitente: String(r.xNome ?? ""), valor: Number(r.vNF ?? 0) };
  } catch { return null; }
}
