import { request } from "undici";
import { env } from "../lib/env.js";
import { log } from "../lib/log.js";

/**
 * Adaptador da CALCULADORA DE TRIBUTOS da Receita Federal (componente offline).
 *
 * FATOS QUE DEFINEM ESTE ARQUIVO (Manual de Serviços da RTC v1, 13/01/2026):
 *  - "não há API pública hospedada para cálculo remoto. A integração sistêmica
 *    ocorre por meio do componente offline, executado no ambiente do integrador,
 *    que expõe API local para consumo máquina a máquina" — API em :8080/api.
 *  - O componente é distribuído como rootfs Docker (calculadora.tar.gz) ou JAR
 *    (Java 21). Ver scripts/rtc-calc/README.md para importar e subir.
 *  - Ele NÃO coleta dados nem tem telemetria: o dado fiscal do cliente fica aqui.
 *
 * CONTRATO REAL — conferido no CÓDIGO-FONTE oficial (codigo-fonte-backend.zip,
 * br.gov.serpro.rtc.api.controller.*) e nos scripts-python-exemplo do pacote:
 *   POST /api/calculadora/regime-geral              cálculo (OperacaoInput → ROC)
 *        body: { id, versao, dhFatoGerador (dataHoraEmissao está @Deprecated),
 *                municipio (IBGE, @NotNull), uf, itens:[{numero, ncm|nbs, cst(3), cClassTrib(6),
 *                baseCalculo, quantidade, unidade, impostoSeletivo?, tributacaoRegular?}] }
 *   POST /api/calculadora/xml/validate?tipo=nfe&subtipo=grupo   (XML → boolean)
 *   POST /api/calculadora/xml/generate?tipo=nfe                 (ROC JSON → XML)
 *   GET  /api/calculadora/dados-abertos/versao  → { versaoApp, versaoDb, descricaoVersaoDb, dataVersaoDb, ambiente }
 *   GET  /api/calculadora/dados-abertos/versao/status           (comparativo local × remoto)
 *   GET  /api/calculadora/dados-abertos/classificacoes-tributarias/cbs-ibs
 *   GET  /api/calculadora/dados-abertos/situacoes-tributarias/cbs-ibs
 *   GET  /api/calculadora/dados-abertos/ncm | nbs | ufs | ufs/municipios | fundamentacoes-legais
 *   (porta 8081) /api/split-payment           split payment simplificado (fora do escopo por ora)
 *
 * REGRA DURA: nenhum número tributário chega ao banco sem vir do motor oficial.
 * Sem RTC_CALC_URL o adaptador lança EngineUnavailableError. O stub só existe
 * com RTC_CALC_ALLOW_STUB=1 e NODE_ENV != production, e marca calcVersion='stub-*'.
 */

export type CalcInput = {
  cst: string;                 // Código de Situação Tributária (3 dígitos, ex.: "000", "200")
  cclasstrib: string;          // Código de Classificação Tributária (6 dígitos)
  baseCents: number;
  /** Bens usam NCM; serviços usam NBS. Informe um dos dois. */
  ncm?: string;
  nbs?: string;
  /** Local da operação (art. 11 LC 214/25): UF e município IBGE do DESTINO. */
  ufDestino: string;
  municipioDestino?: string | number;
  /** Data do FATO GERADOR (a alíquota muda por ano na transição). ISO date ou datetime. */
  issuedAt: string;
  quantidade?: number;
  unidade?: string;
  /** Imposto Seletivo, quando o item está sujeito (cst/cClassTrib próprios do IS). */
  impostoSeletivo?: { cst: string; cclasstrib: string; baseCents?: number };
  /** Tributação regular (para regimes diferenciados que exigem gTribRegular). */
  tributacaoRegular?: { cst: string; cclasstrib: string };
};

export type CalcOutput = {
  ibsUfCents: number;
  ibsMunCents: number;
  cbsCents: number;
  isCents: number;
  /** Soma conveniente: o IBS é dual, a tela mostra junto. */
  ibsCents: number;
  /** Alíquotas em FRAÇÃO (0.009 = 0,9%). O componente devolve em % (pCBS="0.90"). */
  aliquotas: { ibsUf?: number; ibsMun?: number; cbs?: number; is?: number };
  /** Redução de alíquota em % (gRed.pRedAliq), quando houver. */
  reducaoPct?: number;
  /** Alíquotas EFETIVAS após redução, em fração (gRed.pAliqEfet), quando houver. */
  aliquotasEfetivas: { ibsUf?: number; ibsMun?: number; cbs?: number };
  /**
   * O endpoint regime-geral NÃO devolve elegibilidade de crédito do adquirente.
   * Fica true por padrão e a decisão final é do cClassTrib (dados abertos) e do
   * regime do adquirente (classify-chain). Registrado na memória para auditoria.
   */
  creditEligible: boolean;
  creditCents: number;
  /** Memória de cálculo oficial (uma frase por tributo) + objeto bruto do item. */
  memory: unknown;
  calcVersion: string;
};

/** Recusa do motor para UMA assinatura (NCM inexistente na data, cClassTrib inválido, etc.). */
export type CalcRejected = { rejected: true; status: number; title?: string; detail: string };
export type CalcResult = CalcOutput | CalcRejected;
export const isRejected = (r: CalcResult | undefined): r is CalcRejected => !!r && (r as CalcRejected).rejected === true;

export class EngineUnavailableError extends Error {
  constructor(public reason: "not_configured" | "unreachable" | "error", message: string) {
    super(message);
    this.name = "EngineUnavailableError";
  }
}

const CALC_PATH = "/api/calculadora/regime-geral";
const VALIDATE_PATH = "/api/calculadora/xml/validate";
const GENERATE_PATH = "/api/calculadora/xml/generate";
const VERSION_PATH = "/api/calculadora/dados-abertos/versao";
const CLASSTRIB_PATH = "/api/calculadora/dados-abertos/classificacoes-tributarias/cbs-ibs";
const NCM_APLICAVEL_PATH = "/api/calculadora/dados-abertos/classificacoes-tributarias/ncm-aplicavel";
const NBS_APLICAVEL_PATH = "/api/calculadora/dados-abertos/classificacoes-tributarias/nbs-aplicavel";
const VALIDADE_DFE_PATH = "/api/calculadora/dados-abertos/classificacoes-tributarias/cbs-ibs";
const TIMEOUT_MS = 30_000;
const MAX_ITEMS_PER_REQUEST = 200;

const cache = new Map<string, CalcOutput>();
const cacheKey = (i: CalcInput) =>
  [env.RTC_CALC_VERSION, i.cst, i.cclasstrib, i.ncm ?? i.nbs ?? "", i.baseCents,
   i.ufDestino, i.municipioDestino ?? "", i.issuedAt.slice(0, 7),
   i.impostoSeletivo?.cclasstrib ?? "", i.tributacaoRegular?.cclasstrib ?? ""].join("|");

let engineVersion: string | null = null;

/** Versão do motor no ar. Falha alto se divergir de RTC_CALC_VERSION (regra versionada). */
export async function engineInfo(): Promise<{ versao: string; url: string }> {
  if (!env.RTC_CALC_URL) throw new EngineUnavailableError("not_configured", "RTC_CALC_URL não definida");
  let raw: any;
  try {
    const res = await request(`${env.RTC_CALC_URL}${VERSION_PATH}`, { headersTimeout: TIMEOUT_MS });
    if (res.statusCode >= 300) throw new Error(`HTTP ${res.statusCode}`);
    raw = await res.body.json();
  } catch (e) {
    throw new EngineUnavailableError("unreachable", `Calculadora RTC inacessível em ${env.RTC_CALC_URL}: ${(e as Error).message}`);
  }
  // VersaoOutput oficial: versaoApp (semver do motor) + versaoDb (base normativa embarcada).
  // A identidade da regra é o PAR — a mesma app com outra base de dados calcula diferente.
  const versaoApp = String(raw?.versaoApp ?? "").trim();
  const versaoDb = String(raw?.versaoDb ?? "").trim();
  const versao = versaoApp && versaoDb ? `${versaoApp}-db${versaoDb}` : String(raw?.versao ?? raw?.versaoApp ?? "").trim();
  if (!versao) throw new EngineUnavailableError("error", `dados-abertos/versao sem versaoApp/versaoDb: ${JSON.stringify(raw).slice(0, 200)}`);
  log.info({ versaoApp, versaoDb, dataVersaoDb: raw?.dataVersaoDb, ambiente: raw?.ambiente }, "Calculadora RTC no ar");
  if (env.RTC_CALC_VERSION && env.RTC_CALC_VERSION !== "dev" && env.RTC_CALC_VERSION !== versao) {
    throw new EngineUnavailableError("error",
      `Versão do motor (${versao}) difere de RTC_CALC_VERSION (${env.RTC_CALC_VERSION}). ` +
      `Publique uma rule_version nova antes de calcular com este motor.`);
  }
  engineVersion = versao;
  return { versao, url: env.RTC_CALC_URL };
}

export async function calculate(input: CalcInput): Promise<CalcOutput> {
  const [out] = await calculateBatch([input]);
  if (!out) throw new Error("Calculadora não devolveu resultado");
  if (isRejected(out)) throw new Error(`Calculadora RTC ${out.status}: ${out.detail}`);
  return out;
}

/**
 * Calcula vários itens numa só chamada (o endpoint aceita `itens[]`).
 * Todos os itens de um lote precisam compartilhar UF/município/data — o payload
 * é uma "nota" única. Aqui agrupamos por essa chave e disparamos um POST por grupo.
 *
 * O endpoint é TUDO-OU-NADA: um NCM inexistente na data derruba a operação inteira
 * com 404/422 (RFC 7807: type/title/status/detail). Por isso, quando um lote é
 * recusado com 4xx, refazemos item a item e devolvemos CalcRejected só para os
 * culpados — os outros itens seguem calculados. 5xx/rede continuam lançando.
 */
export async function calculateBatch(inputs: CalcInput[]): Promise<CalcResult[]> {
  const results = new Array<CalcResult | undefined>(inputs.length);
  const pending: number[] = [];
  inputs.forEach((i, idx) => {
    const hit = cache.get(cacheKey(i));
    if (hit) results[idx] = hit; else pending.push(idx);
  });
  if (pending.length === 0) return results as CalcResult[];

  if (!env.RTC_CALC_URL) {
    if (stubAllowed()) {
      for (const idx of pending) { const inp = inputs[idx]!; const o = stubCalculate(inp); cache.set(cacheKey(inp), o); results[idx] = o; }
      return results as CalcResult[];
    }
    throw new EngineUnavailableError("not_configured",
      "RTC_CALC_URL não definida — suba o container da Calculadora (scripts/rtc-calc) ou, só em dev, RTC_CALC_ALLOW_STUB=1");
  }
  if (!engineVersion) await engineInfo();

  // agrupa por cabeçalho (uf, municipio, data) — o payload é uma operação por POST
  const groups = new Map<string, number[]>();
  for (const idx of pending) {
    const i = inputs[idx]!;
    const k = [i.ufDestino, i.municipioDestino ?? "", i.issuedAt.slice(0, 10)].join("|");
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(idx);
  }

  for (const idxs of groups.values()) {
    for (let off = 0; off < idxs.length; off += MAX_ITEMS_PER_REQUEST) {
      const slice = idxs.slice(off, off + MAX_ITEMS_PER_REQUEST);
      const ok = await tryBatch(inputs, slice, results);
      if (ok) continue;
      // lote recusado (4xx): item a item, para isolar os culpados
      for (const idx of slice) {
        await tryBatch(inputs, [idx], results, /*single*/ true);
      }
    }
  }
  return results as CalcResult[];
}

/** POST de um lote; em 4xx devolve false (chamador refaz item a item) ou, se single, grava CalcRejected. */
async function tryBatch(inputs: CalcInput[], slice: number[], results: Array<CalcResult | undefined>, single = false): Promise<boolean> {
  const first = inputs[slice[0]!]!;
  const body = buildBody(first, slice.map((idx, n) => ({ n: n + 1, i: inputs[idx]! })));
  const r = await post(CALC_PATH, body);
  if (!r.ok) {
    if (!single) return false;
    const idx = slice[0]!;
    const rej: CalcRejected = { rejected: true, status: r.status, title: r.problem?.title, detail: r.problem?.detail ?? r.text.slice(0, 300) };
    log.warn({ status: r.status, detail: rej.detail, cst: first.cst, cclasstrib: first.cclasstrib, ncm: first.ncm, nbs: first.nbs, issuedAt: first.issuedAt },
      "Calculadora RTC recusou a assinatura");
    results[idx] = rej;          // não vai para o cache: pode ser corrigido na próxima rodada (outra data/NCM)
    return true;
  }
  const objetos: any[] = r.json?.objetos ?? [];
  slice.forEach((idx, n) => {
    const obj = objetos.find((o) => Number(o?.nObj) === n + 1) ?? objetos[n];
    if (!obj) throw new Error(`Calculadora não devolveu o item ${n + 1} do lote`);
    const inp = inputs[idx]!;
    const out = parseItem(obj, inp);
    cache.set(cacheKey(inp), out);
    results[idx] = out;
  });
  return true;
}

function buildBody(head: CalcInput, itens: Array<{ n: number; i: CalcInput }>) {
  const dt = head.issuedAt.length > 10 ? head.issuedAt : `${head.issuedAt}T12:00:00-03:00`;
  const municipio = head.municipioDestino ?? env.RTC_DEFAULT_MUNICIPIO;
  return {
    id: cryptoId(),
    versao: "1.0.0",
    dhFatoGerador: dt,
    dataHoraEmissao: dt,          // campo legado (@Deprecated no OperacaoInput); builds antigas só leem este
    uf: head.ufDestino,
    municipio: Number(municipio), // @NotNull no OperacaoInput — por isso existe RTC_DEFAULT_MUNICIPIO
    itens: itens.map(({ n, i }) => ({
      numero: n,
      ...(i.ncm ? { ncm: i.ncm } : {}),
      ...(i.nbs ? { nbs: i.nbs } : {}),
      cst: i.cst,
      cClassTrib: i.cclasstrib,
      baseCalculo: round2(i.baseCents / 100),
      quantidade: i.quantidade ?? 1,
      unidade: i.unidade ?? "UN",
      ...(i.impostoSeletivo ? {
        impostoSeletivo: {
          cst: i.impostoSeletivo.cst, cClassTrib: i.impostoSeletivo.cclasstrib,
          baseCalculo: round2((i.impostoSeletivo.baseCents ?? i.baseCents) / 100),
          quantidade: i.quantidade ?? 1, unidade: i.unidade ?? "UN",
        } } : {}),
      ...(i.tributacaoRegular ? {
        tributacaoRegular: { cst: i.tributacaoRegular.cst, cClassTrib: i.tributacaoRegular.cclasstrib } } : {}),
    })),
  };
}

function parseItem(obj: any, input: CalcInput): CalcOutput {
  const g = obj?.tribCalc?.IBSCBS?.gIBSCBS ?? {};
  const uf = g.gIBSUF ?? {}, mun = g.gIBSMun ?? {}, cbs = g.gCBS ?? {};
  const is = obj?.tribCalc?.IS ?? {};
  const ibsUfCents = toCents(uf.vIBSUF), ibsMunCents = toCents(mun.vIBSMun), cbsCents = toCents(cbs.vCBS);
  const isCents = toCents(is.vIS);
  const red = uf.gRed ?? cbs.gRed ?? mun.gRed;
  const out: CalcOutput = {
    ibsUfCents, ibsMunCents, cbsCents, isCents, ibsCents: ibsUfCents + ibsMunCents,
    aliquotas: { ibsUf: pct(uf.pIBSUF), ibsMun: pct(mun.pIBSMun), cbs: pct(cbs.pCBS), is: pct(is.pIS) },
    reducaoPct: red?.pRedAliq != null ? Number(red.pRedAliq) : undefined,
    aliquotasEfetivas: { ibsUf: pct(uf.gRed?.pAliqEfet), ibsMun: pct(mun.gRed?.pAliqEfet), cbs: pct(cbs.gRed?.pAliqEfet) },
    creditEligible: true,
    creditCents: ibsUfCents + ibsMunCents + cbsCents,
    memory: {
      fonte: "Calculadora de Tributos RFB (componente offline)",
      versao: engineVersion,
      endpoint: CALC_PATH,
      entrada: { cst: input.cst, cClassTrib: input.cclasstrib, ncm: input.ncm, nbs: input.nbs,
                 uf: input.ufDestino, municipio: input.municipioDestino ?? env.RTC_DEFAULT_MUNICIPIO,
                 dataFatoGerador: input.issuedAt, baseCalculo: round2(input.baseCents / 100) },
      memoriaCalculo: { ibsUf: uf.memoriaCalculo, ibsMun: mun.memoriaCalculo, cbs: cbs.memoriaCalculo, is: is.memoriaCalculo },
      credito: "elegibilidade não é devolvida por regime-geral; assumida true e decidida pelo cClassTrib/regime do adquirente",
      bruto: obj,
    },
    calcVersion: engineVersion ?? env.RTC_CALC_VERSION,
  };
  return out;
}

/**
 * ASSISTENTE VALIDADOR oficial (XMLController.validate). `tipo` = TipoDocumento
 * (nfe, nfce, cte, cte-simplificado, bpe, bpe-tm, nf3e…), `subtipo` = TipoXml
 * (grupo = só o bloco IBSCBS/IS; completo = documento). Devolve boolean; erro de
 * esquema vem como 4xx com `detail`.
 */
export async function validateXml(xml: string, opts: { tipo?: string; subtipo?: string } = {}):
  Promise<{ valido: boolean; inconsistencias: unknown[] }> {
  if (!env.RTC_CALC_URL) throw new EngineUnavailableError("not_configured", "validateXml exige RTC_CALC_URL");
  const q = new URLSearchParams({ tipo: opts.tipo ?? "nfe", subtipo: opts.subtipo ?? "grupo" });
  const res = await request(`${env.RTC_CALC_URL}${VALIDATE_PATH}?${q}`, {
    method: "POST", headers: { "content-type": "application/xml" }, body: xml, headersTimeout: TIMEOUT_MS,
  });
  const text = await res.body.text();
  if (res.statusCode < 300) return { valido: text.trim() === "true" || text.trim() === "", inconsistencias: [] };
  let detail: unknown = text;
  try { detail = JSON.parse(text); } catch { /* texto puro */ }
  return { valido: false, inconsistencias: [detail] };
}

/** ASSISTENTE GERADOR: converte o ROC (saída do regime-geral) no grupo XML do documento. */
export async function generateXml(roc: unknown, tipo = "nfe"): Promise<string> {
  if (!env.RTC_CALC_URL) throw new EngineUnavailableError("not_configured", "generateXml exige RTC_CALC_URL");
  const res = await request(`${env.RTC_CALC_URL}${GENERATE_PATH}?tipo=${encodeURIComponent(tipo)}`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/xml" },
    body: JSON.stringify(roc), headersTimeout: TIMEOUT_MS,
  });
  const text = await res.body.text();
  if (res.statusCode >= 300) throw new Error(`xml/generate ${res.statusCode}: ${text.slice(0, 500)}`);
  return text;
}

/** Dados abertos: classificações tributárias CBS/IBS (matriz CST × cClassTrib). */
export async function fetchClassTribMatrix(): Promise<unknown[]> {
  if (!env.RTC_CALC_URL) throw new EngineUnavailableError("not_configured", "fetchClassTribMatrix exige RTC_CALC_URL");
  const res = await request(`${env.RTC_CALC_URL}${CLASSTRIB_PATH}`, { headersTimeout: TIMEOUT_MS });
  if (res.statusCode >= 300) throw new Error(`dados abertos ${res.statusCode}`);
  const raw = (await res.body.json()) as any;
  return Array.isArray(raw) ? raw : (raw?.conteudo ?? raw?.content ?? []);
}

type PostResult = { ok: true; status: number; json: any; text: string; problem?: undefined }
               | { ok: false; status: number; json?: undefined; text: string; problem?: { type?: string; title?: string; detail?: string } };

/* ------------------------------------------------- AUDITORIA DE MÉRITO -------
 * O motor não devolve "qual cClassTrib eu deveria ter usado", mas responde se um
 * cClassTrib é APLICÁVEL a um NCM/NBS numa data. Com isso e a matriz de reduções
 * dos dados abertos, a auditoria: (a) reprova a classificação usada quando o
 * motor diz que ela não vale para aquele NCM; (b) varre os candidatos aplicáveis
 * e acha o que tem redução maior — o benefício que a empresa deixou na mesa.
 * ---------------------------------------------------------------------------*/

export type ClassTribInfo = {
  cclasstrib: string;
  cst?: string;
  descricao?: string;
  tipoAliquota?: string;
  possuiReducao?: boolean;
  pctReducaoCbs?: number;
  pctReducaoIbsUf?: number;
  pctReducaoIbsMun?: number;
  creditoAdquirenteCbs?: boolean;
  creditoAdquirenteIbs?: boolean;
  tiposDfe?: unknown;
  bruto: unknown;
};

/** GET /classificacoes-tributarias/cbs-ibs → matriz completa (usada uma vez por rule_version). */
export async function classTribMatriz(): Promise<ClassTribInfo[]> {
  const raw = (await getJson(CLASSTRIB_PATH)) as any;
  const arr: any[] = Array.isArray(raw) ? raw : (raw?.conteudo ?? raw?.content ?? []);
  return arr.map((c) => ({
    cclasstrib: String(c.codigo ?? c.cClassTrib ?? ""),
    cst: c.codigoSituacaoTributaria ?? c.cst ?? undefined,
    descricao: c.descricao ?? undefined,
    tipoAliquota: c.tipoAliquota ?? undefined,
    possuiReducao: c.possuiPercentualReducao ?? undefined,
    pctReducaoCbs: num(c.percentualReducaoCbs),
    pctReducaoIbsUf: num(c.percentualReducaoIbsUf),
    pctReducaoIbsMun: num(c.percentualReducaoIbsMun),
    creditoAdquirenteCbs: c.indicaApropriacaoCreditoAdquirenteCbs ?? undefined,
    creditoAdquirenteIbs: c.indicaApropriacaoCreditoAdquirenteIbs ?? undefined,
    tiposDfe: c.tiposDfeClassificacao ?? undefined,
    bruto: c,
  })).filter((c) => c.cclasstrib);
}

/** GET /classificacoes-tributarias/cbs-ibs/{cst} → cClassTrib válidos para um CST (achado A2). */
export async function classTribPorCst(cst: string): Promise<string[]> {
  const raw = (await getJson(`${CLASSTRIB_PATH}/${encodeURIComponent(cst)}`)) as any;
  const arr: any[] = Array.isArray(raw) ? raw : (raw?.conteudo ?? []);
  return arr.map((c) => String(c.codigo ?? c.cClassTrib ?? "")).filter(Boolean);
}

/**
 * O cClassTrib é aplicável a este NCM/NBS nesta data? (achados A3 e A5)
 * O motor responde 200 {valido:true} ou erro de negócio (NCM não vinculada) —
 * ambos são resposta legítima; só rede/5xx sobe como falha.
 */
export async function classificacaoAplicavel(
  cclasstrib: string, tipo: "ncm" | "nbs", codigo: string, data: string,
): Promise<{ valido: boolean; motivo?: string }> {
  if (!env.RTC_CALC_URL) throw new EngineUnavailableError("not_configured", "classificacaoAplicavel exige RTC_CALC_URL");
  const path = tipo === "ncm" ? NCM_APLICAVEL_PATH : NBS_APLICAVEL_PATH;
  const q = new URLSearchParams({ cClassTrib: cclasstrib, [tipo]: codigo, dataOcorrenciaFatoGerador: data.slice(0, 10) });
  const res = await request(`${env.RTC_CALC_URL}${path}?${q}`, { headersTimeout: TIMEOUT_MS });
  const text = await res.body.text();
  if (res.statusCode >= 500) throw new Error(`ncm/nbs-aplicavel ${res.statusCode}: ${text.slice(0, 300)}`);
  if (res.statusCode >= 400) {
    let motivo = text.slice(0, 300);
    try { const p = JSON.parse(text); motivo = String(p.detail ?? p.title ?? motivo); } catch { /* texto */ }
    return { valido: false, motivo };
  }
  try {
    const j = JSON.parse(text);
    return { valido: j?.valido === true, motivo: j?.valido === true ? undefined : "motor respondeu valido=false" };
  } catch { return { valido: text.trim() === "true" }; }
}

/** GET /classificacoes-tributarias/cbs-ibs/{siglaDfe}/{cClassTrib} → validade por modelo de DF-e. */
export async function classTribValidoParaDfe(siglaDfe: string, cclasstrib: string): Promise<boolean | null> {
  try {
    const raw = await getJson(`${VALIDADE_DFE_PATH}/${encodeURIComponent(siglaDfe)}/${encodeURIComponent(cclasstrib)}`);
    const v = (raw as any)?.valido ?? (raw as any)?.valida;
    return typeof v === "boolean" ? v : null;
  } catch { return null; }
}

async function getJson(path: string): Promise<unknown> {
  if (!env.RTC_CALC_URL) throw new EngineUnavailableError("not_configured", `${path} exige RTC_CALC_URL`);
  const res = await request(`${env.RTC_CALC_URL}${path}`, { headersTimeout: TIMEOUT_MS });
  const text = await res.body.text();
  if (res.statusCode >= 300) throw new Error(`${path} ${res.statusCode}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const num = (v: unknown) => (v == null || v === "" ? undefined : Number(v));

async function post(path: string, body: unknown): Promise<PostResult> {
  let res;
  try {
    res = await request(`${env.RTC_CALC_URL}${path}`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body), headersTimeout: TIMEOUT_MS, bodyTimeout: TIMEOUT_MS,
    });
  } catch (e) {
    throw new EngineUnavailableError("unreachable", `Calculadora RTC inacessível: ${(e as Error).message}`);
  }
  const text = await res.body.text();
  if (res.statusCode >= 500) {
    // erro interno do motor: não é culpa do dado, o job deve falhar e tentar de novo
    throw new Error(`Calculadora RTC ${res.statusCode}: ${text.slice(0, 500)}`);
  }
  if (res.statusCode >= 400) {
    let problem: any; try { problem = JSON.parse(text); } catch { /* texto puro */ }
    return { ok: false, status: res.statusCode, text, problem };
  }
  return { ok: true, status: res.statusCode, json: JSON.parse(text), text };
}

const toCents = (v: unknown) => Math.round(Number(v ?? 0) * 100);
const pct = (v: unknown) => (v == null || v === "" ? undefined : Number(v) / 100);
const round2 = (n: number) => Math.round(n * 100) / 100;
const cryptoId = () => Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");

function stubAllowed() {
  return process.env.RTC_CALC_ALLOW_STUB === "1" && process.env.NODE_ENV !== "production";
}

/** MODO DEGRADADO — só dev, só com RTC_CALC_ALLOW_STUB=1. Sem base legal. */
function stubCalculate(input: CalcInput): CalcOutput {
  const rate = 0.18;
  const ibsUf = Math.round(input.baseCents * rate * 0.35);
  const ibsMun = Math.round(input.baseCents * rate * 0.14);
  const cbs = Math.round(input.baseCents * rate * 0.51);
  return {
    ibsUfCents: ibsUf, ibsMunCents: ibsMun, ibsCents: ibsUf + ibsMun, cbsCents: cbs, isCents: 0,
    aliquotas: { ibsUf: rate * 0.35, ibsMun: rate * 0.14, cbs: rate * 0.51 }, aliquotasEfetivas: {},
    creditEligible: true, creditCents: ibsUf + ibsMun + cbs,
    memory: { modo: "STUB — sem RTC_CALC_URL. NÃO USAR EM PRODUÇÃO", rate },
    calcVersion: `stub-${env.RTC_CALC_VERSION}`,
  };
}
